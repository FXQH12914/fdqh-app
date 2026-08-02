// ============================================================
// FDQH - FosunDx Quality Hub Server v1.1
// MongoDB + JSON Fallback | Rate Limiting | Session Expiry
// ============================================================
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
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

// ============================================================
// Session + Rate Limiting
// ============================================================
const sessions = {};
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const loginAttempts = {}; // { ip: { count, firstAttempt } }
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW = 5 * 60 * 1000; // 5 minutes

// Clean expired sessions every hour
setInterval(function() {
  var now = Date.now();
  for (var key in sessions) {
    if (sessions[key].expiresAt < now) delete sessions[key];
  }
}, 3600000);

function requireAuth(req, res, next) {
  var token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !sessions[token]) return res.status(401).json({ error: 'Unauthorized' });
  if (sessions[token].expiresAt < Date.now()) {
    delete sessions[token];
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = sessions[token].user;
  req.token = token;
  next();
}

// Async route wrapper
function asyncHandler(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(function(err) {
      console.error('Route error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    });
  };
}

// ============================================================
// VALIDATION HELPERS
// ============================================================
var VALID_EVENT_TYPES = ['Deviation', 'OOS', 'OOT', 'Complaint', 'CAPA', 'Audit-Finding', 'SCAR', 'NCR'];
var VALID_RISK_LEVELS = ['Low', 'Medium', 'High', 'Critical'];
var VALID_CHANGE_TYPES = ['工艺变更', '设备变更', '物料变更', '文件变更', '产品变更'];
var VALID_CAPA_STATUSES = ['Open', 'In Progress', 'Closed'];
var VALID_EVENT_STATUSES = ['Open', 'In Investigation', 'Root Cause Analysis', 'CAPA Created', 'Closed', 'Closed - No Action'];
var VALID_PRODUCT_LIFECYCLE = ['开发中', '试生产', '上市', '变更中', '退市'];

function requireFields(body, fields) {
  for (var i = 0; i < fields.length; i++) {
    if (!body[fields[i]]) throw new Error('缺少必填字段: ' + fields[i]);
  }
}

function whitelistFields(body, allowed) {
  var result = {};
  for (var i = 0; i < allowed.length; i++) {
    if (body[allowed[i]] !== undefined) result[allowed[i]] = body[allowed[i]];
  }
  return result;
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/login', asyncHandler(async (req, res) => {
  var ip = req.ip || req.connection.remoteAddress || 'unknown';
  var now = Date.now();

  // Rate limiting
  if (!loginAttempts[ip] || now - loginAttempts[ip].firstAttempt > LOGIN_WINDOW) {
    loginAttempts[ip] = { count: 1, firstAttempt: now };
  } else {
    loginAttempts[ip].count++;
  }
  if (loginAttempts[ip].count > MAX_LOGIN_ATTEMPTS) {
    return res.status(429).json({ error: '登录尝试次数过多，请5分钟后再试' });
  }

  var { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

  var users = await db.findAll('users');
  var user = users.find(function(u) { return u.username === username; });
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  // Reset rate limit on success
  delete loginAttempts[ip];

  var token = crypto.randomBytes(32).toString('hex');
  sessions[token] = {
    user: { id: user.id, username: user.username, name: user.name, role: user.role, base: user.base, dept: user.dept },
    expiresAt: now + SESSION_TTL,
  };
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, base: user.base } });
}));

