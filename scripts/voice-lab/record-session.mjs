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

const ROOT = path.join(import.meta.dirname, '..', '..');
const SUPPORT = path.join(os.homedir(), 'Library/Application Support/ARES');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const DIR = opt('--dir', path.join(SUPPORT, 'voice-lab', `session-${stamp}`));

// ---- The lines ---------------------------------------------------------------------------------------------------
// Personal names come from this Mac (contacts, apps, ARES projects) and stay in the local labels file only.
function locals() {
  let contacts = [];
  try {
    contacts = JSON.parse(fs.readFileSync(path.join(SUPPORT, 'contacts.json'), 'utf8'))
      .map((c) => (c.nickname || c.name || '').trim()).filter((n) => /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(n));
  } catch {}
  const apps = fs.readdirSync('/Applications').filter((a) => a.endsWith('.app')).map((a) => a.replace(/\.app$/, '')).filter((a) => /^[A-Za-z][A-Za-z ]{2,15}$/.test(a));
  let projects = [];
  try { projects = fs.readdirSync(path.join(os.homedir(), 'ARES Projects')).filter((p) => !p.startsWith('.')).map((p) => p.replace(/[-_]/g, ' ')); } catch {}
  const pick = (list, n, d) => { const out = []; for (let i = 0; i < n; i++) out.push(list.length ? list[(i * 7919 + 13) % list.length] : d[i % d.length]); return out; };
  return { contacts: pick(contacts, 12, ['Sam', 'Priya', 'Tom']), apps: pick(apps, 8, ['Notes', 'Safari', 'Music']), projects: pick(projects, 3, ['weather app']) };
}
const L = locals();

const WAKE = [
  'Hey ARES, what time is it?', 'Hey ARES, set a timer for five minutes.', 'Hey ARES, what\'s the weather like?', 'Hey ARES, pause the music.',
  'Hey ARES, how are my jobs doing?', 'Hey ARES, open {app0}.', 'Hey ARES, remind me to call {c0} at six.', 'Hey ARES.',
  'Hey ARES, are you there?', 'Hey ARES, turn the volume down.', 'ARES, what\'s next on my calendar?', 'ARES, stop.',
];
const COMMANDS = [
  'What\'s on my calendar tomorrow morning?', 'Text {c1} that I\'ll be ten minutes late.', 'Call {c2}.', 'Open {app1} and {app2}.',
  'Quit {app3}.', 'Set a timer for twenty-five minutes.', 'Remind me to take the bins out at eight tonight.', 'What\'s the weather in Manchester this weekend?',
  'Play something relaxing.', 'Skip this track.', 'Turn the volume up to sixty percent.', 'Lock the screen.', 'How much battery have I got left?',
  'Send the last screenshot to my phone.', 'Find the PDF I downloaded yesterday.', 'Read me my latest email from {c3}.', 'Email {c4} about Friday\'s meeting.',
  'What\'s my {p0} project doing?', 'Start a new project for a habit tracker app.', 'Stop everything.', 'Go quiet.', 'Stay awake.',
  'How\'s my Claude usage looking?', 'Show me my week.', 'What\'s on the twentieth?', 'Add oat milk to my shopping list.',
  'Take a note: ask the landlord about the boiler.', 'Convert eighty kilos to pounds.', 'How do you spell rhythm?', 'What\'s fifteen percent of two hundred and forty?',
  'Turn on do not disturb for an hour.', 'Mute yourself for twenty minutes.', 'Who is {c5}?', 'When did I last talk to {c6}?',
  'Summarise my unread emails.', 'What did Dhruv say about the launcher yesterday?', 'Tell ARES to forget my old address.', 'Never mind.',
  'Say that again.', 'Thanks, that\'s all.', 'Explain how a heat pump works, briefly.', 'Is it going to rain before five?',
  'Move my three o\'clock to four.', 'Cancel the timer.', 'Open the Downloads folder.', 'What\'s the time in Tokyo?',
  'Text {c7} happy birthday.', 'Search the web for the best standing desks.', 'Put the reactor look back on.', 'Power down.',
];
const PAUSES = [ // say these the way you'd think out loud: pause where the dots are
  'Remind me to... um... call {c8} tomorrow at... nine.', 'Can you find the... the file I was working on for {p0}... yesterday afternoon.',
  'What\'s the... hmm... weather going to be like on Saturday?', 'Send {c9} a message saying... I\'ll be there around... half seven.',
  'Set a timer for... let\'s say... twelve minutes.', 'Open {app4} and then... actually also {app5}.', 'I want to plan... a weekend in... Edinburgh, maybe.',
  'Tell me about... the history of... the London Underground.', 'Add to my list... eggs, bread... and coffee.', 'How long would it take to... drive to... Bristol from here?',
  'What was the name of that... the restaurant {c10} recommended?', 'Move my... meeting with {c11}... to Thursday.', 'Turn the volume... down a bit.',
  'So... what\'s on today?', 'And then... remind me about it at four.',
];
const fillIn = (t) => t.replace(/\{c(\d+)\}/g, (_, i) => L.contacts[i % L.contacts.length]).replace(/\{app(\d+)\}/g, (_, i) => L.apps[i % L.apps.length])
  .replace(/\{p(\d+)\}/g, (_, i) => L.projects[i % L.projects.length]);

