// Per-stage latency log for voice turns (docs/voice-prompt.md A1), in the shape of Pipecat's latency observers: one record
// per turn, every stage as ms relative to the moment the user stopped speaking (negative = before it), in
// <support>/latency.jsonl. Times, counts and decisions only: never what was said (overheard speech least of all).
//
// Stages, in order, and who stamps them (all wall-clock ms, so the listener, main and the window share one clock):
//   speechStart, wakeSaid, wake, vadStop, lastText, eot      the listener (AresListener.swift timing())
//   heard, trust, intent, addressed                          main.js onCommand (voice ID, intent layer, addressed.js)
//   handle, plan, brainSent, brainFirstToken, brainDone      the window's handle() and askBrain (router decision with it)
//   firstSentence, ttsRequest, ttsFirstByte, firstAudio      the window's splitter, tts-stream, the window's audio clock
// `node scripts/latency-report.mjs` prints p50/p95 per stage and per kind of turn.
const fs = require('fs');

const STAGES = ['speechStart', 'wakeSaid', 'wake', 'vadStop', 'lastText', 'eot', 'heard', 'trust', 'intent', 'addressed',
  'handle', 'plan', 'brainSent', 'brainFirstToken', 'brainDone', 'firstSentence', 'ttsRequest', 'ttsFirstByte', 'firstAudio', 'done'];
const MAX_TURN_MS = 120_000;

class Latency {
  constructor(file) {
    this.file = file;
    this.turn = null;
  }

  /** A new turn. src: 'wake' | 'desk' | 'ptt' | 'barge' | 'typed' | 'phone'; listener: the command's `timing`. */
  begin(src, listener = {}, info = {}) {
    this.flush('superseded');
    const marks = {};
    for (const [k, v] of Object.entries(listener || {})) if (typeof v === 'number' && STAGES.includes(k)) marks[k] = v;
    this.turn = { src, marks, info: { endSilence: listener?.endSilence, ...info }, started: Date.now() };
    this.timer = setTimeout(() => this.flush('timeout'), MAX_TURN_MS);
    return this.turn;
  }

  /** A typed turn starts at the window's handle() unless a voice turn just began and is waiting for it. */
  ensure(src) {
    const t = this.turn;
    if (!t || t.marks.handle != null || Date.now() - t.started > 15_000) this.begin(src);
    return this.turn;
  }

  mark(stage, t = Date.now(), info) {
    if (!this.turn || !STAGES.includes(stage)) return;
    this.turn.marks[stage] = Math.round(t);
    if (info) Object.assign(this.turn.info, info);
  }

  /** Only the first of a stage counts (the first sentence, the first TTS byte, the first audio). */
  once(stage, t = Date.now(), info) {
    if (this.turn && this.turn.marks[stage] == null) this.mark(stage, t, info);
  }

  note(info) { if (this.turn) Object.assign(this.turn.info, info); }

  /** The turn ended (her reply finished, it was ignored, cut off, or timed out): write its record. */
  flush(end = 'done') {
    clearTimeout(this.timer);
    const turn = this.turn;
    this.turn = null;
    if (!turn) return null;
    const m = turn.marks;
    if (end === 'done') m.done ??= Date.now();
    const zero = m.vadStop ?? m.eot ?? m.handle ?? turn.started;
    const rel = {};
    for (const s of STAGES) if (m[s] != null) rel[s] = m[s] - zero;
    const rec = { at: new Date(zero).toISOString(), src: turn.src, end, ms: rel, ...turn.info };
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch {}
    return rec;
  }
}

module.exports = { Latency, STAGES };
