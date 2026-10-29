// ARES's voice: Katherine (ElevenLabs) first, with a free local backup, Kokoro via sherpa-onnx (kokoro-worker.js),
// and the best British female macOS voice as a last resort. Every engine produces the same thing, 24 kHz 16-bit
// mono PCM streamed sentence by sentence, so the window, the listener, the phone app and Telegram never need to
// know which voice spoke.
//
//  - Automatic fallback: credits exhausted, a rejected key, repeated 429s, network failures or timeouts switch to
//    the backup for that sentence and onwards, with no silence; ElevenLabs is retried periodically (and at the
//    credit reset) and she switches back by herself. Announced once per outage (the 'down' event).
//  - Budget mode (off / auto / always): fillers and acknowledgements in the backup voice, answers in Katherine.
//  - Phrase cache: short Katherine lines are kept on disk and replayed instead of paying for them again.
//  - Credit watch: GET /v1/user/subscription (needs the key's user_read permission) plus local counting, warnings
//    at 80% and 95%, and a reserve kept for the phone line (ElevenLabs agent calls draw on the same credit pool).
//  - Developer mode: dev builds (or the "while I'm building" setting) use the backup voice by default.
// The phone line itself ("ARES Calls") runs in ElevenLabs' cloud and is never touched from here.
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const API = 'https://api.elevenlabs.io';
const RATE = 24000;
const HEDGE_MS = 1200;            // v3 sometimes takes 5 s+ to start: a second identical request after this
const FIRST_AUDIO_MS = Number(process.env.ARES_TTS_TIMEOUT_MS) || 6000;     // no audio by then: use the backup voice for this sentence
const CREDIT_CHECK_MS = 30 * 60_000;
// Kokoro v1.0 speaker ids (from the model's own metadata)
const KOKORO_VOICES = { bf_alice: 20, bf_emma: 21, bf_isabella: 22, bf_lily: 23, bm_daniel: 24, bm_fable: 25, bm_george: 26, bm_lewis: 27,
  af_heart: 3, af_bella: 2, af_nicole: 6, af_sarah: 9, af_sky: 10 };
