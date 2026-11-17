/**
 * app.js — ScriptBreaker 主逻辑
 */
import { DEFAULT_MODEL_CONFIG, PROVIDER_PRESETS, PROXY_PRESET, OFFICIAL_BASE, DEMO_KEY } from './config.js';
import { probe, detectCuts, buildShots, captureThumbs, pickInterval, seekTo, fmtShort, fmtTime } from './cv.js';
import { chat, testConnection, probeProxy } from './providers.js';
import { buildBatchMessages, parseShotJSON, parseSubtitles, attachSubtitles } from './prompt.js';
import { toMarkdown, toCSV, toJSON, download, hasExt } from './exporter.js';
import { mergeShots, splitShot, deleteShots, qcShots, autoFix, renumber } from './qc.js';
import { buildSummaryMessages, parseSummaryJSON, hasExtras } from './summary.js';

const $ = (sel) => document.querySelector(sel);
const LS_CFG = 'scriptbreaker.config.v1';
const LS_HISTORY = 'scriptbreaker.history.v1';

const state = {
  cfg: { ...DEFAULT_MODEL_CONFIG },
  video: null,
  videoUrl: null,
  meta: { filename: '', duration: 0, width: 0, height: 0 },
  shots: [],
  file: null,
  subs: [],
  running: false,
  abort: null,
  lastExport: null,
  filter: 'all',
  query: '',
  selected: new Set(),
  extras: null,
  queue: []
};

/* ---------------- 基础 UI ---------------- */
let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

function log(msg, cls = '') {
  const el = $('#log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setProgress(pct, text) {
  $('#progress').hidden = false;
  $('#progress-bar').style.width = `${Math.max(2, Math.min(100, pct))}%`;
  if (text) $('#progress-text').textContent = text;
}

function hideProgress() {
  $('#progress').hidden = true;
  $('#progress-bar').style.width = '0%';
}

function setPhase(name, status) {
  const el = document.querySelector(`.phase[data-phase="${name}"]`);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (status) el.classList.add(status);
}

function resetPhases() {
  document.querySelectorAll('.phase').forEach(p => p.classList.remove('active', 'done'));
}

/* ---------------- 配置 ---------------- */
function loadConfig() {
  try {
    const raw = localStorage.getItem(LS_CFG);
    if (raw) state.cfg = { ...DEFAULT_MODEL_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  if (DEMO_KEY && state.cfg.api_key === DEMO_KEY) $('#key-warning').hidden = false;
}

function saveConfig() {
  localStorage.setItem(LS_CFG, JSON.stringify(state.cfg));
}

function fillSettingsForm() {
  const c = state.cfg;
  $('#cfg-provider').value = c.provider;
  $('#cfg-baseurl').value = c.base_url;
  $('#cfg-model').value = c.model_name;
  $('#cfg-apikey').value = c.api_key;
  $('#cfg-temp').value = c.temperature;
  $('#cfg-maxtok').value = c.max_tokens;
  $('#cfg-effort').value = c.effort || '';
  $('#cfg-vision').checked = !!c.vision;
  $('#cfg-passcode').value = c.passcode || '';
}

function readSettingsForm() {
  return {
    provider: $('#cfg-provider').value,
    base_url: $('#cfg-baseurl').value.trim(),
    model_name: $('#cfg-model').value.trim(),
    api_key: $('#cfg-apikey').value.trim(),
    temperature: Number($('#cfg-temp').value) || 0.3,
    max_tokens: Number($('#cfg-maxtok').value) || 4096,
    effort: $('#cfg-effort').value,
    vision: $('#cfg-vision').checked,
    passcode: $('#cfg-passcode').value.trim()
  };
}

function syncModelBadge() {
  const badge = $('#model-badge');
  const label = state.cfg.model_name || '—';
  badge.textContent = state.cfg.vision ? `${label} · vision` : `${label} · text`;
  badge.className = 'badge' + (state.cfg.vision ? '' : ' text');
  $('#model-quick-select').value = state.cfg.provider;
}

/* ---------------- 视频 ---------------- */
async function setVideo(src, filename) {
  const video = $('#player');
  try {
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.hidden = false;

    video.crossOrigin = 'anonymous';
    const assignSrc = () => {
      if (src instanceof Blob) {
        state.videoUrl = URL.createObjectURL(src);
        video.src = state.videoUrl;
      } else {
        video.src = src;
      }
    };
    assignSrc();

    let info;
    try {
      info = await probe(video);
    } catch (err) {
      if (typeof src === 'string') {
        video.removeAttribute('crossorigin');
        video.load();
        assignSrc();
        info = await probe(video);
        log('该地址不允许跨域取帧：视频能播放，但抽帧会失败，建议下载后上传。', 'err');
      } else {
        throw err;
      }
    }

    state.video = video;
    state.meta = {
      filename: filename || (typeof src === 'string' ? src.split('/').pop() : 'video'),
      duration: info.duration,
      width: info.width,
      height: info.height
    };
    $('#video-meta').textContent = `${fmtTime(info.duration)} · ${info.width}×${info.height}`;
    $('#btn-run').disabled = false;
    const tips = $('#tips'); if (tips) tips.hidden = true;
    log(`已加载：${state.meta.filename}（${fmtTime(info.duration)}，${info.width}×${info.height}）`, 'ok');
    toast('视频已就绪');
  } catch (e) {
    console.error(e);
    toast(`加载失败：${e.message}`, true);
    log(`加载失败：${e.message}`, 'err');
  }
}

function bindVideoInputs() {
  const dz = $('#dropzone');
  const input = $('#video-upload');
  if (window.SB_NATIVE) $('#btn-local-asr').hidden = false;
  const openPicker = () => input.click();

  dz.addEventListener('click', openPicker);
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openPicker(); });
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    state.file = files[0] || null;
    if (!files.length) return;
    if (files.length === 1) return setVideo(files[0], files[0].name);
    addToQueue(files);
  });

  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('hot');
  }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('hot');
  }));
  dz.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('video/'));
    if (!files.length) return toast('请拖入视频文件', true);
    if (files.length === 1) return setVideo(files[0], files[0].name);
    addToQueue(files);
  });

  $('#btn-load-url').addEventListener('click', () => {
    const url = $('#video-url').value.trim();
    if (!url) return toast('先粘贴一个视频直链', true);
    setVideo(url, url.split('/').pop().split('?')[0]);
  });

  $('#subtitle-input').addEventListener('input', debounce(parseSubsInput, 400));
  $('#btn-parse-sub').addEventListener('click', () => parseSubsInput(true));
  $('#btn-toggle-sub').addEventListener('click', () => {
    const wrap = $('#sub-wrap');
    wrap.hidden = !wrap.hidden;
    $('#btn-toggle-sub').textContent = wrap.hidden ? '展开' : '收起';
  });
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function parseSubsInput(showToast = false) {
  const raw = $('#subtitle-input').value;
  state.subs = parseSubtitles(raw);
  $('#sub-status').textContent = `${state.subs.length} 条`;
  if (showToast) toast(`解析到 ${state.subs.length} 条字幕`);
}

