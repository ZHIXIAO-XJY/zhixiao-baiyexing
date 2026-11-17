/**
 * preload.js —— 只暴露必要的本地能力给页面
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('SB_NATIVE', {
  version: process.versions.electron,
  platform: process.platform,
  /** 取 File 对象在磁盘上的真实路径（Electron 30+ 用 webUtils） */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  probe: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  extractAudio: (filePath) => ipcRenderer.invoke('media:audio', filePath),
  transcribe: (wavBuffer, opts) => ipcRenderer.invoke('asr:transcribe', wavBuffer, opts),
  onProgress: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('asr:progress', h);
    return () => ipcRenderer.removeListener('asr:progress', h);
  },
  checkUpdate: () => ipcRenderer.invoke('app:check-update')
});
