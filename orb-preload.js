// For the corner orb's window (orb.js → renderer/orb.html): a small fixed set of channels, plus the real path of a
// dropped file (webUtils, which the renderer can't reach itself).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('orb', {
  on: (fn) => ipcRenderer.on('orb', (_e, msg) => fn(msg)),
  send: (msg) => ipcRenderer.send('orb-act', msg),
  hits: (rects) => ipcRenderer.send('orb-hits', rects),
  ready: () => ipcRenderer.send('orb-ready'),
  filePath: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});
