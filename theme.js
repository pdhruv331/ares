// The ARES OS theme (docs/ares-theme-prompt.md): the whole Mac in ARES's look, behind one ◉ menu switch.
//
//   system look   dark mode, accent + highlight colour, pointer colour, an ARES alert sound, Apple Dock and menu bar
//                 auto-hide, Finder's desktop grid: supported settings only (System Events, CFPreferences)
//   theme-bar.js      the ARES menu bar (SketchyBar) and the focused-window glow (JankyBorders), live-fed by ARES
//   theme-dock.js     the ARES dock overlay (the orb that sat in it is orb.js, the corner orb, now)
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
const { Originals, run, osa, plist, parse } = require('./theme-prefs');
const { Bar, MENUS } = require('./theme-bar');
const { Dock } = require('./theme-dock');
const { Icons } = require('./theme-icons');
const { Notify } = require('./theme-notify');
const { AppThemes } = require('./theme-apps');
const { Drop } = require('./theme-drop');

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
const ARES_MENUS = ['ares', 'listen', 'voice', 'work', 'view', 'phone']; // the bar's titles while ARES is in front
const DROPS = ['status', 'work']; // the bar items whose drop-downs ARES draws herself (theme-drop.js)
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class Theme {
  /**
   * @param {object} o
   * @param {string} o.supportDir  @param {string} o.appDir  @param {string} o.helper  path to ares-theme
   * @param {(…) => void} o.log  @param {() => object} o.readSettings  @param {(p: object) => void} o.writeSettings
   * @param {(view: string) => void} o.onOpen   open an ARES view: 'summon' | 'work' | 'status' | 'call' | 'job:<id>'
   * @param {() => boolean} o.brainVisible  is the wallpaper brain on screen right now
   * @param {(refresh: () => void) => object[]} [o.orbMenu]  the corner orb's lines for Theme Options (orb.js)
   * @param {() => object} o.menuSections  ARES's menus as Electron menu templates: { ares, listen, voice, work, view, phone }
   * @param {string[]} o.selfIds  ARES's own bundle IDs (so the bar shows ARES's menus while ARES is in front)
   * @param {(live: boolean) => void} o.onLive  the theme's live parts came up or went away (the window hides its header)
   */
  constructor(o) {
    Object.assign(this, o);
    this.dir = path.join(o.supportDir, 'theme');
    this.originals = new Originals({ dir: this.dir, helper: o.helper, log: o.log });
    this.token = crypto.randomBytes(16).toString('hex');
    this.bar = new Bar({ log: o.log, url: () => this.clickUrl, aliases: () => this.aliasNames || [], height: () => this.menubarHeight || 37,
      pidFile: path.join(this.dir, 'ares.pid'), offlineCommands: () => this.offlineCommands() });
    this.dock = new Dock({ dir: this.dir, helper: o.helper, log: o.log, appDir: o.appDir, onSummon: () => o.onOpen('summon'),
      onAccessibility: () => this.askAccessibility(), onFront: (id) => this.front(id),
      readOpts: () => this.opts.dock, saveOpts: (p) => this.save({ dock: { ...this.opts.dock, ...p } }) });
    this.drop = new Drop({ log: o.log, appDir: o.appDir, onAct: (a) => this.dropAct(a) }); // status + WORK, drawn by ARES
    this.popups = {}; // menuId -> [{ run }]: what each line of an open drop-down does
    this.hoverSeq = 0;
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
      // The two parts that replace macOS chrome can each be switched off: then the Mac's own menu bar / Dock are used as-is
      menubar: t.menubar !== false, aresDock: t.aresDock !== false,
      dock: { icons: 'glyphs', reveal: 'edge', apps: null, ...(t.dock || {}) },
      folders: t.folders || ['Documents', 'Downloads', 'My AI'].map((f) => path.join(os.homedir(), f)),
      apps: { terminal: true, vscode: true, chrome: true, ...(t.apps || {}) },
      pointerManual: Boolean(t.pointerManual),
      mirror: t.mirror || ['Control Center', 'Tailscale'], // menu-bar icons mirrored in the bar (by owner)
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
    // Each step on its own: one that fails is logged and the rest of the theme still comes up
    const step = async (name, fn) => { try { await fn(); } catch (err) { this.log('theme start step failed', { step: name, error: err.message }); } };
    await step('server', () => this.serve());
    await step('migrate', () => this.migrate());
    await step('measure', () => this.measure());
    if (!this.live) return; // switched off meanwhile
    await step('pid', () => fs.writeFileSync(path.join(this.dir, 'ares.pid'), String(process.pid)));
    await step('bar', () => {
      if (this.bar.installed) { if (this.opts.menubar) this.bar.start(); this.bar.startBorders(); }
      else this.log('theme: SketchyBar/JankyBorders not installed (brew install felixkratz/formulae/sketchybar felixkratz/formulae/borders)');
    });
    await step('dock', () => { if (this.opts.aresDock) this.dock.start(); });
    if (!this.live) { this.dock.stop(); return; }
    await step('notifications', () => { if (this.opts.notifications) this.notify.start(); });
    await step('drop-downs', () => { if (this.opts.menubar) this.drop.start(); }); // the status pill / WORK drop-downs hang off the bar
    await step('icons', () => this.icons.watch());
    await step('dock settings', () => (this.opts.aresDock ? this.resumeDock() : this.nativeDock()));
    this.onLive?.(true);
  }
  stopLive({ quitting = false } = {}) {
    if (!this.live) return;
    this.live = false;
    if (quitting) this.bar.offline(); // the Mac's own Dock and menu bar come back; the bar and the glow quit with ARES
    else { this.bar.stop(); this.bar.stopBorders(); }
    try { fs.rmSync(path.join(this.dir, 'ares.pid'), { force: true }); } catch {}
    if (!quitting) this.onLive?.(false); // quitting: ARES's window is already gone
    this.dock.stop();
    this.notify.stop();
    this.drop.stop();
    this.icons.unwatch();
    this.server?.close();
    this.server = null;
  }
  /** ARES is quitting: the windows, the bar and the glow all go; the Apple Dock and menu bar are the user's own again until
   *  ARES is back (2026-10-05: the bar used to stay up saying "ares offline"). */
  quit() { this.quitting = true; this.stopLive({ quitting: true }); }

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
    if (o.aresDock) await step('dock', async () => {
      await this.script('dockAutohide', 'true');
      await this.script('dockMagnify', 'false');
      // The ARES dock appears at once at the bottom edge; the Apple Dock after a short dwell (or ⌥⌘D)
      const ok = await this.originals.setPref('com.apple.dock', 'autohide-delay', { real: 1.2 });
      await run('/usr/bin/killall', ['Dock']).catch(() => {});
      return ok;
    });
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

  // ---- The Apple Dock and the macOS menu bar around ARES's own --------------------------------------------------
  /** What the theme sets in com.apple.dock while ARES runs (the originals are kept by apply()). */
  get dockValues() { return { autohide: true, magnification: false, 'autohide-delay': { real: 1.2 } }; }
  /** For offline.sh: the user's own Dock settings back, as shell lines (run when ARES quits, or by the watchdog). */
  offlineCommands() {
    const lines = [];
    for (const key of Object.keys(this.dockValues)) {
      const rec = this.originals.get(`pref:com.apple.dock:${key}`);
      if (rec) lines.push(`${q(this.helper)} pref-set com.apple.dock ${key} ${rec.exists ? rec.plist : '-'} >/dev/null`);
    }
    if (lines.length) lines.push('/usr/bin/killall Dock');
    return lines;
  }
  /** ARES is back: the theme's Dock settings again (only if offline.sh had put the user's back). */
  async resumeDock(force = false) {
    if (!force && !this.originals.has('pref:com.apple.dock:autohide-delay')) return;
    if (force) for (const key of Object.keys(this.dockValues)) await this.originals.keepPref('com.apple.dock', key);
    const cur = await this.originals.readPref('com.apple.dock', 'autohide-delay');
    if (cur.exists && /<real>1\.2/.test(Buffer.from(cur.plist, 'base64').toString())) return;
    for (const [k, v] of Object.entries(this.dockValues)) await run(this.helper, ['pref-set', 'com.apple.dock', k, plist(v)]).catch(() => {});
    await run('/usr/bin/killall', ['Dock']).catch(() => {});
    this.log('theme dock resumed');
  }
  /** The ARES dock switched off: the user's own Dock settings back (auto-hide, magnification, delay), from the saved originals. */
  async nativeDock() {
    let changed = false;
    for (const key of Object.keys(this.dockValues)) {
      const rec = this.originals.get(`pref:com.apple.dock:${key}`);
      if (!rec) continue;
      const cur = await this.originals.readPref('com.apple.dock', key).catch(() => null);
      if (cur && cur.exists === rec.exists && (cur.plist || null) === (rec.plist || null)) continue;
      if (await this.originals.restorePref(rec)) changed = true;
    }
    if (changed) { await run('/usr/bin/killall', ['Dock']).catch(() => {}); this.log('theme: the Mac\'s own Dock settings are back'); }
  }
  /** Switch the ARES menu bar or the ARES dock on/off on its own (the rest of the theme stays). */
  async setPart(part, on) {
    this.save({ [part]: on });
    if (!this.live) return;
    if (part === 'menubar') {
      if (on) { if (this.bar.installed) this.bar.start(); this.drop.start(); }
      else { this.bar.stop(); this.drop.stop(); }
      this.onLive?.(true); // the window shows or hides its own top row to match
    }
    if (part === 'aresDock') {
      if (on) { this.dock.start(); await this.resumeDock(true); }
      else { this.dock.stop(); await this.nativeDock(); }
    }
    this.log('theme part', { part, on });
  }
  /** Earlier versions hid the macOS menu bar; it now stays put underneath the bar (so windows stop below it). */
  async migrate() {
    const ids = ['script:menubar', 'pref:-g:_HIHideMenuBar', 'pref:-g:AppleMenuBarVisibleInFullscreen'].filter((id) => this.originals.has(id));
    if (!ids.length) return;
    for (const id of ids) {
      const rec = this.originals.get(id);
      const ok = rec.kind === 'script' ? await this.originals.restoreScript(rec).then(() => true, () => false) : await this.originals.restorePref(rec);
      if (ok) this.originals.forget(id);
    }
    this.log('theme: macOS menu bar back to its own setting (the ARES bar covers it now)');
    await new Promise((r) => setTimeout(r, 800)); // let the menu bar settle before measuring it
  }
  /** The macOS menu bar's height (the ARES bar matches it exactly), and which menu-bar icons can be mirrored. */
  async measure() {
    const m = await run(this.helper, ['metrics']).then(parse({}), () => ({}));
    this.menubarHeight = m.menubar || 37;
    this.notchLeft = m.left || m.width || 1512; // the bar's left half ends here (the notch)
    const items = await run(this.bar.sketchybar || '/usr/bin/false', ['--query', 'default_menu_items']).then(parse(null), () => null);
    this.mirrorAllowed = Array.isArray(items);
    this.aliasNames = (items || []).filter((n) => this.opts.mirror.some((owner) => n.startsWith(`${owner},`)))
      .filter((n) => !n.startsWith('Control Center,') || /BentoBox|Bluetooth/.test(n)); // Control Center itself and Bluetooth
    if (!this.aliasNames.some((n) => /Bluetooth/.test(n))) this.aliasNames.push('Control Center,Bluetooth'); // always there: it opens Bluetooth settings when the menu-bar item is hidden
  }

  // ---- Menus in the bar ----------------------------------------------------------------------------------------
  /** The front app changed (the dock's app watcher): its menus across the bar, or ARES's while ARES is in front. */
  async front(id) {
    if (!this.live || id === this.frontId) return;
    this.frontId = id;
    this.menuCache = new Map(); // the front app's menus, as last read (shown at once; refreshed in the background)
    if (this.selfIds.includes(id)) return this.layoutMenus(ARES_MENUS.map((m) => m.toUpperCase()));
    const r = await run(this.helper, ['menubar', id]).then(parse({ menus: [] }), () => ({ menus: [] }));
    if (r.trusted !== this.axTrusted) this.log('theme accessibility', { trusted: r.trusted }); // menus, windows and badges need it
    this.axTrusted = r.trusted;
    if (this.frontId !== id) return;
    await this.layoutMenus(r.menus);
    if (r.menus.length) this.prefetchMenus(id, r.menus.length);
    // No menus (no Accessibility yet): at least the app's name, without waiting for SketchyBar's next switch event
    if (!r.menus.length && r.name) this.bar.raw(['--set', 'front', `label=${r.name.toUpperCase().split('').join(' ')}`]);
  }
  get aresFront() { return this.selfIds.includes(this.frontId); }
  /**
   * The titles across the bar's left half, as many as fit before the notch; the rest go under a last "»" menu.
   * Widths are worked out from the bar's monospaced font (about 6.7 pt a character at 11.5 pt, plus 12 pt of padding).
   */
  async layoutMenus(titles) {
    const r = await this.bar.query('ares.status');
    const rect = r && Object.values(r.bounding_rects || {})[0];
    const start = rect && rect.origin[0] > 0 ? rect.origin[0] + rect.size[0] + 5 : 236 + Math.max(0, String(this.bar.state.status.text).length - 14) * 7;
    const width = (t, i) => String(t).length * 6.7 + 12 + (i === 0 ? 10 : 0);
    const room = this.notchLeft - 8 - start;
    let used = 0, fit = 0;
    for (; fit < titles.length && fit < MENUS; fit++) {
      const w = width(titles[fit], fit);
      const needMore = fit < titles.length - 1; // something after this one: keep room for "»"
      if (used + w + (needMore ? width('»', 1) : 0) > room && !(fit === titles.length - 1 && used + w <= room)) break;
      used += w;
    }
    this.allTitles = titles;
    this.overflowFrom = fit < titles.length ? fit : null;
    this.bar.menus(this.overflowFrom === null ? titles : [...titles.slice(0, fit), '»']);
  }
  // Drop-downs. Each one has its rows made once in SketchyBar (theme-bar.js); opening one only fills and shows them.
  // Hovering a title fills its rows straight away and shows them after a short pause, so they appear complete at once.
  ownerOf(i) { return { mark: 'ares.mark', status: 'ares.status', work: 'ares.jobs' }[i] || `menu.${i}`; }
  /** Fill and open drop-down i (also: a submenu in it, or back). */
  show(i, entries) {
    this.popups[i] = entries;
    this.openId = String(i);
    this.bar.popup(this.ownerOf(i), i, entries, true);
  }
  /** What drop-down i holds right now (the front app's menus come from the cache, refreshed in the background). */
  async entriesFor(i) {
    if (i === 'mark') return this.aresList(this.menuSections().ares, i);
    if (i === 'status') return this.statusEntries();
    if (i === 'work') return this.workEntries();
    const n = Number(i);
    if (!(n >= 0 && n < MENUS)) return [];
    if (this.overflowFrom !== null && n === this.overflowFrom) return this.overflowEntries(i);
    if (this.aresFront) return this.aresList(this.menuSections()[ARES_MENUS[n]], i);
    if (!this.frontId) return [];
    if (!this.axTrusted) return [{ label: 'Show this app\'s menus: allow Accessibility for ARES…', run: () => this.askAccessibility() }];
    return this.appEntries(i, String(n));
  }
  hover(i) {
    clearTimeout(this.hoverTimer);
    if (DROPS.includes(i)) return this.dropHover(i);
    this.drop.hide();
    if (this.openId === String(i)) return; // already open
    const seq = ++this.hoverSeq;
    const filled = this.entriesFor(i).then((entries) => {
      if (seq !== this.hoverSeq) return null;
      this.popups[i] = entries;
      this.bar.popup(this.ownerOf(i), i, entries, false); // filled now, shown when the pause is over
      return entries;
    }).catch(() => null);
    // A pause before the first menu opens (so passing over the bar doesn't open them); none when switching between menus
    this.hoverTimer = setTimeout(async () => {
      if (!(await filled) || seq !== this.hoverSeq) return;
      this.openId = String(i);
      this.bar.show(this.ownerOf(i));
    }, this.openId ? 0 : 120);
  }
  unhover(i) {
    if (DROPS.includes(i)) { if (this.dropKind !== i || !this.drop.isOpen) { this.hoverSeq++; clearTimeout(this.hoverTimer); } return; }
    if (this.openId !== String(i)) { this.hoverSeq++; clearTimeout(this.hoverTimer); }
  }
  closed(i) { if (this.openId === String(i)) this.openId = null; }
  /** A click on a title: open it now (hover may already have; then it simply stays open). */
  async openMenu(i) {
    clearTimeout(this.hoverTimer);
    this.hoverSeq++;
    if (DROPS.includes(i)) return this.dropOpen(i, true);
    this.drop.hide();
    if (this.openId === String(i)) return;
    this.show(i, await this.entriesFor(i));
  }
  /**
   * ARES's own menu items (Electron menu templates) as rows. A submenu is one row with "›" that opens in place (with
   * "‹ Back"), so long menus like VIEW stay short.
   */
  aresList(items, i, back = null) {
    const out = back ? [{ label: '‹ Back', run: back, keepOpen: true }, { sep: true }] : [];
    for (const it of items || []) {
      if (!it || it.visible === false) continue;
      if (it.type === 'separator') { if (out.length && !out[out.length - 1].sep) out.push({ sep: true }); continue; }
      if (it.submenu) {
        out.push({ label: it.label, sub: true, keepOpen: true, enabled: it.enabled !== false,
          run: () => this.show(i, this.aresList(it.submenu, i, () => this.show(i, this.aresList(items, i, back)))) });
        continue;
      }
      const mark = (it.type === 'checkbox' || it.type === 'radio') && it.checked ? (it.type === 'radio' ? '•' : '✓') : '';
      out.push({ label: it.label, mark, enabled: it.enabled !== false && Boolean(it.click), info: it.enabled === false,
        run: it.click ? () => it.click({ checked: it.type === 'checkbox' ? !it.checked : true }) : null });
    }
    while (out.length && out[out.length - 1].sep) out.pop();
    return out;
  }
  /** "»": the titles that didn't fit before the notch; each opens its own menu in place. */
  overflowEntries(i) {
    const rest = this.allTitles.slice(this.overflowFrom);
    const list = () => this.show(i, this.overflowEntries(i));
    return rest.map((t, k) => ({ label: t, sub: true, keepOpen: true,
      run: async () => this.show(i, this.aresFront
        ? this.aresList(this.menuSections()[ARES_MENUS[this.overflowFrom + k]], i, list)
        : await this.appEntries(i, String(this.overflowFrom + k), list)) }));
  }
  /**
   * One of the front app's menus (or a submenu: path "2.5"), read through Accessibility. What was read last time is
   * used at once and re-read in the background (ticks and greyed items change); back: re-shows the menu this came from.
   */
  async appEntries(i, menuPath, back = null) {
    const app = this.frontId;
    const key = `${app}|${menuPath}`;
    const toEntries = (items) => {
      const entries = back ? [{ label: '‹ Back', run: back, keepOpen: true }, { sep: true }] : [];
      let prev = null;
      items.forEach((it, k) => {
        if (it.sep) { if (entries.length && !entries[entries.length - 1].sep) entries.push({ sep: true }); prev = null; return; }
        // macOS's hidden ⌥ alternates (they replace the item above only while ⌥ is held) and repeats: not shown
        const base = (x) => x.replace(/[⌃⌥⇧]/g, '');
        if (prev && (it.t === prev.t || (it.key.includes('⌥') && !prev.key.includes('⌥') && base(it.key) === base(prev.key)))) return;
        prev = it;
        const itemPath = `${menuPath}.${k}`;
        entries.push({ label: it.t, mark: it.mark, key: it.key, enabled: it.e, sub: it.sub, keepOpen: it.sub,
          run: it.sub
            ? async () => this.show(i, await this.appEntries(i, itemPath, async () => this.show(i, await this.appEntries(i, menuPath, back))))
            : () => run(this.helper, ['menu-press', app, itemPath]).catch(() => {}) });
      });
      return entries;
    };
    const read = () => run(this.helper, ['menu-items', app, menuPath]).then(parse({ items: [] }), () => ({ items: [] })).then(({ items = [] }) => {
      this.menuCache?.set(key, items);
      return items;
    });
    const cached = this.menuCache?.get(key);
    if (!cached) return toEntries(await read());
    read().then((items) => { // fresh ticks: repaint if it changed while open
      if (JSON.stringify(items) !== JSON.stringify(cached) && this.frontId === app && this.openId === String(i) && !back) this.show(i, toEntries(items));
    });
    return toEntries(cached);
  }
  /** Read the front app's top-level menus ahead (after a switch), so the first hover doesn't wait on Accessibility. */
  async prefetchMenus(app, count) {
    for (let n = 0; n < count && this.frontId === app; n++) {
      const key = `${app}|${n}`;
      if (this.menuCache?.has(key)) continue;
      const { items = [] } = await run(this.helper, ['menu-items', app, String(n)]).then(parse({}), () => ({}));
      if (this.frontId === app) this.menuCache?.set(key, items);
    }
  }

  // ---- The status pill and WORK: drawn by ARES (theme-drop.js) --------------------------------------------------------
  async dropHover(i) {
    if (this.drop.isOpen && this.dropKind === i) return;
    const seq = ++this.hoverSeq;
    const filled = this.dropFill(i);
    this.hoverTimer = setTimeout(async () => {
      await filled;
      if (seq !== this.hoverSeq) return;
      this.bar.closePopups(); this.openId = null;
      this.drop.show();
    }, this.openId || this.drop.isOpen ? 0 : 120);
  }
  async dropOpen(i) {
    await this.dropFill(i);
    this.bar.closePopups(); this.openId = null;
    this.drop.show();
  }
  /** Fill the drop-down for i ('status' | 'work') under its bar item, ready to show. */
  async dropFill(i) {
    const r = await this.bar.query(i === 'status' ? 'ares.status' : 'ares.jobs');
    const rect = r && Object.values(r.bounding_rects || {})[0];
    const anchor = rect && rect.origin[0] > 0
      ? { x: rect.origin[0], w: rect.size[0], h: this.menubarHeight || 33, align: i === 'work' ? 'right' : 'left' }
      : { x: i === 'work' ? (this.notchLeft || 700) + 200 : 110, w: 120, h: this.menubarHeight || 33, align: i === 'work' ? 'right' : 'left' };
    this.dropKind = i;
    this.drop.fill(i, i === 'status' ? await this.statusData() : this.workData(), anchor);
    clearInterval(this.dropTimer);
    // While the status drop-down is open: live CPU and memory every 2 s
    if (i === 'status') this.dropTimer = setInterval(async () => { if (this.drop.isOpen && this.dropKind === 'status') this.drop.update('status', await this.statusData()); else clearInterval(this.dropTimer); }, 2000);
  }
  async statusData() {
    const d = this.statusDetail || {};
    return { problems: d.problems || [], claude: d.claude || [], voice: d.voice || [], integrations: d.integrations || [],
      system: await this.systemStats().catch(() => null) };
  }
  workData() {
    const list = this.jobList || [];
    const slim = (j) => ({ id: j.id, title: j.title, status: j.status, ask: j.status === 'approval' ? j.approval?.what : '' });
    const active = list.filter((j) => ['running', 'queued', 'approval'].includes(j.status));
    const recent = list.filter((j) => !active.includes(j) && !j.dismissed).sort((a, b) => (b.finished || b.created || 0) - (a.finished || a.created || 0)).slice(0, 6);
    return { active: active.map(slim), recent: recent.map(slim) };
  }
  /** A click in the drop-down. */
  dropAct(a) {
    this.log('theme drop act', { type: a?.type });
    switch (a?.type) {
      case 'fix': { const p = a.problem || {}; return this.dashAct(p.url ? 'url' : 'fix', p.url ? { url: p.url } : { key: p.fix }); }
      case 'recheck': return this.dashAct('fix', { key: 'recheck' });
      case 'answer': return this.jobAnswer?.(a.id, Boolean(a.yes));
      case 'job': this.drop.hide(); return this.onOpen(`job:${a.id}`);
      case 'work': this.drop.hide(); return this.openFromBar('work');
      case 'folder': { this.drop.hide(); const f = this.menuSections().work.find((x) => /Work Folder/.test(x.label || '')); return f?.click(); }
    }
  }

  // ---- The status pill and WORK as SketchyBar drop-downs (no longer used for hover; kept for the "»"-style fallback) --
  async statusEntries() {
    const d = this.statusDetail || {};
    const out = [];
    const problems = d.problems || [];
    if (!problems.length) out.push({ label: 'all systems ok', mark: '●', info: true });
    for (const p of problems) {
      out.push({ label: p.text, mark: '●', color: 'amber', info: true });
      if (p.fix || p.url) out.push({ label: `   ${p.label || 'FIX'}${p.hint ? ` (${p.hint})` : ''}`, run: () => this.dashAct(p.url ? 'url' : 'fix', p.url ? { url: p.url } : { key: p.fix }) });
    }
    const lines = (title, list, amberOver80 = false) => {
      if (!list?.length) return;
      out.push({ sep: true }, { label: title, header: true });
      for (const line of list) out.push({ label: line, info: true, ...(amberOver80 && Number(/(\d+)% used/.exec(line)?.[1]) >= 80 && { color: 'amber' }) });
    };
    lines('Claude', d.claude, true);
    lines('Voice', d.voice);
    if (d.integrations?.length) {
      out.push({ sep: true }, { label: 'Integrations', header: true });
      // As in the panel: ● connected, ○ amber needs attention, ○ dim off
      for (const it of d.integrations) out.push({ label: it.text, mark: it.state === 'online' ? '●' : '○', info: it.state !== 'off', ...(it.state === 'pending' && { color: 'amber' }) });
    }
    const st = await this.systemStats().catch(() => null);
    if (st) {
      const up = `${Math.floor(st.uptime / 86400)}d ${Math.floor(st.uptime / 3600) % 24}h ${Math.floor(st.uptime / 60) % 60}m`;
      out.push({ sep: true }, { label: 'System', header: true },
        { label: `${st.user}@${st.host}`, info: true },
        { label: `CPU ${Math.round(st.cpu * 100)}%   ·   Memory ${Math.round((st.memUsed || 0) * 100)}%`, info: true },
        { label: `Up ${up}`, info: true });
    }
    out.push({ sep: true }, { label: 'Recheck', run: () => this.dashAct('fix', { key: 'recheck' }) },
      { label: 'Open the Status Panel', run: () => this.openFromBar('status') });
    return out;
  }
  workEntries() {
    const MARK = { running: ['◐', 'violet'], queued: ['○', null], approval: ['!', 'amber'], done: ['✓', null], failed: ['✕', 'amber'], cancelled: ['–', null] };
    const list = this.jobList || [];
    const active = list.filter((j) => ['running', 'queued', 'approval'].includes(j.status));
    const recent = list.filter((j) => !active.includes(j) && !j.dismissed).sort((a, b) => (b.finished || b.created || 0) - (a.finished || a.created || 0)).slice(0, 5);
    const row = (j) => {
      const [mark, color] = MARK[j.status] || ['·', null];
      return { label: `${j.title}${j.status === 'approval' ? '  · needs your OK' : ''}`, mark, ...(color && { color }), run: () => this.onOpen(`job:${j.id}`) };
    };
    const out = [];
    if (active.length) out.push({ label: 'Working', header: true }, ...active.map(row));
    if (recent.length) out.push(...(out.length ? [{ sep: true }] : []), { label: 'Recent', header: true }, ...recent.map(row));
    if (!out.length) out.push({ label: 'No jobs yet', info: true });
    const folder = this.menuSections().work.find((x) => /Work Folder/.test(x.label || ''));
    out.push({ sep: true }, { label: 'Open the Work Panel', run: () => this.openFromBar('work') },
      ...(folder ? [{ label: folder.label, run: folder.click }] : []));
    return out;
  }

  /** A mirrored menu-bar icon was clicked: press the real one (it's still there, under the bar). */
  extra(k) {
    const name = this.aliasNames?.[Number(k)];
    if (!name) return;
    const [owner, ...rest] = name.split(',');
    run(this.helper, ['extra-press', owner, rest.join(',')]).then((out) => {
      if (/"ok"\s*:\s*true/.test(String(out))) return;
      this.log('theme extra press: not found', { name });
      if (/Bluetooth/.test(name)) shell.openExternal('x-apple.systempreferences:com.apple.BluetoothSettings'); // no Bluetooth menu-bar item: the settings pane
    }, (err) => this.log('theme extra press failed', { name, error: err.message }));
  }
  pick(menuId, k) {
    const e = this.popups[menuId]?.[Number(k)];
    if (!e?.run) return;
    this.log('theme menu pick', { menu: menuId, item: String(e.label).trim().slice(0, 60) });
    if (!e.keepOpen) { this.bar.closePopups(); this.openId = null; }
    Promise.resolve(e.run()).catch((err) => this.log('theme menu action failed', err.message)).finally(() => { if (!e.keepOpen) this.onMenuAction?.(); });
  }
  askAccessibility() {
    run(this.helper, ['ax-prompt']).catch(() => {});
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  }
  flash(text) { if (this.live) this.bar.flash(text); }
  /** How she's listening (the window's "ear"), for the bar's voice item. */
  ear(text) { this.bar.ear(text); }

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
  }
  status(s) {
    if (!s || typeof s !== 'object') return;
    this.lastStatus = s;
    this.statusDetail = s; // problems, Claude limits, voice, integrations: the status drop-down
    if (this.drop?.isOpen && this.dropKind === 'status') this.statusData().then((d) => this.drop.update('status', d));
    if (this.live) this.bar.status({ ok: Boolean(s.ok), text: String(s.text || '') });
  }
  jobs(list) {
    this.jobList = list;
    if (this.drop?.isOpen && this.dropKind === 'work') this.drop.update('work', this.workData());
    const working = list.filter((j) => ['running', 'queued'].includes(j.status)).length;
    const approval = list.filter((j) => j.status === 'approval').length;
    if (this.live) this.bar.jobs({ working, approval });
    else this.bar.state.jobs = { working, approval };
  }
  call(c) { if (this.live) this.bar.call(c); else this.bar.state.call = c; }
  /** Standby / power down (power.js): the bar's ◉ takes the state's colour. */
  power(mode) { if (this.live && !this.quitting) this.bar.power(mode); }
  weather(w) { const t = w?.text || ''; if (this.live) this.bar.weather(t); else this.bar.state.weather = t; }
  /** Where the ARES window is (surface.js): notifications hold back while she's up in front. (The orb that followed this
   *  is the corner orb now, orb.js, which main.js tells directly.) */
  surface(name) { this.summoned = name === 'lifted' || name === 'window'; }

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
        if (token !== this.token || !['open', 'menu', 'pick', 'hover', 'unhover', 'closed', 'extra'].includes(what)) { res.writeHead(404); return res.end(); }
        res.writeHead(204); res.end();
        const i = u.searchParams.get('i');
        if (what === 'menu') return this.openId === i ? null : this.openMenu(i); // (hover may have opened it already: a click keeps it open)
        if (what === 'hover') return this.hover(i);
        if (what === 'unhover') return this.unhover(i);
        if (what === 'closed') return this.closed(i);
        if (what === 'extra') return this.extra(u.searchParams.get('k'));
        if (what === 'pick') return this.pick(u.searchParams.get('m'), u.searchParams.get('k'));
        const view = u.searchParams.get('view') || 'summon';
        if (['status', 'work', 'call'].includes(view)) return this.openFromBar(view);
        if (view === 'summon') this.onOpen(view);
      });
      server.listen(0, '127.0.0.1', () => { this.server = server; resolve(); });
    });
  }

  /** A panel opened from its bar item: it hangs from (status) or unfolds out of (Work, a call) that item. */
  async openFromBar(view) {
    const r = await this.bar.query({ status: 'ares.status', work: 'ares.jobs', call: 'ares.call' }[view]);
    const rect = r && Object.values(r.bounding_rects || {})[0];
    this.onOpen(view, rect && rect.origin[0] > 0 ? { x: Math.round(rect.origin[0]), cx: Math.round(rect.origin[0] + rect.size[0] / 2) } : null);
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
        { label: 'ARES Menu Bar (off: the Mac\'s own)', type: 'checkbox', checked: o.menubar, click: act((item) => this.setPart('menubar', item.checked)) },
        { label: 'ARES Dock (off: the Mac\'s own)', type: 'checkbox', checked: o.aresDock, click: act((item) => this.setPart('aresDock', item.checked)) },
        { type: 'separator' },
        { label: 'Dock Icons: ARES Glyphs', type: 'radio', checked: o.dock.icons !== 'real', click: dockSet({ icons: 'glyphs' }) },
        { label: 'Dock Icons: Real App Icons', type: 'radio', checked: o.dock.icons === 'real', click: dockSet({ icons: 'real' }) },
        { type: 'separator' },
        { label: 'Dock: Show at the Bottom Edge', type: 'radio', checked: o.dock.reveal !== 'always', click: dockSet({ reveal: 'edge' }) },
        { label: 'Dock: Always Visible', type: 'radio', checked: o.dock.reveal === 'always', click: dockSet({ reveal: 'always' }) },
        { label: 'Choose Dock Apps…', click: act(() => this.chooseApps()) },
        { type: 'separator' },
        ...(this.orbMenu ? this.orbMenu(refresh) : []),
        { type: 'separator' },
        { label: 'Use Stacks on the Desktop', type: 'checkbox', checked: o.stacks, click: act((item) => this.setStacks(item.checked)) },
        { label: 'ARES Notifications', type: 'checkbox', checked: o.notifications, click: act((item) => {
          this.save({ notifications: item.checked });
          if (this.live) { if (item.checked) this.notify.start(); else this.notify.stop(); }
        }) },
        { type: 'separator' },
        { label: 'Set the Pointer Colour…', visible: o.pointerManual, click: () => this.pointerHelp() },
        { label: 'Windows, Menus and Badges: Allow Accessibility…', click: () => this.askAccessibility() },
        { label: 'Mirror Menu-Bar Icons: Allow Screen Recording for SketchyBar…', visible: this.mirrorAllowed === false,
          click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') },
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
    if (parts.includes('dock')) await this.dock.start();
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
