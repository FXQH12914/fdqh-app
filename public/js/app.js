// ============================================================
// FDQH Frontend Application
// ============================================================
const API = '/api';
let token = '';
let currentEventFilter = '';
let currentCAPAFilter = '';
let charts = {};

// ---- HTTP Helpers ----
async function apiGet(url) {
  const res = await fetch(API + url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

async function apiPost(url, data) {
  const res = await fetch(API + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data)
  });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

async function apiPut(url, data) {
  const res = await fetch(API + url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data)
  });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

async function apiDelete(url) {
  const res = await fetch(API + url, {
    method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
  });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

// ---- AUTH ----
document.getElementById('loginForm').onsubmit = async function(e) {
  e.preventDefault();
  const username = document.getElementById('loginUser').value;
  const password = document.getElementById('loginPass').value;
  document.getElementById('loginError').textContent = '';
  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok) {
      token = data.token;
      document.getElementById('userName').textContent = data.user.name;
      document.getElementById('userDept').textContent = data.user.base + ' · ' + data.user.role;
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('appLayout').classList.add('active');
      loadDashboard();
    } else {
      document.getElementById('loginError').textContent = data.error || '登录失败';
    }
  } catch(err) {
    document.getElementById('loginError').textContent = '无法连接到服务器';
  }
};

function logout() {
  if (token) apiPost('/auth/logout');
  token = '';
  document.getElementById('loginScreen').style.display = '';
  document.getElementById('appLayout').classList.remove('active');
  document.getElementById('loginError').textContent = '';
}

// ---- NAVIGATION ----
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  var pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  var navEl = document.querySelector(`.sidebar nav a[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  
  switch(page) {
    case 'dashboard': loadDashboard(); break;
    case 'events': loadEvents(); break;
    case 'capa': loadCAPA(); break;
    case 'changes': loadChanges(); break;
    case 'masters': loadMasters(); break;
    case 'audit': loadAuditLogs(); break;
    case 'ai': loadAIAssistant(); break;
  }
}

// ---- MODALS ----
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  const stats = await apiGet('/dashboard/stats');
  if (!stats) return;

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card"><div class="label">质量事件总数</div><div class="value">${stats.totalEvents}</div><div class="sub">全部类型</div></div>
    <div class="stat-card warn"><div class="label">待处理事件</div><div class="value">${stats.openEvents}</div><div class="sub">Open / 调查中</div></div>
    <div class="stat-card"><div class="label">CAPA 总数</div><div class="value">${stats.totalCAPAs}</div><div class="sub">待处理 ${stats.openCAPAs}</div></div>
    <div class="stat-card danger"><div class="label">逾期 CAPA</div><div class="value">${stats.overdueCAPAs}</div><div class="sub">需紧急处理</div></div>
    <div class="stat-card"><div class="label">变更申请</div><div class="value">${stats.totalChanges}</div><div class="sub">待审批 ${stats.pendingChanges}</div></div>
    <div class="stat-card"><div class="label">已关闭事件</div><div class="value">${stats.closedEvents}</div><div class="sub">闭环率 ${stats.totalEvents ? Math.round(stats.closedEvents/stats.totalEvents*100) : 0}%</div></div>
  `;

  // Add AI prediction button
  var aiBtnHtml = '<div class="card" style="margin-bottom:24px;"><div class="card-body" style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;">' +
    '<div><span style="font-size:20px;">📈</span> <strong>AI 质量风险预测</strong> <span style="color:var(--text-secondary);font-size:13px;">基于历史数据智能分析</span></div>' +
    '<button class="btn btn-accent btn-sm" onclick="runRiskPrediction()">🤖 立即分析</button></div></div>';
  
  var pageHeader = document.querySelector('#page-dashboard .page-header');
  if (pageHeader) {
    var existingAiBtn = document.getElementById('aiPredictBtn');
    if (existingAiBtn) existingAiBtn.remove();
    var aiDiv = document.createElement('div');
    aiDiv.id = 'aiPredictBtn';
    aiDiv.innerHTML = aiBtnHtml;
    pageHeader.after(aiDiv);
  }

  renderChart('chartMonthly', 'line', stats.monthlyTrends.map(t => t.month), stats.monthlyTrends.map(t => t.count), '事件数', '#D4875A');
  const rd = stats.riskDistribution;
  renderPieChart('chartRisk', ['Low','Medium','High','Critical'], [rd.Low, rd.Medium, rd.High, rd.Critical], ['#10B981','#F59E0B','#EF4444','#7C3AED']);
  const et = stats.eventTypes;
  renderPieChart('chartTypes', ['Deviation','OOS','Complaint','CAPA','Other'], [et.Deviation, et.OOS, et.Complaint, et.CAPA, et.Other], ['#3B82F6','#F59E0B','#EF4444','#10B981','#6B7280']);

  const recent = await apiGet('/dashboard/recent-events');
  if (recent) {
    document.getElementById('recentEvents').innerHTML = recent.length ? 
      '<table>' + recent.map(e => `<tr class="clickable" onclick="viewEvent('${e.id}')">
        <td><span class="badge badge-${getRiskBadge(e.risk_level)}">${e.risk_level}</span></td>
        <td>${e.id}</td><td>${e.event_type}</td><td>${e.description?.slice(0,40)||''}...</td>
        <td><span class="badge badge-${getStatusBadge(e.status)}">${e.status}</span></td></tr>`).join('') + '</table>' :
      '<div class="empty-state"><div class="icon">✅</div>暂无待处理事件</div>';
  }
}

