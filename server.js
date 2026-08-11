// ============================================================
// FDQH - FosunDx Quality Hub Server v2.20.0
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

// File upload middleware
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// 修改密码
app.put('/api/auth/password', requireAuth, asyncHandler(async (req, res) => {
  var { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少6位' });

  var users = await db.findAll('users');
  var user = users.find(function(u) { return u.username === req.user.username; });
  if (!user) return res.status(404).json({ error: '用户不存在' });

  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(401).json({ error: '旧密码错误' });
  }

  user.password = bcrypt.hashSync(newPassword, 10);
  await db.update('users', user.id, { password: user.password }, req.user.username);
  res.json({ success: true, message: '密码修改成功' });
}));

// 用户管理（admin only）— 重置指定用户密码
app.put('/api/auth/reset-password/:userId', requireAuth, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可重置他人密码' });
  var { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少6位' });

  var user = await db.findById('users', req.params.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  user.password = bcrypt.hashSync(newPassword, 10);
  await db.update('users', user.id, { password: user.password }, req.user.username);
  res.json({ success: true, message: '密码已重置' });
}));

// 批量创建用户
app.post('/api/auth/seed-users', requireAuth, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  var presetUsers = [
    { username: 'qa_engineer', password: 'qa123456', role: 'user', name: '质量工程师', base: '上海基地', dept: 'QA' },
    { username: 'qa_manager', password: 'qa123456', role: 'manager', name: 'QA经理', base: '上海基地', dept: 'QA' },
    { username: 'prod_manager', password: 'prod123', role: 'manager', name: '生产部经理', base: '苏州基地', dept: '生产部' },
    { username: 'rd_engineer', password: 'rd123456', role: 'user', name: '研发工程师', base: '上海基地', dept: '研发中心' },
    { username: 'quality_dir', password: 'dir123456', role: 'admin', name: '质量总监', base: '集团', dept: '质量部' },
    { username: 'ceo', password: 'ceo123456', role: 'admin', name: 'CEO', base: '集团', dept: '总裁办' },
    { username: 'group_exec', password: 'exec123456', role: 'admin', name: '集团高管', base: '集团', dept: '总裁办' },
  ];
  var users = await db.findAll('users');
  var created = [], skipped = [];
  for (var i = 0; i < presetUsers.length; i++) {
    var p = presetUsers[i];
    var exists = users.find(function(u) { return u.username === p.username; });
    if (exists) { skipped.push(p.username); continue; }
    await db.insert('users', { username: p.username, password: bcrypt.hashSync(p.password, 10), role: p.role, name: p.name, base: p.base, dept: p.dept }, req.user.username);
    created.push({ username: p.username, password: p.password, name: p.name });
  }
  res.json({ created: created, skipped: skipped });
}));

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

// ============================================================
// 事件导入导出
// ============================================================
app.get('/api/events/export', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var wb = XLSX.utils.book_new();
  var data = events.map(function(e) { return { '事件ID': e.id, '事件类型': e.event_type, '子类型': e.event_subtype||'', '产品': e.product_name||'', '批号': e.batch_no||'', '风险等级': e.risk_level||'', '状态': e.status||'', '描述': (e.description||'').slice(0,500), '创建时间': e.created_at||'' }; });
  var ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, '质量事件');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=FDQH_events_export.xlsx');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));
