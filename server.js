// ============================================================
// FDQH - FosunDx Quality Hub Server v1.6
// MongoDB + JSON Fallback | Rate Limiting | Session Expiry
// ============================================================
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
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
var VALID_CHANGE_TYPES = ['工艺变更', '设备变更', '物料变更', '文件变更', '产品变更', '设计变更', '工程变更', '试剂变更', '仪器变更', '文件记录变更', '包材/标签变更'];
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

// ============================================================
// EVENTS CATEGORIES — 质量事件四分类看板 (偏差/内审/日常/投诉)
// ============================================================
app.get('/api/events/categories', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');

  // 四分类映射
  function classify(e) {
    switch (e.event_type) {
      case 'Deviation': case 'OOS': case 'OOT': return 'deviation';
      case 'Audit-Finding': return 'audit';
      case 'NCR': case 'SCAR': return 'daily';
      case 'Complaint': return 'complaint';
      default: return 'other';
    }
  }

  var CATS = [
    { id: 'deviation', name: '偏差', icon: '⚠️', types: 'Deviation / OOS / OOT', color: '#F59E0B', desc: '生产过程偏差与超标调查' },
    { id: 'audit', name: '内外审发现', icon: '📋', types: 'Audit-Finding', color: '#6366F1', desc: '内部审核发现的体系缺陷' },
    { id: 'daily', name: '日常发现', icon: '🔍', types: 'NCR / SCAR', color: '#10B981', desc: '日常巡检与IPQC发现问题' },
    { id: 'complaint', name: '客户投诉', icon: '📢', types: 'Complaint', color: '#EF4444', desc: '客户投诉与市场反馈' },
  ];

  var result = CATS.map(function(cat) {
    var items = events.filter(function(e) { return classify(e) === cat.id; });
    var byMonth = {}, byStatus = {}, byRisk = {}, byProduct = {};
    items.forEach(function(e) {
      var m = e.complaint_month || (e.created_at ? new Date(e.created_at).getMonth() + 1 : null);
      if (m) byMonth[m] = (byMonth[m] || 0) + 1;
      byStatus[e.status || 'Unknown'] = (byStatus[e.status || 'Unknown'] || 0) + 1;
      byRisk[e.risk_level || 'Unknown'] = (byRisk[e.risk_level || 'Unknown'] || 0) + 1;
      var p = e.product_name || '未分类';
      byProduct[p] = (byProduct[p] || 0) + 1;
    });
    var topProducts = Object.keys(byProduct).map(function(p) { return { name: p, count: byProduct[p] }; })
      .sort(function(a, b) { return b.count - a.count; }).slice(0, 5);

    return {
      id: cat.id, name: cat.name, icon: cat.icon, types: cat.types, color: cat.color, desc: cat.desc,
      kpi: {
        total: items.length,
        open: items.filter(function(e) { return e.status !== 'Closed'; }).length,
        closed: items.filter(function(e) { return e.status === 'Closed'; }).length,
        closeRate: items.length ? Math.round(items.filter(function(e) { return e.status === 'Closed'; }).length / items.length * 100) : 0,
        highRisk: items.filter(function(e) { return e.risk_level === 'High' || e.risk_level === 'Critical'; }).length,
      },
      byMonth: byMonth, byStatus: byStatus, byRisk: byRisk, topProducts: topProducts,
    };
  });

  // 汇总
  var totalAll = events.length;
  var totalByType = {};
  events.forEach(function(e) { totalByType[e.event_type] = (totalByType[e.event_type] || 0) + 1; });

  res.json({ categories: result, total: totalAll, byType: totalByType });
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

  var data = whitelistFields(req.body, ['event_type', 'risk_level', 'product_id', 'product_name', 'batch_no', 'description', 'complaint_source', 'complaint_month', 'complaint_date', 'complaint_process_id', 'complaint_cause', 'complaint_repeat', 'imported', 'created_at']);
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
// CAPA摘要看板
app.get('/api/capa/summary', requireAuth, asyncHandler(async (req, res) => {
  var capas = await db.findAll('capa_records');
  var byStatus = {}, bySource = {}, byDept = {};
  capas.forEach(function(c) {
    byStatus[c.status||'Open'] = (byStatus[c.status||'Open']||0) + 1;
    var src = c.audit_source || '未分类';
    bySource[src] = (bySource[src]||0) + 1;
    var dept = c.audit_dept || c.assignee || '未分类';
    byDept[dept] = (byDept[dept]||0) + 1;
  });

  // 审核来源分组 (数据来源: table capa.csv)
  var auditList = [
    { source: '西门子供应商审核', count: 1, closed: capas.filter(function(c){return c.capa_no==='A-CAPA-S-20260101'&&c.status==='Closed'}).length, capaNos: 'A-CAPA-S-20260101', summary: '工艺规程与批记录不一致' },
    { source: 'CA50首次注册体考', count: 10, closed: capas.filter(function(c){return (c.capa_no||'').replace(/-\d+$/,'').replace(/0+$/,'').indexOf('A-CAPA-S-202601')>=0&&c.status==='Closed'}).length, capaNos: 'A-CAPA-S-20260102~011', summary: '原材料筛选/软件验证/供应商协议/记录完整性' },
    { source: '泰州基地日常检查', count: 2, closed: capas.filter(function(c){return c.capa_no==='B-CAPA-S-20260406'||c.capa_no==='B-CAPA-S-20260407'?c.status==='Closed':false}).length, capaNos: 'B-CAPA-S-20260406~07', summary: '生产记录/检验记录' },
    { source: '上海日常监督检查', count: 2, closed: capas.filter(function(c){return c.capa_no==='A-CAPA-S-20260501'||c.capa_no==='A-CAPA-S-20260502'?c.status==='Closed':false}).length, capaNos: 'A-CAPA-S-20260501~02', summary: '工艺配制/BOM结构' },
    { source: 'LP(a)体考 + CA50复核', count: 5, closed: capas.filter(function(c){return (c.capa_no||'').indexOf('A-CAPA-S-202606')>=0&&c.status==='Closed'}).length, capaNos: 'A-CAPA-S-20260601~05', summary: '法规清单/校准赋值/软件验证' },
    { source: '2025上海基地内审', count: 6, closed: capas.filter(function(c){return (c.capa_no||'').indexOf('A-CAPA-S-2025-12')>=0&&c.status==='Closed'}).length, capaNos: 'A-CAPA-S-2025-1201~06', summary: '过期物料/设施/记录/设备校准' },
  ];

  res.json({
    total: capas.length,
    open: capas.filter(function(c) { return c.status !== 'Closed'; }).length,
    closed: capas.filter(function(c) { return c.status === 'Closed'; }).length,
    byStatus: byStatus, bySource: bySource, byDept: byDept,
    auditGroups: auditList,
  });
}));

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
  var data = whitelistFields(req.body, ['title', 'event_id', 'root_cause', 'action_plan', 'assignee', 'due_date', 'effectiveness', 'status', 'description', 'audit_source', 'audit_dept', 'clause_no', 'capa_no', 'imported']);
  data.status = data.status || 'Open';

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
// 变更控制摘要统计
app.get('/api/changes/summary', requireAuth, asyncHandler(async (req, res) => {
  var changes = await db.findAll('change_records');
  var byLevel = { 'I': 0, 'II': 0, 'III': 0 }, byStatus = {}, byType = {}, byBase = {};
  // 1. I/II/III × 状态交叉表 (累积图)
  var levelStatus = { 'I': {}, 'II': {}, 'III': {} };

  changes.forEach(function(c) {
    var lv = c.change_level || c.risk || '';
    if (lv.includes('I') && !lv.includes('II')) { byLevel.I = (byLevel.I||0) + 1; lv = 'I'; }
    else if (lv.includes('II') && !lv.includes('III')) { byLevel.II = (byLevel.II||0) + 1; lv = 'II'; }
    else if (lv.includes('III')) { byLevel.III = (byLevel.III||0) + 1; lv = 'III'; }
    else { byLevel.I = (byLevel.I||0) + 1; lv = 'I'; }
    var st = c.status === '完成' ? '完成' : c.status === '是' ? '完成' : '未完成';
    byStatus[st] = (byStatus[st]||0) + 1;
    levelStatus[lv][st] = (levelStatus[lv][st]||0) + 1;
    var bt = c.base || '未知';
    byBase[bt] = (byBase[bt]||0) + 1;
    var ct = c.change_type || '未分类';
    byType[ct] = (byType[ct]||0) + 1;
  });

  // 2. 基地占比 (name + count + pct)
  var basePie = Object.keys(byBase).map(function(k) { return { name: k, count: byBase[k], pct: Math.round(byBase[k]/changes.length*100) }; }).sort(function(a,b){return b.count-a.count;});

  // 3. 产品类型占比
  var productPie = Object.keys(byType).map(function(k) { return { name: k, count: byType[k], pct: Math.round(byType[k]/changes.length*100) }; }).sort(function(a,b){return b.count-a.count;});

  // 4. 变更对象帕累托 (按变更类型+等级)
  var byChangeType = {};
  changes.forEach(function(c) {
    var key = (c.product_type_desc || c.change_type || '未分类');
    byChangeType[key] = (byChangeType[key]||0) + 1;
  });
  var pareto = Object.keys(byChangeType).map(function(k) { return { name: k, count: byChangeType[k] }; }).sort(function(a,b){return b.count-a.count;});
  var pTotal = pareto.reduce(function(s,x){return s+x.count;},0);
  var cum = 0;
  pareto.forEach(function(x) { cum += x.count; x.cumPct = pTotal ? Math.round(cum/pTotal*100) : 0; });
  if (pareto.length > 10) pareto = pareto.slice(0, 10);

  // 5. I/II/III 状态累积 (stacked bar)
  var levelStack = ['I','II','III'].map(function(lv) {
    return { level: lv + '类', count: byLevel[lv]||0, complete: levelStatus[lv]['完成']||0, incomplete: levelStatus[lv]['未完成']||0 };
  });

  res.json({
    total: changes.length,
    completed: changes.filter(function(c) { return c.status === '完成' || c.status === '已完成' || c.status === 'Closed'; }).length,
    byLevel: byLevel, byStatus: byStatus, byBase: byBase,
    basePie: basePie,
    productPie: productPie,
    changePareto: pareto,
    levelStack: levelStack,
  });
}));

// 变更控制深度分析 (I/II/III×设计/工程 + 变更对象帕累托)
app.get('/api/changes/analysis', requireAuth, asyncHandler(async (req, res) => {
  var changes = await db.findAll('change_records');

  // 1. I/II/III × 设计/工程 交叉表
  var crossData = { 'I': { '设计变更': 0, '工程变更': 0 }, 'II': { '设计变更': 0, '工程变更': 0 }, 'III': { '设计变更': 0, '工程变更': 0 } };
  changes.forEach(function(c) {
    var lv = (c.change_level || '').trim();
    if (lv.includes('I') && !lv.includes('II')) lv = 'I';
    else if (lv.includes('II') && !lv.includes('III')) lv = 'II';
    else if (lv.includes('III')) lv = 'III';
    else return;
    if (!crossData[lv]) return;
    var track = (c.change_track || '工程变更').trim();
    if (!crossData[lv][track]) crossData[lv][track] = 0;
    crossData[lv][track]++;
  });

  // 2. 变更对象分类统计 (Pareto)
  var byObject = {};
  changes.forEach(function(c) {
    var obj = (c.change_object || '未分类').trim();
    if (!obj) obj = '未分类';
    // Group similar objects
    if (obj.includes('原料') || obj.includes('供应商')) obj = '原料/供应商';
    else if (obj.includes('工艺') || obj.includes('配方')) obj = '工艺/配方';
    else if (obj.includes('说明书') || obj.includes('标签') || obj.includes('文件')) obj = '说明书/标签/文件';
    else if (obj.includes('技术要求') || obj.includes('标准')) obj = '技术要求/标准';
    else if (obj.includes('软件') || obj.includes('程序')) obj = '软件/固件';
    else if (obj.includes('降本')) obj = '降本优化';
    else if (obj.includes('BOM') || obj.includes('物料')) obj = 'BOM/物料结构';
    else if (obj.includes('规格') || obj.includes('设计')) obj = '规格/设计';
    else if (obj.includes('硬件')) obj = '硬件变更';
    else if (obj.length > 8 && obj.indexOf('变更') === -1) obj = obj.substring(0, 10);
    byObject[obj] = (byObject[obj] || 0) + 1;
  });
  // Pareto
  var objPareto = Object.keys(byObject).map(function(k) { return { name: k, count: byObject[k] }; })
    .sort(function(a, b) { return b.count - a.count; });
  var pTotal = objPareto.reduce(function(s, x) { return s + x.count; }, 0);
  var cum = 0;
  objPareto.forEach(function(x) { cum += x.count; x.cumPct = pTotal ? Math.round(cum / pTotal * 100) : 0; });
  objPareto = objPareto.slice(0, 12);

  // 3. 设计变更 vs 工程变更 总计
  var trackTotal = { '设计变更': 0, '工程变更': 0 };
  changes.forEach(function(c) {
    var t = (c.change_track || '工程变更').trim();
    if (trackTotal[t] !== undefined) trackTotal[t]++;
  });

  res.json({
    cross: crossData,
    objectPareto: objPareto,
    trackTotal: trackTotal,
    total: changes.length,
  });
}));

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
  if (!VALID_CHANGE_TYPES.includes(req.body.change_type)) return res.status(400).json({ error: '无效的变更类型: ' + req.body.change_type });
  if (!VALID_RISK_LEVELS.includes(req.body.risk)) return res.status(400).json({ error: '无效的风险等级' });

  var data = whitelistFields(req.body, ['change_type', 'product_id', 'risk', 'impact', 'validation_status', 'change_level', 'change_no', 'product_type_desc', 'base', 'description', 'status', 'imported', 'change_object', 'change_desc', 'change_track']);
  data.status = data.status || 'Pending Approval';
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
  var allowed = ['product_name', 'product_code', 'product_category', 'detection_tech', 'platform', 'risk_class', 'reg_category', 'lifecycle_status', 'regulatory_status', 'reg_no', 'indications', 'spec_model', 'storage_condition', 'shelf_life', 'cqa_list', 'cma_list', 'cpp_list', 'components', 'throughput'];
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

// POST QCP — allow creating new CLIA QCPs
app.post('/api/qcp', requireAuth, asyncHandler(async (req, res) => {
  var qcp = await db.insert('qcp_library', req.body, req.user.username);
  res.status(201).json(qcp);
}));

// QCP Rule Check — MUST be before /api/qcp/:id to avoid route conflict
app.get('/api/qcp/check', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var results = [];
  var passed = 0, failed = 0, warning = 0;

  var highOpen = events.filter(function(e) { return (e.risk_level === 'High' || e.risk_level === 'Critical') && e.status !== 'Closed'; });
  results.push({ rule: 'RULE-RM-001', name: '高风险事件关闭检查', status: highOpen.length === 0 ? 'pass' : 'fail', message: highOpen.length + ' 个高风险事件未关闭' });
  if (highOpen.length > 0) failed++; else passed++;

  var overdue = capas.filter(function(c) { return c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed'; });
  results.push({ rule: 'RULE-CAPA-001', name: 'CAPA逾期检查', status: overdue.length === 0 ? 'pass' : 'fail', message: overdue.length + ' 个CAPA逾期' });
  if (overdue.length > 0) failed++; else passed++;

  var cutoff = new Date(Date.now() - 90*86400000).toISOString();
  var recentComplaints = events.filter(function(e) { return e.event_type === 'Complaint' && e.created_at > cutoff; });
  results.push({ rule: 'RULE-PMS-001', name: '投诉趋势监控', status: recentComplaints.length < 2 ? 'pass' : 'warning', message: '近90天投诉' + recentComplaints.length + '起' });
  if (recentComplaints.length >= 3) failed++; else if (recentComplaints.length >= 2) warning++; else passed++;

  res.json({ results: results, summary: { passed: passed, failed: failed, warning: warning, total: passed + failed + warning } });
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
// QUALITY KPI DASHBOARD — 质量指标体系
// ============================================================

// QHI: Quality Health Index (客户20%+生产25%+供应20%+体系15%+改善10%+效率10%)
app.get('/api/dashboard/qhi', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var suppliers = await db.findAll('suppliers');
  var products = await db.findAll('products');

  var complaints = events.filter(function(e) { return e.event_type === 'Complaint'; });
  var closedComplaints = complaints.filter(function(e) { return e.status === 'Closed'; });
  var deviations = events.filter(function(e) { return e.event_type === 'Deviation' || e.event_type === 'OOS' || e.event_type === 'OOT'; });
  var closedCapas = capas.filter(function(c) { return c.status === 'Closed'; });
  var auditFindings = events.filter(function(e) { return e.event_type === 'Audit-Finding'; });
  var totalSuppliers = suppliers.length || 1;
  var avgSupplierScore = suppliers.reduce(function(sum, s) { return sum + (s.quality_score || 0); }, 0) / totalSuppliers;

  // === TQM 三维度 ===
  // 🏥 患者结果 = 投诉关闭率×0.25 + 批合格率×0.35 + CAPA效果×0.25 + 严重事件率×0.15
  var complaintCloseRate = complaints.length > 0 ? Math.round((closedComplaints.length / complaints.length) * 100) : 100;
  var batchPassRate = deviations.length > 0 ? Math.max(0, 100 - Math.min(deviations.length / Math.max(events.length, 1) * 100, 40)) : 95;
  var capaEffectScore = capas.length > 0 ? Math.round((closedCapas.filter(function(c) { return c.effectiveness === '有效'; }).length / capas.length) * 100) : 90;
  var severeRate = events.length > 0 ? Math.max(0, 100 - events.filter(function(e) { return e.risk_level === 'Critical' || e.risk_level === 'High'; }).length / events.length * 100) : 100;
  var patientScore = Math.round(complaintCloseRate * 0.25 + batchPassRate * 0.35 + capaEffectScore * 0.25 + severeRate * 0.15);

  // 📋 合规质量 = 审计关闭率×0.30 + CAPA关闭率×0.25 + SCAR关闭率×0.20 + 体系完整度×0.25
  var auditCloseRate = auditFindings.length > 0 ? Math.round(auditFindings.filter(function(e) { return e.status === 'Closed'; }).length / auditFindings.length * 100) : 100;
  var capaCloseRate = capas.length > 0 ? Math.round((closedCapas.length / capas.length) * 100) : 100;
  var scarEvents = events.filter(function(e) { return e.event_type === 'SCAR'; });
  var scarCloseRate = scarEvents.length > 0 ? Math.round(scarEvents.filter(function(e) { return e.status === 'Closed'; }).length / scarEvents.length * 100) : 100;
  var complianceScore = Math.round(auditCloseRate * 0.30 + capaCloseRate * 0.25 + scarCloseRate * 0.20 + 85 * 0.25);

  // ⚡ 经营效率 = 放行周期×0.20 + 偏差率×0.30 + 供应PPM×0.25 + 变更周期×0.25
  var deviationRateScore = events.length > 0 ? Math.max(60, 100 - Math.min(deviations.length / events.length * 100, 30)) : 95;
  var supplyScore = Math.round(Math.min(avgSupplierScore, 100));
  var avgCapaCycle = capas.filter(function(c) { return c.status === 'Closed' && c.due_date; }).length > 0 ? 85 : 90;
  var efficiencyScore = Math.round(deviationRateScore * 0.30 + supplyScore * 0.25 + avgCapaCycle * 0.20 + 90 * 0.25);

  var qhi = Math.round(patientScore * 0.40 + complianceScore * 0.30 + efficiencyScore * 0.30);

  // === 四域指标 ===
  var domainMetrics = {
    rd: { name: '研发质量', designReview: 95, verificationPass: 90, score: 92 },
    supply: { name: '供应链质量', incomingPass: Math.round(avgSupplierScore), supplierAudit: 85, score: Math.round((avgSupplierScore + 85) / 2) },
    mfg: { name: '生产质量', batchPass: batchPassRate, deviationRate: 100 - Math.round(deviations.length / Math.max(events.length, 1) * 100), score: Math.round((batchPassRate + (100 - Math.round(deviations.length / Math.max(events.length, 1) * 100))) / 2) },
    pms: { name: '上市后质量', complaintClose: complaintCloseRate, trendNormal: recentComplaintsCheck(events) ? 100 : 75, score: Math.round((complaintCloseRate + (recentComplaintsCheck(events) ? 100 : 75)) / 2) },
  };

  res.json({
    qhi: qhi,
    level: qhi >= 90 ? 'green' : qhi >= 70 ? 'yellow' : 'red',
    tqm: {
      patient: { score: patientScore, label: '患者结果', weight: '40%', detail: { complaints: complaintCloseRate, batch: batchPassRate, capaEffect: capaEffectScore, severe: severeRate } },
      compliance: { score: complianceScore, label: '合规质量', weight: '30%', detail: { audit: auditCloseRate, capa: capaCloseRate, scar: scarCloseRate } },
      efficiency: { score: efficiencyScore, label: '经营效率', weight: '30%', detail: { deviation: deviationRateScore, supply: supplyScore, cycle: avgCapaCycle } },
    },
    domains: domainMetrics,
    breakdown: {
      customer: { score: complaintCloseRate, weight: '20%' },
      production: { score: batchPassRate, weight: '25%' },
      supply: { score: supplyScore, weight: '20%' },
      compliance: { score: complianceScore, weight: '15%' },
      improvement: { score: capaCloseRate, weight: '10%' },
      efficiency: { score: efficiencyScore, weight: '10%' },
    }
  });
}));

function recentComplaintsCheck(events) {
  var cutoff = new Date(Date.now() - 90*86400000).toISOString();
  return events.filter(function(e) { return e.event_type === 'Complaint' && e.created_at > cutoff; }).length < 2;
}

// Traffic Light 红黄绿预警
app.get('/api/dashboard/alerts', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var alerts = [];

  // Red: 高风险未关闭事件
  var criticalOpen = events.filter(function(e) { return (e.risk_level === 'Critical' || e.risk_level === 'High') && e.status !== 'Closed'; });
  criticalOpen.forEach(function(e) {
    alerts.push({ level: 'red', type: 'high_risk_event', message: e.product_name + ': ' + e.event_type + '未关闭 (风险:' + e.risk_level + ')', eventId: e.id });
  });

  // Yellow: CAPA逾期
  capas.filter(function(c) { return c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed'; }).forEach(function(c) {
    alerts.push({ level: 'yellow', type: 'capa_overdue', message: 'CAPA逾期: ' + c.title + ' (截止:' + c.due_date + ')', capaId: c.id });
  });

  // Yellow: 投诉突增
  var recentComplaints = events.filter(function(e) { return e.event_type === 'Complaint' && e.created_at > new Date(Date.now() - 90*86400000).toISOString(); });
  if (recentComplaints.length >= 2) {
    alerts.push({ level: 'yellow', type: 'complaint_spike', message: '近90天投诉' + recentComplaints.length + '起，需关注', count: recentComplaints.length });
  }

  // Green: 正常运行的积极信号
  if (alerts.length === 0) {
    alerts.push({ level: 'green', type: 'all_clear', message: '所有质量指标正常 ✓' });
  }

  res.json({ alerts: alerts.slice(0, 10), total: alerts.length, redCount: alerts.filter(function(a) { return a.level === 'red'; }).length, yellowCount: alerts.filter(function(a) { return a.level === 'yellow'; }).length });
}));

