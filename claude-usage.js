// How much of the user's Claude subscription limits is left (the 5-hour and weekly windows), without API billing.
//
// Claude Code reports the plan's rate-limit state to headless (stream-json) processes: each turn carries a
//   {"type":"rate_limit_event","rate_limit_info":{"status","resetsAt","rateLimitType",
//     "unifiedWindows":{"five_hour":{"utilization":0.85,"resetsAt":<epoch s>},"seven_day":{...}}}}
// Every Claude process ARES runs (the brain, background jobs, the dashboard) passes its messages through observe(), so
// the reading is exact as of ARES's last Claude call. Other Claude Code sessions share the same limits, so between
// ARES's calls it can be out of date: then (and when there's no reading at all) the numbers are an ESTIMATE from the
// tokens ARES has used since, scaled by how much of the limit earlier calls used per token, and labelled as such.
const EventEmitter = require('events');
const fs = require('fs');

const WINDOWS = { five_hour: '5-hour', seven_day: 'weekly' };
const WARN = [0.8, 0.95];
const FRESH_MS = 10 * 60_000; // a reading this recent counts as current

class ClaudeUsage extends EventEmitter {
  constructor({ file, log }) {
    super();
    this.file = file;
    this.log = log;
    // windows: { five_hour: { util, resetsAt (ms), at (ms) } }, tokensSince: tokens since the last reading,
    // perToken: { window: utilisation per 1k tokens (moving average) }, warned: { 'five_hour@<reset>': 0.8 }
    this.s = { windows: {}, tokensSince: 0, perToken: {}, warned: {}, status: null };
    try { Object.assign(this.s, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
    current = this;
  }

  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.s)); } catch {} }

  /** Any stream-json message from a Claude Code process. */
  observe(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'result' && msg.usage) {
      const u = msg.usage;
      this.s.tokensSince += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1;
      this.save();
      return;
    }
    if (msg.type !== 'rate_limit_event') return;
    const info = msg.rate_limit_info || {};
    const now = Date.now();
    const wins = info.unifiedWindows || (info.rateLimitType && info.utilization != null ? { [info.rateLimitType]: info } : {});
    for (const [key, w] of Object.entries(wins)) {
      if (!WINDOWS[key] || w.utilization == null) continue;
      const util = Number(w.utilization), resetsAt = Number(w.resetsAt) * 1000;
      const prev = this.s.windows[key];
      // Learn how much of this window a token costs, from the change since the last reading in the same window
      if (prev && prev.resetsAt === resetsAt && util > prev.util && this.s.tokensSince > 2000) {
        const rate = (util - prev.util) / (this.s.tokensSince / 1000);
        const old = this.s.perToken[key];
        this.s.perToken[key] = old ? old * 0.7 + rate * 0.3 : rate;
      }
      this.s.windows[key] = { util, resetsAt, at: now };
      this.warn(key, util, resetsAt);
    }
    this.s.status = info.status || this.s.status;
    this.s.tokensSince = 0;
    this.save();
    this.emit('change', this.snapshot());
  }

  /** 80% and 95%: once each per window per reset. */
  warn(key, util, resetsAt) {
    const id = `${key}@${resetsAt}`;
    const done = this.s.warned[id] || 0;
    const hit = WARN.filter((t) => util >= t && t > done).pop();
    if (!hit) return;
    this.s.warned = Object.fromEntries(Object.entries({ ...this.s.warned, [id]: hit }).filter(([k]) => Number(k.split('@')[1]) > Date.now()));
    this.log?.('claude usage warning', { window: key, pct: Math.round(util * 100) });
    this.emit('warn', { window: key, label: WINDOWS[key], pct: Math.round(util * 100), resetsAt, line: this.warnLine(key, util, resetsAt) });
  }
  warnLine(key, util, resetsAt) {
    return `Heads up, sir: you've used ${Math.round(util * 100)}% of your ${WINDOWS[key]} Claude limit. It resets ${when(resetsAt)}.`;
  }

  /** The current picture: exact (from Claude Code, as of `at`) or estimated, per window. */
  snapshot() {
    const now = Date.now();
    const out = { windows: {}, status: this.s.status };
    for (const key of Object.keys(WINDOWS)) {
      const w = this.s.windows[key];
      if (!w) { out.windows[key] = null; continue; }
      const rate = this.s.perToken[key];
      const extra = rate ? (this.s.tokensSince / 1000) * rate : 0;
      if (w.resetsAt && now >= w.resetsAt) { // the window has reset since the reading
        out.windows[key] = { pct: Math.min(100, Math.round(extra * 100)), resetsAt: null, exact: false, at: w.at, note: 'reset since the last reading' };
      } else if (now - w.at < FRESH_MS && extra < 0.01) {
        out.windows[key] = { pct: Math.round(w.util * 100), resetsAt: w.resetsAt, exact: true, at: w.at };
      } else {
        out.windows[key] = { pct: Math.min(100, Math.round((w.util + extra) * 100)), resetsAt: w.resetsAt, exact: false, at: w.at,
          note: rate ? 'ARES\'s own use since, estimated' : 'last reading; other Claude sessions may have used more since' };
      }
    }
    return out;
  }

  /**
   * The reserve that keeps ARES able to answer: background work (jobs, code sessions) waits while a window is above
   * its line (default 90% of the 5-hour, 95% of the weekly). Chat is never held. Returns { ok, why }.
   */
  reserve(limits = {}) {
    const lines = { five_hour: limits.fiveHour ?? 90, seven_day: limits.weekly ?? 95 };
    const snap = this.snapshot();
    for (const [key, line] of Object.entries(lines)) {
      const w = snap.windows[key];
      if (w && w.pct >= line) return { ok: false, why: `the ${WINDOWS[key]} Claude limit is at ${w.pct}%${w.resetsAt ? ` (resets ${when(w.resetsAt)})` : ''}` };
    }
    return { ok: true };
  }

  /** For the brain's claude_usage tool and the status panel. */
  describe() {
    const snap = this.snapshot();
    const lines = [];
    for (const [key, label] of Object.entries(WINDOWS)) {
      const w = snap.windows[key];
      if (!w) { lines.push(`${label} limit: no reading yet (Claude Code reports it after ARES's next Claude call).`); continue; }
      const left = 100 - w.pct;
      const base = `${label} limit: ${w.pct}% used, ${left}% left${w.resetsAt ? `, resets ${when(w.resetsAt)}` : ''}`;
      lines.push(w.exact ? `${base} (exact, from Claude Code ${ago(w.at)}).`
        : `${base} (ESTIMATE: ${w.note}; last exact reading ${ago(w.at)}).`);
    }
    if (snap.status && snap.status !== 'allowed') lines.push(`Claude Code reports the limit status as "${snap.status}".`);
    return lines.join('\n');
  }

  /** Short lines for the status panel. */
  statusLines() {
    const snap = this.snapshot();
    return Object.entries(WINDOWS).map(([key, label]) => {
      const w = snap.windows[key];
      if (!w) return `Claude ${label}: no reading yet`;
      return `Claude ${label}: ${w.pct}% used${w.exact ? '' : ' (est.)'}${w.resetsAt ? ` · resets ${when(w.resetsAt)}` : ''}`;
    });
  }
}

function when(ms) {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `at ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
}
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

// One shared instance: the modules that run Claude Code just call observe(msg) on every stream-json message
let current = null;
const observe = (msg) => { try { current?.observe(msg); } catch {} };

module.exports = { ClaudeUsage, observe };
