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

// ---- 修改密码 ----
function openPasswordModal() {
  document.getElementById('oldPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  document.getElementById('pwdMsg').innerHTML = '';
  openModal('passwordModal');
}

async function changePassword() {
  var oldPwd = document.getElementById('oldPassword').value;
  var newPwd = document.getElementById('newPassword').value;
  var confirmPwd = document.getElementById('confirmPassword').value;
  var msg = document.getElementById('pwdMsg');
  
  if (!oldPwd) { msg.innerHTML = '<span style="color:#DC2626;">请输入旧密码</span>'; return; }
  if (!newPwd || newPwd.length < 6) { msg.innerHTML = '<span style="color:#DC2626;">新密码至少6位</span>'; return; }
  if (newPwd !== confirmPwd) { msg.innerHTML = '<span style="color:#DC2626;">两次输入的新密码不一致</span>'; return; }
  
  var res = await apiPut('/auth/password', { oldPassword: oldPwd, newPassword: newPwd });
  if (!res) return;
  
  if (res.success) {
    msg.innerHTML = '<span style="color:#059669;">✅ ' + res.message + '</span>';
    showToast('密码修改成功', 'success');
    setTimeout(function() { closeModal('passwordModal'); }, 1200);
  }
}

// ---- NAVIGATION ----
function toggleNavSub(page) {
  var parent = document.getElementById('navEventsParent');
  var arrow = document.getElementById('navEventsArrow');
  if (parent.classList.contains('expanded')) {
    parent.classList.remove('expanded');
    arrow.textContent = '▶';
  } else {
    parent.classList.add('expanded');
    arrow.textContent = '▼';
  }
  // Also navigate to the parent page
  navigate(page);
}

function navigate(page) {
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  var pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  
  // Clear all active states
  document.querySelectorAll('.sidebar nav a').forEach(function(a) { a.classList.remove('active'); });
  document.querySelectorAll('.nav-sub a').forEach(function(a) { a.classList.remove('active'); });
  document.querySelectorAll('.nav-parent > a').forEach(function(a) { a.classList.remove('active'); });
  
  // Set active state on the target link
  var navEl = document.querySelector('.sidebar a[data-page="' + page + '"]');
  if (navEl) navEl.classList.add('active');
  
  // Auto-expand events sub-menu when sub-item is active
  var subPages = ['complaints', 'capa', 'workshop'];
  if (subPages.indexOf(page) >= 0) {
    document.getElementById('navEventsParent').classList.add('expanded');
    document.getElementById('navEventsArrow').textContent = '▼';
  }

  switch(page) {
    case 'dashboard': loadDashboard(); break;
    case 'events': showEventsSubPage('categories'); loadEvents(); break;
    case 'capa': loadCAPA(); break;
    case 'changes': loadChanges(); break;
    case 'masters': loadMasters(); break;
    case 'qcp': loadQCP(); break;
    case 'risks': loadRisks(); break;
    case 'audit': loadAuditLogs(); break;
    case 'ai': loadAIAssistant(); break;
    case 'complaints': loadComplaintsDashboard(); break;
    case 'workshop': loadWorkshopDashboard(); break;
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

  // ========== 投诉KPI摘要（驾驶舱内嵌） ==========
  loadComplaintSummary();

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

// ===== 驾驶舱投诉KPI摘要 =====
async function loadComplaintSummary() {
  var data = await apiGet('/dashboard/complaints');
  if (!data) return;

  var k = data.kpi;
  var html = '<div class="card" style="margin-bottom:20px;"><div class="card-body" style="padding:14px 20px;">' +
    '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">' +
    '<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:20px;">📢</span><a href="javascript:navigate(\'complaints\')" style="font-weight:600;color:var(--accent);text-decoration:none;font-size:14px;">客户投诉</a></div>' +
    '<div style="flex:1;display:flex;gap:16px;flex-wrap:wrap;font-size:13px;">' +
    '<span>📊 累计: <b style="color:#EF4444;">' + k.total + '</b> 件</span>' +
    '<span>🔴 未关闭: <b>' + k.open + '</b></span>' +
    '<span>⚠️ 高风险: <b style="color:#DC2626;">' + k.highRisk + '</b></span>' +
    '<span>✅ 关闭率: <b>' + k.closeRate + '%</b></span>' +
    '<span>🔁 重复: <b>' + k.repeat + '</b></span>' +
    '</div>' +
    '<a href="javascript:navigate(\'complaints\')" class="btn btn-accent btn-sm">查看详情 →</a>' +
    '</div></div></div>';

  // Insert after statsGrid or before quality modules
  var target = document.getElementById('tqmKpiSection');
  if (target) {
    var el = document.getElementById('complaintSummary');
    if (el) el.remove();
    var div = document.createElement('div');
    div.id = 'complaintSummary';
    div.innerHTML = html;
    target.after(div);
  }
}

// ===== 生产质量一体化 Workshop 看板 =====
async function loadWorkshopDashboard() {
  var data = await apiGet('/dashboard/workshop');
  if (!data) return;
  var html = '';

  // === Row 1: KPI cards ===
  html += '<div class="module-summary">' +
    '<div class="module-summary-card ms-info"><div class="ms-value">' + (data.total||262) + '</div><div class="ms-label">📊 问题总数</div></div>' +
    '<div class="module-summary-card ms-fail"><div class="ms-value">143</div><div class="ms-label">🔴 持续存在</div></div>' +
    '<div class="module-summary-card ms-warn"><div class="ms-value">73</div><div class="ms-label">🟡 单次</div></div>' +
    '<div class="module-summary-card ms-info"><div class="ms-value">55</div><div class="ms-label">⚙️ 流程执行失败</div><div class="ms-target">@供应链质量</div></div>' +
    '<div class="module-summary-card ms-info"><div class="ms-value">47</div><div class="ms-label">📝 流程无效</div><div class="ms-target">@研发质量</div></div>' +
    '</div>';

  // === Row 2: 过程分组 + 质量原因 帕累托 ===
  html += '<div class="charts-row">' +
    '<div class="card"><div class="card-header"><h3>📊 过程分组帕累托</h3></div><div class="card-body"><div class="chart-container"><canvas id="wsProcess"></canvas></div></div></div>' +
    '<div class="card"><div class="card-header"><h3>🎯 质量原因帕累托</h3></div><div class="card-body"><div class="chart-container"><canvas id="wsCause"></canvas></div></div></div>' +
    '</div>';

  // === Row 3: 根因交叉分析 + 产品线 ===
  html += '<div class="charts-row">' +
    '<div class="card"><div class="card-header"><h3>🔍 根本原因 × 质量原因</h3></div><div class="card-body"><div class="chart-container"><canvas id="wsRoot"></canvas></div></div></div>' +
    '<div class="card"><div class="card-header"><h3>📦 产品线分布 + 频次</h3></div><div class="card-body"><div class="chart-container"><canvas id="wsProduct"></canvas></div></div></div>' +
    '</div>';

  // === Row 4: 解决方案四象限 ===
  html += '<div class="card" style="margin-bottom:24px;"><div class="card-header"><h3>🎯 解决方案四象限矩阵 (执行难易 × 影响大小)</h3><span style="font-size:11px;">来源: Workshop-汇报版本输出 Sheet 2</span></div>' +
    '<div class="card-body">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
    '<div style="background:#D1FAE5;border-radius:8px;padding:12px;"><b style="color:#065F46;">🟢 快赢区 Quick Wins (易+高影响)</b>' +
    data.solutions.filter(function(s){return s.quad==='quick-win';}).map(function(s){return '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid #A7F3D0;"><b>' + s.solution + '</b><br>[' + s.module + '] ' + s.cause + ' | ' + s.owner + ' | ' + s.deadline + '</div>';}).join('') + '</div>' +
    '<div style="background:#DBEAFE;border-radius:8px;padding:12px;"><b style="color:#1E40AF;">🔵 战略区 Strategic (难+高影响)</b>' +
    data.solutions.filter(function(s){return s.quad==='strategic';}).slice(0,6).map(function(s){return '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid #BFDBFE;"><b>' + s.solution + '</b><br>[' + s.module + '] ' + s.cause + ' | ' + s.owner + ' | ' + s.deadline + '</div>';}).join('') + '</div>' +
    '<div style="background:#FEF3C7;border-radius:8px;padding:12px;"><b style="color:#92400E;">🟡 填充区 Fill (易+中影响)</b>' +
    data.solutions.filter(function(s){return s.quad==='fill';}).map(function(s){return '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid #FDE68A;"><b>' + s.solution + '</b><br>[' + s.module + '] ' + s.cause + ' | ' + s.owner + '</div>';}).join('') + '</div>' +
    '<div style="background:#F3F4F6;border-radius:8px;padding:12px;"><b style="color:#4B5563;">⚪ 待评估</b>' +
    data.solutions.filter(function(s){return !s.quad||s.quad==='';}).map(function(s){return '<div style="font-size:11px;padding:4px 0;"><b>' + s.solution + '</b><br>[' + s.module + '] ' + s.cause + '</div>';}).join('') + '</div>' +
    '</div></div></div>';

  // === Row 5: 行动项跟进 (快赢区) ===
  var ai = data.actionItems || [];
  html += '<div class="card" style="margin-bottom:24px;"><div class="card-header"><h3>⚡ 行动项跟进 — 快赢区 (Quick Wins)</h3><span style="font-size:11px;">' + ai.length + ' 项</span></div>' +
    '<div class="card-body" style="overflow-x:auto;">' +
    '<table class="data-table" style="min-width:900px;">' +
    '<thead><tr>' +
    '<th>行动项</th><th>归属模块</th><th>责任人</th><th>时间节点</th><th>完成进度</th><th>状态</th><th>备注</th>' +
    '</tr></thead><tbody>';
  ai.forEach(function(item) {
    var lightIcon = { 'green': '🟢', 'yellow': '🟡', 'red': '🔴' };
    var lightBg = { 'green': '#D1FAE5', 'yellow': '#FEF3C7', 'red': '#FEE2E2' };
    var statusColor = { '已完成': 'var(--pass)', '进行中': 'var(--warn)', '未启动': 'var(--fail)' };
    html += '<tr>' +
      '<td><b>' + (item.solution || '') + '</b></td>' +
      '<td><span style="font-size:11px;color:var(--text-muted);">' + (item.module || '') + '</span></td>' +
      '<td><b>' + (item.owner || '-') + '</b></td>' +
      '<td>' + (item.deadline || '-') + '</td>' +
      '<td>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<div style="flex:1;background:#E5E7EB;border-radius:10px;height:8px;overflow:hidden;">' +
            '<div style="width:' + (item.progress || 0) + '%;height:100%;background:' + (item.progress >= 80 ? '#10B981' : item.progress >= 40 ? '#F59E0B' : '#EF4444') + ';border-radius:10px;"></div>' +
          '</div>' +
          '<span style="font-size:11px;font-weight:600;">' + (item.progress || 0) + '%</span>' +
        '</div>' +
      '</td>' +
      '<td><span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;background:' + (lightBg[item.light] || '#F3F4F6') + ';">' + (lightIcon[item.light] || '') + ' ' + (item.status || '-') + '</span></td>' +
      '<td style="font-size:11px;color:var(--text-muted);max-width:160px;">' + (item.note || '') + '</td>' +
      '</tr>';
  });
  html += '</tbody></table></div></div>';

  // === Row 6: 专项进展跟进 (战略区) ===
  var sp = data.strategicProjects || [];
  html += '<div class="card" style="margin-bottom:24px;"><div class="card-header"><h3>🎯 专项进展跟进 — 战略区 (Strategic)</h3><span style="font-size:11px;">' + sp.length + ' 项</span></div>' +
    '<div class="card-body" style="overflow-x:auto;">';

  sp.forEach(function(proj) {
    var lightIcon = { 'green': '🟢', 'yellow': '🟡', 'red': '🔴' };
    var lightBg = { 'green': '#D1FAE5', 'yellow': '#FEF3C7', 'red': '#FEE2E2' };
    html += '<div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px;' + (proj.hasProject === '是' ? '' : 'opacity:0.65;') + '">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">' +
        '<b style="font-size:15px;">' + (proj.solution || '') + '</b>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<span style="font-size:11px;color:var(--text-muted);">' + (proj.module || '') + '</span>' +
          '<span style="padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600;' + (proj.hasProject === '是' ? 'background:#D1FAE5;color:#065F46;' : 'background:#FEE2E2;color:#991B1B;') + '">' + (proj.hasProject === '是' ? '✅ 已立项' : '❌ 未立项') + '</span>' +
          '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;background:' + (lightBg[proj.light] || '#F3F4F6') + ';">' + (lightIcon[proj.light] || '') + ' ' + (proj.status || '-') + '</span>' +
        '</div>' +
      '</div>';

    // Info row: owner, deadline, progress
    html += '<div style="display:flex;flex-wrap:wrap;gap:16px;font-size:13px;margin-bottom:8px;">' +
      '<span>👤 <b>责任人:</b> ' + (proj.owner || '-') + '</span>' +
      '<span>📅 <b>截止:</b> ' + (proj.deadline || '-') + '</span>' +
      '<span style="display:flex;align-items:center;gap:4px;">📊 <b>进度:</b> ' +
        '<div style="width:100px;background:#E5E7EB;border-radius:8px;height:6px;overflow:hidden;">' +
          '<div style="width:' + (proj.progress || 0) + '%;height:100%;background:' + (proj.progress >= 80 ? '#10B981' : proj.progress >= 40 ? '#F59E0B' : '#EF4444') + ';border-radius:8px;"></div>' +
        '</div> ' + (proj.progress || 0) + '%</span>' +
      '</div>';

    // Milestones (Gantt-like)
    var ms = proj.milestones || [];
    if (ms.length > 0) {
      html += '<div style="margin-top:8px;"><b style="font-size:12px;">📌 里程碑 / 甘特图:</b>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">';
      ms.forEach(function(m) {
        html += '<div style="flex:0 0 auto;padding:6px 12px;border-radius:6px;font-size:11px;text-align:center;' +
          (m.done ? 'background:#D1FAE5;border:1px solid #6EE7B7;' : 'background:#F3F4F6;border:1px solid #E5E7EB;') + '">' +
          (m.done ? '✅ ' : '⏳ ') + m.name + '<br><span style="color:var(--text-muted);">' + m.date + '</span>' +
          '</div>';
      });
      html += '</div></div>';
    }

    // Difficulties & Support
    html += '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:16px;font-size:12px;">' +
      '<span>⚠️ <b>困难及对策:</b> ' + (proj.difficulty || '-') + '</span>' +
      '<span>🆘 <b>所需资源/支持:</b> ' + (proj.support || '-') + '</span>' +
      '</div>';

    html += '</div>'; // end project card
  });
  html += '</div></div>';

  document.getElementById('workshopContent').innerHTML = html;

  // === Render charts ===
  setTimeout(function() {
    // 1. Process Pareto
    var pp = data.processPareto;
    if (document.getElementById('wsProcess')) {
      var ctx1 = document.getElementById('wsProcess').getContext('2d');
      if (charts['wsProcess']) charts['wsProcess'].destroy();
      charts['wsProcess'] = new Chart(ctx1, {
        type: 'bar', data: {
          labels: pp.map(function(x){return x.name + ' (' + x.count + ')';}),
          datasets: [
            { label: '问题数', data: pp.map(function(x){return x.count;}), backgroundColor: '#3B82F6', borderRadius: 4 },
            { label: '占比%', type: 'line', data: pp.map(function(x){return x.pct;}), borderColor: '#EF4444', backgroundColor:'transparent', borderWidth:2, pointRadius:3, yAxisID:'y1' }
          ]
        },
        options: { responsive:true, maintainAspectRatio:false, scales:{y:{beginAtZero:true},y1:{position:'right',min:0,max:100,grid:{drawOnChartArea:false}}}, plugins:{legend:{position:'top'}} }
      });
    }
    // 2. Cause Pareto
    var cp = data.causePareto;
    if (document.getElementById('wsCause')) {
      var ctx2 = document.getElementById('wsCause').getContext('2d');
      if (charts['wsCause']) charts['wsCause'].destroy();
      charts['wsCause'] = new Chart(ctx2, {
        type: 'bar', data: {
          labels: cp.map(function(x){return x.name + ' (' + x.count + ')';}),
          datasets: [
            { label: '问题数', data: cp.map(function(x){return x.count;}), backgroundColor: ['#3B82F6','#F59E0B','#10B981','#8B5CF6','#6B7280'], borderRadius: 4 },
            { label: '占比%', type: 'line', data: cp.map(function(x){return x.pct;}), borderColor: '#EF4444', backgroundColor:'transparent', borderWidth:2, pointRadius:3, yAxisID:'y1' }
          ]
        },
        options: { responsive:true, maintainAspectRatio:false, scales:{y:{beginAtZero:true},y1:{position:'right',min:0,max:100,grid:{drawOnChartArea:false}}}, plugins:{legend:{position:'top'}} }
      });
    }
    // 3. Root cause cross
    var rc = data.rootCauseCross;
    if (document.getElementById('wsRoot')) {
      var ctx3 = document.getElementById('wsRoot').getContext('2d');
      if (charts['wsRoot']) charts['wsRoot'].destroy();
      charts['wsRoot'] = new Chart(ctx3, {
        type: 'bar', data: {
          labels: rc.map(function(x){return x.cause;}),
          datasets: [
            { label: '无流程', data: rc.map(function(x){return x.noProcess;}), backgroundColor: '#EF4444', borderRadius: 2 },
            { label: '流程无效', data: rc.map(function(x){return x.invalidProcess;}), backgroundColor: '#F59E0B', borderRadius: 2 },
            { label: '流程执行失败', data: rc.map(function(x){return x.execFail;}), backgroundColor: '#3B82F6', borderRadius: 2 }
          ]
        },
        options: { responsive:true, maintainAspectRatio:false, scales:{x:{stacked:true},y:{stacked:true,beginAtZero:true}}, plugins:{legend:{position:'top'}} }
      });
    }
    // 4. Product+Frequency
    if (document.getElementById('wsProduct')) {
      var ctx4 = document.getElementById('wsProduct').getContext('2d');
      if (charts['wsProduct']) charts['wsProduct'].destroy();
      var pd = data.productDist;
      var fd = data.freqDist;
      charts['wsProduct'] = new Chart(ctx4, {
        type: 'bar', data: {
          labels: pd.map(function(x){return x.name;}),
          datasets: [
            { label: '问题数', data: pd.map(function(x){return x.count;}), backgroundColor: '#EC4899', borderRadius: 4 }
          ]
        },
        options: { responsive:true, maintainAspectRatio:false, scales:{y:{beginAtZero:true}}, plugins:{legend:{display:false}} }
      });
    }
  }, 300);
}
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

// ===== 投诉看板 =====
var complaintFilter = { source: '', cause: '', search: '', page: 1 };

async function loadComplaintsDashboard() {
  var data = await apiGet('/dashboard/complaints?page=' + complaintFilter.page + '&source=' + encodeURIComponent(complaintFilter.source) + '&cause=' + encodeURIComponent(complaintFilter.cause) + '&search=' + encodeURIComponent(complaintFilter.search));
  if (!data) return;
  var html = '';

  // === KPI Cards ===
  var k = data.kpi;
  html += '<div class="module-summary">' +
    '<div class="module-summary-card ms-info"><div class="ms-value">' + k.total + '</div><div class="ms-label">📢 投诉总数</div><div class="ms-target">2026上半年累计</div></div>' +
    '<div class="module-summary-card ' + (k.open > 0 ? 'ms-warn' : 'ms-pass') + '"><div class="ms-value">' + k.open + '</div><div class="ms-label">🔴 未关闭</div><div class="ms-target">待处理中</div></div>' +
    '<div class="module-summary-card ms-pass"><div class="ms-value">' + k.closeRate + '%</div><div class="ms-label">✅ 关闭率</div><div class="ms-target">已关闭 ' + k.closed + ' 件</div></div>' +
    '<div class="module-summary-card ' + (k.highRisk > 0 ? 'ms-fail' : 'ms-pass') + '"><div class="ms-value">' + k.highRisk + '</div><div class="ms-label">⚠️ 高风险</div><div class="ms-target">High/Critical</div></div>' +
    '<div class="module-summary-card ' + (k.repeat > 0 ? 'ms-warn' : 'ms-pass') + '"><div class="ms-value">' + k.repeat + '</div><div class="ms-label">🔁 重复投诉</div><div class="ms-target">重复发生</div></div>' +
    '</div>';

  // === Charts Row 1: 月度趋势 + 来源分布 ===
  html += '<div class="charts-row">' +
    '<div class="card"><div class="card-header"><h3>📈 投诉月度趋势 (2026上半年)</h3></div><div class="card-body"><div class="chart-container"><canvas id="compMonthChart"></canvas></div></div></div>' +
    '<div class="card"><div class="card-header"><h3>🏷️ 投诉来源分布</h3></div><div class="card-body"><div class="chart-container"><canvas id="compSourceChart"></canvas></div></div></div>' +
    '</div>';

  // === Charts Row 2: 重复投诉列表 + Top产品 ===
  html += '<div class="charts-row">' +
    '<div class="card"><div class="card-header"><h3>🔁 重复投诉事件列表</h3><span style="font-size:11px;">' + (data.repeats||[]).length + ' 件重复投诉</span></div>' +
    '<div class="card-body no-padding"><table class="mod-table"><thead><tr><th>来源</th><th>产品</th><th>原因</th><th>描述</th></tr></thead><tbody>' +
    (data.repeats||[]).map(function(r) {
      return '<tr><td style="font-size:11px;">' + (r.source||'') + '</td><td style="font-weight:500;font-size:12px;">' + (r.product_name||'') + '</td><td><span class="badge ' + (r.cause&&r.cause.includes('设计')?'badge-danger':r.cause&&r.cause.includes('物料')?'badge-warning':'badge-info') + '">' + (r.cause||'-') + '</span></td><td style="text-align:left;font-size:11px;">' + (r.description||'').substring(0,50) + '</td></tr>';
    }).join('') + '</tbody></table></div></div>' +
    '<div class="card"><div class="card-header"><h3>🏆 Top 投诉产品</h3></div><div class="card-body no-padding"><table class="mod-table"><thead><tr><th>产品</th><th>投诉数</th><th>占比</th></tr></thead><tbody>' +
    data.topProducts.map(function(p) {
      var pct = Math.round(p.count / k.total * 100);
      return '<tr><td>' + p.name + '</td><td><b>' + p.count + '</b></td><td><div style="background:#F3F4F6;border-radius:4px;height:18px;position:relative;"><div style="background:#EF4444;height:100%;border-radius:4px;width:' + Math.min(pct, 100) + '%;"></div><span style="position:absolute;left:8px;font-size:11px;line-height:18px;">' + pct + '%</span></div></td></tr>';
    }).join('') + '</tbody></table></div></div>' +
    '</div>';

  // === Charts Row 3: 试剂分析 (环状图 + 帕累托) ===
  html += '<div class="charts-row">' +
    '<div class="card"><div class="card-header"><h3>🧪 试剂问题分类 Top10</h3><span style="font-size:11px;">环状图 · 试剂投诉原因分布</span></div><div class="card-body"><div class="chart-container"><canvas id="compReagentCause"></canvas></div></div></div>' +
    '<div class="card"><div class="card-header"><h3>🔧 仪器问题类型帕累托</h3><span style="font-size:11px;">bug清单 · 柱状+累积%</span></div><div class="card-body"><div class="chart-container"><canvas id="compPareto"></canvas></div></div></div>' +
    '</div>';

  // === Charts Row 4: 条线设计缺陷占比 + 试剂Top10 ===
  html += '<div class="charts-row">' +
    '<div class="card"><div class="card-header"><h3>📊 各条线设计缺陷占比</h3><span style="font-size:11px;">生化 · 化学发光 · 分子 · POCT · 药敏</span></div><div class="card-body"><div class="chart-container"><canvas id="compLineDesign"></canvas></div></div></div>' +
    '<div class="card"><div class="card-header"><h3>🏅 反馈试剂 Top10</h3><span style="font-size:11px;">试剂产品投诉排行</span></div><div class="card-body"><div class="chart-container"><canvas id="compReagentTop"></canvas></div></div></div>' +
    '</div>';

  // === Filters ===
  html += '<div class="card" style="margin-bottom:16px;"><div class="card-body" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:12px 16px;">' +
    '<select onchange="complaintFilter.source=this.value;complaintFilter.page=1;loadComplaintsDashboard();" style="padding:8px;border:1px solid var(--border);border-radius:6px;">' +
    '<option value="">全部来源</option>' +
    Object.keys(data.bySource).map(function(s) { return '<option value="' + s + '"' + (complaintFilter.source === s ? ' selected' : '') + '>' + s + ' (' + data.bySource[s] + ')</option>'; }).join('') +
    '</select>' +
    '<select onchange="complaintFilter.cause=this.value;complaintFilter.page=1;loadComplaintsDashboard();" style="padding:8px;border:1px solid var(--border);border-radius:6px;">' +
    '<option value="">全部原因</option>' +
    Object.keys(data.byCause).map(function(c) { return '<option value="' + c + '"' + (complaintFilter.cause === c ? ' selected' : '') + '>' + c + ' (' + data.byCause[c] + ')</option>'; }).join('') +
    '</select>' +
    '<input type="text" placeholder="搜索产品/描述..." value="' + complaintFilter.search + '" oninput="var v=this.value;clearTimeout(window._cs);window._cs=setTimeout(function(){complaintFilter.search=v;complaintFilter.page=1;loadComplaintsDashboard();},400);" style="padding:8px;border:1px solid var(--border);border-radius:6px;flex:1;min-width:150px;">' +
    '<button class="btn btn-outline btn-sm" onclick="complaintFilter={source:\'\',cause:\'\',search:\'\',page:1};loadComplaintsDashboard();">重置</button>' +
    '</div></div>';

  // === Detail Table ===
  var list = data.list;
  html += '<div class="card"><div class="card-header"><h3>📋 投诉明细</h3><span style="font-size:11px;">共 ' + list.total + ' 条</span></div>' +
    '<div class="card-body no-padding"><table class="mod-table"><thead><tr><th>产品</th><th>来源</th><th>原因</th><th>风险</th><th>状态</th><th>描述</th></tr></thead><tbody>' +
    list.data.map(function(e) {
      var rb = e.risk_level === 'High' || e.risk_level === 'Critical' ? 'badge-danger' : 'badge-warning';
      var sb = e.status === 'Closed' ? 'badge-success' : e.status === 'Open' ? 'badge-danger' : 'badge-info';
      return '<tr><td style="font-weight:500;">' + (e.product_name || '') + '</td><td style="font-size:11px;">' + (e.complaint_source || '').replace('2026上半年投诉汇总-', '') + '</td><td style="font-size:11px;">' + (e.complaint_cause || '') + '</td><td><span class="badge ' + rb + '">' + (e.risk_level || '') + '</span></td><td><span class="badge ' + sb + '">' + e.status + '</span></td><td style="font-size:11px;text-align:left;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (e.description || '').substring(0, 60) + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    '<div class="card-body" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;">' +
    '<span style="font-size:12px;color:var(--text-muted);">第 ' + list.page + ' / ' + Math.max(1, Math.ceil(list.total / 20)) + ' 页</span>' +
    '<div class="btn-group">' +
    '<button class="btn btn-outline btn-sm" ' + (list.page <= 1 ? 'disabled' : '') + ' onclick="complaintFilter.page--;loadComplaintsDashboard();">上一页</button>' +
    '<button class="btn btn-outline btn-sm" ' + (list.page * 20 >= list.total ? 'disabled' : '') + ' onclick="complaintFilter.page++;loadComplaintsDashboard();">下一页</button>' +
    '</div></div></div>';

  document.getElementById('complaintsContent').innerHTML = html;

  // === Charts ===
  setTimeout(function() {
    var months = ['1月','2月','3月','4月','5月','6月'];
    var monthData = months.map(function(m) { return data.byMonth[parseInt(m)] || 0; });
    renderChart('compMonthChart', 'bar', months, monthData, '投诉数', '#EF4444');

    var srcData = data.bySource;
    var srcLabels = Object.keys(srcData).map(function(s) { return s.replace('2026上半年投诉汇总-', ''); });
    var srcValues = Object.keys(srcData).map(function(s) { return srcData[s]; });
    renderPieChart('compSourceChart', srcLabels, srcValues, ['#3B82F6','#10B981','#F59E0B','#8B5CF6','#EC4899']);

    // === New charts (replacing removed compCauseChart) ===
    // 1. 试剂问题分类Top10 环状图
    var rcData = data.reagentCauseTop10 || [];
    if (rcData.length && document.getElementById('compReagentCause')) {
      var rcColors = ['#EF4444','#F59E0B','#3B82F6','#10B981','#8B5CF6','#EC4899','#06B6D4','#F97316','#6366F1','#14B8A6'];
      var ctx1 = document.getElementById('compReagentCause').getContext('2d');
      if (charts['compReagentCause']) charts['compReagentCause'].destroy();
      charts['compReagentCause'] = new Chart(ctx1, {
        type: 'doughnut',
        data: { labels: rcData.map(function(x) { return x.name + ' (' + x.count + ')'; }), datasets: [{ data: rcData.map(function(x) { return x.count; }), backgroundColor: rcColors.slice(0, rcData.length), borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { position: 'right', labels: { font: { size: 10 } } } }, animation: { duration: 600 } }
      });
    }

    // 2. 仪器问题类型帕累托 (bar + cumulative line)
    var pareto = data.instrumentPareto || [];
    if (pareto.length && document.getElementById('compPareto')) {
      var ctx2 = document.getElementById('compPareto').getContext('2d');
      if (charts['compPareto']) charts['compPareto'].destroy();
      charts['compPareto'] = new Chart(ctx2, {
        type: 'bar',
        data: {
          labels: pareto.map(function(x) { return x.name; }),
          datasets: [
            { label: '问题数', data: pareto.map(function(x) { return x.count; }), backgroundColor: '#3B82F6', borderRadius: 3 },
            { label: '累积%', type: 'line', data: pareto.map(function(x) { return x.cumPct; }), borderColor: '#EF4444', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: 0.3, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, title: { display: true, text: '问题数' } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '累积%' } } },
          plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } }, animation: { duration: 600 }
        }
      });
    }

    // 3. 各条线设计缺陷占比柱状图
    var lineDesign = data.reagentLineDesign || [];
    if (lineDesign.length && document.getElementById('compLineDesign')) {
      var ctx3 = document.getElementById('compLineDesign').getContext('2d');
      if (charts['compLineDesign']) charts['compLineDesign'].destroy();
      charts['compLineDesign'] = new Chart(ctx3, {
        type: 'bar',
        data: {
          labels: lineDesign.map(function(x) { return x.name; }),
          datasets: [{
            label: '设计缺陷占比%',
            data: lineDesign.map(function(x) { return x.pct; }),
            backgroundColor: lineDesign.map(function(x) { return x.pct >= 50 ? '#EF4444' : x.pct >= 25 ? '#F59E0B' : '#10B981'; }),
            borderRadius: 4
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: '设计缺陷占比%' } } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: function(c) { var d = lineDesign[c.dataIndex]; return '设计缺陷 ' + d.design + '/' + d.total + ' 件'; } } } },
          animation: { duration: 600 }
        }
      });
    }

    // 4. 反馈试剂Top10
    var rtData = data.reagentTop10 || [];
    if (rtData.length && document.getElementById('compReagentTop')) {
      var ctx4 = document.getElementById('compReagentTop').getContext('2d');
      if (charts['compReagentTop']) charts['compReagentTop'].destroy();
      charts['compReagentTop'] = new Chart(ctx4, {
        type: 'bar',
        data: {
          labels: rtData.map(function(x) { return (x.name || '').substring(0, 14); }),
          datasets: [{ label: '投诉数', data: rtData.map(function(x) { return x.count; }), backgroundColor: '#EC4899', borderRadius: 4 }]
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          scales: { x: { beginAtZero: true } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { title: function(c) { return rtData[c[0].dataIndex].name; } } } },
          animation: { duration: 600 }
        }
      });
    }
  }, 200);
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
  loadEventCategories();
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