// Product Quality Score (生产30%+实验室20%+投诉25%+供应商15%+变更10%)
app.get('/api/products/scores', requireAuth, asyncHandler(async (req, res) => {
  var products = await db.findAll('products');
  var events = await db.findAll('quality_events');
  var changes = await db.findAll('change_records');

  var scores = products.map(function(p) {
    var pEvents = events.filter(function(e) { return e.product_id === p.id; });
    var pChanges = changes.filter(function(c) { return c.product_id === p.id; });
    var closedEvents = pEvents.filter(function(e) { return e.status === 'Closed'; });
    var approvedChanges = pChanges.filter(function(c) { return c.status === 'Approved'; });

    var productionScore = pEvents.length > 0 ? Math.max(0, 100 - pEvents.length * 10) : 95;
    var labScore = pEvents.filter(function(e) { return e.event_type === 'OOS' || e.event_type === 'OOT'; }).length > 0 ? 80 : 100;
    var complaintScore = pEvents.filter(function(e) { return e.event_type === 'Complaint'; }).length > 0 ? 85 : 100;
    var supplierScore = 90; // Placeholder
    var changeScore = pChanges.length > 0 ? Math.round((approvedChanges.length / pChanges.length) * 100) : 100;

    var total = Math.round(productionScore * 0.30 + labScore * 0.20 + complaintScore * 0.25 + supplierScore * 0.15 + changeScore * 0.10);

    return { id: p.id, name: p.product_name, score: total, level: total >= 90 ? 'green' : total >= 70 ? 'yellow' : 'red', events: pEvents.length, complaints: pEvents.filter(function(e) { return e.event_type === 'Complaint'; }).length };
  });

  scores.sort(function(a, b) { return a.score - b.score; });
  res.json(scores);
}));

// Daily Quality Report
app.get('/api/dashboard/daily-report', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var today = new Date().toISOString().slice(0, 10);
  var week = new Date(Date.now() - 7*86400000).toISOString();

  res.json({
    date: today,
    yesterdayEvents: events.filter(function(e) { return e.created_at && e.created_at.slice(0, 10) >= week; }).length,
    openEvents: events.filter(function(e) { return e.status !== 'Closed'; }).length,
    highRiskOpen: events.filter(function(e) { return (e.risk_level === 'High' || e.risk_level === 'Critical') && e.status !== 'Closed'; }).length,
    overdueCAPAs: capas.filter(function(c) { return c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed'; }).length,
    newComplaints: events.filter(function(e) { return e.event_type === 'Complaint' && e.created_at && e.created_at.slice(0, 10) >= week; }).length,
    topRisks: events.filter(function(e) { return e.status !== 'Closed' && (e.risk_level === 'High' || e.risk_level === 'Critical'); }).slice(0, 5).map(function(e) { return { id: e.id, type: e.event_type, product: e.product_name, risk: e.risk_level, desc: (e.description||'').slice(0, 60) }; }),
  });
}));

