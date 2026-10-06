// Standby, power down and dormancy (docs/ignition-prompt.md §4b, §4c, §4f): ARES keeps running in standby with the listener off,
// desk mode held and the desktop quiet. POWER DOWN does not quit the process (a process launch can't be made seamless: the theme
// restarts, the screen blinks, decided 2026-10-06): it plays the spin-down with a ghost log of the real steps, then goes DORMANT:
// every service stopped (listener, phone, calls, voicemail, dashboard, calendar, tasks, panels, camera; jobs and routines held),
// memory saved, the window left drawing the cold gold reactor at a trickle. Waking re-initialises the services in place with the
// same charge-to-wake. The only true quit is ◉ → "Quit ARES Completely" (quitFully), which hands the reactor to the ignition helper.
// Auto standby (lock / idle / night / low battery, wake on unlock or presence) is here too. Every change is logged in the audit log
// and announced to the window, the backdrop, the phone and the menu bar through the 'change' event.
//
//   power.standby(on, why)   power.toggle(why)   power.powerDown(why)   power.wake(why)   power.quitFully(why)
//   power.status() → { listening, link, jobs }
//   events: 'change' { mode: 'online'|'tostandby'|'standby'|'fromstandby'|'spindown'|'dormant'|'charging', status, why }
//           'step'   { name, status, detail }   (the spin-down's ghost log, in reverse boot order)
//           'say'    { line }                   (spoken + typed by the window: "Powering down. Goodnight, sir.")
const EventEmitter = require('events');

const TICK_MS = 30_000;
const SPINDOWN_MIN_MS = 3900;  // the animation's length (renderer/ignite.js TIMING.spindown)
const SPINDOWN_CAP_MS = 25_000; // memory consolidation's cap at quit (main.js)
const DEFAULTS = { auto: { lock: false, idleMin: 0, nightHour: null, lowBattery: false, wakeOnReturn: true }, sounds: true, wakeLine: 'spoken', helperAtLogin: true, keepAwakeOff: false };

class Power extends EventEmitter {
  /**
   * @param {object} o
   * @param {(…) => void} o.log  @param {() => object} o.readSettings  @param {(patch: object) => void} o.writeSettings
   * @param {{ record(e): void }} o.audit
   * @param {object} o.listener   mute/unmute, muted, awake, setAwake     @param {object} o.desk   hold(on)
   * @param {() => object[]} o.jobs  jobs.list()   @param {(id, why) => void} o.pauseJob
   * @param {() => boolean} o.linkAlive   a phone is connected
   * @param {() => Promise} o.saveMemory   the quit consolidation (resolves when saved)   @param {() => number} o.unsaved
   * @param {(msg) => void} o.phone   broadcast to the phones   @param {() => void} o.closeEars   @param {() => void} o.voiceOff
   * @param {() => void} o.quit   the real quit   @param {object} o.powerMonitor
   * @param {{ sleep: () => Promise, wake: () => Promise }} o.services   stop everything for dormancy / start it all again (reporting steps)
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.mode = 'online';
    this.dormantSince = null;
    this.quitAllowed = false; // only ◉ → Quit ARES Completely (and a system shutdown) may end the process
    this.prior = null;      // the listener's state before standby { muted, awake }
    this.autoWhy = null;    // why auto standby put her in standby (so wake-on-return applies)
    this.quitting = false;
    this.timer = null;
    this.nightDone = null;  // the date the night-hour standby already ran
  }
  get opts() { return { ...DEFAULTS, ...(this.readSettings().power || {}), auto: { ...DEFAULTS.auto, ...((this.readSettings().power || {}).auto || {}) } }; }
  save(patch) { this.writeSettings({ power: { ...(this.readSettings().power || {}), ...patch } }); }
  setAuto(patch) { this.save({ auto: { ...this.opts.auto, ...patch } }); this.log('power auto', this.opts.auto); }

  start() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.powerMonitor.on('lock-screen', () => { this.locked = true; if (this.opts.auto.lock && this.mode === 'online') this.standby(true, 'auto: screen locked'); });
    this.powerMonitor.on('unlock-screen', () => { this.locked = false; this.back('unlock'); });
    this.powerMonitor.on('resume', () => setTimeout(() => this.back('wake'), 1500));
  }
  stop() { clearInterval(this.timer); }

  /** The standby status line: listening off, the phone link, running jobs. */
  status() {
    const running = this.jobs().filter((j) => ['running', 'queued', 'approval'].includes(j.status)).length;
    return { listening: this.mode === 'online' && !this.listener.muted, link: Boolean(this.linkAlive()), jobs: running };
  }

