/**
 * providers.js — 统一模型调用层（OpenAI-compatible + Anthropic）
 */

export function normalizeBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

export function endpointFor(cfg) {
  const base = normalizeBase(cfg.base_url);
  if (/\/chat\/completions$/.test(base)) return base;
  if (cfg.provider === 'anthropic') {
    return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  return `${base}/chat/completions`;
}

function splitDataUrl(url) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(url || '');
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

function toAnthropic(messages) {
  let system = '';
  const out = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
      continue;
    }
    const content = [];
    if (typeof msg.content === 'string') {
      content.push({ type: 'text', text: msg.content });
    } else {
      for (const part of msg.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url') {
          const d = splitDataUrl(part.image_url?.url);
          if (d) content.push({ type: 'image', source: { type: 'base64', media_type: d.media_type, data: d.data } });
        }
      }
    }
    out.push({ role: msg.role, content });
  }
  return { system, messages: out };
}

function extractText(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  let text = msg.content;
  if (Array.isArray(text)) text = text.map(p => p?.text || '').join('');
  if (!text && msg.reasoning_content) text = msg.reasoning_content;
  if (!text && typeof choice?.text === 'string') text = choice.text;
  return text || '';
}

async function readError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || j?.message || JSON.stringify(j).slice(0, 300);
  } catch {
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
  }
  return detail || res.statusText || `HTTP ${res.status}`;
}

/**
 * 发一次对话请求
 * @param {object} cfg 模型配置
 * @param {Array} messages OpenAI 风格消息
 * @param {AbortSignal} signal
 * @returns {{text:string, usage:object|null, raw:object}}
 */
export async function chat(cfg, messages, signal) {
  if (!cfg.api_key) throw new Error('缺少 API Key（去「模型设置」里填）');
  const url = endpointFor(cfg);
  const isAnthropic = cfg.provider === 'anthropic';

  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (isAnthropic) {
    const { system, messages: am } = toAnthropic(messages);
    headers['x-api-key'] = cfg.api_key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = {
      model: cfg.model_name,
      max_tokens: Number(cfg.max_tokens) || 4096,
      temperature: Number(cfg.temperature ?? 0.3),
      system,
      messages: am
    };
  } else {
    headers['Authorization'] = `Bearer ${cfg.api_key}`;
    body = {
      model: cfg.model_name,
      messages,
      temperature: Number(cfg.temperature ?? 0.3),
      max_tokens: Number(cfg.max_tokens) || 4096,
      stream: false
    };
    if (cfg.provider === 'deepseek' && cfg.effort) body.effort = cfg.effort;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const detail = await readError(res);
    const err = new Error(`模型接口 ${res.status}：${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = isAnthropic
    ? (data?.content || []).map(p => p?.text || '').join('')
    : extractText(data);

  return { text, usage: data?.usage || null, raw: data };
}

/** 连通性测试：发一句最短的话 */
export async function testConnection(cfg) {
  const t0 = performance.now();
  const { text, raw } = await chat(cfg, [
    { role: 'user', content: '回复两个字：可用' }
  ]);
  return {
    ms: Math.round(performance.now() - t0),
    model: raw?.model || cfg.model_name,
    text: (text || '').slice(0, 30)
  };
}