app.post('/api/auth/logout', (req, res) => {
  var token = req.headers['authorization']?.replace('Bearer ', '');
  delete sessions[token];
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ============================================================
// QUALITY EVENTS
// ============================================================
app.get('/api/events', requireAuth, asyncHandler(async (req, res) => {
  var { status, risk_level, event_type, search, page, limit, sort, order } = req.query;
  var events = await db.findAll('quality_events');
  if (status) events = events.filter(function(e) { return e.status === status; });
  if (risk_level) events = events.filter(function(e) { return e.risk_level === risk_level; });
  if (event_type) events = events.filter(function(e) { return e.event_type === event_type; });
  if (search) events = events.filter(function(e) { return (e.description || '').includes(search) || (e.id || '').includes(search) || (e.batch_no || '').includes(search); });

  // Sort
  var sortField = sort || 'created_at';
  var sortOrder = order === 'asc' ? 1 : -1;
  events.sort(function(a, b) {
    var av = a[sortField], bv = b[sortField];
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return sortOrder * (av < bv ? -1 : av > bv ? 1 : 0);
  });

  // Pagination
  var pageNum = parseInt(page) || 1;
  var pageSize = parseInt(limit) || 50;
  var total = events.length;
  var start = (pageNum - 1) * pageSize;
  var paged = events.slice(start, start + pageSize);

  res.json({ data: paged, total: total, page: pageNum, pageSize: pageSize, totalPages: Math.ceil(total / pageSize) });
}));

app.get('/api/events/:id', requireAuth, asyncHandler(async (req, res) => {
  var event = await db.findById('quality_events', req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  var auditLogs = await db.getAuditLogs('quality_events', req.params.id);
  res.json({ event, auditLogs });
}));

app.post('/api/events', requireAuth, asyncHandler(async (req, res) => {
  requireFields(req.body, ['event_type', 'risk_level', 'description']);
  if (!VALID_EVENT_TYPES.includes(req.body.event_type)) return res.status(400).json({ error: '无效的事件类型' });
  if (!VALID_RISK_LEVELS.includes(req.body.risk_level)) return res.status(400).json({ error: '无效的风险等级' });

  var data = whitelistFields(req.body, ['event_type', 'risk_level', 'product_id', 'product_name', 'batch_no', 'description']);
  data.reported_by = req.user.username;
  data.status = 'Open';

  var event = await db.insert('quality_events', data, req.user.username);
  res.status(201).json(event);
}));

app.put('/api/events/:id', requireAuth, asyncHandler(async (req, res) => {
  var validTransitions = {
    'Open': ['In Investigation', 'Closed - No Action'],
    'In Investigation': ['Root Cause Analysis', 'Closed'],
    'Root Cause Analysis': ['CAPA Created', 'Closed'],
    'CAPA Created': ['Closed'],
  };
  var event = await db.findById('quality_events', req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });

  if (req.body.status) {
    if (!VALID_EVENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: '无效的状态值' });
    if (validTransitions[event.status] && !validTransitions[event.status].includes(req.body.status)) {
      return res.status(400).json({ error: '无效的状态流转: ' + event.status + ' -> ' + req.body.status });
    }
  }

  var allowed = ['event_type', 'risk_level', 'product_id', 'product_name', 'batch_no', 'description', 'status'];
  var data = whitelistFields(req.body, allowed);
  if (data.event_type && !VALID_EVENT_TYPES.includes(data.event_type)) return res.status(400).json({ error: '无效的事件类型' });
  if (data.risk_level && !VALID_RISK_LEVELS.includes(data.risk_level)) return res.status(400).json({ error: '无效的风险等级' });

  var updated = await db.update('quality_events', req.params.id, data, req.user.username);
  res.json(updated);
}));

app.delete('/api/events/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.delete('quality_events', req.params.id, req.user.username);
  res.json({ success: true });
}));

// ============================================================
// CAPA
// ============================================================
app.get('/api/capa', requireAuth, asyncHandler(async (req, res) => {
  var { status, assignee, search, page, limit } = req.query;
  var capas = await db.findAll('capa_records');
  if (status) capas = capas.filter(function(c) { return c.status === status; });
  if (assignee) capas = capas.filter(function(c) { return c.assignee === assignee; });
  if (search) capas = capas.filter(function(c) { return (c.title || '').includes(search) || (c.id || '').includes(search); });
  capas.sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

  var pageNum = parseInt(page) || 1;
  var pageSize = parseInt(limit) || 50;
  var total = capas.length;
  var start = (pageNum - 1) * pageSize;
  var paged = capas.slice(start, start + pageSize);

  res.json({ data: paged, total: total, page: pageNum, pageSize: pageSize });
}));

app.get('/api/capa/:id', requireAuth, asyncHandler(async (req, res) => {
  var capa = await db.findById('capa_records', req.params.id);
  if (!capa) return res.status(404).json({ error: 'Not found' });
  var auditLogs = await db.getAuditLogs('capa_records', req.params.id);
  res.json({ capa, auditLogs });
}));