/* ---------------- 拆解主流程 ---------------- */
async function run() {
  if (state.running || !state.video) return;
  const cfg = state.cfg;
  if (!cfg.api_key) return toast('先去「模型设置」填 API Key', true);

  state.running = true;
  state.abort = new AbortController();
  $('#btn-run').disabled = true;
  $('#btn-cancel').hidden = false;
  $('#log').textContent = '';
  $('#progress').hidden = false;
  resetPhases();
  clearSelection();

  const video = state.video;
  const dur = state.meta.duration;
  const intervalSel = $('#sample-interval').value;
  const interval = intervalSel === 'auto' ? pickInterval(dur) : Number(intervalSel);
  const batchSize = Number($('#frames-per-batch').value) || 6;
  const mergeShort = $('#merge-short').checked;
  const castHint = ($('#cast-hint')?.value || '').trim();

  try {
    setPhase('detect', 'active');
    setProgress(4, `采样中（每 ${interval}s 一帧）…`);
    log(`开始分析：${state.meta.filename}，时长 ${fmtTime(dur)}，采样 ${interval}s`);

    const { cuts, threshold, truncated } = await detectCuts(video, {
      interval,
      onProgress: ({ done, total }) => setProgress(4 + (done / total) * 24, `采样 ${done}/${total}`),
      shouldStop: () => state.abort.signal.aborted
    });
    log(`检测到 ${cuts.length} 个切点（阈值 ${threshold}${truncated ? '，已抽样' : ''}）`);
    if (!cuts.length) log('没检测到硬切，可能是一镜到底或采样过密，将按整段处理');

    let shots = buildShots(cuts, dur, { mergeShort });
    if (!shots.length) shots = [{ id: 1, start: 0, end: dur }];
    shots.forEach((s, i) => { s.id = i + 1; });
    log(`切成 ${shots.length} 个镜头`);

    if (state.subs.length) {
      shots = attachSubtitles(shots, state.subs);
      log(`已把 ${state.subs.length} 条字幕映射到镜头`);
    }

    setPhase('detect', 'done');
    setPhase('capture', 'active');
    setProgress(32, '抽取关键帧…');
    const { tainted } = await captureThumbs(video, shots, {
      onProgress: ({ done, total }) => setProgress(32 + (done / total) * 16, `关键帧 ${done}/${total}`),
      shouldStop: () => state.abort.signal.aborted
    });
    if (tainted) log('跨域视频无法导出画面（画布被污染），卡片不显示缩略图；请改用本地文件。', 'err');

    state.shots = shots;
    setPhase('capture', 'done');
    setPhase('analyze', 'active');
    showSkeleton(Math.min(6, shots.length));
    updateCount();

    if (!cfg.vision) log('当前模型标记为纯文本：不发送图片，只按镜头时长与字幕推断。');

    const batches = [];
    for (let i = 0; i < shots.length; i += batchSize) batches.push(shots.slice(i, i + batchSize));
    log(`分批请求模型：${batches.length} 批 × 最多 ${batchSize} 帧`);

    let doneBatches = 0;
    let contextTail = '';

    for (const batch of batches) {
      if (state.abort.signal.aborted) break;
      const t0 = performance.now();
      try {
        const messages = buildBatchMessages(batch, { vision: cfg.vision, lang: 'zh', contextTail, castHint });
        let { text, usage } = await retryOnce(() => chat(cfg, messages, state.abort.signal));
        let parsed;
        try {
          parsed = parseShotJSON(text, batch.length);
        } catch (parseErr) {
          // 模型偶尔会回一段散文而不是 JSON：带着它的原文再要一次
          log(`批次 ${doneBatches + 1} 返回不是 JSON，要求重发`, 'err');
          const retryMsgs = messages.concat([
            { role: 'assistant', content: text.slice(0, 400) },
            { role: 'user', content: '上一条不是合法 JSON 数组。请只输出 JSON 数组，长度与镜头数一致，不要任何解释。' }
          ]);
          const r2 = await chat({ ...cfg, effort: 'high', max_tokens: Math.max(16384, cfg.max_tokens || 0) }, retryMsgs, state.abort.signal);
          text = r2.text;
          usage = r2.usage;
          parsed = parseShotJSON(text, batch.length);
        }
        parsed.forEach((p, idx) => Object.assign(batch[idx], p));
        contextTail = (batch[batch.length - 1].visual || '').slice(0, 80);
        doneBatches++;
        const ms = Math.round(performance.now() - t0);
        log(`批次 ${doneBatches}/${batches.length} 完成（${ms}ms${usage ? `，tokens ${usage.total_tokens ?? '?'}` : ''}）`, 'ok');
      } catch (e) {
        if (e.name === 'AbortError') break;
        console.error(e);
        log(`批次 ${doneBatches + 1} 失败：${e.message}`, 'err');
        batch.forEach(s => { s.visual = s.visual || '（本批解析失败，可重试或手动补写）'; });
        doneBatches++;
      }
      setProgress(48 + (doneBatches / batches.length) * 50, `模型分析 ${doneBatches}/${batches.length}`);
      render();
    }

    // 质量兜底：字段为空或解析失败的镜头，逐镜用最高档重跑
    if (!state.abort.signal.aborted) {
      const weak = shots.filter(s =>
        !(s.visual || '').trim() || (s.visual || '').includes('解析失败') || !(s.camera || '').trim()
      );
      if (weak.length) {
        log(`有 ${weak.length} 个镜头字段为空，逐镜重跑（effort=max）`);
        for (const s of weak) {
          if (state.abort.signal.aborted) break;
          try {
            const msgs = buildBatchMessages([s], { vision: cfg.vision, lang: 'zh', castHint });
            const r = await chat({ ...cfg, effort: 'max', max_tokens: 16384 }, msgs, state.abort.signal);
            Object.assign(s, parseShotJSON(r.text, 1)[0]);
            render();
          } catch (e) {
            log(`镜头 ${s.id} 重跑失败：${e.message}`, 'err');
          }
        }
      }
    }

    for (const s of shots) {
      if (!s.dialogue && s.subtitle) s.dialogue = s.subtitle;
    }

    render();

    // 全片归纳：角色档案 / 剧情结构 / 要点（纯文本请求，便宜）
    if (!state.abort.signal.aborted) {
      try {
        setProgress(97, '归纳角色与结构…');
        const { text } = await chat({ ...cfg, effort: 'low', max_tokens: 8192 },
          buildSummaryMessages(shots, { castHint }), state.abort.signal);
        state.extras = parseSummaryJSON(text);
        renderExtras();
        log('角色档案与结构已生成', 'ok');
      } catch (e) {
        if (e.name !== 'AbortError') log(`档案生成失败：${e.message}`, 'err');
      }
    }
    setPhase('analyze', 'done');
    setProgress(100, '完成');
    log(`完成：${shots.length} 个镜头`, 'ok');
    toast('拆解完成');
    saveHistory();
  } catch (e) {
    console.error(e);
    if (e.name === 'AbortError') log('已停止', 'err');
    else { log(`失败：${e.message}`, 'err'); toast(e.message, true); }
  } finally {
    state.running = false;
    $('#btn-run').disabled = false;
    $('#btn-cancel').hidden = true;
    setTimeout(hideProgress, 1400);
    state.abort = null;
  }
}

