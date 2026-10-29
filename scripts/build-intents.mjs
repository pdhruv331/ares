// Builds the intent layer's example vectors: models/intent/vectors.json (labels, texts) + vectors.bin
// (Float32, one unit vector per example). Run after changing the seeds or sources:
//   node scripts/build-intents.mjs [--sources swda,dailydialog]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { SEEDS } from './intent-seeds.mjs';
import { SOURCES } from './intent-sources.mjs';

const require = createRequire(import.meta.url);
const { Embedder, INTENTS, normalize } = require('../src/intent.js');

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'models', 'intent');
const arg = process.argv.indexOf('--sources');
const names = (arg > 0 ? process.argv[arg + 1] : 'swda,dailydialog').split(',').filter(Boolean);
const CAP = { chat: 2500 }; // everything else keeps all its distinct phrasings
const DEFAULT_CAP = 600;

// Deterministic shuffle, so rebuilding gives the same set
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Count how often each text carries each intent: "yeah" is a backchannel far more often than a yes
const votes = new Map(); // text -> Map(intent -> count)
for (const name of names) {
  const src = SOURCES[name];
  if (!src) throw new Error(`unknown source "${name}" (have: ${Object.keys(SOURCES).join(', ')})`);
  console.log(`› ${name} (${src.license})`);
  let n = 0;
  for await (const { text, intent } of src.examples()) {
    const t = normalize(text);
    if (!t) continue;
    const v = votes.get(t) ?? new Map();
    v.set(intent, (v.get(intent) || 0) + 1);
    votes.set(t, v);
    n++;
  }
  console.log(`  ${n} utterances`);
}

// A text goes to its clear majority intent; ambiguous ones (no 60% majority) are left out
const byIntent = Object.fromEntries(INTENTS.map((i) => [i, []]));
const seedTexts = new Set(Object.values(SEEDS).flat().map(normalize));
let dropped = 0;
for (const [text, v] of votes) {
  if (seedTexts.has(text)) continue; // the hand-written label wins
  const total = [...v.values()].reduce((a, b) => a + b, 0);
  const [intent, count] = [...v].sort((a, b) => b[1] - a[1])[0];
  if (count / total < 0.6) { dropped++; continue; }
  byIntent[intent].push({ text, count });
}
const examples = [];
for (const intent of INTENTS) {
  // Most frequent phrasings first for the small intents; a random spread for "chat"
  const list = intent === 'chat' ? shuffle(byIntent[intent]) : byIntent[intent].sort((a, b) => b.count - a.count);
  for (const { text } of list.slice(0, CAP[intent] ?? DEFAULT_CAP)) examples.push({ text, intent });
  for (const text of SEEDS[intent] || []) examples.push({ text: normalize(text), intent, seed: true });
}
const unique = [...new Map(examples.map((e) => [`${e.intent}|${e.text}`, e])).values()];

const counts = Object.fromEntries(INTENTS.map((i) => [i, unique.filter((e) => e.intent === i).length]));
console.log('› examples', counts, `(${dropped} ambiguous left out)`);

const embedder = await new Embedder(OUT).load();
const vectors = [];
const t0 = Date.now();
for (let i = 0; i < unique.length; i += 64) {
  vectors.push(...await embedder.embed(unique.slice(i, i + 64).map((e) => e.text)));
  process.stdout.write(`\r› embedding ${Math.min(i + 64, unique.length)}/${unique.length}`);
}
console.log(` (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const dim = vectors[0].length;
const bin = new Float32Array(vectors.length * dim);
vectors.forEach((v, i) => bin.set(v, i * dim));
fs.writeFileSync(path.join(OUT, 'vectors.bin'), Buffer.from(bin.buffer));
fs.writeFileSync(path.join(OUT, 'vectors.json'), JSON.stringify({
  model: 'BAAI/bge-small-en-v1.5 (int8 ONNX, Xenova)',
  source: ['seeds', ...names].join('+'),
  built: new Date().toISOString(),
  dim,
  counts,
  labels: unique.map((e) => e.intent),
  texts: unique.map((e) => e.text),
  seed: unique.map((e) => (e.seed ? 1 : 0)), // hand-written: cleaner labels than the mined ones
}));
console.log(`✓ ${unique.length} example vectors → models/intent/vectors.{json,bin} (${(bin.byteLength / 1e6).toFixed(1)} MB)`);
