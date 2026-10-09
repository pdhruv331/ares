// A synthetic first look at the wake word (docs/voice-prompt.md A2): Kokoro's English voices say "Hey ARES …" lines and
// sentences built from the words ARES's transcripts confuse with her name, then today's wake rule is scored on each
// recogniser's transcripts. Clean TTS audio is an upper bound; the desk recordings (record-session.mjs) are the real test.
//   node scripts/voice-lab/synth-wake.mjs [--out <dir>] [--engines sf,st] [--voices 28]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { transcribe, transcribeJoined } from './lab.mjs';
import { wakeToday, nameHeardAs } from './wake-regex.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('--out', path.join(os.tmpdir(), 'ares-synth-wake'));
const ENGINES = opt('--engines', 'sf,st').split(',');
const VOICES = Number(opt('--voices', 28)); // Kokoro v1.0: 0–19 American, 20–27 British
const require = createRequire(import.meta.url);

export const POSITIVE = ['Hey Ares, what time is it?', 'Hey Ares, set a timer for five minutes.', 'Hey Ares.', 'Ares, pause the music.',
  'Hey Ares, open Safari.', 'Okay Ares, what\'s the weather like?'];
export const NEGATIVE = ['I think she\'s an Aries, actually.', 'Harris called about the meeting.', 'We went to Paris in the spring.',
  'The heiress bought the whole street.', 'Can you erase the whiteboard?', 'My ears are still ringing.', 'I was reading about Ares, the Greek god of war.',
  'There are lots of areas to cover.', 'The arrears on the account are paid.', 'Hey, Harry\'s here!', 'Hey Iris, how was the trip?',
  'That\'s fair, he says.', 'Erase the last line, please.', 'Aries is my star sign.'];

fs.mkdirSync(OUT, { recursive: true });
const manifest = path.join(OUT, 'manifest.json');
let clips = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
if (!clips) {
  const sherpa = require(path.join(import.meta.dirname, '../../node_modules/sherpa-onnx-node'));
  const k = path.join(os.homedir(), 'Library/Application Support/ARES/models/kokoro-v1_0');
  const tts = new sherpa.OfflineTts({ model: { kokoro: { model: path.join(k, 'model.onnx'), voices: path.join(k, 'voices.bin'), tokens: path.join(k, 'tokens.txt'),
    dataDir: path.join(k, 'espeak-ng-data'), lexicon: path.join(k, 'lexicon-gb-en.txt'), lang: 'en' }, numThreads: 4 } });
  clips = [];
  for (let sid = 0; sid < VOICES; sid++) {
    for (const [label, lines] of [['pos', POSITIVE], ['neg', NEGATIVE]]) {
      lines.forEach((text, i) => {
        const file = path.join(OUT, `${label}-${sid}-${i}.wav`);
        const a = tts.generate({ text, sid, speed: 0.9 + 0.2 * ((sid * 7 + i) % 3) / 2 });
        sherpa.writeWave(file, { samples: a.samples, sampleRate: a.sampleRate });
        clips.push({ file, label, text, sid });
      });
    }
    process.stdout.write(`\rvoices ${sid + 1}/${VOICES}`);
  }
  fs.writeFileSync(manifest, JSON.stringify(clips));
  console.log();
}

const report = {};
for (const engine of ENGINES) {
  // SpeechTranscriber: one long joined file (per-file set-up is slow and stalls); SFSpeechRecognizer: per clip, as ARES uses it
  const res = engine === 'st' ? await transcribeJoined('st', clips.map((c) => c.file), { locale: 'en-GB' })
    : await transcribe(engine, clips.map((c) => c.file), { locale: 'en-GB' });
  const byFile = new Map(res.map((r) => [r.file, r]));
  const pos = clips.filter((c) => c.label === 'pos'), neg = clips.filter((c) => c.label === 'neg');
  const woke = (c) => wakeToday(byFile.get(c.file)).woke;
  const heard = {};
  for (const c of pos) { const h = nameHeardAs(byFile.get(c.file)); heard[h] = (heard[h] || 0) + 1; }
  const fa = neg.filter(woke).map((c) => `${c.text} → "${byFile.get(c.file)?.text}"`);
  report[engine] = {
    recall: `${pos.filter(woke).length}/${pos.length}`,
    falseAccepts: `${fa.length}/${neg.length}`,
    nameHeardAs: Object.entries(heard).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k || '(nothing)'} ${v}`).join(', '),
    msPerClip: Math.round(res.reduce((a, r) => a + (r.ms || 0), 0) / res.length),
    misses: pos.filter((c) => !woke(c)).slice(0, 12).map((c) => `[${c.sid}] ${c.text} → "${byFile.get(c.file)?.text ?? byFile.get(c.file)?.error}"`),
    falseAcceptList: [...new Set(fa)].slice(0, 15),
    errors: res.filter((r) => r.error).length,
  };
}
console.log(JSON.stringify(report, null, 1));
