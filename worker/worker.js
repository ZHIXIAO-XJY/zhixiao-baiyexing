/**
 * Cloudflare Worker —— 给 ScriptBreaker 做一层代理，把 Key 放在服务端。
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler secret put DEEPSEEK_KEY      # 粘贴你的 sk-...
 *   wrangler deploy
 *
 * 前端：
 *   模型设置 → Base URL 改成 https://<worker>.workers.dev/v1
 *   模型名 deepseek-flash，Key 随便填（页面不会再用它）
 */

const UPSTREAM = 'https://api.deepseek.com/v1/chat/completions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    const body = await request.text();
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_KEY}`
      },
      body
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': upstream.headers.get('content-type') || 'application/json' }
    });
  }
};
