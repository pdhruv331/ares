// Hand gestures, main-process side (docs/hand-tracking-prompt.md). Runs ares-vision (native/AresVision.swift), the one
// camera owner, and feeds its joint frames through the gesture engine (hands.js); the actions go to the window, where
// renderer/hands.js drives the same panel code the mouse does.
//
// The camera is ON only while: the "Hand Gestures" switch is on, desk mode is active (so: unlocked, not idle, no call
// or other mic user, not told to go quiet), and Low Power Mode is off. The helper itself also stops when the lid closes.
// Frames never leave the helper; this file only ever sees joints. Nothing here is logged beyond state changes.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const { HandEngine } = require('./hands');

class Vision extends EventEmitter {
  /** opts: { helper, pointerHelper, screen, bounds: () => window bounds, log, readSettings, writeSettings, supportDir, powerMonitor, desk,
   *          lowPower: () => bool, devBuild } */
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.child = null;
    this.camera = { on: false };
    this.permission = null;
    this.engine = new HandEngine(this.tuneOpts(), { battery: () => this.powerMonitor.isOnBatteryPower() });
    this.engine.reset('off');
    this.stats = null;
    this.rec = null; // { name, kind, frames, until, aspect }
    this.why = 'off';
    this.restarts = 0;
    this.lastFrameAt = 0;
    this.desk.on('change', () => this.check());
    this.powerMonitor.on('on-battery', () => this.rate());
    this.powerMonitor.on('on-ac', () => this.rate());
    this.timer = setInterval(() => this.check(), 5000);
  }

  get opts() {
    const h = this.readSettings().hands || {};
    return { enabled: Boolean(h.enabled), mac: h.mac !== false, tune: h.tune || {} };
  }

  // ---- Mac mode (default): the hand moves the Mac's own pointer, a pinch is a real click and drag, two-finger drift a real
  // scroll, anywhere on screen (Finder, the ARES bar, apps, and ARES's own panels through the normal mouse path). Swipes,
  // zoom and the palm stay ARES's own. Off: the window gets synthetic pointer events instead (ARES's scene only).
  pointer(cmd) {
    if (!this.ptr) {
      if (!this.pointerHelper || !fs.existsSync(this.pointerHelper)) return;
      const p = spawn(this.pointerHelper, ['pointer'], { stdio: ['pipe', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => { try { const m = JSON.parse(String(d).trim().split('\n')[0]); if (m.trusted === false) this.log('hands', { pointer: 'no Accessibility' }); } catch {} });
      p.on('exit', () => { if (this.ptr === p) this.ptr = null; });
      this.ptr = p;
    }
    try { this.ptr.stdin.write(cmd + '\n'); } catch {}
  }
  pointerStop() { if (this.ptr) { try { this.ptr.stdin.end(); } catch {} this.ptr = null; } }

  /** Engine actions → the Mac's pointer (Mac mode) and the window. Points are display fractions; the window gets them
   *  relative to itself (the ring and brackets), the pointer gets screen pixels. */
  dispatch(actions) {
    if (!this.opts.mac) return this.emit('actions', actions);
    const D = this.screen.getPrimaryDisplay().bounds, b = this.bounds?.() || D;
    const toScreen = (a) => ({ x: Math.round(D.x + a.x * D.width), y: Math.round(D.y + a.y * D.height) });
    const toWin = (a) => { const s = toScreen(a); return { ...a, x: (s.x - b.x) / b.width, y: (s.y - b.y) / b.height }; };
    const out = [];
    for (const a of actions) {
      switch (a.type) {
        case 'cursor': if (!a.lost) { const s = toScreen(a); if (!this.zooming) this.pointer(`move ${s.x} ${s.y}`); out.push(toWin(a)); } else out.push(a); break;
        case 'down': { const s = toScreen(a); this.pointer(`move ${s.x} ${s.y}`); this.pointer('down'); out.push({ ...toWin(a), mac: true }); break; }
        case 'move': { const s = toScreen(a); this.pointer(`move ${s.x} ${s.y}`); break; }
        case 'up': { const s = toScreen(a); if (!a.cancel) this.pointer(`move ${s.x} ${s.y}`); this.pointer('up'); out.push({ ...toWin(a), mac: true }); break; }
        case 'scroll': this.pointer(`scroll ${Math.round(a.dy * 500)}`); break;
        case 'zoom': this.zooming = a.phase !== 'end'; out.push({ ...a, ...(a.x != null ? toWin(a) : {}), a: a.a && toWin(a.a), b: a.b && toWin(a.b) }); break;
        case 'state': if (a.state !== 'engaged') { this.pointer('up'); this.pointerStop(); } out.push(a); break;
        default: out.push(a);
      }
    }
    if (out.length) this.emit('actions', out);
  }
  tuneOpts() { return this.opts.tune; }
  set(patch) {
    this.writeSettings({ hands: { ...(this.readSettings().hands || {}), ...patch } });
    this.engine.setOpts(this.tuneOpts());
    this.check();
  }
  get available() { return fs.existsSync(this.helper); }

  /** off | watching | engaged, and why it's off. */
  get state() { return { state: this.engine.state, camera: this.camera, why: this.why, permission: this.permission, stats: this.stats, recording: this.rec?.name || null }; }

  /** Should the camera be on right now? */
  wanted() {
    const o = this.opts;
    if (!o.enabled) return 'off';
    if (!this.available) return 'helper missing';
    if (this.permission === 'denied') return 'camera access denied';
    // Desk mode's conditions (unlocked, not idle, no call, the switch on); "go quiet" is about listening, not the camera
    if (!this.desk.state.active && this.desk.state.reason !== 'told to go quiet') return `desk mode: ${this.desk.state.reason}`;
    if (this.lowPower()) return 'Low Power Mode';
    return 'on';
  }

  check() {
    if (this.replaying) return; // (development) a clip is driving the engine, whatever the camera rules say
    const why = this.wanted();
    const was = this.why;
    this.why = why;
    if (why === 'on') this.start(); else this.stop();
    if (why !== was) { this.log('hands', { why, camera: this.camera.on }); this.emit('state', this.state); }
  }

  /** The helper is launched as its own app through LaunchServices and talks to us over a UNIX socket: macOS grants the
   *  camera to an app it can name ("ARES Vision"), and refuses the same binary spawned as a child without any prompt. */
  start() {
    if (this.child) { if (this.engine.state === 'off') this.engineStart(); return; }
    const bundle = path.resolve(this.helper, '..', '..', '..');
    const sock = path.join(this.supportDir, 'vision.sock');
    try { fs.unlinkSync(sock); } catch {}
    const conn = { sock: null, server: null, gone: false };
    this.child = conn;
    const gone = (why) => {
      if (conn.gone) return;
      conn.gone = true;
      clearTimeout(conn.timer);
      try { conn.server?.close(); } catch {}
      try { conn.sock?.destroy(); } catch {}
      if (this.child !== conn) return; // replaced already (a stop and a new start)
      this.child = null;
      this.camera = { on: false };
      this.dispatch(this.engine.stop());
      this.emit('state', this.state);
      if (this.why !== 'on') return;
      if (++this.restarts > 4) { this.why = `helper crashed (${why})`; this.log('hands', { why: this.why }); this.emit('state', this.state); return; }
      setTimeout(() => this.check(), 1500 * this.restarts);
    };
    conn.server = net.createServer((s) => {
      if (conn.sock) { s.destroy(); return; } // one helper
      conn.sock = s;
      clearTimeout(conn.timer);
      let buf = '';
      s.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { this.onLine(JSON.parse(line)); } catch { /* not JSON */ }
        }
      });
      s.on('close', () => gone('hung up'));
      s.on('error', () => gone('socket error'));
      for (const cmd of conn.queued || []) this.send(cmd);
      conn.queued = null;
    });
    conn.server.on('error', (err) => { this.log('hands', { why: `socket: ${err.message}` }); gone('socket'); });
    conn.server.listen(sock, () => {
      const opener = spawn('open', ['-a', bundle, '--args', '--serve', sock], { stdio: 'ignore' });
      opener.on('exit', (code) => { if (code) { this.log('hands', { why: `open failed (${code})` }); gone(`open ${code}`); } });
    });
    conn.timer = setTimeout(() => { if (!conn.sock) { this.log('hands', { why: 'helper did not connect' }); gone('no connection'); } }, 8000);
    conn.queued = [];
    this.engineStart();
  }

  engineStart() {
    const acts = this.engine.start();
    this.applyCamera(acts);
    this.send('start');
    this.dispatch(acts);
    this.emit('state', this.state);
  }

  stop() {
    if (this.engine.state !== 'off') this.dispatch(this.engine.stop());
    this.pointerStop();
    if (!this.child) return;
    const c = this.child;
    this.send('quit'); // the helper releases the camera and exits; hanging up below makes sure of it
    this.child = null;
    c.gone = true;
    clearTimeout(c.timer);
    setTimeout(() => { try { c.sock?.destroy(); } catch {} try { c.server?.close(); } catch {} }, 400);
    this.camera = { on: false };
    this.emit('state', this.state);
  }

  send(cmd) {
    const c = this.child;
    if (!c) return;
    if (!c.sock) { c.queued?.push(cmd); return; } // before the helper has connected
    try { c.sock.write(cmd + '\n'); } catch {}
  }

  /** The engine asked for a camera rate/resolution (watching vs engaged). */
  applyCamera(actions) {
    for (const a of actions) if (a.type === 'camera') { this.send(`rate ${a.fps}`); this.send(`res ${a.res}`); }
  }
  rate() { const c = this.engine.camera(); if (c && this.child) this.send(`rate ${c.fps}`); }

  onLine(m) {
    if (m.type !== 'hands' && m.type !== 'stats') this.log('vision', m); // state only, never joints
    switch (m.type) {
      case 'ready': this.restarts = 0; break;
      case 'permission': this.permission = m.status; if (m.status === 'denied') this.check(); this.emit('state', this.state); break;
      case 'camera':
        this.camera = m;
        if (!m.on && m.why === 'lid') { this.why = 'lid closed'; this.dispatch(this.engine.stop()); setTimeout(() => this.check(), 5000); }
        this.emit('state', this.state);
        break;
      case 'stats': this.stats = { fps: m.fps, ms: m.ms, at: Date.now() }; this.emit('stats', this.stats); break;
      case 'error': this.log('hands error', m); this.why = m.message; this.emit('state', this.state); break;
      case 'hands': this.frame(m); break;
      default: break;
    }
  }

  frame(m) {
    this.lastFrameAt = Date.now();
    const aspect = this.camera.w && this.camera.h ? this.camera.w / this.camera.h : 4 / 3;
    if (this.rec) {
      this.rec.frames.push({ ts: m.ts, key: m.key, face: m.face, hands: m.hands });
      this.rec.aspect = aspect;
      if (Date.now() > this.rec.until) this.recordStop();
    }
    const before = this.engine.state;
    const acts = this.engine.feed({ ts: m.ts, aspect, key: m.key, face: m.face, hands: m.hands });
    if (!acts.length) return;
    this.applyCamera(acts);
    this.dispatch(acts);
    if (this.engine.state !== before) { this.log('hands', { state: this.engine.state }); this.emit('state', this.state); }
  }

  /** The renderer answers "is there one of ARES's things under this point?" lazily; the engine asks synchronously, so
   *  the latest known hit areas are used (surface.js reports them anyway). */
  setHitTest(fn) { this.engine.onTarget = fn; }

  // ---- Development: record joint streams, replay them ------------------------------------------------------------
  /** Record the next `seconds` of joints to <support>/hands/clips/<name>-<n>.json (joints only, never video). */
  recordStart(name, kind = 'positive', seconds = 4) {
    if (!this.devBuild) return null;
    const dir = path.join(this.supportDir, 'hands', 'clips');
    fs.mkdirSync(dir, { recursive: true });
    const n = fs.readdirSync(dir).filter((f) => f.startsWith(`${name}-`)).length + 1;
    this.rec = { name: `${name}-${n}`, kind, expect: kind === 'positive' ? name : undefined, frames: [], until: Date.now() + seconds * 1000, dir };
    if (this.engine.state === 'off') this.check();
    this.emit('state', this.state);
    return this.rec.name;
  }
  recordStop() {
    const r = this.rec;
    if (!r) return null;
    this.rec = null;
    const file = path.join(r.dir, `${r.name}.json`);
    fs.writeFileSync(file, JSON.stringify({ kind: r.kind, expect: r.expect, aspect: r.aspect || 4 / 3, recorded: new Date().toISOString(), frames: r.frames }));
    this.log('hands clip', { file, frames: r.frames.length });
    this.emit('state', this.state);
    this.emit('recorded', { file, frames: r.frames.length });
    return file;
  }
  /** Feed a clip (as from scripts/hands-synth.js or a recording) through the live engine, at its own pace. */
  replay(clip, { realtime = true } = {}) {
    if (!this.devBuild) return;
    if (this.engine.state === 'off') { this.engine.reset('watching'); this.dispatch([{ type: 'state', state: 'watching' }]); }
    const frames = clip.frames || [];
    const t0 = frames[0]?.ts ?? 0, start = Date.now();
    this.replaying = true;
    clearTimeout(this.replayIdle);
    let i = 0;
    const step = () => {
      while (i < frames.length && (!realtime || frames[i].ts - t0 <= Date.now() - start)) {
        const f = frames[i++];
        const acts = this.engine.feed({ aspect: clip.aspect || 4 / 3, ...f });
        if (acts.length) { this.applyCamera(acts); this.dispatch(acts); }
      }
      if (i < frames.length) setTimeout(step, 8);
      else { this.emit('state', this.state); this.replayIdle = setTimeout(() => { this.replaying = false; this.check(); }, 30_000); } // the camera rules return after a quiet half minute
    };
    step();
  }

  quit() {
    clearInterval(this.timer);
    this.rec = null;
    this.pointerStop();
    const c = this.child;
    if (c) { this.send('quit'); this.child = null; try { c.sock?.destroy(); } catch {} try { c.server?.close(); } catch {} }
    try { fs.unlinkSync(path.join(this.supportDir, 'vision.sock')); } catch {}
  }
}

/** The helper lives in its own .app bundle (macOS grants the camera only to something it can name). */
function visionPath(app, dir) {
  const base = app.isPackaged ? process.resourcesPath : path.join(dir, 'native', 'build');
  return path.join(base, 'ARES Vision.app', 'Contents', 'MacOS', 'ares-vision');
}

module.exports = { Vision, visionPath };