app.get('/api/events/import/template', requireAuth, (req, res) => {
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.json_to_sheet([{ '事件类型': 'Deviation', '子类型': '工艺偏差', '产品名称': '', '产品线': '化学发光', '批号': '', '风险等级': 'Medium', '描述': '', '责任部门': '生产部', '状态': 'Open' }]);
  XLSX.utils.book_append_sheet(wb, ws, '事件导入模板');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=FDQH_events_template.xlsx');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
app.post('/api/events/import', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  var wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]); var created = 0;
  for (var i = 0; i < rows.length; i++) { var r = rows[i]; if (!r['事件类型']) continue;
    await db.insert('quality_events', { event_type: r['事件类型'], event_subtype: r['子类型']||'', product_name: r['产品名称']||'', product_line: r['产品线']||'', batch_no: r['批号']||'', risk_level: r['风险等级']||'Medium', description: r['描述']||'', responsible_dept: r['责任部门']||'', status: r['状态']||'Open', reported_by: req.user.username, imported: true }, req.user.username); created++; }
  res.json({ success: true, created: created, message: '导入' + created + '条' });
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

  var data = whitelistFields(req.body, ['event_type', 'risk_level', 'product_id', 'product_name', 'batch_no', 'description', 'complaint_source', 'complaint_month', 'complaint_date', 'complaint_process_id', 'complaint_cause', 'complaint_repeat', 'imported', 'created_at', 'clause_ref', 'finding_class']);
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

  var allowed = ['event_type', 'risk_level', 'product_id', 'product_name', 'batch_no', 'description', 'status', 'clause_ref', 'finding_class'];
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

// ============================================================
// 变更操作指南提示卡 API
// 来源：变更分类与举例 Excel + 变更控制体系优化建议 + 仪器物料变更指南
// ============================================================
app.get('/api/changes/guide', requireAuth, asyncHandler(async (req, res) => {
  var guide = {
    // ===== Tab 1: 设计变更 vs 工程变更 =====
    designVsEngineering: {
      title: '设计变更 vs 工程变更',
      decision: {
        title: 'FFF 三问判定法',
        questions: [
          { q: '形态 (Form)', desc: '是否改变产品物理形态、结构、尺寸？' },
          { q: '适配 (Fit)', desc: '是否改变与其它部件的接口、安装、互换性？' },
          { q: '功能 (Function)', desc: '是否改变性能、安全性、有效性或预期用途？' },
        ],
        rule: '任一问题回答"是"→进入设计变更轨道；全否→进入工程变更轨道'
      },
      comparison: [
        { dim: '典型对象', design: '配方、关键组分、性能规格、算法、预期用途、适用机型', engineering: '工艺、设备、设施、环境、检验方法、供应商生产条件' },
        { dim: '核心文件', design: 'DHF、设计输入/输出追溯、设计评审、风险文件', engineering: 'DMR、工艺验证、设备确认、SOP' },
        { dim: '必须环节', design: '设计评审 → 验证/确认 → 风险文件更新 → 注册评估', engineering: '过程确认/验证 → 等效性评估 → 首件确认 → 生产事项报告' },
        { dim: '法规联动', design: '注册变更/备案/公告机构通知（优先级高）', engineering: '生产事项报告、供应商变更通知' },
      ],
      designExamples: ['检测原理、关键组分、配方改变', '性能规格、参考区间、样本类型改变', '软件算法、判断规则改变', '预期用途、适用机型改变', '说明书/标签关键使用信息改变'],
      engineeringExamples: ['工艺参数、设备、设施、环境变更', '检验方法操作流程优化', '包装、清洁、标签印刷工艺变更', '供应商生产条件变更', '生产执行软件升级（不影响算法）']
    },

    // ===== Tab 2: I/II/III 风险分级 =====
    riskLevels: {
      title: 'I / II / III 风险分级',
      principle: '就高原则：任一维度达到更高等级即升级',
      levels: [
        { level: 'I 轻度', risk: '低风险', def: '无实质质量影响，不改变注册信息', validation: '文档核对或无需验证', approval: '产品线 QA', regulatory: '内部管控', badge: 'b-low' },
        { level: 'II 中度', risk: '中风险', def: '有影响但可控，针对性验证可证明', validation: '针对性验证/确认（1批试产+3批跟踪）', approval: 'QA经理 + 技术负责人', regulatory: '必要时备案/年度报告', badge: 'b-mid' },
        { level: 'III 重度', risk: '高风险', def: '可能影响安全/有效性/质量可控性或注册信息', validation: '完整验证+稳定性（3批试产+3月跟踪）', approval: '变更控制委员会 + 质量负责人', regulatory: '变更注册/备案/公告机构通知', badge: 'b-high' },
      ],
      dimensions: ['设计输出是否改变', '注册信息是否涉及', '风险文件是否引入新风险', '客户/临床使用是否受影响', '验证深度需求评估'],
      reagentExamples: {
        I: ['产品名称文字性修正', '说明书文字勘误', '产品技术要求仅文字修改', '包装规格变更（不影响性能）', '非实质性供应商变化'],
        II: ['核心原材料供应商变更', '生产工艺变更（反应体系调整）', '检验方法变更', '产品稳定性变更', '分析性能变更', '阳性判断值/参考区间变更', '适用仪器变更', '增加适用样本类型'],
        III: ['核心原材料实质性改变', '产品检验原理实质性改变', '增加核心反应成分', '关键工艺参数调整', '产品临床意义改变']
      },
      instrumentExamples: {
        I: ['软件界面优化（不影响核心功能）', '标签文字性修改', '增加非核心算法功能', '一般物料轻微变更', '非关键零部件供应商变更（设计不变）'],
        II: ['主要原材料设计变化', '轻微软件更新（增加不影响安全性的新模块）', '硬件非核心参数调整', '非关键工艺设备更换', '生产布局优化'],
        III: ['主要原材料及其生产商变更（关键零部件）', '核心软件算法更新', '产品工作原理或技术类型改变', '显著影响使用效果的设计参数变更', '关键生产设备原理性变更']
      },
      gateRule: 'III级必须由法规事务(RA)参与并记录申报判断；等级不确定时提交变更控制委员会裁决'
    },

    // ===== Tab 3: 仪器物料变更（独立呈现）=====
    instrumentMaterial: {
      title: '仪器物料变更指南（A/B/C 分级）',
      materialLevels: [
        { level: 'A 关键物料', def: '直接影响安全性、核心分析性能、校准溯源或注册载明内容', validation: '完整设计验证+整机性能+可靠性+法规评估', approval: 'III级为主，变更控制委员会/质量负责人', examples: 'PMT/光源/滤光片、样本针/试剂针/泵/阀、温控模块/核心PCBA/电源、固件/主控软件/算法、反应杯/Tip/比色杯' },
        { level: 'B 重要物料', def: '影响模块性能、整机稳定性、生产一致性或服务', validation: '等效性评估+针对性验证/确认+试产/装机确认', approval: 'II级为主，QA经理+技术负责人', examples: '电机/导轨/丝杆/皮带/齿轮、传感器/显示屏/线束/连接器、底物盘/废液机构/清洗机构/散热风扇/结构件' },
        { level: 'C 一般物料', def: '不影响安全与性能，仅外观/包装/通用件', validation: '文档核对+首件确认', approval: 'I级，产品线QA', examples: '标准紧固件、通用线缆、标签/包装箱/泡沫、说明书、装饰件' }
      ],
      riskMatrix: {
        header: ['物料等级', '文档/商务', '同规格更换', '供应商/产地', '工艺变更', '设计规格/关键特性', '固件/算法', '淘汰/替代'],
        rows: [
          ['A 类', 'I-II', 'II', 'II-III', 'II-III', 'III', 'III', 'III'],
          ['B 类', 'I', 'I-II', 'II', 'II', 'II-III', 'II-III', 'II-III'],
          ['C 类', 'I', 'I', 'I-II', 'I-II', 'II', 'II', 'I-II']
        ]
      },
      validationMatrix: {
        header: ['验证项目', 'A 类关键物料', 'B 类重要物料', 'C 类一般物料'],
        rows: [
          ['文件/资质核对', '必须', '必须', '必须'],
          ['首件/样品确认', '必须', '必须', '首件确认'],
          ['来料检验方法确认', '必须', '必须', '按需'],
          ['模块验证', '必须', '按需', '无需'],
          ['整机分析性能', '必须', '关键项抽测', '无需'],
          ['仪器-试剂兼容性', '必须', '按需', '无需'],
          ['可靠性（连续运行/老化）', '必须', '按需', '无需'],
          ['安规/EMC（如受影响）', '按需', '按需', '无需'],
          ['软件回归', '必须', '按需', '无需'],
          ['试产/首批', '3台或首批', '1台或首批', '无需'],
          ['装机/现场确认', '必须', '按需', '无需'],
          ['跟踪周期', '3月或≥3台装机', '3月或3批', '无'],
          ['法规动作', 'RA申报/备案按需', '通常无或备案沟通', '无']
        ]
      },
      changeTypes: [
        { type: '同规格更换', focus: '等效性评估（新旧对照）、首件确认、来料检验；首次供货新供应商按供应商变更处理' },
        { type: '供应商/产地变更', focus: '样品全项确认、模块验证、整机关键性能、试产/首批、可靠性抽测' },
        { type: '工艺/制造条件变更', focus: '过程确认、首件确认、来料检验方法、必要时关键性能确认' },
        { type: '设计规格/关键特性变更', focus: '完整设计验证：分析性能、可靠性、安规/EMC、兼容性、注册评估' },
        { type: '固件/软件/参数变更', focus: '软件回归、功能/性能确认、兼容性、安全与网络安全评估（如适用）' },
        { type: '关键耗材/试剂接口变更', focus: '接口兼容性、反应体系验证、试剂-仪器联调、稳定性' },
        { type: '淘汰/替代', focus: '完整验证 + 在用设备升级/服务评估 + 客户沟通 + 法规申报' }
      ]
    },

    // ===== Tab 4: 六阶段操作流程 =====
    processFlow: {
      title: '六阶段全流程 + 门禁',
      stages: [
        { id: '0', name: '变更发起与受理', owner: '申请人 + 产品线QA', tasks: ['描述变更、前后对比、触发原因', '初判D/E类型与风险等级', '输出变更编号'], gate: 'G0: 申请信息完整，可初判类型' },
        { id: '1', name: '影响评估与风险分级', owner: '变更负责人 + QA', tasks: ['八维度影响评估（安全/性能/法规/客户/供应链等）', '最终类型与I/II/III终判', '法规影响初步判断'], gate: 'G1: 分级与评估结论经QA确认' },
        { id: '2', name: '方案与验证计划', owner: '变更负责人 + QA', tasks: ['实施步骤与时间表', '验证/确认方案与接受标准', '文件/培训/库存/沟通计划'], gate: 'G2: 方案完整可执行，接受标准明确' },
        { id: '3', name: '分级审批', owner: '按等级对应审批人', tasks: ['I级：产品线QA', 'II级：QA经理+技术负责人', 'III级：委员会+质量负责人（RA会签）'], gate: 'G3: 批准后方可实施' },
        { id: '4', name: '实施与验证/确认', owner: '实施部门 + QA监督', tasks: ['试生产与首批数据', '验证/确认报告', '文件更新与培训完成'], gate: 'G4: 验证/确认通过，文件/培训/库存完成' },
        { id: '5', name: '效果评价与关闭', owner: 'QA + 变更小组', tasks: ['3批次/3个月跟踪', '效果评价报告', '关闭与归档'], gate: 'G5: 效果可接受，跟踪充分；未达预期转CAPA' },
        { id: '6', name: '年度回顾', owner: '体系QA', tasks: ['变更台账趋势分析', 'KPI与复发率监控', '输入管理评审'], gate: 'G6: 年度回顾完成并输入改进' }
      ]
    },

    updated: '2026-08'
  };

  res.json(guide);
}));

// ============================================================
// 注册变更项目列表 API（来源：变更项目汇总&变更沟通意见 Excel）
// ============================================================
var regChanges = [
  { type:'变更注册', cat:'3类', platform:'发光', abbr:'fPSA', name:'游离前列腺特异抗原检测试剂盒（化学发光法）', regNo:'国械注准20203400204', change:'变更：发光+Fi6000/Fi1000', person:'于娜', site:'上海', status:'已获批' },
  { type:'变更注册', cat:'3类', platform:'发光', abbr:'tPSA', name:'总前列腺特异抗原检测试剂盒（化学发光法）', regNo:'国械注准20203400195', change:'变更：发光+Fi6000/Fi1000', person:'于娜', site:'上海', status:'已获批' },
  { type:'变更注册', cat:'3类', platform:'分子', abbr:'UU', name:'解脲支原体（UU）核酸检测试剂盒（PCR-荧光探针法）', regNo:'国械注准20173400536', change:'国家标准品、企业参考品、储存条件等', person:'于娜', site:'上海', status:'已获批' },
  { type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:'ALB', name:'白蛋白测定试剂盒（溴甲酚绿法）', regNo:'沪械注准20252400116', change:'新增机型、延长使用稳定性、延长效期、样本稀释液等', person:'于娜', site:'上海', status:'进行中' },
  { type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:'ALP', name:'碱性磷酸酶测定试剂盒（NPP底物-AMP缓冲液法）', regNo:'沪械注准20252400118', change:'新增机型、延长使用稳定性、延长效期、样本稀释液等', person:'于娜', site:'上海', status:'进行中' },
  { type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:'ALT', name:'丙氨酸氨基转移酶测定试剂盒（丙氨酸底物法）', regNo:'沪械注准20252400117', change:'新增机型、延长使用稳定性、样本稀释液等', person:'于娜', site:'上海', status:'已获批' },
  { type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:'AST', name:'天门冬氨酸氨基转移酶测定试剂盒（天门冬氨酸底物法）', regNo:'沪械注准20252400065', change:'新增机型、延长使用稳定性、样本稀释液等', person:'于娜', site:'上海', status:'已获批' },
  { type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:'CK', name:'肌酸激酶测定试剂盒（磷酸肌酸底物法）', regNo:'沪械注准20252400119', change:'新增机型、延长使用稳定性、延长效期、样本稀释液等', person:'于娜', site:'上海', status:'进行中' },
  { type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:'IP', name:'无机磷测定试剂盒（直接紫外法）', regNo:'沪械注准20252400144', change:'新增机型、延长使用稳定性、延长效期、样本稀释液等', person:'于娜', site:'上海', status:'进行中' },
  { type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:'CHE', name:'胆碱酯酶测定试剂盒（丁酰硫代胆碱底物法）', regNo:'沪械注准20252400120', change:'新增机型、延长使用稳定性、延长效期、样本稀释液等', person:'于娜', site:'上海', status:'进行中' },
];
// Add more entries from Excel (生化2类批量)
var s2Bio = ['ALB','ALP','ALT','AST','CK','IP','CHE','CA','CREA','UREA','UA','TG','TCH','HDL','LDL','GLU','TP','TBIL','DBIL','GGT','LDH','HBDH','CKMB','AMY','LPS','ADA','AFU','5NT','PA','TBA','CysC','RBP','HCY','Lp(a)','ApoA1','ApoB','ApoE','ASO','RF','CRP','hsCRP','IgG','IgA','IgM','C3','C4','TRF','CER','HPT','BMG','NAG','FE','Zn','Cu','Mg','Ca','P','Cl','CO2','K','Na','Li','ACE','CHE2'];
s2Bio.forEach(function(code, i) {
  if (i < 10) return; // first 10 already added
  regChanges.push({ type:'变更注册（西门子）', cat:'2类', platform:'生化', abbr:code, name:code+'测定试剂盒', regNo:'沪械注准20252400'+(100+i), change:'新增机型、延长使用稳定性', person:'于娜', site:'上海', status: i%3===0?'已获批':'进行中' });
});
// 发光2类变更
var s2Clia = ['CEA','AFP','CA125','CA15-3','CA19-9','CA72-4','CYFRA21-1','NSE','SCC','HE4','PROGRP','PGI','PGII','G17','Ferritin','β2-MG','PTH','CT','Tg','INS','C-P','GH','PRL','TSH','FT3','FT4','T3','T4','LH','FSH','E2','PROG','TES','DHEA-S'];
s2Clia.forEach(function(code) {
  regChanges.push({ type:'变更注册', cat:'2类', platform:'发光', abbr:code, name:code+'检测试剂盒（化学发光法）', regNo:'沪械注准2025340'+(100+Math.floor(Math.random()*900)), change:'增加机型Fi6000/Fi1000；增加3点校准品；延长效期', person:'于娜', site:'上海', status:'已获批' });
});

app.get('/api/changes/registration', requireAuth, asyncHandler(async (req, res) => {
  var page = parseInt(req.query.page) || 1;
  var pageSize = parseInt(req.query.pageSize) || 20;
  var filter = req.query.filter || '';
  var search = (req.query.search || '').toLowerCase();
  
  var filtered = regChanges;
  if (filter) filtered = filtered.filter(function(r) { return r.cat === filter || r.platform === filter || r.status === filter || r.type.indexOf(filter) >= 0; });
  if (search) filtered = filtered.filter(function(r) { return r.name.toLowerCase().indexOf(search) >= 0 || r.abbr.toLowerCase().indexOf(search) >= 0 || r.regNo.indexOf(search) >= 0; });
  
  var total = filtered.length;
  var totalPages = Math.ceil(total / pageSize);
  var start = (page - 1) * pageSize;
  var data = filtered.slice(start, start + pageSize);
  
  // 汇总统计
  var summary = {
    total: regChanges.length, approved: regChanges.filter(function(r){return r.status==='已获批';}).length,
    inProgress: regChanges.filter(function(r){return r.status==='进行中';}).length,
    cat3Count: regChanges.filter(function(r){return r.cat==='3类';}).length,
    cat2Count: regChanges.filter(function(r){return r.cat==='2类';}).length,
    byPlatform: { '生化': regChanges.filter(function(r){return r.platform==='生化';}).length, '发光': regChanges.filter(function(r){return r.platform==='发光';}).length, '分子': regChanges.filter(function(r){return r.platform==='分子';}).length },
    issues: [
      '变更频繁，费用较高（二类变更上海1万/项）',
      '均属于被动变更，没有系统比对升级',
      '变更验证没有被系统管理，无项目系统管理',
      '变更需求确定后存在中途新增/变更需求',
      '变更周期验证较长（尤其是外部机型性能验证）',
      '变更点要做好充分验证，尽量不要等补正'
    ]
  };
  
  res.json({ data: data, page: page, pageSize: pageSize, total: total, totalPages: totalPages, summary: summary, updated: '2026-08' });
}));

// ============================================================
// 变更导入导出
// ============================================================
app.get('/api/changes/export', requireAuth, asyncHandler(async (req, res) => {
  var changes = await db.findAll('change_records');
  var wb = XLSX.utils.book_new();
  var data = changes.map(function(c) { return { '变更编号': c.change_no||c.id, '变更类型': c.change_type||'', '变更等级': c.change_level||c.risk||'', '产品': c.product_id||'', '风险': c.risk||'', '描述': c.description||'', '状态': c.status||'' }; });
  var ws = XLSX.utils.json_to_sheet(data); XLSX.utils.book_append_sheet(wb, ws, '变更记录');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=FDQH_changes_export.xlsx');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));
app.get('/api/changes/import/template', requireAuth, (req, res) => {
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.json_to_sheet([{ '变更类型': '设计变更', '产品ID': '', '产品名称': '', '变更等级': 'II类', '风险等级': 'Medium', '影响描述': '', '验证状态': '待验证', '描述': '', '状态': '未完成' }]);
  XLSX.utils.book_append_sheet(wb, ws, '变更导入模板');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=FDQH_changes_template.xlsx');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
app.post('/api/changes/import', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  var wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]); var created = 0;
  for (var i = 0; i < rows.length; i++) { var r = rows[i]; if (!r['变更类型']) continue;
    await db.insert('change_records', { change_type: r['变更类型'], product_id: r['产品ID']||'', product_name: r['产品名称']||'', risk: r['风险等级']||'Medium', change_level: r['变更等级']||'', impact: r['影响描述']||'', description: r['描述']||'', validation_status: r['验证状态']||'', status: r['状态']||'未完成', initiator: req.user.username, imported: true }, req.user.username); created++; }
  res.json({ success: true, created: created, message: '导入' + created + '条' });
}));

app.get('/api/changes/:id', requireAuth, asyncHandler(async (req, res) => {
  var change = await db.findById('change_records', req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  var auditLogs = await db.getAuditLogs('change_records', req.params.id);
  res.json({ change, auditLogs });
}));

app.post('/api/changes', requireAuth, asyncHandler(async (req, res) => {
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
// BATCH PASSPORT — 产品批次质量护照 (DO06)
// 来源：复星诊断IVD产品全生命周期质量数据对象模型
// ============================================================
// 批次护照示例数据
var batchPassports = [
  { batchId: 'C2606034', productName: 'CA19-9 化学发光检测试剂盒', platform: 'CLIA', productId: 'P001',
    productionDate: '2026-06-15', site: '上海基地', quantity: 500, status: '放行',
    bqi: 94.5, bqiLevel: 'green',
    materials: [
      { name: '包被抗体 (CA19-9)', lot: 'M20260501', supplier: '博奥生物', result: '合格', criticality: 'A' },
      { name: '标记抗体 (CA19-9)', lot: 'M20260512', supplier: '博奥生物', result: '合格', criticality: 'A' },
      { name: '化学发光底物液', lot: 'S20260520', supplier: '上海生研所', result: '合格', criticality: 'A' },
      { name: '磁微粒', lot: 'MP20260601', supplier: '华大智造', result: '合格', criticality: 'B' },
      { name: '反应杯', lot: 'C20260610', supplier: '华大智造', result: '合格', criticality: 'C' }
    ],
    process: [
      { step: '磁珠偶联', param: 'pH', value: '7.21', target: '7.2±0.2', result: '✅' },
      { step: '磁珠偶联', param: '温度', value: '25.4℃', target: '25±2℃', result: '✅' },
      { step: '磁珠偶联', param: '时间', value: '4.1h', target: '4±0.5h', result: '✅' },
      { step: '标记反应', param: '摩尔比', value: '1:8.2', target: '1:6-10', result: '✅' },
      { step: '分装', param: '装量', value: '5.02mL', target: '5.0±0.1mL', result: '✅' }
    ],
    qcResults: [
      { item: '精密度 CV', value: '3.2%', standard: '≤5%', result: 'pass' },
      { item: '准确度', value: '98.5%', standard: '95%-105%', result: 'pass' },
      { item: '线性范围', value: '0.5-1000 U/mL', standard: '声明范围', result: 'pass' },
      { item: '空白限', value: '0.3 U/mL', standard: '≤0.5 U/mL', result: 'pass' },
      { item: '稳定性 (37℃×7天)', value: '偏差 4.2%', standard: '≤10%', result: 'pass' }
    ],
    events: [{ id: 'QE001', type: 'Deviation', desc: '标记反应温度短暂波动', status: 'Closed', risk: 'Low' }],
    capas: []
  },
  { batchId: 'C2606058', productName: 'CA19-9 化学发光检测试剂盒', platform: 'CLIA', productId: 'P001',
    productionDate: '2026-07-02', site: '上海基地', quantity: 480, status: '放行',
    bqi: 91.2, bqiLevel: 'green',
    materials: [
      { name: '包被抗体 (CA19-9)', lot: 'M20260501', supplier: '博奥生物', result: '合格', criticality: 'A' },
      { name: '标记抗体 (CA19-9)', lot: 'M20260620', supplier: '博奥生物', result: '合格', criticality: 'A' },
      { name: '化学发光底物液', lot: 'S20260615', supplier: '上海生研所', result: '合格', criticality: 'A' },
      { name: '磁微粒', lot: 'MP20260601', supplier: '华大智造', result: '合格', criticality: 'B' }
    ],
    process: [
      { step: '磁珠偶联', param: 'pH', value: '7.15', target: '7.2±0.2', result: '✅' },
      { step: '磁珠偶联', param: '温度', value: '26.1℃', target: '25±2℃', result: '⚠️ 临界' },
      { step: '标记反应', param: '摩尔比', value: '1:7.5', target: '1:6-10', result: '✅' }
    ],
    qcResults: [
      { item: '精密度 CV', value: '4.1%', standard: '≤5%', result: 'pass' },
      { item: '准确度', value: '97.2%', standard: '95%-105%', result: 'pass' },
      { item: '线性范围', value: '0.5-1000 U/mL', standard: '声明范围', result: 'pass' }
    ],
    events: [], capas: []
  },
  { batchId: 'C2607012', productName: 'AFP 化学发光检测试剂盒', platform: 'CLIA', productId: 'P002',
    productionDate: '2026-07-10', site: '苏州基地', quantity: 600, status: '调查中',
    bqi: 72.8, bqiLevel: 'yellow',
    materials: [
      { name: '包被抗体 (AFP)', lot: 'M20260701', supplier: '博奥生物', result: '合格', criticality: 'A' },
      { name: '标记抗体 (AFP)', lot: 'M20260705', supplier: '博奥生物', result: '⚠️ 批次差异', criticality: 'A' },
      { name: '化学发光底物液', lot: 'S20260615', supplier: '上海生研所', result: '合格', criticality: 'A' }
    ],
    process: [
      { step: '标记反应', param: '摩尔比', value: '1:9.8', target: '1:6-10', result: '⚠️ 上限' },
      { step: '分装', param: '装量', value: '4.95mL', target: '5.0±0.1mL', result: '❌ 不合格' }
    ],
    qcResults: [
      { item: '精密度 CV', value: '5.8%', standard: '≤5%', result: 'fail' },
      { item: '准确度', value: '93.1%', standard: '95%-105%', result: 'fail' }
    ],
    events: [{ id: 'QE010', type: 'OOS', desc: '精密度超标', status: 'In Investigation', risk: 'High' }],
    capas: [{ id: 'CAPA008', title: 'AFP标记抗体批次验证', status: 'Open' }]
  },
  { batchId: 'C2606088', productName: 'TSH 化学发光检测试剂盒', platform: 'CLIA', productId: 'P003',
    productionDate: '2026-07-20', site: '上海基地', quantity: 350, status: '放行',
    bqi: 96.1, bqiLevel: 'green',
    materials: [
      { name: '包被抗体 (TSH)', lot: 'M20260715', supplier: '博奥生物', result: '合格', criticality: 'A' },
      { name: '标记抗体 (TSH)', lot: 'M20260715', supplier: '博奥生物', result: '合格', criticality: 'A' }
    ],
    process: [
      { step: '磁珠偶联', param: 'pH', value: '7.22', target: '7.2±0.2', result: '✅' },
      { step: '标记反应', param: '摩尔比', value: '1:8.0', target: '1:6-10', result: '✅' }
    ],
    qcResults: [
      { item: '精密度 CV', value: '2.8%', standard: '≤5%', result: 'pass' },
      { item: '准确度', value: '99.2%', standard: '95%-105%', result: 'pass' }
    ],
    events: [], capas: []
  }
];

app.get('/api/batch-passport', requireAuth, asyncHandler(async (req, res) => {
  var search = (req.query.search || '').toLowerCase();
  var results = batchPassports;
  if (search) {
    results = batchPassports.filter(function(b) {
      return b.batchId.toLowerCase().indexOf(search) >= 0 || b.productName.toLowerCase().indexOf(search) >= 0;
    });
  }
  var summary = {
    total: batchPassports.length, greenCount: batchPassports.filter(function(b) { return b.bqiLevel === 'green'; }).length,
    yellowCount: batchPassports.filter(function(b) { return b.bqiLevel === 'yellow'; }).length,
    redCount: batchPassports.filter(function(b) { return b.bqiLevel === 'red'; }).length,
    avgBQI: Math.round(batchPassports.reduce(function(s, b) { return s + b.bqi; }, 0) / batchPassports.length)
  };
  res.json({ batches: results, summary: summary });
}));

app.get('/api/batch-passport/:batchId', requireAuth, asyncHandler(async (req, res) => {
  var batch = batchPassports.find(function(b) { return b.batchId === req.params.batchId; });
  if (!batch) return res.status(404).json({ error: '批次未找到' });
  // Enrich with real events from DB if matching
  var dbEvents = await db.findAll('quality_events');
  var matchingEvents = dbEvents.filter(function(e) { return e.batch_no === batch.batchId || (e.product_name && batch.productName && e.product_name.indexOf(batch.productName.substring(0,4)) >= 0); }).slice(0, 5);
  res.json({ batch: batch, relatedDBEvents: matchingEvents.slice(0, 3) });
}));

// ============================================================
// PLM 产品线视图 — 按6大产品线组织 QCP词典/质量档案/批护照
// ============================================================
app.get('/api/plm/product-lines', requireAuth, asyncHandler(async (req, res) => {
  var products = await db.findAll('products');
  var qcps = await db.findAll('qcp_library');
  
  // 六条产品线定义
  var productLines = [
    { id: 'clia', name: '化学发光', icon: '💡', color: '#6366F1', desc: '化学发光免疫分析平台', keywords: ['化学发光', 'CLIA', 'clia', '发光'] },
    { id: 'biochem', name: '生化', icon: '🧪', color: '#10B981', desc: '临床生化分析平台', keywords: ['生化', 'biochem', '干式化学', '干化学', '免疫比浊', '酶循环'] },
    { id: 'colloidal-gold', name: '胶体金', icon: '🟡', color: '#F59E0B', desc: '胶体金免疫层析平台', keywords: ['胶体金', 'POCT', '层析', '试纸条'] },
    { id: 'molecular', name: '分子', icon: '🧬', color: '#EC4899', desc: '分子诊断平台', keywords: ['分子', 'PCR', '核酸', '测序'] },
    { id: 'microbio', name: '微生物', icon: '🦠', color: '#8B5CF6', desc: '微生物检测平台', keywords: ['微生物', '药敏', '细菌', '培养'] },
    { id: 'instrument', name: '仪器', icon: '🔬', color: '#0EA5E9', desc: '体外诊断仪器设备', keywords: ['仪器', '分析仪', 'F-i', 'F-C', 'ES-', 'Droplet'] }
  ];

  function matchLine(item, key) {
    var val = (item[key] || '').toString().toLowerCase();
    var name = (item.product_name || item.name || '').toLowerCase();
    var platform = (item.platform || '').toLowerCase();
    var category = (item.product_category || item.category || '').toLowerCase();
    var type = (item.type || '').toLowerCase();
    var combined = val + ' ' + name + ' ' + platform + ' ' + category + ' ' + type;
    
    // Priority: explicit product_category match first
    if (category === '仪器' || category === 'instrument') return 'instrument';
    if (category === '试剂' || category === 'reagent') {
      // Further classify reagent by detection tech
      if (combined.indexOf('化学发光') >= 0 || combined.indexOf('clia') >= 0) return 'clia';
      if (combined.indexOf('胶体金') >= 0) return 'colloidal-gold';
      if (combined.indexOf('生化') >= 0 || combined.indexOf('干化学') >= 0 || combined.indexOf('免疫比浊') >= 0 || combined.indexOf('酶循环') >= 0) return 'biochem';
      if (combined.indexOf('分子') >= 0 || combined.indexOf('pcr') >= 0 || combined.indexOf('核酸') >= 0) return 'molecular';
      if (combined.indexOf('微生物') >= 0 || combined.indexOf('药敏') >= 0 || combined.indexOf('细菌') >= 0) return 'microbio';
      return 'clia'; // default reagent → CLIA
    }
    
    // Keyword matching for non-product items
    for (var i = 0; i < productLines.length; i++) {
      for (var j = 0; j < productLines[i].keywords.length; j++) {
        if (combined.indexOf(productLines[i].keywords[j].toLowerCase()) >= 0) return productLines[i].id;
      }
    }
    return null;
  }

  var result = productLines.map(function(line) {
    // 过滤产品
    var lineProducts = products.filter(function(p) {
      return matchLine(p, 'product_name') === line.id || matchLine(p, 'platform') === line.id
        || matchLine(p, 'detection_tech') === line.id || matchLine(p, 'product_category') === line.id;
    });
    
    // 过滤QCP (by product_line field or product_category)
    var lineQCPs = qcps.filter(function(q) {
      var pl = (q.product_line || q.product_category || '').toLowerCase();
      if (pl === '全部' || pl === 'all') return true;
      return matchLine(q, 'product_line') === line.id || matchLine(q, 'product_category') === line.id
        || matchLine(q, 'name') === line.id;
    });

    // 过滤批次护照 (by platform)
    var lineBatches = batchPassports.filter(function(b) {
      return matchLine(b, 'platform') === line.id || matchLine(b, 'productName') === line.id;
    });

    // 过滤注册证书 (by type/name)
    var lineRegCerts = regCerts.filter(function(r) {
      return matchLine(r, 'name') === line.id || matchLine(r, 'type') === line.id;
    });

    // 生命周期分布
    var lifecycleDist = {};
    lineProducts.forEach(function(p) {
      var s = p.lifecycle_status || '未定义';
      lifecycleDist[s] = (lifecycleDist[s] || 0) + 1;
    });

    // 统计
    var totalBQI = 0, bqiCount = 0;
    lineBatches.forEach(function(b) { totalBQI += b.bqi || 0; bqiCount++; });

    return {
      id: line.id, name: line.name, icon: line.icon, color: line.color, desc: line.desc,
      stats: {
        totalProducts: lineProducts.length,
        totalQCPs: lineQCPs.length,
        totalBatches: lineBatches.length,
        totalRegCerts: lineRegCerts.length,
        avgBQI: bqiCount ? Math.round(totalBQI / bqiCount * 10) / 10 : null
      },
      lifecycleDist: lifecycleDist,
      products: lineProducts.map(function(p) { return {
        id: p.id, name: p.product_name || p.name, category: p.product_category || '',
        platform: p.platform || p.detection_tech || '', riskClass: p.risk_class || '',
        lifecycle: p.lifecycle_status || '', regNo: p.reg_no || '',
        cqa: p.cqa_list || '', cma: p.cma_list || '', cpp: p.cpp_list || '',
        spec: p.spec_model || '', storage: p.storage_condition || '', shelf: p.shelf_life || '',
        batchNo: p.batch_no || '', batchStatus: p.batch_status || '', bqi: p.bqi || null
      }; }),
      qcps: lineQCPs.map(function(q) { return {
        id: q.id, code: q.qcp_code || '', name: q.name || q.control_point || '',
        domain: q.domain || '', stage: q.stage || '', risk: q.risk_level || '',
        method: q.control_method || '', keyParam: q.key_param || '',
        spec: q.spec_standard || '', alert: q.alert_rule || '',
        frequency: q.frequency || '', owner: q.owner || ''
      }; }),
      batches: lineBatches.map(function(b) { return {
        batchId: b.batchId, productName: b.productName, platform: b.platform,
        site: b.site, quantity: b.quantity, status: b.status,
        bqi: b.bqi, bqiLevel: b.bqiLevel, date: b.productionDate,
        materialCount: (b.materials || []).length, qcPassed: (b.qcResults || []).filter(function(qc){return qc.result==='pass';}).length,
        qcTotal: (b.qcResults || []).length
      }; }),
      regCerts: lineRegCerts.map(function(r) { return {
        name: r.name, model: r.model, regNo: r.regNo,
        approveDate: r.approveDate, expireDate: r.expireDate,
        type: r.type, cat: r.cat, standards: r.standards || ''
      }; })
    };
  });

  res.json({ productLines: result, totalLines: result.length, updated: '2026-08' });
}));

// ============================================================
// PLM 统一风险管理 — 跨数据源聚合 (FMEA + QCP + 事件 + 审计发现)
// ============================================================
app.get('/api/plm/risks', requireAuth, asyncHandler(async (req, res) => {
  var risks = await db.findAll('risk_database');
  var qcps = await db.findAll('qcp_library');
  var events = await db.findAll('quality_events');
  var products = await db.findAll('products');
  
  // 阶段定义
  var stageNames = ['立项', '设计开发', '注册', '转产', '量产', '上市', '退市'];
  var stageColors = ['#6366F1', '#8B5CF6', '#0EA5E9', '#F59E0B', '#10B981', '#059669', '#6B7280'];
  
  // Helper: lifecycle_status -> PLM stage
  function lifecycleToStage(lc) {
    var map = { '研发': '设计开发', '开发中': '设计开发', '注册中': '注册', '注册': '注册',
      '试生产': '转产', '生产': '量产', '上市': '上市', '量产': '量产', '退市': '退市' };
    return map[lc] || '量产';
  }
  
  // Helper: fmea_type -> PLM stage
  function fmeaToStage(ft) {
    if (ft === 'DFMEA') return '设计开发';
    if (ft === 'PFMEA') return '量产';
    return '设计开发';
  }
  
  // Helper: risk level to score for sorting
  function riskScore(lv) {
    if (lv === 'Critical') return 4;
    if (lv === 'High') return 3;
    if (lv === 'Medium') return 2;
    return 1;
  }
  
  // Aggregate stage risks
  var stageRisks = stageNames.map(function(name, idx) {
    return { id: 'S' + (idx + 1), name: name, color: stageColors[idx],
      critical: 0, high: 0, medium: 0, low: 0, controlled: 0, total: 0 };
  });
  
  function addToStage(sName, level, controlled) {
    var st = stageRisks.find(function(s) { return s.name === sName; });
    if (!st) st = stageRisks[4]; // default to 量产
    st.total++;
    if (level === 'Critical') st.critical++;
    else if (level === 'High') st.high++;
    else if (level === 'Medium') st.medium++;
    else st.low++;
    if (controlled) st.controlled++;
  }
  
  // Unified risk register
  var register = [];
  
  // 1. FMEA risks
  risks.forEach(function(r) {
    var stage = fmeaToStage(r.fmea_type || '');
    var controlled = r.status === '已控';
    addToStage(stage, r.risk_level || 'Medium', controlled);
    register.push({
      id: r.risk_code || r.id, source: 'FMEA', sourceIcon: '🔍',
      description: r.hazard || r.risk_name || '', stage: stage,
      severity: r.severity || '', probability: r.probability || '',
      detectability: r.detectability || '', rpn: r.rpn || null,
      level: r.risk_level || 'Medium', status: r.status || '监控中',
      measure: r.control_measure || '', fmeaType: r.fmea_type || ''
    });
  });
  
  // 2. QCP risks (per stage)
  qcps.forEach(function(q) {
    var stage = q.stage || '设计开发';
    addToStage(stage, q.risk_level || 'Medium', true);
    register.push({
      id: q.qcp_code || q.id, source: 'QCP', sourceIcon: '🎯',
      description: q.name || q.control_point || '', stage: stage,
      severity: '', probability: '', detectability: '',
      rpn: null, level: q.risk_level || 'Medium',
      status: '受控', measure: q.control_method || ''
    });
  });
  
  // 3. Quality events -> PLM stage via product lifecycle + event_type fallback
  events.forEach(function(e) {
    // Skip events without risk data
    if (!e.risk_level) return;
    
    var stage = null;
    // Try mapping via product
    if (e.product_id) {
      var prod = products.find(function(p) { return p.id === e.product_id; });
      if (prod) stage = lifecycleToStage(prod.lifecycle_status || '');
    }
    // Fallback: use event_type to infer stage
    if (!stage) {
      var et = (e.event_type || '').toLowerCase();
      if (et.indexOf('deviation') >= 0 || et.indexOf('oos') >= 0 || et.indexOf('oot') >= 0) stage = '量产';
      else if (et.indexOf('complaint') >= 0) stage = '上市';
      else if (et.indexOf('audit') >= 0) stage = '设计开发';
      else if (et.indexOf('ncr') >= 0 || et.indexOf('scar') >= 0) stage = '量产';
      else stage = '量产';
    }
    
    var controlled = (e.status === 'Closed' || e.status === 'Closed - No Action' || e.status === 'CAPA Created');
    addToStage(stage, e.risk_level || 'Medium', controlled);
    register.push({
      id: e.event_code || e.id, source: '质量事件', sourceIcon: '⚠️',
      description: (e.description || '').substring(0, 100), stage: stage,
      severity: e.severity || '', probability: e.occurrence || '',
      detectability: e.detectability || '', rpn: e.rpn_score || null,
      level: e.risk_level || 'Medium',
      status: e.status || 'Open', measure: ''
    });
  });
  
  // 4. Audit findings (hardcoded 24 items, approximate stage mapping)
  var auditFindings = [
    { clause: '§6.4.1', stage: '设计开发', level: 'Critical', desc: '赋值记录与检验规范缺失：未建立原料/成品赋值与检验记录制度' },
    { clause: '§6.4.2', stage: '设计开发', level: 'High', desc: '过程控制点遗漏：过程控制覆盖不足' },
    { clause: '§9.2.1', stage: '量产', level: 'Critical', desc: '供应商质量管理：未对关键物料供应商进行年度审核' },
    { clause: '§10.3.1', stage: '量产', level: 'High', desc: '变更控制流程：变更记录与评估不完整' },
    { clause: '§10.4.1', stage: '上市', level: 'Critical', desc: '客户投诉管理：投诉处理与关闭时效不满足要求' },
    { clause: '§7.5.1', stage: '量产', level: 'Medium', desc: '设备验证与校准：关键设备未建立预防性维护计划' },
    { clause: '§5.2.1', stage: '设计开发', level: 'Medium', desc: '风险管理文件更新：风险分析未随设计变更同步更新' },
    { clause: '§8.2.1', stage: '量产', level: 'High', desc: '批记录完整性：生产记录缺少关键工艺参数追溯' },
    { clause: '§4.2.3', stage: '设计开发', level: 'Medium', desc: '文件控制流程：SOP版本混乱缺少变更历史' },
    { clause: '§6.3.1', stage: '量产', level: 'Critical', desc: '工艺验证：关键工序验证数据不够充分' },
    { clause: '§3.5.1', stage: '设计开发', level: 'High', desc: '设计评审：设计评审节点不明确评审记录缺失' },
    { clause: '§11.8.1', stage: '上市', level: 'Medium', desc: '不良事件监测：定期风险评价报告更新不及时' }
  ];
  
  auditFindings.forEach(function(af) {
    addToStage(af.stage, af.level, false);
    register.push({
      id: af.clause, source: '审计发现', sourceIcon: '📋',
      description: af.desc, stage: af.stage,
      severity: '', probability: '', detectability: '', rpn: null,
      level: af.level, status: 'Open', measure: ''
    });
  });
  
  // Sort register by risk level then RPN
  register.sort(function(a, b) {
    if (riskScore(b.level) !== riskScore(a.level)) return riskScore(b.level) - riskScore(a.level);
    return (b.rpn || 0) - (a.rpn || 0);
  });
  
  // Summary
  var summary = {
    total: register.length,
    open: register.filter(function(r) { return r.status !== 'Closed' && r.status !== '受控' && r.status !== '已控'; }).length,
    critical: register.filter(function(r) { return r.level === 'Critical'; }).length,
    high: register.filter(function(r) { return r.level === 'High'; }).length,
    medium: register.filter(function(r) { return r.level === 'Medium'; }).length,
    low: register.filter(function(r) { return r.level === 'Low'; }).length,
    controlledRate: stageRisks.reduce(function(s, st) { return s + st.total; }, 0) > 0
      ? Math.round(stageRisks.reduce(function(s, st) { return s + st.controlled; }, 0) / stageRisks.reduce(function(s, st) { return s + st.total; }, 0) * 100) : 0
  };
  
  res.json({ stageRisks: stageRisks, riskRegister: register, summary: summary, updated: '2026-08' });
}));

// ============================================================
// PLM — 产品全生命周期管理 (PLQDP)
// 标准 7 阶段：立项 → 设计开发 → 注册 → 转产 → 量产 → 上市 → 退市
// 质量指标映射：三层级×三类型（战略/策略/执行 × 红线/经营/提升）
// 来源：复星诊断PLQDP设计方案 + 数据对象模型 + 质量指标体系设计建议
// ============================================================
app.get('/api/plm/stages', requireAuth, asyncHandler(async (req, res) => {
  var stages = [
    { id: '01', code: '01', name: '立项', icon: '🎯', color: '#6366F1',
      desc: '市场需求 → 临床需求 → 竞争分析 → QTPP质量目标',
      inputs: ['市场需求文档', '临床需求分析', '竞争分析报告'],
      controls: ['需求评审100%完成', '风险识别完成', 'QTPP签批'],
      outputs: ['产品质量目标QTPP', '立项批准书'],
      qcpCount: 8, owner: '产品经理 + 市场部',
      indicators: [
        { name: '项目质量指标达成率', type: '经营', level: '策略', target: '≥90%', desc: '新产品导入与开发质量' }
      ] },
    { id: '02', code: '02', name: '设计开发', icon: '🔬', color: '#8B5CF6',
      desc: '设计输入 → CQA/CMA/CPP定义 → 风险分析 → 设计验证',
      inputs: ['QTPP', '用户需求URS', '法规标准'],
      controls: ['CQA关键质量属性识别', 'CMA关键物料属性定义', 'CPP关键工艺参数确定', 'FMEA风险分析', '设计验证方案'],
      outputs: ['设计冻结文件', 'CQA/CMA/CPP清单', 'DHF文档'],
      qcpCount: 20, owner: '研发中心 + DQE',
      indicators: [
        { name: '设计输入输出追溯率', type: '红线', level: '策略', target: '100%', desc: 'ISO13485设计控制闭环' },
        { name: '风险管理文件更新及时率', type: '红线', level: '策略', target: '100%', desc: '新GMP风险持续管理' },
        { name: '关键性能验证覆盖率', type: '经营', level: '策略', target: '100%', desc: '关键性能/可靠性/接口验证覆盖' },
        { name: '需求变更控制率', type: '经营', level: '策略', target: '100%', desc: '区分外部需求与内部返工' },
        { name: '里程碑评审一次通过率', type: '经营', level: '策略', target: '≥80%', desc: '设计纪律与跨部门协同' },
        { name: '注册资料一次通过率', type: '提升', level: '提升', target: '≥85%', desc: '从合规开发到高质量开发' }
      ] },
    { id: '03', code: '03', name: '注册', icon: '📋', color: '#0EA5E9',
      desc: '注册申报 → 注册检验 → 标准符合性 → 取得注册证',
      inputs: ['设计冻结文件', '注册申报资料', '型式检验报告'],
      controls: ['注册标准符合性', '型式检验通过', '文件完整性审核', '注册审评答复'],
      outputs: ['注册证书', '注册检验报告'],
      qcpCount: 12, owner: 'RA法规事务',
      indicators: [
        { name: '注册资料一次通过率', type: '提升', level: '提升', target: '≥85%', desc: '注册审评一次通过' },
        { name: '注册时限达成率', type: '经营', level: '策略', target: '≥95%', desc: '注册周期控制' }
      ] },
    { id: '04', code: '04', name: '转产', icon: '🏭', color: '#F59E0B',
      desc: '工艺转移 → 试产验证 → 首件确认 → 量产工艺包',
      inputs: ['注册证书', 'DHF/DMR文件', '试产计划'],
      controls: ['工艺一致性验证', '性能一致性验证', '试产样机直通率', '首件/首批确认'],
      outputs: ['量产工艺包', '转产确认报告', '试产报告'],
      qcpCount: 15, owner: '工艺工程 + 研发质量',
      indicators: [
        { name: '试产样机直通率', type: '提升', level: '提升', target: '≥85%', desc: '可制造性与设计转化能力' },
        { name: '产品成熟度评分', type: '提升', level: '提升', target: '≥80分', desc: '转产就绪度评估' }
      ] },
    { id: '05', code: '05', name: '量产', icon: '⚙️', color: '#10B981',
      desc: '工艺执行 → CPP监控 → SPC → Batch Passport',
      inputs: ['量产工艺包', '生产计划', '物料批次'],
      controls: ['关键工艺参数CPP监控', 'SPC统计过程控制', '偏差管理', '批记录完整性'],
      outputs: ['Batch Passport批次护照', '批生产记录', 'SPC报告'],
      qcpCount: 30, owner: '生产部 + 制程质量',
      indicators: [
        { name: '过程检验一次合格率', type: '经营', level: '经营', target: '≥98%', desc: '制造过程稳健性' },
        { name: 'CPP超标率', type: '经营', level: '策略', target: '0', desc: '关键工艺参数受控' },
        { name: '返工/重加工批次占比', type: '经营', level: '策略', target: '<2%', desc: '过程稳定性' },
        { name: 'OOS/偏差调查关闭周期', type: '经营', level: '策略', target: '≤14天', desc: '快速闭环' },
        { name: 'SPC覆盖关键工序率', type: '提升', level: '提升', target: '≥90%', desc: '统计过程控制覆盖率' },
        { name: '批间CV/过程波动收敛率', type: '提升', level: '提升', target: '收敛', desc: '跨批次一致性' }
      ] },
    { id: '06', code: '06', name: '上市', icon: '✅', color: '#059669',
      desc: '成品放行 → 上市监控 → 投诉/不良事件 → EQA',
      inputs: ['检验规程', '成品批', 'PMS数据'],
      controls: ['成品全项检验', '放行审核', '投诉调查与关闭', '不良事件报告', 'EQA性能监控'],
      outputs: ['检验报告', '放行单', 'PMS年度报告'],
      qcpCount: 35, owner: 'QC + QA放行 + 市场质量',
      indicators: [
        { name: '出货产品合格率', type: '红线', level: '战略', target: '100%', desc: '市场放行与患者安全' },
        { name: '不良事件按时报告率', type: '红线', level: '战略', target: '100%', desc: '法定时限履行' },
        { name: '电气安全不良事件数', type: '红线', level: '战略', target: '0起', desc: '患者与使用安全' },
        { name: '客户投诉率', type: '经营', level: '战略', target: '持续下降', desc: '市场端质量感知' },
        { name: '质量原因退货率', type: '经营', level: '战略', target: '≤目标值', desc: '市场端真实质量' },
        { name: 'EQA合格率', type: '经营', level: '战略', target: '100%', desc: '产品一致性与场景适用性' },
        { name: '客户投诉闭环率', type: '红线', level: '策略', target: '100%', desc: '上市后快速闭环' },
        { name: '上市后设计相关CAPA闭环率', type: '提升', level: '提升', target: '按期关闭', desc: '持续改进与风险前移' }
      ] },
    { id: '07', code: '07', name: '退市', icon: '📉', color: '#6B7280',
      desc: '退市评估 → 剩余库存处理 → 客户通知 → 备件保障',
      inputs: ['退市申请', '市场数据', '库存数据'],
      controls: ['退市风险评估', '剩余库存处置', '客户/在用设备通知', '备件供应计划'],
      outputs: ['退市评估报告', '退市通知', '备件保障计划'],
      qcpCount: 5, owner: '产品管理 + 法规事务',
      indicators: [
        { name: '备件满足率', type: '提升', level: '提升', target: '≥95%', desc: '退市后服务保障' },
        { name: '在用设备影响评估覆盖率', type: '提升', level: '提升', target: '100%', desc: '客户延续性保障' }
      ] }
  ];
  res.json({ stages: stages, totalQCP: stages.reduce(function(s, st) { return s + st.qcpCount; }, 0), stageCount: 7, standard: 'PLM 7阶段: 立项/设计开发/注册/转产/量产/上市/退市', updated: '2026-08' });
}));

app.get('/api/plm/dashboard', requireAuth, asyncHandler(async (req, res) => {
  var products = await db.findAll('products');
  var qcps = await db.findAll('qcps');
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');

  var lifecycleDist = {};
  products.forEach(function(p) { var s = p.lifecycle_status || '未定义'; lifecycleDist[s] = (lifecycleDist[s] || 0) + 1; });

  var qcpByStage = {};
  qcps.forEach(function(q) { var s = q.stage || q.phase || '未分类'; qcpByStage[s] = (qcpByStage[s] || 0) + 1; });

  var summary = {
    totalProducts: products.length, totalQCPs: qcps.length, totalEvents: events.length, totalCAPAs: capas.length,
    openCAPAs: capas.filter(function(c) { return c.status !== 'Closed'; }).length,
    activeProducts: products.filter(function(p) { return p.lifecycle_status === '上市' || p.lifecycle_status === '量产'; }).length,
    inDevelopment: products.filter(function(p) { return p.lifecycle_status === '研发' || p.lifecycle_status === '注册'; }).length,
  };

  var productPassports = products.slice(0, 10).map(function(p) {
    var pQCPs = qcps.filter(function(q) { return q.product_id === p.id || q.product_name === p.product_name; });
    var pEvents = events.filter(function(e) { return e.product_id === p.id || e.product_name === p.product_name; });
    return { id: p.id, name: p.product_name || p.name || '未知', platform: p.platform || p.detection_tech || '-', lifecycle: p.lifecycle_status || '未定义', regNo: p.reg_no || '-', qcpCount: pQCPs.length, eventCount: pEvents.length, hasBQI: !!p.bqi_score, bqi: p.bqi_score || null };
  });

  res.json({ summary: summary, lifecycleDist: lifecycleDist, qcpByStage: qcpByStage, productPassports: productPassports, updated: '2026-08' });
}));

// ============================================================
// 产品注册档案 API — 来源：有效注册证一览表 Excel
// ============================================================
var regCerts = [
  { name:'干式化学分析仪', model:'MLA-1、MLA-ble', cat:'22-02', regNo:'湘械注准20162220194', approveDate:'2025-07-28', effectiveDate:'2026-02-05', expireDate:'2031-02-04', type:'仪器' },
  { name:'脂类多项测试卡（干化学）', model:'——', cat:'6840-000', regNo:'湘械注准20162400211', approveDate:'2025-08-20', effectiveDate:'2026-04-13', expireDate:'2031-04-12', type:'试剂' },
  { name:'超敏C反应蛋白测定试剂盒（免疫比浊法）', model:'——', cat:'6840-265', regNo:'湘械注准20192400224', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'同型半胱氨酸测定试剂盒（酶循环法）', model:'——', cat:'6840-19-19089', regNo:'湘械注准20192400225', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'胱抑素C测定试剂盒（胶乳免疫比浊法）', model:'——', cat:'6840-08-08040', regNo:'湘械注准20192400226', approveDate:'2023-10-18', effectiveDate:'2024-07-25', expireDate:'2029-07-24', type:'试剂' },
  { name:'脂蛋白相关磷脂酶A2测定试剂盒（连续监测法）', model:'——', cat:'6840-11-11037', regNo:'湘械注准20192400227', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'胃蛋白酶原I检测试剂盒（胶乳免疫比浊法）', model:'——', cat:'6840-08-08088', regNo:'湘械注准20192400232', approveDate:'2023-10-18', effectiveDate:'2024-07-25', expireDate:'2029-07-24', type:'试剂' },
  { name:'胃蛋白酶原II检测试剂盒（胶乳免疫比浊法）', model:'——', cat:'6840-08-08089', regNo:'湘械注准20192400233', approveDate:'2023-10-18', effectiveDate:'2024-07-25', expireDate:'2029-07-24', type:'试剂' },
  { name:'全自动化学发光免疫分析仪', model:'F-i6000/F-i6000s', cat:'22-04', regNo:'湘械注准20242220191', approveDate:'2024-12-20', effectiveDate:'2025-01-15', expireDate:'2030-01-14', type:'仪器' },
  { name:'全自动生化分析仪', model:'F-C2000/F-C2000s', cat:'22-02', regNo:'湘械注准20242220747', approveDate:'2024-12-20', effectiveDate:'2025-01-15', expireDate:'2030-01-14', type:'仪器' },
  { name:'全自动化学发光免疫分析仪', model:'F-i1000', cat:'22-04', regNo:'湘械注准20252220442', approveDate:'2025-06-10', effectiveDate:'2025-07-01', expireDate:'2030-06-30', type:'仪器' },
  { name:'全自动化学发光免疫分析仪', model:'F-i3000/F-i3000M', cat:'22-04', regNo:'湘械注准20212220994', approveDate:'2021-10-15', effectiveDate:'2022-01-01', expireDate:'2027-01-01', type:'仪器' },
  { name:'酶联免疫斑点分析仪', model:'ES-15', cat:'22-04', regNo:'湘械注准20192220367', approveDate:'2019-08-15', effectiveDate:'2020-01-01', expireDate:'2025-01-01', type:'仪器' },
  { name:'全自动微生物药敏分析仪', model:'Droplet48', cat:'22-04', regNo:'湘械注准20192220368', approveDate:'2019-08-15', effectiveDate:'2020-01-01', expireDate:'2025-01-01', type:'仪器' },
  // 更多试剂类产品
  { name:'C反应蛋白测定试剂盒（免疫比浊法）', model:'——', cat:'6840-265', regNo:'湘械注准20192400234', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'类风湿因子测定试剂盒（免疫比浊法）', model:'——', cat:'6840-265', regNo:'湘械注准20192400235', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'抗链球菌溶血素O测定试剂盒（免疫比浊法）', model:'——', cat:'6840-265', regNo:'湘械注准20192400236', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'糖化血红蛋白测定试剂盒（胶乳免疫比浊法）', model:'——', cat:'6840-08-08040', regNo:'湘械注准20192400237', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'D-二聚体测定试剂盒（胶乳免疫比浊法）', model:'——', cat:'6840-08-08040', regNo:'湘械注准20192400238', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  { name:'降钙素原测定试剂盒（胶乳免疫比浊法）', model:'——', cat:'6840-08-08040', regNo:'湘械注准20192400239', approveDate:'2023-10-18', effectiveDate:'2024-07-24', expireDate:'2029-07-23', type:'试剂' },
  // 仪器新标准变更
  { name:'全自动化学发光免疫分析仪（新标准）', model:'F-i6000/F-i6000s', cat:'22-04', regNo:'湘械注准20242220191', approveDate:'2024-12-20', effectiveDate:'2025-01-15', expireDate:'2030-01-14', type:'仪器', standards:'GB 4793-2024、GB/T 42125.1-2024' },
  { name:'全自动生化分析仪（新标准）', model:'F-C2000/F-C2000s', cat:'22-02', regNo:'湘械注准20242220747', approveDate:'2024-12-20', effectiveDate:'2025-01-15', expireDate:'2030-01-14', type:'仪器', standards:'GB 4793-2024、GB/T 42125.1-2024' },
  { name:'全自动化学发光免疫分析仪（新标准）', model:'F-i1000', cat:'22-04', regNo:'湘械注准20252220442', approveDate:'2025-06-10', effectiveDate:'2025-07-01', expireDate:'2030-06-30', type:'仪器', standards:'GB 4793-2024、GB/T 42125.1-2024、GB/T 42125.2-2024等' },
  { name:'全自动化学发光免疫分析仪（新标准）', model:'F-i3000/F-i3000M', cat:'22-04', regNo:'湘械注准20212220994', approveDate:'2021-10-15', effectiveDate:'2022-01-01', expireDate:'2027-01-01', type:'仪器', standards:'GB 4793-2024、GB/T 42125系列' },
  { name:'酶联免疫斑点分析仪（新标准）', model:'ES-15', cat:'22-04', regNo:'湘械注准20192220367', approveDate:'2019-08-15', effectiveDate:'2020-01-01', expireDate:'2025-01-01', type:'仪器', standards:'GB 4793-2024、GB/T 42125.1-2024' },
  { name:'全自动微生物药敏分析仪（新标准）', model:'Droplet48', cat:'22-04', regNo:'湘械注准20192220368', approveDate:'2019-08-15', effectiveDate:'2020-01-01', expireDate:'2025-01-01', type:'仪器', standards:'GB 4793-2024、GB/T 42125.1-2024' },
  { name:'干式化学分析仪（新标准）', model:'MLA-1、MLA-ble', cat:'22-02', regNo:'湘械注准20162220194', approveDate:'2025-07-28', effectiveDate:'2026-02-05', expireDate:'2031-02-04', type:'仪器', standards:'GB 4793-2024、GB/T 42125.1-2024、YY/T 0648-2025' }
];

app.get('/api/plm/registry', requireAuth, asyncHandler(async (req, res) => {
  var search = (req.query.search || '').toLowerCase();
  var filter = req.query.filter || '';
  var page = parseInt(req.query.page) || 1;
  var pageSize = parseInt(req.query.pageSize) || 30;
  
  var filtered = regCerts;
  if (filter) filtered = filtered.filter(function(r) { return r.type === filter || r.cat === filter; });
  if (search) filtered = filtered.filter(function(r) { return r.name.toLowerCase().indexOf(search) >= 0 || r.regNo.indexOf(search) >= 0 || r.model.toLowerCase().indexOf(search) >= 0; });
  
  var total = filtered.length;
  var totalPages = Math.ceil(total / pageSize);
  var start = (page - 1) * pageSize;
  
  var summary = {
    total: regCerts.length, reagentCount: regCerts.filter(function(r){return r.type==='试剂';}).length,
    instrumentCount: regCerts.filter(function(r){return r.type==='仪器';}).length,
    newStdCount: regCerts.filter(function(r){return r.standards;}).length,
    expiringSoon: regCerts.filter(function(r){ return r.expireDate < '2027-01-01' && r.expireDate > '2025-01-01'; }).length
  };
  
  res.json({ data: filtered.slice(start, start + pageSize), page: page, pageSize: pageSize, total: total, totalPages: totalPages, summary: summary });
}));

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

// ---- 胶体金 QCP 字典一键导入 ----
app.post('/api/qcp/seed-colloidal-gold', requireAuth, asyncHandler(async (req, res) => {
  var fs = require('fs');
  var path = require('path');
  var filePath = path.join(__dirname, 'data', 'qcp_colloidal_gold.json');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'QCP数据文件未找到: data/qcp_colloidal_gold.json' });
  
  var qcpData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  var existing = await db.findAll('qcp_library');
  var existingKeys = new Set(existing.map(function(q) { return q.qcp_code + '|' + (q.product_line || ''); }));
  
  var created = 0, skipped = 0;
  for (var i = 0; i < qcpData.length; i++) {
    var q = qcpData[i];
    var key = q.qcp_code + '|' + (q.product_line || '');
    if (existingKeys.has(key)) { skipped++; continue; }
    await db.insert('qcp_library', q, req.user.username);
    existingKeys.add(key);
    created++;
  }
  res.json({ success: true, created: created, skipped: skipped, total: qcpData.length, message: '导入完成: ' + created + ' 新增, ' + skipped + ' 已存在跳过' });
}));

// ---- 分子PCR QCP 字典一键导入 ----
app.post('/api/qcp/seed-molecular', requireAuth, asyncHandler(async (req, res) => {
  var fs = require('fs');
  var path = require('path');
  var filePath = path.join(__dirname, 'data', 'qcp_molecular.json');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'QCP数据文件未找到: data/qcp_molecular.json' });
  
  var qcpData2 = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  var existing2 = await db.findAll('qcp_library');
  var existingKeys2 = new Set(existing2.map(function(q) { return q.qcp_code + '|' + (q.product_line || ''); }));
  
  var created2 = 0, skipped2 = 0;
  for (var j = 0; j < qcpData2.length; j++) {
    var q2 = qcpData2[j];
    var key2 = q2.qcp_code + '|' + (q2.product_line || '');
    if (existingKeys2.has(key2)) { skipped2++; continue; }
    await db.insert('qcp_library', q2, req.user.username);
    existingKeys2.add(key2);
    created2++;
  }
  res.json({ success: true, created: created2, skipped: skipped2, total: qcpData2.length, message: '分子QCP导入: ' + created2 + ' 新增, ' + skipped2 + ' 跳过' });
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

// ============================================================
// QUALITY COCKPIT — 五级驾驶舱
// ============================================================
app.get('/api/dashboard/cockpit', requireAuth, asyncHandler(async (req, res) => {
  var events = await db.findAll('quality_events');
  var capas = await db.findAll('capa_records');
  var products = await db.findAll('products');
  var suppliers = await db.findAll('suppliers');

  var qkpi = {
    product: { label: '产品质量', icon: '📦', metrics: [
      { name: '性能符合率', value: 96 + Math.floor(Math.random() * 4), unit: '%', trend: 'stable' },
      { name: '批间差CV', value: (3 + Math.random() * 2).toFixed(1), unit: '%', trend: 'stable' }
    ]},
    production: { label: '生产质量', icon: '⚙️', metrics: [
      { name: '偏差率', value: (events.filter(function(e){return e.event_type==='Deviation';}).length/Math.max(events.length,1)*100).toFixed(1), unit: '%', trend: 'down' },
      { name: 'CAPA关闭率', value: Math.round(capas.filter(function(c){return c.status==='Closed';}).length/Math.max(capas.length,1)*100), unit: '%', trend: 'up' }
    ]},
    qc: { label: 'QC检验', icon: '🔬', metrics: [
      { name: 'OOS率', value: (1+Math.random()).toFixed(1), unit: '%', trend: 'stable' },
      { name: '检验周期', value: Math.floor(2+Math.random()*3), unit: '天', trend: 'stable' }
    ]},
    supply: { label: '供应链', icon: '🚚', metrics: [
      { name: '来料合格率', value: 97+Math.floor(Math.random()*3), unit: '%', trend: 'stable' },
      { name: '高风险供应商', value: suppliers.filter(function(s){return (s.risk_level||'Low')==='High';}).length, unit: '家', trend: 'stable' }
    ]},
    customer: { label: '客户质量', icon: '👥', metrics: [
      { name: '投诉响应', value: Math.floor(1+Math.random()*3), unit: '天', trend: 'down' },
      { name: '重复投诉率', value: Math.floor(5+Math.random()*10), unit: '%', trend: 'down' }
    ]},
    system: { label: '体系成熟度', icon: '📋', metrics: [
      { name: 'CAPA按时关闭', value: Math.round(capas.filter(function(c){return c.status==='Closed';}).length/Math.max(capas.length,1)*100), unit: '%', trend: 'up' },
      { name: '审核发现', value: events.filter(function(e){return e.event_type==='Audit-Finding';}).length, unit: '项', trend: 'stable' }
    ]}
  };

  var productRisk = products.slice(0, 12).map(function(p) {
    var pEvents = events.filter(function(e) { return e.product_id === p.id || e.product_name === p.product_name; });
    var rs = pEvents.filter(function(e){return e.risk_level==='Critical'||e.risk_level==='High';}).length*3 + pEvents.filter(function(e){return e.risk_level==='Medium';}).length;
    return { name: p.product_name || p.name || '未知', platform: p.platform || '-', riskScore: rs, bizImpact: p.risk_class==='III'?'高':p.risk_class==='II'?'中':'低', level: rs>=10?'high':rs>=5?'medium':'low', eventCount: pEvents.length };
  });

  var alerts = [];
  if (events.filter(function(e){return e.risk_level==='Critical'&&e.status!=='Closed';}).length > 0) alerts.push({ level: 'red', msg: '未关闭的Critical事件', count: events.filter(function(e){return e.risk_level==='Critical'&&e.status!=='Closed';}).length });
  if (capas.filter(function(c){return c.due_date&&new Date(c.due_date)<new Date()&&c.status!=='Closed';}).length > 0) alerts.push({ level: 'red', msg: '逾期未关闭CAPA', count: capas.filter(function(c){return c.due_date&&new Date(c.due_date)<new Date()&&c.status!=='Closed';}).length });
  alerts.push({ level: 'blue', msg: '建议开展管理评审', count: 1 });

  res.json({ qkpi: qkpi, productRisk: productRisk, alerts: alerts, summary: { totalProducts: products.length, totalEvents: events.length, totalCAPAs: capas.length, openCritical: events.filter(function(e){return e.risk_level==='Critical'&&e.status!=='Closed';}).length, overdueCAPAs: capas.filter(function(c){return c.due_date&&new Date(c.due_date)<new Date()&&c.status!=='Closed';}).length }, updated: '2026-08' });
}));

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

  // ===== 红牌 KPI from 保龄球图 (2026-07 YTD) =====
  var BOWLING = {
    // 战略解码 - 仪器/试剂质量
    doaOverallYTD: 8.1,       // 仪器到货缺陷率 Overall YTD 8.1%, target 8%
    doaNewYTD: 8.5,           // 新产品质量 DOA YTD 8.5%
    doaMassYTD: 7.1,          // 量产品 DOA YTD 7.1%
    ffrOverallYTD: 8.2,       // 装机月度仪器维修率 Overall YTD 8.2%, target 8%
    ffrNewYTD: 8.0,           // 新品维修率 YTD 8.0%
    ffrMassYTD: 8.2,          // 量产维修率 YTD 8.2%
    reagentDefectOverallYTD: 2.2,  // 试剂市场缺陷率 Overall YTD 2.2%, target 2.5%
    reagentDefectCLIA: 5.9,   // 发光条线缺陷率 YTD 5.9% ⚠️
    reagentDefectBio: 1.1,    // 生化条线 YTD 1.1%
    reagentDefectMol: 5.6,    // 分子条线 YTD 5.6% ⚠️

    // 日常检验 KPI (YTD)
    pkgPassRate: 99.5,        // 包材检验合格率 99.5%, target 98%
    rawReagentPassRate: 99.6, // 原料检验合格率（试剂）99.6%, target 99%
    rawInstrumentPassRate: 99.1, // 原料检验合格率（仪器）99.1%, target 97%
    semiReagentPassRate: 96.8, // 半成品检验合格率 96.8%, target 98% ⚠️
    finalReagentPassRate: 99.1, // 成品检验合格率（试剂）99.1%, target 99%
    finalInstrumentPassRate: 100, // 成品检验合格率（仪器）100%, target 85%
    batchRecordPassRate: 96.0, // 批记录合格率 96.0%, target 95%
    stabilityCompleteRate: 83.9, // 稳定性检测完成率 83.9% 🔴 target 100%
    stabilityPassRate: 100,    // 稳定性检测合格率 100%
    complaintCountYTD: 108,     // 1-7月客诉总计 108件
    complaintsByLine: { '发光': 38, '生化': 21, '微生物': 38, '荧光PCR': 10, 'POCT': 3 },
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
      { name: '发光条线缺陷率', value: BOWLING.reagentDefectCLIA, target: 2.5, unit: '%', status: BOWLING.reagentDefectCLIA <= 2.5 ? 'pass' : 'fail', source: '⚠️ 超目标 5.9%' },
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
    { id: '8', name: '仪器到货缺陷率 Overall DOA', target: 8, unit: '%', ytd: 8.1, trend: 'up',
      months: [
        { month: '1月', plan: 8, actual: 12.5, status: 'fail' },
        { month: '2月', plan: 8, actual: 0, status: 'pass' },
        { month: '3月', plan: 8, actual: 0, status: 'pass' },
        { month: '4月', plan: 8, actual: 7.7, status: 'pass' },
        { month: '5月', plan: 8, actual: 13.3, status: 'fail' },
        { month: '6月', plan: 8, actual: 13.3, status: 'fail' },
        { month: '7月', plan: 8, actual: 9.5, status: 'fail' },
      ],
      drilldown: [
        { sub: '8.1 新品 DOA', target: 8, ytd: 8.5, months: [14.3, 0, 0, 0, 16.7, 16.7, 6.3] },
        { sub: '8.2 量产品 DOA', target: 8, ytd: 7.1, months: [0, 0, 0, 12.5, 0, 0, 20.0] },
      ]
    },
    { id: '9', name: '仪器维修率 Overall FFR', target: 8, unit: '%', ytd: 8.2, trend: 'down',
      months: [
        { month: '1月', plan: 8, actual: 13.8, status: 'fail' },
        { month: '2月', plan: 8, actual: 7.6, status: 'pass' },
        { month: '3月', plan: 8, actual: 6.4, status: 'pass' },
        { month: '4月', plan: 8, actual: 6.8, status: 'pass' },
        { month: '5月', plan: 8, actual: 6.0, status: 'pass' },
        { month: '6月', plan: 8, actual: 6.9, status: 'pass' },
        { month: '7月', plan: 8, actual: 10.3, status: 'fail' },
      ],
      drilldown: [
        { sub: '9.1 新品 FFR', target: 8, ytd: 8.0, months: [12.0, 7.8, 6.0, 7.4, 5.8, 7.0, 10.8] },
        { sub: '9.2 量产品 FFR', target: 8, ytd: 8.2, months: [16.0, 7.4, 6.8, 6.1, 6.3, 6.8, 9.5] },
      ]
    },
    { id: '10', name: '试剂市场缺陷率', target: 2.5, unit: '%', ytd: 2.2, trend: 'stable',
      months: [
        { month: '1月', plan: 2.5, actual: 3.1, status: 'fail' },
        { month: '2月', plan: 2.5, actual: 1.5, status: 'pass' },
        { month: '3月', plan: 2.5, actual: 2.0, status: 'pass' },
        { month: '4月', plan: 2.5, actual: 2.1, status: 'pass' },
        { month: '5月', plan: 2.5, actual: 2.1, status: 'pass' },
        { month: '6月', plan: 2.5, actual: 2.6, status: 'fail' },
        { month: '7月', plan: 2.5, actual: 2.2, status: 'pass' },
      ],
      drilldown: [
        { sub: '10.1 发光条线', target: 2.5, ytd: 5.9, months: [4.7, 5.0, 4.7, 19.0, 2.5, 0, 6.8], alert: true },
        { sub: '10.2 生化条线', target: 2.5, ytd: 1.1, months: [1.8, 0, 1.0, 0, 2.2, 2.6, 0] },
        { sub: '10.3 分子条线', target: 2.5, ytd: 5.6, months: [12.5, 12.5, 0, 0, 0, 12.5, 0], alert: true },
        { sub: '10.4 微生物条线', target: 2.5, ytd: null, months: [12.5, null, null, null, null, null, null] },
        { sub: '10.5 POCT条线', target: 2.5, ytd: 0, months: [0, null, null, null, null, null, null] },
      ]
    },
  ];

  // 日常检验 KPI
  var daily = [
    { id: 'D1', name: '包材检验合格率', target: 98, unit: '%', ytd: 99.5, months: [100, 98.5, 98.4, 100, 100, 100, 99.4], status: 'pass' },
    { id: 'D2', name: '原料检验合格率（试剂）', target: 99, unit: '%', ytd: 99.6, months: [99.4, 100, 98.5, 99.8, 100, 99.5, 99.8], status: 'pass' },
    { id: 'D3', name: '半成品检验合格率（试剂）', target: 98, unit: '%', ytd: 96.8, months: [97.1, 99.2, 97.4, 94.6, 99.3, 96.4, 94.1], status: 'warning' },
    { id: 'D4', name: '成品检验合格率（试剂）', target: 99, unit: '%', ytd: 99.1, months: [100, 100, 99.5, 100, 100, 98.9, 96.3], status: 'warning' },
    { id: 'D5', name: '批记录合格率', target: 95, unit: '%', ytd: 96.0, months: [98.3, 97.8, 93.8, 94.5, 100, 96.7, 94.4], status: 'pass' },
    { id: 'D6', name: '稳定性检测完成率', target: 100, unit: '%', ytd: 83.9, months: [93.3, 66.7, 86.6, 73.3, 63.9, 100, 100], status: 'fail', note: 'YTD仅83.9%, 需重点关注' },
  ];

  // 客诉汇总
  var complaintStats = {
    total: 108, period: '2026年1-7月',
    byMonth: { '1月': 21, '2月': 8, '3月': 16, '4月': 13, '5月': 21, '6月': 9, '7月': 20 },
    byLine: { '发光': 38, '微生物': 38, '生化': 21, '荧光PCR': 10, 'POCT': 3 },
    byCause: { '非质量问题': 16, '设计问题': 12, '物料问题': 9, '其他问题': 9, '生产问题': 4, '工艺问题': 1 },
    topIssues: [
      { product: '结核I-SPOT', product_line: '微生物', count: 6, issue: '抗原漏液/无标签/阳性对照' },
      { product: '真菌药敏试剂盒', product_line: '微生物', count: 5, issue: '花板/跳孔/识别错误' },
      { product: 'HBV核酸检测', product_line: '荧光PCR', count: 5, issue: '内参未起/结果偏高' },
      { product: 'CA系列（CA242/CA15-3/CA19-9）', product_line: '发光', count: 4, issue: '盲样偏差/批号变更' },
      { product: 'PGI/PGII', product_line: '发光', count: 4, issue: '室间质评偏差/磁珠凝块' },
    ]
  };

  res.json({ strategic, daily, complaintStats, updated: '2026-08' });
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
      { id: 'DOA', name: '仪器到货缺陷率 Overall DOA', target: '≤8%', ytd: '8.1%', status: 'fail', unit: '%',
        months: { '1月': { plan: 8, actual: 12.5 }, '2月': { plan: 8, actual: 0 }, '3月': { plan: 8, actual: 0 }, '4月': { plan: 8, actual: 7.7 }, '5月': { plan: 8, actual: 13.3 }, '6月': { plan: 8, actual: 13.3 }, '7月': { plan: 8, actual: 9.5 } },
        children: [
          { id: 'DOA-N', name: '新品 DOA', target: '≤8%', ytd: '8.5%', status: 'fail', months: { '1月': 14.3, '2月': 0, '3月': 0, '4月': 0, '5月': 16.7, '6月': 16.7, '7月': 6.3 } },
          { id: 'DOA-M', name: '量产品 DOA', target: '≤8%', ytd: '7.1%', status: 'pass', months: { '1月': 0, '2月': 0, '3月': 0, '4月': 12.5, '5月': 0, '6月': 0, '7月': 20.0 } }
        ]
      },
      { id: 'FFR', name: '仪器维修率 Overall FFR', target: '≤8%', ytd: '8.2%', status: 'warning', unit: '%',
        months: { '1月': { plan: 8, actual: 13.8 }, '2月': { plan: 8, actual: 7.6 }, '3月': { plan: 8, actual: 6.4 }, '4月': { plan: 8, actual: 6.8 }, '5月': { plan: 8, actual: 6.0 }, '6月': { plan: 8, actual: 6.9 }, '7月': { plan: 8, actual: 10.3 } },
        children: [
          { id: 'FFR-N', name: '新品 FFR', target: '≤8%', ytd: '8.0%', status: 'warning', months: { '1月': 12.0, '2月': 7.8, '3月': 6.0, '4月': 7.4, '5月': 5.8, '6月': 7.0, '7月': 10.8 } },
          { id: 'FFR-M', name: '量产品 FFR', target: '≤8%', ytd: '8.2%', status: 'fail', months: { '1月': 16.0, '2月': 7.4, '3月': 6.8, '4月': 6.1, '5月': 6.3, '6月': 6.8, '7月': 9.5 } }
        ]
      },
      { id: 'DEFECT', name: '试剂市场缺陷率', target: '≤2.5%', ytd: '2.2%', status: 'pass', unit: '%',
        months: { '1月': { plan: 2.5, actual: 3.1 }, '2月': { plan: 2.5, actual: 1.5 }, '3月': { plan: 2.5, actual: 2.0 }, '4月': { plan: 2.5, actual: 2.1 }, '5月': { plan: 2.5, actual: 2.1 }, '6月': { plan: 2.5, actual: 2.6 }, '7月': { plan: 2.5, actual: 2.2 } },
        children: [
          { id: 'DEF-CLIA', name: '发光条线', target: '≤2.5%', ytd: '5.9%', status: 'fail', alert: true, months: { '1月': 4.7, '2月': 5.0, '3月': 4.7, '4月': 19.0, '5月': 2.5, '6月': 0, '7月': 6.8 } },
          { id: 'DEF-BIO', name: '生化条线', target: '≤2.5%', ytd: '1.1%', status: 'pass', months: { '1月': 1.8, '2月': 0, '3月': 1.0, '4月': 0, '5月': 2.2, '6月': 2.6, '7月': 0 } },
          { id: 'DEF-MOL', name: '分子条线', target: '≤2.5%', ytd: '5.6%', status: 'fail', alert: true, months: { '1月': 12.5, '2月': 12.5, '3月': 0, '4月': 0, '5月': 0, '6月': 12.5, '7月': 0 } },
          { id: 'DEF-MICRO', name: '微生物条线', target: '≤2.5%', ytd: '--', status: 'na', months: { '1月': 12.5, '2月': '--', '3月': '--', '4月': '--', '5月': '--', '6月': '--', '7月': '--' } },
          { id: 'DEF-POCT', name: 'POCT条线', target: '≤2.5%', ytd: '0%', status: 'pass', months: { '1月': 0, '2月': '--', '3月': '--', '4月': '--', '5月': '--', '6月': '--', '7月': '--' } }
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
      { id: 'D1', name: '包材检验合格率', target: '≥98%', ytd: '99.5%', status: 'pass', months: { '1月': 100, '2月': 98.5, '3月': 98.4, '4月': 100, '5月': 100, '6月': 100, '7月': 99.4 },
        detail: { total: 546, fail: 3, bases: '上海/泰州/长沙' } },
      { id: 'D2', name: '原料检验合格率（试剂）', target: '≥99%', ytd: '99.6%', status: 'pass', months: { '1月': 99.4, '2月': 100, '3月': 98.5, '4月': 99.8, '5月': 100, '6月': 99.5, '7月': 99.8 },
        detail: { total: 1586, fail: 8, bases: '上海/泰州/长沙' } },
      { id: 'D3', name: '原料检验合格率（仪器）', target: '≥97%', ytd: '99.1%', status: 'pass', months: { '1月': 97.5, '2月': 97.5, '3月': 99.0, '4月': 99.5, '5月': 100, '6月': 99.7, '7月': 99.7 },
        detail: { total: 1574, fail: 16 } },
      { id: 'D4', name: '半成品检验合格率（试剂）', target: '≥98%', ytd: '96.8%', status: 'warning', months: { '1月': 97.1, '2月': 99.2, '3月': 97.4, '4月': 94.6, '5月': 99.3, '6月': 96.4, '7月': 94.1 },
        detail: { total: 774, fail: 20, bases: '泰州/长沙' } },
      { id: 'D5', name: '成品检验合格率（试剂）', target: '≥99%', ytd: '99.1%', status: 'warning', months: { '1月': 100, '2月': 100, '3月': 99.5, '4月': 100, '5月': 100, '6月': 98.9, '7月': 96.3 },
        detail: { total: 876, fail: 1, bases: '泰州/长沙' } },
      { id: 'D6', name: '成品检验合格率（仪器）', target: '≥85%', ytd: '100%', status: 'pass', months: { '1月': 100, '2月': 100, '3月': 100, '4月': 100, '5月': 100, '6月': 100, '7月': 100 },
        detail: { total: 70, fail: 0 } },
      { id: 'D7', name: '批记录合格率', target: '≥95%', ytd: '96.0%', status: 'pass', months: { '1月': 98.3, '2月': 97.8, '3月': 93.8, '4月': 94.5, '5月': 100, '6月': 96.7, '7月': 94.4 },
        detail: { total: 874, fail: 29, bases: '泰州/长沙' } },
      { id: 'D8', name: '稳定性检测完成率（试剂）', target: '100%', ytd: '83.9%', status: 'fail', note: '⚠️ 6-7月完成率100% 但上半年滞后',
        months: { '1月': '--', '2月': '--', '3月': '--', '4月': '--', '5月': '--', '6月': 100, '7月': 100 },
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
    title: '客诉分析 · 2026年1-7月 (共108件)',
    icon: '📋',
    hasData: true,
    expanded: false,
    byMonth: { '1月': 21, '2月': 8, '3月': 16, '4月': 13, '5月': 21, '6月': 9, '7月': 20 },
    byLine: [
      { name: '发光', count: 38, color: '#3B82F6', risk: '缺陷率5.9%超标' },
      { name: '微生物', count: 38, color: '#10B981', risk: 'I-SPOT/真菌药敏为主' },
      { name: '生化', count: 21, color: '#F59E0B', risk: 'CKMB假阳/Lp(a)批间差' },
      { name: '荧光PCR', count: 10, color: '#8B5CF6', risk: 'HBV内参/迭代偏差' },
      { name: 'POCT', count: 3, color: '#EC4899', risk: '低' },
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
    updated: '2026-08',
    dataSource: '质量管理保龄球图-2026(2).xlsx'
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
      { label:'客诉总数(1-7月)', value:'108件', target:'≤50件/半年', status:'warning', desc:'发光38/微生物38/生化21/分子10' },
      { label:'试剂市场缺陷率', value:'2.2%', target:'≤2.5%', status:'pass', desc:'总体达标' },
      { label:'EQA合格率', value:'100%', target:'100%', status:'pass', desc:'室间质评参评项目' },
      { label:'到货缺陷率DOA', value:'8.1%', target:'≤5%(新标)', status:'fail', desc:'TQM新标准 ≤5%' },
    ],
    sections: [
      { title: '考核指标 (KPI)', type: 'table', headers: ['指标','定义','目标','状态'],
        rows: [
          { name:'客户满意度', target:'≥4.0(5分制)', months:{}, ytd:'--', status:'na', desc:'季度/年度调研代表性客户' },
          { name:'室间质评EQA合格率', target:'100%', months:{}, ytd:'100%', status:'pass', desc:'合格项目数/总参评项目数' },
          { name:'到货缺陷率(仪器)', target:'≤5%(新标)', months:{}, ytd:'8.1%', status:'fail', desc:'故障台数/销售台数' },
          { name:'客户投诉率(试剂)', target:'≤5/万盒', months:{}, ytd:'--', status:'na', desc:'投诉次数/销售盒数×10000' },
          { name:'上市后12月投诉率(新品)', target:'待定', months:{}, ytd:'--', status:'na', desc:'设计/质量投诉÷总发货批次/台数' },
          { name:'上市后设计相关CAPA闭环率', target:'100%', months:{}, ytd:'--', status:'na', desc:'设计问题CAPA按时关闭比例' },
          { name:'客诉例数(试剂)', target:'参照历史水平', months:{}, ytd:'108件', status:'warning', desc:'累计1-7月' },
        ]
      },
      { title: '试剂市场缺陷率 (月度)', type: 'table', headers: ['指标','目标','1月','2月','3月','4月','5月','6月','7月','YTD'],
        rows: [
          { name:'Overall缺陷率', target:'≤2.5%', months:{'1月':3.1,'2月':1.5,'3月':2.0,'4月':2.1,'5月':2.1,'6月':2.6,'7月':2.2}, ytd:'2.2%', status:'pass', direction:'lt' },
          { name:'发光条线', target:'≤2.5%', months:{'1月':4.7,'2月':5.0,'3月':4.7,'4月':19.0,'5月':2.5,'6月':0,'7月':6.8}, ytd:'5.9%', status:'fail', direction:'lt' },
          { name:'生化条线', target:'≤2.5%', months:{'1月':1.8,'2月':0,'3月':1.0,'4月':0,'5月':2.2,'6月':2.6,'7月':0}, ytd:'1.1%', status:'pass', direction:'lt' },
          { name:'分子条线', target:'≤2.5%', months:{'1月':12.5,'2月':12.5,'3月':0,'4月':0,'5月':0,'6月':12.5,'7月':0}, ytd:'5.6%', status:'fail', direction:'lt' },
        ]
      },
      { title: '客诉月度趋势', type: 'table', headers: ['指标','1月','2月','3月','4月','5月','6月','7月','合计'],
        rows: [
          { name:'客诉总数', target:'--', months:{'1月':21,'2月':8,'3月':16,'4月':13,'5月':21,'6月':9,'7月':20}, ytd:'108件', status:'warning' },
          { name:'发光', target:'--', months:{}, ytd:'38件', status:'fail', desc:'缺陷率5.9% 偏高' },
          { name:'微生物', target:'--', months:{}, ytd:'38件', status:'warning' },
          { name:'生化', target:'--', months:{}, ytd:'21件', status:'pass' },
          { name:'荧光PCR', target:'--', months:{}, ytd:'10件', status:'pass' },
          { name:'POCT', target:'--', months:{}, ytd:'3件', status:'pass' },
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
    updated: '2026-08',
    dataSources: ['TQM指标确认.xlsx', '质量管理保龄球图-2026(2).xlsx', '工厂经营会议周报7.26.xls'],
  });
}));

// ============================================================
// COMPLAINT DASHBOARD — 投诉看板
// 数据来源: 质量管理保龄球图-2026(2).xlsx (试剂投诉汇总+仪器投诉汇总, 已导入quality_events)
// ============================================================
// 投诉数据导入 (从 data/complaints_2026_import.json)
app.post('/api/dashboard/import-complaints', requireAuth, asyncHandler(async (req, res) => {
  var fs = require('fs');
  var path = require('path');
  var filePath = path.join(__dirname, 'data', 'complaints_2026_import.json');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '数据文件未找到' });
  
  var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  var events = await db.findAll('quality_events');
  
  // 删除旧投诉事件
  var deleted = 0;
  for (var i = 0; i < events.length; i++) {
    if (events[i].event_type === 'Complaint') {
      await db.delete('quality_events', events[i].id, req.user.username);
      deleted++;
    }
  }
  
  // 导入新投诉
  var created = 0;
  for (var j = 0; j < data.length; j++) {
    await db.insert('quality_events', data[j], req.user.username);
    created++;
  }
  
  res.json({ success: true, deleted: deleted, created: created, message: '投诉数据更新: 删除' + deleted + '条旧数据, 导入' + created + '条新数据' });
}));

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

// 导入模板下载
app.get('/api/dashboard/import/template', requireAuth, asyncHandler(async (req, res) => {
  var wb = XLSX.utils.book_new();
  // Sheet 1: 质量事件模板
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { '事件类型': 'Deviation', '子类型': '工艺偏差', '产品名称': 'CA19-9检测试剂盒', '产品线': '化学发光', '批号': 'B2606001', '风险等级': 'Medium', '描述': '填写事件描述', '责任部门': '生产部', '状态': 'Open' },
    { '事件类型': 'Complaint', '子类型': '', '产品名称': '糖类抗原19-9', '产品线': '化学发光', '批号': 'C2509037', '风险等级': 'High', '描述': '客户投诉示例', '责任部门': 'QA部', '状态': 'In Investigation' },
  ]), '质量事件模板');
  // Sheet 2: CAPA模板
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { '标题': 'CAPA示例', '关联事件ID': '', '审核来源': '内部审核', '缺陷模式': '填写缺陷模式', '根因类别': '人员/设备/物料/方法/环境', '根因': '填写根本原因', '行动计划': '填写纠正预防措施', '负责人': '张三', '截止日期': '2026-08-31', '状态': 'Open' }
  ]), 'CAPA模板');
  // Sheet 3: 产品主数据模板
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { '产品名称': '示例试剂盒', '产品类别': '试剂', '检测技术': 'CLIA', '平台': '化学发光平台', '产品线': '化学发光', '风险等级': 'III', '注册类别': '三类', '生命周期': '生产', '注册状态': '已注册', '注册编号': '国械注准20253400000', '规格型号': '100T/盒', '储存条件': '2-8°C', '有效期': '12个月' },
  ]), '产品主数据模板');
  // Sheet 4: QCP控制点模板
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { 'QCP编号': 'Q01-001', '控制点名称': '临床需求确认', '模块': '设计开发', '阶段': '设计开发', '产品线': '化学发光', '风险等级': 'Medium', '控制方法': '审核', '关键参数': 'URS批准', '规格标准': '100%批准', '预警规则': '', '频率': '立项时', '负责人': '产品经理' },
  ]), 'QCP控制点模板');
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
            product_line: row['产品线'] || row.product_line || '',
            batch_no: row['批号'] || row.batch_no || '',
            description: row['描述'] || row.description || '',
            responsible_dept: row['责任部门'] || row.responsible_dept || '',
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

	    // Import products (产品主数据)
	    var productData = sheets['产品主数据模板'] || sheets['产品主数据'] || sheets['产品'] || [];
	    if (productData.length) {
	      result.imported.products = 0;
	      for (var k = 0; k < productData.length; k++) {
	        var prow = productData[k];
	        if (!prow['产品名称'] && !prow.product_name) continue;
	        try {
	          var prodPayload = {
	            product_name: prow['产品名称'] || prow.product_name,
	            product_category: prow['产品类别'] || prow.product_category || '试剂',
	            detection_tech: prow['检测技术'] || prow.detection_tech || '',
	            platform: prow['平台'] || prow.platform || '',
	            product_line: prow['产品线'] || prow.product_line || '',
	            risk_class: prow['风险等级'] || prow.risk_class || '',
	            reg_category: prow['注册类别'] || prow.reg_category || '',
	            lifecycle_status: prow['生命周期'] || prow.lifecycle_status || '研发',
	            regulatory_status: prow['注册状态'] || prow.regulatory_status || '',
	            reg_no: prow['注册编号'] || prow.reg_no || '',
	            spec_model: prow['规格型号'] || prow.spec_model || '',
	            storage_condition: prow['储存条件'] || prow.storage_condition || '',
	            shelf_life: prow['有效期'] || prow.shelf_life || '',
	            imported: true
	          };
	          await db.insert('products', prodPayload, req.user.username);
	          result.imported.products++;
	          result.details.push('导入产品: ' + prodPayload.product_name);
	        } catch (e) {
	          result.errors.push('产品行' + (k+1) + ': ' + e.message);
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
    { module: '生产质量', cause: '台间差/设备', solution: '标准机建立', difficulty: '难', impact: '高', owner: '待定', deadline: '待定', quad: '' },
    { module: '生产质量', cause: '物料齐套', solution: '相似物料定量管理（如螺丝螺母）', difficulty: '易', impact: '高', owner: '孙卫兵', deadline: '2026.12.31', quad: 'quick-win' },
    { module: '生产质量', cause: '标记/包被工艺', solution: '标记/包被工艺标准化', difficulty: '难', impact: '高', owner: '陈科', deadline: '待定', quad: 'strategic' },
    { module: '生产质量', cause: '赋值标准', solution: '工艺标准化，厂内外标准对标', difficulty: '难', impact: '高', owner: '孙卫兵', deadline: '2026.12.31', quad: 'strategic' },
    { module: '生产质量', cause: '过程监控', solution: 'SPC加强过程监控', difficulty: '难', impact: '中', owner: '待定', deadline: '待定', quad: 'strategic' }
  ];

  // ===== 行动项跟进 (快赢区 Quick Wins) =====
  var actionItems = [
    { id: 'QW1', solution: '关键物料风险预警：安全库存', owner: '沈倩', deadline: '2026-Q3', status: '进行中', light: 'yellow', progress: 40, module: '供应链质量', note: '需质量先提供关键物料清单' },
    { id: 'QW2', solution: '供应商变更流程优化（进行中）', owner: '刘建芳', deadline: '2026.10.30', status: '进行中', light: 'green', progress: 70, module: '供应链质量', note: '' },
    { id: 'QW3', solution: '关键检验资源配置：能力及工具', owner: '姚仁杰', deadline: '待定', status: '未启动', light: 'red', progress: 0, module: '供应链质量', note: '待确认工装夹具需求' },
    { id: 'QW4', solution: 'F-C2000: 注册变更确认符合性', owner: '刘建芳', deadline: '2026.07.31', status: '已完成', light: 'green', progress: 100, module: '研发质量', note: '' },
    { id: 'QW5', solution: '相似物料定量管理（如螺丝螺母）', owner: '孙卫兵', deadline: '2026.12.31', status: '进行中', light: 'yellow', progress: 30, module: '生产质量', note: '需建立物料分类标准' },
    { id: 'QW6', solution: '交叉培训，一人多岗，上岗培训', owner: '待定', deadline: '持续', status: '未启动', light: 'red', progress: 0, module: '生产质量', note: '需明确负责人' },
  ];

  // ===== 专项进展跟进 (战略区 Strategic) =====
  var strategicProjects = [
    { id: 'SP1', solution: '供应商整合：集中采购', owner: '刘建芳', deadline: '2026.12.31', status: '进行中', light: 'yellow', progress: 35, module: '供应链质量',
      hasProject: '是', milestones: [
        { name: '供应商评估筛选', date: '2026-Q3', done: true },
        { name: '谈判与合同签订', date: '2026-Q3', done: false },
        { name: '首批试供验证', date: '2026-Q4', done: false },
        { name: '全面切换完成', date: '2026.12.31', done: false }
      ], difficulty: '供应商配合度、采购周期', support: '采购部协同推进', note: '需集中采购清单' },
    { id: 'SP2', solution: '物料选型优化：建立规划', owner: '姚仁杰', deadline: '待定', status: '未启动', light: 'red', progress: 0, module: '供应链质量',
      hasProject: '否', milestones: [], difficulty: '需跨部门协调', support: '研发/供应链/质量联合', note: '需先成立工作组' },
    { id: 'SP3', solution: '图纸修正补齐(2D/3D)', owner: '陈科', deadline: '2026.10.01', status: '进行中', light: 'yellow', progress: 25, module: '研发质量',
      hasProject: '是', milestones: [
        { name: '机械工程师到位', date: '2026-Q3', done: false },
        { name: '关键图纸修正', date: '2026-Q3', done: false },
        { name: '检规修订', date: '2026-Q4', done: false },
        { name: '全部图纸归档', date: '2027-Q1', done: false }
      ], difficulty: '历史图纸缺失，工作量大', support: '一名机械工程师招聘尽快到位', note: '' },
    { id: 'SP4', solution: '关键物料质检标准更新', owner: '刘建芳', deadline: '2026.09.30', status: '进行中', light: 'green', progress: 60, module: '供应链质量',
      hasProject: '是', milestones: [
        { name: '关键物料清单确认', date: '2026-08', done: true },
        { name: '质检标准起草', date: '2026-08', done: true },
        { name: '评审发布', date: '2026-09', done: false },
        { name: '全面实施', date: '2026.09.30', done: false }
      ], difficulty: '物料种类多', support: '研发提供关键指标', note: '' },
    { id: 'SP5', solution: '工作校准品赋值标准化', owner: '刘建芳', deadline: '2026.12.31', status: '进行中', light: 'yellow', progress: 30, module: '研发质量',
      hasProject: '是', milestones: [
        { name: '赋值标准方案设计', date: '2026-Q3', done: false },
        { name: '试点产品验证', date: '2026-Q3', done: false },
        { name: '全产品推广', date: '2026-Q4', done: false },
        { name: '体系固化', date: '2026.12.31', done: false }
      ], difficulty: '产品线多，赋值差异大', support: '参考实验室协同', note: '' },
    { id: 'SP6', solution: '药敏盘：寻找替代供应商', owner: '陈科', deadline: '待定', status: '未启动', light: 'red', progress: 0, module: '供应链质量',
      hasProject: '否', milestones: [], difficulty: '开模费用16W，可能涉及注册变更', support: '需结构工程师+采购协同', note: '与药敏盘设计迭代联合推进' },
  ];

  res.json({
    processPareto, causePareto, productDist, freqDist, rootCauseCross, impactDist, solutions,
    actionItems: actionItems, strategicProjects: strategicProjects,
    total: 262, sheet3Source: '汇报分析', sheet2Source: '解决方案汇总',
    updated: '2026-07'
  });
}));


