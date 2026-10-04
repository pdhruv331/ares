// The ARES menu bar (SketchyBar) and the active-window glow (JankyBorders), for the ARES OS theme
// (docs/ares-theme-prompt.md). Both are free, open-source Homebrew tools that ARES starts and stops itself, with its
// own config file (no launch agents, nothing in ~/.config). SketchyBar hands its config and item scripts to `sh -c`
// unquoted, so they can't live under "Application Support": they're in ~/.ares/sketchybar, removed when the theme is off.
//
// The bar COVERS the macOS menu bar (drawn above it, exactly its height): the macOS menu bar stays on screen underneath
// (so windows never go under the bar) but is never seen. What it offered comes back in the bar: the front app's menus
// (read and pressed through Accessibility, theme.js), ARES's own menus while ARES is in front, and mirrored menu-bar
// icons (SketchyBar aliases: Control Center, Tailscale; they need Screen Recording for SketchyBar).
//
// LIVE-FED: ARES pushes every change (`sketchybar --set …`, `borders active_color=…`); the bar never polls ARES. The
// clock, battery and Wi-Fi are SketchyBar's own items. Clicks call back into ARES over a local URL with a token.
//
// OFFLINE: when ARES quits, and if it ever dies (a watchdog item checks its pid every 15 s), offline.sh puts the Apple
// Dock back to the user's own settings, lowers the bar under the macOS menu bar and marks the bar offline.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const BREW = ['/opt/homebrew/bin', '/usr/local/bin'];
const which = (name) => BREW.map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) || null;
const MENUS = 14; // menu title slots in the bar

// ARES palette (0xAARRGGBB)
const C = {
  cyan: '0xff3ee6ff', cyanDim: '0x593ee6ff', cyanFaint: '0x1f3ee6ff', text: '0xffcfefff', muted: '0xff5d8797',
  violet: '0xffa78bfa', violetDim: '0x33a78bfa', green: '0xff4ade80', greenDim: '0x2a4ade80', amber: '0xffffb547', amberDim: '0x33ffb547',
  bar: '0xff02050a', popup: '0xf6040b12', none: '0x00000000',
};
const spaced = (s) => String(s).toUpperCase().split('').join(' ').replace(/ {3}/g, '  ');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // a shell-quoted string inside the generated scripts

class Bar {
  /**
   * @param {object} o
   * @param {(…) => void} o.log  @param {() => string} o.url  the click base URL
   * @param {() => string[]} o.aliases  menu-bar icons to mirror ("Owner,Name")
   * @param {() => number} o.height  the macOS menu bar's height (points)
   * @param {string} o.pidFile  ARES's pid, for the watchdog  @param {() => string[]} o.offlineCommands  shell lines
   */
  constructor({ log, url, aliases, height, pidFile, offlineCommands }) {
    const home = path.join(os.homedir(), '.ares', process.env.ARES_USER_DATA ? 'sketchybar-dev' : 'sketchybar'); // a dev harness never touches the installed bar's files
    this.dir = /\s/.test(home) ? path.join(os.tmpdir(), `ares-sketchybar-${process.getuid()}`) : home;
    Object.assign(this, { log, url, aliases, height, pidFile, offlineCommands });
    this.state = { voice: 'idle', ear: 'WAKE WORD', status: { ok: true, text: 'all systems ok' }, jobs: { working: 0, approval: 0 }, call: null, weather: '', attention: false };
    this.lastLevel = 0;
    this.levelAt = 0;
    this.sent = {};          // item -> last args key: nothing is re-sent unchanged
    this.menuTitles = [];
    this.menuBold = true;
  }
  get sketchybar() { return which('sketchybar'); }
  get borders() { return which('borders'); }
  get installed() { return Boolean(this.sketchybar && this.borders); }
  get offlineFile() { return path.join(this.dir, 'offline.sh'); }
  get marker() { return `${this.pidFile}.offline`; }

