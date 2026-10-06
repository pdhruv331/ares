// ARES everywhere on the Mac (docs/wallpaper-prompt.md, docs/live-desktop-prompt.md).
//
// The live desktop is the ARES window itself (surface.js), just above the desktop icons. This module looks after
// what surrounds it:
//  - the BACKDROP: one BrowserWindow per display at the desktop-picture level (type 'desktop': below the icons and
//    every app, on all Spaces, click-through, never focused) drawing the stars. It shows the brain too (a second view
//    of the one ARES: main.js forwards her state, levels, pulses and jobs) where the ARES window isn't: on other
//    displays, and while ARES is open as a separate window.
//  - when each surface can't be seen (native/AresDesktop.swift), so rendering stops completely then;
//  - where the desktop icons are (Finder), so the panels, brain and orbs keep clear of them;
//  - the lock-screen still. The screen saver is a separate native bundle (native/saver), fed by saver-state.json.
const { BrowserWindow, screen, powerMonitor, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

const COVERED = 0.985; // this much hidden by app windows = nothing worth drawing
const STILL_EVERY_MS = 60 * 60_000; // with "warmer in the evening" on: re-render at most hourly when the tint changes

class Wallpaper extends EventEmitter {
  /**
   * @param {object} o
   * @param {(…) => void} o.log
   * @param {() => object} o.readSettings  @param {(patch: object) => void} o.writeSettings
   * @param {string} o.helper  path to ares-desktop  @param {string} o.appDir  @param {string} o.supportDir
   * @param {() => object} o.prefs  { owner, reduceMotion }
   */
  constructor({ log, readSettings, writeSettings, helper, appDir, supportDir, prefs }) {
    super();
    Object.assign(this, { log, readSettings, writeSettings, helper, appDir, supportDir, prefsOf: prefs });
    this.views = new Map(); // displayId -> { win, wid, ready, mode }
    this.desk = { windows: {}, locked: false, lowPower: false, asleep: false };
    this.screenLocked = false;
    this.suspended = false;
    this.jobList = [];
    this.lastScene = { state: { type: 'state', state: 'idle' }, attention: { type: 'attention', on: false }, spot: { type: 'spot', dx: 0, dy: 0, s: 1 } };
    this.watcher = null;
    this.stillTimer = null;
    this.main = null; // { win, wid, name, mode } the ARES window, while it's the desktop or lifted
    this.icons = [];
    this.power = { mode: 'online', status: null }; // ignition / standby / power down (ignition.js): what the still and the backdrop show
    this.revealed = true; // false during a cold start with the ignition helper up: the backdrop stays hidden until the handover
  }

  // ---- Settings ------------------------------------------------------------------------------------------
  get opts() {
    const w = this.readSettings().wallpaper || {};
    return { enabled: w.enabled !== false, displays: w.displays || 'all', clock: Boolean(w.clock), lockStill: Boolean(w.lockStill),
      lockAsked: Boolean(w.lockAsked), evening: Boolean(w.evening), original: w.original || null,
      caption: ['offline', 'standby', 'none'].includes(w.stillCaption) ? w.stillCaption : 'offline' }; // what the still says under the reactor
  }
  save(patch) { this.writeSettings({ wallpaper: { ...(this.readSettings().wallpaper || {}), ...patch } }); }

  // ---- Lifecycle -----------------------------------------------------------------------------------------
  start() {
    for (const e of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(e, () => this.debounce('displays', () => this.sync(), 600));
    powerMonitor.on('lock-screen', () => { this.screenLocked = true; this.refreshModes(); });
    powerMonitor.on('unlock-screen', () => { this.screenLocked = false; this.refreshModes(); this.maybeRerenderStill(); });
    powerMonitor.on('suspend', () => { this.suspended = true; this.refreshModes(); });
    powerMonitor.on('resume', () => { this.suspended = false; this.refreshModes(); });
    powerMonitor.on('on-battery', () => this.refreshModes());
    powerMonitor.on('on-ac', () => this.refreshModes());
    this.sync();
    this.saverState();
  }

  stop() {
    this.closeAll();
    this.watcher?.kill();
    this.watcher = null;
    this.desktopWatch?.close();
    clearInterval(this.iconPoll);
  }

  /** Make the windows match the settings and the connected displays. */
  sync() {
    const o = this.opts;
    if (!o.enabled) return this.closeAll();
    const displays = o.displays === 'main' ? [screen.getPrimaryDisplay()] : screen.getAllDisplays();
    const want = new Set(displays.map((d) => d.id));
    for (const [id, v] of this.views) if (!want.has(id)) { v.win.destroy(); this.views.delete(id); }
    for (const d of displays) {
      const v = this.views.get(d.id);
      if (v) { v.win.setBounds(d.bounds); continue; }
      this.views.set(d.id, this.createView(d));
    }
    this.ensureWatcher();
    this.watchIcons();
    this.pushIds();
  }

  closeAll() {
    for (const v of this.views.values()) if (!v.win.isDestroyed()) v.win.destroy();
    this.views.clear();
    this.pushIds();
  }

  createView(display) {
    const win = new BrowserWindow({
      type: 'desktop',            // macOS: the desktop-picture level, below the icons; not in the Dock, Cmd-Tab or Mission Control
      ...display.bounds,
      frame: false, hasShadow: false, resizable: false, movable: false, focusable: false, skipTaskbar: true,
      enableLargerThanScreen: true, fullscreenable: false, show: false, backgroundColor: '#02050a',
      webPreferences: { preload: path.join(this.appDir, 'wallpaper-preload.js'), contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false }, // it paces (and pauses) itself; see wallpaper.js
    });
    win.setIgnoreMouseEvents(true);   // icons, Finder and right-clicks work as normal
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.loadFile(path.join(this.appDir, 'renderer', 'wallpaper.html'), { query: { mode: 'wallpaper' } });
    const view = { win, display, wid: null, ready: false, mode: null };
    win.once('ready-to-show', () => {
      if (this.revealed) win.showInactive();
      view.wid = Number(String(win.getMediaSourceId()).split(':')[1]) || null; // "window:<CGWindowID>:0"
      this.pushIds();
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      this.log('wallpaper renderer gone', d.reason);
      if (this.views.get(display.id)?.win === win) { this.views.delete(display.id); win.destroy(); setTimeout(() => this.sync(), 2000); }
    });
    return view;
  }

  /** The page loaded: give it everything it needs to show the current ARES. */
  onReady(sender) {
    const view = [...this.views.values()].find((v) => v.win.webContents === sender);
    if (!view) return;
    view.ready = true;
    view.mode = null;
    const send = (ch, msg) => view.win.webContents.send(ch, msg);
    send('wp-prefs', this.backdropPrefs(view));
    send('wp-scene', this.lastScene.state);
    send('wp-scene', this.lastScene.attention);
    send('wp-scene', this.lastScene.spot);
    if (this.lastScene.power) send('wp-scene', this.lastScene.power);
    if (this.lastScene.offline) send('wp-scene', this.lastScene.offline);
    if (this.lastScene.readouts) send('wp-scene', this.lastScene.readouts);
    send('wp-jobs', this.jobList);
    this.refreshModes();
  }

  send(channel, msg) {
    for (const v of this.views.values()) if (v.ready && !v.win.isDestroyed()) v.win.webContents.send(channel, msg);
  }

  // ---- Live link to ARES -------------------------------------------------------------------------------------
  /** From the main window's scene (renderer/scene-link.js): state, level, pulse, attention. */
  scene(msg) {
    if (msg.type === 'state') this.lastScene.state = msg;
    if (msg.type === 'attention') this.lastScene.attention = msg;
    if (msg.type === 'spot') { this.lastScene.spot = msg; this.rememberSpot(msg); } // where the window's brain sits (shifted aside for panels or icons)
    if (msg.type === 'power') this.lastScene.power = msg;
    if (msg.type === 'readouts') this.lastScene.readouts = msg;
    if (msg.type === 'offline') this.lastScene.offline = msg;
    if (!this.views.size) return;
    this.send('wp-scene', msg);
    if (msg.type === 'state') this.refreshModes(); // 60 fps while listening or speaking
  }
  /**
   * The reactor's place on each display, remembered from the window's `spot` messages (screen px → that display's own CSS px),
   * so the lock-screen still and the ignition helper draw it exactly where the live window does (docs/ignition-prompt.md).
   */
  rememberSpot(msg) {
    if (!Number.isFinite(msg.cx) || !Number.isFinite(msg.r) || msg.r < 20) return;
    const d = screen.getDisplayNearestPoint({ x: msg.cx, y: msg.cy });
    const spot = { cx: Math.round(msg.cx - d.bounds.x), cy: Math.round(msg.cy - d.bounds.y), r: Math.round(msg.r) };
    const spots = this.readSettings().wallpaper?.spots || {};
    const old = spots[d.id];
    if (old && old.cx === spot.cx && old.cy === spot.cy && old.r === spot.r) return;
    this.debounce('spot', () => { this.save({ spots: { ...(this.readSettings().wallpaper?.spots || {}), [d.id]: spot } }); this.emit('geometry'); }, 800);
  }
  /** Where the reactor sits on a display (its own CSS px): the remembered spot, else the window's default placement. */
  geometryFor(display) {
    const spot = (this.readSettings().wallpaper?.spots || {})[display.id];
    if (spot && spot.r > 20 && spot.cx > 0 && spot.cx < display.bounds.width && spot.cy > 0 && spot.cy < display.bounds.height) return { ...spot, scale: display.scaleFactor };
    const wa = display.workArea; // the ARES window is the work area (surface.js); scene.js: radius = min(26% h, 22% w), centre 3% below the middle
    return { cx: Math.round(wa.x - display.bounds.x + wa.width / 2), cy: Math.round(wa.y - display.bounds.y + wa.height / 2 + wa.height * 0.03),
      r: Math.round(Math.min(wa.height * 0.26, wa.width * 0.22)), scale: display.scaleFactor };
  }
  /** Every display's geometry, for the ignition helper (ignition.js writes it to a file). */
  geometries() {
    return screen.getAllDisplays().map((d) => ({ id: d.id, x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height, ...this.geometryFor(d),
      primary: d.id === screen.getPrimaryDisplay().id }));
  }
  /** Ignition / standby / power down: the state the still should show, and a re-render if the still is in use. */
  setPower(mode, status) {
    const was = this.power.mode;
    this.power = { mode, status: status || null };
    const stillKind = (m) => (m === 'standby' || m === 'tostandby' ? 'standby' : 'offline');
    if (this.opts.lockStill && stillKind(was) !== stillKind(mode) && ['standby', 'online', 'offline'].includes(mode)) this.renderStills();
  }
  /** A cold start with the helper drawing the charge: keep the backdrop windows hidden until the handover, then show them. */
  reveal(on) {
    this.revealed = on;
    for (const v of this.views.values()) if (!v.win.isDestroyed() && v.ready) { if (on) v.win.showInactive(); else v.win.hide(); }
  }

  jobs(list) {
    this.jobList = list.map(({ id, status, size, steps, title, dismissed, seen, finished, created }) => ({ id, status, size, steps, title, dismissed, seen, finished, created }));
    this.send('wp-jobs', this.jobList);
    this.saverState();
  }
  prefs() { for (const v of this.views.values()) if (v.ready) v.win.webContents.send('wp-prefs', this.backdropPrefs(v)); }
  /** The backdrop draws the brain (and the optional clock) only where the ARES window isn't the desktop. */
  backdropPrefs(view) {
    const here = this.main && view.display.id === screen.getPrimaryDisplay().id && this.main.name !== 'window';
    return { ...this.prefsOf(), clock: this.opts.clock && !here, brain: !here };
  }

  /** The ARES window moved between the desktop, lifted and a window (surface.js). */
  mainSurface(name, win) {
    const wasHere = this.main?.name;
    this.main = { win, wid: this.main?.wid, name: name === 'sinking' ? 'lifted' : name, mode: null };
    if (!this.main.wid) this.main.wid = Number(String(win.getMediaSourceId()).split(':')[1]) || null;
    if (wasHere == null || (wasHere === 'window') !== (this.main.name === 'window')) this.prefs(); // (the first report too: the backdrop may be up already)
    this.ensureWatcher();
    this.pushIds();
    this.sendIcons();
    this.refreshModes();
  }

  /** For the screen saver: a small read-only file with whether work is running (it never talks to ARES). */
  saverState(force = false) {
    const running = this.jobList.filter((j) => ['queued', 'running', 'approval'].includes(j.status));
    const look = this.readSettings().look === 'brain' ? 'brain' : 'reactor';
    const body = JSON.stringify({ t: Date.now(), look, jobs: running.slice(0, 8).map(({ id, status, size, title }) => ({ id, status, size, title })) });
    if (body.slice(body.indexOf(',')) === this.lastSaverBody && !force) return;
    this.lastSaverBody = body.slice(body.indexOf(','));
    fs.writeFile(path.join(this.supportDir, 'saver-state.json'), body, () => {});
  }

  /** Desk mode needs the helper too (who's using the microphone), with or without the wallpaper. */
  watchAlways(fn) { this.always = fn; this.ensureWatcher(); }

  // ---- Pausing ------------------------------------------------------------------------------------------------
  ensureWatcher() {
    if (this.watcher || (!this.views.size && !this.main && !this.always?.())) return;
    if (!fs.existsSync(this.helper)) { this.log('wallpaper helper missing', this.helper); return; }
    const p = spawn(this.helper, ['watch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.watcher = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { this.desk = JSON.parse(line); this.refreshModes(); this.emit('desk', this.desk); } catch {}
      }
    });
    p.stderr.on('data', (d) => this.log('wallpaper helper', String(d).trim()));
    p.on('exit', (code) => {
      if (this.watcher !== p) return;
      this.watcher = null;
      if (this.views.size || this.main || this.always?.()) { this.log('wallpaper helper exited', code); setTimeout(() => this.ensureWatcher(), 3000); }
    });
    this.pushIds();
  }
  pushIds() {
    const ids = [...this.views.values()].map((v) => v.wid).concat(this.main?.wid).filter(Boolean);
    if (this.watcher) this.watcher.stdin.write(`ids ${ids.join(' ')}\n`);
    if (!this.views.size && !this.main && !this.always?.() && this.watcher) { const w = this.watcher; this.watcher = null; w.kill(); }
  }

  /** Paused (draw nothing) while the desktop can't be seen; still in Low Power Mode; simpler on battery. */
  modeFor(view) {
    const d = this.desk;
    const w = view.wid ? d.windows?.[view.wid] : null;
    const lifted = this.main?.name === 'lifted' && view.display?.id === screen.getPrimaryDisplay().id; // under ARES's own glass
    const hidden = this.suspended || this.screenLocked || d.locked || d.asleep || lifted || (w && (!w.onScreen || w.covered >= COVERED));
    return { paused: Boolean(hidden), still: Boolean(d.lowPower), battery: powerMonitor.isOnBatteryPower() };
  }
  refreshModes() {
    // The ARES window as the desktop paces itself the same way (lifted or as a window, it runs as normal)
    const m = this.main;
    if (m && !m.win.isDestroyed()) {
      const mode = m.name === 'desktop' ? { surface: 'desktop', ...this.modeFor({ wid: m.wid }) }
        : { surface: m.name, paused: false, still: false, battery: powerMonitor.isOnBatteryPower() };
      const key = JSON.stringify(mode);
      if (key !== m.mode) { m.mode = key; m.win.webContents.send('surface-mode', mode); this.emit('main-mode', mode); }
    }
    for (const v of this.views.values()) {
      if (!v.ready) continue;
      const m = this.modeFor(v);
      const key = JSON.stringify(m);
      if (key === v.mode) continue;
      v.mode = key;
      v.win.webContents.send('wp-mode', m);
      this.log('wallpaper mode', { display: v.display.id, ...m });
    }
  }

  /** For measuring: is each wallpaper drawing right now? */
  status() {
    return [...this.views.values()].map((v) => ({ display: v.display.id, wid: v.wid, ...this.modeFor(v), desk: v.wid ? this.desk.windows?.[v.wid] : null }))
      .concat(this.main ? [{ main: this.main.name, wid: this.main.wid, mode: this.main.mode }] : []);
  }

  // ---- Desktop icons ------------------------------------------------------------------------------------------
  // Where the icons are (Finder's scripting interface), re-read when ~/Desktop changes (which includes Finder saving
  // moved positions to its .DS_Store) and every couple of minutes. The ARES window gets the rectangles on its
  // display, in its own coordinates: its panels, brain and orbs keep clear of them.
  watchIcons() {
    if (this.desktopWatch || !this.opts.enabled) return;
    try {
      this.desktopWatch = fs.watch(path.join(os.homedir(), 'Desktop'), () => this.debounce('icons', () => this.refreshIcons(), 1500));
    } catch (err) { this.log('desktop watch failed', err.message); }
    this.iconPoll = setInterval(() => this.refreshIcons(), 120_000);
    this.refreshIcons();
  }
  refreshIcons() {
    if (!this.opts.enabled) return;
    const script = 'JSON.stringify(Application("Finder").desktop.items.desktopPosition())';
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 60_000 }, (err, out, stderr) => {
      // The first time, macOS asks the user to let ARES control Finder (Automation): it waits on that prompt
      if (err) { this.log('desktop icons unavailable', (stderr || err.message).trim().split('\n').pop()); this.debounce('icons', () => this.refreshIcons(), 30_000); return; }
      let points;
      try { points = JSON.parse(out); } catch { return; }
      const key = JSON.stringify(points);
      if (key === this.iconKey) return;
      this.iconKey = key;
      // Each item takes its grid cell: the icon (Finder's icon size, 64 by default) and the label under it
      const size = finderIconSize();
      const half = Math.max(46, size * 0.8), up = size * 0.62, down = size * 0.55 + 32;
      this.icons = points.map((p) => ({ x: p.x - half, y: p.y - up, w: half * 2, h: up + down }));
      this.log('desktop icons', { count: this.icons.length });
      this.sendIcons();
    });
  }
  sendIcons() {
    const m = this.main;
    if (!m || m.win.isDestroyed()) return;
    m.win.webContents.send('desk-icons', this.iconsForMain());
  }
  iconsForMain() {
    const a = screen.getPrimaryDisplay().workArea; // the ARES window's bounds as the desktop (and lifted)
    return this.icons.filter((r) => r.x + r.w > a.x && r.x < a.x + a.width && r.y + r.h > a.y && r.y < a.y + a.height)
      .map((r) => ({ x: Math.round(r.x - a.x), y: Math.round(r.y - a.y), w: Math.round(r.w), h: Math.round(r.h) }));
  }
  /** For the ARES window's page when it loads (messages sent before it was listening would be lost). */
  mainState() { return { mode: this.main?.mode ? JSON.parse(this.main.mode) : null, icons: this.iconsForMain() }; }

  // ---- Lock-screen still ---------------------------------------------------------------------------------------
  /** Switch the ARES lock-screen picture on (asking the first time, and saving the current desktop pictures) or off. */
  async setLockStill(on) {
    if (!on) { await this.restoreOriginal(); this.save({ lockStill: false }); return true; }
    if (!this.opts.lockAsked) {
      const { response } = await dialog.showMessageBox({
        type: 'question', buttons: ['Use the ARES Picture', 'Not Now'], defaultId: 0, cancelId: 1,
        message: 'Set an ARES picture as your desktop picture?',
        detail: 'macOS shows the desktop picture on the lock screen and at login, so this is how ARES appears there. ARES saves your current desktop picture first; “Restore My Original Wallpaper” in the ARES menu (or switching this off) puts it back.',
      });
      this.save({ lockAsked: true });
      if (response !== 0) { this.save({ lockStill: false }); return false; }
    }
    if (!this.opts.original) this.save({ original: await this.helperJson(['wallpaper-get']) });
    this.save({ lockStill: true });
    await this.renderStills();
    return true;
  }

  /** Render the still for each display at its native resolution and make it that display's desktop picture. */
  async renderStills() {
    if (this.rendering) return this.rendering;
    this.rendering = (async () => {
      const dir = path.join(this.supportDir, 'wallpaper');
      fs.mkdirSync(dir, { recursive: true });
      const evening = this.opts.evening && isEvening();
      this.stillTint = evening;
      const screens = await this.helperJson(['wallpaper-get']).catch(() => []);
      for (const d of screen.getAllDisplays()) {
        const png = await this.renderStill(d, evening);
        if (!png) continue;
        // A new name each time: macOS caches desktop pictures by path
        const file = path.join(dir, `ares-${d.id}-${Date.now()}.png`);
        fs.writeFileSync(file, png);
        for (const old of fs.readdirSync(dir)) if (old.startsWith(`ares-${d.id}-`) && path.join(dir, old) !== file) fs.rmSync(path.join(dir, old), { force: true });
        const target = screens.find((s) => s.id === d.id) ? d.id : screens[0]?.id;
        if (target == null) continue;
        const r = await this.helperJson(['wallpaper-set', String(target), file, '3', '1']).catch((err) => ({ ok: false, error: err.message }));
        this.log('lock still', { display: d.id, size: `${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}`, evening, ok: r.ok, error: r.error });
      }
      this.scheduleStill();
    })().finally(() => { this.rendering = null; });
    return this.rendering;
  }

  /** One still: a hidden window the size of the display, rendering the same scene at its scale factor. `kind` overrides the state. */
  renderStill(display, evening, kind = null) {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        ...display.bounds, show: false, frame: false, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(this.appDir, 'wallpaper-preload.js'), contextIsolation: true, backgroundThrottling: false },
      });
      const done = (png) => { clearTimeout(timer); require('electron').ipcMain.removeListener('wp-still', onStill); if (!win.isDestroyed()) win.destroy(); resolve(png); };
      const onStill = (e, dataUrl, error) => {
        if (e.sender !== win.webContents) return;
        if (!dataUrl) { this.log('lock still failed', error); return done(null); }
        done(Buffer.from(dataUrl.split(',')[1], 'base64'));
      };
      require('electron').ipcMain.on('wp-still', onStill);
      const timer = setTimeout(() => { this.log('lock still timed out'); done(null); }, 30_000);
      const look = this.readSettings().look === 'brain' ? 'brain' : 'reactor';
      // The reactor look's still follows the power state (gold offline / blue standby) unless the caption is off; at the window's spot
      const standby = this.power.mode === 'standby' || this.power.mode === 'tostandby';
      const caption = this.opts.caption === 'none' ? 'none' : (kind || (standby ? 'standby' : 'offline'));
      const g = this.geometryFor(display);
      const running = this.jobList.filter((j) => ['running', 'queued', 'approval'].includes(j.status)).length;
      win.loadFile(path.join(this.appDir, 'renderer', 'wallpaper.html'), { query: { mode: 'still', look, caption, geo: `${g.cx},${g.cy},${g.r}`,
        jobs: String(running), link: this.power.status?.link ? '1' : '0', ...(evening ? { tint: 'evening' } : {}) } });
    });
  }

  async restoreOriginal() {
    const original = this.opts.original;
    if (!original?.length) return false;
    for (const s of original) {
      if (!s.url) continue;
      const r = await this.helperJson(['wallpaper-set', String(s.id), s.url, String(s.scaling ?? -1), s.clip ? '1' : '0']).catch((err) => ({ ok: false, error: err.message }));
      this.log('wallpaper restored', { display: s.id, ok: r.ok, error: r.error });
    }
    this.save({ original: null, lockStill: false });
    clearTimeout(this.stillTimer);
    return true;
  }

  /** "Warmer in the evening": re-render when evening starts or ends (checked hourly), if the still is in use. */
  scheduleStill() {
    clearTimeout(this.stillTimer);
    if (!this.opts.lockStill || !this.opts.evening) return;
    this.stillTimer = setTimeout(() => this.maybeRerenderStill(), STILL_EVERY_MS);
  }
  maybeRerenderStill() {
    if (!this.opts.lockStill) return;
    if (this.opts.evening ? isEvening() !== this.stillTint : this.stillTint) this.renderStills();
    else this.scheduleStill();
  }
  setEvening(on) { this.save({ evening: on }); if (this.opts.lockStill) this.renderStills(); }
  setCaption(which) { this.save({ stillCaption: which }); if (this.opts.lockStill) this.renderStills(); }

  // ---- Switches --------------------------------------------------------------------------------------------
  /** The tray's "ARES as Wallpaper". Off = the normal desktop straight away, and the desktop picture restored. */
  async setEnabled(on) {
    this.save({ enabled: on });
    this.sync();
    if (on) {
      if (!this.opts.lockAsked) await this.setLockStill(true);
    } else {
      if (this.opts.lockStill) await this.setLockStill(false);
    }
  }
  setDisplays(which) { this.save({ displays: which }); this.sync(); }
  setClock(on) { this.save({ clock: on }); this.prefs(); }

  // ---- Helpers ---------------------------------------------------------------------------------------------
  helperJson(args) {
    return new Promise((resolve, reject) => execFile(this.helper, args, { timeout: 15_000 }, (err, out) => {
      try { const v = JSON.parse(out); return err && !v ? reject(err) : resolve(v); } catch { reject(err || new Error('bad helper output')); }
    }));
  }
  debounce(key, fn, ms) {
    this.timers ??= {};
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(fn, ms);
  }
}

/** Finder's desktop icon size (Show View Options), best effort. */
function finderIconSize() {
  try {
    const out = require('child_process').execFileSync('plutil', ['-extract', 'DesktopViewSettings.IconViewSettings.iconSize', 'raw', '-o', '-',
      path.join(os.homedir(), 'Library/Preferences/com.apple.finder.plist')], { encoding: 'utf8', timeout: 3000 });
    return Number(out.trim()) || 64;
  } catch { return 64; }
}
const isEvening = () => { const h = new Date().getHours(); return h >= 19 || h < 6; };

module.exports = { Wallpaper };
