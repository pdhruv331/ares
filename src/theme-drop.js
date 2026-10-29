// The ARES bar's status and WORK drop-downs, drawn by ARES herself (docs/ares-theme-prompt.md): the real status panel
// and the Work list in her own look, hung under their bar item, instead of SketchyBar's text rows.
//
// One window, made once when the theme starts and only filled and shown on hover (theme.js waits a short moment
// first, so passing over the bar doesn't open it). Transparent, above the apps, in every Space, never focused, and
// click-through except while the pointer is over it. It closes when the pointer has left both it and its bar item.
const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const LEAVE_MS = 260; // the pointer has to be gone this long (crossing the gap from the bar is fine)

class Drop {
  constructor({ log, appDir, onAct }) {
    Object.assign(this, { log, appDir, onAct });
    this.win = null;
    this.ready = false;
    this.kind = null;     // what's showing: 'status' | 'work' | null
    this.anchor = null;   // the bar item it hangs from (screen rect)
    this.size = { w: 330, h: 200 };
  }

  start() {
    if (this.win) return;
    this.win = new BrowserWindow({
      width: this.size.w, height: this.size.h, show: false, type: 'panel', frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, fullscreenable: false, acceptFirstMouse: true,
      webPreferences: { preload: path.join(this.appDir, 'theme-preload.js'), contextIsolation: true },
    });
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.win.setHiddenInMissionControl?.(true);
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.loadFile(path.join(this.appDir, 'renderer', 'theme-drop.html'));
    const on = (ch, fn) => { const h = (e, m) => { if (this.win && e.sender === this.win.webContents) fn(m); }; ipcMain.on(ch, h); (this.ipc ??= []).push([ch, h]); };
    on('theme-ready', () => { this.ready = true; });
    on('theme-drop-size', (s) => { if (s?.w && s?.h) { this.size = { w: Math.ceil(s.w), h: Math.ceil(s.h) }; this.place(); } });
    on('theme-drop-act', (a) => this.onAct(a));
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    for (const [ch, h] of this.ipc || []) ipcMain.removeListener(ch, h);
    this.ipc = [];
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
    this.kind = null;
  }
  get isOpen() { return Boolean(this.kind) && Boolean(this.win?.isVisible()); }

  /** Fill it (kind + data), hung under the bar item at `anchor` ({ x, w, h, align }); shown only with show. */
  fill(kind, data, anchor) {
    if (!this.win || this.win.isDestroyed()) return;
    this.pending = { kind, anchor };
    this.win.webContents.send('theme-drop', { type: 'fill', kind, data });
  }
  /** Fresh data for what's open (status updates, job changes, the live CPU and memory). */
  update(kind, data) {
    if (this.kind === kind && this.win && !this.win.isDestroyed()) this.win.webContents.send('theme-drop', { type: 'update', kind, data });
  }
  show() {
    if (!this.win || this.win.isDestroyed() || !this.pending) return;
    const opening = this.kind !== this.pending.kind;
    ({ kind: this.kind, anchor: this.anchor } = this.pending);
    this.place();
    if (!this.win.isVisible()) this.win.showInactive();
    if (opening) this.win.webContents.send('theme-drop', { type: 'open' });
    this.leftAt = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.check(), 50);
  }
  hide() {
    clearInterval(this.timer); this.timer = null;
    this.kind = null;
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) { this.win.setIgnoreMouseEvents(true, { forward: true }); this.win.hide(); }
  }

  /** Under the bar item: left-aligned with it, or right-aligned for an item on the right half; always on screen. */
  place() {
    if (!this.win || this.win.isDestroyed() || !this.anchor) return;
    const d = screen.getPrimaryDisplay().bounds;
    const a = this.anchor;
    let x = a.align === 'right' ? a.x + a.w - this.size.w : a.x - 6;
    x = Math.max(d.x + 6, Math.min(x, d.x + d.width - this.size.w - 6));
    this.win.setBounds({ x: Math.round(x), y: Math.round(d.y + a.h + 2), width: this.size.w, height: this.size.h });
  }

  /** Clickable while the pointer is over it; closed once it has left both it and the bar item for a moment. */
  check() {
    if (!this.win || this.win.isDestroyed() || !this.kind) return;
    const p = screen.getCursorScreenPoint(), b = this.win.getBounds(), a = this.anchor;
    const over = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    const onItem = a && p.x >= a.x - 4 && p.x <= a.x + a.w + 4 && p.y <= a.h + 4;
    const between = a && p.y > a.h && p.y < b.y + 4 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x + a.w, b.x + b.width);
    if (over !== this.over) { this.over = over; this.win.setIgnoreMouseEvents(!over, { forward: true }); }
    if (over || onItem || between) { this.leftAt = 0; return; }
    this.leftAt ||= Date.now();
    if (Date.now() - this.leftAt > LEAVE_MS) this.hide();
  }
}

module.exports = { Drop };