  // ---- SketchyBar --------------------------------------------------------------------------------------------
  writeConfig() {
    fs.mkdirSync(this.dir, { recursive: true });
    const url = this.url();
    const click = (route) => `curl -s -m 2 '${url}/${route}' >/dev/null`;
    const font = (w, s) => `.SF NS Mono:${w}:${s}`; // SF Mono's system name ("SF Mono" itself isn't installed)
    const h = Math.max(30, Math.round(this.height()));
    const popupStyle = `popup.background.color=${C.popup} popup.background.border_color=${C.cyanDim} popup.background.border_width=1 \\
  popup.background.corner_radius=6 popup.y_offset=4 popup.align=left`;
    const plugins = {
      'clock.sh': '#!/bin/zsh\nsketchybar --set "$NAME" label="$(date \'+%a %b %-d  %-I:%M %p\' | tr a-z A-Z)"\n',
      'battery.sh': `#!/bin/zsh
B=$(pmset -g batt)
P=$(echo "$B" | grep -Eo '[0-9]+%' | head -1)
[[ -z "$P" ]] && { sketchybar --set "$NAME" drawing=off; exit 0; }
N=\${P%\\%}
C=${C.text}; [[ $N -le 20 ]] && C=${C.amber}
I="▮"; echo "$B" | grep -q "AC Power" && I="⚡"
sketchybar --set "$NAME" drawing=on icon="$I" label="$P" label.color=$C icon.color=$C
`,
      'wifi.sh': `#!/bin/zsh
IF=$(networksetup -listallhardwareports | awk '/Wi-Fi|AirPort/{getline; print $2; exit}')
if ipconfig getifaddr "\${IF:-en0}" >/dev/null 2>&1; then
  sketchybar --set "$NAME" icon.color=${C.cyan} label="W I F I" label.color=${C.text}
else
  sketchybar --set "$NAME" icon.color=${C.amber} label="O F F L I N E" label.color=${C.amber}
fi
`,
      'front.sh': `#!/bin/zsh
[[ "$SENDER" == "front_app_switched" ]] && sketchybar --set "$NAME" label="$(echo "$INFO" | tr a-z A-Z | sed 's/./& /g;s/ $//')"
`,
      'close.sh': '#!/bin/zsh\n[[ "$SENDER" == "mouse.exited.global" ]] && sketchybar --set "$NAME" popup.drawing=off\n',
      // Back to the user's own Dock and the plain macOS menu bar while ARES isn't running
      'offline.sh': `#!/bin/zsh
export PATH="${path.dirname(this.sketchybar || '/opt/homebrew/bin/x')}:$PATH"
touch ${q(this.marker)}
${this.offlineCommands().join('\n')}
sketchybar --bar topmost=off --set ares.status label='ares offline' icon.color=${C.amber} label.color=${C.amber} background.border_color=${C.amberDim} \\
  --set ares.voice icon='◌' icon.color=${C.muted} label.drawing=off --set '/menu\\..*/' drawing=off popup.drawing=off --set front drawing=on \\
  --set ares.mark popup.drawing=off
`,
      // The watchdog: ARES died without quitting (once per outage; ARES clears the marker when it's back)
      'watch.sh': `#!/bin/zsh
P=$(cat ${q(this.pidFile)} 2>/dev/null)
[[ -n "$P" ]] && kill -0 "$P" 2>/dev/null && exit 0
[[ -f ${q(this.marker)} ]] && exit 0
exec ${q(this.offlineFile)}
`,
    };
    for (const [f, body] of Object.entries(plugins)) fs.writeFileSync(path.join(this.dir, f), body, { mode: 0o700 });
    const P = (f) => `'${path.join(this.dir, f)}'`;
    const menuItems = Array.from({ length: MENUS }, (_, i) => `sketchybar --add item menu.${i} left --set menu.${i} drawing=off icon.drawing=off \\
  label.font='${font(i === 0 ? 'Bold' : 'Semibold', 11.5)}' label.color=${i === 0 ? C.cyan : C.text} padding_left=${i === 0 ? 12 : 2} padding_right=2 \\
  click_script="${click(`menu?i=${i}`)}" script=${P('close.sh')} ${popupStyle} --subscribe menu.${i} mouse.exited.global`).join('\n');
    const aliases = (this.aliases() || []).map((a) => `sketchybar --add alias ${q(a)} right --set ${q(a)} alias.color=${C.cyan} padding_left=0 padding_right=0`).join('\n');
    const rc = `#!/bin/zsh
# Written by ARES (theme-bar.js). The ARES items are live-fed by ARES itself; the rest are SketchyBar's own.
export PATH="${path.dirname(this.sketchybar)}:$PATH"
sketchybar --bar position=top height=${h} color=${C.bar} border_width=0 shadow=off sticky=on topmost=on \\
  padding_left=14 padding_right=10 notch_width=210 font_smoothing=on display=all y_offset=0 corner_radius=0

sketchybar --default updates=when_shown icon.font='${font('Bold', 12.0)}' label.font='${font('Semibold', 11.0)}' \\
  icon.color=${C.cyan} label.color=${C.text} padding_left=5 padding_right=5 \\
  icon.padding_left=4 icon.padding_right=4 label.padding_left=4 label.padding_right=4 background.height=22 background.corner_radius=11

# ---- left: ARES, then the front app's menus (ARES's own while ARES is in front) ----
sketchybar --add item ares.mark left --set ares.mark icon='◉' icon.font='${font('Bold', 14.0)}' label='A R E S' \\
  label.color=${C.cyan} label.font='${font('Bold', 12.0)}' click_script="${click('menu?i=mark')}" script=${P('close.sh')} \\
  ${popupStyle} --subscribe ares.mark mouse.exited.global
sketchybar --add item ares.status left --set ares.status icon='●' icon.font='${font('Bold', 8.0)}' label='all systems ok' \\
  label.color=${C.text} background.color=${C.cyanFaint} background.border_color=${C.cyanDim} background.border_width=1 \\
  background.drawing=on icon.padding_left=10 label.padding_right=10 click_script="${click('open?view=status')}"
sketchybar --add item ares.voice left --set ares.voice icon='◌' icon.color=${C.muted} label='W A K E  W O R D' label.color=${C.muted} \\
  label.font='${font('Semibold', 9.5)}' click_script="${click('open?view=summon')}"
sketchybar --add item ares.jobs left --set ares.jobs icon='●' icon.font='${font('Bold', 9.0)}' icon.color=${C.muted} label='WORK' \\
  label.color=${C.muted} background.color=${C.none} background.border_color=${C.cyanFaint} background.border_width=1 background.drawing=on \\
  icon.padding_left=10 label.padding_right=10 click_script="${click('open?view=work')}"
sketchybar --add item ares.call left --set ares.call drawing=off icon='●' icon.font='${font('Bold', 9.0)}' icon.color=${C.green} \\
  label.color=${C.green} background.color=${C.greenDim} background.drawing=on icon.padding_left=10 label.padding_right=10 \\
  click_script="${click('open?view=call')}"
sketchybar --add item front left --set front icon.drawing=off label.color=${C.muted} padding_left=14 script=${P('front.sh')} \\
  --subscribe front front_app_switched
${menuItems}

# ---- right: clock, battery, Wi-Fi, mirrored menu-bar icons, weather ----
sketchybar --add item clock right --set clock icon.drawing=off label.color=${C.cyan} update_freq=15 script=${P('clock.sh')} \\
  click_script="${click('open?view=summon')}"
sketchybar --add item battery right --set battery icon.font='${font('Bold', 11.0)}' update_freq=120 script=${P('battery.sh')} \\
  --subscribe battery power_source_change system_woke
sketchybar --add item wifi right --set wifi icon='◠' icon.font='${font('Bold', 12.0)}' script=${P('wifi.sh')} \\
  click_script="open 'x-apple.systempreferences:com.apple.wifi-settings-extension'" --subscribe wifi wifi_change system_woke
${aliases}
sketchybar --add item ares.weather right --set ares.weather drawing=off icon.drawing=off label.color=${C.text} \\
  click_script="${click('open?view=summon')}"
# The watchdog (never drawn)
sketchybar --add item ares.watch right --set ares.watch drawing=off updates=on update_freq=15 script=${P('watch.sh')}

sketchybar --update
`;
    const file = path.join(this.dir, 'sketchybarrc');
    fs.writeFileSync(file, rc, { mode: 0o700 });
    return file;
  }

