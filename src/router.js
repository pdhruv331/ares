// Picks which Claude model answers each request, all within the Claude subscription (no extra charges):
//   haiku  - quick things: chit-chat, Mac controls, timers, time and weather. Light on the usage limits.
//   sonnet - everything else (the default): calendar, email, contacts, messages, most questions.
//   opus   - hard things: planning, analysis, writing, research, decisions, long or multi-part requests.
// Plain rules, no extra model call. Say "use opus" or "think hard" to get Opus; ARES_ROUTER=off pins one model.

const HAIKU = 'haiku';
const SONNET = 'sonnet';
const OPUS = 'opus';

// Asking for a model outright
const ASK_OPUS = /\b(use|switch to|with|on) opus\b|\bthink (it through|hard(er)?|deeply|carefully|properly)\b|\b(deep dive|take your time|in depth|thoroughly|properly research)\b/i;
const ASK_SONNET = /\b(use|switch to|with|on) sonnet\b/i;
const ASK_HAIKU = /\b(use|switch to|with|on) haiku\b|\bquick answer\b/i;

// Short replies that continue what she was doing (a "yes" to a confirmation stays on the same model)
const FOLLOW_UP = /^(yes|yeah|yep|yup|no|nope|nah|go ahead|do it|send it|sure|ok(ay)?|carry on|go on|keep going|sounds good|perfect|correct|right|exactly|that one|the (first|second|third|last|other) one|both|neither|cancel( it)?|never ?mind|stop|wait|hold on)\b/i;
const THANKS = /^(thanks|thank you|cheers|ta|nice one|brilliant|great|cool|lovely|nice)\b[\s!.,]*(ares|mate|sir)?[\s!.]*$/i;

// Signs a request needs real thinking
const HARD = new RegExp([
  String.raw`\b(plan|planning|strategy|strategi[sz]e|roadmap|itinerary|budget)\b`,
  String.raw`\b(analy[sz]e|analysis|compare|comparison|pros and cons|trade-?offs?|evaluate|assess|weigh up)\b`,
  String.raw`\b(debug|troubleshoot|root cause|figure out why|work out why|diagnose)\b`,
  String.raw`\b(research|investigate|look into .{0,30} in detail|in detail|step by step|walk me through|break (it|this|that) down)\b`,
  String.raw`\b(brainstorm|help me (decide|think|work out|figure|choose|plan|write)|should i|what would you do|advise me|advice on)\b`,
  String.raw`\b(review|critique|proofread|rewrite|improve|edit) (my|this|the|that)\b`,
  String.raw`\b(draft|write|compose) (me )?(a|an|the|my|some)?\s?(email|reply|letter|essay|report|proposal|cover letter|plan|story|speech|post|message|summary|bio|cv|resume)\b`,
  String.raw`\b(summari[sz]e|go through|catch me up on) (my|all|the|this|everything)\b`,
  String.raw`\b(optimi[sz]e|prioriti[sz]e|organi[sz]e my (week|day|schedule|time))\b`,
  String.raw`\b(explain|why) .{0,40}\b(how|works?|work|happens?|difference)\b`,
].join('|'), 'i');

// Quick, self-contained things
const EASY = new RegExp([
  String.raw`^(hi|hey|hello|hiya|yo|morning|evening|good (morning|afternoon|evening|night)|how are you|how'?s it going|what'?s up|you there)\b`,
  String.raw`\b(open|launch|start|quit|close) (the )?[a-z0-9 ]{2,20}( app)?$`,
  String.raw`\b(volume|mute|unmute|louder|quieter|turn (it|the volume|the music) (up|down))\b`,
  String.raw`^(play|pause|resume|skip|next|previous|stop the music|stop music)\b`,
  String.raw`\b(set|start|cancel) (a |an |the )?.{0,20}\b(timer|alarm)\b`,
  String.raw`\block (the |my )?(screen|mac|computer)\b`,
  String.raw`\b(battery|charge level)\b`,
  String.raw`^(what('?s| is) the (time|date|day)|what time is it|what day is it|what'?s today'?s date)\b`,
  String.raw`^(what('?s| is) the (weather|temperature|forecast)|how('?s| is) the weather|is it (going to )?(rain|snow|be (hot|cold|sunny)))\b`,
  String.raw`^(how do you spell|spell|define|what does .{1,30} mean|what('?s| is) \d[\d\s.,]*\s?[x×*/+-])`,
  String.raw`^(convert|how many .{1,30} (in|are in) )`,
  String.raw`^remind me\b`,
].join('|'), 'i');

// Anything touching your data, people or sending stays on Sonnet at least
const PERSONAL = /\b(email|e-mail|gmail|inbox|mail|calendar|meeting|event|appointment|schedule|drive|document|doc|file|contact|text|message|whatsapp|call|ring|send|reply|invite|book)\b/i;

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * @param {string} said   what the user actually said (not the notes ARES adds)
 * @param {{images?: number, last?: string}} o   images attached; the model that answered last turn
 * @returns {{model: string, why: string}}
 */
// Driving background jobs (show, open, send, cancel one): quick tool calls, whatever the job is about
const JOB_CONTROL = /^(please |can you |could you )?(show|open|pull up|bring up|send|cancel|stop|dismiss|close)\b.*\b(job|jobs|results?|to my (phone|mac))\b/i;

function route(said, { images = 0, last = SONNET } = {}) {
  const t = String(said || '').trim();
  if (ASK_OPUS.test(t)) return { model: OPUS, why: 'asked' };
  if (ASK_SONNET.test(t)) return { model: SONNET, why: 'asked' };
  if (ASK_HAIKU.test(t)) return { model: HAIKU, why: 'asked' };
  const n = words(t);
  if (n <= 5 && THANKS.test(t)) return { model: HAIKU, why: 'thanks' };
  if (n <= 5 && FOLLOW_UP.test(t)) return { model: last || SONNET, why: 'follow-up' };
  if (t.length > 600 || (t.match(/\?/g) || []).length >= 3) return { model: OPUS, why: 'long' };
  if (n <= 14 && JOB_CONTROL.test(t)) return { model: SONNET, why: 'job control' }; // "show me the comparison job": a tool call, not analysis
  if (HARD.test(t)) return { model: OPUS, why: 'complex' };
  if (!images && n <= 14 && EASY.test(t) && !PERSONAL.test(t)) return { model: HAIKU, why: 'quick' };
  return { model: SONNET, why: 'default' };
}

module.exports = { route, HAIKU, SONNET, OPUS };