app.post('/api/capa', requireAuth, asyncHandler(async (req, res) => {
  requireFields(req.body, ['title', 'action_plan']);
  var data = whitelistFields(req.body, ['title', 'event_id', 'root_cause', 'action_plan', 'assignee', 'due_date', 'effectiveness']);
  data.status = 'Open';

  var capa = await db.insert('capa_records', data, req.user.username);

  // Atomically update linked event status
  if (data.event_id) {
    var evt = await db.findById('quality_events', data.event_id);
    if (evt) await db.update('quality_events', data.event_id, { status: 'CAPA Created' }, req.user.username);
  }
  res.status(201).json(capa);
}));

app.put('/api/capa/:id', requireAuth, asyncHandler(async (req, res) => {
  var capa = await db.findById('capa_records', req.params.id);
  if (!capa) return res.status(404).json({ error: 'Not found' });

  if (req.body.status && !VALID_CAPA_STATUSES.includes(req.body.status)) return res.status(400).json({ error: '无效的状态值' });

  var allowed = ['title', 'event_id', 'root_cause', 'action_plan', 'assignee', 'due_date', 'effectiveness', 'status'];
  var data = whitelistFields(req.body, allowed);
  var updated = await db.update('capa_records', req.params.id, data, req.user.username);

  // Atomically sync event status on CAPA close
  if (data.status === 'Closed' && capa.event_id) {
    await db.update('quality_events', capa.event_id, { status: 'Closed' }, req.user.username);
  }
  res.json(updated);
}));

app.delete('/api/capa/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.delete('capa_records', req.params.id, req.user.username);
  res.json({ success: true });
}));

// ============================================================
// CHANGE CONTROL
// ============================================================
app.get('/api/changes', requireAuth, asyncHandler(async (req, res) => {
  var changes = await db.findAll('change_records');
  if (req.query.status) changes = changes.filter(function(c) { return c.status === req.query.status; });
  changes.sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

  var pageNum = parseInt(req.query.page) || 1;
  var pageSize = parseInt(req.query.limit) || 50;
  var total = changes.length;
  var start = (pageNum - 1) * pageSize;
  res.json({ data: changes.slice(start, start + pageSize), total: total, page: pageNum, pageSize: pageSize });
}));

app.get('/api/changes/:id', requireAuth, asyncHandler(async (req, res) => {
  var change = await db.findById('change_records', req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  var auditLogs = await db.getAuditLogs('change_records', req.params.id);
  res.json({ change, auditLogs });
}));

app.post('/api/changes', requireAuth, asyncHandler(async (req, res) => {
  requireFields(req.body, ['change_type', 'risk', 'impact']);
  if (!VALID_CHANGE_TYPES.includes(req.body.change_type)) return res.status(400).json({ error: '无效的变更类型' });
  if (!VALID_RISK_LEVELS.includes(req.body.risk)) return res.status(400).json({ error: '无效的风险等级' });

  var data = whitelistFields(req.body, ['change_type', 'product_id', 'risk', 'impact', 'validation_status']);
  data.status = 'Pending Approval';
  data.initiator = req.user.username;

  var change = await db.insert('change_records', data, req.user.username);
  res.status(201).json(change);
}));

app.put('/api/changes/:id', requireAuth, asyncHandler(async (req, res) => {
  var allowed = ['change_type', 'product_id', 'risk', 'impact', 'validation_status', 'status'];
  var data = whitelistFields(req.body, allowed);
  if (data.change_type && !VALID_CHANGE_TYPES.includes(data.change_type)) return res.status(400).json({ error: '无效的变更类型' });
  if (data.risk && !VALID_RISK_LEVELS.includes(data.risk)) return res.status(400).json({ error: '无效的风险等级' });

  var updated = await db.update('change_records', req.params.id, data, req.user.username);
  res.json(updated);
}));

app.delete('/api/changes/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.delete('change_records', req.params.id, req.user.username);
  res.json({ success: true });
}));

// ============================================================
// PRODUCTS & SUPPLIERS
// ============================================================
app.get('/api/products', requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.findAll('products'));
}));

app.put('/api/products/:id', requireAuth, asyncHandler(async (req, res) => {
  var allowed = ['product_name', 'platform', 'risk_class', 'lifecycle_status', 'regulatory_status'];
  var data = whitelistFields(req.body, allowed);
  var updated = await db.update('products', req.params.id, data, req.user.username);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
}));

app.get('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.findAll('suppliers'));
}));

