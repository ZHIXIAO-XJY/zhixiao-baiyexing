/**
 * ScriptBreaker 桌面版主进程
 * - 用自定义协议 app:// 提供静态文件（file:// 下 ES Module 会被 CORS 拦）
 * - 注入默认配置：团队开箱即用（走代理 + 口令）
 */
const { app, BrowserWindow, protocol, net, shell, dialog } = require('electron');
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

// 团队默认配置：走 Cloudflare 代理，前端不持有真 Key
const DESKTOP_CONFIG = {
  api_key: 'proxy',
  base_url: 'https://scriptbreaker-proxy.805352942.workers.dev/v1',
  model_name: 'deepseek-flash',
  passcode: '白夜行'
};

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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
