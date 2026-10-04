// The ARES OS theme (docs/ares-theme-prompt.md): the whole Mac in ARES's look, behind one ◉ menu switch.
//
//   system look   dark mode, accent + highlight colour, pointer colour, an ARES alert sound, Apple Dock and menu bar
//                 auto-hide, Finder's desktop grid: supported settings only (System Events, CFPreferences)
//   theme-bar.js      the ARES menu bar (SketchyBar) and the focused-window glow (JankyBorders), live-fed by ARES
//   theme-dock.js     the ARES dock overlay, with the orb while the wallpaper brain is hidden
//   theme-icons.js    ARES icons on the Desktop's items and chosen folders
//   theme-notify.js   ARES's own alerts as FRIDAY panels at the top-right
//   theme-apps.js     Terminal / VS Code / Chrome colour themes
//
// Every original is saved before anything changes (theme-prefs.js); switching the theme off restores them all, then
// reads each one back and compares (a report is kept in <support>/theme/last-restore.json). ARES asks before the
// first apply.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { dialog, shell } = require('electron');
const { Originals, run, osa } = require('./theme-prefs');
const { Bar } = require('./theme-bar');
const { Dock } = require('./theme-dock');
const { Icons } = require('./theme-icons');
const { Notify } = require('./theme-notify');
const { AppThemes } = require('./theme-apps');

const SE = (what) => `tell application "System Events" to tell ${what}`;
// Flipped through System Events (so the change shows at once); the preference keys underneath are saved too and
// written back after, so a restore leaves them byte for byte as they were (absent stays absent)
const SCRIPTS = {
  dark: { get: `${SE('appearance preferences')} to get dark mode`, set: `${SE('appearance preferences')} to set dark mode to %s`, prefs: [['-g', 'AppleInterfaceStyle']] },
  dockAutohide: { get: `${SE('dock preferences')} to get autohide`, set: `${SE('dock preferences')} to set autohide to %s`, prefs: [['com.apple.dock', 'autohide']] },
  dockMagnify: { get: `${SE('dock preferences')} to get magnification`, set: `${SE('dock preferences')} to set magnification to %s`, prefs: [['com.apple.dock', 'magnification']] },
  menubar: { get: `${SE('dock preferences')} to get autohide menu bar`, set: `${SE('dock preferences')} to set autohide menu bar to %s`,
    prefs: [['-g', '_HIHideMenuBar'], ['-g', 'AppleMenuBarVisibleInFullscreen']] },
};
const CYAN_HIGHLIGHT = '0.243137 0.901961 1.000000 Other';
const SOUND = path.join(os.homedir(), 'Library', 'Sounds', 'ARES.aiff');

class Theme {
  /**
   * @param {object} o
   * @param {string} o.supportDir  @param {string} o.appDir  @param {string} o.helper  path to ares-theme
   * @param {(…) => void} o.log  @param {() => object} o.readSettings  @param {(p: object) => void} o.writeSettings
   * @param {(view: string) => void} o.onOpen   open an ARES view: 'summon' | 'work' | 'status' | 'call' | 'job:<id>'
   * @param {() => boolean} o.brainVisible  is the wallpaper brain on screen right now
   */
  constructor(o) {
    Object.assign(this, o);
    this.dir = path.join(o.supportDir, 'theme');
    this.originals = new Originals({ dir: this.dir, helper: o.helper, log: o.log });
    this.token = crypto.randomBytes(16).toString('hex');
    this.bar = new Bar({ log: o.log, url: () => this.clickUrl });
    this.dock = new Dock({ dir: this.dir, helper: o.helper, log: o.log, appDir: o.appDir, onSummon: () => o.onOpen('summon'),
      readOpts: () => this.opts.dock, saveOpts: (p) => this.save({ dock: { ...this.opts.dock, ...p } }) });
    this.icons = new Icons({ dir: this.dir, helper: o.helper, originals: this.originals, log: o.log, appDir: o.appDir });
    this.notify = new Notify({ helper: o.helper, log: o.log, appDir: o.appDir, onAct: (a) => this.act(a) });
    this.apps = new AppThemes({ dir: this.dir, helper: o.helper, originals: this.originals, log: o.log });
    this.live = false;
    this.summoned = false;
  }

