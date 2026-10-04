// Hand gestures, main-process side (docs/hand-tracking-prompt.md). Runs ares-vision (native/AresVision.swift), the one
// camera owner, and feeds its joint frames through the gesture engine (hands.js); the actions go to the window, where
// renderer/hands.js drives the same panel code the mouse does.
//
// The camera is ON only while: the "Hand Gestures" switch is on, desk mode is active (so: unlocked, not idle, no call
// or other mic user, not told to go quiet), and Low Power Mode is off. The helper itself also stops when the lid closes.
// Frames never leave the helper; this file only ever sees joints. Nothing here is logged beyond state changes.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { HandEngine } = require('./hands');

class Vision extends EventEmitter {
  /** opts: { helper, log, readSettings, writeSettings, supportDir, powerMonitor, desk, lowPower: () => bool, devBuild } */
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
    return { enabled: Boolean(h.enabled), tune: h.tune || {} };
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
    if (!this.desk.state.active) return `desk mode: ${this.desk.state.reason}`;
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

  start() {
    if (this.child) { if (this.engine.state === 'off') this.engineStart(); return; }
    this.child = spawn(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line) continue;
        try { this.onLine(JSON.parse(line)); } catch { /* not JSON */ }
      }
    });
    this.child.stderr.on('data', (d) => this.log('vision-stderr', String(d).trim().slice(0, 300)));
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.camera = { on: false };
      this.emit('actions', this.engine.stop());
      this.emit('state', this.state);
      if (this.why !== 'on') return;
      if (++this.restarts > 4) { this.why = `helper crashed (${code ?? signal})`; this.log('hands', { why: this.why }); this.emit('state', this.state); return; }
      setTimeout(() => this.check(), 1500 * this.restarts);
    });
    this.engineStart();
  }

  engineStart() {
    const acts = this.engine.start();
    this.applyCamera(acts);
    this.send('start');
    this.emit('actions', acts);
    this.emit('state', this.state);
  }

  stop() {
    if (this.engine.state !== 'off') this.emit('actions', this.engine.stop());
    if (!this.child) return;
    this.send('stop');
    const c = this.child;
    setTimeout(() => { if (this.child === c) { c.kill(); } }, 400); // fully gone: the camera light must go off
    this.child = null;
    this.camera = { on: false };
    this.emit('state', this.state);
  }

  send(cmd) { try { this.child?.stdin.write(cmd + '\n'); } catch {} }

  /** The engine asked for a camera rate/resolution (watching vs engaged). */
  applyCamera(actions) {
    for (const a of actions) if (a.type === 'camera') { this.send(`rate ${a.fps}`); this.send(`res ${a.res}`); }
  }
  rate() { const c = this.engine.camera(); if (c && this.child) this.send(`rate ${c.fps}`); }

  onLine(m) {
    switch (m.type) {
      case 'ready': this.restarts = 0; break;
      case 'permission': this.permission = m.status; if (m.status === 'denied') this.check(); this.emit('state', this.state); break;
      case 'camera':
        this.camera = m;
        if (!m.on && m.why === 'lid') { this.why = 'lid closed'; this.emit('actions', this.engine.stop()); setTimeout(() => this.check(), 5000); }
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
    this.emit('actions', acts);
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
    if (this.engine.state === 'off') { this.engine.reset('watching'); this.emit('actions', [{ type: 'state', state: 'watching' }]); }
    const frames = clip.frames || [];
    const t0 = frames[0]?.ts ?? 0, start = Date.now();
    this.replaying = true;
    clearTimeout(this.replayIdle);
    let i = 0;
    const step = () => {
      while (i < frames.length && (!realtime || frames[i].ts - t0 <= Date.now() - start)) {
        const f = frames[i++];
        const acts = this.engine.feed({ aspect: clip.aspect || 4 / 3, ...f });
        if (acts.length) { this.applyCamera(acts); this.emit('actions', acts); }
      }
      if (i < frames.length) setTimeout(step, 8);
      else { this.emit('state', this.state); this.replayIdle = setTimeout(() => { this.replaying = false; this.check(); }, 30_000); } // the camera rules return after a quiet half minute
    };
    step();
  }

  quit() {
    clearInterval(this.timer);
    this.rec = null;
    if (this.child) { this.send('stop'); this.child.kill(); this.child = null; }
  }
}

function visionPath(app, dir) {
  return app.isPackaged ? path.join(process.resourcesPath, 'ares-vision') : path.join(dir, 'native', 'build', 'ares-vision');
}

module.exports = { Vision, visionPath };
