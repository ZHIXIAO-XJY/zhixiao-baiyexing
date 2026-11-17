/**
 * cv.js — 浏览器内的视频解码、场景切点检测、关键帧抽取
 * 不依赖任何库；全部用 <video> + <canvas> 完成。
 */

const SAMPLE_W = 160;
const SAMPLE_H = 90;
const THUMB_W = 480;

export function pickInterval(duration) {
  if (!duration || !isFinite(duration)) return 2;
  if (duration <= 60) return 0.5;
  if (duration <= 180) return 1;
  if (duration <= 600) return 2;
  if (duration <= 1800) return 3;
  return 5;
}

export function seekTo(video, t, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(t, (video.duration || 0) - 0.04));
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) return resolve();
    let done = false;
    const onSeeked = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve(); // 超时也放行，避免整条流程卡死
    }, timeout);
    video.addEventListener('seeked', onSeeked, { once: true });
    try {
      video.currentTime = target;
    } catch (e) {
      done = true;
      cleanup();
      reject(e);
    }
  });
}

export async function waitMeta(video) {
  if (video.readyState >= 1 && video.duration) return;
  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('视频无法解码（浏览器不支持该编码？）')); };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', ok);
      video.removeEventListener('error', bad);
    };
    video.addEventListener('loadedmetadata', ok, { once: true });
    video.addEventListener('error', bad, { once: true });
  });
}

export async function probe(video) {
  await waitMeta(video);
  return {
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight
  };
}

function grayOf(ctx) {
  const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  const g = new Uint8Array(SAMPLE_W * SAMPLE_H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    g[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return g;
}

function diff(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return (s / a.length) / 255 * 100;
}

/**
 * 采样 + 检测切点
 * @returns {{cuts:number[], samples:{t:number,score:number}[], interval:number, truncated:boolean}}
 */
export async function detectCuts(video, {
  interval,
  maxSamples = 900,
  onProgress = () => {},
  shouldStop = () => false
} = {}) {
  const dur = video.duration || 0;
  const step = interval || pickInterval(dur);
  let times = [];
  for (let t = 0; t < dur - 0.05; t += step) times.push(+t.toFixed(3));
  let truncated = false;
  if (times.length > maxSamples) {
    truncated = true;
    const stride = Math.ceil(times.length / maxSamples);
    times = times.filter((_, i) => i % stride === 0);
  }

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const samples = [];
  let prev = null;
  for (let i = 0; i < times.length; i++) {
    if (shouldStop()) break;
    await seekTo(video, times[i]);
    try {
      ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    } catch (e) {
      throw new Error('无法从视频取帧（跨域限制？请改用本地文件上传）');
    }
    const g = grayOf(ctx);
    const score = diff(prev, g);
    samples.push({ t: times[i], score: +score.toFixed(2) });
    prev = g;
    if (i % 10 === 0) onProgress({ phase: 'detect', done: i + 1, total: times.length });
  }

  // 自适应阈值
  const scores = samples.map(s => s.score).sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const median = scores[Math.floor(scores.length / 2)] || 0;
  const p75 = scores[Math.floor(scores.length * 0.75)] || 0;
  const thr = Math.max(6, mean + (p75 - median) * 1.2 + 2);

  const cuts = samples
    .filter(s => s.score >= thr && s.t > 0.3)
    .map(s => s.t);

  return { cuts, samples, interval: step, truncated, threshold: +thr.toFixed(2) };
}

/** 把切点变成镜头区间，并合并过短的碎片 */
export function buildShots(cuts, duration, { minLen = 0.8, mergeShort = true, maxShots = 160 } = {}) {
  const pts = [0, ...cuts.filter(c => c > 0.2 && c < duration - 0.2).sort((a, b) => a - b), duration];
  let segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    if (e - s < 0.08) continue;
    segs.push({ start: +s.toFixed(2), end: +e.toFixed(2) });
  }
  if (mergeShort) {
    const merged = [];
    for (const seg of segs) {
      const last = merged[merged.length - 1];
      if (last && seg.end - last.start <= minLen) {
        last.end = seg.end; // 相邻碎片并进上一镜
      } else if (last && seg.end - seg.start < minLen && merged.length) {
        last.end = Math.max(last.end, seg.end);
      } else {
        merged.push({ ...seg });
      }
    }
    segs = merged;
  }
  if (segs.length > maxShots) {
    // 超长视频：等间隔抽样成 maxShots 段
    const pick = Math.ceil(segs.length / maxShots);
    const reduced = [];
    for (let i = 0; i < segs.length; i += pick) {
      const group = segs.slice(i, i + pick);
      reduced.push({ start: group[0].start, end: group[group.length - 1].end });
    }
    segs = reduced;
  }
  return segs.map((s, i) => ({ id: i + 1, start: s.start, end: s.end }));
}

/** 给每个镜头抓一张关键帧（JPEG dataURL） */
export async function captureThumbs(video, shots, {
  width = THUMB_W,
  quality = 0.72,
  onProgress = () => {},
  shouldStop = () => false
} = {}) {
  const vw = video.videoWidth || width;
  const vh = video.videoHeight || Math.round(width * 9 / 16);
  const w = Math.min(width, vw);
  const h = Math.round(vh * (w / vw));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  let tainted = false;

  for (let i = 0; i < shots.length; i++) {
    if (shouldStop()) break;
    const shot = shots[i];
    // 取镜头中点稍前的位置，避开转场第一帧的黑场
    const t = shot.start + Math.min(0.4, (shot.end - shot.start) / 3);
    await seekTo(video, t);
    let url = null;
    if (!tainted) {
      try {
        ctx.drawImage(video, 0, 0, w, h);
        url = canvas.toDataURL('image/jpeg', quality);
      } catch (e) {
        tainted = true;
      }
    }
    shot.thumb = url;
    shot.frameTime = +t.toFixed(2);
    onProgress({ phase: 'capture', done: i + 1, total: shots.length });
  }
  return { tainted };
}

export function fmtTime(sec, withMs = false) {
  const s = Math.max(0, Math.round((sec || 0) * 1000) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(r)).padStart(2, '0')}`;
  return withMs ? `${base}.${String(Math.round((r % 1) * 1000)).padStart(3, '0')}` : base;
}

export function fmtShort(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
