// ============================================================
// FDQH AI Service Module
// Supports: Qwen (primary), DeepSeek (fallback)
// OpenAI-compatible API format
// ============================================================

const { SYSTEM_PROMPTS, QUICK_QUESTIONS } = require('./prompts');

// Configuration
const AI_CONFIG = {
  // Primary: 阿里百炼 Qwen
  primary: {
    baseURL: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '',
    model: process.env.AI_MODEL || 'qwen-plus',
    enabled: true,
  },
  // Fallback: DeepSeek
  fallback: {
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: 'deepseek-chat',
    enabled: true,
  },
};

// Check if AI features are available
function isAvailable() {
  return !!(AI_CONFIG.primary.apiKey || AI_CONFIG.fallback.apiKey);
}

// Get active provider
function getProvider() {
  if (AI_CONFIG.primary.apiKey && AI_CONFIG.primary.enabled) {
    return AI_CONFIG.primary;
  }
  if (AI_CONFIG.fallback.apiKey && AI_CONFIG.fallback.enabled) {
    return AI_CONFIG.fallback;
  }
  return null;
}

// Get system prompt for a given assistant type
function getSystemPrompt(assistantType) {
  return SYSTEM_PROMPTS[assistantType] || SYSTEM_PROMPTS.quality_expert;
}

// Get quick questions
function getQuickQuestions(assistantType) {
  return QUICK_QUESTIONS[assistantType] || QUICK_QUESTIONS.quality_expert;
}

// Build messages array with context
function buildMessages(assistantType, conversationHistory, contextData) {
  const systemPrompt = getSystemPrompt(assistantType);
  const messages = [{ role: 'system', content: systemPrompt }];

  // Inject context data (e.g., current event details for CAPA analysis)
  if (contextData) {
    let contextStr = '## 当前分析上下文数据:\n';
    try {
      contextStr += JSON.stringify(contextData, null, 2);
    } catch (e) {
      contextStr += String(contextData);
    }
    messages.push({ role: 'system', content: contextStr });
  }

  // Add conversation history (last 20 messages)
  if (conversationHistory && conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-20);
    messages.push(...recent);
  }

  return messages;
}

// Helper function to get the Node.js fetch (handle both built-in and older versions)
let nodeFetch;
try {
  nodeFetch = globalThis.fetch;
} catch (e) {
  // Fallback for older Node.js
}

// Make streaming API call
async function streamChat(assistantType, messages, res) {
  const provider = getProvider();
  if (!provider) {
    res.write('data: ' + JSON.stringify({ error: 'AI服务未配置，请设置环境变量 DASHSCOPE_API_KEY 或 DEEPSEEK_API_KEY' }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // For nginx

  // If fetch is not available, use https module
  if (!nodeFetch) {
    return legacyStreamChat(provider, messages, res);
  }

  try {
    const url = provider.baseURL.replace(/\/+$/, '') + '/chat/completions';
    const response = await nodeFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + provider.apiKey,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(120000), // 2 minute timeout
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg;
      try {
        errMsg = JSON.parse(errText);
      } catch (e) {
        errMsg = { error: errText };
      }
      
      // If primary fails, try fallback
      if (provider === AI_CONFIG.primary && AI_CONFIG.fallback.apiKey) {
        res.write('data: ' + JSON.stringify({ status: 'fallback', message: '正在切换到备用AI服务...' }) + '\n\n');
        AI_CONFIG.primary.enabled = false;
        return streamChat(assistantType, messages, res);
      }
      
      res.write('data: ' + JSON.stringify({ error: 'AI服务请求失败: ' + (errMsg.error?.message || errMsg.error || 'Unknown error') }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Stream the response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            res.write('data: ' + JSON.stringify({ content: delta.content }) + '\n\n');
          }
        } catch (e) {
          // Skip malformed JSON
        }
      }
    }

    // Re-enable primary if it was disabled for fallback
    AI_CONFIG.primary.enabled = true;
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('AI Stream Error:', err.message);
    
    // Try fallback on any error
    if (provider === AI_CONFIG.primary && AI_CONFIG.fallback.apiKey) {
      res.write('data: ' + JSON.stringify({ status: 'fallback', message: '主AI服务异常，正在切换...' }) + '\n\n');
      AI_CONFIG.primary.enabled = false;
      return streamChat(assistantType, messages, res);
    }
    
    res.write('data: ' + JSON.stringify({ error: 'AI服务连接失败: ' + err.message }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// Legacy streaming for Node.js without built-in fetch
function legacyStreamChat(provider, messages, res) {
  const https = require('https');
  const http = require('http');
  const urlModule = require('url');

  const urlStr = provider.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const parsedUrl = urlModule.parse(urlStr);
  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const requestBody = JSON.stringify({
    model: provider.model,
    messages: messages,
    stream: true,
    temperature: 0.7,
    max_tokens: 4096,
  });

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + provider.apiKey,
      'Content-Length': Buffer.byteLength(requestBody),
    },
    timeout: 120000,
  };

  const req = transport.request(options, (apiRes) => {
    if (apiRes.statusCode !== 200) {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        res.write('data: ' + JSON.stringify({ error: 'AI服务返回错误: HTTP ' + apiRes.statusCode }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }

    let buffer = '';
    apiRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            res.write('data: ' + JSON.stringify({ content: delta.content }) + '\n\n');
          }
        } catch (e) {
          // Skip malformed JSON
        }
      }
    });

    apiRes.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

    apiRes.on('error', (err) => {
      console.error('AI Response Error:', err.message);
      res.write('data: ' + JSON.stringify({ error: 'AI响应中断: ' + err.message }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  req.on('error', (err) => {
    console.error('AI Request Error:', err.message);
    res.write('data: ' + JSON.stringify({ error: 'AI服务连接失败: ' + err.message }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  req.on('timeout', () => {
    req.destroy();
    res.write('data: ' + JSON.stringify({ error: 'AI服务超时，请稍后重试' }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  req.write(requestBody);
  req.end();
}

// Non-streaming chat (for simple queries)
async function chat(assistantType, messages) {
  const provider = getProvider();
  if (!provider) {
    throw new Error('AI服务未配置');
  }

  const body = JSON.stringify({
    model: provider.model,
    messages: messages,
    temperature: 0.7,
    max_tokens: 4096,
  });

  // Use https module directly for compatibility
  const result = await new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const urlModule = require('url');
    
    const urlStr = provider.baseURL.replace(/\/+$/, '') + '/chat/completions';
    const parsedUrl = urlModule.parse(urlStr);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + provider.apiKey,
      },
      timeout: 120000,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(result.choices?.[0]?.message?.content || '');
          } else {
            reject(new Error(result.error?.message || 'API error: ' + res.statusCode));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('AI请求超时')); });
    req.write(body);
    req.end();
  });

  return result;
}

module.exports = {
  isAvailable,
  getProvider,
  getSystemPrompt,
  getQuickQuestions,
  buildMessages,
  streamChat,
  chat,
  AI_CONFIG,
};