  /** Start the bar with ARES's config. */
  start() {
    const bin = this.sketchybar;
    if (!bin) return false;
    try { fs.rmSync(this.marker, { force: true }); } catch {}
    const rc = this.writeConfig();
    this.sent = {};
    this.active = true;
    // A fresh bar each time: one ARES started earlier (launched with --config) is replaced, so a moved or changed config
    // always takes. A bar the user runs themselves (brew services, no --config) is left alone.
    execFile('/usr/bin/pkill', ['-f', '^/.*/sketchybar --config '], () => setTimeout(() => {
      const env = { ...process.env, LANG: 'en_US.UTF-8', PATH: `${path.dirname(bin)}:${process.env.PATH || '/usr/bin:/bin'}` };
      const p = spawn(bin, ['--config', rc], { detached: true, stdio: 'ignore', env });
      p.unref();
      this.pid = p.pid;
      setTimeout(() => this.pushAll(), 1200);
    }, 400));
    return true;
  }
  stop() {
    this.active = false;
    if (this.pid) { try { process.kill(this.pid); } catch {} this.pid = null; }
    execFile('/usr/bin/pkill', ['-f', '^/.*/sketchybar --config '], () => {});
  }
  /** Theme off: the bar's files go too. */
  removeFiles() { fs.rmSync(this.dir, { recursive: true, force: true }); try { fs.rmdirSync(path.dirname(this.dir)); } catch {} }
  /** ARES is quitting: the bar stays (clock, battery, Wi-Fi) and offline.sh hands the Mac back. Synchronous. */
  offline() {
    this.active = false;
    if (!fs.existsSync(this.offlineFile)) return;
    try { execFileSync('/bin/zsh', [this.offlineFile], { timeout: 8000 }); } catch (err) { this.log('theme offline script', err.message); }
  }

