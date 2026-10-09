// Scores a desk session (record-session.mjs, or fake-session.mjs for a pipeline check) for docs/voice-prompt.md A2–A5:
//   asr      word error rate, names right, latency: SFSpeechRecognizer (today, en-GB/en-US, + custom language model),
//            SpeechTranscriber (en-GB/en-IN/en-US), Parakeet TDT v2/v3 (FluidAudio, with and without ARES's vocabulary)
//   wake     today's wake rule on SFSpeech transcripts (and with "okay" fixed), sherpa-onnx KWS "HEY ARES", and the trained
//            livekit-wakeword model if it exists: recall per condition, false wakes on non-wake lines and other voices
//   speaker  the owner vs other voices for each speaker model and scoring method (A3)
//   eot      end-of-turn policies on the utterances (eot.py)
// The "others" block (other people's voices) is turned into features and its audio deleted.
//   node scripts/voice-lab/score-session.mjs <session dir> [--parts asr,wake,speaker,eot] [--quick]
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { transcribe, transcribeJoined, readWav, writeWav16, command } from './lab.mjs';
import { wakeToday } from './wake-regex.mjs';
import { L } from './session-lines.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SESSION = path.resolve(args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--parts') || '.');
const PARTS = opt('--parts', 'asr,wake,speaker,eot').split(',');
const QUICK = args.includes('--quick');
const ROOT = path.join(import.meta.dirname, '..', '..');
const SUPPORT = path.join(os.homedir(), 'Library/Application Support/ARES');
const LAB = path.join(SUPPORT, 'voice-lab');
const MODELS = path.join(LAB, 'models');
const FLUID = path.join(LAB, 'src/FluidAudio/.build/release/fluidaudiocli');
const require = createRequire(import.meta.url);
const sherpa = require(path.join(ROOT, 'node_modules/sherpa-onnx-node'));
const OUT = path.join(SESSION, 'scores');
const CLIPS = path.join(SESSION, 'clips');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CLIPS, { recursive: true });
const report = { session: path.basename(SESSION), at: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
const pct = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : null; };
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// ---- Clips: each labelled line, trimmed to its voiced part (± 0.3 s), as 16 kHz WAV ----------------------------------
const labels = fs.readFileSync(path.join(SESSION, 'labels.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const blocks = new Map();
const blockAudio = (file) => { if (!blocks.has(file)) blocks.set(file, readWav(path.join(SESSION, file))); return blocks.get(file); };
function voicedSpan(s, rate) {
  const F = Math.round(rate * 0.02), n = Math.floor(s.length / F);
  const rms = Array.from({ length: n }, (_, f) => { let a = 0; for (let i = f * F; i < (f + 1) * F; i++) a += s[i] * s[i]; return Math.sqrt(a / F); });
  const sorted = [...rms].sort((a, b) => a - b);
  const gate = Math.max(sorted[Math.floor(n * 0.2)] * 3, sorted[Math.floor(n * 0.98)] * 0.1, 3e-4);
  const on = rms.map((r) => r > gate);
  const first = on.indexOf(true), last = on.lastIndexOf(true);
  return first < 0 ? null : [first * F, (last + 1) * F];
}
const clips = [];
for (const l of labels) {
  if (l.featuresOnly) continue;
  const { s, rate } = blockAudio(l.file);
  const seg = s.subarray(Math.max(0, Math.floor(l.start * rate)), Math.min(s.length, Math.ceil(l.end * rate)));
  const span = voicedSpan(seg, rate);
  if (!span) continue;
  const pad = Math.round(0.3 * rate);
  const cut = seg.subarray(Math.max(0, span[0] - pad), Math.min(seg.length, span[1] + pad));
  const file = path.join(CLIPS, `${l.block}-${String(l.i).padStart(2, '0')}.wav`);
  if (!fs.existsSync(file)) writeWav16(file, rate === 16000 ? cut : Float32Array.from({ length: Math.floor(cut.length * 16000 / rate) }, (_, i) => cut[Math.floor(i * rate / 16000)]));
  clips.push({ ...l, wav: file, seconds: cut.length / rate });
}
const isWake = (c) => /^(hey |okay |ok )?ares\b/i.test(c.text);
report.clips = { total: clips.length, byBlock: Object.fromEntries([...new Set(clips.map((c) => c.block))].map((b) => [b, clips.filter((c) => c.block === b).length])) };
console.log('clips', report.clips);

// ---- Text normalisation and word error rate ----------------------------------------------------------------------------
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const say = (n) => (n < 20 ? ONES[n] : n < 100 ? TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '') : n < 1000 ? `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${say(n % 100)}` : ''}` : String(n));
const ORD = { '1st': 'first', '2nd': 'second', '3rd': 'third', '20th': 'twentieth', '9th': 'ninth' };
export function norm(t) {
  return String(t || '').toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, (m) => ORD[m] || m).replace(/(\d+)\s*%/g, '$1 percent')
    .replace(/(\d+):(\d\d)/g, (_, h, m) => `${say(+h)} ${m === '00' ? '' : say(+m)}`).replace(/\d+/g, (d) => say(+d))
    .replace(/\bok\b/g, 'okay').replace(/[-–]/g, ' ').replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function wer(ref, hyp) {
  const r = norm(ref).split(' ').filter(Boolean), h = norm(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length };
}
const NAMES = [...new Set([...L.contacts, ...L.apps, ...L.projects, 'ARES', 'Dhruv'].map((n) => norm(n)).filter(Boolean))];
const namesIn = (t) => NAMES.filter((n) => ` ${norm(t)} `.includes(` ${n} `));

// ---- A4: hearing ----------------------------------------------------------------------------------------------------------
const transcripts = {}; // engine label → Map(wav → result)
async function asrRun(label, fn) {
  const cache = path.join(OUT, `asr-${label}.json`);
  if (fs.existsSync(cache)) { transcripts[label] = new Map(JSON.parse(fs.readFileSync(cache, 'utf8')).map((r) => [r.file, r])); return; }
  const t0 = Date.now();
  const res = await fn(clips.map((c) => c.wav));
  fs.writeFileSync(cache, JSON.stringify(res));
  transcripts[label] = new Map(res.map((r) => [r.file, r]));
  console.log(`asr ${label}: ${res.length} clips in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
function parakeet(version, vocab) {
  return async (files) => files.map((f) => {
    const out = path.join(os.tmpdir(), `pk-${process.pid}.json`);
    const t0 = Date.now();
    const a = [f, '--model-version', version, '--output-json', out, ...(vocab ? ['--custom-vocab', vocab, '--vocab-disable-spotter-rescue'] : [])];
    const p = spawnSync(FLUID, ['transcribe', ...a], { encoding: 'utf8' });
    let text = '', err = null;
    try { text = JSON.parse(fs.readFileSync(out, 'utf8')).text || ''; } catch { err = (p.stderr || '').slice(-200); }
    return { file: f, engine: `parakeet-${version}${vocab ? '+vocab' : ''}`, text, ms: Date.now() - t0, error: err };
  });
}
if (PARTS.includes('asr') || PARTS.includes('wake')) {
  await asrRun('sf-en-GB', (f) => transcribe('sf', f, { locale: 'en-GB' }));
}
if (PARTS.includes('asr')) {
  const vocab = path.join(OUT, 'vocab.txt'); // ARES and the names in this session; FluidAudio's "word: alias, alias" format
  fs.writeFileSync(vocab, ['ARES: Aries, Harris, Ares, Arez', 'Dhruv: Druv, Drove', ...L.contacts, ...L.apps, ...L.projects].join('\n') + '\n');
  const lm = path.join(OUT, 'lm-en-GB');
  if (!fs.existsSync(path.join(lm, 'lm'))) await command(['lm-build', lm, '--locale', 'en-GB']);
  await asrRun('sf-en-GB+lm', (f) => transcribe('sf', f, { locale: 'en-GB', lm }));
  if (!QUICK) await asrRun('sf-en-US', (f) => transcribe('sf', f, { locale: 'en-US' }));
  await asrRun('st-en-GB', (f) => transcribeJoined('st', f, { locale: 'en-GB' }));
  if (!QUICK) await asrRun('st-en-IN', (f) => transcribeJoined('st', f, { locale: 'en-IN' }));
  if (!QUICK) await asrRun('st-en-US', (f) => transcribeJoined('st', f, { locale: 'en-US' }));
  if (fs.existsSync(FLUID)) {
    await asrRun('parakeet-v2', parakeet('v2'));
    await asrRun('parakeet-v2+vocab', parakeet('v2', vocab));
    if (!QUICK) await asrRun('parakeet-v3', parakeet('v3'));
    if (!QUICK) await asrRun('parakeet-v3+vocab', parakeet('v3', vocab));
  }
  const asr = {};
  for (const [label, map] of Object.entries(transcripts)) {
    const by = {};
    let namesRef = 0, namesHit = 0;
    const lat = [];
    for (const c of clips) {
      const r = map.get(c.wav);
      if (!r) continue;
      const w = wer(c.text, r.text || '');
      const key = c.distance >= 3 ? 'far' : c.condition === 'quiet' ? 'near' : c.condition;
      (by[key] ??= { errors: 0, words: 0 }).errors += w.errors; by[key].words += w.words;
      (by.all ??= { errors: 0, words: 0 }).errors += w.errors; by.all.words += w.words;
      const want = namesIn(c.text), got = namesIn(r.text || '');
      namesRef += want.length; namesHit += want.filter((n) => got.includes(n)).length;
      if (Number.isFinite(r.ms)) lat.push(r.ms);
    }
    asr[label] = { wer: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, r3(v.errors / Math.max(1, v.words))])),
      names: `${namesHit}/${namesRef}`, msPerClip: { p50: pct(lat, 0.5), p95: pct(lat, 0.95) },
      errors: [...map.values()].filter((r) => r.error).length,
      worst: clips.map((c) => ({ c, r: map.get(c.wav) })).filter((x) => x.r).map((x) => ({ ref: x.c.text, hyp: x.r.text, e: wer(x.c.text, x.r.text || '').errors }))
        .sort((a, b) => b.e - a.e).slice(0, 5) };
  }
  report.asr = asr;
  save();
}

