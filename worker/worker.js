/**
 * ScriptBreaker 代理 —— Cloudflare Worker
 *
 * 作用：把 DeepSeek 的 Key 放在服务端，前端不需要也不应该持有密钥。
 * 防护：Origin 白名单 + 每 IP 限流 + 请求体大小上限。
 *
 * 环境变量（wrangler secret / API 写入）：
 *   DEEPSEEK_KEY   必填，sk- 开头
 *   ALLOW_ORIGIN   可选，逗号分隔，默认 https://zhixiao-xjy.github.io
 *   PASSCODE       可选，访问口令（请求头 X-SB-Code）；不设则不校验
 */

const UPSTREAM = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_ORIGIN = 'https://zhixiao-xjy.github.io';
const MAX_BODY = 3 * 1024 * 1024;      // 3MB，够 8 张 420px 关键帧
const RATE_LIMIT = 40;                 // 每个 isolate 内、每个 IP 的窗口额度
const WINDOW_MS = 10 * 60 * 1000;

const hits = new Map(); // isolate 内存，仅作尽力而为的限流

function allowList(env) {
  return String(env.ALLOW_ORIGIN || DEFAULT_ORIGIN)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? origin : allowed[0] || DEFAULT_ORIGIN,
      'Access-Control-Allow-Headers': 'content-type, authorization, x-sb-code',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    }
  };
}

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE_LIMIT;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = allowList(env);
    const { ok, headers } = corsHeaders(origin, allowed);
    const json = (status, obj) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: ok ? 204 : 403, headers });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!ok) return json(403, { error: `Origin ${origin || '(none)'} 不在白名单` });

    if (!env.DEEPSEEK_KEY) return json(500, { error: '服务端未配置 DEEPSEEK_KEY' });

    // 口令门槛：只防脚本白嫖，不是强安全（前端可见）
    if (env.PASSCODE) {
      const code = request.headers.get('x-sb-code') || new URL(request.url).searchParams.get('code') || '';
      if (code !== env.PASSCODE) return json(401, { error: '口令不对' });
    }

    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) return json(413, { error: '请求体过大' });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (limited(ip)) return json(429, { error: '请求太频繁，稍后再试' });

    const body = await request.text();
    if (body.length > MAX_BODY) return json(413, { error: '请求体过大' });

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.DEEPSEEK_KEY}`
        },
        body
      });
    } catch (e) {
      return json(502, { error: `上游不可达：${e.message}` });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...headers,
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  }
};
