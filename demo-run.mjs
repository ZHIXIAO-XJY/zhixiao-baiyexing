/**
 * demo-run.mjs — 用真实视频跑一遍应用同款链路（不走浏览器，直接调模块）
 * 输入：本地视频切片的关键帧 → buildBatchMessages → chat → parseShotJSON → 导出 Markdown
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildBatchMessages, parseShotJSON } from './assets/prompt.js';
import { buildSummaryMessages, parseSummaryJSON } from './assets/summary.js';
import { chat } from './assets/providers.js';
import { toMarkdown } from './assets/exporter.js';

const ROOT = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace';
const VIDEO = `${ROOT}/xwechat_files_placeholder`;
const KEY_FILE = `${ROOT}/scriptbreaker/assets/config.local.js`;
const OUT = process.env.OUT || path.join(`${ROOT}/vsre/_probe`, 'sample_run.md');

const keyMatch = /api_key:\s*'([^']+)'/.exec(fs.readFileSync(KEY_FILE, 'utf8'));
const cfg = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com/v1',
  model_name: 'deepseek-flash',
  api_key: keyMatch ? keyMatch[1] : process.env.DS_KEY,
  temperature: 0.3,
  max_tokens: 8192,
  effort: 'low',
  vision: true
};
if (!cfg.api_key) throw new Error('没有可用 Key');

const args = process.argv.slice(2);
const video = args[0];
const startSec = Number(args[1] || 0);
const durSec = Number(args[2] || 60);
const step = Number(args[3] || 5);
const castHint = process.env.CAST_HINT || '';
if (!video || !fs.existsSync(video)) throw new Error('用法: node demo-run.mjs <video> [start] [duration] [step]');

const tmp = `${ROOT}/vsre/_probe/run_frames`;
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

console.log(`切片 ${startSec}s + ${durSec}s，每 ${step}s 一帧`);
execFileSync('ffmpeg', [
  '-y', '-v', 'error', '-ss', String(startSec), '-t', String(durSec), '-i', video,
  '-vf', `fps=1/${step},scale=420:-2`, '-q:v', '3', `${tmp}/f%03d.jpg`
]);

const files = fs.readdirSync(tmp).filter(f => f.endsWith('.jpg')).sort();
console.log('抽到帧：', files.length);

const shots = files.map((f, i) => ({
  id: i + 1,
  start: startSec + i * step,
  end: startSec + Math.min((i + 1) * step, durSec),
  thumb: `data:image/jpeg;base64,${fs.readFileSync(path.join(tmp, f)).toString('base64')}`
}));

const t0 = Date.now();
let tokens = 0;
const batchSize = 6;
for (let i = 0; i < shots.length; i += batchSize) {
  const batch = shots.slice(i, i + batchSize);
  const t = Date.now();
  let { text, usage } = await chat(cfg, buildBatchMessages(batch, { vision: true, lang: 'zh', castHint }));
  let parsed;
  try {
    parsed = parseShotJSON(text, batch.length);
  } catch (e) {
    console.log('  解析失败，原始回复前 160 字：', text.slice(0, 160).replace(/\n/g, ' '));
    const retryMsgs = buildBatchMessages(batch, { vision: true, lang: 'zh', castHint });
    retryMsgs.push({ role: 'assistant', content: text.slice(0, 400) });
    retryMsgs.push({ role: 'user', content: '上一条不是合法 JSON 数组。请只输出 JSON 数组，长度与镜头数一致，不要任何解释。' });
    const r2 = await chat(cfg, retryMsgs);
    text = r2.text;
    usage = r2.usage;
    parsed = parseShotJSON(text, batch.length);
  }
  parsed.forEach((p, idx) => Object.assign(batch[idx], p));
  tokens += usage?.total_tokens || 0;
  console.log(`  批 ${i / batchSize + 1}: ${Date.now() - t}ms, tokens ${usage?.total_tokens}, 首句「${(batch[0].visual || '').slice(0, 18)}…」`);
}

fs.writeFileSync(OUT.replace(/\.md$/, '') + '.shots.json', JSON.stringify(shots.map(s => ({ ...s, thumb: undefined })), null, 1));

let extras = { title: '', characters: [], structure: [], notes: [] };
try {
  const sumCfg = { ...cfg, effort: 'low', max_tokens: 8192 };
  let { text: smText, usage: smUsage } = await chat(sumCfg, buildSummaryMessages(shots, { castHint }));
  let usedTokens = smUsage?.total_tokens || 0;
  try { extras = parseSummaryJSON(smText); } catch (e) {
    const retry = buildSummaryMessages(shots, { castHint }).concat([
      { role: 'assistant', content: smText.slice(0, 300) },
      { role: 'user', content: '上一条不是 JSON 对象。请只输出 JSON 对象，不要解释。' }
    ]);
    const r2 = await chat(sumCfg, retry);
    usedTokens += r2.usage?.total_tokens || 0;
    extras = parseSummaryJSON(r2.text);
  }
  tokens += usedTokens;
} catch (e) {
  console.log('汇总失败（不影响镜头表）：', e.message);
}
tokens += smUsage?.total_tokens || 0;
console.log(`汇总：角色 ${extras.characters.length} · 结构 ${extras.structure.length} · 要点 ${extras.notes.length}`);

const md = toMarkdown({
  filename: path.basename(video),
  generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  model: cfg.model_name,
  duration: durSec,
  width: 544,
  height: 960
}, shots, extras);

fs.writeFileSync(OUT, md);
console.log(`\n完成：${((Date.now() - t0) / 1000).toFixed(1)}s，共 ${tokens} tokens`);
console.log('输出：', OUT);
