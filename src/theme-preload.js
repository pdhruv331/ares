// For the ARES theme's own windows (theme.js): the dock overlay, the notification overlay and the hidden icon-art
// renderer. A small fixed set of channels, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const IN = ['theme-dock', 'theme-scene', 'theme-toast', 'theme-art', 'theme-drop'];
const OUT = ['theme-ready', 'theme-hits', 'theme-dock-act', 'theme-toast-act', 'theme-art-done', 'theme-reveal', 'theme-drop-act', 'theme-drop-size'];

contextBridge.exposeInMainWorld('theme', {
  on: (ch, fn) => { if (IN.includes(ch)) ipcRenderer.on(ch, (_e, msg) => fn(msg)); },
  send: (ch, msg) => { if (OUT.includes(ch)) ipcRenderer.send(ch, msg); },
});
