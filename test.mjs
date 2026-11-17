import { buildShots, fmtTime, pickInterval } from './assets/cv.js';
import { parseShotJSON, parseSubtitles, attachSubtitles } from './assets/prompt.js';
import { toMarkdown, toCSV, toJSON, hasExt } from './assets/exporter.js';
import { endpointFor, normalizeBase } from './assets/providers.js';
import { renumber, mergeShots, splitShot, deleteShots, qcShots, autoFix } from './assets/qc.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}

console.log('\n[cv]');
ok('fmtTime 0', fmtTime(0) === '00:00:00');
ok('fmtTime 3725', fmtTime(3725) === '01:02:05');
ok('pickInterval 30s', pickInterval(30) === 0.5);
ok('pickInterval 300s', pickInterval(300) === 2);

const shots = buildShots([5, 10, 10.5], 30, { mergeShort: true });
ok('切点数量', shots.length >= 2, JSON.stringify(shots));
ok('首镜从 0 开始', shots[0].start === 0);
ok('末镜到片尾', shots[shots.length - 1].end === 30);
ok('区间连续', shots.every((s, i) => i === 0 || Math.abs(s.start - shots[i - 1].end) < 0.01));

console.log('\n[prompt]');
const arr = parseShotJSON('```json\n[{"visual":"雨天巷子","dialogue":null,"camera":"固定"},{"visual":"特写"}]\n```', 2);
ok('去代码块', arr.length === 2 && arr[0].visual === '雨天巷子');
ok('null 台词', arr[0].dialogue === null);
ok('缺字段补空', arr[1].audio === '' && arr[1].camera === '');

const pad = parseShotJSON('[{"visual":"a"}]', 3);
ok('补齐数量', pad.length === 3 && pad[2].visual === '');

const trunc = parseShotJSON('[{"visual":"a"},{"visual":"b"},{"visual":"c"', 3);
ok('截断容错', trunc.length === 3 && trunc[1].visual === 'b');

const subs = parseSubtitles('00:02 孩子都七个月了\n00:04 你俩离婚才半年');
ok('字幕解析', subs.length === 2 && subs[0].t === 2 && subs[1].text.includes('离婚'));

const srt = parseSubtitles('1\n00:00:03,000 --> 00:00:05,000\n第一句\n\n2\n00:00:06,000 --> 00:00:08,000\n第二句');
ok('SRT 解析', srt.length === 2 && srt[0].t === 3 && srt[1].text === '第二句', JSON.stringify(srt));

const withSubs = attachSubtitles([{ id: 1, start: 0, end: 5 }], srt);
ok('字幕挂到镜头', withSubs[0].subtitle.includes('第一句'));

console.log('\n[exporter]');
const meta = { filename: 'a.mp4', generatedAt: '2026-11-17 20:00', model: 'deepseek-flash', duration: 30, width: 720, height: 1280 };
const demo = [{ id: 1, start: 0, end: 5, visual: '巷 | 子', dialogue: '台词', camera: '固定', audio: '雨声' }];
const md = toMarkdown(meta, demo);
ok('md 有表头', md.includes('| Shot ID | Timecode |'));
ok('md 转义竖线', md.includes('巷 \\| 子'));
ok('md 时间码', md.includes('00:00:00 - 00:00:05'));
ok('md 无扩展列', !md.includes('Composition'));

const withExt = [{ ...demo[0], composition: '中景', lighting: '侧光' }];
ok('扩展列检测', hasExt(withExt));
ok('md 扩展列', toMarkdown(meta, withExt).includes('Composition'));

const csv = toCSV(meta, demo);
ok('csv BOM', csv.charCodeAt(0) === 0xFEFF);
ok('csv 引号转义', csv.includes('"台词"'));

const js = JSON.parse(toJSON(meta, demo));
ok('json 结构', js.shots[0].timecode.start === '00:00:00' && js.meta.model === 'deepseek-flash');

console.log('\n[providers]');
ok('去尾斜杠', normalizeBase('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1');
ok('补 completions', endpointFor({ provider: 'deepseek', base_url: 'https://api.deepseek.com/v1' }) === 'https://api.deepseek.com/v1/chat/completions');
ok('已完整不重复', endpointFor({ provider: 'openai', base_url: 'https://x/v1/chat/completions' }) === 'https://x/v1/chat/completions');
ok('anthropic 端点', endpointFor({ provider: 'anthropic', base_url: 'https://api.anthropic.com' }) === 'https://api.anthropic.com/v1/messages');

console.log('\n[qc]');
const mk = (id, s, e, extra = {}) => ({ id, start: s, end: e, visual: 'v' + id, camera: 'c', audio: 'a', dialogue: null, ...extra });

const arr2 = [mk(2, 10, 20), mk(1, 0, 10)];
renumber(arr2);
ok('重排后重新编号', arr2[0].id === 1 && arr2[1].id === 2 && arr2[0].start === 0);

let m = mergeShots([mk(1, 0, 10), mk(2, 10, 20), mk(3, 20, 30)], [1, 2]);
ok('合并相邻两镜', m.shots.length === 2 && m.shots[0].end === 20, JSON.stringify(m.shots?.map(x => [x.id, x.start, x.end])));
ok('合并保留台词', mergeShots([mk(1, 0, 10, { dialogue: '甲' }), mk(2, 10, 20, { dialogue: '乙' })], [1, 2]).merged.dialogue === '甲 乙');
ok('合并不相邻报错', !!mergeShots([mk(1, 0, 10), mk(2, 11, 20)], [1, 2]).error);
ok('合并单个报错', !!mergeShots([mk(1, 0, 10)], [1]).error);

let sp = splitShot([mk(1, 0, 20)], 8);
ok('拆分成功', sp.shots.length === 2 && sp.shots[0].end === 8 && sp.shots[1].start === 8);
ok('拆分右侧清空字段', sp.right.visual === '' && sp.right.thumb === null);
ok('贴边不拆', !!splitShot([mk(1, 0, 20)], 0.1).error);

let del = deleteShots([mk(1, 0, 10), mk(2, 10, 20), mk(3, 20, 30)], [2]);
ok('删除并接续', del.length === 2 && del[0].end === 20, JSON.stringify(del.map(x => [x.id, x.start, x.end])));

const good = [mk(1, 0, 10), mk(2, 10, 20)];
ok('质检通过', qcShots(good).length === 0, JSON.stringify(qcShots(good)));
const gap = [mk(1, 0, 10), mk(2, 12, 20)];
ok('质检发现空档', qcShots(gap).some(i => i.msg.includes('空档')));
const ov = [mk(1, 0, 12), mk(2, 10, 20)];
ok('质检发现重叠', qcShots(ov).some(i => i.level === 'error' && i.msg.includes('重叠')));
const dup = [mk(1, 0, 10, { dialogue: '同一句' }), mk(2, 10, 20, { dialogue: '同一句' })];
ok('质检发现重复台词', qcShots(dup).some(i => i.msg.includes('重复')));
const empty = [mk(1, 0, 10, { camera: '' })];
ok('质检发现空字段', qcShots(empty).some(i => i.msg.includes('运镜')));

const fixed = autoFix([mk(1, 0, 12), mk(2, 10, 20)]);
ok('自动修复重叠', fixed[1].start === fixed[0].end);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