  /** Standby on or off. Instant on the way back: no cold start. */
  standby(on, why = 'user') {
    if (this.quitting || this.mode === 'dormant' || this.mode === 'charging') return false;
    if (on && this.mode !== 'online') return false;
    if (!on && this.mode !== 'standby' && this.mode !== 'tostandby') return false;
    if (on) {
      this.prior = { muted: this.listener.muted, awake: this.listener.awake };
      if (!this.listener.muted) this.listener.mute();
      this.desk?.hold(true);
      this.autoWhy = why.startsWith('auto') ? why : null;
      this.mode = 'tostandby';
      this.log('standby', { on: true, why });
      this.audit?.record({ kind: 'power', what: 'standby', why, tier: 1 });
      this.emit('change', { mode: 'tostandby', status: this.status(), why });
      clearTimeout(this.settle);
      this.settle = setTimeout(() => { if (this.mode === 'tostandby') { this.mode = 'standby'; this.emit('change', { mode: 'standby', status: this.status(), why }); } }, 1700);
    } else {
      clearTimeout(this.settle);
      this.mode = 'fromstandby';
      this.desk?.hold(false);
      if (this.prior && !this.prior.muted) this.listener.unmute();
      if (this.prior?.awake) this.listener.setAwake(true);
      this.prior = null; this.autoWhy = null;
      this.log('standby', { on: false, why });
      this.audit?.record({ kind: 'power', what: 'wake from standby', why, tier: 1 });
      this.emit('change', { mode: 'fromstandby', status: this.status(), why });
      this.settle = setTimeout(() => { if (this.mode === 'fromstandby') { this.mode = 'online'; this.emit('change', { mode: 'online', status: this.status(), why }); } }, 1000);
    }
    return true;
  }
  toggle(why = 'user') { if (this.mode === 'dormant') return this.wake(why); return this.standby(this.mode === 'online', why); }
  /** Back at the Mac (unlock, wake from sleep, desk-mode presence): wake if auto standby put her there. */
  back(how) {
    if (!this.autoWhy || !this.opts.auto.wakeOnReturn) return;
    if (this.mode !== 'standby' && this.mode !== 'tostandby') return;
    this.standby(false, `auto: back (${how})`);
  }

  /** Auto standby: every 30 s. Never an auto power down. */
  tick() {
    if (this.mode !== 'online' || this.quitting) return;
    const a = this.opts.auto;
    const idleMin = this.powerMonitor.getSystemIdleTime() / 60;
    if (a.idleMin > 0 && idleMin >= a.idleMin) return this.standby(true, `auto: idle ${a.idleMin} min`);
    if (Number.isInteger(a.nightHour)) {
      const now = new Date(), day = now.toDateString();
      if (now.getHours() === a.nightHour && this.nightDone !== day) { this.nightDone = day; return this.standby(true, `auto: night (${a.nightHour}:00)`); }
    }
    if (a.lowBattery && this.powerMonitor.isOnBatteryPower()) {
      const pct = this.batteryPct?.();
      if (Number.isFinite(pct) && pct <= 15) return this.standby(true, `auto: low battery (${pct}%)`);
    }
  }

