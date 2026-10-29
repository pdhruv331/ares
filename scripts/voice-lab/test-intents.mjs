// Score today's fast path on the A8 intent set (docs/voice-prompt.md A8): which remarks and commands are answered on the
// Mac without the brain, whether that was right, which model the router picks, and what addressed.js says when the same
// words are overheard (desk mode). Needs a running dev instance for the window's localCommand / Work.command
// (node scripts/harness.mjs start). No Claude calls, nothing sent.
//   node scripts/voice-lab/test-intents.mjs [--noisy] [--verbose] [--json out.json]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { chromium } from 'playwright-core';
import { CASES, FAST_TODAY, noisy } from './intent-set.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const { Intents } = require(path.join(ROOT, 'src', 'intent.js'));
const { Remarks } = require(path.join(ROOT, 'src', 'remarks.js'));
const { route } = require(path.join(ROOT, 'src', 'router.js'));
const { judge } = require(path.join(ROOT, 'src', 'addressed.js'));
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const SUPPORT = path.join(os.homedir(), 'Library/Application Support/ARES');

// main.js's phrases caught before the brain (read from the source so they can't drift)
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const POWER = eval(mainSrc.match(/const POWER_PHRASE = (\/.*\/[a-z]*);/)[1]);
const KILL = eval(mainSrc.match(/const KILL_PHRASE = (\/.*\/[a-z]*);/)[1]);

// Placeholders → real local names (in memory only; the output keeps the placeholder)
function fillers() {
  let contacts = [];
  try { contacts = JSON.parse(fs.readFileSync(path.join(SUPPORT, 'contacts.json'), 'utf8')).map((c) => (c.nickname || c.name || '').split(' ')[0]).filter((n) => /^[A-Z][a-z]{2,}$/.test(n)); } catch {}
  const apps = fs.readdirSync('/Applications').filter((a) => a.endsWith('.app')).map((a) => a.replace(/\.app$/, '')).filter((a) => /^[A-Za-z ]{3,16}$/.test(a));
  let projects = [];
  try { projects = fs.readdirSync(path.join(os.homedir(), 'ARES Projects')).filter((p) => !p.startsWith('.')); } catch {}
  const pick = (list, i, d) => (list.length ? list[(i * 7919) % list.length] : d);
  return (text, i) => text.replace('{contact}', pick(contacts, i, 'Sam')).replace('{app}', pick(apps, i, 'Notes')).replace('{project}', pick(projects, i, 'weather app'));
}
const fill = fillers();

