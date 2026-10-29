// The ARES dock (docs/ares-theme-prompt.md, part 3b): a launcher overlay at the bottom centre, in every Space, above
// normal windows, click-through except its icons. The Apple Dock stays (auto-hidden; theme.js saves and restores
// that setting) for minimised windows, drag-onto-app and Dock menus.
//
//  - Apps: the pinned list (settings: theme.dock.apps, first taken from the Apple Dock), their running state from
//    native/AresTheme.swift `apps` (NSWorkspace notifications) and the Dock's own badges (Accessibility, if allowed).
//  - Launch / switch: the helper's `activate` (Launch Services, which switches Spaces, then with Accessibility the app
//    made frontmost and its window raised: `open -b` from a background app can be refused focus since macOS 14).
//    Right-click: the app's windows (Accessibility), Hide, Quit. Quit: NSRunningApplication.terminate.
//  - The ARES orb that used to sit in the dock's centre is now the corner orb (orb.js, docs/orb-prompt.md).
// macOS doesn't send mouse moves to a click-through window of an inactive app, so (like surface.js) the pointer is
// checked here: often near the bottom of the screen, rarely elsewhere.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BrowserWindow, screen, Menu, shell, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const { run, parse } = require('./theme-prefs');

const HEIGHT = 190;          // the window: the icons, the lift, and the name above
const NEAR = 240;            // px from the bottom where the pointer is watched closely
const HIDE_MS = 700;         // edge reveal: hide this long after the pointer leaves

class Dock {
  constructor({ dir, helper, log, appDir, readOpts, saveOpts, onSummon, onAccessibility, onFront }) {
    Object.assign(this, { helper, log, appDir, readOpts, saveOpts, onSummon, onAccessibility, onFront });
    this.dir = path.join(dir, 'dock');
    this.win = null;
    this.apps = [];               // [{ path, id, name }]
    this.running = new Set();
    this.front = '';
    this.badges = {};
    this.hits = [];
    this.interactive = false;
    this.revealed = false;
    this.ready = false;
  }