  // ---- Settings ----------------------------------------------------------------------------------------------
  get opts() {
    const t = this.readSettings().theme || {};
    return {
      enabled: Boolean(t.enabled), asked: Boolean(t.asked), stacks: Boolean(t.stacks), notifications: t.notifications !== false,
      dock: { icons: 'glyphs', reveal: 'edge', apps: null, ...(t.dock || {}) },
      folders: t.folders || ['Documents', 'Downloads', 'My AI'].map((f) => path.join(os.homedir(), f)),
      apps: { terminal: true, vscode: true, chrome: true, ...(t.apps || {}) },
      pointerManual: Boolean(t.pointerManual),
    };
  }
  save(patch) { this.writeSettings({ theme: { ...(this.readSettings().theme || {}), ...patch } }); }

  // ---- Start / stop --------------------------------------------------------------------------------------------
  /** At launch: if the theme is on, bring up its live parts (the settings themselves persist on their own). Switched on
   *  but never applied (turned on in settings.json): apply it now. */
  async start() {
    if (!this.opts.enabled) return;
    if (!this.readSettings().theme?.applied) await this.apply();
    else await this.startLive();
  }
  async startLive() {
    if (this.live) return;
    this.live = true;
    await this.serve();
    if (!this.live) return; // switched off meanwhile
    if (this.bar.installed) { this.bar.start(); this.bar.startBorders(); }
    else this.log('theme: SketchyBar/JankyBorders not installed (brew install felixkratz/formulae/sketchybar felixkratz/formulae/borders)');
    await this.dock.start();
    if (!this.live) { this.dock.stop(); return; }
    if (this.opts.notifications) this.notify.start();
    this.icons.watch();
    this.updateOrb();
  }
  stopLive({ quitting = false } = {}) {
    if (!this.live) return;
    this.live = false;
    if (quitting) this.bar.offline(); // the bar stays as the menu bar, saying ARES is offline
    else { this.bar.stop(); this.bar.stopBorders(); }
    this.dock.stop();
    this.notify.stop();
    this.icons.unwatch();
    this.server?.close();
    this.server = null;
  }
  /** ARES is quitting: the windows go; the bar and the glow stay (they're the Mac's look), the bar says offline. */
  quit() { this.stopLive({ quitting: true }); }

  // ---- The switch ----------------------------------------------------------------------------------------------
  async setEnabled(on) {
    if (on) {
      if (!this.opts.asked) {
        const { response } = await dialog.showMessageBox({
          type: 'question', buttons: ['Apply the ARES Theme', 'Not Now'], defaultId: 0, cancelId: 1,
          message: 'Make the whole Mac look like ARES?',
          detail: [
            'ARES saves your current settings first. Turning “ARES Theme” off in the ◉ menu puts every one of them back.',
            '',
            '• Dark mode, a cyan accent, highlight and pointer, and an ARES alert sound',
            '• The ARES menu bar (SketchyBar) with the macOS menu bar set to auto-hide',
            '• A cyan glow around the focused window (JankyBorders)',
            '• The ARES dock (the Apple Dock stays, auto-hidden, with a short delay)',
            '• ARES icons on your Desktop items, Documents, Downloads and My AI',
            '• Finder\'s desktop grid tidied (Finder restarts once)',
            '• ARES alerts as panels at the top-right',
            '• ARES colours for Terminal and VS Code, and a Chrome theme folder to load',
          ].join('\n'),
        });
        this.save({ asked: true });
        if (response !== 0) return false;
      }
      this.save({ enabled: true });
      await this.apply();
      return true;
    }
    this.save({ enabled: false });
    const report = await this.restore();
    this.save({ applied: false });
    return report;
  }

