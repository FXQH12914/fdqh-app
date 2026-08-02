// ============================================================
// FDQH Frontend Application v1.1
// ============================================================
var API = '/api';
var token = '';
var currentEventFilter = '';
var currentCAPAFilter = '';
var charts = {};
var dashboardTimer = null;
var eventSearchTimer = null;

// ---- HTTP Helpers ----
async function apiGet(url) {
  var res = await fetch(API + url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) { var err = await res.json().catch(function() { return {}; }); showToast(err.error || '请求失败', 'error'); return null; }
  return res.json();
}

async function apiPost(url, data) {
  var res = await fetch(API + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data)
  });
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) { var err = await res.json().catch(function() { return {}; }); showToast(err.error || '操作失败', 'error'); return null; }
  return res.json();
}

async function apiPut(url, data) {
  var res = await fetch(API + url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data)
  });
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) { var err = await res.json().catch(function() { return {}; }); showToast(err.error || '更新失败', 'error'); return null; }
  return res.json();
}

async function apiDelete(url) {
  var res = await fetch(API + url, {
    method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
  });
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) { var err = await res.json().catch(function() { return {}; }); showToast(err.error || '删除失败', 'error'); return null; }
  return res.json();
}

// ---- AUTH ----
document.getElementById('loginForm').onsubmit = async function(e) {
  e.preventDefault();
  var username = document.getElementById('loginUser').value;
  var password = document.getElementById('loginPass').value;
  var errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    var res = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, password: password })
    });
    var data = await res.json();
    if (res.ok) {
      token = data.token;
      document.getElementById('userName').textContent = data.user.name;
      document.getElementById('userDept').textContent = data.user.base + ' · ' + data.user.role;
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('appLayout').classList.add('active');
      loadDashboard();
    } else {
      errEl.textContent = data.error || '登录失败';
    }
  } catch(err) {
    errEl.textContent = '无法连接到服务器';
  }
};

function logout() {
  if (token) apiPost('/auth/logout');
  token = '';
  if (dashboardTimer) clearInterval(dashboardTimer);
  document.getElementById('loginScreen').style.display = '';
  document.getElementById('appLayout').classList.remove('active');
}

// ---- NAVIGATION ----
function navigate(page) {
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  var pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll('.sidebar nav a').forEach(function(a) { a.classList.remove('active'); });
  var navEl = document.querySelector('.sidebar nav a[data-page="' + page + '"]');
  if (navEl) navEl.classList.add('active');

  switch(page) {
    case 'dashboard': loadDashboard(); break;
    case 'events': loadEvents(); break;
    case 'capa': loadCAPA(); break;
    case 'changes': loadChanges(); break;
    case 'masters': loadMasters(); break;
    case 'qcp': loadQCP(); break;
    case 'risks': loadRisks(); break;
    case 'audit': loadAuditLogs(); break;
    case 'ai': loadAIAssistant(); break;
  }
}

// ---- MODALS ----
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ---- CONFIRM DIALOG ----
function confirmAction(msg, callback) {
  if (confirm(msg)) { callback(); }
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  var stats = await apiGet('/dashboard/stats');
  if (!stats) return;

  // ========== TQM 三层驾驶舱 ==========
  var qhi = await apiGet('/dashboard/qhi');
  if (qhi && qhi.tqm) {
    var lc = qhi.level === 'green' ? '#10B981' : qhi.level === 'yellow' ? '#F59E0B' : '#EF4444';
    var t = qhi.tqm;
    var d = qhi.domains || {};

    // === 战略层: QHI Big Card ===
    document.getElementById('tqmQhiRow').innerHTML =
      '<div class="tqm-qhi-total"><div class="qhi-number">' + qhi.qhi + '</div><div class="qhi-label">' + (qhi.level === 'green' ? '🟢 健康' : qhi.level === 'yellow' ? '🟡 关注' : '🔴 预警') + '</div></div>' +
      '<div class="tqm-pillars">' +
      '<div class="tqm-pillar patient"><div class="pillar-value">' + t.patient.score + '</div><div class="pillar-label">🏥 患者结果</div><div class="pillar-weight">权重 40% · 投诉' + t.patient.detail.complaints + '% 批合格' + t.patient.detail.batch + '%</div></div>' +
      '<div class="tqm-pillar compliance"><div class="pillar-value">' + t.compliance.score + '</div><div class="pillar-label">📋 合规质量</div><div class="pillar-weight">权重 30% · CAPA关闭' + t.compliance.detail.capa + '% 审计' + t.compliance.detail.audit + '%</div></div>' +
      '<div class="tqm-pillar efficiency"><div class="pillar-value">' + t.efficiency.score + '</div><div class="pillar-label">⚡ 经营效率</div><div class="pillar-weight">权重 30% · 偏差率' + t.efficiency.detail.deviation + '% 供应' + t.efficiency.detail.supply + '%</div></div>' +
      '</div>';
    }

    // ========== 三类指标卡 (红线 / 经营 / 提升) ==========
  var kpis = await apiGet('/dashboard/kpis');
  if (kpis) {
    function renderKpiCard(icon, title, cssClass, items) {
      var rows = items.map(function(k) {
        var statusIcon = k.status === 'pass' ? '🟢' : k.status === 'fail' ? '🔴' : k.status === 'warning' ? '🟡' : '🔵';
        return '<li><span class="kpi-name">' + k.name + (k.trend === 'up' ? ' ↑' : k.trend === 'down' ? ' ↓' : '') + '</span><span class="kpi-value">' + k.value + (k.unit||'') + '</span><span class="kpi-target">目标 ' + k.target + (k.unit||'') + '</span><span class="kpi-status ' + k.status + '"></span></li>';
      }).join('');
      return '<div class="tqm-kpi-card"><div class="kpi-card-header ' + cssClass + '"><span class="kpi-icon">' + icon + '</span>' + title + '</div><ul class="tqm-kpi-list">' + rows + '</ul></div>';
    }
    document.getElementById('tqmKpiSection').innerHTML =
      renderKpiCard('🔴', '红线类 · 一票否决', 'redline', kpis.redlines) +
      renderKpiCard('📊', '经营类 · 稳定运行', 'operation', kpis.operations) +
      renderKpiCard('🚀', '提升类 · 持续改进', 'improvement', kpis.improvements);
  }

  // ========== 执行层：实时预警 + 待办 ==========
  var alertData = await apiGet('/dashboard/alerts');
  var alertRows = '';
  if (alertData && alertData.alerts && alertData.alerts.length) {
    alertRows = alertData.alerts.map(function(a) {
      var b = a.level === 'red' ? 'danger' : a.level === 'yellow' ? 'warning' : 'success';
      return '<tr><td><span class="badge badge-' + b + '">' + (a.level === 'red' ? '🔴' : a.level === 'yellow' ? '🟡' : '🟢') + '</span></td><td style="font-size:12px;">' + a.message + '</td></tr>';
    }).join('');
  } else {
    alertRows = '<tr><td><div class="empty-state">✅ 所有指标正常，无需预警</div></td></tr>';
  }
  document.getElementById('recentEvents').innerHTML = '<table>' + alertRows + '</table>';

  // ========== 四维质量看板 ==========
  loadQualityModules();

  // Charts
  renderChart('chartMonthly', 'line', stats.monthlyTrends.map(function(t) { return t.month; }), stats.monthlyTrends.map(function(t) { return t.count; }), '事件数', '#D4875A');
  var rd = stats.riskDistribution;
  renderPieChart('chartRisk', ['Low','Medium','High','Critical'], [rd.Low, rd.Medium, rd.High, rd.Critical], ['#10B981','#F59E0B','#EF4444','#7C3AED']);

  // Auto-refresh
  if (document.getElementById('page-dashboard').classList.contains('active')) {
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = setInterval(loadDashboard, 60000);
  }
}