// ============================================================
// TQM KPIs — 按PPT三类指标: 红线/经营/提升
// 数据来源: 质量管理保龄球图-202605
// ============================================================
app.get('/api/dashboard/kpis', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');

  var complaints = events.filter(function(e) { return e.event_type === 'Complaint'; });
  var closedComplaints = complaints.filter(function(e) { return e.status === 'Closed'; });
  var closedCapas = capas.filter(function(c) { return c.status === 'Closed'; });
  var overdueCapas = capas.filter(function(c) { return c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed'; });

  // ===== 红牌 KPI from 保龄球图 (2026-05 YTD) =====
  var BOWLING = {
    // 战略解码 - 仪器/试剂质量
    doaOverallYTD: 8.7,       // 仪器到货缺陷率 Overall YTD 8.7%, target 8%
    doaNewYTD: 9.1,           // 新产品质量 DOA YTD 9.1%
    doaMassYTD: 7.7,          // 量产品 DOA YTD 7.7%
    ffrOverallYTD: 8.1,       // 装机月度仪器维修率 Overall YTD 8.1%, target 8%
    ffrNewYTD: 7.8,           // 新品维修率 YTD 7.8%
    ffrMassYTD: 8.5,          // 量产维修率 YTD 8.5%
    reagentDefectOverallYTD: 2.2,  // 试剂市场缺陷率 Overall YTD 2.2%, target 2.5%
    reagentDefectCLIA: 6.0,   // 发光条线缺陷率 YTD 6.0% ⚠️
    reagentDefectBio: 0.9,    // 生化条线 YTD 0.9%
    reagentDefectMol: 3.7,    // 分子条线 YTD 3.7% ⚠️

    // 日常检验 KPI (YTD)
    pkgPassRate: 99.5,        // 包材检验合格率 99.5%, target 98%
    rawReagentPassRate: 99.5, // 原料检验合格率（试剂）99.5%, target 99%
    rawInstrumentPassRate: 99.0, // 原料检验合格率（仪器）99.0%, target 97%
    semiReagentPassRate: 97.4, // 半成品检验合格率 97.4%, target 98% ⚠️
    finalReagentPassRate: 99.9, // 成品检验合格率（试剂）99.9%, target 99%
    finalInstrumentPassRate: 100, // 成品检验合格率（仪器）100%, target 85%
    batchRecordPassRate: 96.7, // 批记录合格率 96.7%, target 95%
    stabilityCompleteRate: 79.2, // 稳定性检测完成率 79.2% 🔴 target 100%
    stabilityPassRate: 100,    // 稳定性检测合格率 100%
    complaintCountYTD: 79,     // 1-5月客诉总计 79件
    complaintsByLine: { '发光': 30, '生化': 13, '微生物': 26, '荧光PCR': 9, 'POCT': 1 },
  };

  var kpis = {
    // 🔴 红线类 — 一票否决指标 (参照TQM指标确认.xlsx)
    // 红线标准: 外部审计无重大缺陷 / 批批检·市场抽检·监督抽样无不合格 / 药监不良事件按时报告 / 电击起火等电气安全事故为0
    redlines: [
      { name: '无重大缺陷率', value: (function(){ var criticalOpen = events.filter(function(e){ return e.risk_level === 'Critical' && e.status !== 'Closed'; }); return criticalOpen.length === 0 ? 100 : Math.round(Math.max(0, 100 - criticalOpen.length * 5)); })(), target: 100, unit: '%', status: (function(){ return events.filter(function(e){ return e.risk_level === 'Critical' && e.status !== 'Closed'; }).length === 0 ? 'pass' : 'fail'; })(), source: '外部审计+内部事件 无重大缺陷', trend: 'stable' },
      { name: '出货产品合格率', value: BOWLING.finalReagentPassRate, target: 100, unit: '%', status: BOWLING.finalReagentPassRate >= 100 ? 'pass' : 'warning', source: '成品检验(试剂)YTD 99.9% 批批检', trend: 'stable' },
      { name: '不良事件按时报告率', value: 100, target: 100, unit: '%', status: 'pass', source: '药监不良事件报告 0逾期', trend: 'stable' },
      { name: '电气安全不良事故数', value: 0, target: 0, unit: '件', status: 'pass', source: '电击/起火等事件 0起', trend: 'stable' },
    ],
    // 📊 经营类 — 稳定运行指标 (参照TQM: CAPA/客诉闭环/成品合格/EQA)
    operations: [
      { name: 'CAPA按期关闭率', value: capas.length > 0 ? Math.round((closedCapas.length - overdueCapas.length) / Math.max(capas.length, 1) * 100) : 100, target: 95, unit: '%', status: capas.length > 0 && (closedCapas.length - overdueCapas.length) / Math.max(capas.length, 1) * 100 >= 95 ? 'pass' : 'warning', source: 'CAPA措施按时完成率 月≥65% 年≥95%' },
      { name: '客户投诉闭环率', value: complaints.length > 0 ? Math.round(closedComplaints.length / complaints.length * 100) : 100, target: 95, unit: '%', status: complaints.length > 0 && closedComplaints.length / complaints.length >= 0.95 ? 'pass' : 'warning', source: '按时闭环投诉/总投诉' },
      { name: '成品一次合格率', value: BOWLING.finalReagentPassRate, target: 99, unit: '%', status: BOWLING.finalReagentPassRate >= 99 ? 'pass' : 'warning', source: '成品检验(试剂)YTD' },
      { name: '仪器维修率(FFR)', value: BOWLING.ffrOverallYTD, target: 8, unit: '%', status: BOWLING.ffrOverallYTD <= 8 ? 'pass' : 'warning', source: 'Overall FFR YTD' },
      { name: 'EQA合格率(室间质评)', value: 100, target: 100, unit: '%', status: 'pass', source: '合格项目/总参评项目' },
    ],
    // 🚀 提升类 — 持续改进指标 (参照TQM: 缺陷率/供应预警/SPC/培训)
    improvements: [
      { name: '试剂市场缺陷率', value: BOWLING.reagentDefectOverallYTD, target: 2.5, unit: '%', status: BOWLING.reagentDefectOverallYTD <= 2.5 ? 'pass' : 'warning', source: '市场缺陷率≤2.5%' },
      { name: '发光条线缺陷率', value: BOWLING.reagentDefectCLIA, target: 2.5, unit: '%', status: BOWLING.reagentDefectCLIA <= 2.5 ? 'pass' : 'fail', source: '⚠️ 超目标 6.0%' },
      { name: '供应商CAPA按时关闭率', value: 85, target: 90, unit: '%', status: 85 >= 90 ? 'pass' : 'warning', source: '3个月无进料全部关闭' },
      { name: '关键风险物料提前预警率', value: 75, target: 90, unit: '%', status: 75 >= 90 ? 'pass' : 'warning', source: '预警数/需预警总数 ABC分级' },
      { name: 'SPC覆盖关键工序率', value: 65, target: 80, unit: '%', status: 65 >= 80 ? 'pass' : 'warning', source: '生产质量一体化专项' },
      { name: '培训认证覆盖率', value: 92, target: 95, unit: '%', status: 92 >= 95 ? 'pass' : 'warning', source: '培训完成数/计划培训总数' },
    ],
  };

  res.json(kpis);
}));

// ============================================================
// BOWLING CHART DATA — 保龄球图完整数据
// 数据来源: 质量管理保龄球图-202605.xlsx
// ============================================================
app.get('/api/dashboard/bowling-chart', requireAuth, asyncHandler(async (req, res) => {
  // 战略解码指标 — 仪器试剂质量 (DOA/FFR/市场缺陷率)
  var strategic = [
    { id: '8', name: '仪器到货缺陷率 Overall DOA', target: 8, unit: '%', ytd: 8.7, trend: 'up',
      months: [
        { month: '1月', plan: 8, actual: 12.5, status: 'fail' },
        { month: '2月', plan: 8, actual: 0, status: 'pass' },
        { month: '3月', plan: 8, actual: 0, status: 'pass' },
        { month: '4月', plan: 8, actual: 7.7, status: 'pass' },
        { month: '5月', plan: 8, actual: 13.3, status: 'fail' },
      ],
      drilldown: [
        { sub: '8.1 新品 DOA', target: 8, ytd: 9.1, months: [14.3, 0, 0, 0, 16.7] },
        { sub: '8.2 量产品 DOA', target: 8, ytd: 7.7, months: [0, 0, 0, 12.5, 0] },
      ]
    },
    { id: '9', name: '仪器维修率 Overall FFR', target: 8, unit: '%', ytd: 8.1, trend: 'down',
      months: [
        { month: '1月', plan: 8, actual: 13.8, status: 'fail' },
        { month: '2月', plan: 8, actual: 7.6, status: 'pass' },
        { month: '3月', plan: 8, actual: 6.4, status: 'pass' },
        { month: '4月', plan: 8, actual: 6.8, status: 'pass' },
        { month: '5月', plan: 8, actual: 6.0, status: 'pass' },
      ],
      drilldown: [
        { sub: '9.1 新品 FFR', target: 8, ytd: 7.8, months: [12.0, 7.8, 6.0, 7.4, 5.8] },
        { sub: '9.2 量产品 FFR', target: 8, ytd: 8.5, months: [16.0, 7.4, 6.8, 6.1, 6.3] },
      ]
    },
    { id: '10', name: '试剂市场缺陷率', target: 2.5, unit: '%', ytd: 2.2, trend: 'stable',
      months: [
        { month: '1月', plan: 2.5, actual: 3.1, status: 'fail' },
        { month: '2月', plan: 2.5, actual: 1.5, status: 'pass' },
        { month: '3月', plan: 2.5, actual: 2.0, status: 'pass' },
        { month: '4月', plan: 2.5, actual: 2.1, status: 'pass' },
        { month: '5月', plan: 2.5, actual: 2.1, status: 'pass' },
      ],
      drilldown: [
        { sub: '10.1 发光条线', target: 2.5, ytd: 6.0, months: [4.7, 5.0, 4.7, 19.0, 2.5], alert: true },
        { sub: '10.2 生化条线', target: 2.5, ytd: 0.9, months: [1.8, 0, 1.0, 0, 2.2] },
        { sub: '10.3 分子条线', target: 2.5, ytd: 3.7, months: [12.5, 12.5, 0, 0, 0], alert: true },
        { sub: '10.4 微生物条线', target: 2.5, ytd: null, months: [12.5, null, null, null, null] },
        { sub: '10.5 POCT条线', target: 2.5, ytd: 0, months: [0, null, null, null, null] },
      ]
    },
  ];

  // 日常检验 KPI
  var daily = [
    { id: 'D1', name: '包材检验合格率', target: 98, unit: '%', ytd: 99.5, months: [100, 98.5, 98.4, 100, 100], status: 'pass' },
    { id: 'D2', name: '原料检验合格率（试剂）', target: 99, unit: '%', ytd: 99.5, months: [99.4, 100, 98.5, 99.8, 100], status: 'pass' },
    { id: 'D3', name: '半成品检验合格率（试剂）', target: 98, unit: '%', ytd: 97.4, months: [97.1, 99.2, 97.4, 94.6, 99.3], status: 'warning' },
    { id: 'D4', name: '成品检验合格率（试剂）', target: 99, unit: '%', ytd: 99.9, months: [100, 100, 99.5, 100, 100], status: 'pass' },
    { id: 'D5', name: '批记录合格率', target: 95, unit: '%', ytd: 96.7, months: [98.3, 97.8, 93.8, 94.5, 100], status: 'pass' },
    { id: 'D6', name: '稳定性检测完成率', target: 100, unit: '%', ytd: 79.2, months: [null, null, null, null, null], status: 'fail', note: 'YTD仅79.2%, 需重点关注' },
  ];

  // 客诉汇总
  var complaintStats = {
    total: 79, period: '2026年1-5月',
    byMonth: { '1月': 21, '2月': 8, '3月': 16, '4月': 13, '5月': 21 },
    byLine: { '发光': 30, '微生物': 26, '生化': 13, '荧光PCR': 9, 'POCT': 1 },
    byCause: { '非质量问题': 16, '设计问题': 12, '物料问题': 9, '其他问题': 9, '生产问题': 4, '工艺问题': 1 },
    topIssues: [
      { product: '结核I-SPOT', product_line: '微生物', count: 6, issue: '抗原漏液/无标签/阳性对照' },
      { product: '真菌药敏试剂盒', product_line: '微生物', count: 5, issue: '花板/跳孔/识别错误' },
      { product: 'HBV核酸检测', product_line: '荧光PCR', count: 5, issue: '内参未起/结果偏高' },
      { product: 'CA系列（CA242/CA15-3/CA19-9）', product_line: '发光', count: 4, issue: '盲样偏差/批号变更' },
      { product: 'PGI/PGII', product_line: '发光', count: 4, issue: '室间质评偏差/磁珠凝块' },
    ]
  };

  res.json({ strategic, daily, complaintStats, updated: '2026-05' });
}));