// Each block: where you sit, what's going on in the room, and the lines
const BLOCKS = {
  wake: { title: 'Wake word, at the desk (about half a metre)', distance: 0.5, condition: 'quiet', lines: WAKE },
  commands: { title: 'Commands, at the desk', distance: 0.5, condition: 'quiet', lines: COMMANDS },
  pauses: { title: 'Thinking out loud: pause where the dots are, the way you would', distance: 0.5, condition: 'quiet', lines: PAUSES },
  lean: { title: 'Wake word, leaning back (about 1 metre)', distance: 1, condition: 'quiet', lines: WAKE },
  far: { title: 'Across the room (about 3 metres): wake word, then a few commands', distance: 3, condition: 'quiet', lines: [...WAKE, ...COMMANDS.slice(0, 15)] },
  music: { title: 'At the desk with music playing at your normal level (start it yourself now)', distance: 0.5, condition: 'music', lines: [...WAKE, ...COMMANDS.slice(15, 30)] },
  tv: { title: 'At the desk with a TV show or YouTube talking in the background (start it yourself now)', distance: 0.5, condition: 'tv', lines: [...WAKE, ...COMMANDS.slice(30, 40)] },
  speaking: { title: 'While ARES is talking (the backup voice plays through the speakers): cut in with the wake word', distance: 0.5, condition: 'speaking', lines: WAKE, voice: true },
};
const ORDER = opt('--blocks', 'wake,commands,pauses,lean,far,music,tv,speaking').split(',');

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
const key = () => (typed.length ? Promise.resolve(typed.shift()) : new Promise((r) => keys.push(r)));

function makeRecorder() {
  if (DRY) return { send() {}, wait: async () => ({ seconds: 0 }), level: 0, close: async () => {} };
  return recorder({ vpio: !args.includes('--no-vpio') });
}

async function runBlock(name, rec, labels, clips) {
  const b = BLOCKS[name];
  const file = path.join(DIR, `${name}.wav`);
  console.log(`\n=== ${b.title} ===\n${b.lines.length} lines. Press Enter to start.`);
  await key();
  rec.send(`rec ${file}`);
  const t0 = Date.now();
  let player = null;
  let clipIdx = 0;
  const playNext = () => { if (!clips) return; player = spawn('afplay', [clips[clipIdx++ % clips.length]]); player.on('exit', (code, sig) => { if (sig !== 'SIGTERM') setTimeout(playNext, 400); }); };
  if (b.voice) playNext();
  for (let i = 0; i < b.lines.length; i++) {
    const text = fillIn(b.lines[i]);
    const start = (Date.now() - t0) / 1000;
    process.stdout.write(`  [${i + 1}/${b.lines.length}] ${text}\n      (Enter = next · r = redo · s = skip · q = end block) `);
    const k = await key();
    const end = (Date.now() - t0) / 1000;
    if (k === 'r') { i--; continue; }
    if (k === 'q') break;
    if (k === 's') continue;
    labels.write(JSON.stringify({ block: name, file: path.basename(file), i, text, start: +start.toFixed(2), end: +end.toFixed(2), distance: b.distance, condition: b.condition }) + '\n');
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
