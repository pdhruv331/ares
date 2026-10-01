// ARES's backup voice: Kokoro-82M (Apache-2.0) via sherpa-onnx, in a worker thread so synthesis never
// blocks the main process. Requests are spoken strictly in arrival order (sentences stay in order); each
// sentence is split into clause-sized pieces and every piece is posted as soon as it's rendered, so the
// first words play while the rest is still being made. Output: 24 kHz 16-bit mono PCM, the same as
// ElevenLabs' pcm_24000, so everything downstream (window, listener, phone app, Telegram) is unchanged.
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const sherpa = require('sherpa-onnx-node');

const { dir, threads = 4 } = workerData;
const fs = require('fs');
// The full-precision model is about twice as fast as int8 on Apple silicon; int8 if that's all there is
const model = ['model.onnx', 'model.int8.onnx'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));

let tts;
try {
  tts = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model,
        voices: path.join(dir, 'voices.bin'),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
        lexicon: path.join(dir, 'lexicon-gb-en.txt'), // British pronunciations
        lang: 'en', // espeak-ng's 'en' is British English
      },
      numThreads: threads,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  });
  // Warm up, so the first real sentence isn't slowed by one-off initialisation
  tts.generate({ text: 'Ready.', sid: 21, speed: 1 });
  parentPort.postMessage({ type: 'ready', model: path.basename(model), rate: tts.sampleRate });
} catch (err) {
  parentPort.postMessage({ type: 'failed', error: err.message });
}

/** Split a sentence into pieces at clause boundaries: a short first piece (fast first audio), then
 *  pieces of up to ~140 characters. Pauses at commas are natural, so the joins aren't audible. */
function pieces(text) {
  const out = [];
  let rest = text;
  let first = true;
  while (rest.length > (first ? 40 : 140)) {
    const window = rest.slice(0, first ? 110 : 180);
    const re = /[,;:—–]\s+|\s+-\s+/g;
    let cut = -1;
    let m;
    // The first piece breaks at the EARLIEST clause boundary (fast first audio); later ones at the last that fits
    while ((m = re.exec(window))) {
      const end = m.index + m[0].length;
      if (m.index < 15 || rest.length - end < 12) continue; // no tiny fragments either side
      if (first) { cut = end; break; }
      if (end <= 160) cut = end;
    }
    if (cut < 0) break; // no clause boundary: keep it whole (splitting mid-clause sounds worse)
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
    first = false;
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** Float samples -> 16-bit PCM in its own ArrayBuffer (transferable; Apple silicon is little-endian). */
function toPcm(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  return out.buffer;
}

const queue = [];
const cancelled = new Set();
let busy = false;

function next() {
  if (busy || !queue.length) return;
  const job = queue[0];
  if (cancelled.has(job.id) || !job.parts.length) {
    queue.shift();
    const wasCancelled = cancelled.delete(job.id);
    parentPort.postMessage({ type: 'end', id: job.id, cancelled: wasCancelled });
    return setImmediate(next);
  }
  busy = true;
  const part = job.parts.shift();
  try {
    const audio = tts.generate({ text: part, sid: job.sid, speed: job.speed });
    const pcm = toPcm(audio.samples);
    parentPort.postMessage({ type: 'pcm', id: job.id, pcm }, [pcm]);
  } catch (err) {
    queue.shift();
    parentPort.postMessage({ type: 'end', id: job.id, error: err.message });
  }
  busy = false;
  setImmediate(next); // lets cancel messages in between pieces
}

parentPort.on('message', (msg) => {
  if (msg.type === 'speak') {
    if (!tts) return parentPort.postMessage({ type: 'end', id: msg.id, error: 'backup voice unavailable' });
    queue.push({ id: msg.id, parts: pieces(msg.text), sid: msg.sid, speed: msg.speed });
    next();
  } else if (msg.type === 'cancel') {
    if (queue.some((j) => j.id === msg.id)) cancelled.add(msg.id);
  }
});
