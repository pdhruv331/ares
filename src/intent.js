// Semantic intent layer: works out what a short remark is *doing*, not its exact words, so "hold up",
// "whoa whoa" and "gimme a sec" all mean stop. bge-small-en-v1.5 (int8 ONNX) turns the remark into a
// vector on the Mac, and the nearest example remarks decide: people-to-people conversation data
// (SwDA, DailyDialog; see scripts/build-intents.mjs), a hand-written core, and the user's own phrasings,
// which ARES learns over time. Nothing leaves the Mac.
const fs = require('fs');
const path = require('path');

// stop: be quiet now · continue: backchannel / carry on · thanks: thanks or acknowledgement
// repeat: say that again · nevermind: drop it · sleep: go back to waiting for her name · chat: anything else
const INTENTS = ['stop', 'continue', 'yes', 'no', 'thanks', 'repeat', 'nevermind', 'sleep', 'chat'];
// Handled on the Mac without the brain, so a wrong guess costs more: these need a clearer match.
const LOCAL = new Set(['stop', 'thanks', 'repeat', 'nevermind', 'sleep']);
const MAX_WORDS = 12; // longer than this is never just a remark

// ---- Tokeniser: BERT WordPiece (uncased), as bge-small was trained with ------------------------------
class WordPiece {
  constructor(vocabText) {
    this.vocab = new Map(vocabText.split('\n').map((w, i) => [w.replace(/\r$/, ''), i]));
    this.unk = this.vocab.get('[UNK]');
    this.cls = this.vocab.get('[CLS]');
    this.sep = this.vocab.get('[SEP]');
  }

  encode(text, max = 64) {
    const clean = text.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[\p{Cc}\p{Cf}]/gu, ' ');
    const words = clean.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [];
    const ids = [this.cls];
    for (const word of words) {
      if (word.length > 100) { ids.push(this.unk); continue; }
      const pieces = [];
      let start = 0;
      while (start < word.length) {
        let end = word.length;
        let id;
        for (; end > start; end--) {
          id = this.vocab.get((start ? '##' : '') + word.slice(start, end));
          if (id !== undefined) break;
        }
        if (end === start) { pieces.length = 0; pieces.push(this.unk); break; }
        pieces.push(id);
        start = end;
      }
      ids.push(...pieces);
    }
    return [...ids.slice(0, max - 1), this.sep];
  }
}

// ---- Embedder ---------------------------------------------------------------------------------------
class Embedder {
  constructor(modelDir) { this.modelDir = modelDir; }

  async load() {
    const ort = require('onnxruntime-node');
    this.ort = ort;
    this.tok = new WordPiece(fs.readFileSync(path.join(this.modelDir, 'vocab.txt'), 'utf8'));
    this.session = await ort.InferenceSession.create(path.join(this.modelDir, 'model_int8.onnx'), {
      intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: 'all',
    });
    this.inputs = this.session.inputNames;
    return this;
  }

  /** Unit-length sentence vectors (CLS pooling, as bge recommends), one Float32Array per text. */
  async embed(texts) {
    const enc = texts.map((t) => this.tok.encode(t));
    const len = Math.max(...enc.map((e) => e.length));
    const n = enc.length;
    const ids = new BigInt64Array(n * len);
    const mask = new BigInt64Array(n * len);
    enc.forEach((e, i) => e.forEach((id, j) => { ids[i * len + j] = BigInt(id); mask[i * len + j] = 1n; }));
    const feeds = {
      input_ids: new this.ort.Tensor('int64', ids, [n, len]),
      attention_mask: new this.ort.Tensor('int64', mask, [n, len]),
    };
    if (this.inputs.includes('token_type_ids')) feeds.token_type_ids = new this.ort.Tensor('int64', new BigInt64Array(n * len), [n, len]);
    const out = await this.session.run(feeds);
    const hidden = out.last_hidden_state ?? out[this.session.outputNames[0]];
    const dim = hidden.dims[2];
    return enc.map((_, i) => {
      const v = Float32Array.from(hidden.data.subarray(i * len * dim, i * len * dim + dim));
      const norm = Math.hypot(...v) || 1;
      for (let k = 0; k < dim; k++) v[k] /= norm;
      return v;
    });
  }
}

