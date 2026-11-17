/**
 * e2e.mjs — 用真实 API 跑一遍完整链路：帧 → 提示词 → 模型 → 解析
 * 只验证「app 生成的请求」能不能被真实接口接受、返回能不能解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBatchMessages, parseShotJSON } from './assets/prompt.js';
import { chat } from './assets/providers.js';
import { DEFAULT_MODEL_CONFIG } from './assets/config.js';

const ROOT = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace';
const frames = [
  { id: 1, start: 0, end: 13, file: `${ROOT}/vsre/_probe/k422.png` },
  { id: 2, start: 60, end: 66, file: `${ROOT}/vsre/_probe/k226.png` },
  { id: 3, start: 200, end: 205, file: `${ROOT}/vsre/_probe/k345.png` }
];

// 模拟浏览器 canvas.toDataURL 的产物（缩小到 360px 宽，q0.7）
const { execFileSync } = await import('node:child_process');
const PY = 'C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';
execFileSync(PY, ['-c', `
from PIL import Image
for i,f in enumerate(['k422','k226','k345']):
    im=Image.open(r'${ROOT}/vsre/_probe/'+f+'.png').convert('RGB')
    im.thumbnail((360,360)); im.save(r'${ROOT}/vsre/_probe/e'+str(i)+'.jpg',quality=70)
`]);

frames.forEach((f, i) => {
  const b64 = fs.readFileSync(`${ROOT}/vsre/_probe/e${i}.jpg`).toString('base64');
  f.thumb = `data:image/jpeg;base64,${b64}`;
});

const shots = frames.map(({ id, start, end, thumb }) => ({ id, start, end, thumb }));

const messages = buildBatchMessages(shots, { vision: true, lang: 'zh' });
const payloadSize = JSON.stringify(messages).length;
console.log('提示词大小：', (payloadSize / 1024).toFixed(1), 'KB；消息块：', messages[1].content.length);

const cfg = { ...DEFAULT_MODEL_CONFIG };
const t0 = Date.now();
const { text, usage } = await chat(cfg, messages);
const ms = Date.now() - t0;

console.log('耗时：', ms, 'ms');
console.log('usage：', JSON.stringify(usage));
console.log('原始回复前 200 字：', text.slice(0, 200).replace(/\n/g, ' '));

const parsed = parseShotJSON(text, shots.length);
console.log('\n解析结果：');
for (const p of parsed) {
  console.log(`- ${p.visual.slice(0, 40)}… | 台词: ${(p.dialogue || 'null').slice(0, 20)} | 运镜: ${p.camera.slice(0, 20)}`);
}
console.log('\n字段完整性：', parsed.every(p => p.visual && p.camera && p.audio !== undefined));
