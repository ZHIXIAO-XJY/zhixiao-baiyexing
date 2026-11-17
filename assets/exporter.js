/**
 * exporter.js — 把分镜数据导出为 Markdown / CSV / JSON
 */

const EXT_KEYS = ['composition', 'lighting', 'gaze', 'emotion'];
const EXT_LABELS = {
  composition: 'Composition',
  lighting: 'Lighting',
  gaze: 'Eye Contact',
  emotion: 'Emotion Arc'
};

function tc(sec) {
  const s = Math.max(0, sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function cell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

export function hasExt(shots) {
  return shots.some(s => EXT_KEYS.some(k => (s[k] || '').trim()));
}

export function toMarkdown(meta, shots) {
  const ext = hasExt(shots);
  const head = [
    '# Video Script Analysis Report',
    '',
    `**Source File:** ${meta.filename || '(unknown)'}`,
    `**Generated Time:** ${meta.generatedAt || ''}`,
    `**Model Used:** ${meta.model || ''}`,
    `**Duration:** ${meta.duration ? tc(meta.duration) : '—'}　**Resolution:** ${meta.width && meta.height ? `${meta.width}×${meta.height}` : '—'}　**Shots:** ${shots.length}`,
    '',
    '| Shot ID | Timecode | Visual Description | Dialogue / Narration | Camera Movement | Audio / SFX |'
      + (ext ? ' Composition | Lighting | Eye Contact | Emotion Arc |' : ''),
    '| :--- | :--- | :--- | :--- | :--- | :--- |' + (ext ? ' :--- | :--- | :--- | :--- |' : ''),
  ];
  for (const s of shots) {
    const row = [
      String(s.id).padStart(3, '0'),
      `${tc(s.start)} - ${tc(s.end)}`,
      cell(s.visual),
      cell(s.dialogue ?? 'None'),
      cell(s.camera),
      cell(s.audio),
    ];
    if (ext) row.push(cell(s.composition), cell(s.lighting), cell(s.gaze ?? ''), cell(s.emotion));
    head.push('| ' + row.join(' | ') + ' |');
  }
  return head.join('\n') + '\n';
}

function csvCell(v) {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCSV(meta, shots) {
  const ext = hasExt(shots);
  const cols = ['Shot ID', 'Timecode', 'Visual Description', 'Dialogue / Narration', 'Camera Movement', 'Audio / SFX',
    ...(ext ? ['Composition', 'Lighting', 'Eye Contact', 'Emotion Arc'] : [])];
  const rows = [cols.map(csvCell).join(',')];
  for (const s of shots) {
    const row = [String(s.id).padStart(3, '0'), `${tc(s.start)} - ${tc(s.end)}`, s.visual, s.dialogue ?? '', s.camera, s.audio];
    if (ext) row.push(s.composition, s.lighting, s.gaze ?? '', s.emotion);
    rows.push(row.map(csvCell).join(','));
  }
  return '\uFEFF' + rows.join('\r\n');
}

export function toJSON(meta, shots) {
  return JSON.stringify({
    meta: {
      source: meta.filename || null,
      generatedAt: meta.generatedAt,
      model: meta.model,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      shots: shots.length
    },
    shots: shots.map(s => ({
      id: s.id,
      timecode: { start: tc(s.start), end: tc(s.end), startSec: s.start, endSec: s.end },
      visual: s.visual,
      dialogue: s.dialogue,
      camera: s.camera,
      audio: s.audio,
      ...(hasExt(shots) ? {
        composition: s.composition,
        lighting: s.lighting,
        gaze: s.gaze,
        emotion: s.emotion
      } : {})
    }))
  }, null, 2);
}

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export { EXT_LABELS, EXT_KEYS };