// ===== 四分类事件看板 =====
var activeEventCat = 'deviation';

async function loadEventCategories() {
  var data = await apiGet('/events/categories');
  if (!data) return;

  // Render tabs
  var tabsHtml = data.categories.map(function(c) {
    var active = c.id === activeEventCat ? ' active' : '';
    return '<div class="event-cat-tab ' + c.id + active + '" onclick="switchEventCat(\'' + c.id + '\')">' +
      '<span class="ect-icon">' + c.icon + '</span>' +
      '<div class="ect-info"><div class="ect-name">' + c.name + '</div>' +
      '<div class="ect-count">' + c.kpi.total + '</div>' +
      '<div class="ect-desc">' + c.desc + '</div></div></div>';
  }).join('');
  document.getElementById('eventCatTabs').innerHTML = tabsHtml;

  // Render active category detail
  var cat = data.categories.find(function(c) { return c.id === activeEventCat; });
  if (!cat) return;
  var k = cat.kpi;

  var html = '<div class="event-cat-detail card"><div class="card-header"><h3>' + cat.icon + ' ' + cat.name + '看板</h3>' +
    '<span style="font-size:11px;">' + cat.types + '</span></div>' +
    '<div class="card-body">' +
    '<div class="module-summary">' +
    '<div class="module-summary-card ms-info"><div class="ms-value">' + k.total + '</div><div class="ms-label">📊 总数</div></div>' +
    '<div class="module-summary-card ' + (k.open > 0 ? 'ms-fail' : 'ms-pass') + '"><div class="ms-value">' + k.open + '</div><div class="ms-label">🔴 未关闭</div></div>' +
    '<div class="module-summary-card ms-pass"><div class="ms-value">' + k.closeRate + '%</div><div class="ms-label">✅ 关闭率</div><div class="ms-target">' + k.closed + ' 件已关闭</div></div>' +
    '<div class="module-summary-card ' + (k.highRisk > 0 ? 'ms-fail' : 'ms-pass') + '"><div class="ms-value">' + k.highRisk + '</div><div class="ms-label">⚠️ 高风险</div></div>' +
    '</div>' +
    '<div class="charts-row" style="margin-bottom:0;">' +
    '<div class="card" style="border:none;box-shadow:none;"><div class="card-header" style="padding:8px 0;"><h3 style="font-size:13px;">📈 月度分布</h3></div><div class="chart-container" style="height:180px;"><canvas id="ecMonth"></canvas></div></div>' +
    '<div class="card" style="border:none;box-shadow:none;"><div class="card-header" style="padding:8px 0;"><h3 style="font-size:13px;">🏷️ 状态分布</h3></div><div class="chart-container" style="height:180px;"><canvas id="ecStatus"></canvas></div></div>' +
    '</div>' +
    '<div class="ect-mini-bar" style="margin-top:12px;">' +
    Object.keys(cat.byRisk).map(function(r) {
      return '<span>' + r + ': <b>' + cat.byRisk[r] + '</b></span>';
    }).join('') +
    Object.keys(cat.byStatus).map(function(s) {
      return '<span>' + s + ': <b>' + cat.byStatus[s] + '</b></span>';
    }).join('') +
    '</div>' +
    (cat.topProducts.length ? '<div style="margin-top:12px;font-size:12px;color:var(--text-secondary);">Top 关联产品: ' + cat.topProducts.slice(0, 4).map(function(p) { return p.name + '(' + p.count + ')'; }).join(' · ') + '</div>' : '') +
    (cat.id === 'complaint' ? '<div style="margin-top:14px;text-align:center;"><button class="btn btn-accent btn-sm" onclick="navigate(\'complaints\')" style="width:100%;padding:10px;">📊 打开完整投诉看板 → 试剂Top10 · 帕累托 · 设计缺陷占比 · 产品排行</button></div>' : '') +
    // === 内外审发现：嵌入体系产品风险检查分析 ===
    (cat.id === 'audit' ? '<div id="afInlineSection" style="margin-top:20px;border-top:2px solid ' + cat.color + ';padding-top:16px;"></div>' : '') +
    '</div></div>';

  document.getElementById('eventCatContent').innerHTML = html;

  // === 内外审发现：异步加载体系产品风险检查帕累托 + 摘要表 ===
  if (cat.id === 'audit') {
    loadAuditFindingsInline(cat.color);
  }

  // Render charts
  setTimeout(function() {
    var months = ['1月','2月','3月','4月','5月','6月','7月'];
    var monthData = months.map(function(m) { return cat.byMonth[parseInt(m)] || 0; });
    renderChart('ecMonth', 'bar', months, monthData, '件数', cat.color);

    var statusLabels = Object.keys(cat.byStatus);
    var statusValues = Object.keys(cat.byStatus).map(function(s) { return cat.byStatus[s]; });
    renderPieChart('ecStatus', statusLabels, statusValues, ['#EF4444','#F59E0B','#10B981','#3B82F6','#8B5CF6']);
  }, 200);
}

