// Today's wake rule (native/AresListener.swift findWake), ported to run over saved transcripts (docs/voice-prompt.md A2):
// a multi-word phrase ("hey ares", "ok ares") matches anywhere; a bare name only as the first word or after ≥ 0.6 s of quiet.
// "ares" also matches its common mis-hearings. Input: a transcript { text, segments: [{ t, d, s }] } from lab.transcribe.
const NAME = '(?:ares|aries|arras|arris|aris|arez|eris)';
const PHRASES = ['hey ares', 'ok ares'];
const BARE = ['ares'];
const word = (w) => (w === 'ares' ? NAME : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const PHRASE_RE = new RegExp(String.raw`\b(?:` + PHRASES.map((p) => p.split(' ').map(word).join(String.raw`[\s,]+`)).join('|') + String.raw`)\b`, 'i');
const BARE_RE = new RegExp('^(?:' + BARE.map(word).join('|') + ')$', 'i');

/** { woke, how } for one transcript, exactly as the listener would decide on its final text. */
export function wakeToday(tr) {
  if (!tr || !tr.text) return { woke: false, how: 'no text' };
  if (PHRASE_RE.test(tr.text)) return { woke: true, how: 'phrase' };
  const segs = tr.segments || [];
  for (let i = 0; i < segs.length; i++) {
    const w = String(segs[i].s || '').replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!BARE_RE.test(w)) continue;
    const gap = i === 0 ? Infinity : segs[i].t - (segs[i - 1].t + segs[i - 1].d);
    if (i === 0 || gap >= 0.6) return { woke: true, how: i === 0 ? 'bare first word' : 'bare after a pause' };
  }
  return { woke: false, how: 'no match' };
}

/** How the name itself came out, for the confusion table: the word where "ares" should be (or that matched). */
export function nameHeardAs(tr) {
  const m = String(tr?.text || '').match(/^(?:hey|ok|okay)?[\s,]*([\p{L}' -]+?)[\s,]/iu);
  return m ? m[1].toLowerCase() : '';
}
