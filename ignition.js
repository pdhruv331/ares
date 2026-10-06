// Ignition (docs/ignition-prompt.md §2, §3): the handshake between ARES and the ignition helper ("ARES Ignition.app",
// native/AresIgnition.swift) that draws the cold reactor over the offline still while ARES is quit, and the record of every
// start-up step so the charge-to-wake follows the real start (the helper's ring, or the window's own on a Dock launch).
//
//   <support>/ignition/ignition.sock   ARES listens; the helper connects and reads JSON lines:
//        {"type":"hello","steps":[…],"ready":bool}  {"type":"step","name","status","detail","total"}  {"type":"ready"}
//        {"type":"handover"} (the live scene is up: fade out and exit)  {"type":"exit"}
//      and may send {"type":"hello","version"} {"type":"wake-done"} (its wake animation finished; ARES reveals the live scene)
//   <support>/ignition/ares.pid        ARES's pid while it runs (the helper runs only while this pid is dead)
//   <support>/ignition/geometry.json   the reactor's place on each display (wallpaper.js geometries()), for the helper and the still
//   <support>/ignition/shutdown.json   { state: 'running' | 'clean', why, at, version, uptime }: how ARES last stopped (the wake line)
//   <support>/ignition/config.json     what the helper needs: the app to launch, sounds on/off
const EventEmitter = require('events');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const STEPS = ['memory', 'voice', 'ears', 'brain', 'link', 'scene'];
const AGENT_LABEL = 'com.dhruv.ares.ignition';

class Ignition extends EventEmitter {
  /**
   * @param {object} o  { supportDir, appDir, log, isPackaged, version, helperApp (path to "ARES Ignition.app"), appPath (ARES.app), readSettings, writeSettings }
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.dir = path.join(this.supportDir, 'ignition');
    fs.mkdirSync(this.dir, { recursive: true });
    this.steps = new Map();   // name -> { name, status, detail, at }
    this.ready = false;
    this.readyLine = null;
    this.clients = new Set();
    this.server = null;
    this.helper = null;       // the connected helper's socket, if any
    this.last = this.readRecord();
    this.startedAt = Date.now();
  }

  // ---- Records --------------------------------------------------------------------------------------------------------------
  readRecord() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'shutdown.json'), 'utf8')); } catch { return null; }
  }
  writeRecord(rec) { try { fs.writeFileSync(path.join(this.dir, 'shutdown.json'), JSON.stringify(rec)); } catch {} }
  /**
   * Why ARES was off and for how long, from the last record: 'clean' (she was quit), 'crash' (the record still said running),
   * 'restart' (the Mac rebooted since), 'update' (a new version), 'unknown' (no record: the first run).
   */
  lastShutdown() {
    const rec = this.last;
    if (!rec) return { why: 'unknown', first: true, offMs: 0, at: null };
    const bootAt = Date.now() - os.uptime() * 1000;
    let why = rec.state === 'running' ? 'crash' : (rec.why || 'clean');
    const lastSeen = rec.at || rec.seenAt || Date.now();
    if (bootAt > lastSeen + 5000) why = 'restart'; // the Mac came up after ARES last ran (a crash before a reboot reads as a restart)
    else if (rec.version && this.version && rec.version !== this.version) why = 'update';
    return { why, first: false, offMs: Math.max(0, Date.now() - lastSeen), at: lastSeen, record: rec };
  }

