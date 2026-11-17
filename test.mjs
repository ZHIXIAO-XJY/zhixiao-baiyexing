import { buildShots, fmtTime, pickInterval } from './assets/cv.js';
import { parseShotJSON, parseSubtitles, attachSubtitles, buildBatchMessages } from './assets/prompt.js';
import { toMarkdown, toCSV, toJSON, hasExt } from './assets/exporter.js';
import { endpointFor, normalizeBase } from './assets/providers.js';
import { renumber, mergeShots, splitShot, deleteShots, qcShots, autoFix } from './assets/qc.js';
import { parseSummaryJSON, hasExtras, buildSummaryMessages } from './assets/summary.js';

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

console.log('\n[summary]');
const sumText = '```json\n{"title":"夜巷认亲","characters":[{"name":"霍征","role":"男主","profile":"短发","tone":"低沉"}],"structure":[{"start":"00:00","end":"01:36","phase":"钩子","note":"认亲"}],"notes":["让外说惨"]}\n```';
const ex = parseSummaryJSON(sumText);
ok('汇总：去代码块', ex.title === '夜巷认亲');
ok('汇总：角色字段', ex.characters.length === 1 && ex.characters[0].name === '霍征' && ex.characters[0].profile === '短发');
ok('汇总：结构字段', ex.structure[0].phase === '钩子' && ex.structure[0].start === '00:00');
ok('汇总：要点', ex.notes[0] === '让外说惨');
ok('汇总：hasExtras', hasExtras(ex) === true && hasExtras(null) === false);

const truncSum = parseSummaryJSON('{"characters":[{"name":"A"}]');
ok('汇总：截断容错', truncSum.characters[0].name === 'A' && truncSum.structure.length === 0);

const noName = parseSummaryJSON('{"characters":[{"role":"x"},{"name":"B"}]}');
ok('汇总：丢弃无名角色', noName.characters.length === 1 && noName.characters[0].name === 'B');

const msgs = buildSummaryMessages([{ start: 0, end: 13, visual: '巷子', dialogue: '台词' }]);
const msgsHint = buildSummaryMessages([{ start: 0, end: 1, visual: 'x' }], { castHint: '霍征＝男主' });
ok('汇总：角色提示注入', msgsHint[0].content.includes('霍征＝男主'));

const shotMsgs = buildBatchMessages([{ id: 1, start: 0, end: 5, thumb: null }], { vision: false, castHint: '柳清禾＝女主' });
ok('镜头：角色提示注入', shotMsgs[0].content.includes('柳清禾＝女主'));
ok('汇总：请求含镜头', msgs[1].content.includes('00:00-00:13') && msgs[1].content.includes('台词'));

console.log('\n[exporter extras]');
const md2 = toMarkdown(meta, demo, { title: 'T', characters: [{ name: '甲', role: 'r', profile: 'p', tone: 't' }], structure: [{ start: '00:00', end: '00:13', phase: '钩子', note: 'n' }], notes: ['要点'] });
ok('md 含角色档案', md2.includes('## 角色档案') && md2.includes('| 甲 |'));
ok('md 含结构', md2.includes('## 剧情结构') && md2.includes('钩子'));
ok('md 含要点', md2.includes('## 表演与剪辑要点') && md2.includes('- 要点'));
ok('md 含标题', md2.includes('**T**'));
const js2 = JSON.parse(toJSON(meta, demo, { notes: ['x'] }));
ok('json extras 不影响 shots', js2.shots.length === 1);
ok('json 含 extras', js2.extras && js2.extras.notes[0] === 'x');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
