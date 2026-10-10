// The stage-A recording session at the desk (docs/voice-prompt.md A2–A5): prompts one line at a time, you say it, press
// Enter, and the next comes up. Audio goes through the same voice processing ARES hears with (native/build/ares-voicelab),
// 16 kHz WAV per block, into <support>/voice-lab/session-<date>/ with labels.jsonl (block, distance, condition, the
// reference text, start/end in the block's file). Your own voice only; nothing leaves the Mac; delete the folder when done.
//
//   node scripts/voice-lab/record-session.mjs [--blocks wake,commands,pauses,far,music,speaking] [--dry]
//   Mute the installed ARES first (◉ → Mute): two copies of voice processing can't share the microphone.
// Keys during a block: Enter = done, next line · r = redo the last line · s = skip · q = finish the block early.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { recorder } from './lab.mjs';
import { audioDevices } from './devices.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const SUPPORT = path.join(os.homedir(), 'Library/Application Support/ARES');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const DIR = opt('--dir', path.join(SUPPORT, 'voice-lab', `session-${stamp}`));

import { BLOCKS, fillIn } from './session-lines.mjs';

const ORDER = opt('--blocks', 'wake,commands,pauses,lean,far,music,tv,speaking,budsMic,budsMacMic,others').split(',');

// ---- Kokoro lines playing while she "speaks" (another process, the way the window plays her) -------------------------
async function makeVoiceClips() {
  const out = path.join(DIR, 'tts');
  fs.mkdirSync(out, { recursive: true });
  const lines = ['Your next meeting is at three, with the design team, in the small room on the second floor.',
    'I checked the forecast: it should stay dry until about five, then light rain moving in from the west.',
    'ARES here. Three jobs are running, and the weather app project is waiting for your OK on the deploy step.',
    'Right, I have found two files that match. The newer one is from yesterday afternoon, called draft notes.'];
  const files = lines.map((_, i) => path.join(out, `ares-${i}.wav`));
  if (files.every((f) => fs.existsSync(f))) return files;
  const sherpa = (await import('module')).createRequire(import.meta.url)(path.join(ROOT, 'node_modules/sherpa-onnx-node'));
  const k = path.join(SUPPORT, 'models/kokoro-v1_0');
  const tts = new sherpa.OfflineTts({ model: { kokoro: { model: path.join(k, 'model.onnx'), voices: path.join(k, 'voices.bin'), tokens: path.join(k, 'tokens.txt'),
    dataDir: path.join(k, 'espeak-ng-data'), lexicon: path.join(k, 'lexicon-gb-en.txt') }, numThreads: 2 } });
  lines.forEach((t, i) => { const a = tts.generate({ text: t, sid: 21, speed: 1.0 }); sherpa.writeWave(files[i], { samples: a.samples, sampleRate: a.sampleRate }); });
  return files;
}

// ---- Running a block -------------------------------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin });
const keys = [];
const typed = []; // lines typed ahead of the prompt
rl.on('line', (l) => { const w = keys.shift(); if (w) w(l.trim().toLowerCase()); else typed.push(l.trim().toLowerCase()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => (typed.length ? Promise.resolve(typed.shift()) : new Promise((r) => keys.push(r)));

function makeRecorder() {
  if (DRY) return { send() {}, wait: async () => ({ seconds: 0 }), level: 0, close: async () => {} };
  return recorder({ vpio: !args.includes('--no-vpio') });
}

async function runBlock(name, rec, labels, clips) {
  const b = BLOCKS[name];
  const file = path.join(DIR, `${name}.wav`);
  console.log(`\n=== ${b.title} ===\n${b.timed ? `${b.timed} s of room audio` : `${b.lines.length} lines`}. Press Enter to start.`);
  await key();
  const devices = audioDevices();
  if (b.checkInput && devices.input?.transport !== b.checkInput) {
    console.log(`  The input is ${devices.input?.name || 'unknown'} (${devices.input?.transport || '?'}), not the ${b.checkInput} one this block needs: skipping it.`);
    return;
  }
  // The recorder uses the input that was default when it started: restart it so a switched microphone takes effect
  if (b.checkInput && !DRY) { await rec.close(); Object.assign(rec, makeRecorder()); await rec.wait('ready', 120_000); }
  rec.send(`rec ${file}`);
  const t0 = Date.now();
  let player = null;
  let clipIdx = 0;
  const playNext = () => { if (!clips) return; player = spawn('afplay', [clips[clipIdx++ % clips.length]]); player.on('exit', (code, sig) => { if (sig !== 'SIGTERM') setTimeout(playNext, 400); }); };
  if (b.voice) playNext();
  if (b.timed) { // a stretch of room audio, not lines: counts down, then stops
    for (let left = b.timed; left > 0; left--) { // (lines typed meanwhile wait in `typed`; q + Enter ends it early)
      process.stdout.write(`\r  recording… ${left} s left (q + Enter to stop early) `);
      await sleep(1000);
      if (typed.includes('q')) { typed.splice(typed.indexOf('q'), 1); break; }
    }
    labels.write(JSON.stringify({ block: name, file: path.basename(file), i: 0, text: '', start: 0, end: +((Date.now() - t0) / 1000).toFixed(2), distance: b.distance, condition: b.condition, featuresOnly: true }) + '\n');
    console.log();
  }
  for (let i = 0; i < b.lines.length; i++) {
    const text = fillIn(b.lines[i]);
    const start = (Date.now() - t0) / 1000;
    process.stdout.write(`  [${i + 1}/${b.lines.length}] ${text}\n      (Enter = next · r = redo · s = skip · q = end block) `);
    const k = await key();
    const end = (Date.now() - t0) / 1000;
    if (k === 'r') { i--; continue; }
    if (k === 'q') break;
    if (k === 's') continue;
    labels.write(JSON.stringify({ block: name, file: path.basename(file), i, text, start: +start.toFixed(2), end: +end.toFixed(2), distance: b.distance, condition: b.condition, input: devices.input?.name, output: devices.output?.name }) + '\n');
  }
  if (player) { player.removeAllListeners('exit'); player.kill('SIGTERM'); }
  rec.send('stop');
  const saved = await rec.wait('saved');
  console.log(`  saved ${path.basename(file)} (${saved.seconds?.toFixed?.(0) ?? 0} s)`);
}

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
console.log(`Voice lab session → ${DIR}\nMute the installed ARES first (◉ → Mute) so this can have the microphone.`);
const labels = fs.createWriteStream(path.join(DIR, 'labels.jsonl'), { flags: 'a' });
const clips = ORDER.includes('speaking') && !DRY ? await makeVoiceClips() : null;
const rec = makeRecorder();
if (!DRY) console.log('  microphone:', JSON.stringify(await rec.wait('ready', 120_000)));
for (const name of ORDER) if (BLOCKS[name]) await runBlock(name, rec, labels, clips);
await rec.close();
labels.end();
rl.close();
console.log('\nDone. Everything is in', DIR);