// ============================================================
// PRODUCTION QUALITY — 生产质量看板 (完整结构化数据)
// 数据来源: 质量管理保龄球图-202605.xlsx
// ============================================================
app.get('/api/dashboard/production-quality', requireAuth, asyncHandler(async (req, res) => {
  // ===== SECTION 1: 战略解码指标 (有月度实绩数据) =====
  var strategicKPIs = {
    title: '战略解码 · 仪器试剂核心质量指标',
    icon: '🎯',
    hasData: true,
    expanded: true,
    metrics: [
      { id: 'DOA', name: '仪器到货缺陷率 Overall DOA', target: '≤8%', ytd: '8.7%', status: 'fail', unit: '%',
        months: { '1月': { plan: 8, actual: 12.5 }, '2月': { plan: 8, actual: 0 }, '3月': { plan: 8, actual: 0 }, '4月': { plan: 8, actual: 7.7 }, '5月': { plan: 8, actual: 13.3 } },
        children: [
          { id: 'DOA-N', name: '新品 DOA', target: '≤8%', ytd: '9.1%', status: 'fail', months: { '1月': 14.3, '2月': 0, '3月': 0, '4月': 0, '5月': 16.7 } },
          { id: 'DOA-M', name: '量产品 DOA', target: '≤8%', ytd: '7.7%', status: 'pass', months: { '1月': 0, '2月': 0, '3月': 0, '4月': 12.5, '5月': 0 } }
        ]
      },
      { id: 'FFR', name: '仪器维修率 Overall FFR', target: '≤8%', ytd: '8.1%', status: 'warning', unit: '%',
        months: { '1月': { plan: 8, actual: 13.8 }, '2月': { plan: 8, actual: 7.6 }, '3月': { plan: 8, actual: 6.4 }, '4月': { plan: 8, actual: 6.8 }, '5月': { plan: 8, actual: 6.0 } },
        children: [
          { id: 'FFR-N', name: '新品 FFR', target: '≤8%', ytd: '7.8%', status: 'pass', months: { '1月': 12.0, '2月': 7.8, '3月': 6.0, '4月': 7.4, '5月': 5.8 } },
          { id: 'FFR-M', name: '量产品 FFR', target: '≤8%', ytd: '8.5%', status: 'fail', months: { '1月': 16.0, '2月': 7.4, '3月': 6.8, '4月': 6.1, '5月': 6.3 } }
        ]
      },
      { id: 'DEFECT', name: '试剂市场缺陷率', target: '≤2.5%', ytd: '2.2%', status: 'pass', unit: '%',
        months: { '1月': { plan: 2.5, actual: 3.1 }, '2月': { plan: 2.5, actual: 1.5 }, '3月': { plan: 2.5, actual: 2.0 }, '4月': { plan: 2.5, actual: 2.1 }, '5月': { plan: 2.5, actual: 2.1 } },
        children: [
          { id: 'DEF-CLIA', name: '发光条线', target: '≤2.5%', ytd: '6.0%', status: 'fail', alert: true, months: { '1月': 4.7, '2月': 5.0, '3月': 4.7, '4月': 19.0, '5月': 2.5 } },
          { id: 'DEF-BIO', name: '生化条线', target: '≤2.5%', ytd: '0.9%', status: 'pass', months: { '1月': 1.8, '2月': 0, '3月': 1.0, '4月': 0, '5月': 2.2 } },
          { id: 'DEF-MOL', name: '分子条线', target: '≤2.5%', ytd: '3.7%', status: 'fail', alert: true, months: { '1月': 12.5, '2月': 12.5, '3月': 0, '4月': 0, '5月': 0 } },
          { id: 'DEF-MICRO', name: '微生物条线', target: '≤2.5%', ytd: '--', status: 'na', months: { '1月': 12.5, '2月': '--', '3月': '--', '4月': '--', '5月': '--' } },
          { id: 'DEF-POCT', name: 'POCT条线', target: '≤2.5%', ytd: '0%', status: 'pass', months: { '1月': 0, '2月': '--', '3月': '--', '4月': '--', '5月': '--' } }
        ]
      }
    ]
  };

  // ===== SECTION 2: 日常检验指标 =====
  var dailyMetrics = {
    title: '日常检验 · 全过程质量控制指标',
    icon: '🔬',
    hasData: true,
    expanded: true,
    metrics: [
      { id: 'D1', name: '包材检验合格率', target: '≥98%', ytd: '99.5%', status: 'pass', months: { '1月': 100, '2月': 98.5, '3月': 98.4, '4月': 100, '5月': 100 },
        detail: { total: 546, fail: 3, bases: '上海/泰州/长沙' } },
      { id: 'D2', name: '原料检验合格率（试剂）', target: '≥99%', ytd: '99.5%', status: 'pass', months: { '1月': 99.4, '2月': 100, '3月': 98.5, '4月': 99.8, '5月': 100 },
        detail: { total: 1586, fail: 8, bases: '上海/泰州/长沙' } },
      { id: 'D3', name: '原料检验合格率（仪器）', target: '≥97%', ytd: '99.0%', status: 'pass', months: { '1月': 97.5, '2月': 97.5, '3月': 99.0, '4月': 99.5, '5月': 100 },
        detail: { total: 1574, fail: 16 } },
      { id: 'D4', name: '半成品检验合格率（试剂）', target: '≥98%', ytd: '97.4%', status: 'warning', months: { '1月': 97.1, '2月': 99.2, '3月': 97.4, '4月': 94.6, '5月': 99.3 },
        detail: { total: 774, fail: 20, bases: '泰州/长沙' } },
      { id: 'D5', name: '成品检验合格率（试剂）', target: '≥99%', ytd: '99.9%', status: 'pass', months: { '1月': 100, '2月': 100, '3月': 99.5, '4月': 100, '5月': 100 },
        detail: { total: 876, fail: 1, bases: '泰州/长沙' } },
      { id: 'D6', name: '成品检验合格率（仪器）', target: '≥85%', ytd: '100%', status: 'pass', months: { '1月': 100, '2月': 100, '3月': 100, '4月': 100, '5月': 100 },
        detail: { total: 70, fail: 0 } },
      { id: 'D7', name: '批记录合格率', target: '≥95%', ytd: '96.7%', status: 'pass', months: { '1月': 98.3, '2月': 97.8, '3月': 93.8, '4月': 94.5, '5月': 100 },
        detail: { total: 874, fail: 29, bases: '泰州/长沙' } },
      { id: 'D8', name: '稳定性检测完成率（试剂）', target: '100%', ytd: '79.2%', status: 'fail', note: '⚠️ 严重滞后, 仅完成342/432批',
        months: { '1月': '--', '2月': '--', '3月': '--', '4月': '--', '5月': '--' },
        detail: { planned: 432, completed: 342, bases: '泰州/长沙' } },
    ]
  };

  // ===== SECTION 3: 仪器分机型指标 =====
  var instrumentMetrics = {
    title: '仪器分机型 · DOA / FFR 专项追踪',
    icon: '🔧',
    hasData: true,
    expanded: false,
    models: ['F-C800P', '药敏', 'F-i3000', 'F-i1000'],
    metrics: [
      { label: 'DOA (到货缺陷率)', target: '≤8%', key: 'DOA',
        data: {
          'F-C800P': { type: '新产品', ytd: '9.1%', status: 'fail', months: { '1月': 0, '2月': 0, '3月': 0, '4月': 0, '5月': 20.0 } },
          '药敏': { type: '新产品', ytd: '9.1%', status: 'fail', months: { '1月': 33.3, '2月': 0, '3月': 0, '4月': 0, '5月': 0 } },
          'F-i3000': { type: '量产产品', ytd: '0%', status: 'pass', months: { '1月': 0, '2月': 0, '3月': 0, '4月': 0, '5月': 0 } },
          'F-i1000': { type: '量产产品', ytd: '50.0%', status: 'fail', months: { '1月': 0, '2月': 0, '3月': 0, '4月': 50.0, '5月': 0 } }
        }
      },
      { label: 'FFR (月度维修率)', target: '≤8%', key: 'FFR',
        data: {
          'F-C800P': { type: '新产品', ytd: '10.5%', status: 'fail', months: { '1月': 15.7, '2月': 11.7, '3月': 8.5, '4月': 9.2, '5月': 7.3 } },
          '药敏': { type: '新产品', ytd: '4.3%', status: 'pass', months: { '1月': 7.3, '2月': 2.8, '3月': 2.8, '4月': 4.9, '5月': 3.8 } },
          'F-i3000': { type: '量产产品', ytd: '9.4%', status: 'fail', months: { '1月': 17.2, '2月': 8.4, '3月': 7.3, '4月': 6.7, '5月': 7.4 } },
          'F-i1000': { type: '量产产品', ytd: '5.4%', status: 'pass', months: { '1月': 11.7, '2月': 3.9, '3月': 5.2, '4月': 3.8, '5月': 2.5 } }
        }
      }
    ],
    // 装机台数汇总 (1-5月)
    installSummary: {
      'F-C800P': { total: 248, new26: 22, description: '生化分析仪' },
      '药敏': { total: 185, new26: 11, description: '药敏分析仪' },
      'F-i3000': { total: 271, new26: 11, description: '发光免疫（主力）' },
      'F-i1000': { total: 79, new26: 2, description: '发光免疫（小型）' }
    }
  };

  // ===== SECTION 4: 体系建设指标 (仅有定义, 无月度数据) =====
  var systemMetrics = {
    title: '体系建设 · 规划中指标（待启动数据采集）',
    icon: '📝',
    hasData: false,
    expanded: false,
    metrics: [
      { name: '成品：缩短平均检验时间20%', target: '缩短20%', unit: '天', category: '效率提升', note: '基线待确认' },
      { name: '原料：降低平均检验工时25%', target: '降低25%', unit: '工时', category: '效率提升', note: '基线待确认' },
      { name: 'GMP平均缺陷数', target: '待定', unit: '个/次', category: '合规', note: '需建立缺陷分类标准' },
      { name: '风险管理覆盖率', target: '100%', unit: '%', category: '体系', note: '按ISO 14971要求' },
      { name: 'PMS覆盖率', target: '100%', unit: '%', category: '上市后', note: '上市后 surveillance 计划' },
      { name: '研发项目平均缺陷数', target: '待定', unit: '个/项目', category: '研发', note: '需建立设计评审标准' },
      { name: '体系文件优化', target: '待定', unit: '份', category: '体系', note: '文件精简/合并计划' },
    ]
  };

  // ===== SECTION 5: 客诉分析 =====
  var complaintSection = {
    title: '客诉分析 · 2026年1-5月 (共79件)',
    icon: '📋',
    hasData: true,
    expanded: false,
    byMonth: { '1月': 21, '2月': 8, '3月': 16, '4月': 13, '5月': 21 },
    byLine: [
      { name: '发光', count: 30, color: '#3B82F6', risk: '缺陷率6.0%超标' },
      { name: '微生物', count: 26, color: '#10B981', risk: 'I-SPOT/真菌药敏为主' },
      { name: '生化', count: 13, color: '#F59E0B', risk: 'CKMB假阳/Lp(a)批间差' },
      { name: '荧光PCR', count: 9, color: '#8B5CF6', risk: 'HBV内参/迭代偏差' },
      { name: 'POCT', count: 1, color: '#EC4899', risk: '低' },
    ],
    topIssues: [
      { product: '结核I-SPOT', line: '微生物', count: 6, detail: '抗原漏液/无标签/阳性对照无斑点' },
      { product: '真菌药敏试剂盒', line: '微生物', count: 5, detail: '花板/跳孔/识别为革兰阴性卡' },
      { product: 'HBV核酸检测', line: '荧光PCR', count: 5, detail: '内参未起/强阳质控偏差/迭代后阳性率偏高' },
      { product: 'CA系列(CA242/CA15-3/CA19-9)', line: '发光', count: 4, detail: '京津冀鲁盲样不合格/批号变更偏差' },
      { product: 'PGI/PGII/ProGRP', line: '发光', count: 4, detail: '室间质评偏差/磁珠凝块/校准品靶值' },
      { product: '底物液', line: '发光', count: 2, detail: '原料批间差导致定标偏差(重复客诉)' },
    ]
  };

  res.json({
    sections: [strategicKPIs, dailyMetrics, instrumentMetrics, systemMetrics, complaintSection],
    updated: '2026-05',
    dataSource: '质量管理保龄球图-202605.xlsx'
  });
}));

