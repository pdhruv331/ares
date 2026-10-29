// The wake line (docs/ignition-prompt.md §4): what ARES says the moment she's up, different every time. Instant and free: a
// local pool of templates per situation in her voice (conversational, dry, "sir" only sometimes), filled with real facts
// and never repeating any of the last 20 lines. Something that needs the user comes first (a failed job, a missed call, an
// approval waiting); otherwise a short greeting and at most one useful fact. Never a list.
//
//   const lines = new WakeLines(file);  lines.compose(ctx) → { text, spoken }   (spoken: without the [cue] delivery marks)
//   ctx: { now: Date, offMs, why: 'clean'|'crash'|'restart'|'update'|'unknown', first: bool,
//          jobsDone: [titles], jobsFailed: [titles], approvals: n, missedCalls: n, voicemails: n, claudeWaiting: n,
//          nextEvent: { title, start } | null, weather: '14° · RAIN' | null, battery: { pct, charging } | null, usagePct: n|null }
const fs = require('fs');

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
const HISTORY = 20;

function greeting(now) {
  const h = now.getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Morning';
  if (h < 18) return 'Afternoon';
  return 'Evening';
}
const weekday = (now) => now.toLocaleDateString('en-GB', { weekday: 'long' });
function offText(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 2) return { short: true, text: 'a minute' };
  if (min < 60) return { short: true, text: `${min} minutes` };
  const h = Math.round(min / 60);
  if (h < 20) return { short: false, text: h === 1 ? 'an hour' : `${h} hours` };
  const d = Math.round(h / 24);
  if (d <= 1) return { overnight: true, text: 'overnight' };
  return { days: d, text: `${d} days` };
}
const timeOf = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
const hourWord = (ms) => { const d = new Date(ms); const h = d.getHours() % 12 || 12; const m = d.getMinutes(); return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`; };
const shortWeather = (w) => (w ? String(w).toLowerCase().replace(' · ', ', ') : '');

/** The template pools. Each returns a string; "{g}" greeting, "{d}" weekday, "{off}" how long she was off. */
const POOLS = {
  // --- Things that need the user first -------------------------------------------------------------------------------------
  failed: [
    '[measured] {g}. One thing before anything else: {job} failed while I was out. The details are in Work.',
    '{g}, sir. {job} didn\'t make it. I\'ve kept the log for you.',
    'Back online. Bad news first: {job} failed. The rest went fine.',
    '{g}. {job} fell over while I was off. Shall I try it again?',
  ],
  approval: [
    '{g}. {n} waiting on your say-so, whenever you\'re ready.',
    'Back online, sir. Something needs your approval before it can go on.',
    '{g}. I\'ve got {n} on hold for your yes. No rush.',
  ],
  missed: [
    '{g}, sir. You missed {calls} while I was off. The voicemail\'s ready when you are.',
    'Back online. {calls} came in while I was out. I\'ll read you the message if you like.',
    '{g}. {calls} missed. Say the word and I\'ll play it.',
  ],
  claude: [
    '{g}. {n} waiting on you. Nothing urgent, by the look of it.',
    'Back, sir. Claude left you {n} while I was off.',
  ],
  // --- Why she was off ---------------------------------------------------------------------------------------------------------
  crash: [
    '[gently] Sorry about that, sir. I\'m back, and nothing was lost.',
    'That was undignified. I\'m back. Memory intact.',
    '[dryly] I appear to have fainted. All systems up again.',
    'Back online. Something knocked me over; I\'ve made a note of it.',
  ],
  restart: [
    'The Mac\'s back and so am I. {g}.',
    '{g}. Fresh restart, everything up.',
    'Reboot complete, sir. All systems nominal.',
  ],
  update: [
    '{g}. New version, same me. All systems up.',
    'Updated and back online. Let\'s see what\'s changed.',
    '[dryly] I\'ve been upgraded. I feel exactly the same.',
  ],
  first: [
    '[warmly] Hello, sir. ARES, online for the first time. Say my name whenever you need me.',
    'Reactor lit. All systems up. Shall we begin?',
  ],
  // --- How long ------------------------------------------------------------------------------------------------------------------
  quick: [
    'Back already? Picking up where we left off.',
    '[dryly] That was brief. Online again.',
    'Barely gone. All systems up.',
    'Back in a flash, sir.',
  ],
  overnight: [
    '{g}, sir. All systems up. {fact}',
    '{g}. Quiet night. {fact}',
    'Online. {d} morning, sir. {fact}',
  ],
  long: [
    '[warmly] It\'s been a while, sir. {off}. Shall I catch you up?',
    'Back after {off}. The Mac missed you too.',
    '{off} offline. Everything\'s where you left it.',
  ],
  // --- Plain greetings, one useful fact at most --------------------------------------------------------------------------------------
  plain: [
    '{g}, sir. All systems up. {fact}',
    '{g}. Online and listening. {fact}',
    'All systems up. {fact}',
    '{g}. Reactor\'s warm. {fact}',
    '{g}, sir. {fact}',
    'Online. {fact}',
    '[dryly] Back among the living. {fact}',
    '{g}. Quiet day so far.',
  ],
  // --- Facts (one of these fills {fact}; the empty string means none) -----------------------------------------------------------------
  factEvent: [
    'Your {event} is at {time}.',
    '{event} at {time}, sir.',
    'Next up: {event}, {time}.',
  ],
  factWeather: [
    '{weather} outside.',
    'It\'s {weather} out there.',
  ],
  factWeatherEvent: [
    '{weather}, and your {event} is at {time}.',
    '{weather}. {event} at {time}.',
  ],
  factJobs: [
    '{jobs} finished while I was out. The results are in Work.',
    'While I was off: {jobs} finished.',
    '{jobs} done in the background, sir.',
  ],
  factBattery: [
    'Battery\'s at {pct} percent; you might want the charger.',
    '{pct} percent battery, sir. Plug in when you can.',
  ],
  factUsage: [
    'Claude\'s at {pct} percent of its limit; I\'ll be sparing.',
    'Heads up: Claude usage is at {pct} percent.',
  ],
};

class WakeLines {
  constructor(file, { rnd = Math.random } = {}) {
    this.file = file;
    this.rnd = rnd;
    try { this.history = JSON.parse(fs.readFileSync(file, 'utf8')).slice(-HISTORY); } catch { this.history = []; }
  }
  remember(text) {
    this.history.push(text);
    this.history = this.history.slice(-HISTORY);
    try { fs.writeFileSync(this.file, JSON.stringify(this.history)); } catch {}
  }

  /** Fill a template with the context. */
  fill(t, ctx, fact = '') {
    const now = ctx.now || new Date();
    const out = t.replace(/\{g\}/g, greeting(now)).replace(/\{d\}/g, weekday(now)).replace(/\{off\}/g, offText(ctx.offMs || 0).text)
      .replace(/\{fact\}/g, fact)
      .replace(/\{job\}/g, ctx.jobsFailed?.[0] ? `"${ctx.jobsFailed[0]}"` : 'a job')
      .replace(/\{jobs\}/g, ctx.jobsDone?.length === 1 ? `"${ctx.jobsDone[0]}"` : `${ctx.jobsDone?.length || 0} jobs`)
      .replace(/\{n\}/g, (() => { const n = ctx.approvals || ctx.claudeWaiting || 1; return n === 1 ? 'one thing' : `${n} things`; })())
      .replace(/\{calls\}/g, (() => { const c = ctx.missedCalls || 0, v = ctx.voicemails || 0; if (v && c) return c === 1 ? 'a call, with a voicemail' : `${c} calls, ${v} voicemail${v > 1 ? 's' : ''}`; if (v) return v === 1 ? 'a voicemail' : `${v} voicemails`; return c === 1 ? 'a call' : `${c} calls`; })())
      .replace(/\{event\}/g, ctx.nextEvent?.title || 'next event').replace(/\{time\}/g, ctx.nextEvent ? hourWord(ctx.nextEvent.start) : '')
      .replace(/\{weather\}/g, shortWeather(ctx.weather)).replace(/\{pct\}/g, String(ctx.battery?.pct ?? ctx.usagePct ?? ''));
    // Capitalise after a sentence end, tidy doubled spaces and dangling spaces before the full stop
    return out.replace(/\s+/g, ' ').replace(/\s+([.,!?])/g, '$1').replace(/(^|[.!?]\s+)([a-z])/g, (_m, a, b) => a + b.toUpperCase()).trim();
  }

  /** The one fact worth adding (or ''), by usefulness: an event soon, notable weather, finished jobs, low battery, usage. */
  fact(ctx) {
    const soon = ctx.nextEvent && ctx.nextEvent.start - Date.now() < 10 * 3600_000 && ctx.nextEvent.start > Date.now();
    const weatherNotable = ctx.weather && /rain|snow|storm|thunder|fog|wind|hail|clear|sun/i.test(ctx.weather);
    const pool = [];
    if (soon && weatherNotable) pool.push(['factWeatherEvent', 3]);
    if (soon) pool.push(['factEvent', 3]);
    if (ctx.jobsDone?.length) pool.push(['factJobs', 3]);
    if (ctx.battery && !ctx.battery.charging && ctx.battery.pct <= 25) pool.push(['factBattery', 2]);
    if (weatherNotable) pool.push(['factWeather', 1]);
    if (ctx.usagePct >= 80) pool.push(['factUsage', 1]);
    if (!pool.length) return '';
    const best = Math.max(...pool.map((p) => p[1]));
    const top = pool.filter((p) => p[1] === best).map((p) => p[0]);
    return this.fill(pick(POOLS[pick(top, this.rnd)], this.rnd), ctx);
  }

  /** Candidate templates for the situation, most pressing first. */
  pools(ctx) {
    if (ctx.jobsFailed?.length) return ['failed'];
    if (ctx.approvals) return ['approval'];
    if (ctx.missedCalls || ctx.voicemails) return ['missed'];
    if (ctx.claudeWaiting) return ['claude'];
    if (ctx.first) return ['first'];
    if (ctx.why === 'crash') return ['crash', 'plain'];
    if (ctx.why === 'update') return ['update', 'plain'];
    if (ctx.why === 'restart') return ['restart', 'plain'];
    const off = offText(ctx.offMs || 0);
    if (off.days >= 2) return ['long'];
    if (off.overnight) return ['overnight', 'plain'];
    if (off.short) return ['quick', 'plain'];
    return ['plain'];
  }

  compose(ctx = {}) {
    ctx = { now: new Date(), ...ctx };
    const fact = this.fact(ctx);
    const pools = this.pools(ctx);
    // The most pressing pool first; a template that wants a fact only when there is one; nothing said in the last 20 wakes
    const usable = (name) => POOLS[name].filter((t) => fact || !t.includes('{fact}')).map((t) => this.fill(t, ctx, fact));
    let fresh = [];
    for (const name of [...pools, 'plain']) { fresh = usable(name).filter((c) => !this.history.includes(c)); if (fresh.length) break; }
    if (!fresh.length) fresh = POOLS.plain.map((t) => this.fill(t, ctx, fact)).filter((c) => !this.history.includes(c));
    if (!fresh.length) { fresh = usable(pools[0]); fresh.sort((a, b) => this.history.indexOf(a) - this.history.indexOf(b)); } // (all said recently: the least recent)
    const text = pick(fresh, this.rnd);
    this.remember(text);
    return { text, spoken: text, shown: text.replace(/\[[a-z ]+\]\s*/gi, '') };
  }
}

module.exports = { WakeLines, POOLS, offText };
