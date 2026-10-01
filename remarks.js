// What ARES does with a remark once the intent layer (intent.js) has said what it's doing. Shared by the
// Mac window, the phone app and Telegram, so "cheers", "say that again" and "nah, the other one" behave the
// same everywhere. Clear ones are answered on the Mac with no brain call; anything short and less clear goes
// to the brain with what she was just saying, so it lands the way a person means it.

const GRATITUDE = /\b(thanks?|thank you|cheers|ta|appreciated?|legend|star|lovely|brill(iant)?|nice one|great|perfect|awesome|good stuff)\b/i;
const THANKS_REPLIES = ['Any time.', 'Of course.', 'My pleasure.', 'Any time, sir.', 'Not at all.'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const MEANINGS = {
  continue: '"carry on" (pick up where you left off, or just keep going)',
  yes: '"yes"',
  no: '"no" or "not that" (they may want the other option)',
  stop: '"stop" or "wait"',
  thanks: 'thanks, or "got it"',
  repeat: '"say that again"',
  nevermind: '"never mind"',
  sleep: "that they're done for now",
};
// Short, but asking for detail: no "keep it brief" hint
const WANTS_DETAIL = /^(explain|tell me (about|more)|describe|walk me through|how (do|does|did|can|would|should)|why|what'?s the difference|compare|summari[sz]e|give me (a|the) (rundown|summary|details))\b/i;
const quote = (t, n = 240) => {
  const flat = String(t).replace(/\[[a-z ]+\]\s*/gi, '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return flat.length > n ? `…${flat.slice(-n)}` : flat;
};

class Remarks {
  /** lastReply(): { text, t } of what she last said, on any device (or null). */
  constructor({ lastReply }) {
    this.lastReply = lastReply;
    this.lastLocal = null; // the last remark handled without the brain: { text, said, intent, did, t }
  }

  /**
   * Decide what to do with a remark. Returns { quick } to answer it here (quick.reply may be '' for silence;
   * quick.action is 'sleep' when she should go back to waiting for her name), or { notes } to prefix the
   * brain prompt with. Calling it commits: a quick answer is remembered, and a brain turn is told about it.
   * @param r        intent.js classify() result
   * @param opts     afterBarge: they just talked over her · addressed: said to her (not overheard) ·
   *                 awake: always-listening mode · remote: phone/Telegram, where silence would look broken
   */
  plan(text, r, { afterBarge = false, addressed = true, awake = false, remote = false } = {}) {
    const quick = this.quick(text, r, { afterBarge, addressed, awake, remote });
    if (quick) {
      this.lastLocal = { text, said: text.trim().toLowerCase(), intent: r.intent, did: quick.did, t: Date.now() };
      return { quick };
    }
    const notes = this.notes(text, r, afterBarge);
    this.lastLocal = null; // the brain has now been told about it
    return { notes };
  }

  quick(text, r, { afterBarge, addressed, awake, remote }) {
    if (!r?.local) return null;
    const said = text.trim().toLowerCase();
    // The same thing again right after she handled it quietly: perhaps she got it wrong, so the brain looks
    if (r.intent !== 'stop' && this.lastLocal?.said === said && Date.now() - this.lastLocal.t < 20_000) return null;
    // On the phone or Telegram a reply that never comes looks broken, so "quiet" is a word or two in text
    const silent = (did, word = 'Okay.') => (remote ? { reply: word, voice: false, did } : { reply: '', did });
    const spoken = (reply, did, action) => (addressed ? { reply, did, action } : null); // overheard: the brain judges
    const last = this.lastReply();
    switch (r.intent) {
      case 'stop': return silent('stopped and stayed quiet');
      case 'nevermind': return silent('dropped it and stayed quiet', 'No problem.');
      case 'thanks':
        return afterBarge || !GRATITUDE.test(text)
          ? silent('took it as an acknowledgement and stayed quiet', 'Righto.')
          : spoken(pick(THANKS_REPLIES), 'took it as thanks and said a quick "you\'re welcome"');
      case 'repeat':
        return last?.text ? spoken(last.text, 'repeated your last reply') : null;
      case 'sleep':
        return awake && !remote
          ? spoken("Very good, sir. I'll wait for my name.", 'went back to waiting for your name', 'sleep')
          : spoken(pick(['Righto.', 'Very good, sir.']), 'said a quick goodbye');
    }
    return null;
  }

  /** Notes for the brain: what a short remark is probably answering, how long to reply, a local call to double-check. */
  notes(text, r, interrupted) {
    const notes = [];
    const local = this.lastLocal;
    if (local && Date.now() - local.t < 30_000) {
      notes.push(`(ARES note: just before this, the user said "${quote(local.text, 80)}", and the app handled it itself as "${local.intent}" (it ${local.did}) without asking you. ` +
        'If what they say now shows that was wrong, quietly call teach_phrase with their words and what they meant.)');
    }
    const words = r?.words ?? text.trim().split(/\s+/).length;
    const guess = r?.guess ?? 'chat';
    const last = this.lastReply();
    const recent = last?.text && Date.now() - last.t < 3 * 60_000;
    if (words <= 4 && (guess !== 'chat' || words <= 2) && (recent || interrupted)) {
      const meaning = MEANINGS[guess];
      notes.push(`(ARES note: a short remark in reply to ${interrupted ? 'what you were saying when they cut in' : `what you just said: "${quote(last.text)}"`}.` +
        `${meaning ? ` It most likely means ${meaning}.` : ''} Take it the way a person would in conversation, and answer in a few words or a sentence.)`);
    } else if (words <= 6 && !WANTS_DETAIL.test(text.trim())) {
      notes.push('(ARES note: a short, casual remark, so keep your reply short too, a sentence or so, unless they clearly want more.)');
    }
    return notes.map((n) => `${n}\n\n`).join('');
  }
}

module.exports = { Remarks };