  /** One `sketchybar --set` per item, only when something changed. */
  set(item, props, animate = null) {
    const bin = this.sketchybar;
    if (!bin || !this.active) return;
    const key = props.join('\u0000');
    if (!animate && this.sent[item] === key) return;
    this.sent[item] = key;
    execFile(bin, [...(animate ? ['--animate', animate[0], String(animate[1])] : []), '--set', item, ...props], { timeout: 3000 }, () => {});
  }
  raw(args) { if (this.sketchybar && this.active) execFile(this.sketchybar, args, { timeout: 3000 }, () => {}); }
  query(item) {
    return new Promise((resolve) => execFile(this.sketchybar, ['--query', item], { timeout: 2000 }, (err, out) => { try { resolve(JSON.parse(out)); } catch { resolve(null); } }));
  }

  pushAll() {
    this.sent = {};
    execFile(this.sketchybar, ['--update'], () => {}); // lay the items out again after a (re)start
    this.voice(this.state.voice);
    this.status(this.state.status);
    this.jobs(this.state.jobs);
    this.call(this.state.call);
    this.weather(this.state.weather);
    this.menus(this.menuTitles, this.menuBold);
  }

  // ---- Menus -------------------------------------------------------------------------------------------------
  /** The titles across the bar (the front app's, or ARES's). None: just the front app's name. */
  menus(titles, bold = true) {
    this.menuTitles = titles || [];
    this.menuBold = bold;
    const props = [];
    for (let i = 0; i < MENUS; i++) {
      const t = this.menuTitles[i];
      props.push('--set', `menu.${i}`, ...(t ? ['drawing=on', `label=${t}`, `label.color=${i === 0 && bold ? C.cyan : C.text}`] : ['drawing=off']), 'popup.drawing=off');
    }
    props.push('--set', 'front', `drawing=${this.menuTitles.length ? 'off' : 'on'}`);
    const key = props.join('\u0000');
    if (key === this.sent.menus) return;
    this.sent.menus = key;
    this.raw(props);
  }
  /**
   * Fill a drop-down and open it. entries: [{ label, mark, key, enabled, header, sep, sub }]; `owner` is 'menu.<i>' or
   * 'ares.mark'; each entry clicks /pick?m=<menuId>&k=<index>.
   */
  popup(owner, menuId, entries) {
    const args = ['--remove', `/${owner.replace('.', '\\.')}\\.p\\..*/`];
    for (let i = 0; i < MENUS; i++) if (`menu.${i}` !== owner) args.push('--set', `menu.${i}`, 'popup.drawing=off');
    if (owner !== 'ares.mark') args.push('--set', 'ares.mark', 'popup.drawing=off');
    entries.slice(0, 48).forEach((e, k) => {
      const name = `${owner}.p.${k}`;
      args.push('--add', 'item', name, `popup.${owner}`);
      if (e.sep) {
        args.push('--set', name, 'icon.drawing=off', 'label.drawing=off', 'width=230', 'background.height=1', `background.color=${C.cyanFaint}`,
          'background.drawing=on', 'padding_left=8', 'padding_right=8', 'background.padding_left=0');
        return;
      }
      const dim = e.enabled === false || e.header;
      args.push('--set', name, `icon=${e.mark || ' '}`, `icon.color=${C.cyan}`, 'icon.width=18', 'icon.font=.SF NS Mono:Bold:10.0',
        `label=${e.header ? spaced(e.label) : e.label}${e.sub ? '  ›' : ''}${e.key ? `    ${e.key}` : ''}`,
        `label.color=${e.header ? C.cyan : dim ? C.muted : C.text}`, `label.font=.SF NS Mono:${e.header ? 'Bold:8.5' : 'Regular:11.0'}`,
        'padding_left=6', 'padding_right=12', 'background.drawing=off',
        `click_script=${dim ? '' : `curl -s -m 2 '${this.url()}/pick?m=${menuId}&k=${k}' >/dev/null`}`);
    });
    args.push('--set', owner, 'popup.drawing=on');
    this.raw(args);
  }
  closePopups() {
    const args = ['--set', 'ares.mark', 'popup.drawing=off'];
    for (let i = 0; i < MENUS; i++) args.push('--set', `menu.${i}`, 'popup.drawing=off');
    this.raw(args);
  }

