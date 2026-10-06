// The reactor's readouts (docs/reactor-prompt.md, section 5), main-process side: the live values behind the HOST, CLAUDE and
// BATTERY callouts (jobs come from the Work feed the window already has), pushed to the window and the wallpaper backdrop
// when they change and every half minute, a fuller `detail()` for an open card, and the cards' tier-2 actions (lock, sleep,
// Low Power Mode, pause the projects), each recorded in the audit log.
const { execFile } = require('child_process');
const EventEmitter = require('events');
const os = require('os');

const EVERY_MS = 30_000;
const run = (file, args, timeout = 8000) => new Promise((resolve) => execFile(file, args, { timeout }, (err, out) => resolve(err ? null : String(out))));

class Readouts extends EventEmitter {
  /**
   * @param {object} o
   * @param {(…) => void} o.log  @param {() => object} o.readSettings  @param {object} o.powerMonitor
   * @param {() => object|null} o.usage        claude-usage.js's snapshot(), or null
   * @param {() => Array<object>} o.jobs       the jobs list (for the busiest one)
   * @param {() => {paired: boolean, connected: boolean, name?: string}} o.phone
   * @param {() => boolean|null} o.tailscale   running, off, or null = not set up
   * @param {() => boolean} o.theme            the ARES OS theme is on
   * @param {() => object} o.autonomy          { pauseProjects(): string[] }
   * @param {{record: Function}} [o.audit]
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.battery = null;
    this.lowPower = false;
    this.lastKey = '';
    this.timer = null;
  }
  start() {
    this.refresh('start');
    this.timer = setInterval(() => this.refresh('tick'), EVERY_MS);
    for (const e of ['on-ac', 'on-battery', 'resume', 'unlock-screen']) this.powerMonitor.on(e, () => setTimeout(() => this.refresh(e), 1500));
  }
  stop() { clearInterval(this.timer); }

  /** The battery from pmset (percentage, charging, source, time left), cached between refreshes. */
  async readBattery() {
    const out = await run('/usr/bin/pmset', ['-g', 'batt']);
    if (!out) return null;
    const pct = Number(out.match(/(\d+)%/)?.[1]);
    if (!Number.isFinite(pct)) return null;
    const left = out.match(/(\d+):(\d+) remaining/);
    const charging = /;\s*charging/i.test(out) || /finishing charge/i.test(out);
    const ac = /AC Power/i.test(out);
    return { pct, charging, source: ac ? 'ac' : 'battery', timeLeft: left ? Number(left[1]) * 60 + Number(left[2]) : null, charged: /charged/i.test(out) };
  }
  async readLowPower() {
    const out = await run('/usr/bin/pmset', ['-g']);
    return Boolean(out && /lowpowermode\s+1/.test(out));
  }
  /** What's keeping the Mac awake (pmset assertions), for the BATTERY card. */
  async readAssertions() {
    const out = await run('/usr/bin/pmset', ['-g', 'assertions']);
    if (!out) return [];
    const names = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*pid \d+\(([^)]+)\):.*?(PreventUserIdleSystemSleep|PreventUserIdleDisplaySleep|PreventSystemSleep|NoIdleSleepAssertion|NoDisplaySleepAssertion)\s+named:\s*"([^"]*)"/);
      if (!m) continue;
      const who = m[1] === 'ARES' || /electron/i.test(m[1]) ? 'ARES' : m[1];
      names.add(who === 'ARES' && /reachable/i.test(m[3]) ? 'ARES (stay reachable)' : who);
    }
    return [...names].slice(0, 6);
  }

  snapshot() {
    const usage = this.usage?.() || null;
    const w = (k) => { const x = usage?.windows?.[k]; return x ? { pct: x.pct, resetsAt: x.resetsAt || null, exact: Boolean(x.exact) } : null; };
    const reserve = this.readSettings().claudeReserve || {};
    const running = (this.jobs?.() || []).filter((j) => j.status === 'running');
    const busiest = running.sort((a, b) => (b.steps || 0) - (a.steps || 0) || (a.started || 0) - (b.started || 0))[0];
    const up = os.uptime();
    const phone = this.phone?.() || { paired: false, connected: false };
    return {
      host: {
        name: os.hostname().split('.')[0], online: true,
        uptime: up >= 86400 ? `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h` : `${Math.floor(up / 3600)}h ${String(Math.floor((up % 3600) / 60)).padStart(2, '0')}m`,
        phone, tailscale: this.tailscale?.() ?? null, reachable: this.readSettings().stayReachable !== false, theme: Boolean(this.theme?.()),
      },
      claude: { five: w('five_hour'), week: w('seven_day'), reserve: { fiveHour: reserve.fiveHour ?? 90, weekly: reserve.weekly ?? 95 }, busiest: busiest ? busiest.title : null, status: usage?.status || null },
      battery: this.battery ? { ...this.battery, lowPower: this.lowPower, awake: this.awake || [] } : null,
    };
  }
  async refresh(why) {
    this.battery = await this.readBattery();
    this.lowPower = await this.readLowPower();
    this.push(why);
  }
  /** Send the snapshot on if anything in it changed (or `force`). */
  push(why, force = false) {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.lastKey && !force) return;
    this.lastKey = key;
    this.emit('change', snap, why);
  }
  /** The fuller picture for an open card (what keeps the Mac awake). */
  async detail() {
    this.awake = await this.readAssertions();
    this.battery = await this.readBattery();
    this.lowPower = await this.readLowPower();
    return this.snapshot();
  }

  /** The cards' actions: tier 2 (the owner, from the Mac's own window), done and recorded. */
  async act(name, source = 'mac') {
    const record = (what, ok = true, extra = {}) => this.audit?.record?.({ what, tier: 2, kind: 'readout', source, ok, ...extra });
    switch (name) {
      case 'lock': {
        const ok = (await run('/usr/bin/pmset', ['displaysleepnow'])) != null;
        record('locked the Mac (display sleep)', ok);
        return { ok, message: ok ? 'Locked, sir.' : "I couldn't lock the screen." };
      }
      case 'sleep': {
        record('put the Mac to sleep');
        setTimeout(() => run('/usr/bin/pmset', ['sleepnow']), 400); // after the reply has gone out
        return { ok: true, message: 'Going to sleep, sir.' };
      }
      case 'lowpower': {
        const out = await run('/usr/bin/pmset', ['-a', 'lowpowermode', '1']);
        const on = await this.readLowPower();
        if (on) { this.lowPower = true; this.push('lowpower', true); record('Low Power Mode on'); return { ok: true, message: 'Low Power Mode is on, sir.' }; }
        record('Low Power Mode: needs the user (System Settings opened)', false, { note: out == null ? 'pmset refused (needs an administrator)' : 'not applied' });
        await run('/usr/bin/open', ['x-apple.systempreferences:com.apple.Battery-Settings.extension']);
        return { ok: false, message: 'macOS only lets you switch Low Power Mode yourself, sir: I opened Battery settings.' };
      }
      case 'pause-projects': {
        const paused = this.autonomy?.()?.pauseProjects?.() || [];
        record(`paused the projects${paused.length ? `: ${paused.join(', ')}` : ' (none running)'}`);
        return { ok: true, message: paused.length ? `Paused ${paused.join(', ')}, sir. Say "resume everything" when you want them back.` : 'No project is running, sir.' };
      }
      default:
        return { ok: false, message: `Unknown action ${name}.` };
    }
  }
}

module.exports = { Readouts };
