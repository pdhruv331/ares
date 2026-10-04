// ARES notifications (docs/ares-theme-prompt.md, part 5): ARES's own alerts (job done, call summaries, reminders,
// needs-your-yes) materialize as FRIDAY panels near the top-right of the screen, in a transparent overlay above the
// apps that's click-through except over a panel. Other apps' notifications stay native.
//
// Focus: when a Focus is on, only urgent ones show; the rest go to Notification Center as native notifications, which
// macOS holds or delivers per the Focus. If ARES can't tell (reading the Focus state needs Full Disk Access), the
// overlay shows them. If the overlay can't show, a native notification is used instead.
const path = require('path');
const { BrowserWindow, screen, Notification, ipcMain } = require('electron');
const { run } = require('./theme-prefs');

const WIDTH = 360, HEIGHT = 560;

class Notify {
  constructor({ helper, log, appDir, onAct }) {
    Object.assign(this, { helper, log, appDir, onAct });
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.hits = [];
    this.interactive = false;
    this.seq = 0;
  }

  start() {
    if (this.win) return;
    const a = screen.getPrimaryDisplay().workArea;
    this.win = new BrowserWindow({
      x: a.x + a.width - WIDTH - 8, y: a.y + 6, width: WIDTH, height: HEIGHT,
      type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, fullscreenable: false, acceptFirstMouse: true, show: false,
      webPreferences: { preload: path.join(this.appDir, 'theme-preload.js'), contextIsolation: true },
    });
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.win.setHiddenInMissionControl?.(true);
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.loadFile(path.join(this.appDir, 'renderer', 'theme-toast.html'));
    this.win.once('ready-to-show', () => this.win?.showInactive());
    this.win.webContents.on('render-process-gone', () => { this.ready = false; });
    const on = (ch, fn) => { const h = (e, m) => { if (this.win && e.sender === this.win.webContents) fn(m); }; ipcMain.on(ch, h); (this.ipc ??= []).push([ch, h]); };
    on('theme-ready', () => { this.ready = true; for (const t of this.queue.splice(0)) this.win.webContents.send('theme-toast', { type: 'show', toast: t }); });
    on('theme-hits', (h) => { this.hits = Array.isArray(h) ? h : []; this.watchPointer(); });
    on('theme-toast-act', (m) => {
      if (m?.type === 'open' && m.toast) this.onAct(m.toast.action || { type: 'summon' });
    });
    this.onDisplays = () => { const w = screen.getPrimaryDisplay().workArea; this.win?.setBounds({ x: w.x + w.width - WIDTH - 8, y: w.y + 6, width: WIDTH, height: HEIGHT }); };
    for (const e of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(e, this.onDisplays);
  }
  stop() {
    clearInterval(this.pointer); this.pointer = null;
    for (const [ch, h] of this.ipc || []) ipcMain.removeListener(ch, h);
    this.ipc = [];
    if (this.onDisplays) for (const e of ['display-metrics-changed', 'display-added', 'display-removed']) screen.removeListener(e, this.onDisplays);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
  }

  /** Is a Focus on? true / false / null (unknown). */
  async focus() {
    try { return JSON.parse(await run(this.helper, ['focus'])).focus; } catch { return null; }
  }

  /**
   * Show one of ARES's alerts.
   * @param {{ kind?: 'day'|'work'|'call'|'needs', label: string, tag?: string, value: string, detail?: string,
   *           ttl?: number, urgent?: boolean, action?: object }} t
   */
  async show(t) {
    const toast = { id: ++this.seq, kind: 'day', tag: '', detail: '', ttl: t.kind === 'needs' ? 25_000 : 9000, ...t };
    const focus = await this.focus();
    if (focus === true && !toast.urgent) return this.native(toast, 'focus');
    if (!this.win || this.win.isDestroyed()) return this.native(toast, 'no overlay');
    if (!this.ready) { this.queue.push(toast); setTimeout(() => { if (!this.ready && this.queue.includes(toast)) { this.queue.splice(this.queue.indexOf(toast), 1); this.native(toast, 'overlay not ready'); } }, 4000); return; }
    this.win.webContents.send('theme-toast', { type: 'show', toast });
    this.log('theme toast', { kind: toast.kind, label: toast.label, focus });
  }
  native(toast, why) {
    this.log('theme toast native', { why, label: toast.label });
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `ARES · ${toast.label}`, body: [toast.value, toast.detail].filter(Boolean).join('\n'), silent: !toast.urgent });
    n.on('click', () => this.onAct(toast.action || { type: 'summon' }));
    n.show();
  }

  /** Click-through except over a panel: checked only while panels are up. */
  watchPointer() {
    if (!this.hits.length) {
      clearInterval(this.pointer); this.pointer = null;
      if (this.interactive) { this.interactive = false; this.win?.setIgnoreMouseEvents(true, { forward: true }); }
      return;
    }
    this.pointer ??= setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return;
      const p = screen.getCursorScreenPoint(), b = this.win.getBounds();
      const x = p.x - b.x, y = p.y - b.y;
      const over = this.hits.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
      if (over !== this.interactive) { this.interactive = over; this.win.setIgnoreMouseEvents(!over, { forward: true }); }
      this.win.webContents.send('theme-toast', { type: 'pointer', x, y });
    }, 60);
  }
}

module.exports = { Notify };