  // ---- Lifecycle ------------------------------------------------------------------------------------------------------------
  /** Is the helper running right now (it keeps <dir>/helper.pid while it does)? Checked once at start: the backdrop then waits for it. */
  get helperAlive() {
    if (this._helperAlive != null) return this._helperAlive;
    try { const pid = Number(fs.readFileSync(path.join(this.dir, 'helper.pid'), 'utf8')); process.kill(pid, 0); this._helperAlive = pid > 0; } catch { this._helperAlive = false; }
    return this._helperAlive;
  }
  start() {
    void this.helperAlive;
    try { fs.writeFileSync(path.join(this.dir, 'ares.pid'), String(process.pid)); } catch {}
    this.writeRecord({ state: 'running', at: Date.now(), seenAt: Date.now(), version: this.version });
    this.beat = setInterval(() => this.writeRecord({ state: 'running', at: Date.now(), seenAt: Date.now(), version: this.version }), 60_000); // for the crash record's time
    this.writeConfig();
    const sock = path.join(this.dir, 'ignition.sock');
    try { fs.unlinkSync(sock); } catch {}
    this.server = net.createServer((c) => this.accept(c));
    this.server.on('error', (err) => this.log('ignition socket', err.message));
    this.server.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch {} });
  }
  /** Quitting: the clean record (why: 'quit' | 'restart' | 'update' | 'power down'), then the helper takes the reactor over. */
  stop(why = 'quit', { launchHelper = true } = {}) {
    clearInterval(this.beat);
    this.writeRecord({ state: 'clean', why, at: Date.now(), version: this.version });
    for (const c of this.clients) { try { c.write(JSON.stringify({ type: 'exit' }) + '\n'); c.end(); } catch {} }
    this.server?.close();
    try { fs.unlinkSync(path.join(this.dir, 'ares.pid')); } catch {}
    if (launchHelper) this.launchHelper();
  }
  writeConfig() {
    const s = this.readSettings();
    const cfg = { app: this.appPath || null, sounds: (s.power || {}).sounds !== false, dev: !this.isPackaged, version: this.version };
    try { fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify(cfg)); } catch {}
  }
  writeGeometry(list) {
    try { fs.writeFileSync(path.join(this.dir, 'geometry.json'), JSON.stringify({ at: Date.now(), displays: list })); } catch {}
  }

  // ---- Steps ----------------------------------------------------------------------------------------------------------------
  /** A start-up step: status 'start' | 'ok' | 'fail'. The helper and the window follow the share of steps finished. */
  step(name, status, detail = '') {
    const s = { name, status, detail: String(detail || ''), at: Date.now(), total: STEPS.length };
    this.steps.set(name, s);
    this.log('ignition step', { name, status, detail: s.detail });
    this.emit('step', s);
    this.send({ type: 'step', ...s });
  }
  /** Everything's up: the charge completes, the wake plays. */
  setReady(line = null) {
    if (this.ready) return;
    this.ready = true;
    this.readyLine = line;
    this.log('ignition ready', { ms: Date.now() - this.startedAt, helper: Boolean(this.helper), failed: [...this.steps.values()].filter((s) => s.status === 'fail').map((s) => s.name) });
    this.emit('ready', { line });
    this.send({ type: 'ready' });
    // Without a helper the window plays the wake itself and the live scene is simply there; with one, the reveal waits for its wake
    if (!this.helper) this.emit('handover');
    else this.handoverTimer = setTimeout(() => this.handover(), 4000); // (if the helper never says so)
  }
  handover() {
    if (this.handedOver) return;
    this.handedOver = true;
    clearTimeout(this.handoverTimer);
    this.emit('handover');
    this.send({ type: 'handover' });
  }
  state() { return { steps: [...this.steps.values()], ready: this.ready, helper: Boolean(this.helper), line: this.readyLine, last: this.lastShutdown() }; }

  // ---- The helper's socket ------------------------------------------------------------------------------------------------------
  accept(c) {
    this.clients.add(c);
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'hello') { this.helper = c; this.log('ignition helper connected', { version: msg.version }); this.emit('helper', true); }
        if (msg.type === 'wake-done') this.handover();
      }
    });
    c.on('close', () => { this.clients.delete(c); if (this.helper === c) { this.helper = null; this.emit('helper', false); if (this.ready && !this.handedOver) this.handover(); } });
    c.on('error', () => {});
    c.write(JSON.stringify({ type: 'hello', steps: [...this.steps.values()], ready: this.ready, total: STEPS.length }) + '\n');
    if (this.ready) c.write(JSON.stringify({ type: 'ready' }) + '\n');
  }
  send(msg) { const line = JSON.stringify(msg) + '\n'; for (const c of this.clients) { try { c.write(line); } catch {} } }

  // ---- The helper app -------------------------------------------------------------------------------------------------------------
  /** Start the helper (it shows the cold reactor until ARES runs again). Packaged builds, or ARES_IGNITION_HELPER=1 in development. */
  launchHelper() {
    if (!this.helperApp || !fs.existsSync(this.helperApp)) return false;
    if (!this.isPackaged && process.env.ARES_IGNITION_HELPER !== '1') return false;
    if ((this.readSettings().power || {}).helper === false) return false;
    try {
      const p = spawn('open', ['-a', this.helperApp, '--args', '--support', this.supportDir], { detached: true, stdio: 'ignore' });
      p.unref();
      this.log('ignition helper launched');
      return true;
    } catch (err) { this.log('ignition helper launch failed', err.message); return false; }
  }
  /** Tell a running helper to quit (ARES is up: it should be gone already). */
  quitHelper() { execFile('pkill', ['-x', 'ares-ignition'], () => {}); }

  // ---- Login item (a LaunchAgent for the helper; packaged builds only) ------------------------------------------------------------
  get agentFile() { return path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`); }
  get agentOn() { return fs.existsSync(this.agentFile); }
  setAgent(on) {
    if (!this.isPackaged) return false;
    if (!on) { try { execFile('launchctl', ['bootout', `gui/${process.getuid()}/${AGENT_LABEL}`], () => {}); fs.unlinkSync(this.agentFile); } catch {} this.log('ignition agent', { on: false }); return true; }
    if (!this.helperApp) return false;
    const bin = path.join(this.helperApp, 'Contents', 'MacOS', 'ares-ignition');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${bin}</string><string>--support</string><string>${this.supportDir}</string><string>--login</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
    try {
      fs.mkdirSync(path.dirname(this.agentFile), { recursive: true });
      fs.writeFileSync(this.agentFile, plist);
      this.log('ignition agent', { on: true });
      return true;
    } catch (err) { this.log('ignition agent failed', err.message); return false; }
  }
}

module.exports = { Ignition, STEPS };
