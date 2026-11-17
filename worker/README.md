# ScriptBreaker 代理 Worker

把 DeepSeek 的 Key 放在服务端，前端不需要持有密钥。

## 已部署

```
https://scriptbreaker-proxy.805352942.workers.dev
```

- 账户：`805352942@qq.com's Account`（id `97dbeac16b7885b0ba2618f816c3cd13`）
- 子域：`805352942.workers.dev`
- 密钥：`DEEPSEEK_KEY` 已写入（secret，不可读回）
- Origin 白名单：`https://zhixiao-xjy.github.io`（实测恶意 Origin 返回 403）
- 限流：同 isolate 内每 IP 10 分钟 40 次；请求体 ≤ 3 MB

前端配置方式：「模型设置」里

| 项 | 值 |
|---|---|
| Base URL | `https://scriptbreaker-proxy.805352942.workers.dev/v1` |
| 模型 | `deepseek-flash` |
| API Key | 随便填（代理会忽略并换成服务端密钥） |

> 注意：Worker 的路径是 `/v1/chat/completions`，所以 Base URL 末尾要带 `/v1`。

## ⚠️ 中国大陆可访问性

`*.workers.dev` 在国内 **DNS 被污染**（解析到 `108.160.163.116` / Facebook 的 IPv6），直连超时；挂代理访问正常（实测 200）。

如果站点主要面向国内访客，需要：

1. 给 Worker 绑一个**自己的域名**（该账号目前没有 zone，需要先把域名接入 Cloudflare）；
2. 或者把同一份 `worker.js` 部署到国内可访问的函数计算/服务器上（代码不用改，只换运行环境）。

## 重新部署

```bash
# 方式一：wrangler
npm i -g wrangler
wrangler login
wrangler secret put DEEPSEEK_KEY
wrangler deploy

# 方式二：API（无需 wrangler）
# PUT /accounts/{account_id}/workers/scripts/scriptbreaker-proxy
#   multipart: metadata + worker.js
# PUT .../secrets  {name:DEEPSEEK_KEY,type:secret_text,text:...}
# POST .../subdomain {enabled:true}
```
