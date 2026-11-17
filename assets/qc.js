/**
 * qc.js — 镜头数据的纯函数操作与质检（不碰 DOM，可单测）
 */

/** 按开始时间排序并重新编号（原地改 + 返回） */
export function renumber(shots) {
  shots.sort((a, b) => a.start - b.start);
  shots.forEach((s, i) => { s.id = i + 1; });
  return shots;
}

/** 合并选中的相邻镜头；返回 {shots, merged} 或 {error} */
export function mergeShots(shots, ids) {
  const set = new Set(ids);
  const picked = shots.filter(s => set.has(s.id)).sort((a, b) => a.start - b.start);
  if (picked.length < 2) return { error: '至少选择两个镜头' };
  for (let i = 1; i < picked.length; i++) {
    if (Math.abs(picked[i].start - picked[i - 1].end) > 0.25) {
      return { error: '只能合并时间上首尾相接的镜头' };
    }
  }
  const last = picked[picked.length - 1];
  const first = picked[0];
  const dialogues = [...new Set(picked.map(s => (s.dialogue || '').trim()).filter(Boolean))];
  const merged = {
    ...first,
    end: last.end,
    dialogue: dialogues.length ? dialogues.join(' ') : null,
    subtitle: picked.map(s => s.subtitle || '').filter(Boolean).join(' ')
  };
  const rest = shots.filter(s => !set.has(s.id));
  rest.push(merged);
  return { shots: renumber(rest), merged };
}

/** 在 t 处拆分包含它的镜头；返回 {shots, left, right} 或 {error} */
export function splitShot(shots, t, minLen = 0.4) {
  const target = shots.find(s => t > s.start + minLen && t < s.end - minLen);
  if (!target) return { error: '播放头不在任何镜头的中间位置' };
  const right = {
    ...target,
    start: t,
    id: -1,
    thumb: null,
    visual: '',
    dialogue: null,
    camera: '',
    audio: '',
    composition: '',
    lighting: '',
    gaze: null,
    emotion: ''
  };
  target.end = t;
  return { shots: renumber([...shots, right]), left: target, right };
}

/** 删除选中镜头，并把空档并给左边的镜头（可关） */
export function deleteShots(shots, ids, { absorbGap = true } = {}) {
  const set = new Set(ids);
  const kept = shots.filter(s => !set.has(s.id)).sort((a, b) => a.start - b.start);
  if (absorbGap) {
    for (let i = 0; i < kept.length; i++) {
      const next = kept[i + 1];
      if (next && Math.abs(kept[i].end - next.start) > 0.01) {
        // 让上一镜补到下一镜起点，保持时间轴连续
        kept[i].end = next.start;
      }
    }
  }
  return renumber(kept);
}

/** 质检：返回问题列表 */
export function qcShots(shots) {
  const issues = [];
  if (!shots.length) return issues;
  const sorted = [...shots].sort((a, b) => a.start - b.start);

  sorted.forEach((s, i) => {
    if (!(s.end > s.start)) {
      issues.push({ level: 'error', id: s.id, msg: `镜头 ${s.id} 起止时间非法（${s.start} - ${s.end}）` });
    }
    if (i > 0) {
      const gap = +(s.start - sorted[i - 1].end).toFixed(2);
      if (gap > 0.05) issues.push({ level: 'warn', id: s.id, msg: `镜头 ${s.id} 前面有空档 ${gap}s` });
      if (gap < -0.05) issues.push({ level: 'error', id: s.id, msg: `镜头 ${s.id} 与上一镜重叠 ${(-gap).toFixed(2)}s` });
    }
    if (!(s.visual || '').trim()) issues.push({ level: 'warn', id: s.id, msg: `镜头 ${s.id} 画面描述为空` });
    if (!(s.camera || '').trim()) issues.push({ level: 'warn', id: s.id, msg: `镜头 ${s.id} 运镜为空` });
    if (!(s.audio || '').trim()) issues.push({ level: 'warn', id: s.id, msg: `镜头 ${s.id} 声音字段为空` });
  });

  const seen = new Map();
  for (const s of sorted) {
    const key = (s.dialogue || '').trim();
    if (!key) continue;
    if (seen.has(key)) issues.push({ level: 'warn', id: s.id, msg: `台词与镜头 ${seen.get(key)} 重复：${key.slice(0, 20)}` });
    else seen.set(key, s.id);
  }
  return issues;
}

/** 一键修复：排序 + 重编号 + 把重叠裁掉（空档不动） */
export function autoFix(shots) {
  const arr = renumber(shots.map(s => ({ ...s })));
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].start < arr[i - 1].end) arr[i].start = arr[i - 1].end;
  }
  return arr;
}

/** 扁平表格（导出预览、质检报告都用它） */
export function toRows(shots) {
  return shots.map(s => ({
    id: s.id,
    start: s.start,
    end: s.end,
    visual: s.visual || '',
    dialogue: s.dialogue || '',
    camera: s.camera || '',
    audio: s.audio || ''
  }));
}