const intents = await new Intents({ modelDir: path.join(ROOT, 'models', 'intent'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ares-a8-')) }).init();
const remarks = new Remarks({ lastReply: () => ({ text: 'The meeting is at three, sir.', t: Date.now() - 5000 }) });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.ARES_HARNESS_PORT || 9334}`, { timeout: 5000 });
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('renderer/index.html'));
if (!page) throw new Error('no dev instance window: node scripts/harness.mjs start');

/** The window's own matchers, timed. Only says whether one fired and what it would do (its `after` isn't run). */
const windowMatch = (text) => page.evaluate((t) => {
  const t0 = performance.now();
  const c = localCommand(t) || Work.command(t);
  const ms = performance.now() - t0;
  if (!c) return { hit: false, ms };
  const did = String(c.after || '');
  const what = /setAwake\(true\)/.test(did) ? 'listen.awake' : /setAwake\(false\)/.test(did) ? 'listen.quiet' : /\.mute\(/.test(did) ? 'listen.mute'
    : /\.unmute\(/.test(did) ? 'listen.unmute' : /Callouts\.open/.test(did) ? 'readout' : /Comms\.(open|close)/.test(did) ? 'ui.comms' : /\.hide\(\)/.test(did) ? 'ui.hide'
    : /Dash\.tidy/.test(did) ? 'ui.tidy' : /'calendar'/.test(did) ? 'calendar' : /tasks/.test(did) ? 'tasks' : /setCity/.test(did) ? 'settings.weatherCity'
    : /Dash\.pin|resumeListening\(\)\s*$/.test(did) && /pin/i.test(t) ? 'ui.pin' : 'other';
  return { hit: true, what, reply: c.reply || '', ms };
}, text);

const ROUTE_OK = { 'listen.awake': ['listen.awake'], 'listen.quiet': ['listen.quiet', 'remark.sleep'], 'listen.mute': ['listen.mute'], 'listen.unmute': ['listen.unmute'],
  readout: ['readout.claude', 'readout.jobs', 'battery.query'], 'ui.comms': ['ui.comms'], 'ui.hide': ['ui.hide'], 'ui.tidy': ['ui.tidy'],
  calendar: ['calendar.show', 'calendar.day'], tasks: ['tasks.show'], 'settings.weatherCity': ['settings.weatherCity'], 'ui.pin': ['ui.pin'] };

async function decide(text) {
  const t0 = performance.now();
  if (POWER.test(text.trim())) return { path: 'power.down', ms: performance.now() - t0 };
  const w = await windowMatch(text);
  if (w.hit) return { path: 'window', what: w.what, ms: w.ms };
  if (KILL.test(text)) return { path: 'autonomy.stopAll', ms: performance.now() - t0 };
  const r = await intents.classify(text);
  intents.cache.clear();
  const q = remarks.quick(text, r, { afterBarge: false, addressed: true, awake: false, remote: false });
  if (q) return { path: 'remark', what: `remark.${r.intent}`, ms: w.ms + r.ms, r };
  return { path: 'brain', ms: w.ms + r.ms, r };
}

const rows = [];
let i = 0;
for (const [tmpl, want, slots = {}, flags = {}] of CASES) {
  const variants = [[tmpl, false], ...(args.includes('--noisy') ? noisy(tmpl, ++i).map((v) => [v, true]) : [])];
  for (const [t, isNoisy] of variants) {
    const text = fill(t, i);
    const d = await decide(text);
    const fast = d.path !== 'brain';
    const correct = !fast ? !FAST_TODAY.has(want)
      : d.path === 'window' ? (ROUTE_OK[d.what] || []).includes(want)
      : d.path === 'remark' ? d.what === want || (want === 'listen.quiet' && d.what === 'remark.sleep') || (d.what === 'remark.stop' && want === 'remark.nevermind')
      : d.path === want;
    const r0 = performance.now();
    const model = route(text).model;
    const routerMs = performance.now() - r0;
    const heard = judge(text, { lastReplyAt: 0 }); // overheard in desk mode, no conversation open
    rows.push({ text: t, want, noisy: isNoisy, neg: Boolean(flags.neg), fast, path: d.path, what: d.what, correct, ms: d.ms, model, wantModel: flags.model, routerMs, overheard: heard.verdict, overheardWhy: heard.why });
    if (verbose) console.log(`${correct ? '✓' : '✗'} ${isNoisy ? '~' : ' '} ${t.padEnd(52)} want ${want.padEnd(18)} → ${(d.what || d.path).padEnd(18)} model ${model.padEnd(6)} desk:${heard.verdict}`);
  }
}
await browser.close();
await intents.dispose();

const pct = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))].toFixed(1) : null; };
const summary = (set, label) => {
  const fastFired = set.filter((r) => r.fast);
  const shouldFast = set.filter((r) => FAST_TODAY.has(r.want));
  const negs = set.filter((r) => r.neg);
  const routed = set.filter((r) => r.wantModel && !r.fast);
  const forHer = set.filter((r) => r.want !== 'none' && !r.neg);
  const notForHer = set.filter((r) => r.want === 'none');
  const out = {
    label, cases: set.length,
    fastPrecision: `${fastFired.filter((r) => r.correct).length}/${fastFired.length}`,
    fastRecall: `${shouldFast.filter((r) => r.fast && r.correct).length}/${shouldFast.length}`,
    wrongFastActions: fastFired.filter((r) => !r.correct).map((r) => `${r.text} → ${r.what || r.path} (wanted ${r.want})`),
    negativesFired: `${negs.filter((r) => r.fast).length}/${negs.length}`,
    routerAgreement: `${routed.filter((r) => r.model === r.wantModel).length}/${routed.length}`,
    routerConfusion: Object.entries(routed.reduce((a, r) => ((a[`${r.wantModel}→${r.model}`] = (a[`${r.wantModel}→${r.model}`] || 0) + 1), a), {})).map((x) => x.join(' ')).join(', '),
    deskModeAnswered: `${forHer.filter((r) => r.overheard === 'yes').length}/${forHer.length} meant for her`,
    deskModeFalseYes: `${notForHer.filter((r) => r.overheard === 'yes').length}/${notForHer.length} not for her`,
    deskFalseYesList: notForHer.filter((r) => r.overheard === 'yes').map((r) => `${r.text} (${r.overheardWhy})`),
    fastMs: { p50: pct(set.map((r) => r.ms), 0.5), p95: pct(set.map((r) => r.ms), 0.95) },
    routerMs: { p50: pct(set.map((r) => r.routerMs), 0.5), p95: pct(set.map((r) => r.routerMs), 0.95) },
  };
  return out;
};
const result = { clean: summary(rows.filter((r) => !r.noisy), 'clean transcripts') };
if (args.includes('--noisy')) result.noisy = summary(rows.filter((r) => r.noisy), 'noisy variants');
console.log(JSON.stringify(result, null, 1));
const j = args.indexOf('--json');
if (j >= 0) fs.writeFileSync(args[j + 1], JSON.stringify({ result, rows }, null, 1));