/** Strip what isn't part of the remark itself: her name, filler punctuation, stray spaces. */
function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/^\s*((hey|ok(ay)?|oi)\s+)?(ares|aries|ariz|harris)\b[\s,.!?]*/i, '')
    .replace(/[\s,]*\b(ares|aries)\s*[.!?]*$/i, '')
    .replace(/[“”"]/g, '').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ').trim();
}
const wordCount = (t) => (t.match(/[\p{L}\p{N}']+/gu) || []).length;

// ---- Classifier -------------------------------------------------------------------------------------
class Intents {
  /**
   * modelDir holds model_int8.onnx, vocab.txt and the precomputed example vectors (vectors.json + vectors.bin).
   * dataDir is where the user's own phrasings live: my-phrases.txt (editable) and corrections.log.
   */
  constructor({ modelDir, dataDir, log = () => {} }) {
    this.modelDir = modelDir;
    this.dataDir = dataDir;
    this.log = log;
    this.phrasesFile = path.join(dataDir, 'my-phrases.txt');
    this.logFile = path.join(dataDir, 'corrections.log');
    this.ready = false;
    this.personal = []; // { text, intent, vec }
    this.cache = new Map();
  }

  async init() {
    const t0 = Date.now();
    this.embedder = await new Embedder(this.modelDir).load();
    const meta = JSON.parse(fs.readFileSync(path.join(this.modelDir, 'vectors.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(this.modelDir, 'vectors.bin'));
    this.dim = meta.dim;
    this.matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    this.labels = Uint8Array.from(meta.labels.map((l) => INTENTS.indexOf(l)));
    this.texts = meta.texts;
    this.bonus = Float32Array.from(meta.seed || [], (x) => (x ? SEED_BONUS : 0));
    this.source = meta.source;
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.phrasesFile)) fs.writeFileSync(this.phrasesFile, PHRASES_HEADER);
    await this.loadPersonal();
    fs.watchFile(this.phrasesFile, { interval: 2000 }, () => this.loadPersonal().catch(() => {}));
    await this.classify('warm up');
    this.ready = true;
    this.log('intent ready', { examples: this.texts.length, personal: this.personal.length, source: this.source, ms: Date.now() - t0 });
    return this;
  }

  async loadPersonal() {
    const lines = fs.readFileSync(this.phrasesFile, 'utf8').split('\n')
      .map((l) => l.match(/^\s*([a-z]+)\s*:\s*(.+?)\s*$/i)).filter(Boolean)
      .map((m) => ({ intent: m[1].toLowerCase(), text: normalize(m[2]) }))
      .filter((p) => INTENTS.includes(p.intent) && p.text);
    const byText = new Map(lines.map((p) => [p.text, p])); // a later line wins
    const list = [...byText.values()];
    const vecs = list.length ? await this.embedder.embed(list.map((p) => p.text)) : [];
    this.personal = list.map((p, i) => ({ ...p, vec: vecs[i] }));
    this.cache.clear();
  }

  /**
   * What is this remark doing? → { intent, guess, score, margin, clear, ms }
   * intent is 'chat' unless the match is good enough to act on; guess is the nearest intent either way.
   * clear = confident enough to answer on the Mac (or stay silent) with no brain call.
   */
  async classify(raw) {
    const t0 = performance.now();
    const text = normalize(raw);
    const words = wordCount(text);
    if (!text || words > MAX_WORDS || !this.embedder) return { intent: 'chat', guess: 'chat', score: 0, margin: 1, clear: false, local: false, words, ms: 0 };
    const exact = this.personal.find((p) => p.text === text);
    if (exact) return { intent: exact.intent, guess: exact.intent, score: 1, margin: 1, clear: true, local: LOCAL.has(exact.intent), personal: true, words, ms: +(performance.now() - t0).toFixed(1) };
    if (this.cache.has(text)) return { ...this.cache.get(text), ms: +(performance.now() - t0).toFixed(1) };

    const [v] = await this.embedder.embed([text]);
    const K = 4;
    const top = INTENTS.map(() => []); // best K similarities per intent, descending
    const push = (label, s) => {
      const arr = top[label];
      if (arr.length === K && s <= arr[K - 1]) return;
      let i = arr.length - (arr.length === K ? 1 : 0);
      if (arr.length < K) arr.push(s);
      while (i > 0 && arr[i - 1] < s) { arr[i] = arr[i - 1]; i--; }
      arr[i] = s;
    };
    const { matrix, labels, dim, bonus } = this;
    for (let r = 0, n = labels.length; r < n; r++) {
      let s = 0;
      const o = r * dim;
      for (let k = 0; k < dim; k++) s += matrix[o + k] * v[k];
      push(labels[r], s + (bonus[r] || 0));
    }
    // The user's own phrasings count for a bit more than strangers' on the phone in 1991
    for (const p of this.personal) {
      let s = 0;
      for (let k = 0; k < dim; k++) s += p.vec[k] * v[k];
      push(INTENTS.indexOf(p.intent), s + PERSONAL_BONUS);
    }
    const weights = [0.4, 0.3, 0.2, 0.1];
    const scores = top.map((arr) => (arr.length ? arr.reduce((a, s, i) => a + s * weights[i], 0) / weights.slice(0, arr.length).reduce((a, b) => a + b) : 0));
    const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
    const [[score, best], [second]] = order;
    const guess = INTENTS[best];
    const margin = score - second;
    const need = LOCAL.has(guess) ? THRESHOLD.local : THRESHOLD.other;
    const confident = guess !== 'chat' && score >= need.score && margin >= need.margin;
    const clear = confident && score >= THRESHOLD.clear.score && margin >= THRESHOLD.clear.margin;
    const result = {
      intent: confident ? guess : 'chat',
      guess,
      score: +score.toFixed(3),
      margin: +margin.toFixed(3),
      clear,
      // Handle on the Mac, no brain: stopping is cheap to get wrong, the others need a clear match
      local: confident && (guess === 'stop' || (LOCAL.has(guess) && clear)),
      words,
    };
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(text, result);
    return { ...result, ms: +(performance.now() - t0).toFixed(1) };
  }

  async dispose() {
    fs.unwatchFile(this.phrasesFile);
    await this.embedder?.session?.release();
    this.embedder = null;
  }

  /** Learn the user's phrasing: "gimme a tick" means stop. Saved to my-phrases.txt, noted in corrections.log. */
  async learn(raw, intent, { was = null, why = 'correction' } = {}) {
    const text = normalize(raw);
    intent = String(intent || '').toLowerCase();
    if (!text || !INTENTS.includes(intent)) throw new Error(`unknown meaning "${intent}" (use one of: ${INTENTS.join(', ')})`);
    if (wordCount(text) > MAX_WORDS) throw new Error('that is too long to be a short remark');
    fs.appendFileSync(this.phrasesFile, `${intent}: ${text}\n`);
    fs.appendFileSync(this.logFile, `${new Date().toISOString()}\t"${text}"\t${was ? `heard as ${was}` : 'new'} → ${intent}\t(${why})\n`);
    await this.loadPersonal();
    this.log('intent learned', { intent, was, why });
    return { text, intent };
  }
}

const SEED_BONUS = 0.02;
const PERSONAL_BONUS = 0.04;
// Tuned on scripts/test-intents.mjs (casual phrasings that aren't in the seed data)
const THRESHOLD = {
  local: { score: 0.77, margin: 0.01 },
  other: { score: 0.76, margin: 0.015 },
  clear: { score: 0.86, margin: 0.04 },
};

const PHRASES_HEADER = `# ARES: your own phrasings. One per line, "meaning: what you say".
# ARES adds lines here when she gets one of your remarks wrong and you put her right, and you can
# add or delete lines yourself (changes are picked up within a few seconds).
# Meanings: stop, continue (carry on / backchannel), yes, no, thanks (thanks or acknowledgement),
# repeat, nevermind, sleep (go back to waiting for her name), chat (not a command, just talking).
#
# stop: gimme a tick
`;

module.exports = { Intents, Embedder, WordPiece, INTENTS, LOCAL, normalize, THRESHOLD };