// === 内外审发现：内嵌体系产品风险检查分析 ===
async function loadAuditFindingsInline(auditColor) {
  var container = document.getElementById('afInlineSection');
  if (!container) return;
  
  var data = await apiGet('/audit-findings');
  if (!data) { container.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">⏳ 加载分析数据中...</div>'; return; }
  
  var s = data.summary;
  var cp = data.clausePareto || [];
  var items = data.items || [];
  
  var html = '';
  
  // === Mini KPI row ===
  html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">' +
    '<div style="flex:1;min-width:100px;background:#FEE2E2;border-radius:6px;padding:8px 12px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#DC2626;">' + s.keyItems + '</div><div style="font-size:10px;color:#991B1B;">🔴 关键项目 ***</div></div>' +
    '<div style="flex:1;min-width:100px;background:#FEF3C7;border-radius:6px;padding:8px 12px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#D97706;">' + s.majorItems + '</div><div style="font-size:10px;color:#92400E;">🟡 主要项目 **</div></div>' +
    '<div style="flex:1;min-width:100px;background:#D1FAE5;border-radius:6px;padding:8px 12px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#059669;">' + s.generalItems + '</div><div style="font-size:10px;color:#065F46;">🟢 一般项目 *</div></div>' +
    '<div style="flex:1;min-width:100px;background:#EEF2FF;border-radius:6px;padding:8px 12px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#4F46E5;">' + s.total + '</div><div style="font-size:10px;color:#3730A3;">📋 总计风险项</div></div>' +
    '</div>';
  
  // === Conclusion badge ===
  var conclusionColor = s.conclusion.indexOf('暂停') >= 0 ? '#DC2626' : s.conclusion.indexOf('限期') >= 0 ? '#D97706' : '#059669';
  html += '<div style="background:' + conclusionColor + '10;border:1px solid ' + conclusionColor + '30;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;">' +
    '<b style="color:' + conclusionColor + ';">⚖️ ' + s.conclusion + '</b>' +
    '<span style="color:var(--text-muted);margin-left:8px;">依据检查指导原则判定表</span></div>';
  
  // === Pareto chart ===
  html += '<div class="charts-row" style="margin-bottom:12px;">' +
    '<div class="card" style="border:1px solid ' + auditColor + '30;"><div class="card-header"><h3 style="font-size:13px;">📊 条款不符合帕累托图 (新GMP × ISO 13485)</h3></div>' +
    '<div class="card-body"><div class="chart-container" style="height:280px;"><canvas id="afInlinePareto"></canvas></div>' +
    '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;font-size:9px;">' +
    cp.slice(0, 8).map(function(c) {
      return '<span style="background:#F3F4F6;border-radius:3px;padding:1px 5px;">' + c.clause + '(' + c.count + ')→' + (c.iso || '-') + '</span>';
    }).join('') +
    '</div></div></div></div>';
  
  // === Compact summary table ===
  html += '<div style="overflow-x:auto;margin-top:12px;">' +
    '<table class="data-table" style="min-width:900px;font-size:11px;">' +
    '<thead><tr style="background:' + auditColor + '10;">' +
    '<th>#</th><th>类别</th><th>风险描述</th><th>GMP条款</th><th>ISO 13485</th><th>分级</th><th>类型</th>' +
    '</tr></thead><tbody>';
  
  items.forEach(function(item) {
    var rc = item.risk_class === '***' ? '#DC2626' : item.risk_class === '**' ? '#D97706' : '#059669';
    var bg = item.risk_class === '***' ? '#FEE2E2' : item.risk_class === '**' ? '#FEF3C7' : '#D1FAE5';
    var etLabel = item.event_type === 'Audit-Finding' ? '📋 内外审' : '🔍 日常';
    
    html += '<tr class="af-row" data-risk-class="' + item.risk_class + '" data-category="' + item.category + '">' +
      '<td>' + item.seq + '</td>' +
      '<td><span style="font-size:10px;color:var(--text-muted);">' + item.category + '</span></td>' +
      '<td style="max-width:220px;font-size:11px;">' + (item.risk_desc.length > 60 ? item.risk_desc.substring(0, 60) + '...' : item.risk_desc) + '</td>' +
      '<td><span style="font-size:9px;color:#6B7280;">' + (item.gmp_chapter || '') + '</span><br><span style="font-weight:600;color:' + rc + ';font-size:11px;">' + item.clause_ref + '</span></td>' +
      '<td><span style="font-size:10px;color:#6366F1;">' + (item.iso_clause || '—') + '</span></td>' +
      '<td><span style="display:inline-block;padding:1px 6px;border-radius:8px;font-weight:700;font-size:11px;background:' + bg + ';color:' + rc + ';">' + item.risk_class + '</span></td>' +
      '<td><span style="font-size:10px;">' + etLabel + '</span></td>' +
      '</tr>';
  });
  
  html += '</tbody></table></div>';
  
  container.innerHTML = html;
  
  // === Render Pareto chart ===
  if (cp.length > 0) {
    setTimeout(function() {
      var ctx = document.getElementById('afInlinePareto');
      if (!ctx) return;
      if (charts['afInlinePareto']) charts['afInlinePareto'].destroy();
      charts['afInlinePareto'] = new Chart(ctx.getContext('2d'), {
        type: 'bar', data: {
          labels: cp.map(function(x) { return x.clause; }),
          datasets: [
            { label: '出现次数', data: cp.map(function(x) { return x.count; }), backgroundColor: cp.map(function(x) { return x.count >= 3 ? '#DC2626' : x.count >= 2 ? '#F59E0B' : '#3B82F6'; }), borderRadius: 3, yAxisID: 'y' },
            { label: '累积%', type: 'line', data: cp.map(function(x) { return x.cumPct; }), borderColor: '#10B981', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, tension: 0.3, yAxisID: 'y1' }
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: { display: true, text: '次', font: { size: 10 } } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '%', font: { size: 10 } } } }, plugins: { legend: { position: 'top', labels: { font: { size: 10 } } }, tooltip: { callbacks: { afterLabel: function(c) { var d = cp[c.dataIndex]; return 'ISO: ' + (d.iso || '-'); } } } } }
      });
    }, 400);
  }
}