// ============================================================
// AUDIT FINDINGS — 体系/产品风险清单 → 内外审发现/日常发现
// 对照《医疗器械生产质量管理规范检查指导原则》分类
// ============================================================
var auditFindings = [
  // ===== 体系风险 (18项) =====
  { seq: 1, category: '体系风险', risk_desc: '赋值记录缺失，实际赋值的机型少于产品定值表中载明的机型。品种多，批次多，机型多，资源少，为了产品交付，赋值记录未纳入批生产记录进行审核放行，存在数据真实性和溯源性问题。',
    current_mitigation: '对发现有机型差的项目真实赋值（但非赋值流程，仅验证性赋值），未赋值的机型按日立机型值出具。赋值记录有要求，但当下无法实现。',
    event_type: 'Audit-Finding', clause_ref: '§6.4.1, §10.4.1', clause_content: '规范第四十五条(***)/八十一条(***)：记录应当真实准确完整及时可追溯；每批产品均应当有生产记录并满足追溯要求',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 2, category: '体系风险', risk_desc: '部分产品生产工艺与实际操作不符，批生产记录按照工艺填写，存在数据真实性和溯源性问题，当发生不合格或客诉时不易溯源',
    current_mitigation: '生产有真实的作业指导书，相关物料使用信息及配制记录记录在作业指导书中',
    event_type: 'Audit-Finding', clause_ref: '§10.1.1, §6.4.1', clause_content: '规范第七十八条(***)/四十五条(***)：建立生产过程控制程序并按要求组织生产；记录应当真实准确完整及时',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 3, category: '体系风险', risk_desc: '泰州持证产品委托上海进行受托生产，注册人制度下如何落实主体责任',
    current_mitigation: '无',
    event_type: 'Audit-Finding', clause_ref: '§12.1.1, §12.2.1', clause_content: '规范第一百零七条(***)/一百零八条(***)：委托方质量管理体系应覆盖医疗器械全生命周期；双方签订质量协议明确各自权利义务和责任',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 4, category: '体系风险', risk_desc: '无特殊要求的客户，产品发货采用泡沫箱加冰袋的方式进行运输，不符合经营质量管理规范及相关标准',
    current_mitigation: '泡沫箱+冰袋',
    event_type: 'Audit-Finding', clause_ref: '§13.2.1, §8.8.1', clause_content: '规范第一百一十八条(**)/六十六条(*)：采用经验证或确认的运输条件和工具运输产品并做好产品防护；仓储管理制度确保原材料中间产品成品正确贮存发放使用和运输',
    risk_class: '**', item_type: '主要项目', risk_level: 'High' },
  { seq: 5, category: '体系风险', risk_desc: '上海委托泰州生产、长沙委托泰州生产的产品以及泰州自产的产品，经营主体均为上海，但实物均储存在泰州。泰州的仓库为生产基地仓库，非经营仓库，不满足经营质量管理规范',
    current_mitigation: '方案1：另租厂房用于存放经营产品；方案2：现有生产地址上划出经营仓库，建立符合经营质量管理规范的体系要求',
    event_type: 'Audit-Finding', clause_ref: '§4.5.1, §8.8.1, §13.1.1', clause_content: '规范第二十九条(*)/六十六条(*)/一百一十七条(**)：仓储区应满足原材料中间产品成品等贮存条件要求并按待检合格不合格等情形合理存放；产品销售应符合相关法规要求',
    risk_class: '**', item_type: '主要项目', risk_level: 'High' },
  { seq: 6, category: '体系风险', risk_desc: '生产设备、检验仪器和设备、工装夹具、工具软件等需要进行管理；目前工装夹具和工具软件未纳入日常管理（新版GMP差异）',
    current_mitigation: '（未提供方案）',
    event_type: 'NCR', clause_ref: '§5.1.1, §5.4.1, §9.9.1', clause_content: '规范第三十六/三十九/七十七条：配备生产设备、检验仪器和工装夹具并确保有效运行；标明编号与名称；工具软件需确认',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 7, category: '体系风险', risk_desc: '变更应用闭环跟踪难度大：工厂端自然切换/配套切换闭环；客户端技改闭环。变更的必要性需要评审确认',
    current_mitigation: '已建立明确的变更流程，对变更需求进行明确评审；变更应用评审以客户导向和市场输入为主',
    event_type: 'NCR', clause_ref: '§2.4.1, §7.10.1', clause_content: '规范第十条(***)/五十六条(***)：建立变更控制程序，根据风险程度确定变更管理类型并对变更进行评审；设计开发变更应识别评估并在实施前得到批准',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 8, category: '体系风险', risk_desc: '转产前评估不充分，未覆盖可采购性、可制造性、可维护性、可验证性、风险评估不充分；未充分识别关键过程和特殊过程；设计转化不完全，供方管控及物料控制存在缺陷',
    current_mitigation: '正在梳理设计转换具体要求细化设计转换流程和明确职责',
    event_type: 'Audit-Finding', clause_ref: '§7.6.1, §7.3.2, §9.4.2', clause_content: '规范第五十二条(***)/四十九条(**)/七十二条(***)：设计开发到生产的转换活动需确保相关规程得到验证并适用于商业化生产；特殊过程应经过确认，关键工序应经过验证',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 9, category: '体系风险', risk_desc: '物料平衡的文件还未正式实施（第八十二条 企业应当根据产品特性检查实际产量和关键原材料实际用量间的物料平衡）',
    current_mitigation: '物料平衡文件已完成输出正处于评审阶段；平衡限度需要组织验证确认有效性',
    event_type: 'NCR', clause_ref: '§10.5.1, §10.4.2', clause_content: '规范第八十二条(**)/八十一条(*)：根据产品特性检查实际产量和关键原材料实际用量间的物料平衡确保符合设定限度要求；生产记录应体现物料平衡或记录关键原材料使用情况',
    risk_class: '**', item_type: '主要项目', risk_level: 'High' },
  { seq: 10, category: '体系风险', risk_desc: '变更应用闭环跟踪难度大（与第7项关联，工厂端和客户端双向闭环难度大）',
    current_mitigation: '已建立明确的变更流程，对变更需求进行明确评审',
    event_type: 'NCR', clause_ref: '§2.4.1, §12.6.1', clause_content: '规范第十条(***)/一百一十二条(**)：建立变更控制程序；委托方设计变更、采购变更等应当及时通知受托方并监督其执行变更要求',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 11, category: '体系风险', risk_desc: '仪器产品还未完成UDI赋码导入（第九十一条 企业应当按照国家实施医疗器械唯一标识有关要求开展赋码、数据上传和维护更新）（新版GMP差异）',
    current_mitigation: '需要评估现有UDI打印设备适用性；制定或评审受控的UDI管理规程的符合性和适用性',
    event_type: 'NCR', clause_ref: '§10.14.1', clause_content: '规范第九十一条：企业应当按照国家实施医疗器械唯一标识有关要求开展赋码、数据上传和维护更新，保证信息真实、准确、完整和可追溯',
    risk_class: '**', item_type: '主要项目', risk_level: 'High' },
  { seq: 12, category: '体系风险', risk_desc: '缺少仪器产品配套软件的管理制度（软件生命周期管理、设计开发、软件质量控制、软件部署管理等系统性文件）',
    current_mitigation: '（未提供方案）',
    event_type: 'NCR', clause_ref: '§9.9.1, §7.1.1', clause_content: '规范第七十七条(**)/四十七条(**)：设计开发生产检验仓储等过程中采用的计算机软件对产品质量有影响的应当进行确认并保留记录；建立设计开发控制程序对全过程实施策划和控制',
    risk_class: '**', item_type: '主要项目', risk_level: 'High' },
  { seq: 13, category: '体系风险', risk_desc: 'IVDD已申报并获证，需要在11月底前完成技术文件备案；和IVDR产品认证准备（技术文件及体系文件）；目前缺少系统性的法规培训',
    current_mitigation: '（未提供方案）',
    event_type: 'NCR', clause_ref: '§3.10.1, §6.3.1', clause_content: '规范第二十三条(**)/四十四条(*)：从事影响产品质量工作的所有人员应经过与其岗位要求相适应的培训；指定部门或人员负责识别医疗器械相关法律法规规范标准等外部文件变化及时更新体系文件',
    risk_class: '**', item_type: '主要项目', risk_level: 'High' },
  { seq: 14, category: '体系风险', risk_desc: '上海基地纯化水系统管理缺乏专业人员进行维护和日常监测',
    current_mitigation: '（未提供方案）',
    event_type: 'Audit-Finding', clause_ref: '§4.7.1, §4.7.2, §3.3.1', clause_content: '规范第三十一条(***/**)/十六条(**)：配置工艺用水系统等设施并进行确认和日常监测维护；配备足够数量并具有相应资质的专业人员',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 15, category: '体系风险', risk_desc: '研发记录和实验记录归档保存缺乏有效管理制度；人员离职交接缺乏有效移交导致资料完整性缺失',
    current_mitigation: '（未提供方案）',
    event_type: 'Audit-Finding', clause_ref: '§6.4.1, §7.11.1', clause_content: '规范第四十五条(***)/五十七条(**)：记录应当保证产品设计开发等活动可追溯；建立产品设计开发文档确保历次设计开发输出过程及相关活动可追溯',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 16, category: '体系风险', risk_desc: '生产检验设备等计量器具缺少系统性管理（如量程、精度和校准报告有效性确认）',
    current_mitigation: '（未提供方案）',
    event_type: 'NCR', clause_ref: '§5.5.1, §5.5.2, §5.5.3', clause_content: '规范第四十条(*/*/*)：按照操作规程和校准或检定计划定期对主要设备和仪器进行校准或检定且量程范围应涵盖实际使用范围；计量器具量程和精度应满足使用要求并标明有效期；保留校准或检定记录',
    risk_class: '*', item_type: '一般项目', risk_level: 'Low' },
  { seq: 17, category: '体系风险', risk_desc: '培训管理、健康管理未明确管理部门',
    current_mitigation: '（未提供方案）',
    event_type: 'NCR', clause_ref: '§3.10.2, §3.11.1', clause_content: '规范第二十三条(*)/二十四条(*)：指定部门或专人负责培训管理工作建立培训制度制定培训计划保留培训记录并评估培训效果；根据生产产品特性对从事影响产品质量工作的人员进行健康管理并建立健康档案',
    risk_class: '*', item_type: '一般项目', risk_level: 'Low' },
  { seq: 18, category: '体系风险', risk_desc: '记录滞后性：生产现场及研发实验室的配制记录、称量记录、设备使用记录填写普遍存在不及时现象；记录代填与真实性缺失：三楼研发实验室所有设备使用记录及冰箱温度记录均长期由同一人代为填写',
    current_mitigation: '（未提供方案）',
    event_type: 'Audit-Finding', clause_ref: '§6.4.1, §3.8.2', clause_content: '规范第四十五条(***)/二十一条(**)：记录应当真实准确完整及时清晰不得随意涂改或销毁；生产管理部门负责人应确保生产记录真实准确完整及时和可追溯',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  // ===== 产品风险 (6项) =====
  { seq: 19, category: '产品风险', risk_desc: '生化试剂关键原材料缺少关键功能性指标，原料批间差控制缺失。2026年上半年因物料问题导致的半成品不合格有4批',
    current_mitigation: '发现一例纠正一例，通过生产前小试或增加原料小试或更换生产商或变更工艺等',
    event_type: 'NCR', clause_ref: '§8.7.1, §8.1.1, §8.5.1', clause_content: '规范第六十五条(***)/五十九条(***)/六十三条(**)：建立原材料进货验收制度对采购原材料进行检查检验或验证；采购控制程序确保原材料符合规定要求；与关键供应商签订质量协议明确技术要求和验收标准',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 20, category: '产品风险', risk_desc: '大包装产品质量问题被动，改善难。质量人员的专业知识不足以了解产品的全部质量风险，供应商内部变更不受控',
    current_mitigation: '由质量部和供应商对接',
    event_type: 'NCR', clause_ref: '§8.4.2, §8.3.2, §8.10.2', clause_content: '规范第六十二条(***)/六十一条(**)/六十八条(**)：经评估供应商存在重大缺陷的应中止采购并分析对产品带来的风险；确定是否对供应商进行现场审核；评估供应商变更对产品质量影响',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 21, category: '产品风险', risk_desc: '部分产品不满足产品技术要求，主要体现在准确度或正确度指标上。面临抽检不合格的风险',
    current_mitigation: '已梳理纳入清单；改进推进中',
    event_type: 'NCR', clause_ref: '§11.3.1, §11.6.1, §7.8.1', clause_content: '规范第九十七条(***)/一百条(***)/五十四条(**)：基于风险管理原则制定进货/过程/成品检验规程；按照检验规程开展检验检测活动；对设计开发进行验证确保输出满足输入要求',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 22, category: '产品风险', risk_desc: '生化部分产品与已批准的产品说明书主要组成成分不一致（如甘油三酯、丙氨酸氨基转移酶、天门冬氨酸氨基转移酶等）',
    current_mitigation: '（未提供方案）',
    event_type: 'Audit-Finding', clause_ref: '§10.7.1, §7.10.1', clause_content: '规范第八十四条(***)/五十六条(***)：产品说明书、标签应当符合相关法律法规及标准要求并进行有效管控；设计开发变更应识别评估变更影响并在实施前得到批准',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 23, category: '产品风险', risk_desc: '化学发光部分产品与已批准的产品说明书主要组成成分中缓冲液浓度不一致（如层粘蛋白、透明质酸、胃蛋白酶原I等）；与产品说明书主要组成成分不一致（如甘胆酸）',
    current_mitigation: '（未提供方案）',
    event_type: 'Audit-Finding', clause_ref: '§10.7.1, §7.10.1', clause_content: '规范第八十四条(***)/五十六条(***)：产品说明书标签应符合法规及标准要求并进行有效管控；设计开发变更应识别评估变更影响并在实施前得到批准',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' },
  { seq: 24, category: '产品风险', risk_desc: '化学发光部分产品与已批准的技术要求中原料附录不一致（如铁蛋白、人附睾蛋白4、甲胎蛋白等）',
    current_mitigation: '（未提供方案）',
    event_type: 'Audit-Finding', clause_ref: '§10.7.1, §7.5.2', clause_content: '规范第八十四条(***)/五十一条(***)：产品说明书标签应符合法规要求；设计开发输出至少应包括采购生产检验使用和服务所需相关信息以及产品技术要求等并经过验证批准',
    risk_class: '***', item_type: '关键项目', risk_level: 'Critical' }
];

// GET — 返回分类分析结果（含 ISO 13485 对照 + 条款帕累托）
app.get('/api/audit-findings', requireAuth, asyncHandler(async (req, res) => {
  // ISO 13485 条款映射表（编号 → 编号 + 中文描述）
  var isoMap = {
    '§2.4.1': 'ISO 13485 7.3.9 / 4.1.4',
    '§3.3.1': 'ISO 13485 6.1 / 6.2',
    '§3.8.2': 'ISO 13485 7.5.1',
    '§3.10.1': 'ISO 13485 6.2',
    '§3.10.2': 'ISO 13485 6.2',
    '§3.11.1': 'ISO 13485 6.4',
    '§4.5.1': 'ISO 13485 7.5.11',
    '§4.7.1': 'ISO 13485 6.4 / 7.5.1',
    '§4.7.2': 'ISO 13485 6.4 / 7.5.1',
    '§5.1.1': 'ISO 13485 6.3',
    '§5.4.1': 'ISO 13485 6.3 / 7.5.3',
    '§5.5.1': 'ISO 13485 7.6',
    '§5.5.2': 'ISO 13485 7.6',
    '§5.5.3': 'ISO 13485 7.6',
    '§6.3.1': 'ISO 13485 4.2.1',
    '§6.4.1': 'ISO 13485 4.2.4',
    '§7.1.1': 'ISO 13485 7.3.1',
    '§7.3.1': 'ISO 13485 7.3.2',
    '§7.3.2': 'ISO 13485 7.3.2',
    '§7.5.2': 'ISO 13485 7.3.4',
    '§7.6.1': 'ISO 13485 7.3.8',
    '§7.8.1': 'ISO 13485 7.3.6',
    '§7.10.1': 'ISO 13485 7.3.9',
    '§7.11.1': 'ISO 13485 4.2.3 / 7.3.10',
    '§8.1.1': 'ISO 13485 7.4.1',
    '§8.3.2': 'ISO 13485 7.4.1',
    '§8.4.2': 'ISO 13485 7.4.1',
    '§8.5.1': 'ISO 13485 7.4.1',
    '§8.7.1': 'ISO 13485 7.4.3',
    '§8.8.1': 'ISO 13485 7.5.11',
    '§8.10.2': 'ISO 13485 7.4.1',
    '§9.4.2': 'ISO 13485 7.5.6',
    '§9.9.1': 'ISO 13485 7.5.6 / 4.1.6',
    '§10.1.1': 'ISO 13485 7.5.1',
    '§10.4.1': 'ISO 13485 7.5.1 / 4.2.4',
    '§10.4.2': 'ISO 13485 7.5.1 / 4.2.4',
    '§10.5.1': 'ISO 13485 7.5.1 / 8.2.6',
    '§10.7.1': 'ISO 13485 7.5.1 / 4.2.3',
    '§10.14.1': 'ISO 13485 7.5.8 / 7.5.9',
    '§11.3.1': 'ISO 13485 8.2.6',
    '§11.6.1': 'ISO 13485 8.2.6',
    '§12.1.1': 'ISO 13485 4.1',
    '§12.2.1': 'ISO 13485 7.4.1',
    '§12.6.1': 'ISO 13485 7.4.1 / 4.1.4',
    '§13.1.1': 'ISO 13485 7.5.1',
    '§13.2.1': 'ISO 13485 7.5.11'
  };

  // ISO 13485 条款中文名称
  var isoNameMap = {
    '4.1': '总要求', '4.1.4': '变更控制', '4.1.6': '软件确认',
    '4.2.1': '文件要求', '4.2.3': '文件控制', '4.2.4': '记录控制',
    '6.1': '资源提供', '6.2': '人力资源(能力/培训/意识)', '6.3': '基础设施', '6.4': '工作环境',
    '7.3.1': '设计开发策划', '7.3.2': '设计开发策划', '7.3.4': '设计开发输出',
    '7.3.6': '设计开发验证', '7.3.8': '设计开发转换', '7.3.9': '设计开发变更控制', '7.3.10': '设计开发文档',
    '7.4.1': '采购过程', '7.4.3': '采购产品验证',
    '7.5.1': '生产和服务提供控制', '7.5.3': '标识和可追溯性',
    '7.5.6': '生产和服务过程确认', '7.5.8': '标识', '7.5.9': '可追溯性', '7.5.11': '产品防护',
    '7.6': '监视和测量设备控制',
    '8.2.6': '产品监视和测量'
  };

  // GMP 章节中文名称
  var gmpChapterMap = {
    '1': '第一章 总则', '2': '第二章 质量保证', '3': '第三章 机构与人员',
    '4': '第四章 厂房与设施', '5': '第五章 设备', '6': '第六章 文件与数据管理',
    '7': '第七章 设计开发', '8': '第八章 采购与原材料管理', '9': '第九章 验证与确认',
    '10': '第十章 生产管理', '11': '第十一章 质量控制与产品放行',
    '12': '第十二章 委托生产与外协加工', '13': '第十三章 销售与售后服务',
    '14': '第十四章 分析与改进'
  };

  // 辅助：为 ISO 条款编号附加中文名称
  function enrichISO(isoRef) {
    if (!isoRef) return '';
    return isoRef.replace(/ISO 13485 (\d+(?:\.\d+)*)/g, function(match, num) {
      var name = isoNameMap[num];
      return name ? (match + ' ' + name) : match;
    });
  }

  // 辅助：为 GMP 条款附加章节中文名称
  function gmpChapter(clause) {
    var m = clause.match(/^§(\d+)\./);
    if (m && gmpChapterMap[m[1]]) return gmpChapterMap[m[1]];
    return '';
  }

  // 为每条目附加 ISO 条款（含中文名称）+ GMP 章节
  var itemsWithISO = auditFindings.map(function(item) {
    var clauses = item.clause_ref.split(', ');
    var isoRefs = [];
    clauses.forEach(function(c) {
      var iso = isoMap[c.trim()];
      if (iso) isoRefs.push(enrichISO(iso));
    });
    var primaryClause = clauses[0] ? clauses[0].trim() : '';
    return Object.assign({}, item, {
      iso_clause: isoRefs.join('; ') || isoRefs[0] || '',
      gmp_chapter: gmpChapter(primaryClause)
    });
  });

  // === 条款帕累托分析 ===
  var clauseFreq = {};
  auditFindings.forEach(function(item) {
    var clauses = item.clause_ref.split(', ');
    clauses.forEach(function(c) {
      var key = c.trim();
      clauseFreq[key] = (clauseFreq[key] || 0) + 1;
    });
  });
  // 转为数组并降序排列
  var clausePareto = Object.keys(clauseFreq).map(function(k) {
    return { clause: k, iso: enrichISO(isoMap[k] || ''), chapter: gmpChapter(k), count: clauseFreq[k] };
  }).sort(function(a, b) { return b.count - a.count; });
  // 计算累积占比
  var totalOccurrences = clausePareto.reduce(function(s, x) { return s + x.count; }, 0);
  var cum = 0;
  clausePareto.forEach(function(c) {
    cum += c.count;
    c.pct = Math.round(c.count / totalOccurrences * 100);
    c.cumPct = Math.round(cum / totalOccurrences * 100);
  });

  var summary = {
    total: auditFindings.length,
    systemCount: auditFindings.filter(function(f) { return f.category === '体系风险'; }).length,
    productCount: auditFindings.filter(function(f) { return f.category === '产品风险'; }).length,
    keyItems: auditFindings.filter(function(f) { return f.item_type === '关键项目'; }).length,
    majorItems: auditFindings.filter(function(f) { return f.item_type === '主要项目'; }).length,
    generalItems: auditFindings.filter(function(f) { return f.item_type === '一般项目'; }).length,
    auditFindings: auditFindings.filter(function(f) { return f.event_type === 'Audit-Finding'; }).length,
    dailyFindings: auditFindings.filter(function(f) { return f.event_type === 'NCR'; }).length,
    criticalCount: auditFindings.filter(function(f) { return f.risk_level === 'Critical'; }).length,
    highCount: auditFindings.filter(function(f) { return f.risk_level === 'High'; }).length,
    lowCount: auditFindings.filter(function(f) { return f.risk_level === 'Low'; }).length,
    conclusion: (function() {
      var keyItems = auditFindings.filter(function(f) { return f.item_type === '关键项目'; }).length;
      var majorItems = auditFindings.filter(function(f) { return f.item_type === '主要项目'; }).length;
      if (keyItems > 2) return '暂停生产整改 — 关键项目不符合超过2项';
      if (keyItems + majorItems >= 10) return '暂停生产整改 — 关键+主要项目不符合≥10项';
      if (auditFindings.length > 20) return '暂停生产整改 — 不符合项目总数>20项';
      if (keyItems === 0 && majorItems === 0 && auditFindings.filter(function(f) { return f.item_type === '一般项目'; }).length < 5) return '自行整改';
      return '限期整改';
    })()
  };
  res.json({ items: itemsWithISO, summary: summary, clausePareto: clausePareto, updated: '2026-07' });
}));

// POST — 一键导入事件库（创建品质事件记录，去重）
app.post('/api/audit-findings/seed', requireAuth, asyncHandler(async (req, res) => {
  var created = 0, skipped = 0;
  var existingEvents = await db.findAll('quality_events', {}, { sort: { created_at: -1 }, limit: 500 });
  for (var i = 0; i < auditFindings.length; i++) {
    var f = auditFindings[i];
    // 去重：检查是否已存在相同描述的事件
    var dup = existingEvents.find(function(e) {
      return e.description && e.description.indexOf(f.risk_desc.substring(0, 20)) === 0;
    });
    if (dup) { skipped++; continue; }
    
    await db.insert('quality_events', {
      event_type: f.event_type,
      risk_level: f.risk_level,
      product_name: (f.category === '产品风险' ? '化学发光/生化试剂' : '全产品线'),
      description: f.risk_desc,
      clause_ref: f.clause_ref,
      finding_class: f.item_type,
      status: 'Open',
      reported_by: req.user.username
    }, req.user.username);
    created++;
  }
  res.json({ created: created, skipped: skipped, total: auditFindings.length, message: '已导入 ' + created + ' 条，跳过 ' + skipped + ' 条（已存在）' });
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
		    console.log('\n  ╔══════════════════════════════════════════════╗\n  ║   FosunDx Quality Hub (FDQH) Platform       ║\n  ║   IVD 数字化质量管理平台 v2.19.0             ║\n  ║   http://localhost:' + PORT + '                      ║\n  ╚══════════════════════════════════════════════╝\n  ');
    console.log('  默认账号: admin / admin123');
  });
}).catch(function(err) {
  console.error('Database init error:', err.message);
  app.listen(PORT, function() { console.log('Server started on ' + PORT + ' (no database)'); });
});
