// ============================================================
// FDQH - FosunDx Quality Hub Server
// ============================================================
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3100;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database
const db = require('./database/init');

// AI Service
const aiService = require('./ai');

// ---- Simple Session (in-memory) ----
const sessions = {};

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !sessions[token]) return res.status(401).json({ error: 'Unauthorized' });
  req.user = sessions[token];
  next();
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.findAll('users').find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = require('crypto').randomBytes(32).toString('hex');
  sessions[token] = { id: user.id, username: user.username, name: user.name, role: user.role, base: user.base, dept: user.dept };
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, base: user.base } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  delete sessions[token];
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ============================================================
// QUALITY EVENTS - 质量事件管理
// ============================================================
app.get('/api/events', requireAuth, (req, res) => {
  const { status, risk_level, event_type, search } = req.query;
  let events = db.findAll('quality_events');
  if (status) events = events.filter(e => e.status === status);
  if (risk_level) events = events.filter(e => e.risk_level === risk_level);
  if (event_type) events = events.filter(e => e.event_type === event_type);
  if (search) events = events.filter(e => (e.description || '').includes(search) || e.id?.includes(search) || (e.batch_no || '').includes(search));
  events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(events);
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  const event = db.findById('quality_events', req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  res.json({ event, auditLogs: db.getAuditLogs('quality_events', req.params.id) });
});

app.post('/api/events', requireAuth, (req, res) => {
  const event = db.insert('quality_events', {
    ...req.body,
    reported_by: req.user.username,
    status: 'Open',
  });
  res.status(201).json(event);
});

app.put('/api/events/:id', requireAuth, (req, res) => {
  // Allow status transitions
  const validTransitions = {
    'Open': ['In Investigation', 'Closed - No Action'],
    'In Investigation': ['Root Cause Analysis', 'Closed'],
    'Root Cause Analysis': ['CAPA Created', 'Closed'],
    'CAPA Created': ['Closed'],
  };
  const event = db.findById('quality_events', req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  if (req.body.status && validTransitions[event.status] && !validTransitions[event.status].includes(req.body.status)) {
    return res.status(400).json({ error: `Invalid status transition: ${event.status} -> ${req.body.status}` });
  }
  const updated = db.update('quality_events', req.params.id, req.body);
  res.json(updated);
});

// ============================================================
// CAPA - 纠正与预防措施
// ============================================================
app.get('/api/capa', requireAuth, (req, res) => {
  const { status, assignee, search } = req.query;
  let capas = db.findAll('capa_records');
  if (status) capas = capas.filter(c => c.status === status);
  if (assignee) capas = capas.filter(c => c.assignee === assignee);
  if (search) capas = capas.filter(c => (c.title || '').includes(search) || c.id?.includes(search));
  capas.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(capas);
});

app.get('/api/capa/:id', requireAuth, (req, res) => {
  const capa = db.findById('capa_records', req.params.id);
  if (!capa) return res.status(404).json({ error: 'Not found' });
  res.json({ capa, auditLogs: db.getAuditLogs('capa_records', req.params.id) });
});

app.post('/api/capa', requireAuth, (req, res) => {
  const capa = db.insert('capa_records', { ...req.body, status: 'Open' });
  // If linked to an event, update event status
  if (req.body.event_id) {
    db.update('quality_events', req.body.event_id, { status: 'CAPA Created' });
  }
  res.status(201).json(capa);
});

app.put('/api/capa/:id', requireAuth, (req, res) => {
  const capa = db.findById('capa_records', req.params.id);
  if (!capa) return res.status(404).json({ error: 'Not found' });
  const updated = db.update('capa_records', req.params.id, req.body);
  // Sync event status on CAPA close
  if (req.body.status === 'Closed' && capa.event_id) {
    db.update('quality_events', capa.event_id, { status: 'Closed' });
  }
  res.json(updated);
});

app.delete('/api/capa/:id', requireAuth, (req, res) => {
  db.delete('capa_records', req.params.id);
  res.json({ success: true });
});

// ============================================================
// CHANGE CONTROL - 变更控制
// ============================================================
app.get('/api/changes', requireAuth, (req, res) => {
  let changes = db.findAll('change_records');
  if (req.query.status) changes = changes.filter(c => c.status === req.query.status);
  changes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(changes);
});

app.post('/api/changes', requireAuth, (req, res) => {
  const change = db.insert('change_records', { ...req.body, status: 'Pending Approval' });
  res.status(201).json(change);
});

app.put('/api/changes/:id', requireAuth, (req, res) => {
  const updated = db.update('change_records', req.params.id, req.body);
  res.json(updated);
});

// ============================================================
// PRODUCTS & SUPPLIERS - 主数据管理
// ============================================================
app.get('/api/products', requireAuth, (req, res) => {
  res.json(db.findAll('products'));
});

app.get('/api/suppliers', requireAuth, (req, res) => {
  res.json(db.findAll('suppliers'));
});

app.post('/api/suppliers', requireAuth, (req, res) => {
  res.status(201).json(db.insert('suppliers', req.body));
});

app.put('/api/suppliers/:id', requireAuth, (req, res) => {
  res.json(db.update('suppliers', req.params.id, req.body));
});

// ============================================================
// DASHBOARD / BI - 驾驶舱
// ============================================================
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  res.json(db.getDashboardStats());
});