// ===== 保龄球图渲染 =====
var currentModule = 'mfg'; // default active module

async function loadQualityModules() {
  var data = await apiGet('/dashboard/quality-modules');
  if (!data || !data.modules) return;

  var months = ['1月','2月','3月','4月','5月'];

  // Render tabs
  var tabsHtml = data.modules.map(function(mod) {
    var active = mod.id === currentModule ? ' active' : '';
    return '<button class="module-tab ' + mod.id + active + '" onclick="switchModule(\'' + mod.id + '\')">' + mod.icon + ' ' + mod.title + '</button>';
  }).join('');
  document.getElementById('moduleTabs').innerHTML = tabsHtml;

  // Render active module
  renderModule(data.modules.find(function(m) { return m.id === currentModule; }), months);

  function renderModule(mod, defaultMonths) {
    if (!mod) return;
    var html = '';

    // Summary cards
    html += '<div class="module-summary">';
    mod.summary.forEach(function(s) {
      var cls = s.status === 'pass' ? 'ms-pass' : s.status === 'fail' ? 'ms-fail' : s.status === 'warning' ? 'ms-warn' : 'ms-info';
      html += '<div class="module-summary-card ' + cls + '"><div class="ms-value">' + s.value + '</div><div class="ms-label">' + s.label + '</div><div class="ms-target">目标: ' + s.target + ' ｜ ' + (s.desc||'') + '</div></div>';
    });
    html += '</div>';

    // Sections
    mod.sections.forEach(function(sec) {
      var secMonths = sec.months || defaultMonths;
      html += '<div class="module-section"><div class="module-section-title">' + sec.title + '</div>';

      if (sec.type === 'table') {
        html += '<table class="mod-table"><thead><tr>' + sec.headers.map(function(h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
        sec.rows.forEach(function(row) {
          var cls = 'c-' + row.status;
          html += '<tr><td>' + row.name + (row.note ? ' <span style="color:#DC2626;font-size:10px;">' + row.note + '</span>' : '') + (row.desc ? ' <small style="color:var(--text-muted)">' + row.desc + '</small>' : '') + '</td><td><b>' + row.target + '</b></td>';
          secMonths.forEach(function(mo) {
            var v = row.months[mo];
            var dir = row.direction || 'gte';
            var c = v === '--' || v === null || v === undefined ? 'c-na' : (dir === 'lt' ? (v <= parseFloat(row.target) ? 'c-pass' : 'c-fail') : (v >= parseFloat(row.target) ? 'c-pass' : 'c-fail'));
            var disp = v === '--' ? '-' : (v !== null && v !== undefined ? (v >= 100 ? '100' : Number(v).toFixed(1)) + (isNaN(parseFloat(row.target)) ? '' : '%') : '-');
            html += '<td class="' + c + '">' + disp + '</td>';
          });
          html += '<td class="' + cls + '"><b>' + row.ytd + '</b></td></tr>';
          if (row.children) {
            row.children.forEach(function(ch) {
              html += '<tr class="sub-row"><td>↳ ' + ch.name + '</td><td>' + ch.target + '</td>';
              secMonths.forEach(function(mo) {
                var v = ch.months[mo];
                var c = v === '--' || v === null || v === undefined ? 'c-na' : (v <= parseFloat(ch.target) ? 'c-pass' : 'c-fail');
                html += '<td class="' + c + '">' + (v !== null && v !== undefined ? Number(v).toFixed(1) + '%' : '-') + '</td>';
              });
              html += '<td class="c-' + ch.status + '"><b>' + ch.ytd + '</b></td></tr>';
            });
          }
        });
        html += '</tbody></table>';

      } else if (sec.type === 'list') {
        html += '<ul class="mod-list">';
        sec.items.forEach(function(item) {
          html += '<li><span class="mod-issue">' + item.issue + '</span><span class="mod-line">' + (item.line||'') + '</span><span style="font-size:11px;color:var(--text-muted);">' + (item.product||'') + '</span><span class="mod-status ' + (item.status||'open') + '">' + (item.status==='open'?'待解决':'已关闭') + '</span></li>';
        });
        html += '</ul>';

      } else if (sec.type === 'cards') {
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">';
        sec.items.forEach(function(item) {
          html += '<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:12px;"><div style="font-weight:600;font-size:13px;color:#92400E;">' + item.name + '</div><div style="font-size:11px;color:#A16207;margin-top:4px;">目标: ' + item.target + '</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-style:italic;">💡 ' + item.note + '</div></div>';
        });
        html += '</div>';

      } else if (sec.type === 'summary') {
        html += '<div class="mod-summary-bar">';
        sec.items.forEach(function(item) {
          html += '<div class="mod-summary-item"><span class="msi-label">' + item.label + '</span><span class="msi-value" style="color:' + (item.color||'#3B82F6') + '">' + item.value + '</span></div>';
        });
        html += '</div>';

      } else if (sec.type === 'cross') {
        html += '<table class="mod-cross"><thead><tr><th>机型</th><th>指标</th>' + secMonths.map(function(m){return '<th>'+m+'</th>';}).join('') + '<th>YTD</th><th>状态</th></tr></thead><tbody>';
        sec.models.forEach(function(model) {
          sec.metrics.forEach(function(met) {
            var d = met.data[model];
            if (!d) return;
            html += '<tr><td class="rl">' + model + '</td><td>' + met.label + ' ≤' + met.target + '</td>';
            secMonths.forEach(function(mo) {
              var v = d.months[mo];
              var c = v === null || v === undefined ? 'c-na' : (v <= parseFloat(met.target) ? 'c-pass' : 'c-fail');
              html += '<td class="' + c + '">' + (v !== null && v !== undefined ? Number(v).toFixed(1) + '%' : '-') + '</td>';
            });
            html += '<td class="c-' + d.status + '"><b>' + d.ytd + '</b></td><td>' + (d.status==='pass'?'🟢':d.status==='fail'?'🔴':'🟡') + '</td></tr>';
          });
        });
        html += '</tbody></table>';
      }

      html += '</div>'; // close section
    });

    document.getElementById('moduleContent').innerHTML = html;
  }
}

function switchModule(id) {
  currentModule = id;
  loadQualityModules();
}

// ===== 数据导入/导出 =====
async function exportDashboardData() {
  var res = await fetch(API + '/dashboard/export', { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401) { logout(); return; }
  if (!res.ok) { showToast('导出失败', 'error'); return; }
  var blob = await res.blob();
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var dateStr = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = 'FDQH_export_' + dateStr + '.xlsx';
  document.body.appendChild(a); a.click();
  setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 500);
  showToast('✅ 数据已导出 (Excel 多工作表)', 'success');
}

async function downloadImportTemplate() {
  var res = await fetch(API + '/dashboard/import/template', { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401) { logout(); return; }
  if (!res.ok) { showToast('模板下载失败', 'error'); return; }
  var blob = await res.blob();
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'FDQH_import_template.xlsx';
  document.body.appendChild(a); a.click();
  setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 500);
  showToast('📄 导入模板已下载', 'success');
}

async function importDashboardData(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];
  var formData = new FormData();
  formData.append('file', file);
  var resultEl = document.getElementById('importResult');
  if (!resultEl) return;

  resultEl.style.display = 'block';
  resultEl.innerHTML = '⏳ 正在解析并导入 <b>' + file.name + '</b> ...';

  try {
    var res = await fetch(API + '/dashboard/import', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    if (res.status === 401) { logout(); return; }
    var data = await res.json();
    if (!data.success) {
      resultEl.innerHTML = '❌ 导入失败: ' + (data.error || '未知错误');
      showToast('导入失败', 'error');
      return;
    }
    var lines = [];
    lines.push('✅ 导入完成 — 事件 ' + data.imported.events + ' 条 | CAPA ' + data.imported.capa + ' 条 | 产品 ' + data.imported.products + ' 条');
    if (data.errors && data.errors.length) {
      lines.push('<div style="color:#DC2626;margin-top:6px;">⚠️ ' + data.errors.length + ' 条错误：</div>');
      data.errors.slice(0, 8).forEach(function(err) { lines.push('<div style="color:#DC2626;font-size:12px;">• ' + err + '</div>'); });
    }
    if (data.details && data.details.length) {
      lines.push('<div style="color:var(--text-muted);margin-top:6px;font-size:12px;">' + data.details.slice(0, 10).join('<br>') + '</div>');
    }
    resultEl.innerHTML = lines.join('');
    showToast('📤 导入成功: ' + data.imported.events + ' 事件 / ' + data.imported.capa + ' CAPA', 'success');
    // Refresh relevant views
    if (document.getElementById('page-events').classList.contains('active')) loadEvents();
    if (document.getElementById('page-capa').classList.contains('active')) loadCAPA();
  } catch (e) {
    resultEl.innerHTML = '❌ 导入失败: ' + e.message;
    showToast('导入失败', 'error');
  }
  input.value = '';
}

function renderChart(id, type, labels, data, label, color) {
  var ctx = document.getElementById(id).getContext('2d');
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: type, data: { labels: labels, datasets: [{ label: label, data: data, borderColor: color, backgroundColor: color + '20', fill: true, tension: 0.4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, animation: { duration: 600 } }
  });
}

function renderPieChart(id, labels, data, colors) {
  var ctx = document.getElementById(id).getContext('2d');
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'doughnut', data: { labels: labels, datasets: [{ data: data, backgroundColor: colors }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, animation: { duration: 600 } }
  });
}

// ============================================================
// EVENTS
// ============================================================
async function loadEvents() {
  var search = document.getElementById('eventSearch')?.value || '';
  var query = '?limit=100';
  if (currentEventFilter) query += '&status=' + currentEventFilter;
  if (search) query += '&search=' + encodeURIComponent(search);

  var result = await apiGet('/events' + query);
  if (!result) return;
  var events = result.data || result;

  var tbody = document.querySelector('#eventsTable tbody');
  tbody.innerHTML = events.length ? events.map(function(e) {
    return '<tr><td><a href="javascript:viewEvent(\'' + e.id + '\')">' + e.id + '</a></td>' +
      '<td>' + (e.event_code||'-') + '</td>' +
      '<td><span class="badge badge-info">' + e.event_type + '</span></td>' +
      '<td>' + (e.event_subtype||'-') + '</td>' +
      '<td>' + (e.product_name||'-') + '</td><td>' + (e.batch_no||'-') + '</td>' +
      '<td><span class="badge badge-' + getRiskBadge(e.risk_level) + '">' + e.risk_level + '</span></td>' +
      '<td>' + (e.rpn_score != null ? e.rpn_score : '-') + '</td>' +
      '<td><span class="badge badge-' + getStatusBadge(e.status) + '">' + e.status + '</span></td>' +
      '<td>' + (e.responsible_dept||'-') + '</td>' +
      '<td title="' + (e.description||'') + '">' + (e.description||'').slice(0,50) + '</td>' +
      '<td>' + formatDate(e.created_at) + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="eventStatusAction(\'' + e.id + '\',\'' + e.status + '\')">流转</button> ' +
      '<button class="btn btn-outline btn-sm" onclick="editEvent(\'' + e.id + '\')">编辑</button> ' +
      '<button class="btn btn-danger btn-sm" onclick="deleteEvent(\'' + e.id + '\')">删除</button></td></tr>';
  }).join('') : '<tr><td colspan="13"><div class="empty-state">暂无质量事件记录</div></td></tr>';
}

function filterEvents(status) {
  if (status !== undefined) currentEventFilter = status === currentEventFilter ? '' : status;
  var allBtns = document.querySelectorAll('#page-events .card-header .btn-group:first-child .btn');
  allBtns.forEach(function(btn) { btn.classList.remove('btn-primary'); btn.classList.add('btn-outline'); });
  if (currentEventFilter) {
    allBtns.forEach(function(btn) {
      var onclick = btn.getAttribute('onclick') || '';
      if (onclick.indexOf("'" + currentEventFilter + "'") !== -1) { btn.classList.remove('btn-outline'); btn.classList.add('btn-primary'); }
    });
  } else {
    var firstBtn = allBtns[0];
    if (firstBtn) { firstBtn.classList.remove('btn-outline'); firstBtn.classList.add('btn-primary'); }
  }
  loadEvents();
}

// Search with debounce
document.addEventListener('DOMContentLoaded', function() {
  var searchInput = document.getElementById('eventSearch');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      if (eventSearchTimer) clearTimeout(eventSearchTimer);
      eventSearchTimer = setTimeout(loadEvents, 300);
    });
  }
});