  /**
   * Power down: the spin-down with the real steps in reverse, then DORMANT (the process stays; see the top). Returns the line she
   * says first (so the caller can answer the voice command), or null if already on the way out. `fully` = the real quit instead.
   */
  powerDown(why = 'user', { fully = false } = {}) {
    if (this.quitting || this.mode === 'dormant' || this.mode === 'charging') return null;
    this.quitting = true;
    this.fully = fully;
    clearTimeout(this.settle);
    const running = this.jobs().filter((j) => j.status === 'running');
    const line = running.length
      ? `${running.length === 1 ? 'One job is' : `${running.length} jobs are`} running; ${running.length === 1 ? 'it\'ll' : 'they\'ll'} pause. Powering down. Goodnight, sir.`
      : pickLine(why);
    this.log('power down', { why, running: running.length, unsaved: this.unsaved?.() || 0 });
    this.audit?.record({ kind: 'power', what: 'power down', why, tier: 1, detail: running.length ? `${running.length} jobs paused` : '' });
    this.mode = 'spindown';
    this.saidDone = false; this.onSaid = null;
    this.emit('say', { line });
    this.emit('change', { mode: 'spindown', status: this.status(), why, line });
    const t0 = Date.now();
    const step = (name, status, detail = '') => this.emit('step', { name, status, detail });
    (async () => {
      // 1. jobs paused
      step('jobs', 'start');
      for (const j of running) { try { this.pauseJob(j.id, 'paused for power down'); } catch {} }
      step('jobs', 'ok', running.length ? `${running.length} paused` : 'none running');
      // 2. memory saved (the quit consolidation, within its cap)
      step('memory', 'start');
      const unsaved = this.unsaved?.() || 0;
      if (unsaved) {
        const r = await Promise.race([this.saveMemory().then(() => 'saved', () => 'failed'), new Promise((res) => setTimeout(() => res('timeout'), SPINDOWN_CAP_MS))]);
        step('memory', r === 'saved' ? 'ok' : 'fail', r === 'saved' ? `${unsaved} turns saved` : r === 'timeout' ? 'ran out of time' : 'could not save');
      } else step('memory', 'ok', 'nothing new');
      // 3. phone notified
      step('phone', 'start');
      try { this.phone?.({ type: 'power', mode: 'spindown', status: this.status(), why, note: 'phone told' }); step('phone', 'ok', this.linkAlive() ? 'told' : 'not connected'); } catch (err) { step('phone', 'fail', err.message); }
      // Her line plays through the listener's speaker (echo-cancelled): let her finish it before the ears close, within a cap
      await this.waitSaid(7000);
      // 4. ears closed, 5. voice off
      step('ears', 'start'); try { this.closeEars?.(); step('ears', 'ok', 'closed'); } catch (err) { step('ears', 'fail', err.message); }
      step('voice', 'start'); try { this.voiceOff?.(); step('voice', 'ok', 'off'); } catch (err) { step('voice', 'fail', err.message); }
      // the animation gets its full length even when the steps were quick
      const left = SPINDOWN_MIN_MS - (Date.now() - t0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      step('reactor', 'ok', 'cold');
      this.emit('cold');
      if (this.fully) { this.quitAllowed = true; setTimeout(() => this.quit(), 350); return; }
      // Dormant: everything else stops; the window keeps the cold reactor
      try { await this.services?.sleep?.(); } catch (err) { this.log('dormant: sleep failed', err.message); }
      this.mode = 'dormant'; this.quitting = false; this.dormantSince = Date.now();
      this.log('dormant', { why });
      this.emit('change', { mode: 'dormant', status: this.status(), why });
    })().catch((err) => { this.log('power down failed', err.message); this.quitting = false; });
    return line;
  }
  /** The window finished speaking the power-down line (renderer/power.js) → the ears and the voice may stop. */
  lineSaid() { this.saidDone = true; this.onSaid?.(); }
  waitSaid(ms) { if (this.saidDone) return Promise.resolve(); return new Promise((r) => { this.onSaid = r; setTimeout(r, ms); }); }
  /** ◉ → Quit ARES Completely: the spin-down, then the process ends and the ignition helper takes the reactor over. */
  quitFully(why = 'menu') { this.log('quit fully', { why, mode: this.mode }); return this.powerDown(why, { fully: true }); }

  /** Wake from dormancy: the charge-to-wake follows the services starting again (main.js reports the steps). Instant from standby. */
  wake(why = 'user') {
    if (this.mode === 'standby' || this.mode === 'tostandby') return this.standby(false, why);
    if (this.mode !== 'dormant') return false;
    this.mode = 'charging';
    this.log('wake from dormant', { why });
    this.audit?.record({ kind: 'power', what: 'wake', why, tier: 1 });
    this.emit('change', { mode: 'charging', status: this.status(), why });
    (async () => {
      try { await this.services?.wake?.(); } catch (err) { this.log('wake failed', err.message); }
    })();
    return true;
  }
  /** The window finished its wake animation (or main.js's fallback): online. */
  setOnline(why = 'wake') {
    if (this.mode !== 'charging') return;
    this.mode = 'online'; this.dormantSince = null;
    this.emit('change', { mode: 'online', status: this.status(), why });
  }
}

function pickLine(why) {
  const h = new Date().getHours();
  const night = h >= 20 || h < 5;
  const lines = night
    ? ['Powering down. Goodnight, sir.', 'Reactor cold in a moment. Goodnight.', 'Shutting down for the night, sir. Sleep well.']
    : ['Powering down, sir. Back when you need me.', 'Reactor cold in a moment. Hold the core to wake me.', 'Powering down. Until later, sir.'];
  return lines[Math.floor(Math.random() * lines.length)];
}

module.exports = { Power, DEFAULTS };
