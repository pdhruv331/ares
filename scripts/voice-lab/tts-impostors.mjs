// How ARES's own voices score against the owner's voiceprint (docs/voice-prompt.md A3): Katherine's cached clips
// (<support>/voice-cache, real ElevenLabs audio already paid for) and Kokoro clips, through today's model (TitaNet-small)
// and today's rule (cosine to the centroid vs the threshold). Read-only: the voiceprint is never written.
//   node scripts/voice-lab/tts-impostors.mjs [--kokoro <dir of wavs>] [--model <onnx>]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const SUPPORT = path.join(os.homedir(), 'Library/Application Support/ARES');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const sherpa = require(path.join(ROOT, 'node_modules/sherpa-onnx-node'));
const MODEL = opt('--model', path.join(ROOT, 'models/speaker-titanet-small.onnx'));
const ex = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 2 });
const profile = JSON.parse(fs.readFileSync(path.join(SUPPORT, 'voiceprint.json'), 'utf8'));

const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
function embed(samples, rate) {
  const s = ex.createStream();
  s.acceptWaveform({ samples, sampleRate: rate });
  s.inputFinished();
  return norm(Array.from(ex.compute(s, false)));
}
const pcm16 = (buf) => { const out = new Float32Array(buf.length >> 1); for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768; return out; };
function readWav(file) {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12;
  while (off < b.length - 8 && b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const data = b.subarray(off + 8, off + 8 + b.readUInt32LE(off + 4));
  if (bits === 16) return { samples: pcm16(data), rate };
  return { samples: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)), rate };
}

const centroid = profile.centroid, samples = profile.samples;
const score = (e) => ({ centroid: cos(centroid, e), maxEnrol: Math.max(...samples.map((s) => cos(s, e))) });
const sets = {};
// Katherine: raw 24 kHz 16-bit mono PCM, one file per sentence she has said
const cache = path.join(SUPPORT, 'voice-cache');
sets.katherine = fs.readdirSync(cache).filter((f) => f.endsWith('.pcm')).map((f) => {
  const s = pcm16(fs.readFileSync(path.join(cache, f)));
  return s.length / 24000 >= 0.8 ? { seconds: s.length / 24000, ...score(embed(s, 24000)) } : null;
}).filter(Boolean);
const kdir = opt('--kokoro', null);
if (kdir) {
  sets.kokoro = fs.readdirSync(kdir).filter((f) => f.endsWith('.wav')).map((f) => { const w = readWav(path.join(kdir, f)); return { seconds: w.samples.length / w.rate, ...score(embed(w.samples, w.rate)) }; });
}
// The enrolment against itself (leave-one-out), for scale
sets.enrolmentLOO = samples.map((s, i) => {
  const others = samples.filter((_, j) => j !== i);
  const c = norm(others[0].map((_, k) => others.reduce((a, v) => a + v[k], 0)));
  return { centroid: cos(c, s), maxEnrol: Math.max(...others.map((o) => cos(o, s))) };
});

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))].toFixed(3); };
const out = { model: path.basename(MODEL), threshold: profile.threshold };
for (const [name, rows] of Object.entries(sets)) {
  const c = rows.map((r) => r.centroid), m = rows.map((r) => r.maxEnrol);
  out[name] = { n: rows.length, centroid: { p50: q(c, 0.5), p95: q(c, 0.95), max: q(c, 1) }, maxEnrol: { p50: q(m, 0.5), p95: q(m, 0.95), max: q(m, 1) },
    acceptedToday: rows.filter((r) => r.centroid >= profile.threshold).length };
}
console.log(JSON.stringify(out, null, 1));