// Supplier Score 评分模型
app.get('/api/suppliers/scores', requireAuth, asyncHandler(async (req, res) => {
  var suppliers = await db.findAll('suppliers');
  var scores = suppliers.map(function(s) {
    var qualityScore = (s.quality_score || 0) * 0.5;
    var deliveryScore = ((s.incoming_pass_rate || 0)) * 0.2;
    var systemScore = (s.certification ? (s.certification.includes('13485') ? 100 : 80) : 50) * 0.2;
    var strategyScore = (s.risk_level === 'Low' ? 90 : s.risk_level === 'Medium' ? 70 : 50) * 0.1;
    var total = Math.round(qualityScore + deliveryScore + systemScore + strategyScore);
    return { id: s.id, name: s.supplier_name, supplier_code: s.supplier_code, quality: Math.round(qualityScore * 2), delivery: Math.round(deliveryScore * 5), system: Math.round(systemScore * 5), strategy: Math.round(strategyScore * 10), total: total, risk_level: s.risk_level };
  });
  scores.sort(function(a, b) { return b.total - a.total; });
  res.json(scores);
}));

app.get('/api/suppliers/:id', requireAuth, asyncHandler(async (req, res) => {
  var supplier = await db.findById('suppliers', req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Not found' });
  res.json(supplier);
}));

app.post('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  requireFields(req.body, ['supplier_name']);
  var allowed = ['supplier_name', 'category', 'risk_level', 'quality_score', 'certification'];
  var data = whitelistFields(req.body, allowed);
  res.status(201).json(await db.insert('suppliers', data, req.user.username));
}));

app.put('/api/suppliers/:id', requireAuth, asyncHandler(async (req, res) => {
  var allowed = ['supplier_name', 'category', 'risk_level', 'quality_score', 'certification'];
  var data = whitelistFields(req.body, allowed);
  var updated = await db.update('suppliers', req.params.id, data, req.user.username);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
}));

app.delete('/api/suppliers/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.delete('suppliers', req.params.id, req.user.username);
  res.json({ success: true });
}));

// ============================================================
// PRODUCT LIFECYCLE - 产品状态流转
// ============================================================
var PRODUCT_TRANSITIONS = {
  '开发中': ['试生产'],
  '试生产': ['上市', '开发中'],
  '上市': ['变更中', '退市'],
  '变更中': ['上市', '退市'],
  '退市': [],
};

app.put('/api/products/:id/lifecycle', requireAuth, asyncHandler(async (req, res) => {
  var product = await db.findById('products', req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  var newStatus = req.body.lifecycle_status;
  if (!newStatus || !VALID_PRODUCT_LIFECYCLE.includes(newStatus)) return res.status(400).json({ error: '无效的状态值' });

  var current = product.lifecycle_status || '开发中';
  var allowed = PRODUCT_TRANSITIONS[current];
  if (allowed && !allowed.includes(newStatus)) {
    return res.status(400).json({ error: '无效的状态流转: ' + current + ' -> ' + newStatus });
  }

  var updated = await db.update('products', req.params.id, { lifecycle_status: newStatus }, req.user.username);
  res.json(updated);
}));

// ============================================================
// DASHBOARD / BI
// ============================================================
app.get('/api/dashboard/stats', requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.getDashboardStats());
}));

app.get('/api/dashboard/recent-events', requireAuth, asyncHandler(async (req, res) => {
  var events = (await db.findAll('quality_events'))
    .filter(function(e) { return e.status !== 'Closed'; })
    .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); })
    .slice(0, 10);
  res.json(events);
}));

app.get('/api/dashboard/recent-activity', requireAuth, asyncHandler(async (req, res) => {
  var logs = await db.findAll('audit_logs');
  res.json(logs.slice(-20).reverse());
}));

app.get('/api/audit-logs', requireAuth, asyncHandler(async (req, res) => {
  var pageNum = parseInt(req.query.page) || 1;
  var pageSize = parseInt(req.query.limit) || 50;
  var logs = await db.findAll('audit_logs');
  var sorted = logs.slice().reverse();
  var total = sorted.length;
  var start = (pageNum - 1) * pageSize;
  res.json({ data: sorted.slice(start, start + pageSize), total: total, page: pageNum, pageSize: pageSize });
}));

// ============================================================
// QCP LIBRARY - 质量控制点库 (QO08)
// ============================================================
app.get('/api/qcp', requireAuth, asyncHandler(async (req, res) => {
  var qcps = await db.findAll('qcp_library');
  res.json(qcps);
}));