  // ---- Apply ---------------------------------------------------------------------------------------------------
  async apply() {
    const o = this.opts;
    const results = {};
    const step = async (name, fn) => {
      try { results[name] = (await fn()) !== false; } catch (err) { results[name] = false; this.log('theme apply failed', { step: name, error: err.stderr || err.message }); }
    };
    // 1. System look
    await step('dark', () => this.script('dark', 'true'));
    await step('accent', async () => {
      const a = await this.originals.setPref('-g', 'AppleAccentColor', 4); // blue: the nearest of macOS's accents to ARES cyan
      const h = await this.originals.setPref('-g', 'AppleHighlightColor', CYAN_HIGHLIGHT);
      await run(this.helper, ['appearance-changed']).catch(() => {});
      return a && h;
    });
    await step('pointer', () => this.pointer());
    await step('sound', () => this.sound());
    await step('dock', async () => {
      await this.script('dockAutohide', 'true');
      await this.script('dockMagnify', 'false');
      // The ARES dock appears at once at the bottom edge; the Apple Dock after a short dwell (or ⌥⌘D)
      const ok = await this.originals.setPref('com.apple.dock', 'autohide-delay', { real: 1.2 });
      await run('/usr/bin/killall', ['Dock']).catch(() => {});
      return ok;
    });
    await step('menubar', () => (this.bar.installed ? this.script('menubar', 'true') : false));
    await step('finder', () => this.finder());
    // 4. Icons
    await step('icons', async () => (await this.icons.apply(o.folders)).failed === 0);
    // 6. App themes
    if (o.apps.terminal) await step('terminal', () => this.apps.terminal());
    if (o.apps.vscode) await step('vscode', () => this.apps.vscode());
    if (o.apps.chrome) await step('chrome', () => { this.apps.chrome(); return true; });
    this.save({ applied: true });
    await this.startLive();
    this.log('theme applied', results);
    this.lastApply = results;
    return results;
  }

  async script(name, value) {
    const s = SCRIPTS[name];
    for (const [d, k] of s.prefs) await this.originals.keepPref(d, k); // saved first, so restored after the script
    await this.originals.setScript(`script:${name}`, s, value);
  }

  /** The pointer: cyan outline, dark fill (Accessibility → Display → Pointer). */
  async pointer() {
    const c = (r, g, b) => ({ red: { real: r }, green: { real: g }, blue: { real: b }, alpha: { real: 1 } });
    const ok = (await this.originals.setPref('com.apple.universalaccess', 'cursorOutline', c(0.243137, 0.901961, 1)))
      && (await this.originals.setPref('com.apple.universalaccess', 'cursorFill', c(0.02, 0.05, 0.08)))
      && (await this.originals.setPref('com.apple.universalaccess', 'cursorIsCustomized', true));
    if (!ok) {
      // macOS keeps Accessibility settings to itself: the user sets these two colours in System Settings
      for (const k of ['cursorOutline', 'cursorFill', 'cursorIsCustomized']) this.originals.forget(`pref:com.apple.universalaccess:${k}`);
      this.save({ pointerManual: true });
    }
    return ok;
  }

  /** A short ARES chime (generated here) as the alert sound. */
  async sound() {
    this.originals.keepFile('file:sound', SOUND);
    fs.mkdirSync(path.dirname(SOUND), { recursive: true });
    const wav = path.join(this.dir, 'ares-chime.wav');
    fs.writeFileSync(wav, chime());
    await run('/usr/bin/afconvert', ['-f', 'AIFF', '-d', 'BEI16', wav, SOUND]);
    return this.originals.setPref('-g', 'com.apple.sound.beep.sound', SOUND);
  }

  /** Finder's desktop: snap to a slightly wider grid; Stacks if chosen. */
  async finder() {
    const cur = await this.originals.readPref('com.apple.finder', 'DesktopViewSettings');
    const dict = cur.exists ? parsePlist(Buffer.from(cur.plist, 'base64').toString('utf8')) : {};
    const icons = { ...(dict.IconViewSettings || {}) };
    Object.assign(icons, { arrangeBy: 'grid', gridSpacing: { real: 62 }, iconSize: { real: 64 }, textSize: { real: 11 }, labelOnBottom: true });
    const next = { ...dict, IconViewSettings: icons, GroupBy: this.opts.stacks ? 'Kind' : (dict.GroupBy || 'None') };
    const ok = await this.originals.setPref('com.apple.finder', 'DesktopViewSettings', next);
    await run('/usr/bin/killall', ['Finder']).catch(() => {});
    return ok;
  }
  async setStacks(on) {
    this.save({ stacks: on });
    if (this.opts.enabled) await this.finder();
  }

