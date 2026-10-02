// The wallpaper windows' bridge (renderer/wallpaper.js): receive-only, apart from "ready" and the finished still.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, msg) => fn(msg));
contextBridge.exposeInMainWorld('wp', {
  onScene: on('wp-scene'),
  onMode: on('wp-mode'),
  onJobs: on('wp-jobs'),
  onPrefs: on('wp-prefs'),
  ready: () => ipcRenderer.send('wp-ready'),
  stillDone: (png, error) => ipcRenderer.send('wp-still', png, error || null),
});