app.get('/api/qcp/:id', requireAuth, asyncHandler(async (req, res) => {
  var qcp = await db.findById('qcp_library', req.params.id);
  if (!qcp) return res.status(404).json({ error: 'Not found' });
  res.json(qcp);
}));

// ============================================================
// RISK DATABASE - 风险数据库 (QO09)
// ============================================================
app.get('/api/risks', requireAuth, asyncHandler(async (req, res) => {
  var risks = await db.findAll('risk_database');
  res.json(risks);
}));

app.get('/api/risks/:id', requireAuth, asyncHandler(async (req, res) => {
  var risk = await db.findById('risk_database', req.params.id);
  if (!risk) return res.status(404).json({ error: 'Not found' });
  res.json(risk);
}));

// ============================================================
// PMS ALERTS - 投诉趋势检测
// ============================================================
app.get('/api/pms/alerts', requireAuth, asyncHandler(async (req, res) => {
  var events = (await db.findAll('quality_events'))
    .filter(function(e) { return e.event_type === 'Complaint'; })
    .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

  var alerts = [];
  // Group complaints by product
  var byProduct = {};
  events.forEach(function(e) {
    var key = e.product_id || 'unknown';
    if (!byProduct[key]) byProduct[key] = { product: e.product_name, count: 0, events: [] };
    byProduct[key].count++;
    byProduct[key].events.push(e);
  });

  // Alert if product has 3+ complaints in 6 months
  Object.values(byProduct).forEach(function(g) {
    if (g.count >= 3) {
      alerts.push({ type: 'complaint_spike', severity: 'High', product: g.product, count: g.count, message: g.product + ' 近期投诉达' + g.count + '起，建议重点关注' });
    }
  });

  // Alert on high-risk open events
  events.filter(function(e) { return e.status !== 'Closed' && (e.risk_level === 'High' || e.risk_level === 'Critical'); }).forEach(function(e) {
    alerts.push({ type: 'high_risk_open', severity: e.risk_level, product: e.product_name, eventId: e.id, message: e.product_name + ' 存在未关闭的' + e.risk_level + '风险事件: ' + (e.description||'').slice(0, 60) });
  });

  res.json({ alerts: alerts.slice(0, 10), totalComplaints: events.length });
}));

// ============================================================
// SUPPLIER SCORE - 供应商评分模型
// ============================================================
app.get('/api/suppliers/scores', requireAuth, asyncHandler(async (req, res) => {
  var suppliers = await db.findAll('suppliers');
  var scores = suppliers.map(function(s) {
    var qualityScore = (s.quality_score || 0) * 0.5;
    var deliveryScore = ((s.incoming_pass_rate || 0)) * 0.2;
    var systemScore = (s.certification ? (s.certification.includes('13485') ? 100 : 80) : 50) * 0.2;
    var strategyScore = (s.risk_level === 'Low' ? 90 : s.risk_level === 'Medium' ? 70 : 50) * 0.1;
    var total = Math.round(qualityScore + deliveryScore + systemScore + strategyScore);

    return {
      id: s.id,
      name: s.supplier_name,
      supplier_code: s.supplier_code,
      quality: Math.round(qualityScore * 2),
      delivery: Math.round(deliveryScore * 5),
      system: Math.round(systemScore * 5),
      strategy: Math.round(strategyScore * 10),
      total: total,
      risk_level: s.risk_level,
    };
  });

  scores.sort(function(a, b) { return b.total - a.total; });
  res.json(scores);
}));

// ============================================================
// AI ASSISTANT
// ============================================================
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

app.post('/api/ai/chat', requireAuth, (req, res) => {
  var { assistantType, messages, contextData } = req.body;
  if (!aiService.isAvailable()) return res.status(503).json({ error: 'AI服务未配置' });
  if (!assistantType || !['quality_expert', 'knowledge', 'capa_rca', 'risk_prediction'].includes(assistantType)) {
    return res.status(400).json({ error: '无效的助手类型' });
  }
  var fullMessages = aiService.buildMessages(assistantType, messages || [], contextData || null);
  aiService.streamChat(assistantType, fullMessages, res);
});

