// Checks the intent layer on casual phrasings that aren't in its examples, and times it.
//   node scripts/test-intents.mjs [--verbose]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { HELD_OUT } from './intent-seeds.mjs';

const require = createRequire(import.meta.url);
const { Intents, normalize } = require('../src/intent.js');
const verbose = process.argv.includes('--verbose');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-intent-test-')); // no personal phrases
const intents = await new Intents({ modelDir: path.join(import.meta.dirname, '..', 'models', 'intent'), dataDir }).init();
const seen = new Set(intents.texts);

let right = 0, total = 0, skipped = 0, harmful = 0;
const misses = [];
const times = [];
for (const [expected, phrases] of Object.entries(HELD_OUT)) {
  let ok = 0, n = 0;
  for (const phrase of phrases) {
    if (seen.has(normalize(phrase))) { skipped++; continue; }
    const r = await intents.classify(phrase);
    intents.cache.clear();
    times.push(r.ms);
    n++;
    // Anything but stop may fall back to "chat": the brain then gets it with the guess as a hint
    const good = r.intent === expected || (expected !== 'stop' && expected !== 'chat' && r.intent === 'chat');
    // The costly mistakes: going quiet or acting on the Mac when the user meant something else
    if (r.local && r.intent !== expected) harmful++;
    if (good) ok++;
    else misses.push(`  ${expected.padEnd(9)} "${phrase}" → ${r.intent} (guess ${r.guess} ${r.score}, margin ${r.margin}${r.local ? ', acts locally' : ''})`);
    if (verbose) console.log(`${good ? '✓' : '✗'} ${expected.padEnd(9)} ${phrase.padEnd(32)} → ${r.intent.padEnd(9)} ${r.guess}/${r.score}/${r.margin}${r.clear ? ' clear' : ''}`);
  }
  right += ok; total += n;
  console.log(`${expected.padEnd(10)} ${ok}/${n}`);
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
console.log(`\naccuracy ${right}/${total} (${(100 * right / total).toFixed(0)}%), wrong local actions ${harmful}, ${skipped} held-out phrasings skipped (already in the examples)`);
console.log(`latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${times.at(-1)} ms`);
if (misses.length) console.log('\nmisses:\n' + misses.join('\n'));
await intents.dispose();
fs.rmSync(dataDir, { recursive: true, force: true });
