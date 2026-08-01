// ============================================================
// FDQH AI Chat Frontend
// ============================================================

// ---- State ----
var aiState = {
  currentAssistant: 'quality_expert',
  conversations: {},  // { assistantType: [ {role, content}, ... ] }
  currentAbortController: null,
  isStreaming: false,
  historyList: [],    // [{id, title, assistantType, timestamp}]
  floatingOpen: false,
};

// Assistant config
var AI_ASSISTANTS = {
  quality_expert: { name: '质量专家助手', icon: '🤖', desc: 'ISO 13485 / GMP / IVD法规咨询', color: '#3B82F6' },
  knowledge: { name: 'AI 知识助手', icon: '📚', desc: '质量管理知识库问答', color: '#10B981' },
  capa_rca: { name: 'AI CAPA/RCA 智能助手', icon: '🔧', desc: '根因分析与CAPA计划生成', color: '#F59E0B' },
  risk_prediction: { name: 'AI 质量风险预测', icon: '📈', desc: '风险趋势分析与预警', color: '#EF4444' },
};

// Initialize conversations
Object.keys(AI_ASSISTANTS).forEach(function(k) {
  aiState.conversations[k] = [];
});

// ---- Load AI Page ----
async function loadAIAssistant() {
  // Check AI status first
  try {
    var status = await apiGet('/ai/status');
    if (status && status.available) {
      renderAIPage(status);
    } else {
      renderAINotAvailable(status);
    }
  } catch (e) {
    renderAINotAvailable(null);
  }
}

