/**
 * finish-run.mjs — 用已保存的 shots.json 补做「汇总」，然后导出 Markdown
 * 用法: node finish-run.mjs <shots.json> <out.md> [castHint]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat } from './assets/providers.js';
import { buildSummaryMessages, parseSummaryJSON } from './assets/summary.js';
import { toMarkdown } from './assets/exporter.js';

const [shotsFile, outFile, hintArg] = process.argv.slice(2);
if (!shotsFile || !outFile) throw new Error('用法: node finish-run.mjs <shots.json> <out.md> [castHint]');

const key = /api_key:\s*'([^']+)'/.exec(fs.readFileSync('assets/config.local.js', 'utf8'))?.[1];
if (!key) throw new Error('assets/config.local.js 里没有 Key');

const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'));
const castHint = hintArg || '';
const cfg = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com/v1',
  model_name: 'deepseek-flash',
  api_key: key,
  temperature: 0.3,
  max_tokens: 8192,
  effort: 'low',
  vision: true
};

let extras = { title: '', characters: [], structure: [], notes: [] };
let tokens = 0;
try {
  const msgs = buildSummaryMessages(shots, { castHint });
  let { text, usage } = await chat(cfg, msgs);
  tokens += usage?.total_tokens || 0;
  try {
    extras = parseSummaryJSON(text);
  } catch {
    const retry = msgs.concat([
      { role: 'assistant', content: text.slice(0, 300) },
      { role: 'user', content: '上一条不是 JSON 对象。请只输出 JSON 对象，不要解释。' }
    ]);
    const r2 = await chat(cfg, retry);
    tokens += r2.usage?.total_tokens || 0;
    extras = parseSummaryJSON(r2.text);
  }
} catch (e) {
  console.log('汇总失败（继续导出镜头表）：', e.message);
}

const md = toMarkdown({
  filename: 'e739354a287182bb55355e62583efb64.mp4',
  generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  model: cfg.model_name,
  duration: shots[shots.length - 1].end,
  width: 544,
  height: 960
}, shots, extras);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, md);
console.log(`镜头 ${shots.length} 个；角色 ${extras.characters.length}；结构 ${extras.structure.length}；要点 ${extras.notes.length}`);
console.log(`汇总 tokens ${tokens}`);
console.log('输出：', outFile);
