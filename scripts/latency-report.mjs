// p50/p95 of each stage of a voice turn, from <support>/latency.jsonl (latency.js; docs/voice-prompt.md A1).
// Usage: node scripts/latency-report.mjs [file] [--since 2026-10-09] [--src wake,desk,ptt] [--json]
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const file = args.filter((a, i) => !a.startsWith('--') && !['--since', '--src'].includes(args[i - 1]))[0]
  || path.join(process.env.ARES_USER_DATA || path.join(os.homedir(), 'Library/Application Support/ARES'), 'latency.jsonl');
const since = opt('--since');
const srcs = opt('--src')?.split(',');

let recs = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (since) recs = recs.filter((r) => r.at >= since);
if (srcs) recs = recs.filter((r) => srcs.includes(r.src));

/** What kind of turn it was, for the per-kind table. */
function kind(r) {
  if (r.end === 'not the owner' || r.end === 'not for her') return 'overheard';
  if (r.local) return 'local';
  if (r.tools > 0) return 'tool turn';
  if (r.replyChars > 300) return 'long answer';
  if (r.why === 'quick') return 'command';
  return 'question';
}
const pct = (a, p) => {
  const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : null;
};
const span = (r, a, b) => (r.ms[a] != null && r.ms[b] != null ? r.ms[b] - r.ms[a] : null);
// [label, from, to]: each slice of the turn, then the whole of it
const SLICES = [
  ['wake detected after the phrase', 'wakeSaid', 'wake'],
  ['end of turn (mic quiet → decided)', 'vadStop', 'eot'],
  ['text settled → decided', 'lastText', 'eot'],
  ['listener → main (heard)', 'eot', 'heard'],
  ['intent layer', 'heard', 'intent'],
  ['voice check', 'intent', 'trust'],
  ['heard → window handle()', 'heard', 'handle'],
  ['handle → plan (remark layer)', 'handle', 'plan'],
  ['plan → brain sent', 'plan', 'brainSent'],
  ['brain: sent → first token', 'brainSent', 'brainFirstToken'],
  ['first token → first sentence', 'brainFirstToken', 'firstSentence'],
  ['first sentence → TTS request', 'firstSentence', 'ttsRequest'],
  ['TTS: request → first byte', 'ttsRequest', 'ttsFirstByte'],
  ['TTS first byte → audio out', 'ttsFirstByte', 'firstAudio'],
  ['VOICE TO VOICE (mic quiet → her first sound)', 'vadStop', 'firstAudio'],
  ['decided → her first sound', 'eot', 'firstAudio'],
];

const rows = (set) => SLICES.map(([label, a, b]) => {
  const v = set.map((r) => span(r, a, b)).filter((x) => x != null);
  return { label, n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95) };
}).filter((x) => x.n);

const show = (title, set) => {
  console.log(`\n${title} (${set.length} turns)`);
  for (const r of rows(set)) console.log(`  ${r.label.padEnd(46)} n=${String(r.n).padStart(3)}  p50 ${String(r.p50).padStart(6)} ms  p95 ${String(r.p95).padStart(6)} ms`);
};

if (args.includes('--json')) {
  const kinds = [...new Set(recs.map(kind))];
  console.log(JSON.stringify({ all: rows(recs), ...Object.fromEntries(kinds.map((k) => [k, rows(recs.filter((r) => kind(r) === k))])) }, null, 1));
} else {
  console.log(`${file}: ${recs.length} turns` + (since ? ` since ${since}` : ''));
  const count = (f) => Object.entries(recs.reduce((a, r) => ((a[f(r)] = (a[f(r)] || 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`  by source: ${count((r) => r.src)}\n  by kind: ${count(kind)}\n  by end: ${count((r) => r.end)}\n  models: ${count((r) => r.model || '-')}`);
  show('ALL', recs.filter((r) => kind(r) !== 'overheard'));
  for (const k of ['question', 'command', 'tool turn', 'long answer', 'local', 'overheard']) {
    const set = recs.filter((r) => kind(r) === k);
    if (set.length) show(k.toUpperCase(), set);
  }
}
