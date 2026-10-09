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
export function transcribe(engine, files, { locale = 'en-GB', context = null, lm = null } = {}) {
  const args = [engine, '--locale', locale, ...(context ? ['--context', context.join(',')] : []), ...(lm ? ['--lm', lm] : []), ...files];
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