function switchEventCat(id) {
  activeEventCat = id;
  loadEventCategories();
}

// ===== 体系产品风险检查 (Audit Findings) =====
var auditFindingsActive = false;

function showEventsSubPage(sub) {
  var catTabs = document.getElementById('eventCatTabs');
  var catContent = document.getElementById('eventCatContent');
  var afContent = document.getElementById('auditFindingsContent');
  var aiContent = document.getElementById('aiRiskPredictContent');
  var eventsTable = document.querySelector('#page-events .card');
  var btns = document.querySelectorAll('#page-events .page-header .btn-group .btn');
  
  btns.forEach(function(b) { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
  
  // Hide all sub-pages
  if (catTabs) catTabs.style.display = 'none';
  if (catContent) catContent.style.display = 'none';
  if (afContent) afContent.style.display = 'none';
  if (aiContent) aiContent.style.display = 'none';
  if (eventsTable) eventsTable.style.display = 'none';
  
  if (sub === 'categories') {
    auditFindingsActive = false;
    if (btns[0]) { btns[0].classList.remove('btn-outline'); btns[0].classList.add('btn-primary'); }
    if (catTabs) catTabs.style.display = '';
    if (catContent) catContent.style.display = '';
    if (eventsTable) eventsTable.style.display = '';
    loadEventCategories();
  } else if (sub === 'auditFindings') {
    auditFindingsActive = true;
    if (btns[1]) { btns[1].classList.remove('btn-outline'); btns[1].classList.add('btn-primary'); }
    if (afContent) afContent.style.display = 'block';
    loadAuditFindings();
  } else if (sub === 'aiRiskPredict') {
    auditFindingsActive = false;
    if (btns[2]) { btns[2].classList.remove('btn-outline'); btns[2].classList.add('btn-primary'); }
    if (aiContent) aiContent.style.display = 'block';
    loadAIRiskPredict();
  }
}

async function loadAuditFindings() {
  var data = await apiGet('/audit-findings');
  if (!data) return;
  var s = data.summary;
  var items = data.items || [];
  
  var html = '';
  
  // === Summary KPI Cards ===
  html += '<div class="module-summary" style="margin-bottom:16px;">' +
    '<div class="module-summary-card ms-info"><div class="ms-value">' + s.total + '</div><div class="ms-label">📋 总项目数</div><div class="ms-target">体系' + s.systemCount + ' + 产品' + s.productCount + '</div></div>' +
    '<div class="module-summary-card ms-fail"><div class="ms-value">' + s.keyItems + '</div><div class="ms-label">🔴 关键项目 ***</div><div class="ms-target">可能致产品安全风险</div></div>' +
    '<div class="module-summary-card ms-warn"><div class="ms-value">' + s.majorItems + '</div><div class="ms-label">🟡 主要项目 **</div><div class="ms-target">多项叠加可能导致风险</div></div>' +
    '<div class="module-summary-card ms-pass"><div class="ms-value">' + s.generalItems + '</div><div class="ms-label">🟢 一般项目 *</div><div class="ms-target">有影响但程度较轻</div></div>' +
    '<div class="module-summary-card ms-info"><div class="ms-value">' + s.auditFindings + '</div><div class="ms-label">📋 内外审发现</div><div class="ms-target">Audit-Finding</div></div>' +
    '<div class="module-summary-card ms-info"><div class="ms-value">' + s.dailyFindings + '</div><div class="ms-label">🔍 日常发现</div><div class="ms-target">NCR</div></div>' +
    '</div>';
  
  // === 判定结论 ===
  var conclusionColor = s.conclusion.indexOf('暂停') >= 0 ? '#DC2626' : s.conclusion.indexOf('限期') >= 0 ? '#D97706' : '#059669';
  html += '<div style="background:' + conclusionColor + '10;border:1px solid ' + conclusionColor + '30;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;">' +
    '<span style="font-size:20px;">⚖️</span>' +
    '<div><b style="color:' + conclusionColor + ';">检查结论判定: ' + s.conclusion + '</b>' +
    '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">依据《医疗器械生产质量管理规范检查指导原则》附2/附3判定表</div></div>' +
    '</div>';
  
  // === Seed Button ===
  html += '<div style="margin-bottom:16px;display:flex;gap:8px;align-items:center;">' +
    '<button class="btn btn-accent btn-sm" onclick="seedAuditFindings()" id="seedAFBtn">📤 一键导入事件库</button>' +
    '<span style="font-size:11px;color:var(--text-muted);">将以上项目作为质量事件（内外审发现/日常发现）写入事件库</span>' +
    '<span id="seedAFResult" style="font-size:12px;"></span>' +
    '</div>';
  
  // === Filter Tabs ===
  html += '<div class="btn-group" style="margin-bottom:12px;">' +
    '<button class="btn btn-sm btn-primary" onclick="filterAuditFindings(\'all\')" id="afAll">全部 (' + s.total + ')</button>' +
    '<button class="btn btn-sm btn-outline" onclick="filterAuditFindings(\'***\')" id="afKey">关键项目 *** (' + s.keyItems + ')</button>' +
    '<button class="btn btn-sm btn-outline" onclick="filterAuditFindings(\'**\')" id="afMajor">主要项目 ** (' + s.majorItems + ')</button>' +
    '<button class="btn btn-sm btn-outline" onclick="filterAuditFindings(\'*\')" id="afGeneral">一般项目 * (' + s.generalItems + ')</button>' +
    '<button class="btn btn-sm btn-outline" onclick="filterAuditFindings(\'体系风险\')" id="afSys">体系风险 (' + s.systemCount + ')</button>' +
    '<button class="btn btn-sm btn-outline" onclick="filterAuditFindings(\'产品风险\')" id="afProd">产品风险 (' + s.productCount + ')</button>' +
    '</div>';

  // === 条款不符合项帕累托图 ===
  var cp = data.clausePareto || [];
  html += '<div class="charts-row">' +
    '<div class="card"><div class="card-header"><h3>📊 不符合条款帕累托图 (新GMP × ISO 13485)</h3><span style="font-size:11px;">按出现频次降序 — 24项风险清单中条款引用次数分布</span></div>' +
    '<div class="card-body"><div class="chart-container" style="height:360px;"><canvas id="afClausePareto"></canvas></div>' +
    '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;font-size:10px;">' +
    cp.slice(0, 10).map(function(c) {
      return '<span style="background:#F3F4F6;border-radius:4px;padding:2px 6px;">' + c.clause + ' (' + c.count + '次) → ' + (c.iso || '-') + '</span>';
    }).join('') +
    '</div></div></div>' +
    '</div>';

  // === Table ===
  html += '<div class="card"><div class="card-header"><h3>📋 体系/产品风险清单 — 对照检查指导原则分类</h3><span style="font-size:11px;">来源: 20260724 体系、产品风险清单汇总 × 医疗器械生产质量管理规范检查指导原则（征求意见稿）</span></div>' +
    '<div class="card-body no-padding" style="overflow-x:auto;">' +
    '<table class="data-table" style="min-width:1200px;" id="afTable">' +
    '<thead><tr>' +
    '<th>序号</th><th>类别</th><th>风险描述</th><th>GMP条款</th><th>ISO 13485</th><th>风险分级</th><th>项目分类</th><th>发现类型</th><th>风险等级</th><th>目前方案</th>' +
    '</tr></thead><tbody>';
  
  items.forEach(function(item) {
    var riskClassColor = item.risk_class === '***' ? '#DC2626' : item.risk_class === '**' ? '#D97706' : '#059669';
    var riskClassBg = item.risk_class === '***' ? '#FEE2E2' : item.risk_class === '**' ? '#FEF3C7' : '#D1FAE5';
    var eventTypeLabel = item.event_type === 'Audit-Finding' ? '📋 内外审发现' : '🔍 日常发现';
    var eventTypeColor = item.event_type === 'Audit-Finding' ? '#6366F1' : '#10B981';
    var riskBadge = getRiskBadge(item.risk_level);
    
    html += '<tr class="af-row" data-risk-class="' + item.risk_class + '" data-category="' + item.category + '">' +
      '<td>' + item.seq + '</td>' +
      '<td><span style="font-size:11px;color:var(--text-muted);">' + item.category + '</span></td>' +
      '<td style="max-width:280px;font-size:12px;">' + item.risk_desc + '</td>' +
      '<td><span style="font-size:10px;color:#6B7280;">' + (item.gmp_chapter || '') + '</span><br><span style="font-weight:600;color:' + riskClassColor + ';">' + item.clause_ref + '</span><br><span style="font-size:10px;color:var(--text-muted);">' + (item.clause_content || '') + '</span></td>' +
      '<td><span style="font-size:10px;font-weight:500;color:#6366F1;">' + (item.iso_clause || '—') + '</span></td>' +
      '<td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-weight:700;font-size:13px;background:' + riskClassBg + ';color:' + riskClassColor + ';">' + item.risk_class + '</span></td>' +
      '<td><span style="font-size:12px;font-weight:600;color:' + riskClassColor + ';">' + item.item_type + '</span></td>' +
      '<td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:' + eventTypeColor + '15;color:' + eventTypeColor + ';font-weight:600;">' + eventTypeLabel + '</span></td>' +
      '<td><span class="badge badge-' + riskBadge + '">' + item.risk_level + '</span></td>' +
      '<td style="max-width:180px;font-size:11px;color:var(--text-muted);">' + (item.current_mitigation || '-') + '</td>' +
      '</tr>';
  });
  
  html += '</tbody></table></div></div>';
  
  document.getElementById('auditFindingsContent').innerHTML = html;
  
  // === Render Pareto chart ===
  if (cp.length > 0) {
    setTimeout(function() {
      var ctx = document.getElementById('afClausePareto');
      if (!ctx) return;
      if (charts['afClausePareto']) charts['afClausePareto'].destroy();
      charts['afClausePareto'] = new Chart(ctx.getContext('2d'), {
        type: 'bar', data: {
          labels: cp.map(function(x) { return x.clause; }),
          datasets: [
            { label: '出现次数', data: cp.map(function(x) { return x.count; }), backgroundColor: cp.map(function(x) { return x.count >= 3 ? '#DC2626' : x.count >= 2 ? '#F59E0B' : '#3B82F6'; }), borderRadius: 3, yAxisID: 'y' },
            { label: '累积%', type: 'line', data: cp.map(function(x) { return x.cumPct; }), borderColor: '#10B981', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: 0.3, yAxisID: 'y1' }
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: { display: true, text: '不符合项次' } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '累积占比%' } } }, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { afterLabel: function(c) { var d = cp[c.dataIndex]; return 'ISO: ' + (d.iso || '-'); } } } } }
      });
    }, 400);
  }
  
  // Store items for filtering
  window._auditFindingsData = items;
}