function renderChart(id, type, labels, data, label, color) {
  const ctx = document.getElementById(id).getContext('2d');
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type, data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '20', fill: true, tension: 0.4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

function renderPieChart(id, labels, data, colors) {
  const ctx = document.getElementById(id).getContext('2d');
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
}

// ============================================================
// EVENTS
// ============================================================
async function loadEvents() {
  const search = document.getElementById('eventSearch')?.value || '';
  const events = await apiGet('/events?' + (currentEventFilter ? `status=${currentEventFilter}&` : '') + (search ? `search=${search}&` : ''));
  if (!events) return;
  
  const tbody = document.querySelector('#eventsTable tbody');
  tbody.innerHTML = events.map(e => `<tr>
    <td><a href="javascript:viewEvent('${e.id}')">${e.id}</a></td>
    <td><span class="badge badge-info">${e.event_type}</span></td>
    <td>${e.product_name||'-'}</td><td>${e.batch_no||'-'}</td>
    <td><span class="badge badge-${getRiskBadge(e.risk_level)}">${e.risk_level}</span></td>
    <td><span class="badge badge-${getStatusBadge(e.status)}">${e.status}</span></td>
    <td title="${e.description}">${(e.description||'').slice(0,50)}</td>
    <td>${formatDate(e.created_at)}</td>
    <td>
      <button class="btn btn-outline btn-sm" onclick="eventStatusAction('${e.id}','${e.status}')">流转</button>
      <button class="btn btn-outline btn-sm" onclick="editEvent('${e.id}')">编辑</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="9"><div class="empty-state">暂无质量事件记录</div></td></tr>';
}

function filterEvents(status) {
  // Toggle filter
  if (status !== undefined) {
    currentEventFilter = status === currentEventFilter ? '' : status;
  }
  // Update filter button visual states
  var allBtns = document.querySelectorAll('#page-events .card-header .btn-group:first-child .btn');
  allBtns.forEach(function(btn) { btn.classList.remove('btn-primary'); btn.classList.add('btn-outline'); });
  if (currentEventFilter) {
    allBtns.forEach(function(btn) {
      var onclick = btn.getAttribute('onclick') || '';
      if (onclick.includes("'" + currentEventFilter + "'")) {
        btn.classList.remove('btn-outline');
        btn.classList.add('btn-primary');
      }
    });
  } else {
    // "全部" is the first button
    var firstBtn = allBtns[0];
    if (firstBtn) { firstBtn.classList.remove('btn-outline'); firstBtn.classList.add('btn-primary'); }
  }
  loadEvents();
}

async function openEventModal(editId) {
  // Load products for dropdown
  var products = await apiGet('/products');
  var sel = document.getElementById('evProduct');
  sel.innerHTML = '<option value="">请选择</option>' + (products||[]).map(p => '<option value="' + p.id + '">' + p.product_name + '</option>').join('');

  if (editId) {
    // Use direct event endpoint for efficiency
    var data = await apiGet('/events/' + editId);
    var event = data ? data.event : null;
    if (event) {
      document.getElementById('eventModalTitle').textContent = '编辑质量事件';
      document.getElementById('evId').value = event.id;
      document.getElementById('evType').value = event.event_type;
      document.getElementById('evRisk').value = event.risk_level;
      document.getElementById('evProduct').value = event.product_id || '';
      document.getElementById('evBatch').value = event.batch_no || '';
      document.getElementById('evDesc').value = event.description || '';
    }
  } else {
    document.getElementById('eventModalTitle').textContent = '新建质量事件';
    document.getElementById('evId').value = '';
    document.getElementById('eventForm').reset();
  }
  openModal('eventModal');
}

function editEvent(id) { openEventModal(id); }

async function saveEvent() {
  const data = {
    event_type: document.getElementById('evType').value,
    risk_level: document.getElementById('evRisk').value,
    product_id: document.getElementById('evProduct').value || null,
    product_name: document.getElementById('evProduct').selectedOptions[0]?.text || null,
    batch_no: document.getElementById('evBatch').value || null,
    description: document.getElementById('evDesc').value,
  };
  const id = document.getElementById('evId').value;
  if (!data.event_type || !data.risk_level || !data.description) return alert('请填写必填字段');
  
  if (id) { await apiPut('/events/' + id, data); }
  else { await apiPost('/events', data); }
  closeModal('eventModal');
  loadEvents();
}

async function eventStatusAction(eventId, currentStatus) {
  const transitions = {
    'Open': ['In Investigation', 'Closed - No Action'],
    'In Investigation': ['Root Cause Analysis', 'Closed'],
    'Root Cause Analysis': ['CAPA Created', 'Closed'],
    'CAPA Created': ['Closed'],
  };
  const opts = transitions[currentStatus];
  if (!opts || opts.length === 0) return alert('当前状态无法流转');
  const newStatus = prompt(`当前状态: ${currentStatus}\n可选流转:\n${opts.join('\n')}\n请输入目标状态:`);
  if (newStatus && opts.includes(newStatus)) {
    await apiPut('/events/' + eventId, { status: newStatus });
    loadEvents();
    if (document.getElementById('page-dashboard').classList.contains('active')) loadDashboard();
  } else if (newStatus) {
    alert('无效的状态流转');
  }
}

async function viewEvent(id) {
  const data = await apiGet('/events/' + id);
  if (!data || !data.event) return;
  const e = data.event;
  document.getElementById('eventDetailContent').innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><div class="dl">事件ID</div><div class="dv">${e.id}</div></div>
      <div class="detail-item"><div class="dl">类型</div><div class="dv">${e.event_type}</div></div>
      <div class="detail-item"><div class="dl">风险等级</div><div class="dv"><span class="badge badge-${getRiskBadge(e.risk_level)}">${e.risk_level}</span></div></div>
      <div class="detail-item"><div class="dl">状态</div><div class="dv"><span class="badge badge-${getStatusBadge(e.status)}">${e.status}</span></div></div>
      <div class="detail-item"><div class="dl">关联产品</div><div class="dv">${e.product_name||'-'}</div></div>
      <div class="detail-item"><div class="dl">批号</div><div class="dv">${e.batch_no||'-'}</div></div>
      <div class="detail-item"><div class="dl">上报人</div><div class="dv">${e.reported_by||'-'}</div></div>
      <div class="detail-item"><div class="dl">创建时间</div><div class="dv">${formatDate(e.created_at)}</div></div>
    </div>
    <div style="margin-top:16px"><div class="dl" style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">事件描述</div>
    <div style="background:var(--bg);padding:12px;border-radius:var(--radius);font-size:14px">${e.description||'无'}</div></div>
    <div style="margin-top:16px;display:flex;gap:8px;">
      <button class="btn btn-accent btn-sm" onclick="analyzeEventWithAI('${e.id}')">🤖 AI 智能分析</button>
      <button class="btn btn-outline btn-sm" onclick="closeModal('eventDetailModal')">关闭</button>
    </div>
    ${(data.auditLogs||[]).length > 0 ? `<div style="margin-top:20px"><h4 style="margin-bottom:12px">审计追踪</h4><div class="timeline">${data.auditLogs.map(l => `<div class="timeline-item"><div class="ts">${formatDate(l.timestamp)}</div><div class="td">${l.action} - ${l.detail}</div></div>`).join('')}</div></div>` : ''}
  `;
  openModal('eventDetailModal');
}

// ============================================================
// CAPA
// ============================================================
async function loadCAPA(filter) {
  if (filter) currentCAPAFilter = currentCAPAFilter === filter ? '' : filter;
  const capas = await apiGet('/capa');
  if (!capas) return;
  
  let rows = capas;
  if (currentCAPAFilter === 'Open') rows = rows.filter(c => c.status === 'Open');
  else if (currentCAPAFilter === 'In Progress') rows = rows.filter(c => c.status === 'In Progress');
  else if (currentCAPAFilter === 'Overdue') rows = rows.filter(c => c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed');

  const tbody = document.querySelector('#capaTable tbody');
  tbody.innerHTML = rows.map(c => `<tr>
    <td>${c.id}</td><td>${c.title}</td><td>${c.event_id||'-'}</td>
    <td>${(c.root_cause||'').slice(0,30)}</td><td>${c.assignee||'-'}</td>
    <td><span class="badge badge-${getStatusBadge(c.status)}">${c.status}</span></td>
    <td>${c.due_date||'-'} ${new Date(c.due_date) < new Date() && c.status !== 'Closed' ? '⚠️' : ''}</td>
    <td>${c.effectiveness||'-'}</td>
    <td><button class="btn btn-outline btn-sm" onclick="editCAPA('${c.id}')">编辑</button>
      <button class="btn btn-danger btn-sm" onclick="deleteCAPA('${c.id}')">删除</button></td>
  </tr>`).join('') || '<tr><td colspan="9"><div class="empty-state">暂无 CAPA 记录</div></td></tr>';
}

function filterCAPA(status) { currentCAPAFilter = currentCAPAFilter === status ? '' : status; loadCAPA(); }

async function openCAPAModal(editId) {
  const events = await apiGet('/events');
  const sel = document.getElementById('capaEvent');
  sel.innerHTML = '<option value="">无</option>' + (events||[]).map(e => `<option value="${e.id}">${e.id} ${e.event_type}</option>`).join('');

  if (editId) {
    const capas = await apiGet('/capa');
    const c = capas.find(x => x.id === editId);
    if (c) {
      document.getElementById('capaId').value = c.id;
      document.getElementById('capaTitle').value = c.title || '';
      document.getElementById('capaEvent').value = c.event_id || '';
      document.getElementById('capaRootCause').value = c.root_cause || '';
      document.getElementById('capaActionPlan').value = c.action_plan || '';
      document.getElementById('capaAssignee').value = c.assignee || '';
      document.getElementById('capaDueDate').value = c.due_date || '';
      document.getElementById('capaEffectiveness').value = c.effectiveness || '';
      document.getElementById('capaStatus').value = c.status || 'Open';
    }
  } else {
    document.getElementById('capaId').value = '';
    document.getElementById('capaForm').reset();
    document.getElementById('capaStatus').value = 'Open';
  }
  openModal('capaModal');
}

function editCAPA(id) { openCAPAModal(id); }

async function saveCAPA() {
  const data = {
    title: document.getElementById('capaTitle').value,
    event_id: document.getElementById('capaEvent').value || null,
    root_cause: document.getElementById('capaRootCause').value,
    action_plan: document.getElementById('capaActionPlan').value,
    assignee: document.getElementById('capaAssignee').value,
    due_date: document.getElementById('capaDueDate').value,
    effectiveness: document.getElementById('capaEffectiveness').value,
    status: document.getElementById('capaStatus').value,
  };
  const id = document.getElementById('capaId').value;
  if (id) { await apiPut('/capa/' + id, data); }
  else { await apiPost('/capa', data); }
  closeModal('capaModal');
  loadCAPA();
}

async function deleteCAPA(id) {
  if (confirm('确定删除此 CAPA 记录？')) {
    await apiDelete('/capa/' + id);
    loadCAPA();
  }
}

// ============================================================
// CHANGES
// ============================================================
async function loadChanges() {
  const changes = await apiGet('/changes');
  if (!changes) return;
  const tbody = document.querySelector('#changesTable tbody');
  tbody.innerHTML = changes.map(c => `<tr>
    <td>${c.id}</td><td>${c.change_type}</td><td>${c.product_id||'-'}</td>
    <td><span class="badge badge-${getRiskBadge(c.risk)}">${c.risk}</span></td>
    <td>${(c.impact||'').slice(0,40)}</td><td>${c.validation_status||'-'}</td>
    <td><span class="badge badge-${getStatusBadge(c.status)}">${c.status}</span></td>
    <td>${c.initiator||'-'}</td>
    <td><button class="btn btn-outline btn-sm" onclick="approveChange('${c.id}')">审批</button></td>
  </tr>`).join('') || '<tr><td colspan="9"><div class="empty-state">暂无变更记录</div></td></tr>';
}

async function openChangeModal() {
  const products = await apiGet('/products');
  document.getElementById('chgProduct').innerHTML = '<option value="">请选择</option>' + (products||[]).map(p => `<option value="${p.id}">${p.product_name}</option>`).join('');
  document.getElementById('chgId').value = '';
  document.getElementById('changeForm').reset();
  openModal('changeModal');
}

async function saveChange() {
  const data = {
    change_type: document.getElementById('chgType').value,
    risk: document.getElementById('chgRisk').value,
    product_id: document.getElementById('chgProduct').value || null,
    impact: document.getElementById('chgImpact').value,
    initiator: document.getElementById('userName')?.textContent || 'system',
  };
  await apiPost('/changes', data);
  closeModal('changeModal');
  loadChanges();
}

async function approveChange(id) {
  const action = prompt('审批操作 (输入: Approved / Rejected / Pending Approval):', 'Approved');
  if (action) {
    await apiPut('/changes/' + id, { status: action, validation_status: action === 'Approved' ? '待验证' : '' });
    loadChanges();
  }
}

// ============================================================
// MASTERS
// ============================================================
async function loadMasters() { showMasterTab('products'); }

async function showMasterTab(tab) {
  // Fix: find tab button by data attribute instead of relying on event.target
  var allTabs = document.querySelectorAll('#page-masters .tab');
  allTabs.forEach(function(t) { t.classList.remove('active'); });
  var activeTab = document.querySelector('#page-masters .tab[onclick*="' + tab + '"]');
  if (activeTab) activeTab.classList.add('active');
  
  document.getElementById('master-products').style.display = tab === 'products' ? '' : 'none';
  document.getElementById('master-suppliers').style.display = tab === 'suppliers' ? '' : 'none';
  
  if (tab === 'products') {
    var products = await apiGet('/products');
    var tbody = document.querySelector('#productsTable tbody');
    tbody.innerHTML = (products||[]).map(p => '<tr><td>' + p.id + '</td><td>' + p.product_name + '</td><td>' + (p.platform||'-') + '</td><td><span class="badge badge-' + getRiskBadge(p.risk_class) + '">' + p.risk_class + '</span></td><td>' + (p.lifecycle_status||'-') + '</td><td>' + (p.regulatory_status||'-') + '</td></tr>').join('') || '<tr><td colspan="6"><div class="empty-state">暂无产品数据</div></td></tr>';
  } else {
    var suppliers = await apiGet('/suppliers');
    var tbody2 = document.querySelector('#suppliersTable tbody');
    tbody2.innerHTML = (suppliers||[]).map(s => '<tr><td>' + s.id + '</td><td>' + s.supplier_name + '</td><td>' + (s.category||'-') + '</td><td><span class="badge badge-' + getRiskBadge(s.risk_level) + '">' + s.risk_level + '</span></td><td>' + (s.quality_score != null ? '⭐'.repeat(Math.round(s.quality_score/20)) + ' ' + s.quality_score : '-') + '</td><td>' + (s.certification||'-') + '</td><td><button class="btn btn-outline btn-sm" onclick="editSupplier(\'' + s.id + '\')">编辑</button></td></tr>').join('') || '<tr><td colspan="7"><div class="empty-state">暂无供应商数据</div></td></tr>';
  }
}

async function openSupplierModal() {
  document.getElementById('supId').value = '';
  document.getElementById('supplierForm').reset();
  openModal('supplierModal');
}

async function editSupplier(id) {
  const suppliers = await apiGet('/suppliers');
  const s = suppliers.find(x => x.id === id);
  if (s) {
    document.getElementById('supId').value = s.id;
    document.getElementById('supName').value = s.supplier_name;
    document.getElementById('supCategory').value = s.category || '';
    document.getElementById('supRisk').value = s.risk_level || 'Low';
    document.getElementById('supScore').value = s.quality_score || '';
    document.getElementById('supCert').value = s.certification || '';
    openModal('supplierModal');
  }
}

async function saveSupplier() {
  const data = {
    supplier_name: document.getElementById('supName').value,
    category: document.getElementById('supCategory').value,
    risk_level: document.getElementById('supRisk').value,
    quality_score: parseFloat(document.getElementById('supScore').value) || null,
    certification: document.getElementById('supCert').value,
  };
  const id = document.getElementById('supId').value;
  if (id) { await apiPut('/suppliers/' + id, data); }
  else { await apiPost('/suppliers', data); }
  closeModal('supplierModal');
  showMasterTab('suppliers');
}

// ============================================================
// AUDIT LOGS
// ============================================================
async function loadAuditLogs() {
  const logs = await apiGet('/audit-logs');
  const tbody = document.querySelector('#auditTable tbody');
  tbody.innerHTML = (logs||[]).map(l => `<tr>
    <td>${formatDate(l.timestamp)}</td><td>${l.action}</td><td>${l.table_name}</td>
    <td>${l.record_id}</td><td>${l.detail||''}</td>
  </tr>`).join('') || '<tr><td colspan="5"><div class="empty-state">暂无审计日志</div></td></tr>';
}

// ============================================================
// UTILITIES
// ============================================================
function formatDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('zh-CN'); } catch(e) { return d; }
}

function getRiskBadge(level) {
  const map = { Low: 'success', Medium: 'warning', High: 'danger', Critical: 'danger', III: 'danger', II: 'warning', I: 'success' };
  return map[level] || 'default';
}

function getStatusBadge(status) {
  if (!status) return 'default';
  if (status.includes('Closed') || status === 'Approved') return 'success';
  if (status.includes('Investigation') || status.includes('Progress') || status.includes('Pending')) return 'warning';
  if (status.includes('Open') || status === 'Created') return 'info';
  return 'default';
}

// ---- TOAST NOTIFICATIONS ----
function showToast(msg, type) {
  type = type || 'info';
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = msg;
  toast.style.cssText = 'position:fixed;top:20px;right:20px;padding:12px 24px;border-radius:8px;color:white;z-index:9999;animation:slideIn 0.3s ease;font-size:14px;max-width:400px;';
  if (type === 'success') toast.style.background = '#10B981';
  else if (type === 'error') toast.style.background = '#EF4444';
  else if (type === 'warning') toast.style.background = '#F59E0B';
  else toast.style.background = '#3B82F6';
  document.body.appendChild(toast);
  setTimeout(function() { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, 3000);
  setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3300);
}

// Global error handler for uncaught errors
window.addEventListener('error', function(e) {
  console.error('Global error:', e.error);
  showToast('操作出错，请刷新页面重试', 'error');
});

// Global handler for unhandled promise rejections
window.addEventListener('unhandledrejection', function(e) {
  console.error('Unhandled rejection:', e.reason);
  showToast('网络请求失败，请检查连接', 'error');
});

// ---- Init ----
console.log('🩺 FDQH Platform initialized');