// ============================================================
// ============================================================
// QUALITY MODULES — 五维质量看板 (体系/研发/供应链/生产/上市后)
// 参考: TQM（全面质量管理）指标确认.xlsx
// ============================================================
app.get('/api/dashboard/quality-modules', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var suppliers = await db.findAll('suppliers');

  var complaints = events.filter(function(e) { return e.event_type === 'Complaint'; });
  var closedComplaints = complaints.filter(function(e) { return e.status === 'Closed'; });
  var closedCapas = capas.filter(function(c) { return c.status === 'Closed'; });

  // ===== MODULE 1: 体系质量 QMS =====
  var qmsModule = {
    id: 'qms', title: '体系质量', icon: '📋', subtitle: '合规保证 · CAPA · 审计 · 培训 · 验证',
    color: '#10B981',
    summary: [
      { label: '出货产品合格率', value: '99.9%', target: '100%', status: 'pass', desc: '批批检/市场抽检/召回' },
      { label: 'CAPA按期关闭率', value: capas.length ? Math.round(closedCapas.length/capas.length*100)+'%' : '100%', target: '≥95%', status: 'pass', desc: '月≥65% 年≥95%' },
      { label: '客诉闭环率', value: complaints.length ? Math.round(closedComplaints.length/complaints.length*100)+'%' : '100%', target: '≥95%', status: 'pass' },
      { label: '不良事件数', value: '0', target: '0', status: 'pass', desc: '电气安全/严重不良' },
    ],
    sections: [
      { title: '考核指标 (KPI)', type: 'table', headers: ['指标','目标','定义'],
        rows: [
          { name: '出货产品合格率', target: '100%', months: {}, ytd: '99.9%', status:'pass', desc:'合格出货批次/总出货批次(含国抽市抽)' },
          { name: '不良事件按时报告率', target: '100%', months: {}, ytd: '100%', status:'pass', desc:'药监不良事件报告时效' },
          { name: '电气安全不良事件数', target: '0件', months: {}, ytd: '0', status:'pass', desc:'电击/起火等事件数' },
          { name: '客户投诉闭环率', target: '≥95%', months: {}, ytd: complaints.length?Math.round(closedComplaints.length/complaints.length*100)+'%':'100%', status:'pass', desc:'按时闭环投诉/总投诉' },
        ]
      },
      { title: 'CAPA 管理', type: 'summary',
        items: [
          { label:'CAPA总数', value:capas.length, color:'#3B82F6' },
          { label:'已关闭', value:closedCapas.length, color:'#10B981' },
          { label:'处理中', value:capas.filter(function(c){return c.status==='In Progress'}).length, color:'#F59E0B' },
          { label:'逾期', value:capas.filter(function(c){return c.due_date&&new Date(c.due_date)<new Date()&&c.status!=='Closed'}).length, color:'#EF4444' },
          { label:'按期关闭率', value:capas.length?Math.round(closedCapas.length/capas.length*100)+'%':'100%', color:'#059669' },
        ]
      },
      { title: '观察指标 (Monitoring)', type: 'table', headers: ['指标','目标','数据来源'],
        rows: [
          { name:'无重大缺陷率(外部审计)', target:'100%', months:{}, ytd:'--', status:'na', desc:'药监审评 无重大缺陷发现' },
          { name:'注册核查一次通过率', target:'待定', months:{}, ytd:'--', status:'na', desc:'药监/公告机构注册核查' },
          { name:'验证完成率(环境/设备)', target:'月≥70% 年≥95%', months:{}, ytd:'--', status:'na', desc:'验证完成数/验证计划总数' },
          { name:'体系培训完成课时', target:'≥35h/人/年', months:{}, ytd:'--', status:'na', desc:'年人均质量培训课时' },
          { name:'培训认证覆盖率', target:'待定', months:{}, ytd:'--', status:'na', desc:'培训完成数/计划培训总数' },
          { name:'文件合格率(受控率)', target:'≥95%', months:{}, ytd:'96%', status:'pass', desc:'体系文件受控率' },
        ]
      },
      { title: '体系建设规划 (待启动)', type: 'cards',
        items: [
          { name:'风险管理覆盖率', target:'100%', note:'ISO 14971 风险管理覆盖' },
          { name:'PMS覆盖率', target:'100%', note:'上市后监督计划执行' },
          { name:'GMP平均缺陷数', target:'待定', note:'需建立缺陷分类标准' },
          { name:'体系文件优化', target:'待定', note:'文件精简/合并计划' },
        ]
      },
    ]
  };

  // ===== MODULE 2: 研发质量 R&D =====
  var rdModule = {
    id: 'rd', title: '研发质量', icon: '🔬', subtitle: '需求完整 · 验证充分 · 变更受控',
    color: '#6366F1',
    summary: [
      { label:'项目质量达成率', value:'92%', target:'≥90%', status:'pass', desc:'项目质量目标达成' },
      { label:'新品DOA', value:'9.1%', target:'≤8%', status:'fail', desc:'仪器到货缺陷率' },
      { label:'新品FFR', value:'7.8%', target:'≤8%', status:'pass', desc:'仪器维修率' },
      { label:'设计变更', value:events.filter(function(e){return e.event_type==='Change-Control'}).length, target:'--', status:'info', desc:'进行中设计变更' },
    ],
    sections: [
      { title: '考核指标 (KPI)', type: 'table', headers: ['指标','定义','目标','状态'],
        rows: [
          { name:'项目质量指标达成率', target:'≥90%', months:{}, ytd:'92%', status:'pass', desc:'质量目标达成数/计划目标总数' },
          { name:'需求变更控制率', target:'≤3次/项目', months:{}, ytd:'--', status:'na', desc:'需求不明确导致设计变更次数' },
          { name:'试剂-仪器匹配验证率(发光)', target:'100%', months:{}, ytd:'--', status:'na', desc:'通过验证组合/总申报组合' },
          { name:'产品成熟度评分', target:'≥85分', months:{}, ytd:'--', status:'na', desc:'性能+工艺成熟度评分(陈科总维度表)' },
          { name:'关键性能KPI验证覆盖率', target:'待定', months:{}, ytd:'--', status:'na', desc:'已验证KPI/注册要求KPI' },
        ]
      },
      { title: '新产品导入质量 (DOA/FFR)', type: 'table', headers: ['指标','目标','1月','2月','3月','4月','5月','YTD'],
        rows: [
          { name:'DOA到货缺陷率', target:'≤8%', months:{'1月':14.3,'2月':0,'3月':0,'4月':0,'5月':16.7}, ytd:'9.1%', status:'fail', direction:'lt' },
          { name:'FFR月度维修率', target:'≤8%', months:{'1月':12.0,'2月':7.8,'3月':6.0,'4月':7.4,'5月':5.8}, ytd:'7.8%', status:'pass', direction:'lt' },
        ],
        children: [
          { name:'F-C800P FFR', target:'≤8%', months:{'1月':15.7,'2月':11.7,'3月':8.5,'4月':9.2,'5月':7.3}, ytd:'10.5%', status:'fail' },
          { name:'药敏FFR', target:'≤8%', months:{'1月':7.3,'2月':2.8,'3月':2.8,'4月':4.9,'5月':3.8}, ytd:'4.3%', status:'pass' },
        ]
      },
      { title: '观察指标 (Monitoring)', type: 'table', headers: ['指标','目标','定义'],
        rows: [
          { name:'设计输出与输入追溯率', target:'≥95%', months:{}, ytd:'--', status:'na', desc:'可追溯设计输出/输入总需求 防遗漏' },
          { name:'里程碑评审一次通过率', target:'≥85%', months:{}, ytd:'--', status:'na', desc:'各阶段里程碑一次通过率' },
          { name:'风险管理文件更新及时率', target:'100%', months:{}, ytd:'--', status:'na', desc:'新GMP要求 按时更新/应更新次数' },
          { name:'试产样机装配直通率', target:'≥80%', months:{}, ytd:'--', status:'na', desc:'无需返工完成全部工序比例' },
          { name:'注册资料一次通过率', target:'≥90%', months:{}, ytd:'--', status:'na', desc:'无发补或发补≤1次' },
        ]
      },
      { title: '设计相关客诉 Top问题', type: 'list',
        items: [
          { issue:'CKMB假阳性(小批量上市)', product:'CKMB测定试剂盒', line:'生化', status:'open' },
          { issue:'CA系列盲样偏差(京津冀鲁EQA)', product:'CA242/CA15-3/CA19-9', line:'发光', status:'open' },
          { issue:'HBV迭代后阳性率偏高', product:'HBV核酸检测', line:'荧光PCR', status:'open' },
          { issue:'PGI/PGII室间质评偏差', product:'PGI/PGII检测试剂', line:'发光', status:'open' },
        ]
      },
    ]
  };

  // ===== MODULE 3: 供应链质量 SC =====
  var scModule = {
    id: 'supply', title: '供应链质量', icon: '📦', subtitle: '严格准入 · 绩效监控 · 变更管理 · 仓储物流',
    color: '#F59E0B',
    summary: [
      { label:'原料合格率(试剂)', value:'99.5%', target:'≥99%', status:'pass', desc:'1586批/8不良' },
      { label:'原料合格率(仪器)', value:'99.0%', target:'≥98.5%', status:'pass', desc:'1574批/16不良' },
      { label:'包材合格率', value:'99.5%', target:'≥98%', status:'pass', desc:'546批/3不良' },
      { label:'入库及时率', value:'100%', target:'≥99.5%', status:'pass', desc:'仓储入库时效' },
    ],
    sections: [
      { title: '考核指标 (KPI)', type: 'table', headers: ['指标','目标','定义'],
        rows: [
          { name:'原料不合格率(试剂)', target:'≤1%', months:{}, ytd:'0.5%', status:'pass', desc:'不合格批/总检验批 合格率≥99%' },
          { name:'仪器物料不良率(M4后)', target:'≤1.5%', months:{}, ytd:'1.0%', status:'pass', desc:'合格率≥98.5% 区分结构/非结构件' },
          { name:'上线不良率(仪器)', target:'≤380ppm', months:{}, ytd:'--', status:'na', desc:'上线不良数/投入产品数' },
          { name:'供应商CAPA按时关闭率', target:'≥90%', months:{}, ytd:'--', status:'na', desc:'按时关闭CAPA数/总CAPA数' },
          { name:'关键风险物料提前预警率', target:'≥90%', months:{}, ytd:'--', status:'na', desc:'预警数/需预警总数 ABC分级' },
          { name:'采购供货按时交货率', target:'≥95%', months:{}, ytd:'--', status:'na', desc:'按时交货批次/计划供货总批次' },
        ]
      },
      { title: 'IQC来料检验 (2026H1累计)', type: 'table', headers: ['类别','来料批','不合格批','合格率','目标'],
        rows: [
          { name:'仪器-原辅料', target:'≥98.5%', months:{'批数':7874}, ytd:'98.6%', status:'pass', direction:'gte', desc:'111不良' },
          { name:'仪器-包材', target:'≥98.8%', months:{'批数':363}, ytd:'97.8%', status:'warning', direction:'gte', desc:'8不良' },
          { name:'试剂-原辅料(长沙)', target:'≥99.3%', months:{'批数':1616}, ytd:'99.8%', status:'pass', direction:'gte', desc:'4不良' },
          { name:'试剂-包材(长沙)', target:'≥99.3%', months:{'批数':439}, ytd:'99.1%', status:'pass', direction:'gte', desc:'4不良' },
          { name:'原料漏检率(试剂)', target:'≤0.2%', months:{'上线数':341590}, ytd:'0.01%', status:'pass', direction:'lt', desc:'上线不良19件' },
        ]
      },
      { title: '观察指标 (Monitoring)', type: 'table', headers: ['指标','目标','定义'],
        rows: [
          { name:'新供应商审计合格率', target:'≥80%', months:{}, ytd:'--', status:'na', desc:'一次审计通过数/总审计数' },
          { name:'供应商年度审核完成率', target:'≥90%', months:{}, ytd:'--', status:'na', desc:'审核数/年度计划审核数' },
          { name:'供应商优化率', target:'≥5%', months:{}, ytd:'--', status:'na', desc:'(淘汰+导入)/合格供应商总数' },
          { name:'物料变更未通知事件数', target:'0件', months:{}, ytd:'--', status:'na', desc:'供应商未提前通知变更次数' },
          { name:'ODM/OEM入厂不合格率', target:'≤3%', months:{}, ytd:'--', status:'na', desc:'不合格批次/总检验批(仪器/试剂)' },
          { name:'关键原料批间CV(试剂)', target:'≤15%', months:{}, ytd:'--', status:'na', desc:'连续3批关键指标变异系数' },
        ]
      },
      { title: 'IQC材料异常', type: 'summary',
        items: [
          { label:'仪器供应商问题', value:'135件', color:'#F59E0B' },
          { label:'仪器非供应商', value:'101件', color:'#3B82F6' },
          { label:'试剂供应商问题', value:'8件', color:'#10B981' },
          { label:'试剂非供应商', value:'53件', color:'#8B5CF6' },
          { label:'异常关闭率', value:'99.1%', color:'#059669' },
        ]
      },
      { title: '仓储物流KPI (长沙工厂)', type: 'summary',
        items: [
          { label:'入库及时率', value:'100%', color:'#10B981' },
          { label:'出库及时率', value:'100%', color:'#10B981' },
          { label:'领料及时率', value:'98.3%', color:'#D97706' },
          { label:'48小时发货率', value:'--', color:'#3B82F6' },
          { label:'发货准确性', value:'--', color:'#3B82F6' },
        ]
      },
    ]
  };

  // ===== MODULE 4: 生产质量 MFG =====
  var mfgModule = {
    id: 'mfg', title: '生产质量', icon: '🏭', subtitle: '过程稳健 · 批间一致 · 版本准确 · 设备保障',
    color: '#3B82F6',
    summary: [
      { label:'半成品合格率', value:'97.4%', target:'≥98%', status:'warning', desc:'774批/20不良' },
      { label:'成品合格率(试剂)', value:'99.9%', target:'≥99%', status:'pass', desc:'876批/1不良' },
      { label:'批记录合格率', value:'96.7%', target:'≥95%', status:'pass', desc:'874批/29不良' },
      { label:'DOA Overall', value:'8.7%', target:'≤8%', status:'warning', desc:'整体到货缺陷率' },
    ],
    sections: [
      { title: '考核指标 (KPI)', type: 'table', headers: ['指标','目标','定义'],
        rows: [
          { name:'质量原因退货率', target:'≤0.1%', months:{}, ytd:'--', status:'na', desc:'质量原因退货盒数/放行总盒数' },
          { name:'变更引发不合格品率', target:'≤5%', months:{}, ytd:'--', status:'na', desc:'变更后首批不合格品/该批总数' },
          { name:'参考区间验证率', target:'100%', months:{}, ytd:'--', status:'na', desc:'验证符合样本数/总验证样本数(新行标)' },
          { name:'仪器早期故障识别率', target:'100%', months:{}, ytd:'--', status:'na', desc:'可追溯元器件数/总使用数' },
          { name:'产品稳定性监测达标率', target:'100%', months:{}, ytd:'--', status:'na', desc:'实时/加速稳定性符合预设标准' },
        ]
      },
      { title: '过程检验 & 成品 (月度)', type: 'table', headers: ['指标','目标','1月','2月','3月','4月','5月','YTD'],
        rows: [
          { name:'半成品合格率(试剂)', target:'≥98%', months:{'1月':97.1,'2月':99.2,'3月':97.4,'4月':94.6,'5月':99.3}, ytd:'97.4%', status:'warning', direction:'gte' },
          { name:'原料检验合格率(试剂)', target:'≥99%', months:{'1月':99.4,'2月':100,'3月':98.5,'4月':99.8,'5月':100}, ytd:'99.5%', status:'pass', direction:'gte' },
          { name:'成品合格率(试剂)', target:'≥99%', months:{'1月':100,'2月':100,'3月':99.5,'4月':100,'5月':100}, ytd:'99.9%', status:'pass', direction:'gte' },
          { name:'成品合格率(仪器)', target:'≥85%', months:{'1月':100,'2月':100,'3月':100,'4月':100,'5月':100}, ytd:'100%', status:'pass', direction:'gte' },
          { name:'批记录合格率', target:'≥95%', months:{'1月':98.3,'2月':97.8,'3月':93.8,'4月':94.5,'5月':100}, ytd:'96.7%', status:'pass', direction:'gte' },
          { name:'稳定性检测完成率', target:'100%', months:{'1月':'--','2月':'--','3月':'--','4月':'--','5月':'--'}, ytd:'79.2%', status:'fail', note:'⚠342/432批', direction:'gte' },
        ]
      },
      { title: '仪器质量 (分机型DOA/FFR)', type: 'cross', models: ['F-C800P','F-i3000','F-i1000','药敏'],
        metrics: [
          { label:'DOA到货缺陷率', target:'≤8%', data:{'F-C800P':{months:{'1月':0,'2月':0,'3月':0,'4月':0,'5月':20.0},ytd:'9.1%',status:'fail'},'F-i3000':{months:{'1月':0,'2月':0,'3月':0,'4月':0,'5月':0},ytd:'0%',status:'pass'},'F-i1000':{months:{'1月':0,'2月':0,'3月':0,'4月':50.0,'5月':0},ytd:'50%',status:'fail'},'药敏':{months:{'1月':33.3,'2月':0,'3月':0,'4月':0,'5月':0},ytd:'9.1%',status:'fail'}} },
          { label:'FFR月度维修率', target:'≤8%', data:{'F-C800P':{months:{'1月':15.7,'2月':11.7,'3月':8.5,'4月':9.2,'5月':7.3},ytd:'10.5%',status:'fail'},'F-i3000':{months:{'1月':17.2,'2月':8.4,'3月':7.3,'4月':6.7,'5月':7.4},ytd:'9.4%',status:'fail'},'F-i1000':{months:{'1月':11.7,'2月':3.9,'3月':5.2,'4月':3.8,'5月':2.5},ytd:'5.4%',status:'pass'},'药敏':{months:{'1月':7.3,'2月':2.8,'3月':2.8,'4月':4.9,'5月':3.8},ytd:'4.3%',status:'pass'}} },
        ]
      },
      { title: '仪器一次通过率 (周数据)', type: 'table', headers: ['指标','目标','W2W','W3W','W4W','W5W','W6W','W7W'],
        rows: [
          { name:'生化F-C800P', target:'≥97%', months:{'W2W':100,'W3W':100,'W4W':100,'W5W':100,'W6W':'--','W7W':100}, ytd:'100%', status:'pass', direction:'gte' },
          { name:'发光F-i3000', target:'≥97%', months:{'W2W':100,'W3W':'--','W4W':'--','W5W':'--','W6W':'--','W7W':'--'}, ytd:'--', status:'na', direction:'gte' },
        ]
      },
      { title: '试剂一次通过率 (周数据)', type: 'table', headers: ['指标','目标','W2W','W3W','W4W','W5W','W6W','W7W'],
        rows: [
          { name:'半成品-发光', target:'≥97%', months:{'W2W':100,'W3W':100,'W4W':100,'W5W':100,'W6W':100,'W7W':100}, ytd:'100%', status:'pass', direction:'gte' },
          { name:'半成品-微生物', target:'≥97%', months:{'W2W':80,'W3W':75,'W4W':100,'W5W':100,'W6W':100,'W7W':100}, ytd:'92.5%', status:'warning', direction:'gte' },
          { name:'半成品-分子', target:'≥97%', months:{'W2W':100,'W3W':92,'W4W':100,'W5W':100,'W6W':100,'W7W':100}, ytd:'98.7%', status:'pass', direction:'gte' },
          { name:'半成品-生化', target:'≥99%', months:{'W2W':'--','W3W':100,'W4W':100,'W5W':100,'W6W':100,'W7W':100}, ytd:'100%', status:'pass', direction:'gte' },
          { name:'成品-发光', target:'≥99%', months:{'W2W':'--','W3W':100,'W4W':100,'W5W':100,'W6W':100,'W7W':100}, ytd:'100%', status:'pass', direction:'gte' },
          { name:'成品-微生物', target:'≥99%', months:{'W2W':'--','W3W':100,'W4W':100,'W5W':100,'W6W':100,'W7W':100}, ytd:'100%', status:'pass', direction:'gte' },
        ]
      },
      { title: '观察指标 (Monitoring) — 生产/工程/设备', type: 'cards',
        items: [
          { name:'过程检验一次合格率', target:'≥85%', note:'一次通过检验批次/总检验批' },
          { name:'调试工时偏差率', target:'≤120%', note:'实际调试工时/标准工时 识别工艺瓶颈' },
          { name:'老化故障率', target:'≤5%', note:'老化过程故障台数/总老化台数' },
          { name:'软件校验通过率', target:'100%', note:'校验通过数/总灌装数 确保软件完整性' },
          { name:'批放行周期', target:'待定', note:'观察统计(仅统计不考核)' },
          { name:'返工/重加工批次占比', target:'≤3%', note:'返工批次数/总生产批次数' },
          { name:'生产报废率', target:'待定', note:'报废金额/总产出 需确认口径' },
          { name:'校准品批间CV(试剂)', target:'≤注册×60%', note:'连续3-5批关键指标变异系数 核心指标' },
          { name:'校准品批间更换验证率', target:'100%', note:'通过验证更换/总更换 防校准体系偏移' },
          { name:'加速稳定性不合格预警', target:'≤1项/批', note:'接近警戒限项目数 早期识别风险' },
          { name:'SPC覆盖关键工序率', target:'待定', note:'生产质量一体化专项建议' },
          { name:'OOS/偏差调查关闭周期', target:'≤7天', note:'OOS发生至调查关闭平均天数' },
          { name:'关键工艺参数CPP超标率', target:'≤3%', note:'CPP超控制限批次/总生产批次 工艺标准化' },
          { name:'试剂批间CV(固定仪器)', target:'≤注册×60%', note:'连续3批试剂在固定仪器检测CV' },
          { name:'关键元器件批次追溯率', target:'100%', note:'可追溯元器件/总使用 支撑召回' },
          { name:'关键设备故障率', target:'月≤8% 年≤1%', note:'故障次数/设备总数' },
          { name:'维护保养完成率', target:'月≥95% 年100%', note:'完成数/计划完成数' },
          { name:'校准&检定完成率', target:'100%', note:'实际完成/计划总数 工程部设备' },
          { name:'订单48小时发货率', target:'月≥80% 年≥95%', note:'48h实际发货/计划发货' },
          { name:'发货准确性', target:'年≥99.9%', note:'发货差错条数/总发货条数' },
        ]
      },
    ]
  };

  // ===== MODULE 5: 上市后质量 PMS =====
  var pmsModule = {
    id: 'pms', title: '上市后质量', icon: '🌐', subtitle: '早期探测 · 快速响应 · 持续改进 · 客户满意',
    color: '#EC4899',
    summary: [
      { label:'客诉总数(1-5月)', value:'79件', target:'≤50件/半年', status:'warning', desc:'发光30/微生物26/生化13/分子9' },
      { label:'试剂市场缺陷率', value:'2.2%', target:'≤2.5%', status:'pass', desc:'总体达标' },
      { label:'EQA合格率', value:'100%', target:'100%', status:'pass', desc:'室间质评参评项目' },
      { label:'到货缺陷率DOA', value:'8.7%', target:'≤5%(新标)', status:'fail', desc:'TQM新标准 ≤5%' },
    ],
    sections: [
      { title: '考核指标 (KPI)', type: 'table', headers: ['指标','定义','目标','状态'],
        rows: [
          { name:'客户满意度', target:'≥4.0(5分制)', months:{}, ytd:'--', status:'na', desc:'季度/年度调研代表性客户' },
          { name:'室间质评EQA合格率', target:'100%', months:{}, ytd:'100%', status:'pass', desc:'合格项目数/总参评项目数' },
          { name:'到货缺陷率(仪器)', target:'≤5%(新标)', months:{}, ytd:'8.7%', status:'fail', desc:'故障台数/销售台数' },
          { name:'客户投诉率(试剂)', target:'≤5/万盒', months:{}, ytd:'--', status:'na', desc:'投诉次数/销售盒数×10000' },
          { name:'上市后12月投诉率(新品)', target:'待定', months:{}, ytd:'--', status:'na', desc:'设计/质量投诉÷总发货批次/台数' },
          { name:'上市后设计相关CAPA闭环率', target:'100%', months:{}, ytd:'--', status:'na', desc:'设计问题CAPA按时关闭比例' },
          { name:'客诉例数(试剂)', target:'参照历史水平', months:{}, ytd:'79件', status:'warning', desc:'累计1-5月' },
        ]
      },
      { title: '试剂市场缺陷率 (月度)', type: 'table', headers: ['指标','目标','1月','2月','3月','4月','5月','YTD'],
        rows: [
          { name:'Overall缺陷率', target:'≤2.5%', months:{'1月':3.1,'2月':1.5,'3月':2.0,'4月':2.1,'5月':2.1}, ytd:'2.2%', status:'pass', direction:'lt' },
          { name:'发光条线', target:'≤2.5%', months:{'1月':4.7,'2月':5.0,'3月':4.7,'4月':19.0,'5月':2.5}, ytd:'6.0%', status:'fail', direction:'lt' },
          { name:'生化条线', target:'≤2.5%', months:{'1月':1.8,'2月':0,'3月':1.0,'4月':0,'5月':2.2}, ytd:'0.9%', status:'pass', direction:'lt' },
          { name:'分子条线', target:'≤2.5%', months:{'1月':12.5,'2月':12.5,'3月':0,'4月':0,'5月':0}, ytd:'3.7%', status:'fail', direction:'lt' },
        ]
      },
      { title: '客诉月度趋势', type: 'table', headers: ['指标','1月','2月','3月','4月','5月','合计'],
        rows: [
          { name:'客诉总数', target:'--', months:{'1月':21,'2月':8,'3月':16,'4月':13,'5月':21}, ytd:'79件', status:'warning' },
          { name:'发光', target:'--', months:{}, ytd:'30件', status:'fail', desc:'缺陷率6.0% 偏高' },
          { name:'微生物', target:'--', months:{}, ytd:'26件', status:'warning' },
          { name:'生化', target:'--', months:{}, ytd:'13件', status:'pass' },
          { name:'荧光PCR', target:'--', months:{}, ytd:'9件', status:'pass' },
          { name:'POCT', target:'--', months:{}, ytd:'1件', status:'pass' },
        ]
      },
      { title: '观察指标 (Monitoring) — 客服/可靠性', type: 'cards',
        items: [
          { name:'平均故障间隔MTBF(仪器)', target:'≥设计目标×80%', note:'运行总时间/故障次数 季度评估' },
          { name:'首次修复率', target:'≥85%', note:'一次修复台数/总服务台数 月度' },
          { name:'平均修复时间MTTR', target:'≤4小时', note:'总修复时间/修复次数 提升满意度' },
          { name:'重大缺陷停机率', target:'待定', note:'月度监测' },
          { name:'客户端仪器存活率', target:'待定', note:'仪器数据日志分析' },
          { name:'备件满足率', target:'待定', note:'备件供应及时性' },
          { name:'重复投诉率', target:'待定', note:'重复投诉数/总投诉数' },
          { name:'零星客户投诉率', target:'参照历史', note:'零星投诉/总投诉' },
          { name:'批量客户投诉占比', target:'待定', note:'批量投诉/总投诉' },
          { name:'与对比方法相关性偏差率', target:'待定', note:'方法来料偏差监测' },
        ]
      },
      { title: '客诉 Top 问题', type: 'list',
        items: [
          { issue:'结核I-SPOT 抗原漏液/无标签', product:'I-SPOT', line:'微生物', status:'open' },
          { issue:'真菌药敏 花板/跳孔/识别错误', product:'真菌药敏试剂盒', line:'微生物', status:'open' },
          { issue:'HBV 内参未起/迭代后阳性率偏高', product:'HBV核酸检测', line:'荧光PCR', status:'open' },
          { issue:'CA系列盲样不合格(京津冀鲁EQA)', product:'CA242/CA15-3/CA19-9', line:'发光', status:'open' },
          { issue:'底物液原料批间差(重复客诉)', product:'全自动底物液', line:'发光', status:'open' },
        ]
      },
    ]
  };

  res.json({
    modules: [qmsModule, rdModule, scModule, mfgModule, pmsModule],
    updated: '2026-07',
    dataSources: ['TQM指标确认.xlsx', '质量管理保龄球图-202605.xlsx', '工厂经营会议周报7.26.xls'],
  });
}));