// Short lines worth keeping Katherine's audio for, and the fillers budget mode gives to the backup voice
const ACK = String.raw`(?:right|alright|okay|ok|sure|certainly|of course|absolutely|very well|noted|got it|on it|i'm on it|will do|done|all done|consider it done|one moment|one sec(?:ond)?|just a (?:moment|sec(?:ond)?)|let me (?:check|see|look)(?: (?:that|into it|now))?|checking(?: now)?|working on it|timer'?s? set|reminder set|set|cancelled|canceled|stopped|paused|good (?:morning|afternoon|evening|night)|hello|hi|hey|goodbye|bye|cheers|thanks|thank you|you'?re welcome|no problem|my pleasure|yes|no|indeed|quite|sorry|apologies|understood|as you wish|right away|straight away|coming up|here you go|there you go|perfect|lovely|great|excellent)`;
const FILLER = new RegExp(String.raw`^(?:\[[a-z ]+\]\s*)?(?:${ACK}(?:,?\s*(?:sir|then|now))?[.!…,]*\s*)+$`, 'i');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (t) => (t.match(/[A-Za-z0-9']+/g) || []).length;
const stripCues = (t) => t.replace(/\[[a-z ]+\]\s*/gi, '');
const norm = (t) => t.trim().replace(/\s+/g, ' ');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const abortError = () => Object.assign(new Error('cancelled'), { kind: 'cancelled' });

/** Text for Kokoro: no ElevenLabs delivery cues, no markdown, and names it would otherwise spell out. */
function forKokoro(text) {
  return stripCues(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')        // markdown links -> their text
    .replace(/[*_`#>|]+/g, '')
    .replace(/\bA\.?R\.?E\.?S\.?(?=\W|$)/g, 'Ares')
    .replace(/\s&\s/g, ' and ')
    .replace(/~\s?(\d)/g, 'about $1')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which ElevenLabs failure this is: credits, key, permission, busy, outage, network, timeout or request. */
function classify(status, body = '') {
  const b = String(body).toLowerCase();
  if (status === 402 || /quota_exceeded|quota|insufficient|character limit|credits?_?(?:remaining|exhausted|limit)|exceeds your/.test(b)) return 'credits';
  if (status === 401 && /missing_permissions/.test(b)) return 'permission';
  if (status === 401 || status === 403) return 'key';
  if (status === 429) return 'busy';
  if (status >= 500) return 'outage';
  return 'request';
}
const failure = (kind, message) => Object.assign(new Error(message || kind), { kind });

const DOWN_NOTE = {
  credits: "I'm on my backup voice until the credits reset.",
  key: "My usual voice isn't accepting the key, so I'm on my backup voice for now.",
  permission: "My usual voice isn't accepting the key, so I'm on my backup voice for now.",
  default: "ElevenLabs isn't answering, so I'm on my backup voice until it's back.",
};
const REASON = { credits: 'credits used up', key: 'key rejected', permission: 'key lacks permission', busy: 'too many requests',
  outage: 'ElevenLabs outage', network: 'network down', timeout: 'ElevenLabs too slow' };

// ---- Phrase cache -----------------------------------------------------------------------------------------
class PhraseCache {
  constructor(dir, sig, log, maxBytes = 40 * 1024 * 1024) {
    this.dir = dir;
    this.sig = sig;   // voice + model + speed + settings: a change invalidates everything
    this.log = log;
    this.maxBytes = maxBytes;
    this.lookups = 0;
    this.hits = 0;
    fs.mkdirSync(dir, { recursive: true });
    try { this.index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { this.index = {}; }
    let dropped = 0;
    for (const [k, e] of Object.entries(this.index)) {
      if (e.sig !== sig || !fs.existsSync(this.#file(k))) { this.#remove(k); dropped++; }
    }
    if (dropped) { log('voice cache invalidated', { dropped }); this.#save(); }
  }
  #file(k) { return path.join(this.dir, `${k}.pcm`); }
  #remove(k) { try { fs.unlinkSync(this.#file(k)); } catch {} delete this.index[k]; }
  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.index)); } catch {} }, 2000);
  }
  key(text) { return sha(`${this.sig}\n${norm(text).toLowerCase()}`); }
  /** Short lines only: greetings, acknowledgements, confirmations, refusals. */
  eligible(text) { return text.length <= 90 && words(text) <= 10; }
  get(text) {
    if (!this.eligible(text)) return null;
    this.lookups++;
    const k = this.key(text);
    const e = this.index[k];
    let audio = null;
    if (e) try { audio = fs.readFileSync(this.#file(k)); e.hits = (e.hits || 0) + 1; e.last = Date.now(); this.hits++; this.#save(); } catch { this.#remove(k); }
    if (this.lookups % 25 === 0) this.log('voice cache', this.stats());
    return audio;
  }
  put(text, pcm) {
    if (!this.eligible(text) || !pcm.length) return;
    const k = this.key(text);
    try { fs.writeFileSync(this.#file(k), pcm); } catch { return; }
    this.index[k] = { text: norm(text), sig: this.sig, bytes: pcm.length, hits: 0, last: Date.now() };
    // Least recently used out, past the size cap
    let total = Object.values(this.index).reduce((s, e) => s + e.bytes, 0);
    for (const [old] of Object.entries(this.index).sort((a, b) => a[1].last - b[1].last)) {
      if (total <= this.maxBytes) break;
      total -= this.index[old].bytes;
      this.#remove(old);
    }
    this.#save();
  }
  stats() {
    return { entries: Object.keys(this.index).length, hits: this.hits, lookups: this.lookups,
      rate: this.lookups ? Math.round((this.hits / this.lookups) * 100) : 0 };
  }
}

// ---- The voice ----------------------------------------------------------------------------------------------
class Voice extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir           ARES support folder
   * @param {Function} o.log
   * @param {() => object} o.settings
   * @param {(patch: object) => void} o.saveSettings
   * @param {boolean} o.devBuild     running from source (npm start)
   * @param {object} o.eleven        { key, voice, model, speed, settings: () => voice_settings }
   */
  constructor({ dir, log, settings, saveSettings, devBuild, eleven }) {
    super();
    this.dir = dir;
    this.log = log;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.devBuild = devBuild;
    this.eleven = eleven;
    this.localVoice = KOKORO_VOICES[process.env.ARES_LOCAL_VOICE] !== undefined ? process.env.ARES_LOCAL_VOICE : 'bf_emma';
    this.localSpeed = Math.min(1.3, Math.max(0.8, Number(process.env.ARES_LOCAL_SPEED) || 1.05));
    this.slots = Number(process.env.ELEVENLABS_CONCURRENCY) || 3;
    this.active = 0;
    this.waiting = [];
    this.down = null;      // { kind, since, retryAt, fails, announced }
    this.timeouts = 0;     // consecutive first-audio timeouts
    this.kokoro = { ready: false, error: null, pending: new Map(), seq: 0 };
    // Agent call minutes and TTS share one ElevenLabs credit pool (Creator: ~121k credits, ~275 agent minutes)
    this.reserveCredits = (Number(process.env.ARES_VOICE_RESERVE_MIN) || 60) * (Number(process.env.ARES_CALL_CREDITS_PER_MIN) || 440);
    this.stateFile = path.join(dir, 'voice-state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { this.state = {}; }
    this.state.sent ||= {};  // hour (ms) -> credits ARES itself spent, for local counting
    const sig = sha(JSON.stringify([eleven.voice, eleven.model, eleven.speed, eleven.settings()]));
    this.cache = new PhraseCache(path.join(dir, 'voice-cache'), sig, log);
  }

  start() {
    this.#startKokoro();
    this.refreshCredits();
    this.creditTimer = setInterval(() => this.refreshCredits(), CREDIT_CHECK_MS);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.creditTimer);
    this.kokoro.worker?.terminate();
    this.#saveState(true);
    this.log('voice cache', this.cache.stats());
  }

  // ---- Settings ----
  get budgetMode() { return ['off', 'auto', 'always'].includes(this.settings().voiceBudget) ? this.settings().voiceBudget : 'auto'; }
  setBudget(mode) {
    if (!['off', 'auto', 'always'].includes(mode)) return;
    this.saveSettings({ voiceBudget: mode });
    this.log('voice budget', { mode });
    this.emit('state');
  }
  /** Dev builds, and the "while I'm building/testing" setting, use the backup voice (ARES_DEV_ELEVEN=1 overrides). */
  get devMode() { return process.env.ARES_DEV_ELEVEN !== '1' && (this.devBuild || Boolean(this.settings().devVoice)); }
  setDevMode(on) { this.saveSettings({ devVoice: on }); this.emit('state'); }
  get available() { return Boolean(this.eleven.key) || this.kokoro.ready || !this.kokoro.error; }

  // ---- Credits ----
  async refreshCredits() {
    if (!this.eleven.key) return;
    try {
      const res = await fetch(`${API}/v1/user/subscription`, { headers: { 'xi-api-key': this.eleven.key }, signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      if (res.ok) {
        const s = JSON.parse(body);
        this.state.snapshot = { used: s.character_count, limit: s.character_limit, reset: s.next_character_count_reset_unix * 1000, tier: s.tier, at: Date.now() };
        this.state.access = 'ok';
        // Credits came back after the reset: try Katherine again straight away
        if (this.down?.kind === 'credits' && s.character_count < s.character_limit) this.down.retryAt = 0;
      } else {
        this.state.access = /missing_permissions/.test(body) ? 'no-permission' : `HTTP ${res.status}`;
      }
    } catch (err) {
      this.state.access ||= 'unreachable';
    }
    this.#saveState();
    this.#evaluate();
  }

  #spent(credits) {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    this.state.sent[hour] = (this.state.sent[hour] || 0) + credits;
    const cutoff = Date.now() - 40 * 86_400_000;
    for (const h of Object.keys(this.state.sent)) if (Number(h) < cutoff) delete this.state.sent[h];
    this.#saveState();
    this.#evaluate();
  }
  #sentSince(t) { return Object.entries(this.state.sent).reduce((s, [h, n]) => (Number(h) + 3_600_000 > t ? s + n : s), 0); }
  #saveState(now = false) {
    clearTimeout(this.stateTimer);
    const write = () => { try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state)); } catch {} };
    if (now) write(); else this.stateTimer = setTimeout(write, 3000);
  }

  /** What's known about this billing period's credits. */
  credits() {
    const snap = this.state.snapshot;
    const periodStart = snap?.reset ? new Date(snap.reset).setMonth(new Date(snap.reset).getMonth() - 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const out = { access: this.state.access || 'unknown', aresSent: Math.round(this.#sentSince(periodStart)), reserve: this.reserveCredits };
    if (!snap || snap.reset < Date.now()) return { ...out, known: false };
    // The snapshot plus what ARES itself has spent since (calls between checks aren't counted until the next one)
    const used = Math.min(snap.limit, snap.used + this.#sentSince(snap.at));
    return { ...out, known: true, used, limit: snap.limit, remaining: snap.limit - used, pct: used / snap.limit, reset: snap.reset, at: snap.at };
  }

  /** Budget AUTO, the call reserve and the 80%/95% warnings, from the latest credit picture. */
  #evaluate() {
    const c = this.credits();
    const wasAuto = this.autoBudget;
    const wasReserve = this.reserve;
    const exhausted = this.down?.kind === 'credits';
    if (c.known) {
      const days = (c.reset - Date.now()) / 86_400_000;
      this.autoBudget = c.pct >= 0.8 || (days <= 5 && c.pct >= 0.6);
      this.reserve = c.remaining < this.reserveCredits;
      for (const level of [95, 80]) {
        if (c.pct * 100 < level) continue;
        const key = `${level}@${c.reset}`;
        if (!(this.state.warned || []).includes(key)) {
          this.state.warned = [...(this.state.warned || []).slice(-6), key];
          this.#saveState();
          this.emit('warn', { level, ...c });
        }
        break; // one warning at a time: 95 covers 80
      }
    } else {
      this.autoBudget = exhausted;
      this.reserve = false;
    }
    if (wasAuto !== this.autoBudget || wasReserve !== this.reserve) {
      this.log('voice credits', { pct: c.known ? Math.round(c.pct * 100) : null, autoBudget: this.autoBudget, reserve: this.reserve });
      this.emit('state');
    }
  }

  get budgetActive() {
    const mode = this.budgetMode;
    return mode === 'always' || (mode === 'auto' && Boolean(this.autoBudget));
  }

  /** Which engine should say this, and why. */
  plan(text) {
    if (!this.eleven.key) return { engine: 'local', why: 'no key' };
    if (this.devMode) return { engine: 'local', why: 'dev' };
    if (this.down && Date.now() < this.down.retryAt) return { engine: 'local', why: this.down.kind };
    if (this.reserve) return { engine: 'local', why: 'reserve' };
    if (this.budgetActive && FILLER.test(norm(text))) return { engine: 'local', why: 'budget' };
    return { engine: 'eleven', why: this.down ? 'retry' : '' };
  }

  status() {
    const c = this.credits();
    return {
      backup: Boolean(this.down), reason: this.down ? REASON[this.down.kind] || this.down.kind : null,
      retryAt: this.down?.retryAt || null, dev: this.devMode, budget: this.budgetMode, budgetActive: this.budgetActive,
      autoBudget: Boolean(this.autoBudget), reserve: Boolean(this.reserve), credits: c, cache: this.cache.stats(),
      local: this.kokoro.ready ? `Kokoro ${this.localVoice}` : this.kokoro.error ? `system (${this.systemVoice() || 'none'})` : 'starting',
    };
  }

  // ---- Speaking ----
  /**
   * Speak one sentence as 24 kHz PCM through onChunk(Buffer), choosing and falling back between engines.
   * Resolves { engine, firstMs } when the audio is complete; rejects only when every engine failed or on cancel.
   */
  async speak(text, { onChunk, signal, source = 'mac' } = {}) {
    const t0 = Date.now();
    let first = null;
    let carry = null;
    const emit = (bytes) => {
      if (signal?.aborted) return;
      bytes = Buffer.from(bytes);
      if (carry) { bytes = Buffer.concat([carry, bytes]); carry = null; }
      if (bytes.length % 2) { carry = bytes.subarray(bytes.length - 1); bytes = bytes.subarray(0, bytes.length - 1); }
      if (!bytes.length) return;
      first ??= Date.now() - t0;
      onChunk(bytes);
    };
    const done = (engine, extra = {}) => {
      this.log('timing tts', { engine, chars: text.length, firstAudioMs: first, doneMs: Date.now() - t0, source, ...extra });
      return { engine, firstMs: first };
    };
    const elText = this.eleven.model === 'eleven_v3' ? text : stripCues(text);

    // Katherine's own audio for a line she has said before: free, instant, and the real voice
    const cached = this.eleven.key ? this.cache.get(elText) : null;
    if (cached) {
      for (let i = 0; i < cached.length && !signal?.aborted; i += 9600) emit(cached.subarray(i, i + 9600));
      return done('cache');
    }

    const plan = this.plan(text);
    if (plan.engine === 'eleven') {
      const keep = this.cache.eligible(elText) ? [] : null;
      try {
        const extra = await this.#elevenStream(elText, signal, (b) => { keep?.push(Buffer.from(b)); emit(b); });
        if (keep) this.cache.put(elText, Buffer.concat(keep));
        return done('eleven', extra);
      } catch (err) {
        if (err.kind === 'cancelled' || signal?.aborted) throw abortError();
        if (first !== null) return done('eleven', { cutShort: err.message }); // failed mid-sentence: don't repeat it
        this.log('tts fallback', { kind: err.kind, error: String(err.message).slice(0, 160) });
      }
    }
    try {
      await this.#kokoroSpeak(text, signal, emit);
      return done('kokoro', { why: plan.why || 'fallback' });
    } catch (err) {
      if (err.kind === 'cancelled' || signal?.aborted) throw abortError();
      this.log('kokoro error', err.message);
    }
    await this.#systemSpeak(text, signal, emit);
    return done('system', { voice: this.systemVoice() });
  }

  /** A whole line as an audio file for a Telegram voice note: Ogg/Opus from ElevenLabs, or M4A from the backup. */
  async voiceNote(text) {
    if (this.plan(text).engine === 'eleven') {
      await this.#acquire();
      try {
        const res = await fetch(`${API}/v1/text-to-speech/${this.eleven.voice}?output_format=opus_48000_64`, {
          method: 'POST',
          headers: { 'xi-api-key': this.eleven.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: this.eleven.model === 'eleven_v3' ? text : stripCues(text), model_id: this.eleven.model, voice_settings: this.eleven.settings() }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) { const body = await res.text(); throw failure(classify(res.status, body), `HTTP ${res.status}: ${body.slice(0, 160)}`); }
        const audio = Buffer.from(await res.arrayBuffer());
        this.#succeeded(text.length);
        return { audio, type: 'audio/ogg', engine: 'eleven' };
      } catch (err) {
        this.#failed(err.kind ? err : failure(err.name === 'TimeoutError' ? 'timeout' : 'network', err.message));
        this.log('voice note fallback', { error: String(err.message).slice(0, 160) });
      } finally {
        this.#release();
      }
    }
    const parts = [];
    try { await this.#kokoroSpeak(text, null, (b) => parts.push(Buffer.from(b))); } catch { parts.length = 0; await this.#systemSpeak(text, null, (b) => parts.push(Buffer.from(b))); }
    return { audio: await toM4a(Buffer.concat(parts)), type: 'audio/mp4', engine: 'local' };
  }

  // ---- ElevenLabs ----
  #acquire() { return this.active < this.slots ? (this.active++, Promise.resolve()) : new Promise((r) => this.waiting.push(r)); }
  #tryAcquire() { return this.active < this.slots && !this.waiting.length ? (this.active++, true) : false; }
  #release() { const next = this.waiting.shift(); if (next) next(); else this.active--; }

  async #open(text, signal) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${API}/v1/text-to-speech/${this.eleven.voice}/stream?output_format=pcm_24000`, {
          method: 'POST',
          headers: { 'xi-api-key': this.eleven.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: this.eleven.model, voice_settings: this.eleven.settings() }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw abortError();
        throw failure('network', err.cause?.code || err.message);
      }
      // Over the concurrency limit (e.g. another app on the same key): two quick retries, then the backup voice
      if (res.status === 429 && attempt < 2) {
        const body = await res.text();
        if (classify(429, body) === 'credits') throw failure('credits', `HTTP 429: ${body.slice(0, 160)}`);
        await sleep(350 * (attempt + 1));
        continue;
      }
      if (!res.ok) { const body = await res.text(); throw failure(classify(res.status, body), `HTTP ${res.status}: ${body.slice(0, 200)}`); }
      const cost = Number(res.headers.get('x-character-count')) || text.length;
      const reader = res.body.getReader();
      const first = await reader.read(); // resolves when audio actually starts flowing
      return { reader, first, cost };
    }
  }

  /** One sentence from ElevenLabs, hedged (a second request if the first is slow), with a first-audio deadline. */
  async #elevenStream(text, signal, onChunk) {
    if (signal?.aborted) throw abortError();
    await this.#acquire();
    if (signal?.aborted) { this.#release(); throw abortError(); }
    const attempts = [];
    const abortAll = () => attempts.forEach((a) => { a.ctrl.abort(); a.release(); });
    signal?.addEventListener('abort', abortAll, { once: true });
    let hedged = false;
    try {
      const winner = await new Promise((resolve, reject) => {
        let pending = 0;
        let settled = false;
        const timers = [];
        const settle = (fn, v) => { if (settled) return; settled = true; timers.forEach(clearTimeout); fn(v); };
        const launch = () => {
          const attempt = { ctrl: new AbortController(), won: false, released: false };
          attempt.release = () => { if (!attempt.released) { attempt.released = true; this.#release(); } };
          attempts.push(attempt);
          pending++;
          this.#open(text, attempt.ctrl.signal).then(
            (stream) => {
              if (settled) { attempt.ctrl.abort(); return attempt.release(); } // the other request got there first
              attempt.won = true;
              settle(resolve, { ...stream, attempt });
            },
            (err) => {
              attempt.release();
              if (settled) return;
              if (signal?.aborted) return settle(reject, abortError());
              // Credits or key problems won't fix themselves on a retry
              if (['credits', 'key', 'permission', 'request', 'busy'].includes(err.kind)) return settle(reject, err);
              if (--pending > 0) return;
              if (!hedged) { hedged = true; this.#acquire().then(launch); } // first failure: retry once
              else settle(reject, err);
            },
          );
        };
        launch(); // uses the slot acquired above
        timers.push(setTimeout(() => {
          if (settled || hedged || !this.#tryAcquire()) return; // only hedge when a slot is free
          hedged = true;
          launch();
        }, HEDGE_MS));
        timers.push(setTimeout(() => settle(reject, failure('timeout', `no audio after ${FIRST_AUDIO_MS} ms`)), FIRST_AUDIO_MS));
      });
      attempts.forEach((a) => { if (!a.won) { a.ctrl.abort(); a.release(); } });
      try {
        let { done, value } = winner.first;
        while (!done && !signal?.aborted) {
          onChunk(value);
          ({ done, value } = await winner.reader.read());
        }
        if (signal?.aborted) { winner.attempt.ctrl.abort(); throw abortError(); }
      } catch (err) {
        if (err.kind === 'cancelled') throw err;
        throw failure('network', err.message); // dropped mid-stream
      } finally {
        winner.attempt.release();
      }
      this.#succeeded(winner.cost);
      return { hedged };
    } catch (err) {
      abortAll();
      if (err.kind !== 'cancelled') this.#failed(err);
      throw err;
    } finally {
      signal?.removeEventListener('abort', abortAll);
    }
  }

  #succeeded(chars) {
    this.timeouts = 0;
    // eleven_v3 and multilingual: 1 credit per character; flash/turbo: half
    this.#spent(chars * (/flash|turbo/.test(this.eleven.model) ? 0.5 : 1));
    if (this.down) {
      this.log('voice restored', { after: this.down.kind, minutes: Math.round((Date.now() - this.down.since) / 60_000) });
      const was = this.down;
      this.down = null;
      this.emit('restored', was);
      this.emit('state');
    }
  }

  #failed(err) {
    let kind = err.kind || 'network';
    if (kind === 'request') return; // this sentence only (e.g. text it refused)
    if (kind === 'timeout' && ++this.timeouts < 2 && !this.down) return; // one slow sentence isn't an outage
    if (kind === 'timeout') kind = 'network';
    const now = Date.now();
    const fails = (this.down?.fails || 0) + 1;
    let wait;
    if (kind === 'credits') {
      const reset = this.state.snapshot?.reset;
      wait = Math.min(30 * 60_000, reset && reset > now ? reset - now + 60_000 : 30 * 60_000);
    } else if (kind === 'key' || kind === 'permission') wait = 30 * 60_000;
    else wait = Math.min(10 * 60_000, 30_000 * 2 ** (fails - 1)); // 30 s, 1, 2, 4, 8, 10 min
    const first = !this.down;
    this.down = { kind, since: this.down?.since || now, retryAt: now + wait, fails, announced: this.down?.announced || false };
    this.log('voice down', { kind, retryInS: Math.round(wait / 1000), error: String(err.message).slice(0, 160) });
    if (kind === 'credits') this.#evaluate();
    if (first || !this.down.announced) {
      this.down.announced = true;
      this.emit('down', { kind, reason: REASON[kind] || kind, note: DOWN_NOTE[kind] || DOWN_NOTE.default });
    }
    this.emit('state');
  }

  // ---- Kokoro (local) ----
  #startKokoro() {
    const dir = path.join(this.dir, 'models', 'kokoro-v1_0');
    if (!fs.existsSync(path.join(dir, 'voices.bin'))) {
      this.kokoro.error = 'model not installed (scripts/get-voice-model.sh)';
      return this.log('kokoro unavailable', this.kokoro.error);
    }
    const k = this.kokoro;
    k.starting = new Promise((resolve) => { k.onReady = resolve; });
    const worker = new Worker(path.join(__dirname, 'kokoro-worker.js'), { workerData: { dir, threads: Number(process.env.ARES_LOCAL_THREADS) || 4 } });
    k.worker = worker;
    const t0 = Date.now();
    worker.on('message', (msg) => {
      if (msg.type === 'ready') { k.ready = true; k.error = null; this.log('kokoro ready', { model: msg.model, voice: this.localVoice, ms: Date.now() - t0 }); k.onReady(); this.emit('state'); return; }
      if (msg.type === 'failed') { k.error = msg.error; this.log('kokoro unavailable', msg.error); k.onReady(); return; }
      const p = k.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'pcm') p.onChunk(Buffer.from(msg.pcm));
      else if (msg.type === 'end') {
        k.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else if (msg.cancelled) p.reject(abortError());
        else p.resolve();
      }
    });
    const dead = (why) => {
      k.ready = false;
      k.error = why;
      k.onReady?.();
      for (const p of k.pending.values()) p.reject(new Error(why));
      k.pending.clear();
      this.log('kokoro stopped', why);
      // Restart once a minute at most, unless it never worked
      if (!this.stopped && Date.now() - t0 > 60_000) setTimeout(() => this.#startKokoro(), 1000);
    };
    worker.on('error', (err) => dead(err.message));
    worker.on('exit', (code) => { if (k.worker === worker) dead(`exited (${code})`); });
  }

  async #kokoroSpeak(text, signal, onChunk) {
    const k = this.kokoro;
    if (!k.ready && k.starting) await Promise.race([k.starting, sleep(8000)]);
    if (!k.ready) throw new Error(`backup voice unavailable: ${k.error || 'starting'}`);
    const said = forKokoro(text);
    if (!/[a-z0-9]/i.test(said)) return;
    const id = ++k.seq;
    await new Promise((resolve, reject) => {
      k.pending.set(id, { onChunk, resolve, reject });
      k.worker.postMessage({ type: 'speak', id, text: said, sid: KOKORO_VOICES[this.localVoice], speed: this.localSpeed });
      signal?.addEventListener('abort', () => k.worker.postMessage({ type: 'cancel', id }), { once: true });
    });
  }

  // ---- macOS system voice (last resort): the best British female voice installed, never Daniel ----
  systemVoice() {
    if (this.sysVoice !== undefined) return this.sysVoice;
    let list = [];
    try {
      list = require('child_process').execFileSync('say', ['-v', '?'], { encoding: 'utf8' }).split('\n')
        .map((l) => l.match(/^(.+?)\s{2,}(\w\w_\w+)\s+#/)).filter(Boolean).map((m) => ({ name: m[1].trim(), lang: m[2] }));
    } catch {}
    const NAMES = ['Serena', 'Kate', 'Stephanie', 'Martha', 'Flo', 'Shelley', 'Sandy']; // British female, best first
    const tier = (v) => (/Premium/.test(v.name) ? 0 : /Enhanced/.test(v.name) ? 1 : 2);
    const female = list.filter((v) => v.lang === 'en_GB' && NAMES.some((n) => v.name.startsWith(n)))
      .sort((a, b) => tier(a) - tier(b) || NAMES.findIndex((n) => a.name.startsWith(n)) - NAMES.findIndex((n) => b.name.startsWith(n)));
    this.sysVoice = female[0]?.name || null;
    return this.sysVoice;
  }

  async #systemSpeak(text, signal, onChunk) {
    const voice = this.systemVoice();
    const file = path.join(os.tmpdir(), `ares-say-${process.pid}-${Date.now()}.wav`);
    try {
      await new Promise((resolve, reject) => {
        const child = execFile('say', [...(voice ? ['-v', voice] : []), '-r', '185', '--file-format=WAVE', `--data-format=LEI16@${RATE}`, '-o', file, '--', forKokoro(text)],
          (err) => (err ? reject(err) : resolve()));
        signal?.addEventListener('abort', () => child.kill(), { once: true });
      });
      if (signal?.aborted) throw abortError();
      const pcm = wavData(fs.readFileSync(file));
      for (let i = 0; i < pcm.length; i += 9600) onChunk(pcm.subarray(i, i + 9600));
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }
}

/** The PCM inside a WAVE file. */
function wavData(buf) {
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') return buf.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 24 kHz PCM -> M4A (AAC) with macOS's own encoder (its Ogg writer is broken; Telegram takes M4A voice notes). */
async function toM4a(pcm) {
  const base = path.join(os.tmpdir(), `ares-note-${process.pid}-${Date.now()}`);
  fs.writeFileSync(`${base}.wav`, wav(pcm));
  try {
    await new Promise((resolve, reject) => execFile('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '48000', `${base}.wav`, `${base}.m4a`], (err) => (err ? reject(err) : resolve())));
    return fs.readFileSync(`${base}.m4a`);
  } finally {
    fs.rm(`${base}.wav`, { force: true }, () => {});
    fs.rm(`${base}.m4a`, { force: true }, () => {});
  }
}

module.exports = { Voice, FILLER, classify, forKokoro, KOKORO_VOICES };