  // ---- Lifecycle ----------------------------------------------------------------------------------------------
  async start() {
    if (this.win) return;
    fs.mkdirSync(this.dir, { recursive: true });
    await this.loadApps();
    const d = screen.getPrimaryDisplay();
    this.win = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y + d.bounds.height - HEIGHT, width: d.bounds.width, height: HEIGHT,
      type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, fullscreenable: false, acceptFirstMouse: true, show: false, enableLargerThanScreen: true,
      webPreferences: { preload: path.join(this.appDir, 'theme-preload.js'), contextIsolation: true, backgroundThrottling: true },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.win.setHiddenInMissionControl?.(true);
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.loadFile(path.join(this.appDir, 'renderer', 'theme-dock.html'));
    this.win.once('ready-to-show', () => this.win?.showInactive());
    this.onIpc = (ch, fn) => { const h = (e, m) => { if (this.win && e.sender === this.win.webContents) fn(m); }; ipcMain.on(ch, h); (this.ipc ??= []).push([ch, h]); };
    this.onIpc('theme-ready', () => { this.ready = true; this.push(); });
    this.onIpc('theme-hits', (h) => { this.hits = Array.isArray(h) ? h : []; this.check(); });
    this.onIpc('theme-dock-act', (a) => this.act(a));
    this.onDisplays = () => this.place();
    for (const e of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(e, this.onDisplays);
    this.watchApps();
    this.tick();
  }
  stop() {
    clearTimeout(this.timer); this.timer = null;
    clearInterval(this.badgeTimer);
    for (const [ch, h] of this.ipc || []) ipcMain.removeListener(ch, h);
    this.ipc = [];
    if (this.onDisplays) for (const e of ['display-metrics-changed', 'display-added', 'display-removed']) screen.removeListener(e, this.onDisplays);
    const w = this.apps$; this.apps$ = null; w?.kill();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
  }
  place() {
    if (!this.win) return;
    const d = screen.getPrimaryDisplay();
    this.win.setBounds({ x: d.bounds.x, y: d.bounds.y + d.bounds.height - HEIGHT, width: d.bounds.width, height: HEIGHT });
  }
  send(msg) { if (this.win && this.ready && !this.win.isDestroyed()) this.win.webContents.send('theme-dock', msg); }
  push() {
    const o = this.readOpts();
    const withIcon = (a) => ({ ...a, icon: this.iconUrl(a) });
    this.send({ type: 'apps', apps: this.apps.map(withIcon), folders: this.folders().map(withIcon) });
    this.send({ type: 'prefs', icons: o.icons, reveal: o.reveal });
    this.send({ type: 'running', running: [...this.running], front: this.front, badges: this.badges });
    this.send({ type: 'reveal', on: o.reveal === 'always' || this.revealed });
  }

  // ---- Apps ---------------------------------------------------------------------------------------------------
  /** The pinned apps: from settings, or the first time from the Apple Dock's own list. */
  async loadApps() {
    let paths = this.readOpts().apps;
    if (!paths?.length) {
      const out = await run('/usr/bin/defaults', ['read', 'com.apple.dock', 'persistent-apps']).catch(() => '');
      paths = [...out.matchAll(/"_CFURLString" = "(file:\/\/[^"]+)"/g)].map((m) => decodeURIComponent(new URL(m[1]).pathname).replace(/\/$/, ''));
      paths = paths.filter((p) => !/\/Apps\.app$|\/Launchpad\.app$/.test(p)); // the app launcher itself
      this.saveOpts({ apps: paths });
    }
    const apps = [];
    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const plist = path.join(p, 'Contents', 'Info.plist');
      const id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]).catch(() => '')).trim();
      const name = (await run('/usr/bin/plutil', ['-extract', 'CFBundleDisplayName', 'raw', '-o', '-', plist]).catch(() => '')).trim()
        || path.basename(p, '.app');
      if (id) apps.push({ path: p, id, name });
    }
    this.apps = apps;
    await this.cacheIcons();
  }
  iconFile(a) { return path.join(this.dir, `${a.id}.png`); }
  async cacheIcons() {
    const missing = [...this.apps, ...this.folders()].filter((a) => !fs.existsSync(this.iconFile(a)));
    for (const a of missing) await run(this.helper, ['app-icon', '128', this.iconFile(a), a.path]).catch(() => {});
  }
  iconUrl(a) {
    try { return `data:image/png;base64,${fs.readFileSync(this.iconFile(a)).toString('base64')}`; } catch { return ''; }
  }
  folders() {
    return [
      { id: 'folder.downloads', name: 'Downloads', path: path.join(os.homedir(), 'Downloads'), kind: 'folder' },
      { id: 'folder.trash', name: 'Trash', path: path.join(os.homedir(), '.Trash'), kind: 'trash' },
    ];
  }

  watchApps() {
    if (this.apps$ || !fs.existsSync(this.helper)) return;
    const p = spawn(this.helper, ['apps'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.apps$ = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.running) {
          this.running = new Set(m.running);
          if (m.front && m.front !== this.front) this.onFront?.(m.front);
          this.front = m.front;
          this.send({ type: 'running', running: m.running, front: m.front, badges: this.badges });
          this.askBadges();
        }
        if (m.badges) { this.badges = m.badges; this.send({ type: 'running', running: [...this.running], front: this.front, badges: m.badges }); }
      }
    });
    p.on('exit', () => { if (this.apps$ === p) { this.apps$ = null; if (this.win) setTimeout(() => this.watchApps(), 3000); } });
    // Badges change without any notification: re-read them now and then, only while the dock can be seen
    this.badgeTimer = setInterval(() => { if (this.revealed || this.readOpts().reveal === 'always') this.askBadges(); }, 30_000);
  }
  askBadges() { try { this.apps$?.stdin.write('badges\n'); } catch {} }

  async act(a) {
    if (!a || typeof a !== 'object') return;
    const item = [...this.apps, ...this.folders()].find((x) => x.id === a.id);
    if (a.type === 'summon') return this.onSummon();
    if (!item) return;
    if (a.type === 'open') {
      if (item.kind === 'trash') return execFile('/usr/bin/osascript', ['-e', 'tell application "Finder"\nopen trash\nactivate\nend tell'], () => {});
      if (item.kind === 'folder') return shell.openPath(item.path);
      return run(this.helper, ['activate', item.id, item.path]).catch((err) => {
        this.log('dock activate failed', { app: item.id, error: err.stderr || err.message });
        execFile('/usr/bin/open', ['-b', item.id], () => {});
      });
    }
    if (a.type === 'menu') {
      const running = this.running.has(item.id);
      let wins = { trusted: true, windows: [] };
      if (!item.kind && running) wins = await run(this.helper, ['windows', item.id]).then(parse(wins), () => wins);
      const helper = (args) => run(this.helper, args).catch(() => {});
      Menu.buildFromTemplate([
        ...wins.windows.map((w) => ({ label: `${w.min ? '◦ ' : ''}${w.title || item.name}`, click: () => helper(['raise', item.id, String(w.i)]) })),
        ...(!wins.trusted ? [{ label: 'Show Windows: Allow Accessibility for ARES…', click: () => this.onAccessibility?.() }] : []),
        { type: 'separator', visible: wins.windows.length > 0 || !wins.trusted },
        { label: item.kind ? `Open ${item.name}` : running ? `Show ${item.name}` : `Open ${item.name}`, click: () => this.act({ type: 'open', id: item.id }) },
        { label: 'Show in Finder', visible: item.kind !== 'trash', click: () => shell.showItemInFolder(item.path) },
        { type: 'separator', visible: !item.kind && running },
        { label: `Hide ${item.name}`, visible: !item.kind && running, click: () => helper(['hide', item.id]) },
        { label: `Quit ${item.name}`, visible: !item.kind && running, click: () => helper(['quit', item.id]) },
      ]).popup({ window: this.win });
    }
  }

  // ---- The pointer: hit-testing, edge reveal, hover ----------------------------------------------------------------
  tick() {
    if (!this.win) return;
    const near = this.check();
    this.timer = setTimeout(() => this.tick(), near ? 50 : 250);
  }
  /** Returns whether the pointer is near the dock (so it's checked often). */
  check() {
    if (!this.win || this.win.isDestroyed()) return false;
    const p = screen.getCursorScreenPoint(), b = this.win.getBounds();
    const d = screen.getPrimaryDisplay().bounds;
    const x = p.x - b.x, y = p.y - b.y;
    const near = p.x >= d.x && p.x < d.x + d.width && p.y > d.y + d.height - NEAR;
    const o = this.readOpts();
    if (o.reveal !== 'always') {
      const atEdge = p.y >= d.y + d.height - 2 && p.x >= d.x && p.x < d.x + d.width;
      const overDock = y > HEIGHT - 120 && x >= 0 && x <= b.width && this.hits.some((r) => x >= r.x - 40 && x <= r.x + r.w + 40);
      if (atEdge && !this.revealed) { this.revealed = true; this.send({ type: 'reveal', on: true }); this.askBadges(); }
      if (this.revealed && (atEdge || overDock)) this.leftAt = 0;
      else if (this.revealed) {
        this.leftAt ||= Date.now();
        if (Date.now() - this.leftAt > HIDE_MS) { this.revealed = false; this.leftAt = 0; this.send({ type: 'reveal', on: false }); }
      }
    }
    const over = this.hits.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (over !== this.interactive) { this.interactive = over; this.win.setIgnoreMouseEvents(!over, { forward: true }); }
    if (near) this.send({ type: 'pointer', x, y });
    else if (this.wasNear) this.send({ type: 'pointer', x: -1, y: -1 });
    this.wasNear = near;
    return near;
  }

  // ---- From theme.js ------------------------------------------------------------------------------------------
  prefs() { this.push(); }
  async reloadApps() { await this.loadApps(); this.push(); }
}

module.exports = { Dock };
