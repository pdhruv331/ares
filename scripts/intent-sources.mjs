// Example sources for the intent layer. Each source downloads its data once (cached in models/data) and
// yields { text, intent } pairs; scripts/build-intents.mjs picks them with --sources. To swap in another
// corpus (MASSIVE, Schema-Guided Dialogue...), add an entry here that maps its labels onto intent.js's INTENTS.
import fs from 'fs';
import path from 'path';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';

const DATA = path.join(import.meta.dirname, '..', 'models', 'data');
const SPLITS = ['train', 'validation', 'test'];

async function parquet(repo, name, columns) {
  fs.mkdirSync(DATA, { recursive: true });
  const rows = [];
  for (const split of SPLITS) {
    const file = path.join(DATA, `${name}-${split}.parquet`);
    if (!fs.existsSync(file)) {
      const url = `https://huggingface.co/datasets/${repo}/resolve/refs%2Fconvert%2Fparquet/default/${split}/0000.parquet`;
      console.log(`  downloading ${repo} ${split}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    for (const r of await parquetReadObjects({ file: await asyncBufferFromFile(file), columns })) rows.push(r);
  }
  return rows;
}

const words = (t) => t.split(' ').filter(Boolean).length;

// ---- Switchboard Dialog Act Corpus: ~1,150 US phone conversations, every utterance tagged with its act ----
// DAMSL tag order from the dataset's ClassLabel (cgpotts/swda, swda.py)
const DAMSL = ['ad', 'qo', 'qy', 'arp_nd', 'sd', 'h', 'bh', 'no', '^2', '^g', 'ar', 'aa', 'sv', 'bk', 'fp', 'qw', 'b',
  'ba', 't1', 'oo_co_cc', '+', 'ny', 'qw^d', 'x', 'qh', 'fc', 'fo_o_fw_"_by_bc', 'aap_am', '%', 'bf', 't3', 'nn', 'bd',
  'ng', '^q', 'br', 'qy^d', 'fa', '^h', 'b^m', 'ft', 'qrr', 'na'];
const SWDA_MAP = {
  b: 'continue',   // backchannel: "uh-huh", "yeah", "right"
  bh: 'continue',  // backchannel as a question: "oh really?"
  ny: 'yes', aa: 'yes', na: 'yes', // yes answers, agree/accept, affirmative non-yes
  nn: 'no', ar: 'no',              // no answers, reject
  bk: 'thanks',    // response acknowledgement: "oh, okay"
  ft: 'thanks',    // thanking
  br: 'repeat',    // signal non-understanding: "pardon?"
  fc: 'sleep',     // conventional closing: "bye-bye", "take care"
  sd: 'chat', sv: 'chat', qy: 'chat', qw: 'chat', qo: 'chat', 'qy^d': 'chat', 'qw^d': 'chat',
};

function cleanSwda(t) {
  return t
    .replace(/\{F [^}]*\}/g, ' ')                  // fillers: {F uh, }
    .replace(/\{[DCEA] ([^}]*)\}/g, ' $1 ')        // discourse markers, conjunctions, asides: keep the words
    .replace(/<+[^>]*>+/g, ' ')                    // <laughter>, <<noise>>
    .replace(/\(\(|\)\)|[[\]+{}/#]|--/g, ' ')
    .replace(/\s+([,.?!])/g, '$1').replace(/\s+/g, ' ')
    .toLowerCase().replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();
}

// ---- DailyDialog: ~13k written everyday dialogues (English-learner style); acts are coarse, so short
// remarks are mined by their wording and longer ones feed the "just chatting" examples ------------------
const DD_MINE = [ // first match wins, so the specific ones come first
  ['thanks', /\b(thanks|thank you|cheers)\b/, 5],
  ['sleep', /\b(good ?bye|bye|see you|good night)\b/, 5],
  ['repeat', /^(pardon|sorry\?|excuse me\?|what did you say|come again|say (it|that) again)/, 5],
  ['stop', /^(wait|hold on|hang on|just a (moment|minute|second)|one (moment|minute|second))\b/, 5],
  ['nevermind', /^(never mind|forget it|it doesn'?t matter|don'?t worry about it)\b/, 5],
  [null, /\b(problem|here you are|sir|madam)\b/, 5], // "no problem", "yes, here you are": not answers
  ['yes', /^(yes|yeah|sure|of course|certainly|absolutely|all right|ok(ay)?)\b/, 3],
  ['no', /^(no|nope|not really|i'?m afraid not|no way)\b/, 3],
];

function cleanDaily(t) {
  return t.replace(/’/g, "'").replace(/\s+([,.?!';:])/g, '$1').replace(/'\s+/g, "'")
    .replace(/\s+/g, ' ').toLowerCase().trim().replace(/[.!]+$/, '');
}

export const SOURCES = {
  swda: {
    license: 'CC BY-NC-SA 3.0 (cgpotts/swda)',
    async *examples() {
      for (const r of await parquet('cgpotts/swda', 'swda', ['text', 'damsl_act_tag'])) {
        let intent = SWDA_MAP[DAMSL[r.damsl_act_tag]];
        if (!intent) continue;
        const text = cleanSwda(r.text);
        if (intent === 'sleep') { // closings: keep the goodbyes, not "you too" or "thanks for calling"
          if (/\bthank/.test(text)) intent = 'thanks';
          else if (!/\b(bye|see you|talk to you|take care|good ?night|later)\b/.test(text)) continue;
        }
        const n = words(text);
        if (!n || /^(uh|um|oh|well|and|so|but)$/.test(text)) continue;
        if (intent === 'chat' ? n < 3 || n > 12 : n > 6) continue;
        yield { text, intent };
      }
    },
  },
  dailydialog: {
    license: 'CC BY-NC-SA 4.0 (li2017dailydialog/daily_dialog)',
    async *examples() {
      for (const d of await parquet('li2017dailydialog/daily_dialog', 'dailydialog', ['dialog', 'act'])) {
        for (let i = 0; i < d.dialog.length; i++) {
          const text = cleanDaily(d.dialog[i]);
          const n = words(text);
          if (!n) continue;
          if (n <= 5) {
            const hit = DD_MINE.find(([, re]) => re.test(text));
            if (hit) { if (hit[0] && n <= hit[2]) yield { text, intent: hit[0] }; continue; }
          }
          // 1 inform, 2 question (3 directive and 4 commissive are too often "yes"/"stop"-ish to be negatives)
          if ((d.act[i] === 1 || d.act[i] === 2) && n >= 3 && n <= 12) yield { text, intent: 'chat' };
        }
      }
    },
  },
  // massive: { license: 'CC BY 4.0', async *examples() { /* AmazonScience/massive: map intents onto INTENTS */ } },
  // sgd:     { license: 'CC BY-SA 4.0', async *examples() { /* google/schema_guided_dstc8: dialogue acts → INTENTS */ } },
};