// ============================================================
// COMPLAINT DASHBOARD — 投诉看板
// 数据来源: 2026年上半年投诉情况汇总20260728.xlsx (已导入quality_events)
// ============================================================
app.get('/api/dashboard/complaints', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var complaints = events.filter(function(e) { return e.event_type === 'Complaint'; });

  // === KPI ===
  var total = complaints.length;
  var open = complaints.filter(function(c) { return c.status !== 'Closed'; }).length;
  var closed = complaints.filter(function(c) { return c.status === 'Closed'; }).length;
  var highRisk = complaints.filter(function(c) { return c.risk_level === 'High' || c.risk_level === 'Critical'; }).length;
  var repeat = complaints.filter(function(c) { return c.complaint_repeat === true; }).length;

  // === 月度趋势 ===
  var byMonth = {};
  complaints.forEach(function(c) {
    var m = c.complaint_month;
    if (m) byMonth[m] = (byMonth[m] || 0) + 1;
  });

  // === 产品线分布 ===
  var bySource = {};
  complaints.forEach(function(c) {
    var src = c.complaint_source || '未分类';
    bySource[src] = (bySource[src] || 0) + 1;
  });

  // === 原因分类 (从描述提取) ===
  var byCause = {};
  complaints.forEach(function(c) {
    var cause = c.complaint_cause || '未分类';
    if (cause.includes('设计')) cause = '设计问题';
    else if (cause.includes('物料')) cause = '物料问题';
    else if (cause.includes('工艺')) cause = '工艺问题';
    else if (cause.includes('生产')) cause = '生产问题';
    else if (cause.includes('非质量')) cause = '非质量问题';
    else if (cause.includes('其他')) cause = '其他问题';
    byCause[cause] = (byCause[cause] || 0) + 1;
  });

  // === 产品维度 Top ===
  var byProduct = {};
  complaints.forEach(function(c) {
    var p = c.product_name || '未知';
    byProduct[p] = (byProduct[p] || 0) + 1;
  });
  var topProducts = Object.keys(byProduct).map(function(p) { return { name: p, count: byProduct[p] }; })
    .sort(function(a, b) { return b.count - a.count; }).slice(0, 10);

  // === 故障细分 (仪器) ===
  var byCategory = {};
  complaints.forEach(function(c) {
    var desc = c.description || '';
    var match = desc.match(/【([^】]+)】/);
    var cat = match ? match[1] : '其他';
    if (cat.includes('·')) cat = cat.split('·')[1] || cat;
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  });
  var topCategories = Object.keys(byCategory).map(function(k) { return { name: k, count: byCategory[k] }; })
    .sort(function(a, b) { return b.count - a.count; }).slice(0, 12);

  // ======================================================
  // === 新增4个分析图表数据集 ===
  // ======================================================

  // === 试剂投诉 (来源含"试剂") ===
  var reagentComplaints = complaints.filter(function(c) { return (c.complaint_source || '').includes('试剂'); });

  // 1. 试剂问题分类 Top10 (环状图)
  var reagentCauseTop10 = {};
  reagentComplaints.forEach(function(c) {
    var cause = c.complaint_cause || '未分类';
    if (cause.includes('设计问题（小批量') || cause.includes('设计')) cause = '设计问题';
    else if (cause.includes('物料')) cause = '物料问题';
    else if (cause.includes('工艺')) cause = '工艺问题';
    else if (cause.includes('生产')) cause = '生产问题';
    else if (cause.includes('非质量')) cause = '非质量问题';
    else if (cause.includes('其他')) cause = '其他问题';
    reagentCauseTop10[cause] = (reagentCauseTop10[cause] || 0) + 1;
  });
  var reagentCauseList = Object.keys(reagentCauseTop10).map(function(k) { return { name: k, count: reagentCauseTop10[k] }; })
    .sort(function(a, b) { return b.count - a.count; }).slice(0, 10);

  // 2. 仪器问题类型帕累托 (bug清单)
  var instrumentComplaints = complaints.filter(function(c) { return !(c.complaint_source || '').includes('试剂'); });
  // 排除的条线/来源关键词
  var BUG_EXCLUDE = ['发光', '生化', '荧光PCR', 'POCT', '药敏', '微生物'];
  var instrumentBugType = {};
  instrumentComplaints.forEach(function(c) {
    var desc = c.description || '';
    var m = desc.match(/【([^】]+)】/);
    var inner = m ? m[1] : '';
    var bug = '';
    if (inner.includes('·')) {
      var parts = inner.split('·');
      bug = parts[parts.length - 1] || '';
    } else {
      bug = inner;
    }
    bug = bug.replace(/^FFR[:：]?\s*/i, '').trim();
    var isLine = BUG_EXCLUDE.some(function(l) { return bug === l || (bug.length > 2 && bug.indexOf(l) === 0); });
    if (!bug || isLine) bug = '其他';
    if (bug.length > 14) bug = bug.substring(0, 14);
    instrumentBugType[bug] = (instrumentBugType[bug] || 0) + 1;
  });
  var instrumentPareto = Object.keys(instrumentBugType).map(function(k) { return { name: k, count: instrumentBugType[k] }; })
    .sort(function(a, b) { return b.count - a.count; }).slice(0, 10);
  // 计算累积百分比
  var paretoTotal = instrumentPareto.reduce(function(s, x) { return s + x.count; }, 0);
  var cum = 0;
  instrumentPareto.forEach(function(x) { cum += x.count; x.cumPct = paretoTotal ? Math.round(cum / paretoTotal * 100) : 0; });

  // 3. 各试剂条线设计缺陷占比 (生化/化学发光/分子/POCT/药敏)
  var LINES = [
    { key: '生化', name: '生化' },
    { key: '发光', name: '化学发光' },
    { key: '荧光PCR', name: '分子' },
    { key: 'POCT', name: 'POCT' },
    { key: '药敏', name: '药敏' },
  ];
  var reagentLineDesign = LINES.map(function(line) {
    var items = reagentComplaints.filter(function(c) {
      return (c.description || '').includes('【' + line.key);
    });
    var design = items.filter(function(c) {
      var cause = c.complaint_cause || (c.description || '');
      return cause.includes('设计');
    });
    return {
      name: line.name, key: line.key,
      total: items.length, design: design.length,
      pct: items.length ? Math.round(design.length / items.length * 100) : 0,
    };
  });

  // 4. 反馈试剂 Top10
  var reagentByProduct = {};
  reagentComplaints.forEach(function(c) {
    var p = c.product_name || '未知';
    reagentByProduct[p] = (reagentByProduct[p] || 0) + 1;
  });
  var reagentTop10 = Object.keys(reagentByProduct).map(function(p) { return { name: p, count: reagentByProduct[p] }; })
    .sort(function(a, b) { return b.count - a.count; }).slice(0, 10);

  // === 明细 (分页) ===
  var page = parseInt(req.query.page) || 1;
  var limit = parseInt(req.query.limit) || 20;
  var sourceFilter = req.query.source || '';
  var causeFilter = req.query.cause || '';
  var search = req.query.search || '';

  var filtered = complaints.filter(function(c) {
    if (sourceFilter && !(c.complaint_source || '').includes(sourceFilter)) return false;
    if (causeFilter && !(c.complaint_cause || '').includes(causeFilter)) return false;
    if (search && !((c.description || '') + (c.product_name || '')).includes(search)) return false;
    return true;
  });
  filtered.sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  var start = (page - 1) * limit;
  var paged = filtered.slice(start, start + limit);

  res.json({
    kpi: { total: total, open: open, closed: closed, closeRate: total ? Math.round(closed / total * 100) : 0, highRisk: highRisk, repeat: repeat },
    byMonth: byMonth,
    bySource: bySource,
    byCause: byCause,
    topProducts: topProducts,
    topCategories: topCategories,
    reagentCauseTop10: reagentCauseList,
    instrumentPareto: instrumentPareto,
    reagentLineDesign: reagentLineDesign,
    reagentTop10: reagentTop10,
    repeats: complaints.filter(function(c) { return c.complaint_repeat === true; }).sort(function(a,b){return new Date(b.created_at)-new Date(a.created_at);}).map(function(c) { return { id: c.id, product_name: c.product_name, batch: c.batch_no, description: (c.description||'').substring(0,80), cause: c.complaint_cause, status: c.status, date: c.created_at, source: (c.complaint_source||'').replace('2026上半年投诉汇总-','') }; }),
    list: { data: paged, total: filtered.length, page: page, limit: limit },
  });
}));


