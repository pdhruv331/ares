// The ARES menu bar (SketchyBar) and the active-window glow (JankyBorders), for the ARES OS theme
// (docs/ares-theme-prompt.md). Both are free, open-source Homebrew tools that ARES starts and stops itself, with its
// own config file in the support folder (no launch agents, nothing in ~/.config).
//
// LIVE-FED: ARES pushes every change (`sketchybar --set …`, `borders active_color=…`); the bar never polls ARES. The
// clock, battery and Wi-Fi are SketchyBar's own items. Clicks call back into ARES over a local URL with a token
// (theme.js), which opens the matching view.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const BREW = ['/opt/homebrew/bin', '/usr/local/bin'];
const which = (name) => BREW.map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) || null;

// ARES palette (0xAARRGGBB)
const C = {
  cyan: '0xff3ee6ff', cyanDim: '0x593ee6ff', cyanFaint: '0x1f3ee6ff', text: '0xffcfefff', muted: '0xff5d8797',
  violet: '0xffa78bfa', violetDim: '0x33a78bfa', green: '0xff4ade80', greenDim: '0x2a4ade80', amber: '0xffffb547', amberDim: '0x33ffb547',
  bar: '0xf002050a', none: '0x00000000',
};
const spaced = (s) => String(s).toUpperCase().split('').join(' ').replace(/ {3}/g, '  ');

class Bar {
  constructor({ dir, log, url }) {
    this.dir = path.join(dir, 'sketchybar');
    this.log = log;
    this.url = url;          // () => 'http://127.0.0.1:<port>/<token>' for clicks
    this.state = { voice: 'idle', status: { ok: true, text: 'all systems ok' }, jobs: { working: 0, approval: 0 }, call: null, weather: '', attention: false };
    this.lastLevel = 0;
    this.levelAt = 0;
    this.sent = {};          // item -> last args key: nothing is re-sent unchanged
  }
  get sketchybar() { return which('sketchybar'); }
  get borders() { return which('borders'); }
  get installed() { return Boolean(this.sketchybar && this.borders); }

