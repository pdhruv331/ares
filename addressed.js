// Is the user talking TO ARES? For speech heard without the wake word (desk mode, "stay awake").
// Judged on the Mac, from the words and the conversation's timing, before anything goes to the brain:
//   yes     her name; a follow-up within ~20 s of her last reply; a direct request or question to an assistant
//   no      thinking aloud, self-talk, fillers, talking about someone
//   unsure  everything else: she stays quiet (never interrupt, never guess)
// Only "yes" reaches the brain, which still gets the always-listening note and can decline with (ignore).

const FOLLOW_UP_MS = 20_000;
const NAME = /\b(ares|aries|ayres|arias|aris)\b/i;
const FILLER = /^(hmm+|hm+|uh+|um+|er+|ah+|oh+|ooh+|ugh+|huh|meh|wow|ok(ay)?|right|yeah|yep|nope|no|yes|cool|nice|damn|shit|oops|whoops|come on|god)$/i;
// Thinking aloud / talking to oneself or about others
const SELF_TALK = new RegExp('^(' + [
  'hmm+', 'um+', 'uh+', 'ok(ay)? so', 'so', 'wait', 'hold on', 'let me', "let's see", 'lemme', 'i wonder', 'i think', 'i guess', 'i need to', "i'll", 'i should',
  "i'm (gonna|going to)", 'maybe i', 'where (did|is|are) (i|my|the)', "where's (my|the)", 'what was (i|it|that)', 'why (is|isn\'t|won\'t|doesn\'t|did) (this|it|that)',
  'come on', 'oh (no|god|man|wait)', 'he ', 'she ', 'they ', 'we (need|should|could)', 'you know what', 'note to self',
].join('|') + ')\\b', 'i');
// Requests and questions you'd put to an assistant
const DIRECT = new RegExp('^(please |hey |ok(ay)? )?(' + [
  'can you', 'could you', 'would you', 'will you', 'do you', 'are you', 'did you', 'have you', "what's", 'what is', 'what are', 'what time', 'whats',
  'how (do|does|much|many|long|far|is|are|about)', 'when (is|does|do|are|was)', 'who (is|was|are)', 'where is', 'is it', 'is there', 'are there', 'should i',
  'remind', 'tell me', 'show me', 'give me', 'find', 'search', 'look up', 'look for', 'open', 'close', 'play', 'pause', 'resume', 'skip', 'stop', 'set', 'start',
  'turn', 'send', 'text', 'message', 'email', 'call', 'ring', 'add', 'schedule', 'book', 'cancel', 'read', 'check', 'summari[sz]e', 'make', 'write', 'draft',
  'create', 'translate', 'explain', 'define', 'calculate', 'convert', 'mute', 'unmute', 'volume', 'take a note', 'note that', 'remember', 'forget',
].join('|') + ')\\b', 'i');

/**
 * @param {string} text  what was heard
 * @param {{ lastReplyAt?: number, askedQuestion?: boolean, now?: number }} ctx
 * @returns {{ verdict: 'yes'|'no'|'unsure', why: string, followUp: boolean }}
 */
function judge(text, { lastReplyAt = 0, askedQuestion = false, now = Date.now() } = {}) {
  const t = String(text || '').trim().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');
  const words = t ? t.split(' ').length : 0;
  const followUp = now - lastReplyAt < FOLLOW_UP_MS;
  if (!words) return { verdict: 'no', why: 'empty', followUp };
  if (NAME.test(t)) return { verdict: 'yes', why: 'her name', followUp };
  if (followUp) {
    // In conversation: a short answer to her question, or anything that isn't plainly self-talk, is for her
    if (askedQuestion && words <= 6) return { verdict: 'yes', why: 'answering her question', followUp };
    if (SELF_TALK.test(t) && !/\byou\b/i.test(t)) return { verdict: 'unsure', why: 'self-talk during a conversation', followUp };
    if (words >= 2 || FILLER.test(t)) return { verdict: 'yes', why: 'follow-up', followUp };
  }
  if (words < 3 || FILLER.test(t)) return { verdict: 'no', why: 'too short or a filler', followUp };
  if (SELF_TALK.test(t) && !/\b(you|your)\b/i.test(t)) return { verdict: 'no', why: 'thinking aloud', followUp };
  if (DIRECT.test(t)) return { verdict: 'yes', why: 'a request or question', followUp };
  return { verdict: 'unsure', why: 'not clearly for her', followUp };
}

module.exports = { judge, FOLLOW_UP_MS };
