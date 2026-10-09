// A pretend desk session in record-session.mjs's exact format (block WAVs + labels.jsonl), read by Kokoro, so the scoring
// (score-session.mjs) can be tested end to end before a real one. The "owner" is one Kokoro voice; the conditions are
// simulated: far = quieter + a simple reverb, music = a chord pad, tv = another voice underneath, speaking = the backup
// voice talking over, others = other voices alone. "…" in a line becomes a real pause (0.5–1.4 s). Numbers from this are
// a pipeline check only, never a result.
//   node scripts/voice-lab/fake-session.mjs [--dir <out>] [--owner 26]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { BLOCKS, fillIn } from './session-lines.mjs';
import { writeWav16 } from './lab.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('--dir', path.join(os.tmpdir(), 'ares-fake-session'));
const OWNER = Number(opt('--owner', 26)); // bm_george
const require = createRequire(import.meta.url);
const sherpa = require(path.join(import.meta.dirname, '../../node_modules/sherpa-onnx-node'));
const k = path.join(os.homedir(), 'Library/Application Support/ARES/models/kokoro-v1_0');
const tts = new sherpa.OfflineTts({ model: { kokoro: { model: path.join(k, 'model.onnx'), voices: path.join(k, 'voices.bin'), tokens: path.join(k, 'tokens.txt'),
  dataDir: path.join(k, 'espeak-ng-data'), lexicon: path.join(k, 'lexicon-gb-en.txt'), lang: 'en' }, numThreads: 4 } });

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const to16k = (s, rate) => { const out = new Float32Array(Math.floor(s.length * 16000 / rate)); for (let i = 0; i < out.length; i++) { const x = i * rate / 16000, j = Math.floor(x), f = x - j; out[i] = s[j] * (1 - f) + (s[j + 1] ?? 0) * f; } return out; };
const say = (text, sid, speed = 1) => { const a = tts.generate({ text, sid, speed }); return to16k(a.samples, a.sampleRate); };
const silence = (sec) => new Float32Array(Math.round(sec * 16000));
const cat = (parts) => { const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
/** A line as the owner says it: "…" becomes a pause. */
const speak = (line) => cat(line.split(/\.\.\.|…/).map((part) => part.trim()).filter(Boolean).flatMap((part, i) => (i ? [silence(0.5 + rnd() * 0.9), say(part, OWNER)] : [say(part, OWNER)])));
function far(x) { // 3 m: about 12 dB quieter, with a short exponential reverb tail
  const ir = Float32Array.from({ length: 4000 }, (_, i) => (i === 0 ? 1 : (rnd() * 2 - 1) * 0.5 * Math.exp(-i / 900)));
  const y = new Float32Array(x.length + ir.length);
  for (let i = 0; i < x.length; i++) if (x[i]) for (let j = 0; j < ir.length; j += 4) y[i + j] += x[i] * ir[j];
  return y.map((v) => v * 0.25);
}
const music = (n) => Float32Array.from({ length: n }, (_, i) => 0.03 * (Math.sin(i * 2 * Math.PI * 220 / 16000) + Math.sin(i * 2 * Math.PI * 277 / 16000) + Math.sin(i * 2 * Math.PI * 330 / 16000)) * (0.6 + 0.4 * Math.sin(i / 16000 * 2)));
const TV_LINES = ['And that, of course, is why the committee voted against it last week.', 'We will be right back after the break with more on the story.',
  'The temperature is expected to fall sharply overnight across the north.', 'I just think it was the wrong decision, frankly.', 'Let me ask you this: did anyone see it coming?'];
const voiceBed = (n, sids, gain) => { const parts = []; let len = 0, i = 0; while (len < n) { const s = say(TV_LINES[i % TV_LINES.length], sids[i % sids.length]); parts.push(s, silence(0.3)); len += s.length + 4800; i++; } return cat(parts).subarray(0, n).map((v) => v * gain); };
const mix = (a, b) => a.map((v, i) => v + (b[i] || 0));

fs.mkdirSync(DIR, { recursive: true });
const labels = fs.createWriteStream(path.join(DIR, 'labels.jsonl'));
for (const [name, b] of Object.entries(BLOCKS)) {
  const parts = [silence(1)];
  let t = 1;
  const rows = [];
  if (b.timed) {
    parts.push(voiceBed(60 * 16000, [3, 11, 21, 15], 0.6)); // others: 60 s of other voices alone
    rows.push({ i: 0, text: '', start: 1, end: 61, featuresOnly: true });
    t = 61;
  }
  b.lines.forEach((line, i) => {
    const text = fillIn(line);
    let s = speak(text);
    if (b.distance >= 3) s = far(s);
    rows.push({ i, text, start: +(t - 0.3).toFixed(2), end: +(t + s.length / 16000 + 0.4).toFixed(2) });
    parts.push(s, silence(1.5 + rnd()));
    t += s.length / 16000 + parts.at(-1).length / 16000;
  });
  let audio = cat(parts);
  if (b.condition === 'music') audio = mix(audio, music(audio.length));
  if (b.condition === 'tv') audio = mix(audio, voiceBed(audio.length, [9, 13], 0.25));
  if (b.condition === 'speaking') audio = mix(audio, voiceBed(audio.length, [3], 0.35)); // af_heart: "ARES" talking
  writeWav16(path.join(DIR, `${name}.wav`), audio);
  for (const r of rows) labels.write(JSON.stringify({ block: name, file: `${name}.wav`, ...r, distance: b.distance, condition: b.condition, fake: true }) + '\n');
  console.log(`${name}: ${rows.length} lines, ${(audio.length / 16000).toFixed(0)} s`);
}
labels.end();
console.log('→', DIR);