function filterAuditFindings(filter) {
  // Update button styles
  var btns = document.querySelectorAll('#auditFindingsContent .btn-group:last-of-type .btn');
  btns.forEach(function(b) { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
  var activeBtn = document.getElementById('af' + (filter === 'all' ? 'All' : filter === '***' ? 'Key' : filter === '**' ? 'Major' : filter === '*' ? 'General' : filter === '体系风险' ? 'Sys' : 'Prod'));
  if (activeBtn) { activeBtn.classList.remove('btn-outline'); activeBtn.classList.add('btn-primary'); }
  
  var rows = document.querySelectorAll('#afTable .af-row');
  rows.forEach(function(row) {
    if (filter === 'all') {
      row.style.display = '';
    } else if (filter === '***' || filter === '**' || filter === '*') {
      row.style.display = row.getAttribute('data-risk-class') === filter ? '' : 'none';
    } else {
      row.style.display = row.getAttribute('data-category') === filter ? '' : 'none';
    }
  });
}

async function seedAuditFindings() {
  var btn = document.getElementById('seedAFBtn');
  var result = document.getElementById('seedAFResult');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 导入中...'; }
  try {
    var res = await apiPost('/audit-findings/seed', {});
    if (res) {
      if (result) result.innerHTML = '<span style="color:#059669;">✅ ' + res.message + '</span>';
      showToast(res.message, 'success');
      // Refresh events if on events page
      if (document.getElementById('page-events').classList.contains('active')) loadEvents();
    }
  } catch(e) {
    if (result) result.innerHTML = '<span style="color:#DC2626;">❌ 导入失败</span>';
  }
  if (btn) { btn.disabled = false; btn.textContent = '📤 一键导入事件库'; }
}

// ===== AI 质量风险预测 =====
async function loadAIRiskPredict() {
  var container = document.getElementById('aiRiskPredictContent');
  if (!container) return;
  
  // Initial state: show button
  var html = '<div class="card"><div class="card-header"><h3>🤖 AI 质量风险预测</h3><span style="font-size:11px;">基于当前质量事件数据，AI 分析风险趋势与预警</span></div>' +
    '<div class="card-body" style="text-align:center;padding:40px;">' +
    '<p style="color:var(--text-muted);margin-bottom:16px;">AI 将分析全部质量事件、CAPA、产品和供应商数据，生成风险预测报告</p>' +
    '<button class="btn btn-accent" onclick="runAIRiskPredict()" id="aiPredictBtn" style="padding:12px 32px;font-size:15px;">🚀 开始 AI 风险预测分析</button>' +
    '<div id="aiPredictResult" style="margin-top:20px;text-align:left;"></div>' +
    '</div></div>';
  
  container.innerHTML = html;
}

async function runAIRiskPredict() {
  var btn = document.getElementById('aiPredictBtn');
  var result = document.getElementById('aiPredictResult');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ AI 分析中，请稍候...'; }
  if (result) result.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">⏳ AI 正在分析质量数据，生成风险预测报告...</div>';
  
  try {
    var data = await apiPost('/ai/risk-predict', {});
    if (!data) {
      if (result) result.innerHTML = '<div style="color:#DC2626;text-align:center;padding:20px;">❌ AI 服务暂不可用，请检查 API Key 配置</div>';
      if (btn) { btn.disabled = false; btn.textContent = '🔄 重试分析'; }
      return;
    }
    
    var ctx = data.data;
    
    var html = '';
    
    // === Statistical Summary Cards ===
    html += '<div style="margin-top:16px;"><b style="font-size:14px;">📊 数据统计摘要</b></div>' +
      '<div class="module-summary" style="margin-top:8px;">' +
      '<div class="module-summary-card ms-info"><div class="ms-value">' + (ctx.summary.totalEvents || 0) + '</div><div class="ms-label">📋 事件总数</div></div>' +
      '<div class="module-summary-card ms-fail"><div class="ms-value">' + (ctx.summary.openEvents || 0) + '</div><div class="ms-label">🔴 未关闭事件</div></div>' +
      '<div class="module-summary-card ms-warn"><div class="ms-value">' + (ctx.summary.criticalEvents || 0) + '</div><div class="ms-label">⚠️ 高/严重风险</div></div>' +
      '<div class="module-summary-card ' + ((ctx.summary.overdueCAPAs || 0) > 0 ? 'ms-fail' : 'ms-pass') + '"><div class="ms-value">' + (ctx.summary.overdueCAPAs || 0) + '</div><div class="ms-label">⏰ 逾期CAPA</div></div>' +
      '</div>';
    
    // Risk distribution bars
    var rd = ctx.riskDistribution || {};
    var rdTotal = (rd.Low||0) + (rd.Medium||0) + (rd.High||0) + (rd.Critical||0) || 1;
    html += '<div style="margin-top:12px;display:flex;gap:4px;height:20px;border-radius:10px;overflow:hidden;">' +
      '<div style="width:' + Math.round((rd.Critical||0)/rdTotal*100) + '%;background:#DC2626;" title="Critical: '+(rd.Critical||0)+'"></div>' +
      '<div style="width:' + Math.round((rd.High||0)/rdTotal*100) + '%;background:#F59E0B;" title="High: '+(rd.High||0)+'"></div>' +
      '<div style="width:' + Math.round((rd.Medium||0)/rdTotal*100) + '%;background:#3B82F6;" title="Medium: '+(rd.Medium||0)+'"></div>' +
      '<div style="width:' + Math.round((rd.Low||0)/rdTotal*100) + '%;background:#10B981;" title="Low: '+(rd.Low||0)+'"></div>' +
      '</div>' +
      '<div style="display:flex;gap:12px;font-size:10px;margin-top:4px;color:var(--text-muted);">' +
      '<span>🔴 Critical '+(rd.Critical||0)+'</span><span>🟡 High '+(rd.High||0)+'</span><span>🔵 Medium '+(rd.Medium||0)+'</span><span>🟢 Low '+(rd.Low||0)+'</span>' +
      '</div>';
    
    // Top risk products
    var trp = ctx.topRiskProducts || [];
    if (trp.length > 0) {
      html += '<div style="margin-top:12px;"><b style="font-size:12px;">🏭 事件最多的产品 Top 5:</b>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">' +
        trp.map(function(p, i) {
          var colors = ['#DC2626','#F59E0B','#3B82F6','#8B5CF6','#6B7280'];
          return '<span style="background:' + colors[i] + '15;border:1px solid ' + colors[i] + '30;border-radius:12px;padding:2px 10px;font-size:11px;">' + (p.name || '未知') + ': <b style="color:' + colors[i] + ';">' + p.count + '</b></span>';
        }).join('') +
        '</div></div>';
    }
    
    // === AI Analysis Result ===
    html += '<div style="margin-top:20px;border-top:2px solid #6366F1;padding-top:16px;">' +
      '<b style="font-size:14px;color:#6366F1;">🤖 AI 风险预测报告</b>' +
      '<div style="margin-top:12px;background:#F9FAFB;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;white-space:pre-wrap;">' + (data.content || 'AI 分析结果为空') + '</div>' +
      '<div style="margin-top:8px;font-size:10px;color:var(--text-muted);">⚠️ AI 分析基于统计模型，仅供参考，关键决策需结合专业判断。</div>' +
      '</div>';
    
    if (result) result.innerHTML = html;
    if (btn) { btn.disabled = false; btn.textContent = '🔄 重新分析'; }
    
  } catch(e) {
    if (result) result.innerHTML = '<div style="color:#DC2626;text-align:center;padding:20px;">❌ 分析失败: ' + e.message + '</div>';
    if (btn) { btn.disabled = false; btn.textContent = '🔄 重试分析'; }
  }
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

  // Load summary
  var summary = await apiGet('/capa/summary');
  if (summary) {
    document.getElementById('capaSummary').innerHTML =
      '<div class="module-summary-card ms-info"><div class="ms-value">' + summary.total + '</div><div class="ms-label">📊 CAPA总数</div></div>' +
      '<div class="module-summary-card ms-fail"><div class="ms-value">' + summary.open + '</div><div class="ms-label">🔴 未关闭</div></div>' +
      '<div class="module-summary-card ms-pass"><div class="ms-value">' + summary.closed + '</div><div class="ms-label">✅ 已关闭</div></div>' +
      '<div class="module-summary-card ms-warn"><div class="ms-value">' + Math.round(summary.total ? summary.closed/summary.total*100 : 0) + '%</div><div class="ms-label">📈 关闭率</div></div>' +
      '<div class="module-summary-card ms-info"><div class="ms-value">' + ((summary.bySource||{})['外部审核'] || 0) + '</div><div class="ms-label">🏛 外部审核</div><div class="ms-target">外部审核来源</div></div>' +
      '<div class="module-summary-card ms-info"><div class="ms-value">' + ((summary.bySource||{})['内部审核'] || 0) + '</div><div class="ms-label">🏠 内部审核</div><div class="ms-target">内部审核来源</div></div>';

    // Audit groups table
    var groups = summary.auditGroups || [];
    var gtbody = document.querySelector('#capaAuditTable tbody');
    if (gtbody && groups.length) {
      gtbody.innerHTML = groups.map(function(g) {
        var pct = Math.round(g.count ? g.closed/g.count*100 : 0);
        return '<tr><td style="font-weight:500;">' + g.source + '</td><td><b>' + g.count + '</b></td>' +
          '<td style="font-size:11px;text-align:left;">' + g.capaNos + '</td>' +
          '<td style="font-size:11px;">' + (g.summary||'') + '</td>' +
          '<td><span style="font-weight:600;color:' + (pct>=80?'#10B981':pct>=50?'#F59E0B':'#EF4444') + ';">' + pct + '%</span></td></tr>';
      }).join('');
    }
  }

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
    var srcBadge = c.audit_source === '内部审核' ? 'badge-info' : 'badge-warning';
    return '<tr><td style="font-weight:500;font-size:12px;">' + (c.capa_no||c.id) + '</td>' +
      '<td title="' + (c.description||c.title||'') + '">' + (c.title||'').substring(0,45) + '</td>' +
      '<td><span class="badge ' + srcBadge + '" style="font-size:10px;">' + (c.audit_source||'-') + '</span></td>' +
      '<td style="font-size:11px;">' + (c.defect_mode||'-') + '</td>' +
      '<td style="font-size:11px;">' + (c.root_cause_category||'-') + '</td>' +
      '<td><span class="badge badge-' + getStatusBadge(c.status) + '">' + c.status + '</span></td>' +
      '<td>' + (c.assignee||'-') + '</td><td>' + (c.due_date||'-') + (isOverdue ? ' ⚠️' : '') + '</td>' +
      '<td style="font-size:11px;">' + (c.effectiveness||'-') + '</td>' +
      '<td style="font-size:11px;">' + (c.verified_by||'-') + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="editCAPA(\'' + c.id + '\')">编辑</button> ' +
      '<button class="btn btn-danger btn-sm" onclick="deleteCAPA(\'' + c.id + '\')">删除</button></td></tr>';
  }).join('') : '<tr><td colspan="11"><div class="empty-state">暂无 CAPA 记录</div></td></tr>';
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
var changeFilter = 'all';

async function loadChanges() {
  // Load summary
  var summary = await apiGet('/changes/summary');
  if (summary) {
    document.getElementById('changeSummary').innerHTML =
      '<div class="module-summary-card ms-info"><div class="ms-value">' + summary.total + '</div><div class="ms-label">📊 变更总数</div></div>' +
      '<div class="module-summary-card ms-pass"><div class="ms-value">' + summary.completed + '</div><div class="ms-label">✅ 已完成</div></div>' +
      '<div class="module-summary-card ms-warn"><div class="ms-value">' + (summary.byLevel.I||0) + '</div><div class="ms-label">Ⅰ类 · 轻度</div></div>' +
      '<div class="module-summary-card ms-info"><div class="ms-value">' + (summary.byLevel.II||0) + '</div><div class="ms-label">Ⅱ类 · 中度</div></div>' +
      '<div class="module-summary-card ms-fail"><div class="ms-value">' + (summary.byLevel.III||0) + '</div><div class="ms-label">Ⅲ类 · 重度</div></div>';

    // Render 4 charts
    setTimeout(function() {
      // 1. Base pie
      var bp = summary.basePie || [];
      if (bp.length && document.getElementById('changeBase')) {
        renderPieChart('changeBase', bp.map(function(x){return x.name+' ('+x.pct+'%)';}), bp.map(function(x){return x.count;}), ['#3B82F6','#10B981','#F59E0B','#8B5CF6']);
      }
      // 2. Product type pie
      var pp = summary.productPie || [];
      if (pp.length && document.getElementById('changeProduct')) {
        renderPieChart('changeProduct', pp.map(function(x){return x.name+' ('+x.pct+'%)';}), pp.map(function(x){return x.count;}), ['#6366F1','#EC4899','#14B8A6','#F97316']);
      }
      // 3. Pareto
      var cp = summary.changePareto || [];
      if (cp.length && document.getElementById('changePareto')) {
        var ctx3 = document.getElementById('changePareto').getContext('2d');
        if (charts['changePareto']) charts['changePareto'].destroy();
        charts['changePareto'] = new Chart(ctx3, {
          type: 'bar',
          data: {
            labels: cp.map(function(x){return x.name;}),
            datasets: [
              { label: '变更数', data: cp.map(function(x){return x.count;}), backgroundColor: '#3B82F6', borderRadius: 3 },
              { label: '累积%', type: 'line', data: cp.map(function(x){return x.cumPct;}), borderColor: '#EF4444', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: 0.3, yAxisID: 'y1' }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, title: { display: true, text: '变更数' } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '累积%' } } },
            plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } }
          }
        });
      }
      // 4. Level stack
      var ls = summary.levelStack || [];
      if (ls.length && document.getElementById('changeStack')) {
        var ctx4 = document.getElementById('changeStack').getContext('2d');
        if (charts['changeStack']) charts['changeStack'].destroy();
        charts['changeStack'] = new Chart(ctx4, {
          type: 'bar',
          data: {
            labels: ls.map(function(x){return x.level + ' (' + x.count + '件)';}),
            datasets: [
              { label: '已完成', data: ls.map(function(x){return x.complete;}), backgroundColor: '#10B981', borderRadius: 3 },
              { label: '未完成', data: ls.map(function(x){return x.incomplete;}), backgroundColor: '#EF4444', borderRadius: 3 }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: '变更件数' } } },
            plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } }
          }
        });
      }

      // 5 & 6. Fetch analysis for I/II/III × 设计/工程 + 变更理由帕累托
      apiGet('/changes/analysis').then(function(analysis) {
        if (!analysis) return;
        // 5. I/II/III × 设计/工程 stacked bar
        var cross = analysis.cross;
        if (cross && document.getElementById('changeCross')) {
          var ctx5 = document.getElementById('changeCross').getContext('2d');
          if (charts['changeCross']) charts['changeCross'].destroy();
          var levels = ['I','II','III'];
          charts['changeCross'] = new Chart(ctx5, {
            type: 'bar',
            data: {
              labels: levels.map(function(l){return l+'类';}),
              datasets: [
                { label: '设计变更', data: levels.map(function(l){return cross[l]['设计变更']||0;}), backgroundColor: '#6366F1', borderRadius: 3 },
                { label: '工程变更', data: levels.map(function(l){return cross[l]['工程变更']||0;}), backgroundColor: '#F59E0B', borderRadius: 3 }
              ]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              scales: { y: { beginAtZero: true, title: { display: true, text: '件数' } } },
              plugins: { legend: { position: 'top' } }
            }
          });
        }
        // 6. 变更理由帕累托
        var op = analysis.objectPareto || [];
        if (op.length && document.getElementById('changeReasonPareto')) {
          var ctx6 = document.getElementById('changeReasonPareto').getContext('2d');
          if (charts['changeReasonPareto']) charts['changeReasonPareto'].destroy();
          charts['changeReasonPareto'] = new Chart(ctx6, {
            type: 'bar',
            data: {
              labels: op.map(function(x){return x.name;}),
              datasets: [
                { label: '变更数', data: op.map(function(x){return x.count;}), backgroundColor: '#8B5CF6', borderRadius: 3 },
                { label: '累积%', type: 'line', data: op.map(function(x){return x.cumPct;}), borderColor: '#EF4444', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: 0.3, yAxisID: 'y1' }
              ]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              scales: { y: { beginAtZero: true, title: { display: true, text: '件数' } }, y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '累积%' } } },
              plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } }
            }
          });
        }
      });
    }, 300);
  }

  var result = await apiGet('/changes?limit=300');
  if (!result) return;
  var changes = result.data || result;

  if (changeFilter !== 'all') {
    if (changeFilter === '完成' || changeFilter === '未完成') {
      changes = changes.filter(function(c) { return c.status === changeFilter; });
    } else {
      changes = changes.filter(function(c) { return (c.change_level||'').indexOf(changeFilter) === 0; });
    }
  }

  var tbody = document.querySelector('#changesTable tbody');
  tbody.innerHTML = changes.length ? changes.map(function(c) {
    var levelBadge = (c.change_level||'').includes('I') && !(c.change_level||'').includes('II') ? 'badge-success' :
      (c.change_level||'').includes('II') && !(c.change_level||'').includes('III') ? 'badge-warning' : 'badge-danger';
    var statusBadge = c.status === '完成' ? 'badge-success' : c.status === '未完成' ? 'badge-danger' : 'badge-info';
    return '<tr><td style="font-weight:500;">' + (c.change_no||c.id) + '</td>' +
      '<td>' + (c.base||'-') + '</td><td>' + (c.product_type_desc||c.product_id||'-') + '</td>' +
      '<td><span class="badge ' + levelBadge + '">' + (c.change_level||c.risk||'-') + '</span></td>' +
      '<td>' + (c.change_type||'-') + '</td>' +
      '<td><span class="badge ' + statusBadge + '">' + (c.status||'-') + '</span></td>' +
      '<td><span class="badge badge-' + getRiskBadge(c.risk) + '">' + (c.risk||'') + '</span></td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="approveChange(\'' + c.id + '\')">审批</button> ' +
      '<button class="btn btn-danger btn-sm" onclick="deleteChange(\'' + c.id + '\')">删除</button></td></tr>';
  }).join('') : '<tr><td colspan="8"><div class="empty-state">暂无变更记录</div></td></tr>';
}