  // ---- SketchyBar --------------------------------------------------------------------------------------------
  writeConfig() {
    fs.mkdirSync(this.dir, { recursive: true });
    const url = this.url();
    const click = (view) => `curl -s -m 2 '${url}/open?view=${view}' >/dev/null`;
    const font = (w, s) => `SF Mono:${w}:${s}`;
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
    };
    for (const [f, body] of Object.entries(plugins)) fs.writeFileSync(path.join(this.dir, f), body, { mode: 0o700 });
    const P = (f) => `'${path.join(this.dir, f)}'`;
    const rc = `#!/bin/zsh
# Written by ARES (theme-bar.js). The ARES items are live-fed by ARES itself; the rest are SketchyBar's own.
sketchybar --bar position=top height=34 color=${C.bar} border_width=0 shadow=off sticky=on topmost=off \\
  padding_left=14 padding_right=14 notch_width=210 font_smoothing=on display=all y_offset=0 \\
  border_color=${C.cyanFaint} corner_radius=0

sketchybar --default updates=when_shown icon.font='${font('Bold', 12.0)}' label.font='${font('Semibold', 11.0)}' \\
  icon.color=${C.cyan} label.color=${C.text} padding_left=5 padding_right=5 \\
  icon.padding_left=4 icon.padding_right=4 label.padding_left=4 label.padding_right=4 background.height=22 background.corner_radius=11

# ---- left: ARES ----
sketchybar --add item ares.mark left --set ares.mark icon='◉' icon.font='${font('Bold', 14.0)}' label='A R E S' \\
  label.color=${C.cyan} label.font='${font('Bold', 12.0)}' click_script="${click('summon')}"
sketchybar --add item ares.status left --set ares.status icon='●' icon.font='${font('Bold', 8.0)}' label='all systems ok' \\
  label.color=${C.text} background.color=${C.cyanFaint} background.border_color=${C.cyanDim} background.border_width=1 \\
  background.drawing=on icon.padding_left=10 label.padding_right=10 click_script="${click('status')}"
sketchybar --add item ares.voice left --set ares.voice icon='◌' icon.color=${C.muted} label.drawing=off click_script="${click('summon')}"
sketchybar --add item ares.jobs left --set ares.jobs drawing=off icon='●' icon.font='${font('Bold', 9.0)}' icon.color=${C.violet} \\
  label.color=${C.violet} background.color=${C.violetDim} background.drawing=on icon.padding_left=10 label.padding_right=10 \\
  click_script="${click('work')}"
sketchybar --add item ares.call left --set ares.call drawing=off icon='●' icon.font='${font('Bold', 9.0)}' icon.color=${C.green} \\
  label.color=${C.green} background.color=${C.greenDim} background.drawing=on icon.padding_left=10 label.padding_right=10 \\
  click_script="${click('call')}"
sketchybar --add item front left --set front icon.drawing=off label.color=${C.muted} padding_left=14 script=${P('front.sh')} \\
  --subscribe front front_app_switched

# ---- right: clock, battery, Wi-Fi, weather ----
sketchybar --add item clock right --set clock icon.drawing=off label.color=${C.cyan} update_freq=15 script=${P('clock.sh')} \\
  click_script="${click('summon')}"
sketchybar --add item battery right --set battery icon.font='${font('Bold', 11.0)}' update_freq=120 script=${P('battery.sh')} \\
  --subscribe battery power_source_change system_woke
sketchybar --add item wifi right --set wifi icon='◠' icon.font='${font('Bold', 12.0)}' script=${P('wifi.sh')} \\
  click_script="open 'x-apple.systempreferences:com.apple.wifi-settings-extension'" --subscribe wifi wifi_change system_woke
sketchybar --add item ares.weather right --set ares.weather drawing=off icon.drawing=off label.color=${C.text} \\
  click_script="${click('summon')}"

sketchybar --update
`;
    const file = path.join(this.dir, 'sketchybarrc');
    fs.writeFileSync(file, rc, { mode: 0o700 });
    return file;
  }

  /** Start the bar with ARES's config (or reload it into a bar ARES already started). */
  start() {
    const bin = this.sketchybar;
    if (!bin) return false;
    const rc = this.writeConfig();
    this.sent = {};
    this.active = true;
    execFile(bin, ['--query', 'bar'], { timeout: 3000 }, (err) => {
      if (!err) { execFile(bin, ['--reload', rc], () => setTimeout(() => this.pushAll(), 600)); return; }
      const p = spawn(bin, ['--config', rc], { detached: true, stdio: 'ignore', env: { ...process.env, LANG: 'en_US.UTF-8' } });
      p.unref();
      this.pid = p.pid;
      setTimeout(() => this.pushAll(), 1200);
    });
    return true;
  }
  stop() {
    this.active = false;
    // The bar ARES started (its pid), or any bar still running ARES's config
    if (this.pid) { try { process.kill(this.pid); } catch {} this.pid = null; }
    execFile('/usr/bin/pkill', ['-f', `sketchybar --config ${path.join(this.dir, 'sketchybarrc')}`], () => {});
  }
  /** ARES is quitting: the bar stays (it's the menu bar) but says so. */
  offline() {
    this.set('ares.status', ['label=ares offline', `icon.color=${C.amber}`, `label.color=${C.amber}`, `background.border_color=${C.amberDim}`]);
    this.set('ares.voice', ['icon=◌', `icon.color=${C.muted}`, 'label.drawing=off']);
  }

  /** One `sketchybar --set` per item, only when something changed. */
  set(item, props, animate = null) {
    const bin = this.sketchybar;
    if (!bin || !this.running) return;
    const key = props.join('\u0000');
    if (!animate && this.sent[item] === key) return;
    this.sent[item] = key;
    execFile(bin, [...(animate ? ['--animate', animate[0], String(animate[1])] : []), '--set', item, ...props], { timeout: 3000 }, () => {});
  }
  get running() { return this.active; }

  pushAll() {
    this.sent = {};
    this.voice(this.state.voice, true);
    this.status(this.state.status);
    this.jobs(this.state.jobs);
    this.call(this.state.call);
    this.weather(this.state.weather);
  }

  // ---- State from ARES ----------------------------------------------------------------------------------------
  status({ ok, text }) {
    this.state.status = { ok, text };
    const col = ok ? C.cyan : C.amber;
    this.set('ares.status', [`label=${ok ? 'all systems ok' : String(text).slice(0, 48)}`, `icon.color=${col}`,
      `label.color=${ok ? C.text : C.amber}`, `background.border_color=${ok ? C.cyanDim : C.amberDim}`, `background.color=${ok ? C.cyanFaint : C.amberDim}`]);
  }
  voice(state) {
    this.state.voice = state;
    const look = {
      idle: ['icon=◌', `icon.color=${C.muted}`, 'label.drawing=off'],
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
    const q = Math.round(Math.min(1, v * 1.6) * 6) / 6;
    if (now - this.levelAt < 160 || q === this.lastLevel) return;
    this.levelAt = now;
    this.lastLevel = q;
    const a = Math.round(0x50 + q * (0xff - 0x50)).toString(16).padStart(2, '0');
    this.set('ares.voice', [`icon.color=0x${a}3ee6ff`], ['sin', 8]);
  }
  jobs({ working, approval }) {
    this.state.jobs = { working, approval };
    if (!working && !approval) return this.set('ares.jobs', ['drawing=off']);
    const amber = approval > 0;
    this.set('ares.jobs', ['drawing=on', `label=${amber ? 'NEEDS YOU' : `${working} WORKING`}`, `icon.color=${amber ? C.amber : C.violet}`,
      `label.color=${amber ? C.amber : C.violet}`, `background.color=${amber ? C.amberDim : C.violetDim}`]);
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
    const p = spawn(bin, args, { detached: true, stdio: 'ignore' });
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

module.exports = { Bar, which, C };