app.get('/api/dashboard/recent-events', requireAuth, (req, res) => {
  const events = db.findAll('quality_events')
    .filter(e => e.status !== 'Closed')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);
  res.json(events);
});

app.get('/api/audit-logs', requireAuth, (req, res) => {
  const logs = (db.collections.audit_logs || []).slice(-200).reverse();
  res.json(logs);
});

// ============================================================
// AI ASSISTANT - AI 智能助手
// ============================================================

// Get AI service status
app.get('/api/ai/status', requireAuth, (req, res) => {
  res.json({
    available: aiService.isAvailable(),
    models: aiService.isAvailable()
      ? [aiService.AI_CONFIG.primary.model, aiService.AI_CONFIG.fallback.apiKey ? aiService.AI_CONFIG.fallback.model : null].filter(Boolean)
      : [],
    assistantTypes: [
      { id: 'quality_expert', name: '质量专家助手', icon: '🤖', desc: 'ISO 13485 / GMP / IVD法规咨询' },
      { id: 'knowledge', name: 'AI 知识助手', icon: '📚', desc: '质量管理知识库问答' },
      { id: 'capa_rca', name: 'AI CAPA/RCA 智能助手', icon: '🔧', desc: '根因分析与CAPA计划生成' },
      { id: 'risk_prediction', name: 'AI 质量风险预测', icon: '📈', desc: '风险趋势分析与预警' },
    ],
    quickQuestions: aiService.isAvailable() ? {
      quality_expert: aiService.getQuickQuestions('quality_expert'),
      knowledge: aiService.getQuickQuestions('knowledge'),
      capa_rca: aiService.getQuickQuestions('capa_rca'),
      risk_prediction: aiService.getQuickQuestions('risk_prediction'),
    } : {},
  });
});

// AI Chat - Streaming
app.post('/api/ai/chat', requireAuth, (req, res) => {
  const { assistantType, messages, contextData } = req.body;

  if (!aiService.isAvailable()) {
    return res.status(503).json({ error: 'AI服务未配置。请设置环境变量 DASHSCOPE_API_KEY 或 DEEPSEEK_API_KEY 后重启服务。', hint: '推荐使用阿里百炼平台: https://bailian.console.aliyun.com' });
  }

  if (!assistantType || !['quality_expert', 'knowledge', 'capa_rca', 'risk_prediction'].includes(assistantType)) {
    return res.status(400).json({ error: '无效的助手类型' });
  }

  // Build messages with system prompt and context
  const fullMessages = aiService.buildMessages(assistantType, messages || [], contextData || null);

  // Stream the response
  aiService.streamChat(assistantType, fullMessages, res);
});