function filterChanges(filter) {
  changeFilter = changeFilter === filter ? 'all' : filter;
  var allBtns = document.querySelectorAll('#page-changes .card-header .btn-group:first-child .btn');
  allBtns.forEach(function(btn) { btn.classList.remove('btn-primary'); btn.classList.add('btn-outline'); });
  var activeBtn = Array.from(allBtns).find(function(b) { return (b.textContent||'').trim().indexOf(filter) === 0; });
  if (activeBtn) { activeBtn.classList.remove('btn-outline'); activeBtn.classList.add('btn-primary'); }
  loadChanges();
}

// ===== 变更控制子页面切换 =====
function showChangesSubPage(sub) {
  var db = document.getElementById('changesDashboard');
  var guide = document.getElementById('changesGuideContent');
  var btns = document.querySelectorAll('#page-changes .page-header .btn-group .btn');
  
  btns.forEach(function(b) { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
  
  if (sub === 'guide') {
    if (btns[1]) { btns[1].classList.remove('btn-outline'); btns[1].classList.add('btn-primary'); }
    if (db) db.style.display = 'none';
    if (guide) guide.style.display = 'block';
    // Hide chart rows
    document.querySelectorAll('#page-changes .charts-row, #page-changes .card').forEach(function(el) {
      if (!el.closest('#changesGuideContent')) el.style.display = 'none';
    });
    loadChangesGuide();
  } else {
    if (btns[0]) { btns[0].classList.remove('btn-outline'); btns[0].classList.add('btn-primary'); }
    if (db) db.style.display = '';
    if (guide) guide.style.display = 'none';
    document.querySelectorAll('#page-changes .charts-row, #page-changes .card').forEach(function(el) {
      if (!el.closest('#changesGuideContent')) el.style.display = '';
    });
  }
}

// ===== 变更操作指南提示卡 =====
async function loadChangesGuide() {
  var container = document.getElementById('changesGuideContent');
  if (!container) return;
  
  var data = await apiGet('/changes/guide');
  if (!data) { container.innerHTML = '<div class="card"><div class="card-body" style="text-align:center;padding:40px;">⏳ 加载指南中...</div></div>'; return; }
  
  var html = '';
  
  // === Tab navigation ===
  html += '<div class="btn-group" style="margin-bottom:16px;" id="guideTabs">' +
    '<button class="btn btn-sm btn-primary" onclick="switchGuideTab(\'de\')" id="gtDE">🔀 设计/工程变更</button>' +
    '<button class="btn btn-sm btn-outline" onclick="switchGuideTab(\'risk\')" id="gtRisk">⚖️ I/II/III 风险分级</button>' +
    '<button class="btn btn-sm btn-outline" onclick="switchGuideTab(\'material\')" id="gtMat">🔩 仪器物料变更</button>' +
    '<button class="btn btn-sm btn-outline" onclick="switchGuideTab(\'flow\')" id="gtFlow">📋 六阶段流程</button>' +
    '</div>' +
    '<div id="guideTabContent"></div>';
  
  container.innerHTML = html;
  window._changeGuideData = data;
  switchGuideTab('de');
}

function switchGuideTab(tab) {
  var data = window._changeGuideData;
  if (!data) return;
  
  var btns = document.querySelectorAll('#guideTabs .btn');
  btns.forEach(function(b) { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
  var activeBtn = document.getElementById('gt' + (tab === 'de' ? 'DE' : tab === 'risk' ? 'Risk' : tab === 'material' ? 'Mat' : 'Flow'));
  if (activeBtn) { activeBtn.classList.remove('btn-outline'); activeBtn.classList.add('btn-primary'); }
  
  var content = document.getElementById('guideTabContent');
  if (!content) return;
  
  var html = '';
  
  if (tab === 'de') {
    var d = data.designVsEngineering;
    html += '<div class="card"><div class="card-header"><h3>🔀 ' + d.title + '</h3><span style="font-size:11px;">先判定变更类型，再进入对应管理轨道</span></div><div class="card-body">';
    
    // FFF Decision
    html += '<div style="background:#EEF2FF;border-radius:8px;padding:16px;margin-bottom:16px;"><b style="color:#4F46E5;">🧭 ' + d.decision.title + '</b>';
    d.decision.questions.forEach(function(q) {
      html += '<div style="margin-top:8px;font-size:13px;">• <b>' + q.q + '</b>：' + q.desc + '</div>';
    });
    html += '<div style="margin-top:10px;font-size:12px;color:#DC2626;font-weight:600;">⚠ ' + d.decision.rule + '</div></div>';
    
    // Comparison table
    html += '<table class="data-table" style="font-size:12px;"><thead><tr><th>维度</th><th style="color:#0F766E;">🔵 设计变更</th><th style="color:#D97706;">🟠 工程变更</th></tr></thead><tbody>';
    d.comparison.forEach(function(r) {
      html += '<tr><td><b>' + r.dim + '</b></td><td>' + r.design + '</td><td>' + r.engineering + '</td></tr>';
    });
    html += '</tbody></table>';
    
    // Examples
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px;">' +
      '<div style="background:#D1FAE5;border-radius:8px;padding:14px;"><b style="color:#065F46;">🔵 设计变更示例</b><ul style="margin:8px 0 0 16px;font-size:12px;">' +
      d.designExamples.map(function(e) { return '<li>' + e + '</li>'; }).join('') + '</ul></div>' +
      '<div style="background:#FEF3C7;border-radius:8px;padding:14px;"><b style="color:#92400E;">🟠 工程变更示例</b><ul style="margin:8px 0 0 16px;font-size:12px;">' +
      d.engineeringExamples.map(function(e) { return '<li>' + e + '</li>'; }).join('') + '</ul></div>' +
      '</div>';
    
    html += '</div></div>';
    
  } else if (tab === 'risk') {
    var r = data.riskLevels;
    html += '<div class="card"><div class="card-header"><h3>⚖️ ' + r.title + '</h3><span style="font-size:11px;color:#DC2626;">' + r.principle + '</span></div><div class="card-body">';
    
    // Risk level cards
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">';
    r.levels.forEach(function(l) {
      var color = l.badge === 'b-high' ? '#DC2626' : l.badge === 'b-mid' ? '#D97706' : '#059669';
      var bg = l.badge === 'b-high' ? '#FEE2E2' : l.badge === 'b-mid' ? '#FEF3C7' : '#D1FAE5';
      html += '<div style="background:' + bg + ';border-radius:8px;padding:14px;border-top:3px solid ' + color + ';">' +
        '<b style="color:' + color + ';">' + l.level + ' / ' + l.risk + '</b>' +
        '<p style="font-size:11px;margin:6px 0;">' + l.def + '</p>' +
        '<div style="font-size:11px;margin-top:8px;"><b>验证：</b>' + l.validation + '</div>' +
        '<div style="font-size:11px;"><b>审批：</b>' + l.approval + '</div>' +
        '<div style="font-size:11px;"><b>法规：</b>' + l.regulatory + '</div></div>';
    });
    html += '</div>';
    
    // Reagent examples
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' +
      '<div><b style="font-size:13px;">🧪 试剂变更示例</b>' +
      '<div style="background:#D1FAE5;border-radius:6px;padding:10px;margin-top:6px;font-size:11px;"><b style="color:#059669;">I 类（低风险）</b><ul style="margin:4px 0 0 14px;">' + r.reagentExamples.I.map(function(e){return '<li>'+e+'</li>';}).join('') + '</ul></div>' +
      '<div style="background:#FEF3C7;border-radius:6px;padding:10px;margin-top:6px;font-size:11px;"><b style="color:#D97706;">II 类（中风险）</b><ul style="margin:4px 0 0 14px;">' + r.reagentExamples.II.map(function(e){return '<li>'+e+'</li>';}).join('') + '</ul></div>' +
      '<div style="background:#FEE2E2;border-radius:6px;padding:10px;margin-top:6px;font-size:11px;"><b style="color:#DC2626;">III 类（高风险）</b><ul style="margin:4px 0 0 14px;">' + r.reagentExamples.III.map(function(e){return '<li>'+e+'</li>';}).join('') + '</ul></div>' +
      '</div>' +
      '<div><b style="font-size:13px;">🔩 仪器变更示例</b>' +
      '<div style="background:#D1FAE5;border-radius:6px;padding:10px;margin-top:6px;font-size:11px;"><b style="color:#059669;">I 类（低风险）</b><ul style="margin:4px 0 0 14px;">' + r.instrumentExamples.I.map(function(e){return '<li>'+e+'</li>';}).join('') + '</ul></div>' +
      '<div style="background:#FEF3C7;border-radius:6px;padding:10px;margin-top:6px;font-size:11px;"><b style="color:#D97706;">II 类（中风险）</b><ul style="margin:4px 0 0 14px;">' + r.instrumentExamples.II.map(function(e){return '<li>'+e+'</li>';}).join('') + '</ul></div>' +
      '<div style="background:#FEE2E2;border-radius:6px;padding:10px;margin-top:6px;font-size:11px;"><b style="color:#DC2626;">III 类（高风险）</b><ul style="margin:4px 0 0 14px;">' + r.instrumentExamples.III.map(function(e){return '<li>'+e+'</li>';}).join('') + '</ul></div>' +
      '</div></div>';
    
    html += '<div style="margin-top:12px;background:#FEE2E2;border-radius:6px;padding:10px;font-size:11px;color:#991B1B;">⚠ ' + r.gateRule + '</div>';
    html += '</div></div>';
    
  } else if (tab === 'material') {
    var m = data.instrumentMaterial;
    html += '<div class="card"><div class="card-header"><h3>🔩 ' + m.title + '</h3></div><div class="card-body">';
    
    // Material level cards
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">';
    var colors = ['#DC2626','#D97706','#059669'];
    var bgs = ['#FEE2E2','#FEF3C7','#D1FAE5'];
    m.materialLevels.forEach(function(l, i) {
      html += '<div style="background:' + bgs[i] + ';border-radius:8px;padding:14px;border-top:3px solid ' + colors[i] + ';">' +
        '<b style="color:' + colors[i] + ';">' + l.level + '</b><p style="font-size:11px;margin:6px 0;">' + l.def + '</p>' +
        '<div style="font-size:11px;margin-top:8px;"><b>验证：</b>' + l.validation + '</div>' +
        '<div style="font-size:11px;"><b>审批：</b>' + l.approval + '</div>' +
        '<div style="font-size:11px;margin-top:4px;color:#6B7280;">示例：' + l.examples + '</div></div>';
    });
    html += '</div>';
    
    // Risk matrix
    html += '<b style="font-size:13px;">📊 物料分级 × 变更类型 → 风险等级矩阵</b>' +
      '<div style="overflow-x:auto;margin-top:6px;"><table class="data-table" style="font-size:11px;"><thead><tr>' +
      m.riskMatrix.header.map(function(h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    m.riskMatrix.rows.forEach(function(row) {
      html += '<tr>' + row.map(function(c, i) {
        var style = i === 0 ? 'font-weight:600;' : '';
        if (c === 'III') style += 'color:#DC2626;font-weight:700;';
        else if (c && c.indexOf('III') >= 0) style += 'color:#DC2626;';
        else if (c === 'II' || (c && c.indexOf('II') >= 0 && c.indexOf('III') < 0)) style += 'color:#D97706;';
        return '<td style="' + style + '">' + c + '</td>';
      }).join('') + '</tr>';
    });
    html += '</tbody></table></div>';
    
    // Validation matrix
    html += '<b style="font-size:13px;display:block;margin-top:16px;">✅ 按物料类别验证矩阵</b>' +
      '<div style="overflow-x:auto;margin-top:6px;"><table class="data-table" style="font-size:11px;"><thead><tr>' +
      m.validationMatrix.header.map(function(h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    m.validationMatrix.rows.forEach(function(row) {
      html += '<tr>' + row.map(function(c, i) {
        var style = i === 0 ? 'font-weight:600;' : '';
        if (c === '必须') style += 'color:#DC2626;font-weight:600;';
        else if (c === '按需') style += 'color:#D97706;';
        else if (c === '无需') style += 'color:#9CA3AF;';
        return '<td style="' + style + '">' + c + '</td>';
      }).join('') + '</tr>';
    });
    html += '</tbody></table></div>';
    
    // Change types
    html += '<b style="font-size:13px;display:block;margin-top:16px;">🔍 按变更类型验证侧重</b>';
    m.changeTypes.forEach(function(ct) {
      html += '<div style="margin-top:6px;padding:8px 12px;background:#F9FAFB;border-radius:6px;font-size:11px;"><b>' + ct.type + '：</b>' + ct.focus + '</div>';
    });
    
    html += '</div></div>';
    
  } else if (tab === 'flow') {
    var f = data.processFlow;
    html += '<div class="card"><div class="card-header"><h3>📋 ' + f.title + '</h3></div><div class="card-body">';
    
    f.stages.forEach(function(s) {
      html += '<div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start;">' +
        '<div style="background:#0F766E;color:#fff;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;flex-shrink:0;">' + s.id + '</div>' +
        '<div style="flex:1;"><b style="font-size:14px;">' + s.name + '</b>' +
        '<div style="font-size:11px;color:#0F766E;margin-top:2px;">👤 ' + s.owner + '</div>' +
        '<ul style="margin:6px 0 0 16px;font-size:12px;">' + s.tasks.map(function(t) { return '<li>' + t + '</li>'; }).join('') + '</ul>' +
        '<div style="margin-top:8px;font-size:11px;background:#EEF2FF;border-radius:4px;padding:4px 8px;color:#4F46E5;font-weight:600;">🚪 ' + s.gate + '</div></div></div>';
    });
    
    html += '</div></div>';
  }
  
  content.innerHTML = html;
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
