// ============================================================
// FDQH - FosunDx Quality Hub Server v1.6
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
    // 🔴 红线类 — 一票否决指标
    redlines: [
      { name: '出货产品合格率', value: BOWLING.finalReagentPassRate, target: 99, unit: '%', status: BOWLING.finalReagentPassRate >= 99 ? 'pass' : 'fail', source: '成品检验（试剂）YTD' },
      { name: '不良事件发生率', value: 0, target: 0, unit: '件', status: 'pass', source: '严重不良事件数' },
      { name: '稳定性检测完成率', value: BOWLING.stabilityCompleteRate, target: 100, unit: '%', status: BOWLING.stabilityCompleteRate >= 100 ? 'pass' : 'fail', source: '试剂稳定性YTD' },
      { name: '仪器到货缺陷率(DOA)', value: BOWLING.doaOverallYTD, target: 8, unit: '%', status: BOWLING.doaOverallYTD <= 8 ? 'pass' : 'fail', source: 'Overall DOA YTD' },
    ],
    // 📊 经营类 — 稳定运行指标
    operations: [
      { name: '包材检验合格率', value: BOWLING.pkgPassRate, target: 98, unit: '%', status: BOWLING.pkgPassRate >= 98 ? 'pass' : 'warning', source: 'YTD' },
      { name: '原料检验合格率（试剂）', value: BOWLING.rawReagentPassRate, target: 99, unit: '%', status: 'pass', source: 'YTD' },
      { name: '半成品检验合格率（试剂）', value: BOWLING.semiReagentPassRate, target: 98, unit: '%', status: BOWLING.semiReagentPassRate >= 98 ? 'pass' : 'warning', source: 'YTD' },
      { name: '批记录合格率', value: BOWLING.batchRecordPassRate, target: 95, unit: '%', status: 'pass', source: 'YTD' },
      { name: '仪器维修率(FFR) Overall', value: BOWLING.ffrOverallYTD, target: 8, unit: '%', status: BOWLING.ffrOverallYTD <= 8 ? 'pass' : 'warning', source: 'YTD' },
      { name: '客户投诉闭环率', value: complaints.length > 0 ? Math.round(closedComplaints.length / complaints.length * 100) : 100, target: 95, unit: '%', status: complaints.length > 0 && closedComplaints.length / complaints.length >= 0.95 ? 'pass' : 'warning' },
    ],
    // 🚀 提升类 — 持续改进
    improvements: [
      { name: '试剂市场缺陷率(Overall)', value: BOWLING.reagentDefectOverallYTD, target: 2.5, unit: '%', status: BOWLING.reagentDefectOverallYTD <= 2.5 ? 'pass' : 'warning', source: 'YTD 目标2.5%' },
      { name: '发光条线缺陷率', value: BOWLING.reagentDefectCLIA, target: 2.5, unit: '%', status: BOWLING.reagentDefectCLIA <= 2.5 ? 'pass' : 'fail', source: '⚠️ 超目标' },
      { name: '分子条线缺陷率', value: BOWLING.reagentDefectMol, target: 2.5, unit: '%', status: BOWLING.reagentDefectMol <= 2.5 ? 'pass' : 'fail', source: '⚠️ 超目标' },
      { name: 'CAPA按期关闭率', value: capas.length > 0 ? Math.round((closedCapas.length - overdueCapas.length) / Math.max(capas.length, 1) * 100) : 100, target: 90, unit: '%', status: 'stable' },
      { name: '客户投诉总数(1-5月)', value: BOWLING.complaintCountYTD, target: 50, unit: '件', status: BOWLING.complaintCountYTD <= 50 ? 'pass' : 'warning', source: '累计79件' },
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
// QUALITY MODULES — 四维质量看板 (研发/供应链/生产/体系)
// ============================================================
app.get('/api/dashboard/quality-modules', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var suppliers = await db.findAll('suppliers');
  var products = await db.findAll('products');

  var months = ['1月','2月','3月','4月','5月'];

  // ===== MODULE 1: 研发质量 R&D =====
  var rdModule = {
    id: 'rd', title: '研发质量', icon: '🔬', subtitle: '设计保证 · 新产品导入 · 设计变更',
    color: '#6366F1',
    summary: [
      { label: '新品DOA', value: '9.1%', target: '≤8%', status: 'fail', desc: '仪器到货缺陷率(新产品)' },
      { label: '新品FFR', value: '7.8%', target: '≤8%', status: 'pass', desc: '仪器维修率(新产品)' },
      { label: '设计缺陷率', value: '2.2%', target: '≤2.5%', status: 'pass', desc: '试剂设计验证一次通过率' },
      { label: '设计变更', value: events.filter(function(e) { return e.event_type === 'Change-Control'; }).length, target: '--', status: 'info', desc: '进行中设计变更数' },
    ],
    sections: [
      { title: '新产品导入质量 (DOA / FFR)', type: 'table',
        headers: ['指标','目标',...months,'YTD'],
        rows: [
          { name: 'DOA 到货缺陷率', target: '≤8%', months: {'1月':14.3,'2月':0,'3月':0,'4月':0,'5月':16.7}, ytd:'9.1%', status:'fail', direction:'lt' },
          { name: 'FFR 月度维修率', target: '≤8%', months: {'1月':12.0,'2月':7.8,'3月':6.0,'4月':7.4,'5月':5.8}, ytd:'7.8%', status:'pass', direction:'lt' },
        ],
        children: [
          { name: 'F-C800P FFR', target: '≤8%', months: {'1月':15.7,'2月':11.7,'3月':8.5,'4月':9.2,'5月':7.3}, ytd:'10.5%', status:'fail' },
          { name: '药敏 FFR', target: '≤8%', months: {'1月':7.3,'2月':2.8,'3月':2.8,'4月':4.9,'5月':3.8}, ytd:'4.3%', status:'pass' },
        ]
      },
      { title: '设计相关客诉 Top 问题', type: 'list',
        items: [
          { issue: 'CKMB假阳性（小批量上市产品）', product: 'CKMB测定试剂盒', line: '生化', status: 'open' },
          { issue: 'CA系列盲样偏差（京津冀鲁EQA）', product: 'CA242/CA15-3/CA19-9', line: '发光', status: 'open' },
          { issue: 'HBV迭代后阳性率偏高', product: 'HBV核酸检测', line: '荧光PCR', status: 'open' },
          { issue: 'PGI/PGII室间质评偏差', product: 'PGI/PGII检测试剂', line: '发光', status: 'open' },
        ]
      },
      { title: '研发体系建设 (待启动)', type: 'cards',
        items: [
          { name: '研发项目平均缺陷数', target: '待定', note: '需建立设计评审标准' },
          { name: '设计验证一次通过率', target: '≥95%', note: '需建立统计口径' },
        ]
      },
    ]
  };

  // ===== MODULE 2: 供应链质量 SC =====
  var scModule = {
    id: 'supply', title: '供应链质量', icon: '📦', subtitle: '来料检验 · 供应商管理 · 仓储物流',
    color: '#F59E0B',
    summary: [
      { label: '原料合格率(试剂)', value: '99.5%', target: '≥99%', status: 'pass', desc: '上海/泰州/长沙 共1586批' },
      { label: '原料合格率(仪器)', value: '99.0%', target: '≥97%', status: 'pass', desc: '共1574批' },
      { label: '包材合格率', value: '99.5%', target: '≥98%', status: 'pass', desc: '共546批' },
      { label: '量产品DOA', value: '7.7%', target: '≤8%', status: 'pass', desc: '量产仪器到货缺陷率' },
    ],
    sections: [
      { title: '来料检验合格率趋势', type: 'table',
        headers: ['指标','目标',...months,'YTD'],
        rows: [
          { name: '包材检验合格率', target: '≥98%', months: {'1月':100,'2月':98.5,'3月':98.4,'4月':100,'5月':100}, ytd:'99.5%', status:'pass', detail:'546批/3不良', direction:'gte' },
          { name: '原料(试剂)合格率', target: '≥99%', months: {'1月':99.4,'2月':100,'3月':98.5,'4月':99.8,'5月':100}, ytd:'99.5%', status:'pass', detail:'1586批/8不良', direction:'gte' },
          { name: '原料(仪器)合格率', target: '≥97%', months: {'1月':97.5,'2月':97.5,'3月':99.0,'4月':99.5,'5月':100}, ytd:'99.0%', status:'pass', detail:'1574批/16不良', direction:'gte' },
        ]
      },
      { title: '供应商质量绩效', type: 'table',
        headers: ['供应商','质量评分','交货评分','体系评分','综合','风险'],
        rows: suppliers.slice(0, 6).map(function(s) { return {
          name: s.supplier_name || s.name,
          quality: s.quality_score || '--',
          delivery: s.delivery_score || '--',
          system: s.system_score || '--',
          total: s.total_score || '--',
          risk: s.risk_level || '--',
        };})
      },
      { title: '物料相关客诉', type: 'list',
        items: [
          { issue: '底物液原料批间差(重复客诉)', product: '全自动底物液', line: '发光', status: 'open' },
          { issue: 'Lp(a) DAKO原料批间差', product: '脂蛋白a测定试剂盒', line: '生化', status: 'closed' },
          { issue: 'TT4试剂瓶裂痕漏液', product: 'TT4试剂', line: '发光', status: 'closed' },
        ]
      },
    ]
  };

  // ===== MODULE 3: 生产质量 MFG =====
  var mfgModule = {
    id: 'mfg', title: '生产质量', icon: '🏭', subtitle: '过程控制 · 成品检验 · 批记录 · 仪器质量',
    color: '#3B82F6',
    summary: [
      { label: '半成品合格率', value: '97.4%', target: '≥98%', status: 'warning', desc: '774批/20不良' },
      { label: '成品合格率(试剂)', value: '99.9%', target: '≥99%', status: 'pass', desc: '876批/1不良' },
      { label: '批记录合格率', value: '96.7%', target: '≥95%', status: 'pass', desc: '874批/29不良' },
      { label: 'DOA Overall', value: '8.7%', target: '≤8%', status: 'warning', desc: '整体到货缺陷率' },
    ],
    sections: [
      { title: '过程检验 & 成品检验', type: 'table',
        headers: ['指标','目标',...months,'YTD'],
        rows: [
          { name: '半成品合格率(试剂)', target: '≥98%', months: {'1月':97.1,'2月':99.2,'3月':97.4,'4月':94.6,'5月':99.3}, ytd:'97.4%', status:'warning', direction:'gte' },
          { name: '成品合格率(试剂)', target: '≥99%', months: {'1月':100,'2月':100,'3月':99.5,'4月':100,'5月':100}, ytd:'99.9%', status:'pass', direction:'gte' },
          { name: '成品合格率(仪器)', target: '≥85%', months: {'1月':100,'2月':100,'3月':100,'4月':100,'5月':100}, ytd:'100%', status:'pass', direction:'gte' },
          { name: '批记录合格率', target: '≥95%', months: {'1月':98.3,'2月':97.8,'3月':93.8,'4月':94.5,'5月':100}, ytd:'96.7%', status:'pass', direction:'gte' },
          { name: '稳定性检测完成率', target: '100%', months: {'1月':'--','2月':'--','3月':'--','4月':'--','5月':'--'}, ytd:'79.2%', status:'fail', note:'⚠️342/432批', direction:'gte' },
        ]
      },
      { title: '仪器质量 (分机型 DOA/FFR)', type: 'cross',
        models: ['F-C800P','F-i3000','F-i1000','药敏'],
        metrics: [
          { label:'DOA', target:'≤8%', data:{'F-C800P':{months:{'1月':0,'2月':0,'3月':0,'4月':0,'5月':20.0},ytd:'9.1%',status:'fail'},'F-i3000':{months:{'1月':0,'2月':0,'3月':0,'4月':0,'5月':0},ytd:'0%',status:'pass'},'F-i1000':{months:{'1月':0,'2月':0,'3月':0,'4月':50.0,'5月':0},ytd:'50%',status:'fail'},'药敏':{months:{'1月':33.3,'2月':0,'3月':0,'4月':0,'5月':0},ytd:'9.1%',status:'fail'}} },
          { label:'FFR', target:'≤8%', data:{'F-C800P':{months:{'1月':15.7,'2月':11.7,'3月':8.5,'4月':9.2,'5月':7.3},ytd:'10.5%',status:'fail'},'F-i3000':{months:{'1月':17.2,'2月':8.4,'3月':7.3,'4月':6.7,'5月':7.4},ytd:'9.4%',status:'fail'},'F-i1000':{months:{'1月':11.7,'2月':3.9,'3月':5.2,'4月':3.8,'5月':2.5},ytd:'5.4%',status:'pass'},'药敏':{months:{'1月':7.3,'2月':2.8,'3月':2.8,'4月':4.9,'5月':3.8},ytd:'4.3%',status:'pass'}} },
        ]
      },
    ]
  };

  // ===== MODULE 4: 体系质量 QMS =====
  var qmsModule = {
    id: 'qms', title: '体系质量', icon: '📋', subtitle: 'CAPA · 审计 · 文件 · 风险管理',
    color: '#10B981',
    summary: [
      { label: 'CAPA总数', value: capas.length, target: '--', status: 'info', desc: '含关闭' + capas.filter(function(c){return c.status==='Closed';}).length + '件' },
      { label: '审计发现', value: events.filter(function(e){return e.event_type==='Audit-Finding';}).length, target: '--', status: 'info', desc: '待关闭审计发现' },
      { label: '客诉闭环率', value: (function(){var ce=events.filter(function(e){return e.event_type==='Complaint';});return ce.length?Math.round(ce.filter(function(e){return e.status==='Closed'}).length/ce.length*100):100;})(), target: '≥95%', status: (function(){var ce=events.filter(function(e){return e.event_type==='Complaint';});return ce.length&&ce.filter(function(e){return e.status==='Closed'}).length/ce.length>=0.95?'pass':'fail';})(), unit:'%', desc: '投诉闭环率' },
      { label: '文件合格率', value: '96%', target: '≥95%', status: 'pass', desc: '体系文件受控率' },
    ],
    sections: [
      { title: 'CAPA 管理', type: 'summary',
        items: [
          { label: 'CAPA总数', value: capas.length },
          { label: '已关闭', value: capas.filter(function(c){return c.status==='Closed';}).length, color:'#10B981' },
          { label: '处理中', value: capas.filter(function(c){return c.status==='In Progress';}).length, color:'#3B82F6' },
          { label: '逾期', value: capas.filter(function(c){return c.due_date&&new Date(c.due_date)<new Date()&&c.status!=='Closed';}).length, color:'#EF4444' },
        ]
      },
      { title: '体系建设指标 (规划中)', type: 'cards',
        items: [
          { name: '风险管理覆盖率', target: '100%', note: 'ISO 14971 风险管理覆盖' },
          { name: 'PMS覆盖率', target: '100%', note: '上市后监督计划执行' },
          { name: 'GMP平均缺陷数', target: '待定', note: '需建立缺陷分类标准' },
          { name: '体系文件优化', target: '待定', note: '文件精简/合并计划' },
        ]
      },
      { title: '近期审计发现', type: 'list',
        items: events.filter(function(e){return e.event_type==='Audit-Finding';}).slice(0, 5).map(function(e){return {issue:e.description||e.title,date:e.created_at,status:e.status};})
      },
    ]
  };

  res.json({
    modules: [rdModule, scModule, mfgModule, qmsModule],
    updated: '2026-05',
  });
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
	    console.log('\n  ╔══════════════════════════════════════════════╗\n  ║   FosunDx Quality Hub (FDQH) Platform       ║\n  ║   IVD 数字化质量管理平台 v1.6                 ║\n  ║   http://localhost:' + PORT + '                      ║\n  ╚══════════════════════════════════════════════╝\n  ');
    console.log('  默认账号: admin / admin123');
  });
}).catch(function(err) {
  console.error('Database init error:', err.message);
  app.listen(PORT, function() { console.log('Server started on ' + PORT + ' (no database)'); });
});