  // ---- Restore -------------------------------------------------------------------------------------------------
  /** Everything back as it was, then each saved original read back and compared. */
  async restore() {
    this.stopLive();
    this.bar.stop(); this.bar.stopBorders(); // also a bar and glow left running by an earlier ARES
    this.bar.removeFiles();
    const saved = JSON.parse(JSON.stringify(this.originals.data));
    const iconFails = await this.icons.restore();
    const terminalDefault = saved['pref:com.apple.Terminal:Default Window Settings'];
    const failed = await this.originals.restore('', {
      termprofile: (r) => this.apps.restoreTerminal(r),
      vscodeext: (r) => this.apps.restoreVscode(r),
      vscodetheme: (r) => this.apps.restoreVscode(r),
    });
    await run(this.helper, ['appearance-changed']).catch(() => {});
    if (Object.keys(saved).some((k) => k.startsWith('pref:com.apple.dock:') || k.startsWith('script:dock'))) await run('/usr/bin/killall', ['Dock']).catch(() => {});
    if (saved['pref:com.apple.finder:DesktopViewSettings']) await run('/usr/bin/killall', ['Finder']).catch(() => {});
    if (terminalDefault) {
      const name = (r) => (r?.exists ? /<string>([^<]*)<\/string>/.exec(Buffer.from(r.plist, 'base64').toString())?.[1] : null);
      await this.apps.terminalLive(name(terminalDefault), name(saved['pref:com.apple.Terminal:Startup Window Settings']));
    }
    const report = await this.verify(saved);
    report.failed = [...iconFails, ...failed];
    fs.writeFileSync(path.join(this.dir, 'last-restore.json'), JSON.stringify({ at: new Date().toISOString(), ...report }, null, 1));
    this.log('theme restored', { checked: report.checked, mismatched: report.mismatched.length, failed: report.failed.length });
    return report;
  }
  /** Compare what's there now with every saved original. */
  async verify(saved) {
    const mismatched = [];
    let checked = 0;
    for (const [id, rec] of Object.entries(saved)) {
      checked++;
      try {
        if (rec.kind === 'pref') {
          const now = await this.originals.readPref(rec.domain, rec.key);
          const norm = (b64) => (b64 ? Buffer.from(b64, 'base64').toString().replace(/\s+/g, '') : null);
          if (now.exists !== rec.exists || (rec.exists && norm(now.plist) !== norm(rec.plist))) mismatched.push(id);
        } else if (rec.kind === 'script') {
          if ((await osa(rec.get)) !== rec.value) mismatched.push(id);
        } else if (rec.kind === 'file') {
          const there = fs.existsSync(rec.path);
          if (there !== rec.existed || (there && fs.readFileSync(rec.path).toString('base64') !== rec.content)) mismatched.push(id);
        } else if (rec.kind === 'icon') {
          if (!fs.existsSync(rec.path)) continue;
          const now = await this.icons.snapshot(rec.path);
          if (now.info !== rec.info || JSON.stringify(now.iconFile) !== JSON.stringify(rec.iconFile)) mismatched.push(id);
        }
      } catch { mismatched.push(id); }
    }
    return { checked, mismatched };
  }

  // ---- Live feed from ARES -------------------------------------------------------------------------------------
  scene(msg) {
    if (!this.live) return;
    if (msg.type === 'state') this.bar.voice(msg.state);
    else if (msg.type === 'level') this.bar.level(msg.v || 0);
    else if (msg.type === 'attention') this.bar.attention(msg.on);
    this.dock.scene(msg);
  }
  status(s) { if (s && typeof s === 'object') { this.lastStatus = s; if (this.live) this.bar.status({ ok: Boolean(s.ok), text: String(s.text || '') }); } }
  jobs(list) {
    const working = list.filter((j) => ['running', 'queued'].includes(j.status)).length;
    const approval = list.filter((j) => j.status === 'approval').length;
    if (this.live) this.bar.jobs({ working, approval });
    else this.bar.state.jobs = { working, approval };
  }
  call(c) { if (this.live) this.bar.call(c); else this.bar.state.call = c; }
  weather(w) { const t = w?.text || ''; if (this.live) this.bar.weather(t); else this.bar.state.weather = t; }
  /** Where the ARES window is (surface.js) and what the desktop helper sees: the orb shows only while the brain doesn't. */
  surface(name) { this.summoned = name === 'lifted' || name === 'window'; this.updateOrb(); }
  updateOrb() { if (this.live) this.dock.setOrb(!this.summoned && !this.brainVisible()); }

  /** One of ARES's alerts, as a panel at the top-right (not while ARES itself is up in front). */
  toast(t) {
    if (!this.live || !this.opts.notifications || this.summoned) return false;
    this.notify.show(t);
    return true;
  }
  act(a) {
    if (a.type === 'job') return this.onOpen(`job:${a.id}`);
    this.onOpen(a.type === 'summon' ? 'summon' : a.type);
  }