// ---- A2: wake word ----------------------------------------------------------------------------------------------------
const spotters = new Map();
function kwsScan(samples, { threshold, score }) {
  const key = `${threshold}/${score}`;
  if (!spotters.has(key)) spotters.set(key, makeSpotter(threshold, score));
  const kws = spotters.get(key);
  const st = kws.createStream();
  st.acceptWaveform({ samples: new Float32Array(16000), sampleRate: 16000 }); // a streaming model: it misses words at the very start
  st.acceptWaveform({ samples, sampleRate: 16000 });
  st.acceptWaveform({ samples: new Float32Array(8000), sampleRate: 16000 });
  const hits = [];
  while (kws.isReady(st)) { kws.decode(st); const k = kws.getResult(st); if (k.keyword) { hits.push({ keyword: k.keyword, t: k.start_time }); kws.reset(st); } }
  return hits;
}
function makeSpotter(threshold, score) {
  const dir = path.join(MODELS, 'kws/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01');
  const kwFile = path.join(os.tmpdir(), `kws-${threshold}-${score}.txt`);
  // The open-vocabulary spotter needs ARES spelled as it sounds: "ARES" tokenises like "are" and never fires; these do.
  const SPELLINGS = ['▁HE Y ▁A IR ES', '▁HE Y ▁A IR IES', '▁HE Y ▁A R IES', '▁OKAY ▁A IR ES', '▁OKAY ▁A IR IES'];
  fs.writeFileSync(kwFile, SPELLINGS.map((t, i) => `${t} :${score} #${threshold} @WAKE_${i}`).join('\n') + '\n');
  const kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: path.join(dir, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx'), decoder: path.join(dir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
      joiner: path.join(dir, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx') }, tokens: path.join(dir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
    keywordsFile: kwFile,
  });
  return kws;
}
/** livekit-wakeword: max score per clip and the scores over the other-voices audio (wake_score.py in its own env). */
function livekitScores(wavs) {
  const model = path.join(LAB, 'wakeword/output/hey_ares/hey_ares.onnx');
  if (!fs.existsSync(model)) return null;
  const list = path.join(os.tmpdir(), `lk-${process.pid}.json`);
  fs.writeFileSync(list, JSON.stringify(wavs));
  const p = spawnSync('uv', ['run', '--project', path.join(LAB, 'wakeword/livekit-wakeword'), 'python', '-I', path.join(import.meta.dirname, 'wake_score.py'), model, list], { encoding: 'utf8', maxBuffer: 1 << 26 });
  try { return JSON.parse(p.stdout); } catch { console.error('livekit scores:', p.stderr.slice(-400)); return null; }
}
if (PARTS.includes('wake')) {
  const sfT = transcripts['sf-en-GB'];
  const pos = clips.filter(isWake), neg = clips.filter((c) => !isWake(c));
  const conds = [...new Set(pos.map((c) => (c.distance >= 3 ? 'far 3 m' : c.distance >= 1 ? 'lean 1 m' : c.condition)))];
  const condOf = (c) => (c.distance >= 3 ? 'far 3 m' : c.distance >= 1 ? 'lean 1 m' : c.condition);
  const wake = { positives: pos.length, negatives: neg.length, conditions: {} };
  const others = labels.filter((l) => l.featuresOnly).map((l) => { const { s, rate } = blockAudio(l.file); return { s: s.subarray(Math.floor(l.start * rate), Math.floor(l.end * rate)), rate, seconds: l.end - l.start }; });
  const otherSeconds = others.reduce((a, o) => a + o.seconds, 0);
  const methods = {
    'regex today (SFSpeech)': (c) => wakeToday(sfT.get(c.wav)).woke,
    'regex + okay fix': (c) => wakeToday(sfT.get(c.wav), { okayFix: true }).woke,
  };
  const kwsSettings = QUICK ? [{ threshold: 0.2, score: 1.5 }] : [{ threshold: 0.3, score: 1.5 }, { threshold: 0.2, score: 2.0 }, { threshold: 0.1, score: 2.5 }];
  for (const k of kwsSettings) {
    const hit = new Map(clips.map((c) => [c.wav, kwsScan(readWav(c.wav).s, k).length > 0]));
    methods[`KWS thr ${k.threshold} boost ${k.score}`] = (c) => hit.get(c.wav);
    wake[`KWS thr ${k.threshold} boost ${k.score} on other voices`] = `${others.reduce((a, o) => a + kwsScan(o.s, k).length, 0)} in ${otherSeconds.toFixed(0)} s`;
  }
  const otherWavs = others.map((o, i) => { const f = path.join(os.tmpdir(), `others-${process.pid}-${i}.wav`); writeWav16(f, o.rate === 16000 ? o.s : Float32Array.from({ length: Math.floor(o.s.length * 16000 / o.rate) }, (_, j) => o.s[Math.floor(j * o.rate / 16000)])); return f; });
  const lk = livekitScores([...clips.map((c) => c.wav), ...otherWavs]);
  if (lk) {
    for (const thr of [0.3, 0.5, 0.68, 0.8, 0.9]) {
      methods[`livekit hey_ares ≥ ${thr}`] = (c) => (lk[c.wav]?.max ?? 0) >= thr;
      wake[`livekit hey_ares ≥ ${thr} on other voices`] = `${otherWavs.reduce((a, f) => a + (lk[f]?.fires[String(thr)] || 0), 0)} in ${otherSeconds.toFixed(0)} s`;
    }
    const evalJson = path.join(LAB, 'wakeword/output/hey_ares/hey_ares_eval.json'); // its own DET run on 25 h of validation audio
    if (fs.existsSync(evalJson)) wake['livekit eval (25 h validation set)'] = JSON.parse(fs.readFileSync(evalJson, 'utf8'));
  }
  for (const f of otherWavs) fs.rmSync(f, { force: true });
  for (const [name, fn] of Object.entries(methods)) {
    wake.conditions[name] = Object.fromEntries(conds.map((cd) => { const set = pos.filter((c) => condOf(c) === cd); return [cd, `${set.filter(fn).length}/${set.length}`]; }));
    wake.conditions[name].recall = `${pos.filter(fn).length}/${pos.length}`;
    wake.conditions[name].falseWakesOnOtherLines = `${neg.filter(fn).length}/${neg.length}`;
  }
  report.wake = wake;
  save();
}