// AI Chat - Non-streaming (for simple queries)
app.post('/api/ai/chat/simple', requireAuth, async (req, res) => {
  const { assistantType, messages, contextData } = req.body;

  if (!aiService.isAvailable()) {
    return res.status(503).json({ error: 'AI服务未配置' });
  }

  try {
    const fullMessages = aiService.buildMessages(assistantType, messages || [], contextData || null);
    const response = await aiService.chat(assistantType, fullMessages);
    res.json({ content: response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analyze quality event with CAPA/RCA assistant
app.post('/api/ai/analyze-event/:eventId', requireAuth, async (req, res) => {
  const event = db.findById('quality_events', req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Collect related data for context
  const capas = db.findAll('capa_records').filter(c => c.event_id === event.id);
  const relatedEvents = db.findAll('quality_events').filter(e => e.product_id === event.product_id && e.id !== event.id);
  const product = event.product_id ? db.findById('products', event.product_id) : null;

  const contextData = {
    event: event,
    relatedCAPAs: capas,
    relatedEvents: relatedEvents.slice(0, 5),
    product: product,
    analysisContext: {
      totalEventsForProduct: relatedEvents.length,
      existingCAPAsForEvent: capas.length,
      similarEvents: relatedEvents.map(e => ({ id: e.id, type: e.event_type, status: e.status, desc: e.description?.slice(0, 100) })),
    }
  };

  const messages = [
    { role: 'user', content: `请对以下质量事件进行根因分析和CAPA建议:\n\n事件ID: ${event.id}\n类型: ${event.event_type}\n产品: ${event.product_name || 'N/A'}\n批号: ${event.batch_no || 'N/A'}\n风险等级: ${event.risk_level}\n状态: ${event.status}\n描述: ${event.description}\n\n请提供:\n1. 可能的根因分析\n2. 建议的CAPA计划\n3. 风险评估` }
  ];

  try {
    const fullMessages = aiService.buildMessages('capa_rca', messages, contextData);
    const response = await aiService.chat('capa_rca', fullMessages);
    res.json({ content: response, eventId: event.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Predict risk based on current data
app.post('/api/ai/risk-predict', requireAuth, async (req, res) => {
  // Collect all relevant data
  const events = db.collections.quality_events || [];
  const capas = db.collections.capa_records || [];
  const products = db.collections.products || [];
  const suppliers = db.collections.suppliers || [];

  const contextData = {
    summary: {
      totalEvents: events.length,
      openEvents: events.filter(e => e.status === 'Open' || e.status === 'In Investigation').length,
      criticalEvents: events.filter(e => e.risk_level === 'Critical' || e.risk_level === 'High').length,
      overdueCAPAs: capas.filter(c => c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed').length,
    },
    eventsByProduct: {},
    eventsByType: {},
    riskDistribution: { Low: 0, Medium: 0, High: 0, Critical: 0 },
    monthlyCounts: {},
    topRiskProducts: [],
  };

  // Aggregate data
  events.forEach(e => {
    contextData.riskDistribution[e.risk_level] = (contextData.riskDistribution[e.risk_level] || 0) + 1;
    contextData.eventsByType[e.event_type] = (contextData.eventsByType[e.event_type] || 0) + 1;
    if (e.product_name) {
      contextData.eventsByProduct[e.product_name] = (contextData.eventsByProduct[e.product_name] || 0) + 1;
    }
    if (e.created_at) {
      const month = e.created_at.slice(0, 7);
      contextData.monthlyCounts[month] = (contextData.monthlyCounts[month] || 0) + 1;
    }
  });

  // Top risk products
  contextData.topRiskProducts = Object.entries(contextData.eventsByProduct)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const messages = [
    { role: 'user', content: '请基于当前质量数据进行风险预测分析，识别高风险领域并提供改进建议。' }
  ];

  try {
    const fullMessages = aiService.buildMessages('risk_prediction', messages, contextData);
    const response = await aiService.chat('risk_prediction', fullMessages);
    res.json({ content: response, data: contextData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   FosunDx Quality Hub (FDQH) Platform       ║
  ║   IVD 数字化质量管理平台                      ║
  ║   Version 1.0.0                              ║
  ║   http://localhost:${PORT}                      ║
  ╚══════════════════════════════════════════════╝
  `);
  console.log('  默认账号: admin / admin123');
  console.log('  QA经理: qa_manager / qa123');
});
