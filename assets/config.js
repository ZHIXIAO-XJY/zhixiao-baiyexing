/**
 * config.js — 默认模型配置
 *
 * ⚠️ 安全说明
 * 下面这个 Key 是「演示用临时密钥」，写在静态文件里等于公开，任何人都能拿到并刷爆它。
 * 公开部署（GitHub Pages 等）前请：
 *   1) 到设置面板换成自己的 Key（只存在浏览器 localStorage，不进代码）；
 *   2) 或者把站点放在 Cloudflare Worker / Vercel Function 后面做代理，Key 放服务端。
 */

const LOCAL = (typeof window !== 'undefined' && window.SB_LOCAL_CONFIG) || {};

export const DEFAULT_MODEL_CONFIG = {
  provider: 'deepseek',
  // 端点：OpenAI-compatible。DeepSeek 官方 v1 根路径即可，代码会自动补 /chat/completions
  base_url: 'https://api.deepseek.com/v1',
  // 真实可用的模型 id 是 deepseek-flash（即 DeepSeek-V4.1-Flash），支持图像输入；
  // 客户端里的 "V4.1 Flash High" 对应 effort=high（默认）。
  model_name: 'deepseek-flash',
  display_name: 'DeepSeek-V4.1-Flash · High',
  // 仓库里不放真实 Key。本地调试时新建 assets/config.local.js（已 gitignore）写入：
  //   window.SB_LOCAL_CONFIG = { api_key: 'sk-…' };
  api_key: LOCAL.api_key || '',
  temperature: 0.3,
  max_tokens: 4096,
  effort: 'high',
  vision: true
};

export const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek（官方）',
    base_url: 'https://api.deepseek.com/v1',
    model_name: 'deepseek-flash',
    vision: true
  },
  openai: {
    label: 'OpenAI 兼容接口',
    base_url: 'https://api.openai.com/v1',
    model_name: 'gpt-4o-mini',
    vision: true
  },
  anthropic: {
    label: 'Anthropic',
    base_url: 'https://api.anthropic.com',
    model_name: 'claude-3-5-sonnet-latest',
    vision: true
  },
  ollama: {
    label: 'Ollama（本地）',
    base_url: 'http://localhost:11434/v1',
    model_name: 'qwen2.5-vl:7b',
    vision: true
  }
};

/** 拆解输出的字段定义（核心 6 列 + 可选扩展 4 列） */
export const CORE_FIELDS = [
  { key: 'visual', label: 'Visual Description', cn: '画面描述' },
  { key: 'dialogue', label: 'Dialogue / Narration', cn: '对白·旁白' },
  { key: 'camera', label: 'Camera Movement', cn: '运镜' },
  { key: 'audio', label: 'Audio / SFX', cn: '音效·BGM' }
];

export const EXT_FIELDS = [
  { key: 'composition', label: 'Composition', cn: '构图' },
  { key: 'lighting', label: 'Lighting', cn: '光线' },
  { key: 'gaze', label: 'Eye Contact', cn: '眼神交互' },
  { key: 'emotion', label: 'Emotion Arc', cn: '神态·表情轨迹' }
];

export const DEMO_KEY = LOCAL.api_key || '';
