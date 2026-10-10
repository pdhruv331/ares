// A6 (docs/voice-prompt.md): does macOS voice processing (VPIO) cancel audio played by ANOTHER process (the ARES window,
// a browser), or only audio its own engine plays? Plays one Kokoro passage through the speakers in each condition, records
// what the mic hears, and reports echo reduction (ERLE, dB) and how many of her words the recogniser still hears.
// AUDIBLE for ~3 minutes. Run only with the owner's go, with the installed ARES muted and the room quiet.
//   node scripts/voice-lab/echo-test.mjs --go
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { recorder, readWav, transcribe } from './lab.mjs';
import { audioDevices } from './devices.mjs';

if (!process.argv.includes('--go')) { console.error('Plays audio through the speakers for ~3 minutes. Mute the installed ARES, keep the room quiet, then pass --go.'); process.exit(1); }
const OUT = path.join(os.homedir(), 'Library/Application Support/ARES/voice-lab', `echo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
try { if (execFileSync('pgrep', ['-f', 'echo-test.mjs --go'], { encoding: 'utf8' }).trim().split('\n').length > 1) { console.error('Another echo test is already running.'); process.exit(1); } } catch {}
fs.mkdirSync(OUT, { recursive: true });
const TEXT = 'Your next meeting is at three with the design team. I checked the forecast and it should stay dry until about five, then light rain moves in from the west. Three jobs are running, and the weather app project is waiting for your OK.';
const volume = execFileSync('osascript', ['-e', 'output volume of (get volume settings)'], { encoding: 'utf8' }).trim();
const muted = execFileSync('osascript', ['-e', 'output muted of (get volume settings)'], { encoding: 'utf8' }).trim() === 'true';
if (muted || Number(volume) < 20) { // nothing (or almost nothing) would reach the mic: the numbers would be meaningless
  console.error(`The speakers are ${muted ? 'muted' : `at ${volume}%`}. Unmute and set the volume where you normally have ARES (about 50%), then run this again.`);
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
}
const require = createRequire(import.meta.url);
const sherpa = require(path.join(import.meta.dirname, '../../node_modules/sherpa-onnx-node'));
const k = path.join(os.homedir(), 'Library/Application Support/ARES/models/kokoro-v1_0');
const passage = path.join(OUT, 'passage.wav');
{
  const tts = new sherpa.OfflineTts({ model: { kokoro: { model: path.join(k, 'model.onnx'), voices: path.join(k, 'voices.bin'), tokens: path.join(k, 'tokens.txt'),
    dataDir: path.join(k, 'espeak-ng-data'), lexicon: path.join(k, 'lexicon-gb-en.txt'), lang: 'en' }, numThreads: 4 } });
  const a = tts.generate({ text: TEXT, sid: 21, speed: 1 });
  sherpa.writeWave(passage, { samples: a.samples, sampleRate: a.sampleRate });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const energy = (file) => { const { s } = readWav(file); let a = 0; for (const v of s) a += v * v; return a / Math.max(1, s.length); };

async function capture(name, vpio, play) {
  const rec = recorder({ vpio });
  await rec.wait('ready', 120_000);
  await sleep(1500); // voice processing settles
  const file = path.join(OUT, `${name}.wav`);
  rec.send(`rec ${file}`);
  await sleep(500);
  if (play === 'other') await new Promise((r) => spawn('afplay', [passage]).on('exit', r));
  else if (play === 'engine') { rec.send(`play ${passage}`); await rec.wait('played', 60_000); }
  else await sleep(15_000);
  await sleep(800);
  rec.send('stop');
  await rec.wait('saved');
  await rec.close();
  console.log(`  ${name} recorded`);
  return file;
}

const dev = audioDevices();
console.log(`Echo test → ${OUT}\nInput: ${dev.input?.name}, output: ${dev.output?.name} at ${volume}%. Stay quiet for about three minutes.`);
const f = {
  silenceOff: await capture('silence-vpio-off', false, null),
  silenceOn: await capture('silence-vpio-on', true, null),
  otherOff: await capture('other-process-vpio-off', false, 'other'),
  otherOn: await capture('other-process-vpio-on', true, 'other'),
  engineOn: await capture('engine-vpio-on', true, 'engine'),
  engineOff: await capture('engine-vpio-off', false, 'engine'),
};
const E = Object.fromEntries(Object.entries(f).map(([kk, v]) => [kk, energy(v)]));
const db = (x) => +(10 * Math.log10(Math.max(x, 1e-12))).toFixed(1);
const erle = (raw, nRaw, proc, nProc) => db(Math.max(raw - nRaw, 1e-12) / Math.max(proc - nProc, 1e-12));
const words = (t) => (t.toLowerCase().match(/[a-z']+/g) || []);
const said = new Set(words(TEXT));
const tr = await transcribe('sf', Object.values(f), { locale: 'en-GB' });
const heard = Object.fromEntries(Object.keys(f).map((kk, i) => { const w = words(tr[i]?.text || ''); return [kk, `${w.filter((x) => said.has(x)).length}/${words(TEXT).length} of her words`]; }));
const result = {
  devices: audioDevices(), // speakers vs earbuds change everything: always say which
  outputVolume: `${volume}%`,
  levelsDb: Object.fromEntries(Object.entries(E).map(([kk, v]) => [kk, db(v)])),
  erleOtherProcessDb: erle(E.otherOff, E.silenceOff, E.otherOn, E.silenceOn),
  erleEngineOwnedDb: erle(E.engineOff, E.silenceOff, E.engineOn, E.silenceOn),
  recogniserHears: heard,
};
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
