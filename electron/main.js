/**
 * ScriptBreaker 桌面版主进程
 * - 用自定义协议 app:// 提供静态文件（file:// 下 ES Module 会被 CORS 拦）
 * - 注入默认配置：团队开箱即用（走代理 + 口令）
 */
const { app, BrowserWindow, protocol, shell, ipcMain, dialog } = require('electron');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// 团队默认配置：优先读打包时生成的 team-config.json（内置 Key），否则回退到代理
function loadTeamConfig() {
  const candidates = [
    path.join(__dirname, 'team-config.json'),
    path.join(app.isPackaged ? process.resourcesPath : '', 'team-config.json')
  ];
  for (const f of candidates) {
    try {
      if (f && fs.existsSync(f)) {
        const c = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (c && c.api_key) return c;
      }
    } catch { /* ignore */ }
  }
  return {
    api_key: 'proxy',
    base_url: 'https://scriptbreaker-proxy.805352942.workers.dev/v1',
    model_name: 'deepseek-flash',
    passcode: '白夜行'
  };
}
const DESKTOP_CONFIG = loadTeamConfig();

// 本地 whisper（随包分发）
const vendorPath = (...p) => path.join(app.isPackaged ? process.resourcesPath : ROOT, 'vendor', ...p);
const WHISPER_EXE = vendorPath('whisper', 'bin', 'whisper-cli.exe');
const WHISPER_MODEL = vendorPath('whisper', 'models', 'ggml-small-q5_1.bin');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0a0c11',
    title: 'ScriptBreaker',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.show();
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('LOAD_FAIL', code, desc, url));
  win.webContents.on('console-message', (_e, level, msg) => console.log('RENDERER', level, msg));
  win.webContents.on('render-process-gone', (_e, d) => console.error('RENDERER_GONE', JSON.stringify(d)));
  win.loadURL('app://sb/index.html');

  // 冒烟测试：--smoke <输出png>，截图后自动退出
  const smokeIdx = process.argv.indexOf('--smoke');
  if (smokeIdx !== -1) {
    const out = process.argv[smokeIdx + 1] || 'smoke.png';
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const info = await win.webContents.executeJavaScript(`(() => ({
            title: document.title,
            hasGrid: !!document.querySelector('#storyboard-list'),
            buttons: document.querySelectorAll('button').length,
            cfg: window.SB_LOCAL_CONFIG || null,
            ready: document.readyState
          }))()`);
          console.log('SMOKE_INFO', JSON.stringify(info));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          console.log('SMOKE_OK', out);
        } catch (e) {
          console.error('SMOKE_FAIL', e.message);
        } finally {
          app.quit();
        }
      }, 4000);
    });
  }

  // 外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://sb/')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

/* ---------------- 本地转写 ---------------- */
ipcMain.handle('asr:transcribe', async (event, wavBuffer, opts = {}) => {
  if (!fs.existsSync(WHISPER_EXE)) throw new Error('未找到 whisper-cli.exe');
  if (!fs.existsSync(WHISPER_MODEL)) throw new Error('未找到 whisper 模型');
  const stamp = Date.now();
  const wav = path.join(os.tmpdir(), `sb_${stamp}.wav`);
  const out = path.join(os.tmpdir(), `sb_${stamp}`);
  fs.writeFileSync(wav, Buffer.from(wavBuffer));

  return new Promise((resolve, reject) => {
    const threads = Math.max(2, Math.min(8, os.cpus().length - 1));
    const args = ['-m', WHISPER_MODEL, '-f', wav, '-l', opts.lang || 'zh', '-oj', '-of', out, '-t', String(threads)];
    const p = spawn(WHISPER_EXE, args, { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => {
      const txt = d.toString();
      stderr += txt;
      const m = /progress\s*=\s*(\d+)%/.exec(txt);
      if (m) event.sender.send('asr:progress', { percent: Number(m[1]) });
    });
    p.on('error', reject);
    p.on('close', (code) => {
      try {
        const json = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
        const segments = (json.transcription || []).map(t => ({
          start: +(t.offsets.from / 1000).toFixed(2),
          end: +(t.offsets.to / 1000).toFixed(2),
          text: String(t.text || '').trim()
        })).filter(s => s.text);
        resolve({ segments, elapsed: json.systeminfo ? undefined : undefined, code });
      } catch (e) {
        reject(new Error(`whisper 输出解析失败（exit ${code}）：${stderr.slice(-300)}`));
      } finally {
        setTimeout(() => { try { fs.unlinkSync(wav); } catch {} }, 2000);
      }
    });
  });
});

/* ---------------- 版本检查 ---------------- */
ipcMain.handle('app:check-update', async () => {
  try {
    const res = await fetch('https://api.github.com/repos/ZHIXIAO-XJY/zhixiao-baiyexing/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const r = await res.json();
    const latest = String(r.tag_name || '').replace(/^v/, '');
    return { ok: true, current: app.getVersion(), latest, url: r.html_url };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    try {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';

    // 桌面版注入默认配置（覆盖仓库里空的那份）
    if (rel === 'assets/config.local.js' || rel === 'assets/config.js.desktop') {
      const js = `window.SB_LOCAL_CONFIG = ${JSON.stringify(DESKTOP_CONFIG)};`;
      return new Response(js, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }

    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response('Not Found', { status: 404 });
    }
    const ext = path.extname(file).toLowerCase();
    const body = fs.readFileSync(file);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': MIME[ext] || 'application/octet-stream' }
    });
    } catch (e) {
      console.error('PROTO_ERR', request.url, e.message);
      return new Response('Error: ' + e.message, { status: 500 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