  // ---- State from ARES ----------------------------------------------------------------------------------------
  status({ ok, text }) {
    this.state.status = { ok, text };
    const col = ok ? C.cyan : C.amber;
    this.set('ares.status', [`label=${ok ? 'all systems ok' : String(text).slice(0, 48)}`, `icon.color=${col}`,
      `label.color=${ok ? C.text : C.amber}`, `background.border_color=${ok ? C.cyanDim : C.amberDim}`, `background.color=${ok ? C.cyanFaint : C.amberDim}`]);
  }
  /** How she's listening when idle: wake word / always listening / desk mode / muted (the window's "ear"). */
  ear(text) { this.state.ear = text; if (this.state.voice === 'idle') this.voice('idle'); }
  voice(state) {
    this.state.voice = state;
    const muted = /MUTED/.test(this.state.ear);
    const look = {
      idle: ['icon=◌', `icon.color=${muted ? C.amber : C.muted}`, 'label.drawing=on', `label=${spaced(this.state.ear)}`, `label.color=${muted ? C.amber : C.muted}`],
      listening: ['icon=◉', `icon.color=${C.cyan}`, 'label.drawing=on', `label=${spaced('listening')}`, `label.color=${C.cyan}`],
      speaking: ['icon=◉', `icon.color=${C.cyan}`, 'label.drawing=on', `label=${spaced('speaking')}`, `label.color=${C.cyan}`],
      thinking: ['icon=◉', `icon.color=${C.violet}`, 'label.drawing=on', `label=${spaced('thinking')}`, `label.color=${C.violet}`],
    }[state] || null;
    if (look) this.set('ares.voice', look);
    this.glow();
  }
  /** Her real voice level: the dot breathes with it (a few updates a second at most, and only on a real change). */
  level(v) {
    const s = this.state.voice;
    if (s !== 'speaking' && s !== 'listening') return;
    const now = Date.now();
    const lv = Math.round(Math.min(1, v * 1.6) * 6) / 6;
    if (now - this.levelAt < 160 || lv === this.lastLevel) return;
    this.levelAt = now;
    this.lastLevel = lv;
    const a = Math.round(0x50 + lv * (0xff - 0x50)).toString(16).padStart(2, '0');
    this.set('ares.voice', [`icon.color=0x${a}3ee6ff`], ['sin', 8]);
  }
  /** WORK is always there (the way into the Work panel); busy: violet with a count; amber when a job needs the user. */
  jobs({ working, approval }) {
    this.state.jobs = { working, approval };
    const amber = approval > 0, busy = working > 0;
    const col = amber ? C.amber : busy ? C.violet : C.muted;
    this.set('ares.jobs', ['drawing=on', `label=${amber ? 'NEEDS YOU' : busy ? `${working} WORKING` : 'WORK'}`, `icon.color=${col}`, `label.color=${col}`,
      `background.color=${amber ? C.amberDim : busy ? C.violetDim : C.none}`, `background.border_color=${amber || busy ? C.none : C.cyanFaint}`]);
    this.glow();
  }
  call(call) {
    this.state.call = call;
    this.set('ares.call', call?.live ? ['drawing=on', `label=ON CALL · ${String(call.name || 'CALL').toUpperCase().slice(0, 24)}`] : ['drawing=off']);
  }
  weather(text) {
    this.state.weather = text || '';
    this.set('ares.weather', text ? ['drawing=on', `label=${String(text).toUpperCase()}`] : ['drawing=off']);
  }
  attention(on) { this.state.attention = Boolean(on); this.glow(); }

