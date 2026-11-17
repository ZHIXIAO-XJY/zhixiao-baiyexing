/**
 * summary.js — 「角色档案 / 剧情结构 / 表演要点」的汇总请求与解析
 * 拆完镜头后，用一次纯文本请求把整片归纳出来（不发送图片，便宜）
 */

export function buildSummaryMessages(shots, { lang = 'zh' } = {}) {
  const lines = shots.map(s => {
    const t = `[${mmss(s.start)}-${mmss(s.end)}]`;
    const d = s.dialogue ? ` 台词：${s.dialogue}` : '';
    return `${t} ${(s.visual || '').slice(0, 80)}${d}`;
  }).join('\n');

  const system = [
    '你是资深影视后期制作专家。用户会给你一份已经拆好的分镜头清单（时间、画面、台词）。',
    '',
    '请归纳三块内容，只输出 JSON 对象，不要 markdown 代码块、不要解释：',
    '{',
    '  "title": "给这支片子起一个短标题（不超过 14 字）",',
    '  "characters": [{"name":"角色名","role":"身份/关系","profile":"外形与识别要素：发型、领型、配饰、体型、常见场景","tone":"说话特点与情绪外化方式"}],',
    '  "structure": [{"start":"mm:ss","end":"mm:ss","phase":"段落名","note":"这一段在做什么，一句话"}],',
    '  "notes": ["全片可复制的做法或表演/剪辑要点，3-6 条"]',
    '}',
    '',
    '硬约束：',
    '- 角色名只用清单里出现过的称呼，不要编新角色；',
    '- 时间必须来自清单里的区间，不要杜撰；',
    '- 信息不足就写「不确定」，不要编细节。',
    lang === 'zh' ? '用简体中文书写。' : 'Write in English.'
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `分镜头清单（${shots.length} 个）：\n${lines}` }
  ];
}

function mmss(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 补齐被截断的括号/引号（模型输出被 max_tokens 截断时用） */
export function repairJSON(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s.replace(/,\s*$/, '');
  if (inStr) out += '"';
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

/** 从模型回复里解析汇总对象，容忍代码块与截断 */
export function parseSummaryJSON(text) {
  let t = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();

  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1) throw new Error('模型没有返回 JSON 对象');
  let slice = t.slice(start, end === -1 ? undefined : end + 1);

  let obj;
  try {
    obj = JSON.parse(slice);
  } catch {
    try { obj = JSON.parse(repairJSON(slice)); } catch { throw new Error('模型返回的 JSON 无法解析'); }
  }

  const arr = (v, map) => Array.isArray(v) ? v.map(map).filter(Boolean) : [];

  return {
    title: str(obj.title).slice(0, 24),
    characters: arr(obj.characters, c => {
      if (!c || typeof c !== 'object') return null;
      const name = str(c.name);
      if (!name) return null;
      return {
        name,
        role: str(c.role),
        profile: str(c.profile),
        tone: str(c.tone)
      };
    }),
    structure: arr(obj.structure, s => {
      if (!s || typeof s !== 'object') return null;
      const phase = str(s.phase);
      if (!phase) return null;
      return {
        start: str(s.start).slice(0, 8),
        end: str(s.end).slice(0, 8),
        phase,
        note: str(s.note)
      };
    }),
    notes: arr(obj.notes, n => {
      const s = str(n);
      return s ? s : null;
    }).slice(0, 8)
  };
}

export function hasExtras(extras) {
  return !!extras && (
    (extras.characters?.length || 0) + (extras.structure?.length || 0) + (extras.notes?.length || 0) > 0
  );
}
