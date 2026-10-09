// Talks to "ARES Voice Lab.app" (native/AresVoiceLab.swift; build with zsh scripts/voice-lab/build.sh). It's launched with
// `open` so macOS treats it as its own app (mic and speech permissions in its own name, not Claude's or Terminal's):
// commands go in through a named pipe, events come back through a file.
import { spawn, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const APP = path.join(import.meta.dirname, '..', '..', 'native/build/ARES Voice Lab.app');

function launch(args, withStdin) {
  if (!fs.existsSync(APP)) throw new Error('build it first: zsh scripts/voice-lab/build.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-voicelab-'));
  const out = path.join(dir, 'out.jsonl');
  const err = path.join(dir, 'err.txt');
  fs.writeFileSync(out, '');
  let stdin = '/dev/null';
  if (withStdin) { stdin = path.join(dir, 'in'); execFileSync('mkfifo', [stdin]); }
  const child = spawn('open', ['-W', '-n', '-g', '--stdin', stdin, '--stdout', out, '--stderr', err, APP, '--args', ...args], { stdio: 'ignore' });
  return { dir, out, err, stdin, child };
}

/** Follows the helper's stdout file, calling onLine for each JSON line. Returns stop(). */
function follow(file, onLine) {
  let pos = 0, buf = '';
  const tick = () => {
    const size = fs.statSync(file).size;
    if (size <= pos) return;
    const fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(size - pos);
    fs.readSync(fd, chunk, 0, chunk.length, pos);
    fs.closeSync(fd);
    pos = size;
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { onLine(JSON.parse(line)); } catch {}
    }
  };
  const timer = setInterval(tick, 50);
  return () => { tick(); clearInterval(timer); };
}

/** Transcribe files on device. engine: 'sf' | 'st'. Resolves with one result per file. */
export function transcribe(engine, files, { locale = 'en-GB', context = null, lm = null, timeoutS = null } = {}) {
  const args = [engine, '--locale', locale, ...(timeoutS ? ['--timeout', String(timeoutS)] : []), ...(context ? ['--context', context.join(',')] : []), ...(lm ? ['--lm', lm] : []), ...files];
  const run = launch(args, false);
  const results = [];
  const stop = follow(run.out, (m) => { if (m.file || m.type === 'error') results.push(m); });
  return new Promise((resolve) => run.child.on('exit', () => {
    stop();
    const errText = fs.readFileSync(run.err, 'utf8').split('\n').filter((l) => l && !/Assistant asset/.test(l)).join('\n');
    fs.rmSync(run.dir, { recursive: true, force: true });
    resolve(Object.assign(results, { stderr: errText }));
  }));
}

/** Run a one-off subcommand (locales, lm-build) and resolve with its JSON lines. */
export function command(args) {
  const run = launch(args, false);
  const lines = [];
  const stop = follow(run.out, (m) => lines.push(m));
  return new Promise((resolve) => run.child.on('exit', () => { stop(); fs.rmSync(run.dir, { recursive: true, force: true }); resolve(lines); }));
}

/** The recorder: send('rec <file>'), send('stop'), send('play <file>'), wait('saved'); events: 'event' (every JSON line). */
export function recorder({ vpio = true } = {}) {
  const run = launch(['record', ...(vpio ? [] : ['--no-vpio'])], true);
  const r = new EventEmitter();
  r.level = 0;
  const pipe = fs.createWriteStream(run.stdin); // (opens once the helper opens its end)
  pipe.on('error', () => {}); // the helper exited (its error event says why): don't take Node down with EPIPE
  const stop = follow(run.out, (m) => { if (m.type === 'level') r.level = m.rms; r.emit('event', m); r.emit(m.type, m); });
  r.send = (cmd) => pipe.write(cmd + '\n');
  r.wait = (type, ms = 30_000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`voice lab: no "${type}" in ${ms / 1000}s (permission prompt waiting? ${fs.readFileSync(run.err, 'utf8').slice(-300)})`)), ms);
    r.once(type, (m) => { clearTimeout(t); resolve(m); });
  });
  r.close = () => new Promise((resolve) => {
    r.send('quit');
    pipe.end();
    run.child.on('exit', () => { stop(); fs.rmSync(run.dir, { recursive: true, force: true }); resolve(); });
    setTimeout(() => run.child.kill(), 5000);
  });
  r.on('error', (m) => console.error('  voice lab:', m.message));
  return r;
}

// ---- Many short clips through one recogniser pass (SpeechTranscriber is slow and can stall when set up per file) -------
function readWav(file) {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(24);
  let off = 12;
  while (off < b.length - 8 && b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const n = b.readUInt32LE(off + 4) >> 1;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
  return { s, rate };
}
const to16k = ({ s, rate }) => {
  if (rate === 16000) return s;
  const out = new Float32Array(Math.floor(s.length * 16000 / rate));
  for (let i = 0; i < out.length; i++) { const x = i * rate / 16000, j = Math.floor(x), f = x - j; out[i] = s[j] * (1 - f) + (s[j + 1] ?? 0) * f; }
  return out;
};
export function writeWav16(file, samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}
export { readWav };

/** Transcribe many clips as one file (clips joined by `gap` s of silence); results per clip, words assigned by time. */
export async function transcribeJoined(engine, files, { gap = 3, batch = 120, ...opts } = {}) {
  const out = [];
  for (let b = 0; b < files.length; b += batch) {
    const part = files.slice(b, b + batch);
    const spans = [];
    const chunks = [];
    let t = 0;
    for (const f of part) {
      const s = to16k(readWav(f));
      spans.push({ file: f, start: t, end: t + s.length / 16000 });
      chunks.push(s, new Float32Array(Math.round(gap * 16000)));
      t += s.length / 16000 + gap;
    }
    const all = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const joined = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ares-joined-')), 'joined.wav');
    writeWav16(joined, all);
    const [r] = await transcribe(engine, [joined], { ...opts, timeoutS: Math.ceil(t) + 60 });
    for (const sp of spans) {
      // each word belongs to the clip whose span (widened to the middle of the gaps either side) holds its midpoint
      const segs = (r?.segments || []).filter((g) => g.t + g.d / 2 >= sp.start - gap / 2 && g.t + g.d / 2 < sp.end + gap / 2)
        .map((g) => ({ ...g, t: g.t - sp.start }));
      out.push({ file: sp.file, engine, text: segs.map((g) => g.s).join('').replace(/\s+/g, ' ').trim(), segments: segs, error: r?.error, ms: r?.ms ? Math.round(r.ms * (sp.end - sp.start) / t) : null });
    }
    fs.rmSync(path.dirname(joined), { recursive: true, force: true });
  }
  return out;
}