async function openEventModal(editId) {
  var products = await apiGet('/products');
  var sel = document.getElementById('evProduct');
  sel.innerHTML = '<option value="">请选择</option>' + (products||[]).map(function(p) { return '<option value="' + p.id + '">' + p.product_name + '</option>'; }).join('');

  if (editId) {
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
  var data = {
    event_type: document.getElementById('evType').value,
    risk_level: document.getElementById('evRisk').value,
    product_id: document.getElementById('evProduct').value || null,
    product_name: document.getElementById('evProduct').selectedOptions[0]?.text || null,
    batch_no: document.getElementById('evBatch').value || null,
    description: document.getElementById('evDesc').value,
  };
  var id = document.getElementById('evId').value;
  if (!data.event_type || !data.risk_level || !data.description) { showToast('请填写必填字段', 'warning'); return; }

  if (id) { await apiPut('/events/' + id, data); }
  else { await apiPost('/events', data); }
  closeModal('eventModal');
  loadEvents();
  showToast('保存成功', 'success');
}

async function deleteEvent(eventId) {
  confirmAction('确定删除此事件？此操作不可撤销。', async function() {
    await apiDelete('/events/' + eventId);
    loadEvents();
    showToast('已删除', 'success');
  });
}

async function eventStatusAction(eventId, currentStatus) {
  var transitions = {
    'Open': ['In Investigation', 'Closed - No Action'],
    'In Investigation': ['Root Cause Analysis', 'Closed'],
    'Root Cause Analysis': ['CAPA Created', 'Closed'],
    'CAPA Created': ['Closed'],
  };
  var opts = transitions[currentStatus];
  if (!opts || opts.length === 0) { showToast('当前状态无法流转', 'warning'); return; }

  // Show status transition modal
  var html = '<div class="modal-overlay active" id="statusModal"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>状态流转</h3><button class="modal-close" onclick="closeModal(\'statusModal\')">&times;</button></div>' +
    '<div class="modal-body"><p>当前状态: <strong>' + currentStatus + '</strong></p><p>选择目标状态:</p>' +
    '<select id="statusSelect" style="width:100%;padding:10px;">' + opts.map(function(s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') + '</select></div>' +
    '<div class="modal-footer"><button class="btn btn-outline" onclick="closeModal(\'statusModal\')">取消</button>' +
    '<button class="btn btn-accent" onclick="confirmStatusChange(\'' + eventId + '\')">确认流转</button></div></div></div>';

  var existing = document.getElementById('statusModal');
  if (existing) existing.remove();
  var div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);
}

function confirmStatusChange(eventId) {
  var newStatus = document.getElementById('statusSelect').value;
  closeModal('statusModal');
  apiPut('/events/' + eventId, { status: newStatus }).then(function() {
    loadEvents();
    if (document.getElementById('page-dashboard').classList.contains('active')) loadDashboard();
    showToast('状态已更新', 'success');
  });
}

async function viewEvent(id) {
  var data = await apiGet('/events/' + id);
  if (!data || !data.event) return;
  var e = data.event;
  var html =
    '<div class="detail-grid">' +
    '<div class="detail-item"><div class="dl">事件ID</div><div class="dv">' + e.id + '</div></div>' +
    '<div class="detail-item"><div class="dl">事件编码</div><div class="dv">' + (e.event_code||'-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">类型</div><div class="dv">' + e.event_type + '</div></div>' +
    '<div class="detail-item"><div class="dl">子类型</div><div class="dv">' + (e.event_subtype||'-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">风险等级</div><div class="dv"><span class="badge badge-' + getRiskBadge(e.risk_level) + '">' + e.risk_level + '</span></div></div>' +
    '<div class="detail-item"><div class="dl">严重度</div><div class="dv">' + (e.severity||'-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">RPN评分</div><div class="dv">' + (e.rpn_score != null ? e.rpn_score : '-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">状态</div><div class="dv"><span class="badge badge-' + getStatusBadge(e.status) + '">' + e.status + '</span></div></div>' +
    '<div class="detail-item"><div class="dl">责任部门</div><div class="dv">' + (e.responsible_dept||'-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">关联产品</div><div class="dv">' + (e.product_name||'-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">批号</div><div class="dv">' + (e.batch_no||'-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">发生时间</div><div class="dv">' + (e.occurred_at ? formatDate(e.occurred_at) : '-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">上报人</div><div class="dv">' + (e.reported_by||'-') + '</div></div>' +
    '<div class="detail-item"><div class="dl">创建时间</div><div class="dv">' + formatDate(e.created_at) + '</div></div></div>' +
    // Add CLIA product info if available
    (e.product_id ? '<div style="margin-top:12px;padding:12px;background:var(--accent-light);border-radius:var(--radius);font-size:13px;" id="eventProductInfo">加载产品信息...</div>' : '') +
    '<div style="margin-top:16px"><div class="dl" style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">事件描述</div>' +
    '<div style="background:var(--bg);padding:12px;border-radius:var(--radius);font-size:14px">' + (e.description||'无') + '</div></div>';
  // Load product CQA/CMA/CPP asynchronously
  if (e.product_id) {
    apiGet('/products').then(function(prods) {
      var p = (prods||[]).find(function(x) { return x.id === e.product_id; });
      var info = document.getElementById('eventProductInfo');
      if (info && p && (p.cqa_list || p.cma_list || p.cpp_list)) {
        info.innerHTML = '<strong>🧬 CLIA 产品质量属性</strong><br>' +
          (p.cqa_list ? '📊 <b>CQA:</b> ' + p.cqa_list + '<br>' : '') +
          (p.cma_list ? '🧪 <b>CMA:</b> ' + p.cma_list + '<br>' : '') +
          (p.cpp_list ? '⚙️ <b>CPP:</b> ' + p.cpp_list : '');
      } else if (info) { info.style.display = 'none'; }
    });
  }
  if ((data.auditLogs||[]).length > 0) {
    html += '<div style="margin-top:20px"><h4 style="margin-bottom:12px">审计追踪</h4><div class="timeline">' + data.auditLogs.map(function(l) {
      return '<div class="timeline-item"><div class="ts">' + formatDate(l.timestamp) + ' | ' + (l.user||'system') + '</div><div class="td">' + l.action + ' - ' + l.detail + '</div></div>';
    }).join('') + '</div></div>';
  }
  html += '<div style="margin-top:16px;display:flex;gap:8px;"><button class="btn btn-accent btn-sm" onclick="analyzeEventWithAI(\'' + e.id + '\')">🤖 AI 智能分析</button>' +
    '<button class="btn btn-outline btn-sm" onclick="closeModal(\'eventDetailModal\')">关闭</button></div>';
  document.getElementById('eventDetailContent').innerHTML = html;
  openModal('eventDetailModal');
}

// ============================================================
// CAPA
// ============================================================
async function loadCAPA(filter) {
  if (filter !== undefined) currentCAPAFilter = currentCAPAFilter === filter ? '' : filter;
  var result = await apiGet('/capa?limit=100');
  if (!result) return;
  var capas = result.data || result;

  var rows = capas;
  if (currentCAPAFilter === 'Open') rows = rows.filter(function(c) { return c.status === 'Open'; });
  else if (currentCAPAFilter === 'In Progress') rows = rows.filter(function(c) { return c.status === 'In Progress'; });
  else if (currentCAPAFilter === 'Overdue') rows = rows.filter(function(c) { return c.due_date && c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed'; });

  var tbody = document.querySelector('#capaTable tbody');
  tbody.innerHTML = rows.length ? rows.map(function(c) {
    var isOverdue = c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed';
    return '<tr><td>' + c.id + '</td><td>' + c.title + '</td><td>' + (c.defect_mode||'-') + '</td>' +
      '<td>' + (c.root_cause_category||'-') + '</td>' +
      '<td><span class="badge badge-' + getStatusBadge(c.status) + '">' + c.status + '</span></td>' +
      '<td>' + (c.assignee||'-') + '</td>' +
      '<td>' + (c.due_date||'-') + (isOverdue ? ' ⚠️' : '') + '</td>' +
      '<td>' + (c.effectiveness||'-') + '</td>' +
      '<td>' + (c.verified_by||'-') + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="editCAPA(\'' + c.id + '\')">编辑</button> ' +
      '<button class="btn btn-danger btn-sm" onclick="deleteCAPA(\'' + c.id + '\')">删除</button></td></tr>';
  }).join('') : '<tr><td colspan="10"><div class="empty-state">暂无 CAPA 记录</div></td></tr>';
}

function filterCAPA(status) { currentCAPAFilter = currentCAPAFilter === status ? '' : status; loadCAPA(); }

async function openCAPAModal(editId) {
  var events = await apiGet('/events');
  var sel = document.getElementById('capaEvent');
  sel.innerHTML = '<option value="">无</option>' + (events.data||events||[]).map(function(e) { return '<option value="' + e.id + '">' + e.id + ' ' + e.event_type + '</option>'; }).join('');

  if (editId) {
    var result = await apiGet('/capa?limit=200');
    var capas = result.data || result;
    var c = capas.find(function(x) { return x.id === editId; });
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
  var data = {
    title: document.getElementById('capaTitle').value,
    event_id: document.getElementById('capaEvent').value || null,
    root_cause: document.getElementById('capaRootCause').value,
    action_plan: document.getElementById('capaActionPlan').value,
    assignee: document.getElementById('capaAssignee').value,
    due_date: document.getElementById('capaDueDate').value,
    effectiveness: document.getElementById('capaEffectiveness').value,
    status: document.getElementById('capaStatus').value,
  };
  if (!data.title || !data.action_plan) { showToast('请填写标题和行动计划', 'warning'); return; }
  var id = document.getElementById('capaId').value;
  if (id) { await apiPut('/capa/' + id, data); }
  else { await apiPost('/capa', data); }
  closeModal('capaModal');
  loadCAPA();
  showToast('保存成功', 'success');
}

async function deleteCAPA(id) {
  confirmAction('确定删除此 CAPA 记录？', async function() {
    await apiDelete('/capa/' + id);
    loadCAPA();
    showToast('已删除', 'success');
  });
}

// ============================================================
// CHANGES
// ============================================================
async function loadChanges() {
  var result = await apiGet('/changes?limit=100');
  if (!result) return;
  var changes = result.data || result;
  var tbody = document.querySelector('#changesTable tbody');
  tbody.innerHTML = changes.length ? changes.map(function(c) {
    return '<tr><td>' + c.id + '</td><td>' + c.change_type + '</td><td>' + (c.product_id||'-') + '</td>' +
      '<td><span class="badge badge-' + getRiskBadge(c.risk) + '">' + c.risk + '</span></td>' +
      '<td>' + (c.impact||'').slice(0,40) + '</td><td>' + (c.validation_status||'-') + '</td>' +
      '<td><span class="badge badge-' + getStatusBadge(c.status) + '">' + c.status + '</span></td>' +
      '<td>' + (c.initiator||'-') + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="approveChange(\'' + c.id + '\')">审批</button> ' +
      '<button class="btn btn-danger btn-sm" onclick="deleteChange(\'' + c.id + '\')">删除</button></td></tr>';
  }).join('') : '<tr><td colspan="9"><div class="empty-state">暂无变更记录</div></td></tr>';
}

async function openChangeModal() {
  var products = await apiGet('/products');
  document.getElementById('chgProduct').innerHTML = '<option value="">请选择</option>' + (products||[]).map(function(p) { return '<option value="' + p.id + '">' + p.product_name + '</option>'; }).join('');
  document.getElementById('chgId').value = '';
  document.getElementById('changeForm').reset();
  openModal('changeModal');
}

async function saveChange() {
  var data = {
    change_type: document.getElementById('chgType').value,
    risk: document.getElementById('chgRisk').value,
    product_id: document.getElementById('chgProduct').value || null,
    impact: document.getElementById('chgImpact').value,
  };
  if (!data.change_type || !data.risk || !data.impact) { showToast('请填写必填字段', 'warning'); return; }
  await apiPost('/changes', data);
  closeModal('changeModal');
  loadChanges();
  showToast('提交成功', 'success');
}

async function approveChange(id) {
  var action = prompt('审批操作 (Approved / Rejected / Pending Approval):', 'Approved');
  if (action) {
    await apiPut('/changes/' + id, { status: action, validation_status: action === 'Approved' ? '待验证' : '' });
    loadChanges();
    showToast('审批完成', 'success');
  }
}

async function deleteChange(id) {
  confirmAction('确定删除此变更记录？', async function() {
    await apiDelete('/changes/' + id);
    loadChanges();
    showToast('已删除', 'success');
  });
}

// ============================================================
// MASTERS
// ============================================================
async function loadMasters() { showMasterTab('products'); }

async function showMasterTab(tab) {
  var allTabs = document.querySelectorAll('#page-masters .tab');
  allTabs.forEach(function(t) { t.classList.remove('active'); });
  var activeTab = document.querySelector('#page-masters .tab[onclick*="' + tab + '"]');
  if (activeTab) activeTab.classList.add('active');

  document.getElementById('master-products').style.display = tab === 'products' ? '' : 'none';
  document.getElementById('master-suppliers').style.display = tab === 'suppliers' ? '' : 'none';

  if (tab === 'products') {
    var products = await apiGet('/products');
    var tbody = document.querySelector('#productsTable tbody');
    tbody.innerHTML = (products||[]).map(function(p) {
      return '<tr class="clickable" onclick="viewProduct(\'' + p.id + '\')" title="点击查看产品详情">' +
        '<td>' + p.id + '</td><td>' + p.product_name + '</td><td>' + (p.product_category||'-') + '</td><td>' + (p.detection_tech||'-') + '</td>' +
        '<td><span class="badge badge-' + getRiskBadge(p.risk_class) + '">' + p.risk_class + '</span></td>' +
        '<td>' + (p.lifecycle_status||'-') + '</td><td>' + (p.regulatory_status||'-') + '</td><td>' + (p.reg_no||p.product_code||'-') + '</td>' +
        '<td>' + (p.bqi ? '<span style="font-weight:700;color:' + (p.bqi>=90?'#10B981':p.bqi>=70?'#F59E0B':'#EF4444') + ';">' + p.bqi + '</span>' : '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="8"><div class="empty-state">暂无产品数据</div></td></tr>';
  } else {
    var suppliers = await apiGet('/suppliers');
    var tbody2 = document.querySelector('#suppliersTable tbody');
    tbody2.innerHTML = (suppliers||[]).map(function(s) {
      return '<tr><td>' + s.id + '</td><td>' + s.supplier_name + '</td><td>' + (s.supplier_code||'-') + '</td><td>' + (s.category||'-') + '</td><td>' + (s.material_category||'-') + '</td><td><span class="badge badge-' + getRiskBadge(s.risk_level) + '">' + s.risk_level + '</span></td><td>' + (s.risk_score != null ? s.risk_score : '-') + '</td><td>' + (s.quality_score != null ? '⭐'.repeat(Math.round(s.quality_score/20)) + ' ' + s.quality_score : '-') + '</td><td>' + (s.certification||'-') + '</td><td>' + (s.audit_result||'-') + '</td><td>' + (s.incoming_pass_rate != null ? s.incoming_pass_rate + '%' : '-') + '</td><td>' + (s.scar_count != null ? s.scar_count : '-') + '</td><td><button class="btn btn-outline btn-sm" onclick="editSupplier(\'' + s.id + '\')">编辑</button> <button class="btn btn-danger btn-sm" onclick="deleteSupplier(\'' + s.id + '\')">删除</button></td></tr>';
    }).join('') || '<tr><td colspan="13"><div class="empty-state">暂无供应商数据</div></td></tr>';
  }
}

async function openSupplierModal() {
  document.getElementById('supId').value = '';
  document.getElementById('supplierForm').reset();
  openModal('supplierModal');
}

async function editSupplier(id) {
  var s = await apiGet('/suppliers/' + id);
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
  var data = {
    supplier_name: document.getElementById('supName').value,
    category: document.getElementById('supCategory').value,
    risk_level: document.getElementById('supRisk').value,
    quality_score: parseFloat(document.getElementById('supScore').value) || null,
    certification: document.getElementById('supCert').value,
  };
  if (!data.supplier_name) { showToast('请输入供应商名称', 'warning'); return; }
  var id = document.getElementById('supId').value;
  if (id) { await apiPut('/suppliers/' + id, data); }
  else { await apiPost('/suppliers', data); }
  closeModal('supplierModal');
  showMasterTab('suppliers');
  showToast('保存成功', 'success');
}

async function deleteSupplier(id) {
  confirmAction('确定删除此供应商？', async function() {
    await apiDelete('/suppliers/' + id);
    showMasterTab('suppliers');
    showToast('已删除', 'success');
  });
}

// ============================================================
// AUDIT LOGS
// ============================================================
async function loadAuditLogs() {
  var result = await apiGet('/audit-logs?limit=200');
  if (!result) return;
  var logs = result.data || result;
  var tbody = document.querySelector('#auditTable tbody');
  tbody.innerHTML = (logs||[]).length ? logs.map(function(l) {
    return '<tr><td>' + formatDate(l.timestamp) + '</td><td>' + l.action + '</td><td>' + l.table_name + '</td><td>' + l.record_id + '</td><td>' + (l.detail||'') + '</td><td>' + (l.user||'system') + '</td></tr>';
  }).join('') : '<tr><td colspan="6"><div class="empty-state">暂无审计日志</div></td></tr>';
}

// ============================================================
// PRODUCT DETAIL — 产品质量档案
// ============================================================
async function viewProduct(id) {
  var products = await apiGet('/products');
  var p = (products||[]).find(function(x) { return x.id === id; });
  if (!p) return;

  var bqiColor = (p.bqi||0) >= 90 ? '#10B981' : (p.bqi||0) >= 70 ? '#F59E0B' : '#EF4444';
  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">' +
    '<div><span style="color:var(--text-secondary);">产品编码</span><br><strong>' + (p.product_code||p.id) + '</strong></div>' +
    '<div><span style="color:var(--text-secondary);">产品名称</span><br><strong>' + (p.product_name||'-') + '</strong></div>' +
    '<div><span style="color:var(--text-secondary);">类别</span><br>' + (p.product_category||'-') + '</div>' +
    '<div><span style="color:var(--text-secondary);">检测技术</span><br>' + (p.detection_tech||'-') + '</div>' +
    '<div><span style="color:var(--text-secondary);">风险等级</span><br><span class="badge badge-' + getRiskBadge(p.risk_class) + '">' + (p.risk_class||'-') + '</span></div>' +
    '<div><span style="color:var(--text-secondary);">BQI 批次健康指数</span><br><span style="font-size:24px;font-weight:700;color:' + bqiColor + ';">' + (p.bqi||'N/A') + '</span></div>' +
    '<div><span style="color:var(--text-secondary);">注册编号</span><br>' + (p.reg_no||'-') + '</div>' +
    '<div><span style="color:var(--text-secondary);">规格</span><br>' + (p.spec_model||'-') + '</div>' +
    '<div><span style="color:var(--text-secondary);">储运条件</span><br>' + (p.storage_condition||'-') + '</div>' +
    '<div><span style="color:var(--text-secondary);">有效期</span><br>' + (p.shelf_life||'-') + '</div>' +
    (p.throughput ? '<div><span style="color:var(--text-secondary);">通量</span><br>' + p.throughput + '</div>' : '') +
    '<div><span style="color:var(--text-secondary);">适应症</span><br>' + (p.indications||'-') + '</div>' +
    '</div>';

  // Batch info
  if (p.batch_no) {
    html += '<div style="margin-top:14px;padding:12px;background:var(--bg);border-radius:var(--radius);"><strong>📦 当前批次</strong><br>' +
      '批号: ' + p.batch_no + ' | 生产日期: ' + (p.batch_date||'-') + '<br>' +
      '基地: ' + (p.base||'-') + ' | 产线: ' + (p.line||'-') + ' | 数量: ' + (p.batch_qty||'-') + '<br>' +
      '状态: <span class="badge badge-warning">' + (p.batch_status||'-') + '</span></div>';
  }

  // Components
  if (p.components) {
    html += '<div style="margin-top:10px;"><span style="color:var(--text-secondary);font-size:12px;">🧪 <b>组分</b></span><br>' + p.components.replace(/\//g, '<br>') + '</div>';
  }

  // CQA/CMA/CPP
  if (p.cqa_list || p.cma_list || p.cpp_list) {
    html += '<div style="margin-top:14px;padding:12px;background:var(--accent-light);border-radius:var(--radius);">' +
      '<strong>🧬 CLIA 质量属性</strong><br>' +
      (p.cqa_list ? '📊 <b>CQA:</b> ' + p.cqa_list + '<br>' : '') +
      (p.cma_list ? '🧪 <b>CMA:</b> ' + p.cma_list + '<br>' : '') +
      (p.cpp_list ? '⚙️ <b>CPP:</b> ' + p.cpp_list : '') +
      '</div>';
  }

  // Show in event detail modal
  document.getElementById('eventDetailContent').innerHTML = html;
  document.getElementById('eventModalTitle') && (document.getElementById('eventModalTitle').textContent = '产品档案: ' + (p.product_code||p.id));
  openModal('eventDetailModal');
}
// ============================================================
async function loadQCP() {
  var result = await apiGet('/qcp?limit=200');
  if (!result) return;
  var qcps = result.data || result;
  var tbody = document.querySelector('#qcpTable tbody');
  tbody.innerHTML = (qcps||[]).length ? qcps.map(function(q) {
    var cqaCpp = [q.cqa, q.cma, q.cpp].filter(Boolean).join(' / ') || '-';
    return '<tr><td>' + (q.qcp_code||q.id) + '</td>' +
      '<td>' + (q.module||q.domain||'-') + '</td>' +
      '<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (q.name||q.control_name||'') + '">' + (q.name||q.control_name||'-') + '</td>' +
      '<td>' + (q.stage||'-') + '</td>' +
      '<td><span class="badge badge-' + getRiskBadge(q.risk_level) + '">' + (q.risk_level||'-') + '</span></td>' +
      '<td>' + (q.control_method||q.detection_method||'-') + '</td>' +
      '<td>' + (q.key_param||q.key_params||'-') + '</td>' +
      '<td style="font-size:11px;">' + cqaCpp + '</td>' +
      '<td style="font-size:11px;max-width:100px;overflow:hidden;text-overflow:ellipsis;" title="' + (q.spec_standard||q.standard||'') + '">' + (q.spec_standard||q.standard||'-') + '</td>' +
      '<td style="font-size:11px;color:var(--danger);">' + (q.alert_rule||'-') + '</td>' +
      '<td>' + (q.frequency||'-') + '</td>' +
      '<td>' + (q.owner||'-') + '</td></tr>';
  }).join('') : '<tr><td colspan="12"><div class="empty-state">暂无质量控制点数据</div></td></tr>';
}

// ============================================================
// RISKS
// ============================================================
async function loadRisks() {
  var result = await apiGet('/risks?limit=200');
  if (!result) return;
  var risks = result.data || result;
  var tbody = document.querySelector('#riskTable tbody');
  tbody.innerHTML = (risks||[]).length ? risks.map(function(r) {
    return '<tr><td>' + r.id + '</td><td>' + (r.hazard_description||'').slice(0,40) + '</td><td>' + (r.severity||'-') + '</td><td>' + (r.occurrence||'-') + '</td><td>' + (r.detectability||'-') + '</td><td>' + (r.rpn||'-') + '</td><td><span class="badge badge-' + getRiskBadge(r.risk_level) + '">' + (r.risk_level||'-') + '</span></td><td>' + (r.fmea_type||'-') + '</td><td>' + (r.product_name||'-') + '</td><td>' + ((r.control_measures||'').slice(0,30)) + '</td><td><span class="badge badge-' + getStatusBadge(r.status) + '">' + (r.status||'-') + '</span></td></tr>';
  }).join('') : '<tr><td colspan="11"><div class="empty-state">暂无风险FMEA数据</div></td></tr>';
}

// ============================================================
// UTILITIES
// ============================================================
function formatDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleDateString('zh-CN'); } catch(e) { return d; }
}

function getRiskBadge(level) {
  var map = { Low: 'success', Medium: 'warning', High: 'danger', Critical: 'danger', III: 'danger', II: 'warning', I: 'success' };
  return map[level] || 'default';
}

function getStatusBadge(status) {
  if (!status) return 'default';
  if (status.indexOf('Closed') !== -1 || status === 'Approved') return 'success';
  if (status.indexOf('Investigation') !== -1 || status.indexOf('Progress') !== -1 || status.indexOf('Pending') !== -1) return 'warning';
  if (status.indexOf('Open') !== -1 || status === 'Created') return 'info';
  return 'default';
}

// ---- TOAST NOTIFICATIONS ----
function showToast(msg, type) {
  type = type || 'info';
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = msg;
  toast.style.cssText = 'position:fixed;top:20px;right:20px;padding:12px 24px;border-radius:8px;color:white;z-index:9999;animation:slideIn 0.3s ease;font-size:14px;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,.2);';
  if (type === 'success') toast.style.background = '#10B981';
  else if (type === 'error') toast.style.background = '#EF4444';
  else if (type === 'warning') toast.style.background = '#F59E0B';
  else toast.style.background = '#3B82F6';
  document.body.appendChild(toast);
  setTimeout(function() { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, 2500);
  setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 2800);
}

// Global error handlers
window.addEventListener('error', function(e) { console.error('Global error:', e.error); showToast('操作出错，请刷新页面重试', 'error'); });
window.addEventListener('unhandledrejection', function(e) { console.error('Unhandled rejection:', e.reason); });

console.log('🩺 FDQH Platform v1.1 initialized');