function renderAIPage(status) {
  var page = document.getElementById('page-ai');
  if (!page) return;
  
  page.innerHTML = `
    <div class="page-header">
      <h2>🤖 AI 智能助手</h2>
      <p>质量专家 · 知识问答 · CAPA/RCA分析 · 风险预测</p>
    </div>
    
    <div class="ai-layout">
      <!-- Sidebar: Assistant tabs + History -->
      <div class="ai-sidebar">
        <div class="ai-sidebar-header">🧠 AI 助手</div>
        <div style="padding: 8px;">
          ${Object.entries(AI_ASSISTANTS).map(function(entry) {
            var k = entry[0], a = entry[1];
            var active = k === aiState.currentAssistant ? ' active' : '';
            return '<div class="ai-history-item assistant-tab' + active + '" data-assistant="' + k + '" onclick="switchAIAssistant(\'' + k + '\')" style="border-left: 3px solid ' + (k === aiState.currentAssistant ? a.color : 'transparent') + ';">' +
              '<span class="icon">' + a.icon + '</span>' + a.name + '</div>';
          }).join('')}
        </div>
        <div class="ai-sidebar-header" style="margin-top:8px;">💬 对话历史</div>
        <div class="ai-history-list" id="aiHistoryList">
          ${aiState.historyList.length === 0 ? '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px;">暂无对话记录</div>' : ''}
          ${aiState.historyList.map(function(h, i) {
            return '<div class="ai-history-item" onclick="loadHistory(' + i + ')" title="' + (h.title || '对话') + '">' +
              '<span class="icon">💬</span>' + (h.title || '对话 ' + (i + 1)) + '<span style="margin-left:auto;font-size:11px;color:var(--text-secondary)">' + h.assistantType + '</span></div>';
          }).join('')}
        </div>
        <div class="ai-sidebar-footer">
          <button class="btn-new-chat" onclick="newAIChat()">➕ 新建对话</button>
        </div>
      </div>
      
      <!-- Main Chat Area -->
      <div class="ai-chat-main">
        <div class="ai-chat-header">
          <div class="assistant-info">
            <div class="assistant-avatar">${AI_ASSISTANTS[aiState.currentAssistant].icon}</div>
            <div>
              <h3>${AI_ASSISTANTS[aiState.currentAssistant].name}</h3>
              <div class="desc">${AI_ASSISTANTS[aiState.currentAssistant].desc}</div>
            </div>
          </div>
          <div>
            <span style="font-size:12px;color:var(--text-secondary);">模型: ${status ? status.models.join(', ') : 'Qwen'}</span>
          </div>
        </div>
        
        <div class="ai-messages" id="aiMessages">
          ${renderAIEmptyState()}
        </div>
        
        ${status && status.quickQuestions && status.quickQuestions[aiState.currentAssistant] ? 
          '<div class="ai-quick-questions" id="aiQuickQuestions">' +
            status.quickQuestions[aiState.currentAssistant].map(function(q) {
              return '<span class="ai-quick-question" onclick="sendQuickQuestion(\'' + q.replace(/'/g, "\\'") + '\')">' + q + '</span>';
            }).join('') +
          '</div>' : ''}
        
        <div class="ai-input-area">
          <div class="ai-input-row">
            <textarea id="aiInput" placeholder="输入你的问题..." rows="1" onkeydown="handleAIKeyDown(event)"></textarea>
            ${aiState.isStreaming ? 
              '<button class="btn-stop" onclick="stopAIGeneration()" title="停止生成">⏹</button>' :
              '<button class="btn-send" onclick="sendAIMessage()" title="发送">➤</button>'}
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Render existing conversation
  renderAIMessages();
  
  // Auto-resize textarea
  var ta = document.getElementById('aiInput');
  if (ta) {
    ta.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }
}

function renderAINotAvailable(status) {
  var page = document.getElementById('page-ai');
  if (!page) return;
  
  page.innerHTML = `
    <div class="page-header">
      <h2>🤖 AI 智能助手</h2>
      <p>质量专家 · 知识问答 · CAPA/RCA分析 · 风险预测</p>
    </div>
    
    <div class="ai-config-banner">
      <div class="icon">⚙️</div>
      <div class="content">
        <h4>AI 服务未配置</h4>
        <p>FDQH AI助手需要配置大模型API密钥才能使用。推荐使用<strong>阿里百炼</strong>平台，新用户可获得免费额度。</p>
        <p style="margin-top:8px;">
          <strong>配置步骤：</strong><br>
          1. 访问 <a href="https://bailian.console.aliyun.com" target="_blank">bailian.console.aliyun.com</a> 注册并获取 API Key<br>
          2. 设置环境变量：<code>DASHSCOPE_API_KEY=你的API密钥</code><br>
          3. 或者设置 DeepSeek API：<code>DEEPSEEK_API_KEY=你的API密钥</code><br>
          4. 重启 FDQH 服务
        </p>
        <p style="margin-top:8px;font-size:12px;">
          💡 <strong>推荐模型：</strong>阿里百炼 Qwen-Plus（免费70万tokens）、DeepSeek-V3（极低成本）<br>
          💡 两个API均为 OpenAI 兼容格式，无需修改代码即可切换
        </p>
      </div>
    </div>
    
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;">
      ${Object.entries(AI_ASSISTANTS).map(function(entry) {
        var a = entry[1];
        return '<div class="card" style="opacity:0.6;">' +
          '<div class="card-body" style="text-align:center;padding:32px 20px;">' +
          '<div style="font-size:40px;margin-bottom:12px;">' + a.icon + '</div>' +
          '<h4 style="margin-bottom:8px;">' + a.name + '</h4>' +
          '<p style="font-size:13px;color:var(--text-secondary);">' + a.desc + '</p>' +
          '</div></div>';
      }).join('')}
    </div>
  `;
}

// ---- Render Messages ----
function renderAIEmptyState() {
  return '<div class="ai-empty-state">' +
    '<div class="icon">' + AI_ASSISTANTS[aiState.currentAssistant].icon + '</div>' +
    '<h3>' + AI_ASSISTANTS[aiState.currentAssistant].name + '</h3>' +
    '<p>' + AI_ASSISTANTS[aiState.currentAssistant].desc + '</p>' +
    '<p style="font-size:12px;margin-top:8px;opacity:0.6;">选择下方快捷问题或输入你的问题开始对话</p>' +
    '</div>';
}

function renderAIMessages() {
  var container = document.getElementById('aiMessages');
  if (!container) return;
  
  var msgs = aiState.conversations[aiState.currentAssistant] || [];
  
  if (msgs.length === 0) {
    container.innerHTML = renderAIEmptyState();
    return;
  }
  
  container.innerHTML = msgs.map(function(m) {
    var role = m.role === 'user' ? 'user' : 'assistant';
    var avatar = role === 'user' ? '👤' : AI_ASSISTANTS[aiState.currentAssistant].icon;
    var content = role === 'assistant' ? formatAIMarkdown(m.content) : escapeHtml(m.content);
    return '<div class="ai-message ' + role + '">' +
      '<div class="avatar">' + avatar + '</div>' +
      '<div class="bubble">' + content + '</div>' +
      '</div>';
  }).join('');
  
  // Scroll to bottom
  setTimeout(function() { container.scrollTop = container.scrollHeight; }, 100);
}

// Simple markdown formatter
function formatAIMarkdown(text) {
  if (!text) return '';
  var html = escapeHtml(text);
  
  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  
  // Headers: ### text
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  
  // Bullet lists: - text or * text
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  
  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  
  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Code blocks: ``` ... ```
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  
  // Tables (basic)
  html = html.replace(/\|(.+)\|/g, function(match) {
    var cells = match.split('|').filter(function(c) { return c.trim(); });
    if (cells.length > 1) {
      return '<tr>' + cells.map(function(c) {
        var trimmed = c.trim();
        // Skip separator rows like ---
        if (/^[-:]+$/.test(trimmed)) return '';
        return '<td>' + trimmed + '</td>';
      }).join('') + '</tr>';
    }
    return match;
  });
  html = html.replace(/(<tr>.*<\/tr>\n?)+/g, '<table>$&</table>');
  
  // Convert newlines to <br>
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Switch Assistant ----
function switchAIAssistant(type) {
  aiState.currentAssistant = type;
  
  // Update tab styles
  var tabs = document.querySelectorAll('.assistant-tab');
  tabs.forEach(function(t) {
    t.classList.remove('active');
    t.style.borderLeftColor = 'transparent';
  });
  var activeTab = document.querySelector('.assistant-tab[data-assistant="' + type + '"]');
  if (activeTab) {
    activeTab.classList.add('active');
    activeTab.style.borderLeftColor = AI_ASSISTANTS[type].color;
  }
  
  // Reload page
  loadAIAssistant();
}

// ---- Send Message ----
function sendAIMessage() {
  var input = document.getElementById('aiInput');
  if (!input) return;
  var text = input.value.trim();
  if (!text || aiState.isStreaming) return;
  
  input.value = '';
  input.style.height = 'auto';
  
  // Add user message
  var msgs = aiState.conversations[aiState.currentAssistant];
  msgs.push({ role: 'user', content: text });
  renderAIMessages();
  
  // Show typing indicator
  showAITyping();
  
  // Call API
  callAIStream(text);
}

function sendQuickQuestion(question) {
  var input = document.getElementById('aiInput');
  if (input) {
    input.value = question;
    sendAIMessage();
  }
}

function handleAIKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAIMessage();
  }
}

// ---- Streaming API Call ----
async function callAIStream(userMessage) {
  aiState.isStreaming = true;
  updateSendButton();
  
  // Add empty assistant bubble for streaming
  var msgs = aiState.conversations[aiState.currentAssistant];
  msgs.push({ role: 'assistant', content: '' });
  renderAIMessages();
  
  try {
    var controller = new AbortController();
    aiState.currentAbortController = controller;
    
    var response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        assistantType: aiState.currentAssistant,
        messages: msgs.filter(function(m) { return m.role !== 'assistant' || m.content !== ''; }).slice(0, -1),
      }),
      signal: controller.signal,
    });
    
    if (!response.ok) {
      var err = await response.json();
      throw new Error(err.error || '请求失败');
    }
    
    // Read SSE stream
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var fullContent = '';
    
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || !line.startsWith('data: ')) continue;
        var data = line.slice(6);
        if (data === '[DONE]') continue;
        
        try {
          var parsed = JSON.parse(data);
          if (parsed.content) {
            fullContent += parsed.content;
            // Update the last assistant message in-place
            var lastMsg = msgs[msgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.content = fullContent;
              renderAIMessages();
            }
          } else if (parsed.error) {
            throw new Error(parsed.error);
          } else if (parsed.status === 'fallback') {
            // Fallback message
            fullContent += '\n\n*' + parsed.message + '*\n\n';
            var lastMsg2 = msgs[msgs.length - 1];
            if (lastMsg2 && lastMsg2.role === 'assistant') {
              lastMsg2.content = fullContent;
              renderAIMessages();
            }
          }
        } catch (parseErr) {
          // Skip parse errors
        }
      }
    }
    
    // Save to history
    if (fullContent && msgs.length >= 2) {
      var title = userMessage.slice(0, 30) + (userMessage.length > 30 ? '...' : '');
      aiState.historyList.push({
        id: Date.now().toString(36),
        title: title,
        assistantType: aiState.currentAssistant,
        timestamp: new Date().toISOString(),
      });
    }
    
  } catch (err) {
    if (err.name === 'AbortError') {
      // User stopped generation
      var lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content += '\n\n*[已停止生成]*';
        renderAIMessages();
      }
    } else {
      showToast('AI请求失败: ' + err.message, 'error');
      // Remove empty assistant message on error
      var lm = msgs[msgs.length - 1];
      if (lm && lm.role === 'assistant' && lm.content === '') {
        msgs.pop();
        renderAIMessages();
      }
    }
  }
  
  aiState.isStreaming = false;
  aiState.currentAbortController = null;
  updateSendButton();
  removeAITyping();
}

function stopAIGeneration() {
  if (aiState.currentAbortController) {
    aiState.currentAbortController.abort();
  }
}

function updateSendButton() {
  var sendBtn = document.querySelector('.btn-send');
  var stopBtn = document.querySelector('.btn-stop');
  if (aiState.isStreaming) {
    if (sendBtn) sendBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'flex';
  } else {
    if (sendBtn) sendBtn.style.display = 'flex';
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

// ---- Typing indicator ----
function showAITyping() {
  var container = document.getElementById('aiMessages');
  if (!container) return;
  var typing = document.createElement('div');
  typing.className = 'ai-message assistant';
  typing.id = 'aiTyping';
  typing.innerHTML = '<div class="avatar">' + AI_ASSISTANTS[aiState.currentAssistant].icon + '</div>' +
    '<div class="bubble"><div class="ai-typing"><span></span><span></span><span></span></div></div>';
  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

function removeAITyping() {
  var typing = document.getElementById('aiTyping');
  if (typing) typing.remove();
}

// ---- New Chat ----
function newAIChat() {
  aiState.conversations[aiState.currentAssistant] = [];
  loadAIAssistant();
}

// ---- Load History ----
function loadHistory(index) {
  // Simple history loading - just switch to that assistant
  var h = aiState.historyList[index];
  if (h) {
    aiState.currentAssistant = h.assistantType;
    loadAIAssistant();
  }
}

// ============================================================
// FLOATING AI WIDGET
// ============================================================

// Toggle floating panel
function toggleAIFloating() {
  var panel = document.getElementById('aiFloatingPanel');
  if (!panel) return;
  
  if (aiState.floatingOpen) {
    panel.classList.remove('active');
    aiState.floatingOpen = false;
  } else {
    panel.classList.add('active');
    aiState.floatingOpen = true;
    // Ensure it's rendered
    if (panel.innerHTML.trim() === '') {
      renderFloatingPanel();
    }
    var input = document.getElementById('floatingInput');
    if (input) input.focus();
  }
}

function renderFloatingPanel() {
  var panel = document.getElementById('aiFloatingPanel');
  if (!panel) return;
  
  panel.innerHTML = `
    <div class="panel-header" id="floatingHeader">
      <h4>${AI_ASSISTANTS[aiState.currentAssistant].icon} ${AI_ASSISTANTS[aiState.currentAssistant].name}</h4>
      <div class="panel-actions">
        <select id="floatingAssistantSelect" onchange="switchFloatingAssistant(this.value)" style="font-size:11px;border:1px solid var(--border);border-radius:4px;padding:2px 4px;margin-right:4px;">
          ${Object.entries(AI_ASSISTANTS).map(function(entry) {
            return '<option value="' + entry[0] + '"' + (entry[0] === aiState.currentAssistant ? ' selected' : '') + '>' + entry[1].icon + ' ' + entry[1].name + '</option>';
          }).join('')}
        </select>
        <button onclick="toggleAIFloating()" title="关闭">✕</button>
      </div>
    </div>
    <div class="panel-messages" id="floatingMessages">
      <div class="ai-empty-state" style="padding:24px;">
        <div style="font-size:32px;">${AI_ASSISTANTS[aiState.currentAssistant].icon}</div>
        <p style="font-size:12px;margin-top:8px;">有什么可以帮你的？</p>
      </div>
    </div>
    <div class="panel-input">
      <input type="text" id="floatingInput" placeholder="输入问题..." onkeydown="if(event.key==='Enter')sendFloatingMessage()">
      <button onclick="sendFloatingMessage()">发送</button>
    </div>
  `;
  
  // Simple drag for panel header
  var header = document.getElementById('floatingHeader');
  var isDragging = false, startX, startY, startLeft, startBottom;
  
  header.addEventListener('mousedown', function(e) {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    var rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startBottom = window.innerHeight - rect.bottom;
    panel.style.transition = 'none';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    panel.style.left = (startLeft + dx) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = (startBottom - dy) + 'px';
  });
  
  document.addEventListener('mouseup', function() {
    isDragging = false;
    panel.style.transition = '';
  });
}

function switchFloatingAssistant(type) {
  aiState.currentAssistant = type;
  var select = document.getElementById('floatingAssistantSelect');
  if (select) select.value = type;
  renderFloatingPanel();
}

async function sendFloatingMessage() {
  var input = document.getElementById('floatingInput');
  if (!input) return;
  var text = input.value.trim();
  if (!text || aiState.isStreaming) return;
  input.value = '';
  
  var msgsContainer = document.getElementById('floatingMessages');
  if (!msgsContainer) return;
  
  // Clear empty state
  if (msgsContainer.querySelector('.ai-empty-state')) {
    msgsContainer.innerHTML = '';
  }
  
  // Add user bubble
  msgsContainer.innerHTML += '<div style="text-align:right;margin-bottom:10px;"><span style="background:var(--primary);color:white;padding:8px 12px;border-radius:12px;font-size:13px;display:inline-block;max-width:80%;">' + escapeHtml(text) + '</span></div>';
  
  // Add assistant bubble with typing
  var aiBubble = document.createElement('div');
  aiBubble.style.cssText = 'margin-bottom:10px;';
  aiBubble.innerHTML = '<span style="background:var(--bg);padding:8px 12px;border-radius:12px;font-size:13px;display:inline-block;max-width:80%;"><div class="ai-typing"><span></span><span></span><span></span></div></span>';
  msgsContainer.appendChild(aiBubble);
  msgsContainer.scrollTop = msgsContainer.scrollHeight;
  
  aiState.isStreaming = true;
  
  try {
    var controller = new AbortController();
    aiState.currentAbortController = controller;
    
    var msgs = aiState.conversations[aiState.currentAssistant] || [];
    msgs.push({ role: 'user', content: text });
    
    var response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        assistantType: aiState.currentAssistant,
        messages: msgs.slice(-10),
      }),
      signal: controller.signal,
    });
    
    if (!response.ok) {
      var err = await response.json();
      throw new Error(err.error || '请求失败');
    }
    
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var fullContent = '';
    
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || !line.startsWith('data: ')) continue;
        var data = line.slice(6);
        if (data === '[DONE]') continue;
        
        try {
          var parsed = JSON.parse(data);
          if (parsed.content) {
            fullContent += parsed.content;
            aiBubble.querySelector('span').innerHTML = formatAIMarkdown(fullContent);
            msgsContainer.scrollTop = msgsContainer.scrollHeight;
          } else if (parsed.error) {
            throw new Error(parsed.error);
          }
        } catch (e) {}
      }
    }
    
    msgs.push({ role: 'assistant', content: fullContent });
    
  } catch (err) {
    if (err.name !== 'AbortError') {
      aiBubble.querySelector('span').innerHTML = '<span style="color:var(--danger);">请求失败: ' + escapeHtml(err.message) + '</span>';
    }
  }
  
  aiState.isStreaming = false;
  aiState.currentAbortController = null;
}

// ============================================================
// EVENT ANALYSIS - Quick CAPA/RCA Analysis
// ============================================================
async function analyzeEventWithAI(eventId) {
  showToast('正在进行AI分析...', 'info');
  
  // Switch to CAPA/RCA assistant
  aiState.currentAssistant = 'capa_rca';
  
  try {
    var response = await fetch('/api/ai/analyze-event/' + eventId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
    });
    
    if (!response.ok) {
      var err = await response.json();
      throw new Error(err.error || '分析失败');
    }
    
    var data = await response.json();
    
    // Navigate to AI page and show result
    navigate('ai');
    aiState.conversations['capa_rca'] = [
      { role: 'user', content: '请对质量事件 ' + eventId + ' 进行根因分析' },
      { role: 'assistant', content: data.content },
    ];
    
    // Render after a short delay to ensure page is loaded
    setTimeout(function() {
      renderAIMessages();
    }, 200);
    
    showToast('AI分析完成', 'success');
  } catch (err) {
    showToast('AI分析失败: ' + err.message, 'error');
  }
}

// ============================================================
// RISK PREDICTION - Dashboard Quick Analysis
// ============================================================
async function runRiskPrediction() {
  showToast('正在进行风险预测...', 'info');
  
  aiState.currentAssistant = 'risk_prediction';
  
  try {
    var response = await fetch('/api/ai/risk-predict', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
    });
    
    if (!response.ok) {
      var err = await response.json();
      throw new Error(err.error || '预测失败');
    }
    
    var data = await response.json();
    
    navigate('ai');
    aiState.conversations['risk_prediction'] = [
      { role: 'user', content: '请基于当前质量数据进行风险预测分析' },
      { role: 'assistant', content: data.content },
    ];
    
    setTimeout(function() {
      renderAIMessages();
    }, 200);
    
    showToast('风险预测完成', 'success');
  } catch (err) {
    showToast('风险预测失败: ' + err.message, 'error');
  }
}

console.log('🤖 FDQH AI Chat module initialized');