// ---- A3: voice trust ---------------------------------------------------------------------------------------------------
const voicedOnly = (s) => { // voiceid.js voiced(): 20 ms frames well above the clip's quiet level, ±3 frames
  const F = 320, frames = Math.floor(s.length / F);
  if (frames < 5) return s;
  const rms = Array.from({ length: frames }, (_, f) => { let a = 0; for (let i = f * F; i < (f + 1) * F; i++) a += s[i] * s[i]; return Math.sqrt(a / F); });
  const sorted = [...rms].sort((a, b) => a - b);
  const gate = Math.max(sorted[Math.floor(frames * 0.2)] * 3, sorted[Math.floor(frames * 0.98)] * 0.12, 1e-4);
  const out = [];
  for (let f = 0; f < frames; f++) { let on = false; for (let d = -3; d <= 3 && !on; d++) on = rms[f + d] > gate; if (on) for (let i = f * F; i < (f + 1) * F; i++) out.push(s[i]); }
  return out.length >= 6400 ? Float32Array.from(out) : s;
};
const normv = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const meanv = (vs) => normv(vs[0].map((_, i) => vs.reduce((a, v) => a + v[i], 0)));
function eer(gen, imp) { // the error rate where false rejects equal false accepts
  let best = 1, gap = Infinity;
  for (const t of [...gen, ...imp]) {
    const frr = gen.filter((g) => g < t).length / gen.length, far = imp.filter((i) => i >= t).length / imp.length;
    if (Math.abs(frr - far) < gap) { gap = Math.abs(frr - far); best = (frr + far) / 2; }
  }
  return best;
}
const thrAtFar = (imp, far) => { const s = [...imp].sort((a, b) => b - a); return s[Math.max(0, Math.floor(far * s.length) - 1)] ?? 1; };
if (PARTS.includes('speaker')) {
  const models = ['nemo_en_titanet_small', 'wespeaker_en_voxceleb_CAM++_LM', '3dspeaker_speech_campplus_sv_en_voxceleb_16k', '3dspeaker_speech_eres2net_sv_en_voxceleb_16k',
    '3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common', 'nemo_en_titanet_large', 'wespeaker_en_voxceleb_resnet221_LM', 'wespeaker_en_voxceleb_resnet293_LM'].filter((m) => !QUICK || /small|CAM\+\+_LM|large/.test(m));
  const modelPath = (m) => (m === 'nemo_en_titanet_small' ? path.join(ROOT, 'models/speaker-titanet-small.onnx') : path.join(MODELS, 'speaker', `${m}.onnx`));
  // Impostors: the other-voices block in 1.5 s and 3 s windows, Katherine's cached clips, and (for the cohort) Kokoro voices
  const otherWins = [];
  for (const l of labels.filter((x) => x.featuresOnly)) {
    const { s, rate } = blockAudio(l.file);
    const seg = s.subarray(Math.floor(l.start * rate), Math.floor(l.end * rate));
    for (const w of [1.5, 3]) for (let o = 0; o + w * rate <= seg.length; o += w * rate) { const win = seg.subarray(o, o + w * rate); if (voicedSpan(win, rate)) otherWins.push({ s: win, rate, seconds: w }); }
  }
  const kath = fs.readdirSync(path.join(SUPPORT, 'voice-cache')).filter((f) => f.endsWith('.pcm')).slice(0, QUICK ? 40 : 120).map((f) => {
    const b = fs.readFileSync(path.join(SUPPORT, 'voice-cache', f)); const s = new Float32Array(b.length >> 1); for (let i = 0; i < s.length; i++) s[i] = b.readInt16LE(i * 2) / 32768; return { s, rate: 24000 };
  });
  const synthDir = opt('--cohort', path.join(os.tmpdir(), 'ares-synth-wake'));
  const ownerSid = clips[0]?.fake ? 26 : -1; // a fake session's "owner" is Kokoro voice 26: not in the cohort
  const cohortWavs = fs.existsSync(synthDir) ? fs.readdirSync(synthDir).filter((f) => f.endsWith('.wav') && !f.includes(`-${ownerSid}-`)).filter((_, i) => i % (QUICK ? 6 : 2) === 0).map((f) => readWav(path.join(synthDir, f))) : [];
  const genuine = clips.filter((c) => c.block !== 'speaking'); // (ARES talking underneath: barge-in material, scored separately below)
  // Enrolment: E1 = the desk wake lines (careful, quiet: like today's enrolment); E2 = multi-condition (even lines of wake, lean,
  // music, tv). Test = every owner line not used for that enrolment.
  const E1 = genuine.filter((c) => c.block === 'wake');
  const E2 = genuine.filter((c) => ['wake', 'lean', 'music', 'tv'].includes(c.block) && c.i % 2 === 0);
  const speaker = {};
  for (const m of models) {
    if (!fs.existsSync(modelPath(m))) continue;
    const ex = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath(m), numThreads: 4 });
    const emb = (s, rate) => { const st = ex.createStream(); st.acceptWaveform({ samples: s, sampleRate: rate }); st.inputFinished(); return normv(Array.from(ex.compute(st, false))); };
    const t0 = Date.now();
    const g = genuine.map((c) => { const { s } = readWav(c.wav); const v = voicedOnly(s); return { c, seconds: v.length / 16000, e: emb(v, 16000), e15: v.length > 1.5 * 16000 ? emb(v.subarray(0, 24000), 16000) : null }; });
    const msPer = (Date.now() - t0) / g.length / 2;
    const imp = [...otherWins.map((o) => ({ kind: 'other voices', seconds: o.seconds, e: emb(o.s, o.rate) })), ...kath.map((k) => ({ kind: 'Katherine', seconds: k.s.length / k.rate, e: emb(k.s, k.rate) }))];
    const cohort = cohortWavs.map((w) => emb(w.s, w.rate));
    const res = {};
    for (const [ename, enrol] of [['E1 desk only', E1], ['E2 multi-condition', E2]]) {
      const enrolV = g.filter((x) => enrol.includes(x.c)).map((x) => x.e);
      if (enrolV.length < 3) continue;
      const centroid = meanv(enrolV);
      const tests = g.filter((x) => !enrol.includes(x.c));
      const scorers = {
        centroid: (e) => cos(centroid, e),
        'top-3 of all enrolment vectors': (e) => { const s = enrolV.map((v) => cos(v, e)).sort((a, b) => b - a); return (s[0] + s[1] + s[2]) / 3; },
      };
      if (cohort.length >= 20) { // AS-norm: the score standardised against the top-K cohort scores of both sides
        const K = Math.min(100, cohort.length);
        const topStats = (e) => { const s = cohort.map((c) => cos(c, e)).sort((a, b) => b - a).slice(0, K); const mu = s.reduce((a, b) => a + b, 0) / K; const sd = Math.sqrt(s.reduce((a, b) => a + (b - mu) ** 2, 0) / K) || 1; return [mu, sd]; };
        const [me, se] = topStats(centroid);
        scorers['centroid + AS-norm'] = (e) => { const raw = cos(centroid, e); const [mt, st] = topStats(e); return 0.5 * ((raw - me) / se + (raw - mt) / st); };
      }
      for (const [sname, fn] of Object.entries(scorers)) {
        const whole = tests.map((x) => ({ s: fn(x.e), sec: x.seconds, c: x.c }));
        const short = tests.filter((x) => x.e15).map((x) => fn(x.e15));
        const impS = imp.map((i) => fn(i.e));
        const impShort = imp.filter((i) => i.seconds <= 1.6).map((i) => fn(i.e));
        const t1 = thrAtFar(impS, 0.01), t5 = thrAtFar(impS, 0.05);
        const usable = whole.filter((w) => w.sec >= 1); // under 1 s of voice = no evidence, not a rejection
        const bucket = (lo, hi) => { const b = usable.filter((w) => w.sec >= lo && w.sec < hi); return b.length ? `${b.filter((w) => w.s < t1).length}/${b.length}` : '-'; };
        const cond = (f) => { const b = usable.filter((w) => f(w.c)); return b.length ? `${b.filter((w) => w.s < t1).length}/${b.length}` : '-'; };
        res[`${ename} · ${sname}`] = {
          eer: r3(eer(usable.map((w) => w.s), impS)), eer1p5s: short.length && impShort.length ? r3(eer(short, impShort)) : null,
          frrAtFar1pct: r3(usable.filter((w) => w.s < t1).length / usable.length), frrAtFar5pct: r3(usable.filter((w) => w.s < t5).length / usable.length),
          noEvidenceUnder1s: `${whole.length - usable.length}/${whole.length}`,
          rejectedAtFar1pct: { '1–2 s': bucket(1, 2), '2–3 s': bucket(2, 3), '3 s+': bucket(3, 99), near: cond((c) => c.distance < 1 && c.condition === 'quiet'), '1 m': cond((c) => c.distance === 1), '3 m': cond((c) => c.distance >= 3), music: cond((c) => c.condition === 'music'), tv: cond((c) => c.condition === 'tv') },
          katherineMax: r3(Math.max(...imp.filter((i) => i.kind === 'Katherine').map((i) => fn(i.e)))),
        };
      }
    }
    // Today exactly: TitaNet-small against the real voiceprint and its 0.48 threshold (only meaningful on a real session)
    if (m === 'nemo_en_titanet_small' && !clips[0]?.fake) {
      const vp = JSON.parse(fs.readFileSync(path.join(SUPPORT, 'voiceprint.json'), 'utf8'));
      const acc = g.filter((x) => cos(vp.centroid, x.e) >= vp.threshold);
      res.today = { acceptRate: r3(acc.length / g.length), byBlock: Object.fromEntries([...new Set(g.map((x) => x.c.block))].map((b) => [b, `${acc.filter((x) => x.c.block === b).length}/${g.filter((x) => x.c.block === b).length}`])), threshold: vp.threshold };
    }
    speaker[m] = { msPerEmbedding: Math.round(msPer), ...res };
    console.log(`speaker ${m}: done`);
  }
  speaker.trials = { owner: genuine.length, otherVoiceWindows: otherWins.length, katherine: kath.length, cohort: cohortWavs.length };
  report.speaker = speaker;
  save();
  // Other people's voices: features only. The block's audio goes now that its embeddings and wake scores are taken.
  if (!clips[0]?.fake && !args.includes('--keep-others')) for (const l of labels.filter((x) => x.featuresOnly)) { try { fs.unlinkSync(path.join(SESSION, l.file)); } catch {} }
}

// ---- A5: end of turn -----------------------------------------------------------------------------------------------------
if (PARTS.includes('eot')) {
  const wordsFor = transcripts['st-en-GB'] || transcripts['sf-en-GB'];
  const list = clips.filter((c) => ['pauses', 'commands'].includes(c.block)).map((c) => ({ wav: c.wav, words: wordsFor?.get(c.wav)?.segments || [] }));
  const lf = path.join(OUT, 'eot-clips.json');
  fs.writeFileSync(lf, JSON.stringify(list));
  const p = spawnSync('uv', ['run', '-q', '--no-project', '--with', 'numpy', '--with', 'onnxruntime', '--with', 'soundfile', '--with', 'transformers', 'python', '-I', path.join(import.meta.dirname, 'eot.py'), lf, MODELS], { encoding: 'utf8', maxBuffer: 1 << 26 });
  try { report.eot = JSON.parse(p.stdout); delete report.eot.rows; fs.writeFileSync(path.join(OUT, 'eot-full.json'), p.stdout); } catch { report.eot = { error: p.stderr.slice(-600) }; }
  save();
}
console.log(JSON.stringify(report, null, 1));
