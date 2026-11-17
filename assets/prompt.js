/**
 * prompt.js — 拆解指令与结果解析
 * 指令分层：角色 / 任务 / 字段定义 / 硬约束 / 输出格式
 */

export function buildSystemPrompt({ vision, lang = 'zh' }) {
  const langLine = lang === 'zh' ? '所有字段用简体中文书写。'
    : 'Write every field in English.';

  return [
    '你是一名资深影视后期制作专家，精通视听语言与分镜头脚本拆解。',
    '',
    '【任务】',
    '用户会给你一段视频按时间顺序抽取的若干关键帧，每帧都带镜头编号与起止时间。',
    '请把这些帧还原成可用于复刻拍摄的分镜头描述，逐帧一件，数量与顺序必须和输入完全一致。',
    '',
    '【每个镜头要写的字段】',
    '1. visual（画面描述）：谁、在哪、穿什么、在做什么、画面里有什么关键物体；只写看得见的，不写心理活动。',
    '2. dialogue（对白·旁白）：画面字幕或人物正在说的话，一字不差照抄；没有台词写 null。',
    '3. camera（运镜）：景别（大远景/全景/中景/近景/特写）+ 机位高度 + 运动（固定/推/拉/摇/移/跟/手持）。',
    '4. audio（音效·BGM）：能从画面推断的声音线索（环境声、动作声、音乐情绪）；推断不出就写“无法从画面判断”。',
    '5. composition（构图）：人物在画面的位置关系、留白、轴线关系。',
    '6. lighting（光线）：光源方向 + 可观察证据（高光、阴影落在哪、色温），不写臆测。',
    '7. gaze（眼神交互）：谁在看谁、看哪个部位、停留多久；没有人物对视写 null。',
    '8. emotion（神态·表情轨迹）：按 起→中→末 写面部变化（眉、眼、嘴、下颌），不要只写一个形容词。',
    '',
    '【硬约束】',
    '- 只输出 JSON 数组，不要 markdown 代码块，不要解释、不要前后缀。',
    '- 数组长度必须等于输入镜头数，顺序必须一致。',
    '- 不要输出时间戳：时间由系统按检测结果填写。',
    '- 台词只抄画面上真实出现的字；看不清就写 null，禁止编造。',
    '- 不确定的内容写“不确定”，不要编细节。',
    vision ? '- 你收到的图片就是该镜头的画面，请据此描述。' : '- 本次没有图片，只能依据镜头时长与用户提供的字幕做结构推断，画面描述要保守。',
    langLine
  ].join('\n');
}

export function buildBatchMessages(shots, { vision, lang = 'zh', contextTail = '' }) {
  const parts = [{
    type: 'text',
    text: [
      `本批共 ${shots.length} 个镜头，按时间顺序。`,
      contextTail ? `上一批最后一个镜头的内容（用于延续语气，不要重复输出）：${contextTail}` : '',
      '请逐镜输出 JSON 数组，元素字段：visual, dialogue, camera, audio, composition, lighting, gaze, emotion。'
    ].filter(Boolean).join('\n')
  }];

  for (const s of shots) {
    parts.push({
      type: 'text',
      text: `镜头 ${s.id}｜${fmt(s.start)} → ${fmt(s.end)}｜时长 ${(s.end - s.start).toFixed(1)}s`
    });
    if (vision && s.thumb) {
      parts.push({ type: 'image_url', image_url: { url: s.thumb } });
    }
    if (s.subtitle) {
      parts.push({ type: 'text', text: `该时段字幕（可能不完全对应画面）：${s.subtitle}` });
    }
  }

  return [
    { role: 'system', content: buildSystemPrompt({ vision, lang }) },
    { role: 'user', content: parts }
  ];
}

export function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function stripFence(text) {
  let t = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

/** 从模型回复里抠出 JSON 数组，容忍前后废话与截断 */
export function parseShotJSON(text, expected) {
  let t = stripFence(text);
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1) throw new Error('模型没有返回 JSON 数组');
  let slice = t.slice(start, end === -1 ? undefined : end + 1);

  let arr;
  try {
    arr = JSON.parse(slice);
  } catch {
    // 尝试补齐被截断的括号
    let fixed = slice.replace(/,\s*$/, '');
    const opens = (fixed.match(/\[/g) || []).length;
    const closes = (fixed.match(/\]/g) || []).length;
    fixed += ']'.repeat(Math.max(0, opens - closes));
    if (!fixed.trim().endsWith(']')) fixed += ']';
    try {
      arr = JSON.parse(fixed);
    } catch {
      // 最后兜底：逐个对象抢救
      const objs = [...slice.matchAll(/\{[\s\S]*?\}(?=\s*,?\s*\{|\s*\]|$)/g)].map(m => m[0]);
      arr = [];
      for (const o of objs) {
        try { arr.push(JSON.parse(o)); } catch { /* skip */ }
      }
      if (!arr.length) throw new Error('模型返回的不是合法 JSON');
    }
  }

  if (!Array.isArray(arr)) throw new Error('模型返回的不是数组');
  const clean = arr.slice(0, expected).map(item => {
    const o = typeof item === 'object' && item ? item : {};
    return {
      visual: str(o.visual),
      dialogue: o.dialogue == null || o.dialogue === '' ? null : String(o.dialogue).trim(),
      camera: str(o.camera),
      audio: str(o.audio),
      composition: str(o.composition),
      lighting: str(o.lighting),
      gaze: o.gaze == null || o.gaze === '' ? null : String(o.gaze).trim(),
      emotion: str(o.emotion)
    };
  });
  while (clean.length < expected) {
    clean.push({ visual: '', dialogue: null, camera: '', audio: '', composition: '', lighting: '', gaze: null, emotion: '' });
  }
  return clean;
}

function str(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
}

/** 解析用户粘贴的字幕：支持 [mm:ss] / mm:ss 开头 / SRT 时间块 */
export function parseSubtitles(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = [];
  let pending = null;

  const push = (t, text) => {
    const s = String(text || '').trim();
    if (!s) return;
    out.push({ t, text: s });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // SRT 的纯数字序号行，直接跳过
    if (/^\d{1,3}$/.test(line)) continue;

    // SRT: 00:00:02,000 --> 00:00:04,000
    const srt = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(line);
    if (srt) {
      pending = (+srt[1]) * 3600 + (+srt[2]) * 60 + (+srt[3]) + (+srt[4]) / 1000;
      continue;
    }
    // [00:12] / 00:12 / 00:00:12 文本
    const tc = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*(.*)$/.exec(line);
    if (tc && tc[3] !== undefined) {
      const t = (+tc[1]) * 3600 + (+tc[2]) * 60 + (+tc[3]);
      push(t, tc[4]);
      pending = null;
      continue;
    }
    if (tc && tc[4] !== undefined && tc[4] !== '') {
      const t = (+tc[1]) * 60 + (+tc[2]);
      push(t, tc[4]);
      pending = null;
      continue;
    }
    if (pending != null) {
      push(pending, line);
      pending = null;
    } else if (out.length) {
      // 无时间戳的续行，接到上一条
      out[out.length - 1].text += line;
    } else {
      push(0, line);
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 把字幕按时间灌进镜头 */
export function attachSubtitles(shots, subs) {
  if (!subs?.length) return shots;
  return shots.map(s => {
    const hit = subs.filter(x => x.t >= s.start - 1 && x.t < s.end + 1);
    s.subtitle = hit.map(x => x.text).join(' ').slice(0, 400) || '';
    return s;
  });
}