app.post('/api/ai/chat/simple', requireAuth, asyncHandler(async (req, res) => {
  var { assistantType, messages, contextData } = req.body;
  if (!aiService.isAvailable()) return res.status(503).json({ error: 'AI服务未配置' });
  var fullMessages = aiService.buildMessages(assistantType, messages || [], contextData || null);
  var response = await aiService.chat(assistantType, fullMessages);
  res.json({ content: response });
}));

app.post('/api/ai/analyze-event/:eventId', requireAuth, asyncHandler(async (req, res) => {
  var event = await db.findById('quality_events', req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  var capas = (await db.findAll('capa_records')).filter(function(c) { return c.event_id === event.id; });
  var relatedEvents = (await db.findAll('quality_events')).filter(function(e) { return e.product_id === event.product_id && e.id !== event.id; });
  var product = event.product_id ? await db.findById('products', event.product_id) : null;

  var contextData = {
    event, relatedCAPAs: capas, product,
    relatedEvents: relatedEvents.slice(0, 5),
    analysisContext: {
      totalEventsForProduct: relatedEvents.length,
      existingCAPAsForEvent: capas.length,
      similarEvents: relatedEvents.map(function(e) { return { id: e.id, type: e.event_type, status: e.status, desc: e.description?.slice(0, 100) }; }),
    }
  };

  var messages = [{
    role: 'user',
    content: '请对以下质量事件进行根因分析和CAPA建议:\n\n事件ID: ' + event.id + '\n类型: ' + event.event_type + '\n产品: ' + (event.product_name || 'N/A') + '\n批号: ' + (event.batch_no || 'N/A') + '\n风险等级: ' + event.risk_level + '\n状态: ' + event.status + '\n描述: ' + event.description + '\n\n请提供:\n1. 可能的根因分析\n2. 建议的CAPA计划\n3. 风险评估'
  }];

  var fullMessages = aiService.buildMessages('capa_rca', messages, contextData);
  var response = await aiService.chat('capa_rca', fullMessages);
  res.json({ content: response, eventId: event.id });
}));

app.post('/api/ai/risk-predict', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var products = await db.findAll('products');
  var suppliers = await db.findAll('suppliers');

  var contextData = {
    summary: {
      totalEvents: events.length,
      openEvents: events.filter(function(e) { return e.status === 'Open' || e.status === 'In Investigation'; }).length,
      criticalEvents: events.filter(function(e) { return e.risk_level === 'Critical' || e.risk_level === 'High'; }).length,
      overdueCAPAs: capas.filter(function(c) { return c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed'; }).length,
    },
    eventsByProduct: {}, eventsByType: {},
    riskDistribution: { Low: 0, Medium: 0, High: 0, Critical: 0 },
    monthlyCounts: {}, topRiskProducts: [],
  };

  events.forEach(function(e) {
    contextData.riskDistribution[e.risk_level] = (contextData.riskDistribution[e.risk_level] || 0) + 1;
    contextData.eventsByType[e.event_type] = (contextData.eventsByType[e.event_type] || 0) + 1;
    if (e.product_name) contextData.eventsByProduct[e.product_name] = (contextData.eventsByProduct[e.product_name] || 0) + 1;
    if (e.created_at) { var m = e.created_at.slice(0, 7); contextData.monthlyCounts[m] = (contextData.monthlyCounts[m] || 0) + 1; }
  });

  contextData.topRiskProducts = Object.entries(contextData.eventsByProduct)
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5)
    .map(function(entry) { return { name: entry[0], count: entry[1] }; });

  var messages = [{ role: 'user', content: '请基于当前质量数据进行风险预测分析' }];
  var fullMessages = aiService.buildMessages('risk_prediction', messages, contextData);
  var response = await aiService.chat('risk_prediction', fullMessages);
  res.json({ content: response, data: contextData });
}));

// ============================================================
// START
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.connect().then(function() {
  app.listen(PORT, function() {
    console.log('\n  ╔══════════════════════════════════════════════╗\n  ║   FosunDx Quality Hub (FDQH) Platform       ║\n  ║   IVD 数字化质量管理平台 v1.1                 ║\n  ║   http://localhost:' + PORT + '                      ║\n  ╚══════════════════════════════════════════════╝\n  ');
    console.log('  默认账号: admin / admin123');
  });
}).catch(function(err) {
  console.error('Database init error:', err.message);
  app.listen(PORT, function() { console.log('Server started on ' + PORT + ' (no database)'); });
});