// ============================================================
// DATA IMPORT / EXPORT — 数据导入导出
// ============================================================
// ---- Export: 导出驾驶舱数据为 Excel ----
app.get('/api/dashboard/export', requireAuth, asyncHandler(async (req, res) => {
  try {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var changes = await db.findAll('change_records');
  var products = await db.findAll('products');
  var suppliers = await db.findAll('suppliers');
  var qcps = await db.findAll('qcp_library');
  var risks = await db.findAll('risk_library');

  // Helper: normalize to rows
  function toRows(arr, mapFn) { return arr.map(mapFn); }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function list(v) {
    if (Array.isArray(v)) return v.join('; ');
    if (typeof v === 'object' && v !== null) return JSON.stringify(v);
    return str(v);
  }

  var wb = XLSX.utils.book_new();

  // Sheet 1: 质量事件
  var eventRows = toRows(events, function(e) {
    return {
      '事件ID': str(e.id), '类型': str(e.event_type), '风险等级': str(e.risk_level),
      '产品': str(e.product_name), '批号': str(e.batch_no),
      '描述': str(e.description).substring(0, 200),
      '状态': str(e.status), '创建时间': str(e.created_at), '更新时间': str(e.updated_at)
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventRows), '质量事件');

  // Sheet 2: CAPA
  var capaRows = toRows(capas, function(c) {
    return {
      'CAPA ID': str(c.id), '标题': str(c.title), '关联事件': str(c.event_id),
      '根因': str(c.root_cause), '行动计划': str(c.action_plan).substring(0, 200),
      '负责人': str(c.assignee), '截止日期': str(c.due_date),
      '状态': c.status, '有效性': c.effectiveness || '',
      '创建时间': c.created_at
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(capaRows), 'CAPA');

  // Sheet 3: 变更记录
  var changeRows = toRows(changes, function(c) {
    return { '变更ID': c.id, '标题': c.title, '产品': c.product_name || '', '类型': c.change_type || '', '状态': c.status || '', '创建时间': c.created_at || '' };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(changeRows), '变更记录');

  // Sheet 4: 产品档案
  var productRows = toRows(products, function(p) {
    return {
      '产品ID': str(p.id), '产品名称': str(p.product_name), '产品代码': str(p.product_code),
      '批号': str(p.batch_no), 'BQI': str(p.bqi), '状态': str(p.lifecycle_status || p.status),
      'CQA': list(p.cqa_list), 'CMA': list(p.cma_list), 'CPP': list(p.cpp_list)
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(productRows), '产品档案');

  // Sheet 5: 供应商
  var supplierRows = toRows(suppliers, function(s) {
    return {
      '供应商ID': str(s.id), '名称': str(s.supplier_name || s.name), '代码': str(s.supplier_code),
      '风险等级': str(s.risk_level), '质量评分': str(s.quality_score),
      '认证': str(s.certification), '状态': str(s.status)
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(supplierRows), '供应商');

  // Sheet 6: 控制点库
  var qcpRows = toRows(qcps, function(q) {
    return { 'QCP编号': str(q.qcp_code || q.id), '模块': str(q.module), '控制点': str(q.control_point || q.name), 'CQA': str(q.cqa), 'CMA': str(q.cma), 'CPP': str(q.cpp), '方法': str(q.control_method), '负责人': str(q.owner) };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(qcpRows), '控制点库');

  // Sheet 7: 风险库
  var riskRows = toRows(risks, function(r) {
    return { '风险ID': str(r.id), '名称': str(r.risk_name || r.name), '等级': str(r.risk_level), 'RPN': str(r.rpn), '措施': str(r.mitigation || r.action) };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(riskRows), '风险库');

  var buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  var dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="FDQH_export_' + dateStr + '.xlsx"');
  res.send(buf);
  } catch (e) {
    console.error('Export error:', e.message, e.stack);
    res.status(500).json({ error: '导出失败: ' + e.message });
  }
}));

// ---- Import: 上传 Excel/JSON 导入数据 ----
var upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 导入模板下载
app.get('/api/dashboard/import/template', requireAuth, asyncHandler(async (req, res) => {
  var template = [
    { '事件ID': 'QE001', '类型': 'Deviation', '风险等级': 'Medium', '产品名称': 'CA19-9检测试剂盒', '批号': 'B2606001', '描述': '填写事件描述', '状态': 'Open' },
    { '事件ID': 'QE002', '类型': 'Complaint', '风险等级': 'High', '产品名称': '糖类抗原19-9', '批号': 'C2509037', '描述': '客户投诉示例', '状态': 'In Investigation' },
  ];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(template), '质量事件模板');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { '标题': 'CAPA示例', '关联事件ID': 'QE001', '根因': '填写根本原因', '行动计划': '填写纠正预防措施', '负责人': '张三', '截止日期': '2026-08-31', '状态': 'Open' }
  ]), 'CAPA模板');
  var buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="FDQH_import_template.xlsx"');
  res.send(buf);
}));

// 导入数据 (Excel/JSON)
app.post('/api/dashboard/import', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });

  var file = req.file;
  var filename = (file.originalname || '').toLowerCase();
  var result = { imported: { events: 0, capa: 0, products: 0 }, errors: [], details: [] };

  try {
    // Parse based on file type
    var sheets = {};
    if (filename.endsWith('.json')) {
      var json = JSON.parse(file.buffer.toString('utf-8'));
      if (Array.isArray(json)) sheets['质量事件'] = json;
      else for (var key in json) if (Array.isArray(json[key])) sheets[key] = json[key];
    } else {
      var wb = XLSX.read(file.buffer, { type: 'buffer' });
      wb.SheetNames.forEach(function(sn) {
        sheets[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
      });
    }

    // Import quality events
    var eventData = sheets['质量事件'] || sheets['质量事件模板'] || [];
    if (eventData.length) {
      for (var i = 0; i < eventData.length; i++) {
        var row = eventData[i];
        if (!row['类型'] && !row['event_type']) continue;
        try {
          var eventType = row['类型'] || row.event_type;
          if (!VALID_EVENT_TYPES.includes(eventType)) { result.errors.push('行' + (i+1) + ': 无效事件类型 ' + eventType); continue; }
          var payload = {
            event_type: eventType,
            risk_level: row['风险等级'] || row.risk_level || 'Medium',
            product_id: row['产品ID'] || row.product_id || '',
            product_name: row['产品名称'] || row.product_name || '',
            batch_no: row['批号'] || row.batch_no || '',
            description: row['描述'] || row.description || '',
            status: row['状态'] || row.status || 'Open',
            created_at: row['创建时间'] || row.created_at || new Date().toISOString(),
            imported: true
          };
          if (!VALID_RISK_LEVELS.includes(payload.risk_level)) { result.errors.push('行' + (i+1) + ': 无效风险等级 ' + payload.risk_level); continue; }
          var saved = await db.insert('quality_events', payload, req.user.username);
          result.imported.events++;
          result.details.push('导入事件: ' + (saved.id || '') + ' ' + eventType);
        } catch (e) {
          result.errors.push('行' + (i+1) + ': ' + e.message);
        }
      }
    }

    // Import CAPA
    var capaData = sheets['CAPA'] || sheets['CAPA模板'] || [];
    if (capaData.length) {
      for (var j = 0; j < capaData.length; j++) {
        var crow = capaData[j];
        if (!crow['标题'] && !crow.title) continue;
        try {
          var capaPayload = {
            title: crow['标题'] || crow.title,
            event_id: crow['关联事件ID'] || crow.event_id || '',
            root_cause: crow['根因'] || crow.root_cause || '',
            action_plan: crow['行动计划'] || crow.action_plan || '',
            assignee: crow['负责人'] || crow.assignee || '',
            due_date: crow['截止日期'] || crow.due_date || '',
            status: crow['状态'] || crow.status || 'Open',
            imported: true
          };
          await db.insert('capa_records', capaPayload, req.user.username);
          result.imported.capa++;
          result.details.push('导入CAPA: ' + capaPayload.title.substring(0, 40));
        } catch (e) {
          result.errors.push('CAPA行' + (j+1) + ': ' + e.message);
        }
      }
    }

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: '解析文件失败: ' + e.message });
  }
}));

// ============================================================
// WORKSHOP DASHBOARD — 生产质量一体化Workshop看板
// 数据来源: 生产质量一体化Workshop-汇报版本输出.xlsx (Sheet 2+3)
// ============================================================
app.get('/api/dashboard/workshop', requireAuth, asyncHandler(async (req, res) => {
  // ===== Sheet 3: 汇报分析 =====
  // 过程分组帕累托
  var processPareto = [
    { name: '来料过程', count: 150, pct: 53 },
    { name: '中间品制备检验', count: 68, pct: 24 },
    { name: '成品检验放行', count: 65, pct: 23 }
  ];

  // 质量原因帕累托
  var causePareto = [
    { name: '研发质量', count: 131, pct: 50 },
    { name: '供应链质量', count: 84, pct: 32 },
    { name: '生产质量', count: 33, pct: 13 },
    { name: '体系质量', count: 12, pct: 5 },
    { name: '其他', count: 2, pct: 1 }
  ];

  // 产品线分布
  var productDist = [
    { name: '微生物', count: 60 },
    { name: '发光试剂', count: 40 },
    { name: '生化试剂', count: 25 },
    { name: '仪器', count: 20 },
    { name: '分子试剂', count: 7 }
  ];

  // 发生频次分布
  var freqDist = [
    { name: '持续存在', count: 143 },
    { name: '单次', count: 73 },
    { name: '偶发', count: 27 },
    { name: '月度多次', count: 16 }
  ];

  // 根本原因 × 质量原因 交叉表
  var rootCauseCross = [
    { cause: '研发质量', noProcess: 29, invalidProcess: 47, execFail: 55, total: 131 },
    { cause: '供应链质量', noProcess: 2, invalidProcess: 27, execFail: 55, total: 84 },
    { cause: '生产质量', noProcess: 0, invalidProcess: 22, execFail: 11, total: 33 },
    { cause: '体系质量', noProcess: 0, invalidProcess: 11, execFail: 1, total: 12 }
  ];

  // 影响分布
  var impactDist = [
    { name: '质量风险', count: 180 },
    { name: '交期延误', count: 45 },
    { name: '成本损失', count: 20 },
    { name: '其他', count: 17 }
  ];

  // ===== Sheet 2: 解决方案四象限 =====
  var solutions = [
    { module: '供应链质量', cause: '供应商质量管控', solution: '供应商整合：集中采购，优化付款周期', difficulty: '难', impact: '高', owner: '刘建芳', deadline: '2026.12.31', quad: 'strategic' },
    { module: '供应链质量', cause: '物料变更频繁', solution: '物料选型优化：建立规划，供应链参与设计选型', difficulty: '难', impact: '高', owner: '姚仁杰', deadline: '待定', quad: 'strategic' },
    { module: '供应链质量', cause: '物料风险', solution: '关键物料风险预警：安全库存', difficulty: '易', impact: '高', owner: '沈倩', deadline: '待定', quad: 'quick-win' },
    { module: '供应链质量', cause: '供应商变更流程', solution: '供应商变更流程优化（进行中）', difficulty: '易', impact: '高', owner: '刘建芳', deadline: '2026.10.30', quad: 'quick-win' },
    { module: '供应链质量', cause: '来料质量标准', solution: '关键物料质检标准更新', difficulty: '难', impact: '高', owner: '刘建芳', deadline: '2026.09.30', quad: 'strategic' },
    { module: '供应链质量', cause: '药敏盘问题', solution: '药敏盘：寻找替代供应商', difficulty: '难', impact: '高', owner: '陈科', deadline: '待定', quad: 'strategic' },
    { module: '供应链质量', cause: '来料检验资源', solution: '关键检验资源配置：能力及工具', difficulty: '易', impact: '高', owner: '姚仁杰', deadline: '待定', quad: 'quick-win' },
    { module: '研发质量', cause: '图纸错误', solution: '图纸：修正错误，补齐缺失图纸(2D/3D)', difficulty: '难', impact: '高', owner: '陈科', deadline: '2026.10.01', quad: 'strategic' },
    { module: '研发质量', cause: '处方工艺', solution: '关键工艺参数定义及验证', difficulty: '难', impact: '中', owner: '待定', deadline: '待定', quad: 'strategic' },
    { module: '研发质量', cause: '质量标准', solution: '质量标准更新：内控标准更新', difficulty: '难', impact: '高', owner: '刘建芳', deadline: '2026.09.30', quad: 'strategic' },
    { module: '研发质量', cause: '技术要求', solution: 'F-C2000: 注册变更确认符合性', difficulty: '易', impact: '高', owner: '刘建芳', deadline: '2026.07.31', quad: 'quick-win' },
    { module: '研发质量', cause: '转产验证', solution: '转产：加强评估+规范设计转换节点', difficulty: '难', impact: '高', owner: '刘建芳', deadline: '2026.10.30', quad: 'strategic' },
    { module: '研发质量', cause: '仪器试剂适配', solution: '工作校准品赋值标准化', difficulty: '难', impact: '高', owner: '刘建芳', deadline: '2026.12.31', quad: 'strategic' },
    { module: '生产质量', cause: '人员不稳定', solution: '交叉培训，一人多岗，上岗培训（持续）', difficulty: '易', impact: '中', owner: '', deadline: '', quad: 'fill' },
    { module: '生产质量', cause: '台间差/设备', solution: '标准机建立', difficulty: '难', impact: '高', owner: '待定', deadline: '待定', quad: 'strategic' },
    { module: '生产质量', cause: '物料齐套', solution: '相似物料定量管理（如螺丝螺母）', difficulty: '易', impact: '高', owner: '孙卫兵', deadline: '2026.12.31', quad: 'quick-win' },
    { module: '生产质量', cause: '标记/包被工艺', solution: '标记/包被工艺标准化', difficulty: '难', impact: '高', owner: '陈科', deadline: '待定', quad: 'strategic' },
    { module: '生产质量', cause: '赋值标准', solution: '工艺标准化，厂内外标准对标', difficulty: '难', impact: '高', owner: '孙卫兵', deadline: '2026.12.31', quad: 'strategic' },
    { module: '生产质量', cause: '过程监控', solution: 'SPC加强过程监控', difficulty: '难', impact: '中', owner: '待定', deadline: '待定', quad: 'strategic' }
  ];

  res.json({
    processPareto, causePareto, productDist, freqDist, rootCauseCross, impactDist, solutions,
    total: 262, sheet3Source: '汇报分析', sheet2Source: '解决方案汇总',
    updated: '2026-07'
  });
}));


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
	    console.log('\n  ╔══════════════════════════════════════════════╗\n  ║   FosunDx Quality Hub (FDQH) Platform       ║\n  ║   IVD 数字化质量管理平台 v1.6                 ║\n  ║   http://localhost:' + PORT + '                      ║\n  ╚══════════════════════════════════════════════╝\n  ');
    console.log('  默认账号: admin / admin123');
  });
}).catch(function(err) {
  console.error('Database init error:', err.message);
  app.listen(PORT, function() { console.log('Server started on ' + PORT + ' (no database)'); });
});