  // ---- Clicks from the menu bar --------------------------------------------------------------------------------
  get clickUrl() { return this.server ? `http://127.0.0.1:${this.server.address().port}/${this.token}` : 'http://127.0.0.1:9/none'; }
  serve() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const [token, what] = u.pathname.split('/').filter(Boolean);
        if (token !== this.token || what !== 'open') { res.writeHead(404); return res.end(); }
        const view = u.searchParams.get('view') || 'summon';
        if (['summon', 'work', 'status', 'call'].includes(view)) this.onOpen(view);
        res.writeHead(204); res.end();
      });
      server.listen(0, '127.0.0.1', () => { this.server = server; resolve(); });
    });
  }

  // ---- The ◉ menu ---------------------------------------------------------------------------------------------
  menu(refresh) {
    const o = this.opts;
    const act = (fn) => async (item) => { await fn(item); refresh(); };
    const dockSet = (p) => act(async () => { this.save({ dock: { ...this.opts.dock, ...p } }); this.dock.prefs(); });
    return [
      { label: 'ARES Theme', type: 'checkbox', checked: o.enabled, click: act(async (item) => {
        const r = await this.setEnabled(item.checked);
        if (!item.checked && r?.mismatched) this.restoreNotice(r);
      }) },
      { label: 'ARES Theme Options', submenu: [
        { label: 'Dock Icons: ARES Glyphs', type: 'radio', checked: o.dock.icons !== 'real', click: dockSet({ icons: 'glyphs' }) },
        { label: 'Dock Icons: Real App Icons', type: 'radio', checked: o.dock.icons === 'real', click: dockSet({ icons: 'real' }) },
        { type: 'separator' },
        { label: 'Dock: Show at the Bottom Edge', type: 'radio', checked: o.dock.reveal !== 'always', click: dockSet({ reveal: 'edge' }) },
        { label: 'Dock: Always Visible', type: 'radio', checked: o.dock.reveal === 'always', click: dockSet({ reveal: 'always' }) },
        { label: 'Choose Dock Apps…', click: act(() => this.chooseApps()) },
        { type: 'separator' },
        { label: 'Use Stacks on the Desktop', type: 'checkbox', checked: o.stacks, click: act((item) => this.setStacks(item.checked)) },
        { label: 'ARES Notifications', type: 'checkbox', checked: o.notifications, click: act((item) => {
          this.save({ notifications: item.checked });
          if (this.live) { if (item.checked) this.notify.start(); else this.notify.stop(); }
        }) },
        { type: 'separator' },
        { label: 'Set the Pointer Colour…', visible: o.pointerManual, click: () => this.pointerHelp() },
        { label: 'Dock Badges Need Accessibility…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
        { label: 'Focus Detection Needs Full Disk Access…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles') },
        { label: 'Load the Chrome Theme…', visible: o.apps.chrome, click: () => this.chromeHelp() },
        { label: 'Test an ARES Notification', enabled: this.live, click: () => this.notify.show({ kind: 'work', label: 'TEST', tag: 'ARES', value: 'This is how ARES alerts look.', detail: 'Click to open ARES.' }) },
      ] },
    ];
  }
  async chooseApps() {
    const { filePaths } = await dialog.showOpenDialog({ title: 'Apps for the ARES dock', defaultPath: '/Applications', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Apps', extensions: ['app'] }] });
    if (!filePaths?.length) return;
    this.save({ dock: { ...this.opts.dock, apps: filePaths } });
    if (this.live) await this.dock.reloadApps();
  }
  pointerHelp() {
    shell.openExternal('x-apple.systempreferences:com.apple.Accessibility-Settings.extension?Display');
    dialog.showMessageBox({ type: 'info', message: 'Set the pointer colour in System Settings', detail: 'macOS only lets you change this yourself. In Accessibility → Display → Pointer, set Pointer outline colour to cyan (#3EE6FF) and Pointer fill colour to near-black (#050D14). “Reset” there puts back the default.' });
  }
  chromeHelp() {
    const dir = this.apps.chrome();
    shell.showItemInFolder(path.join(dir, 'manifest.json'));
    dialog.showMessageBox({ type: 'info', message: 'Load the ARES theme in Chrome', detail: `Chrome lets only you add a theme. Open chrome://extensions, switch on Developer mode, click “Load unpacked” and pick the folder that just opened:\n${dir}\n\nTo remove it later: Chrome Settings → Appearance → Reset to default.` });
  }
  restoreNotice(r) {
    if (!r.mismatched.length && !r.failed.length) return;
    dialog.showMessageBox({ type: 'warning', message: 'Most of your setup is back, but not all of it', detail: `These didn't come back exactly:\n${[...new Set([...r.mismatched, ...r.failed])].join('\n')}\n\nDetails: ${path.join(this.dir, 'last-restore.json')}` });
  }

  /** Development only (ARES_TEST_THEME=dock,notify,art,bar): bring up parts of the theme without changing any setting. */
  async test(parts) {
    if (parts.includes('apply')) { this.save({ asked: true, enabled: true }); this.log('theme test apply', await this.apply()); return; }
    if (parts.includes('restore')) { this.save({ enabled: false }); this.log('theme test restore', await this.restore()); return; }
    await this.serve();
    this.live = true;
    if (parts.includes('bar')) this.log('theme test bar config', this.bar.writeConfig());
    if (parts.includes('art')) this.log('theme test art', await this.icons.art(), this.icons.dir);
    if (parts.includes('dock')) { await this.dock.start(); this.updateOrb(); }
    if (parts.includes('notify')) {
      this.notify.start();
      setTimeout(() => this.notify.show({ kind: 'work', label: 'JOB DONE', tag: 'WORK', value: 'Competitor report', detail: 'Three new listings this week, prices down 4%.' }), 2500);
      setTimeout(() => this.notify.show({ kind: 'needs', label: 'NEEDS YOUR OK', tag: 'WORK', value: 'Send the summary email', detail: 'It wants to email the report to the team.', urgent: true }), 4000);
      setTimeout(() => this.notify.show({ kind: 'call', label: 'CALLS', tag: 'ARES LINE', value: 'Sam called about Friday.', detail: 'Wants to move dinner to 8.' }), 5500);
    }
  }

  /** For testing over CDP. */
  info() { return { enabled: this.opts.enabled, live: this.live, originals: this.originals.ids.length, lastApply: this.lastApply || null }; }
}

/** The ARES chime: two soft bell tones a fifth apart, rising (a 16-bit mono WAV). */
function chime() {
  const rate = 44100, len = Math.round(rate * 0.62);
  const data = Buffer.alloc(44 + len * 2);
  const notes = [{ f: 987.77, at: 0, amp: 0.42 }, { f: 1479.98, at: 0.085, amp: 0.36 }];
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    let s = 0;
    for (const n of notes) {
      const u = t - n.at;
      if (u < 0) continue;
      const env = Math.min(1, u / 0.004) * Math.exp(-u * 7.5);
      s += n.amp * env * (Math.sin(2 * Math.PI * n.f * u) + 0.32 * Math.sin(2 * Math.PI * n.f * 2.01 * u) * Math.exp(-u * 9) + 0.12 * Math.sin(2 * Math.PI * n.f * 3.98 * u) * Math.exp(-u * 16));
    }
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * 0.85)) * 32767), 44 + i * 2);
  }
  data.write('RIFF', 0); data.writeUInt32LE(36 + len * 2, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(len * 2, 40);
  return data;
}

/** A small XML plist reader (dict, array, string, integer, real, true/false): reals stay reals ({ real }). */
function parsePlist(xml) {
  const tokens = xml.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<\/?plist[^>]*>/g, '').match(/<[^>]+>|[^<]+/g).map((t) => t.trim()).filter(Boolean);
  let i = 0;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const value = () => {
    const t = tokens[i++];
    if (t === '<dict>') { const o = {}; while (tokens[i] !== '</dict>') { const k = unesc(tokens[i + 1]); i += 3; o[k] = value(); } i++; return o; }
    if (t === '<dict/>') return {};
    if (t === '<array>') { const a = []; while (tokens[i] !== '</array>') a.push(value()); i++; return a; }
    if (t === '<array/>') return [];
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string/>') return '';
    if (t === '<string>' || t === '<integer>' || t === '<real>') {
      let body = '';
      if (!tokens[i].startsWith('</')) body = tokens[i++];
      i++;
      if (t === '<integer>') return Number(body);
      if (t === '<real>') return { real: Number(body) };
      return unesc(body);
    }
    throw new Error(`unsupported plist element ${t}`);
  };
  return value();
}

module.exports = { Theme, chime, parsePlist };