async function retryOnce(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.name === 'AbortError' || e.status === 401 || e.status === 403) throw e;
    await new Promise(r => setTimeout(r, 900));
    return fn();
  }
}

/* ---------------- 本地转写（桌面版） ---------------- */
function encodeWav(channels, sampleRate) {
  const data = channels[0];
  const len = data.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return buf;
}

async function localTranscribe() {
  if (!window.SB_NATIVE) return toast('本地转写只在桌面版可用', true);
  if (!state.file) return toast('请先用「选择文件」加载视频（直链不支持本地转写）', true);
  const btn = $('#btn-local-asr');
  const status = $('#asr-status');
  btn.disabled = true;
  status.textContent = '解码音轨…';
  try {
    const arrayBuf = await state.file.arrayBuffer();
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(arrayBuf.slice(0));
    const targetRate = 16000;
    const off = new OfflineAudioContext(1, Math.ceil(audio.duration * targetRate), targetRate);
    const src = off.createBufferSource();
    src.buffer = audio; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    await ctx.close();

    status.textContent = `转写中（${Math.round(audio.duration)} 秒音频，本地 whisper）…`;
    const unsub = window.SB_NATIVE.onProgress(({ percent }) => {
      status.textContent = `转写中… ${percent}%`;
    });
    const { segments } = await window.SB_NATIVE.transcribe(encodeWav([rendered.getChannelData(0)], targetRate), { lang: 'zh' });
    unsub();

    state.subs = segments.map(s => ({ t: s.start, text: s.text }));
    $('#subtitle-input').value = segments.map(s => `${fmtClock(s.start)} ${s.text}`).join('\n');
    $('#sub-status').textContent = `${state.subs.length} 条`;
    status.textContent = `完成：${segments.length} 段`;
    if (state.shots.length) { state.shots = attachSubtitles(state.shots, state.subs); render(); }
    toast(`本地转写完成，${segments.length} 段`);
    if (state.subs.length) document.querySelector('#sub-wrap').hidden = false;
  } catch (e) {
    console.error(e);
    status.textContent = `失败：${e.message}`;
    toast(`转写失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ---------------- 多文件队列 ---------------- */
function addToQueue(files) {
  for (const f of files) state.queue.push({ file: f, name: f.name, status: 'pending' });
  renderQueue();
  toast(`已加入 ${files.length} 个文件`);
}

const QSTATUS = { pending: '等待', running: '处理中', done: '完成', error: '失败' };

function renderQueue() {
  const box = $('#queue');
  if (!box) return;
  if (!state.queue.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = state.queue.map((q, i) => `
    <div class="qrow ${q.status}">
      <span class="qname" title="${esc(q.name)}">${esc(q.name)}</span>
      <span class="qstat">${QSTATUS[q.status] || q.status}</span>
      ${q.status === 'done' ? `<button class="link" data-dl="${i}" type="button">下载</button>` : ''}
    </div>`).join('');
  box.querySelectorAll('[data-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = state.queue[Number(btn.dataset.dl)];
      if (q?.md) download(q.name.replace(/\.[^.]+$/, '') + '_storyboard.md', q.md, 'text/markdown;charset=utf-8');
    });
  });
  const pending = state.queue.filter(q => q.status === 'pending').length;
  $('#btn-queue').hidden = pending === 0;
  $('#btn-queue').textContent = pending ? `跑队列（${pending}）` : '跑队列';
}

async function runQueue() {
  if (state.running) return;
  const items = state.queue.filter(q => q.status === 'pending');
  if (!items.length) return toast('没有待处理的文件', true);
  for (const q of items) {
    if (!state.cfg.api_key) { toast('先去「模型设置」填 API Key', true); break; }
    q.status = 'running';
    renderQueue();
    try {
      await setVideo(q.file, q.name);
      await run();
      if (state.shots.length) {
        q.md = toMarkdown(exportMeta(), state.shots, state.extras);
        q.shots = state.shots.length;
        q.status = 'done';
      } else {
        q.status = 'error';
      }
    } catch (e) {
      q.status = 'error';
      q.error = e.message;
      log(`队列：${q.name} 失败 ${e.message}`, 'err');
    }
    renderQueue();
  }
  toast('队列处理完毕');
  const done = state.queue.filter(q => q.status === 'done').length;
  if (done) log(`队列完成 ${done} 个文件，可在左侧逐条下载`, 'ok');
}

/* ---------------- 过滤与统计 ---------------- */
function visibleShots() {
  const q = state.query.trim().toLowerCase();
  return state.shots.filter(s => {
    if (state.filter === 'dialogue' && !s.dialogue) return false;
    if (state.filter === 'nothumb' && s.thumb) return false;
    if (!q) return true;
    return [s.visual, s.dialogue, s.camera, s.audio, s.subtitle]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  });
}

function updateCount() {
  const total = state.shots.length;
  const shown = visibleShots().length;
  $('#shot-count').textContent = total ? (shown === total ? String(total) : `${shown}/${total}`) : '0';
  renderStats();
}

function renderStats() {
  const el = $('#stats');
  if (!state.shots.length) { el.innerHTML = ''; return; }
  const withDialogue = state.shots.filter(s => s.dialogue).length;
  const total = state.shots.reduce((a, s) => a + (s.end - s.start), 0);
  const avg = total / state.shots.length;
  el.innerHTML = `
    <span>镜头 <b>${state.shots.length}</b></span>
    <span>总长 <b>${fmtTime(total)}</b></span>
    <span>有台词 <b>${withDialogue}</b></span>
    <span>均长 <b>${avg.toFixed(1)}s</b></span>`;
}

/* ---------------- 多选与批量 ---------------- */
function clearSelection() {
  state.selected.clear();
  document.querySelectorAll('.shot-card.selected').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.pick input').forEach(i => { i.checked = false; });
  updateSelBar();
}

function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  const card = document.querySelector(`.shot-card[data-id="${id}"]`);
  if (card) card.classList.toggle('selected', on);
  updateSelBar();
}

function updateSelBar() {
  const bar = $('#sel-bar');
  const n = state.selected.size;
  $('#sel-n').textContent = String(n);
  bar.hidden = n === 0;
}

function selectedShots() {
  return state.shots.filter(s => state.selected.has(s.id));
}

async function doMerge() {
  const ids = [...state.selected];
  if (ids.length < 2) return toast('至少选择两个相邻镜头', true);
  const r = mergeShots(state.shots, ids);
  if (r.error) return toast(r.error, true);
  state.shots = r.shots;
  clearSelection();
  render();
  toast(`已合并为 1 个镜头`);
}

function doDelete() {
  const n = state.selected.size;
  if (!n) return;
  state.shots = deleteShots(state.shots, [...state.selected]);
  clearSelection();
  render();
  toast(`已删除 ${n} 个镜头，时间轴已接续`);
}

async function doSplit() {
  if (!state.video) return toast('先加载视频', true);
  const t = state.video.currentTime;
  const r = splitShot(state.shots, t);
  if (r.error) return toast(r.error, true);
  state.shots = r.shots;
  render();
  toast(`已在 ${fmtShort(t)} 处拆分`);
  try {
    await captureThumbs(state.video, [r.right]);
    render();
  } catch { /* 取帧失败不影响拆分 */ }
}

function openBatch() {
  if (!state.selected.size) return toast('先选择镜头', true);
  $('#batch-camera').value = '';
  $('#batch-audio').value = '';
  $('#batch-modal').hidden = false;
}

function applyBatch() {
  const camera = $('#batch-camera').value.trim();
  const audio = $('#batch-audio').value.trim();
  const onlyEmpty = $('#batch-only-empty').checked;
  if (!camera && !audio) return toast('至少填一项', true);
  let n = 0;
  for (const s of selectedShots()) {
    if (camera && (!onlyEmpty || !(s.camera || '').trim())) { s.camera = camera; n++; }
    if (audio && (!onlyEmpty || !(s.audio || '').trim())) { s.audio = audio; n++; }
  }
  $('#batch-modal').hidden = true;
  render();
  toast(`已更新 ${selectedShots().length} 个镜头`);
}

/* ---------------- 质检 ---------------- */
function showQC() {
  if (!state.shots.length) return toast('还没有分镜', true);
  $('#modal').dataset.mode = 'qc';
  const issues = qcShots(state.shots);
  const title = $('#modal-title');
  const body = $('#modal-content');
  title.textContent = issues.length ? `质检 · 发现 ${issues.length} 项` : '质检 · 全部通过';

  if (!issues.length) {
    body.textContent = [
      `镜头数：${state.shots.length}`,
      '时间轴：连续、无重叠',
      '必填字段：画面 / 运镜 / 声音 均已填写',
      '台词：无重复',
      '',
      '可以导出了。'
    ].join('\n');
    $('#modal').hidden = false;
    return;
  }

  const lines = issues.slice(0, 200).map(i => `${i.level === 'error' ? '✕' : '!'} ${i.msg}`);
  body.textContent = lines.join('\n') + (issues.length > 200 ? `\n… 还有 ${issues.length - 200} 项` : '');

  const fix = document.createElement('button');
  fix.className = 'btn small';
  fix.textContent = '自动重排 + 修重叠';
  fix.addEventListener('click', () => {
    state.shots = autoFix(state.shots);
    render();
    $('#modal').hidden = true;
    toast('已重排并修掉重叠');
  });
  body.appendChild(document.createElement('div')).appendChild(fix);
  $('#modal').hidden = false;
}

/* ---------------- 渲染 ---------------- */
function showSkeleton(n) {
  const list = $('#storyboard-list');
  $('#empty-state').hidden = true;
  list.hidden = false;
  list.innerHTML = Array.from({ length: n }, () => `
    <article class="shot-card skeleton">
      <div class="shot-media"></div>
      <div class="shot-body">
        <div class="line w85"></div>
        <div class="line"></div>
        <div class="line w60"></div>
      </div>
    </article>`).join('');
}

function render() {
  const list = $('#storyboard-list');
  const empty = $('#empty-state');
  updateCount();

  if (!state.shots.length) {
    list.hidden = true;
    empty.hidden = false;
    list.innerHTML = '';
    updateSelBar();
    return;
  }
  empty.hidden = true;
  list.hidden = false;

  const shots = visibleShots();
  if (!shots.length) {
    list.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-art">🔍</div><h3>没有匹配的镜头</h3><p>换个关键词，或把筛选切回「全部」。</p></div>`;
    updateSelBar();
    return;
  }

  list.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const s of shots) {
    const card = document.createElement('article');
    card.className = 'shot-card' + (state.selected.has(s.id) ? ' selected' : '');
    card.dataset.id = s.id;
    card.innerHTML = `
      <div class="shot-media">
        ${s.thumb ? `<img src="${s.thumb}" alt="镜头 ${s.id}" loading="lazy" />` : '<div class="media-empty">无关键帧</div>'}
        <span class="chip-id">#${String(s.id).padStart(3, '0')}</span>
        <span class="chip-time">${fmtShort(s.start)}–${fmtShort(s.end)}</span>
        <label class="pick" title="选择"><input type="checkbox" ${state.selected.has(s.id) ? 'checked' : ''} /></label>
        ${s.thumb ? '<button class="btn-expand" type="button" title="看大图">⤢</button>' : ''}
      </div>
      <div class="shot-body">
        <div class="desc" contenteditable="true" data-field="visual" spellcheck="false">${esc(s.visual || '（待填写）')}</div>
        <div class="say${s.dialogue ? '' : ' empty'}" contenteditable="true" data-field="dialogue" data-empty="${s.dialogue ? '' : '1'}" spellcheck="false">${esc(s.dialogue || '（无台词）')}</div>
        <div class="meta-chips">
          <span class="mchip"><b>运镜</b><span contenteditable="true" data-field="camera">${esc(s.camera || '—')}</span></span>
          <span class="mchip"><b>声音</b><span contenteditable="true" data-field="audio">${esc(s.audio || '—')}</span></span>
        </div>
        ${hasShotDetail(s) ? `
        <details class="detail">
          <summary>详情 · 构图 / 光线 / 眼神 / 表情</summary>
          <div class="detail-rows">
            ${detailRow('构图', s.composition, 'composition')}
            ${detailRow('光线', s.lighting, 'lighting')}
            ${detailRow('眼神', s.gaze, 'gaze')}
            ${detailRow('表情', s.emotion, 'emotion')}
          </div>
        </details>` : ''}
      </div>`;

    card.addEventListener('click', (e) => {
      if (e.target.closest('[contenteditable]') || e.target.closest('.btn-expand') || e.target.closest('.pick')) return;
      if (state.video) { seekTo(state.video, s.start); state.video.play().catch(() => {}); }
      document.querySelectorAll('.shot-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });

    const pick = card.querySelector('.pick input');
    pick.addEventListener('change', () => toggleSelect(s.id, pick.checked));

    const expand = card.querySelector('.btn-expand');
    if (expand) {
      expand.addEventListener('click', (e) => {
        e.stopPropagation();
        openLightbox(s);
      });
    }

    card.querySelectorAll('[contenteditable]').forEach(el => {
      el.addEventListener('blur', () => {
        const field = el.dataset.field;
        let val = el.textContent.trim();
        if (el.dataset.empty && (val === '（无台词）' || !val)) val = '';
        s[field] = field === 'dialogue' ? (val || null) : val;
        if (field === 'dialogue') {
          el.dataset.empty = val ? '' : '1';
          el.classList.toggle('empty', !val);
          if (!val) el.textContent = '（无台词）';
        }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
      });
    });

    frag.appendChild(card);
  }
  list.appendChild(frag);
  updateSelBar();
}

function hasShotDetail(s) {
  return ['composition', 'lighting', 'gaze', 'emotion'].some(k => (s[k] || '').trim());
}

function detailRow(label, value, field) {
  if (!(value || '').trim()) return '';
  return `<div class="drow"><i>${label}</i><span contenteditable="true" data-field="${field}">${esc(value)}</span></div>`;
}

function esc(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 档案与结构 ---------------- */
function renderExtras() {
  const box = $('#extras');
  const ex = state.extras;
  if (!hasExtras(ex)) { box.hidden = true; return; }
  box.hidden = false;
  $('#extras-title').textContent = ex.title ? `档案与结构 · ${ex.title}` : '档案与结构';

  const esc = (v) => String(v || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const chars = (ex.characters || []).map((c, i) => `
    <li><b>${esc(c.name)}</b>${c.role ? `（${esc(c.role)}）` : ''}<br>
      <span contenteditable="true" data-kind="char" data-i="${i}" data-f="profile">${esc(c.profile || '—')}</span><br>
      <span contenteditable="true" data-kind="char" data-i="${i}" data-f="tone" style="color:var(--txt-3)">${esc(c.tone || '—')}</span>
    </li>`).join('');
  const struct = (ex.structure || []).map((x, i) => `
    <li><code>${esc(x.start)}-${esc(x.end)}</code><b>${esc(x.phase)}</b><br>
      <span contenteditable="true" data-kind="struct" data-i="${i}" data-f="note">${esc(x.note || '—')}</span>
    </li>`).join('');
  const notes = (ex.notes || []).map((n, i) => `
    <li contenteditable="true" data-kind="note" data-i="${i}">${esc(n)}</li>`).join('');

  $('#extras-body').innerHTML = `
    <div class="ex-grid">
      <div class="ex-col"><h4>角色档案（${(ex.characters || []).length}）</h4><ul>${chars || '<li>—</li>'}</ul></div>
      <div class="ex-col"><h4>剧情结构</h4><ul>${struct || '<li>—</li>'}</ul></div>
      <div class="ex-col"><h4>表演与剪辑要点</h4><ul>${notes || '<li>—</li>'}</ul></div>
    </div>`;

  $('#extras-body').querySelectorAll('[contenteditable]').forEach(el => {
    el.addEventListener('blur', () => {
      const kind = el.dataset.kind, i = Number(el.dataset.i), f = el.dataset.f, v = el.textContent.trim();
      if (kind === 'char' && ex.characters?.[i]) ex.characters[i][f] = v;
      else if (kind === 'struct' && ex.structure?.[i]) ex.structure[i][f] = v;
      else if (kind === 'note' && ex.notes) ex.notes[i] = v;
    });
  });
}

async function regenExtras() {
  if (!state.shots.length) return toast('还没有分镜', true);
  if (!state.cfg.api_key) return toast('先去「模型设置」填 API Key', true);
  try {
    toast('正在归纳…');
    const { text } = await chat({ ...state.cfg, effort: 'low', max_tokens: 8192 },
      buildSummaryMessages(state.shots, { castHint: ($('#cast-hint')?.value || '').trim() }));
    state.extras = parseSummaryJSON(text);
    renderExtras();
    toast('档案已更新');
  } catch (e) {
    toast(`失败：${e.message}`, true);
  }
}

/* ---------------- 大图 ---------------- */
function openLightbox(shot) {
  if (!shot.thumb) return;
  $('#lightbox-img').src = shot.thumb;
  $('#lightbox-cap').textContent = `#${String(shot.id).padStart(3, '0')} · ${fmtShort(shot.start)}–${fmtShort(shot.end)}`;
  $('#lightbox').hidden = false;
}

/* ---------------- 导出 ---------------- */
function exportMeta() {
  return {
    ...state.meta,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    model: state.cfg.model_name
  };
}

function ensureShots() {
  if (!state.shots.length) { toast('还没有分镜可导出', true); return false; }
  return true;
}

function doExport(kind) {
  if (!ensureShots()) return;
  const meta = exportMeta();
  const base = (meta.filename || 'script').replace(/\.[^.]+$/, '') + '_storyboard';
  if (kind === 'md') {
    const text = toMarkdown(meta, state.shots, state.extras);
    state.lastExport = { name: `${base}.md`, text, mime: 'text/markdown;charset=utf-8' };
    download(state.lastExport.name, text, state.lastExport.mime);
  } else if (kind === 'csv') {
    const text = toCSV(meta, state.shots);
    state.lastExport = { name: `${base}.csv`, text, mime: 'text/csv;charset=utf-8' };
    download(state.lastExport.name, text, state.lastExport.mime);
  } else {
    const text = toJSON(meta, state.shots, state.extras);
    state.lastExport = { name: `${base}.json`, text, mime: 'application/json' };
    download(state.lastExport.name, text, state.lastExport.mime);
  }
  toast(`已导出 ${state.lastExport.name}`);
}

function preview() {
  if (!ensureShots()) return;
  const text = toMarkdown(exportMeta(), state.shots, state.extras);
  state.lastExport = { name: 'preview.md', text, mime: 'text/markdown;charset=utf-8' };
  $('#modal').dataset.mode = 'doc';
  $('#modal-title').textContent = `预览 · ${state.shots.length} 镜${hasExt(state.shots) ? '（含扩展字段）' : ''}`;
  $('#modal-content').textContent = text;
  $('#modal').hidden = false;
}

/* ---------------- 演示数据 ---------------- */
function loadDemo() {
  const demo = [
    { id: 1, start: 0, end: 13, visual: '雨后的老巷，地面积水映着路灯。白色厢式货车横在巷中，司机跳下车指着车头前的两个孩子骂。男孩军绿夹克，女孩姜黄毛衣，背贴车厢不敢动。', dialogue: '谁家的野孩子，破车横在路中间，差点撵着你们，赶紧走开。', camera: '大远景起幅，切司机中景、孩子双人中景；机位始终高于孩子', audio: '雨滴声、引擎怠速、远处车流；无 BGM',
      composition: '司机居中偏右占主体，两个孩子在左前景形成过肩框架，白色车厢封住右侧边界',
      lighting: '钠灯从右上方打下，额头与鼻梁有高光，下颌与颈部落影，整体偏冷青',
      gaze: '司机的视线越过镜头压向两个孩子，停留约 3 秒',
      emotion: '起：眉心拧成结 → 中：眼睛瞪圆、下颌前顶 → 末：嘴唇抿紧，维持凶狠' },
    { id: 2, start: 13, end: 20, visual: '霍征从暗处走出，黑色呢大衣、没打伞，肩头湿一片，站到孩子与司机之间。', dialogue: '住口。冲两个孩子耍横，你丢不丢人。', camera: '过肩双人中景，切正面近景', audio: '雨声持续，脚步踩水' },
    { id: 3, start: 20, end: 47, visual: '两个孩子一人一句往他跟前凑，女孩说照片，男孩说“你是我爸”，霍征往后退半步。', dialogue: '他跟妈枕头底下那张照片长得一模一样……叔叔你是我爸对不对。', camera: '孩子近景交替，穿插霍征反应近景；仰拍', audio: '雨声变轻，孩子声音发颤' },
    { id: 4, start: 47, end: 63, visual: '霍征蹲下来与孩子平视，问出“你们妈叫什么名字”。', dialogue: '南巷渠边修皮具做刷子的柳清禾。', camera: '蹲下后的平视双人中景', audio: '环境声压低，留白' },
    { id: 5, start: 63, end: 81, visual: '巷口，唐特助拉开车门，两个孩子被安置进后座，霍征弯腰对车窗说话。', dialogue: '听话，爸爸去接妈妈，你们在商场乖乖等电话。', camera: '车外中景，切车内视角', audio: '车门声、引擎启动' },
    { id: 6, start: 81, end: 96, visual: '车走了，霍征一个人站在巷口，低头看身上的呢大衣，抬手把它脱下来。', dialogue: '当年你甩给我一句跟你没活路，我认了。', camera: '单人近景转中景，脱衣动作完整入画', audio: '雨停，远处车流声' }
  ];
  state.shots = demo;
  state.extras = {
    title: '夜巷认亲 · 刷子打脸',
    characters: [
      { name: '霍征', role: '男主 · 车队老板', profile: '短发、眉骨高；前段黑呢大衣，02:04 后换深灰牛仔夹克＋米色卫衣', tone: '命令句快、认罪句慢；情绪往下压' },
      { name: '柳清禾', role: '女主 · 皮具手艺', profile: '酒红盘扣外套、长辫垂胸、耳后别笔；手上有裂口与冻疮', tone: '越说越硬，用干活的手说话' },
      { name: '男孩', role: '霍家长子', profile: '军绿夹克、短发；语速快、爱抢话', tone: '仰头、皱眉，认亲靠喊' }
    ],
    structure: [
      { start: '00:00', end: '01:36', phase: '夜巷认亲（钩子）', note: '货车险撞 → 孩子认出爸 → 报出妈妈名字' },
      { start: '01:36', end: '02:06', phase: '打听与待命（信息差）', note: '大姐的嘴把女主的苦说透，车队就位揭底' },
      { start: '02:06', end: '03:18', phase: '重逢对质（真相）', note: '翻旧账 → “你说什么” → 逼上船的真相' }
    ],
    notes: [
      '让外人（大姐）说惨，当事人不自己诉苦',
      '反派提出一个观众都算得清的亏本价，压价才成立',
      '不辩解，直接演示——把“烂木头”原话还给反派'
    ]
  };
  state.meta = { filename: 'demo_鞋刷.mp4', duration: 448, width: 544, height: 960 };
  $('#video-meta').textContent = '演示数据 · 07:28 · 544×960';
  clearSelection();
  render();
  renderExtras();
  toast('已载入演示数据');
}

/* ---------------- 设置 ---------------- */
function bindSettings() {
  const open = () => { fillSettingsForm(); $('#settings-drawer').hidden = false; };
  const close = () => { $('#settings-drawer').hidden = true; };

  $('#btn-settings').addEventListener('click', open);

  const fallback = $('#btn-fallback');
  if (fallback) {
    fallback.addEventListener('click', () => {
      state.cfg = { ...state.cfg, base_url: OFFICIAL_BASE, model_name: 'deepseek-flash', api_key: '', passcode: '' };
      saveConfig();
      syncModelBadge();
      $('#net-tip').hidden = true;
      fillSettingsForm();
      $('#settings-drawer').hidden = false;
      setTimeout(() => {
        const el = $('#cfg-apikey');
        el?.focus();
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 80);
      toast('已切到官方接口，粘贴 Key 后点保存');
    });
  }
  const tipClose = $('#net-tip-close');
  if (tipClose) tipClose.addEventListener('click', () => { $('#net-tip').hidden = true; });
  $('#key-warning-close').addEventListener('click', () => { $('#key-warning').hidden = true; });
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => {
    close();
    $('#modal').hidden = true;
    $('#batch-modal').hidden = true;
  }));

  $('#cfg-provider').addEventListener('change', () => {
    const p = PROVIDER_PRESETS[$('#cfg-provider').value];
    if (!p) return;
    $('#cfg-baseurl').value = p.base_url;
    $('#cfg-model').value = p.model_name;
    $('#cfg-vision').checked = !!p.vision;
  });

  $('#btn-save-cfg').addEventListener('click', () => {
    const next = readSettingsForm();
    if (!next.base_url || !next.model_name) return toast('Base URL 与模型名不能为空', true);
    state.cfg = { ...state.cfg, ...next };
    saveConfig();
    syncModelBadge();
    $('#key-warning').hidden = !(DEMO_KEY && state.cfg.api_key === DEMO_KEY);
    close();
    toast('配置已保存到本机');
  });

  $('#btn-use-proxy').addEventListener('click', () => {
    $('#cfg-provider').value = 'deepseek';
    $('#cfg-baseurl').value = PROXY_PRESET.base_url;
    $('#cfg-model').value = PROXY_PRESET.model_name;
    $('#cfg-apikey').value = 'proxy';
    $('#cfg-passcode').value = PROXY_PRESET.passcode || '';
    $('#cfg-vision').checked = true;
    $('#cfg-effort').value = 'high';
    toast('已填入本站代理，点「保存」生效');
  });

  $('#btn-reset-cfg').addEventListener('click', () => {
    state.cfg = { ...DEFAULT_MODEL_CONFIG };
    saveConfig();
    fillSettingsForm();
    syncModelBadge();
    toast('已恢复默认配置');
  });

  $('#btn-test-cfg').addEventListener('click', async () => {
    const btn = $('#btn-test-cfg');
    const out = $('#cfg-test-out');
    btn.disabled = true;
    out.textContent = '测试中…';
    try {
      const cfg = { ...state.cfg, ...readSettingsForm() };
      const r = await testConnection(cfg);
      out.textContent = `✅ 可用：${r.model}，${r.ms}ms，返回「${r.text}」`;
    } catch (e) {
      out.textContent = `❌ 失败：${e.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  $('#model-quick-select').addEventListener('change', (e) => {
    const preset = PROVIDER_PRESETS[e.target.value];
    if (!preset) return;
    state.cfg = { ...state.cfg, provider: e.target.value, base_url: preset.base_url, model_name: preset.model_name, vision: preset.vision };
    saveConfig();
    syncModelBadge();
    toast(`已切换到 ${preset.label}（记得在设置里填对应 Key）`);
  });
}

/* ---------------- 历史 ---------------- */
function saveHistory() {
  try {
    const item = {
      at: Date.now(),
      file: state.meta.filename,
      duration: state.meta.duration,
      shots: state.shots.map(s => ({ id: s.id, start: s.start, end: s.end, visual: s.visual, dialogue: s.dialogue, camera: s.camera, audio: s.audio }))
    };
    const raw = localStorage.getItem(LS_HISTORY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift(item);
    localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(0, 3)));
  } catch { /* 配额满了忽略 */ }
}

/* ---------------- 帮助 ---------------- */
function showHelp() {
  $('#modal').dataset.mode = 'doc';
  $('#modal-title').textContent = '方法论与输出格式';
  $('#modal-content').textContent = [
    '一、拆解流程',
    '1) 浏览器内解码视频 → 按间隔采样 → 逐帧灰度差分检测硬切点；',
    '2) 切点合成镜头区间（可合并 <0.8s 碎片）；',
    '3) 每个镜头抽取一张关键帧；',
    '4) 分批把「镜头编号 + 起止时间 + 关键帧」发给多模态模型；',
    '5) 模型按固定字段返回 JSON，前端合并、渲染、可编辑；',
    '6) 导出 Markdown / CSV / JSON。',
    '',
    '二、字段',
    '核心：Shot ID｜Timecode｜Visual Description｜Dialogue｜Camera Movement｜Audio/SFX',
    '扩展（有画面时）：Composition｜Lighting｜Eye Contact｜Emotion Arc',
    '',
    '三、逐镜编辑',
    '· 勾选卡片左上角可多选：合并相邻镜头、批量补运镜/声音、删除（时间轴自动接续）；',
    '· 「在播放头拆分」：把播放器当前时间所在的镜头一分为二；',
    '· 「质检」：查时间轴断点/重叠、空字段、台词重复，可一键重排修复。',
    '',
    '四、快捷键',
    '空格 播放/暂停　← → 前后 1 秒　J / K 上一镜 / 下一镜　Esc 关闭弹层',
    '',
    '五、几条硬规矩（沿用视频脚本逆向的方法论）',
    '· 台词零清洗：保留语气词，不美化、不概括；',
    '· 眼神必须具名：写清谁看谁、看哪个部位；',
    '· 表情写轨迹：起 → 中 → 末，不写单一形容词；',
    '· 看不见的部分宁可写「不确定」，不许编。',
    '',
    '六、已知限制',
    '· 浏览器不能做语音识别：台词精度取决于烧录字幕或你粘贴的字幕；',
    '· 跨域视频可能无法取帧（画布污染），请上传本地文件；',
    '· 模型看到的是离散关键帧，镜头内连续运动只能推断。'
  ].join('\n');
  $('#modal').hidden = false;
}

/* ---------------- 键盘 ---------------- */
function togglePlay() {
  if (!state.video) return;
  if (state.video.paused) state.video.play().catch(() => {}); else state.video.pause();
}

function seekBy(d) {
  if (!state.video) return;
  state.video.currentTime = Math.max(0, Math.min(state.video.duration || 0, state.video.currentTime + d));
}

function jumpShot(dir) {
  if (!state.video || !state.shots.length) return;
  const t = state.video.currentTime;
  const list = [...state.shots].sort((a, b) => a.start - b.start);
  const cur = list.findIndex(s => t >= s.start && t < s.end);
  const idx = Math.max(0, Math.min(list.length - 1, (cur === -1 ? 0 : cur) + dir));
  state.video.currentTime = list[idx].start;
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toUpperCase();
    if (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.key === 'Escape') {
      $('#lightbox').hidden = true;
      $('#modal').hidden = true;
      $('#settings-drawer').hidden = true;
      $('#batch-modal').hidden = true;
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(1); }
    else if (e.key === 'j' || e.key === 'J') jumpShot(-1);
    else if (e.key === 'k' || e.key === 'K') jumpShot(1);
  });
}

/* ---------------- 启动 ---------------- */
function boot() {
  loadConfig();
  syncModelBadge();
  bindVideoInputs();
  bindSettings();
  bindKeyboard();

  $('#btn-run').addEventListener('click', run);
  $('#btn-cancel').addEventListener('click', () => state.abort?.abort());
  $('#btn-export-md').addEventListener('click', () => doExport('md'));
  $('#btn-export-csv').addEventListener('click', () => doExport('csv'));
  $('#btn-export-json').addEventListener('click', () => doExport('json'));
  $('#btn-preview').addEventListener('click', preview);
  $('#btn-qc').addEventListener('click', showQC);
  $('#btn-demo').addEventListener('click', loadDemo);
  $('#btn-help').addEventListener('click', showHelp);

  $('#btn-merge').addEventListener('click', doMerge);
  $('#btn-split').addEventListener('click', doSplit);
  $('#btn-del').addEventListener('click', doDelete);
  $('#btn-batch').addEventListener('click', openBatch);
  $('#btn-sel-clear').addEventListener('click', clearSelection);
  $('#btn-batch-apply').addEventListener('click', applyBatch);
  $('#btn-regen-extras').addEventListener('click', regenExtras);
  $('#btn-queue').addEventListener('click', runQueue);
  $('#btn-local-asr').addEventListener('click', localTranscribe);

  document.querySelectorAll('#filter-seg button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filter-seg button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      state.filter = btn.dataset.filter;
      render();
    });
  });
  $('#search-input').addEventListener('input', debounce((e) => {
    state.query = e.target.value || '';
    render();
  }, 180));

  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });

  $('#btn-copy').addEventListener('click', async () => {
    if (!state.lastExport) return toast('先预览或导出一次', true);
    try {
      await navigator.clipboard.writeText(state.lastExport.text);
      toast('已复制');
    } catch {
      toast('浏览器拒绝剪贴板访问', true);
    }
  });
  $('#btn-download-last').addEventListener('click', () => {
    if (!state.lastExport) return toast('先预览或导出一次', true);
    download(state.lastExport.name.replace(/\.md$/, '_preview.md'), state.lastExport.text, state.lastExport.mime);
  });

  window.addEventListener('online', () => toast('网络已恢复'));
  window.addEventListener('offline', () => toast('网络已断开，模型调用不可用', true));

  log('就绪。加载视频 → 点「开始拆解」。没有 Key 可先点「演示数据」看界面。');

  if (window.SB_NATIVE) {
    log(`桌面版 ${window.SB_NATIVE.version || ''} · 本地转写可用`, 'ok');
    window.SB_NATIVE.checkUpdate().then(r => {
      if (r?.ok && r.latest && r.latest !== r.current) {
        toast(`发现新版本 v${r.latest}（当前 v${r.current}）`);
        log(`有新版本 v${r.latest}，下载：${r.url}`, 'ok');
      }
    }).catch(() => {});
  }

  // 用的是本站代理？探测一下可达性，不通就给一条「切官方接口」的退路
  if ((state.cfg.base_url || '').includes('workers.dev')) {
    probeProxy(state.cfg).then((ok) => {
      if (!ok) {
        $('#net-tip').hidden = false;
        log('本站代理当前网络不可达，可点顶部提示切到官方接口', 'err');
      }
    });
  }

  const qs = new URLSearchParams(location.search);
  if (qs.get('demo') === '1' || location.hash === '#demo') loadDemo();
  if (qs.get('panel') === 'settings') setTimeout(() => $('#btn-settings').click(), 200);
}

boot();