  // ---- JankyBorders ------------------------------------------------------------------------------------------
  /** The focused window's glow: cyan; violet while she's thinking; amber when something needs the user. */
  glowColor() {
    if (this.state.attention || this.state.jobs.approval > 0) return 'glow(0xe6ffb547)';
    if (this.state.voice === 'thinking') return 'glow(0xe6a78bfa)';
    return 'glow(0xcc3ee6ff)';
  }
  startBorders() {
    const bin = this.borders;
    if (!bin) return false;
    this.lastGlow = this.glowColor();
    const args = ['style=round', 'width=3.0', 'hidpi=on', `active_color=${this.lastGlow}`, 'inactive_color=0x00000000', 'blacklist=ARES,Electron'];
    const p = spawn(bin, args, { detached: true, stdio: 'ignore' }); // a second `borders …` only updates the one running
    p.unref();
    this.bordersPid = p.pid;
    this.bordersOn = true;
    return true;
  }
  glow() {
    if (!this.bordersOn || !this.borders) return;
    const c = this.glowColor();
    if (c === this.lastGlow) return;
    this.lastGlow = c;
    execFile(this.borders, [`active_color=${c}`], { timeout: 3000 }, () => {}); // updates the running instance
  }
  stopBorders() {
    this.bordersOn = false;
    if (this.bordersPid) { try { process.kill(this.bordersPid); } catch {} this.bordersPid = null; }
    execFile('/usr/bin/pkill', ['-x', 'borders'], () => {});
  }
}

module.exports = { Bar, which, C, MENUS };
