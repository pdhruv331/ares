// Phone calls: ARES's phone line is an ElevenLabs agent ("ARES Calls") on a Twilio number. The Mac never
// accepts connections for it: everything here is outbound HTTPS to ElevenLabs (start calls, poll for results,
// keep the agent's context current). The line keeps working with the Mac off; the Mac catches up when it's back.
//
// Files (support folder): calls/calls.json (the calls log), calls/state.json (what's been processed,
// messages to pass on, scheduled calls), calls/transcripts/<conversation id>.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const API = 'https://api.elevenlabs.io';
const OWNER = process.env.ARES_OWNER_NAME || 'Dhruv';
const MAX_SECS = Math.min(900, Math.max(60, Number(process.env.ARES_CALL_MAX_SECS) || 300)); // per call, both ways
const PER_DAY = Math.max(1, Number(process.env.ARES_CALLS_PER_DAY) || 10);              // outbound calls ARES may place a day
const LINE_DAILY_LIMIT = Math.max(PER_DAY, Number(process.env.ARES_LINE_DAILY_LIMIT) || 40); // all calls, set on the agent
const POLL_MS = 45_000;      // looking for new inbound calls while the Mac is on
const LIVE_POLL_MS = 4_000;  // a call ARES placed, until it ends
const AGENT_SETUP = 3;       // bump when ensureAgent() changes what it sets
const MARKER = '\n\n## Standing rules (kept current by the ARES app; edit the part above this line, not below)';
const FINAL = new Set(['done', 'failed']);

const GREETING = `Hi, this is ARES, ${OWNER}'s AI assistant. He can't get to the phone right now, so I'm taking messages, and this call's transcribed for him. Who's calling?`;
const GREETING_HI = 'नमस्ते, मैं ARES हूँ, ध्रुव की AI असिस्टेंट। वो अभी फ़ोन नहीं उठा पा रहे हैं, तो मैं उनके लिए मैसेज ले रही हूँ, और यह कॉल उनके लिए लिखी जा रही है। कौन बोल रहे हैं?';

// What ElevenLabs' post-call analysis pulls out of every call (platform_settings.data_collection)
const DATA_COLLECTION = {
  caller_name: { type: 'string', description: 'Inbound calls: the caller\'s name as they gave it (and company, if any). Empty if they never said.' },
  callback_number: { type: 'string', description: 'Inbound calls: the number the caller wants to be called back on, digits with country code if given. Write "this number" if they said the number they\'re calling from. Empty if not discussed.' },
  topic: { type: 'string', description: 'What the call was about in 2 to 6 words, lower case, e.g. "friday dinner plans", "confirming the dentist appointment".' },
  message: { type: 'string', description: `The message for ${OWNER} in one or two short sentences, in plain words. Empty if there was none.` },
  urgent: { type: 'boolean', description: 'True only if the caller said it is urgent or an emergency, or it is clearly time-critical (needs an answer within hours, a family or medical matter).' },
  spam: { type: 'boolean', description: 'True if it was a sales call, robocall, scam, survey, or a wrong number.' },
  outcome: { type: 'string', description: `Outbound calls (the assistant called someone for ${OWNER}): the result of the task in one sentence with the key details (times, names, prices, reference numbers, conditions). Empty for inbound calls.` },
};

const digitsOf = (n = '') => String(n).replace(/[^\d]/g, '');
const last10 = (n) => digitsOf(n).slice(-10);
/** A dialable E.164 number, or null. US/Canada numbers may be given without the +1. */
function e164(raw) {
  const s = String(raw || '').trim();
  const d = digitsOf(s);
  if (s.startsWith('+')) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  if (s.startsWith('00') && d.length > 10) return `+${d.slice(2)}`;
  return null;
}
/** Numbers ARES must never dial: emergency and short codes, premium lines, or its own line. */
function forbidden(num, own) {
  const d = digitsOf(num);
  if (own && last10(own) === last10(num)) return 'that\'s the ARES line itself';
  if (/^1(900|976)/.test(d)) return 'premium-rate numbers are off limits';
  if (d.length < 8 || /^1?(911|112|999|988)$/.test(d)) return 'emergency and short numbers are off limits';
  return null;
}
const say = (n) => { const d = last10(n); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : n; };
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local

class Calls extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir         support-folder directory for the calls log
   * @param {Function} o.log
   * @param {Function} o.contactByNumber  (number) => contact name or ''
   * @param {Function} o.phrase    async (prompt) => text: turns a finished call into a natural sentence (Claude Code)
   * @param {string} o.cli         the Claude Code CLI, for reading busy/free from the calendar
   * @param {Function} o.delivered async (ids) => ids the cloud relay already pushed to the phone
   */
  constructor({ dir, log, contactByNumber = () => '', phrase, cli, delivered = async () => [] }) {
    super();
    this.dir = dir;
    this.log = log;
    this.contactByNumber = contactByNumber;
    this.phrase = phrase;
    this.cli = cli;
    this.delivered = delivered;
    this.key = process.env.ELEVENLABS_API_KEY;
    this.agentId = process.env.ELEVENLABS_AGENT_ID;
    this.numberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
    fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
    this.logFile = path.join(dir, 'calls.json');
    this.stateFile = path.join(dir, 'state.json');
    this.calls = this.#read(this.logFile, []);
    this.state = this.#read(this.stateFile, null);
    this.live = new Map(); // conversation id -> poll timer, for calls ARES placed
    this.talk = new Map(); // conversation id -> the transcript so far, while it's live (the dashboard's CALL details)
    this.busy = null;      // { day, blocks: [{start, end, allDay}] } from the calendar
    this.ownNumber = '';
    this.persona = '';
  }

  get ready() { return Boolean(this.key && this.agentId && this.numberId); }

  #read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
  #saveLog() {
    if (this.calls.length > 500) this.calls.splice(0, this.calls.length - 500);
    fs.writeFileSync(this.logFile, JSON.stringify(this.calls, null, 1), { mode: 0o600 });
  }
  #saveState() { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 1), { mode: 0o600 }); }

  async #api(method, p, body) {
    const res = await fetch(API + p, {
      method,
      headers: { 'xi-api-key': this.key, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { text }; }
    if (!res.ok) {
      const detail = data?.detail?.message || data?.detail?.[0]?.msg || (typeof data?.detail === 'string' ? data.detail : '') || res.statusText;
      throw new Error(`ElevenLabs ${res.status}: ${String(detail).slice(0, 200)}`);
    }
    return data;
  }

  // ---- Startup --------------------------------------------------------------------------------
  async start() {
    if (!this.ready) { this.log('calls off', { key: Boolean(this.key), agent: Boolean(this.agentId), number: Boolean(this.numberId) }); return; }
    if (!this.state) await this.#firstRun();
    try {
      const nums = await this.#api('GET', '/v1/convai/phone-numbers');
      this.ownNumber = nums.find?.((n) => n.phone_number_id === this.numberId)?.phone_number || '';
      await this.ensureAgent();
    } catch (err) { this.log('calls setup failed', err.message); }
    // Calls ARES placed that were still going when the app last quit
    for (const c of this.calls) if (c.direction === 'outbound' && !FINAL.has(c.status) && c.status !== 'scheduled' && c.id) this.#watch(c.id);
    await this.catchUp('start');
    this.timer = setInterval(() => this.poll().catch((err) => this.log('calls poll failed', err.message)), POLL_MS);
    this.timer.unref?.();
    this.schedTimer = setInterval(() => this.#runScheduled(), 20_000);
    this.schedTimer.unref?.();
    this.refreshContext('start');
    this.hourly = setInterval(() => this.refreshContext('hourly'), 60 * 60_000);
    this.hourly.unref?.();
  }

  stop() { clearInterval(this.timer); clearInterval(this.schedTimer); clearInterval(this.hourly); for (const t of this.live.values()) clearTimeout(t); }

  /** First launch with calls: the line's history goes into the log quietly; nothing old is announced. */
  async #firstRun() {
    this.state = { processed: [], messages: [], scheduled: [], contextHash: '', agentSetup: 0 };
    try {
      const { conversations = [] } = await this.#api('GET', `/v1/convai/conversations?agent_id=${this.agentId}&page_size=50&summary_mode=include`);
      for (const c of conversations.reverse()) {
        this.state.processed.push(c.conversation_id);
        let rec = { id: c.conversation_id, direction: c.direction || 'inbound', at: c.start_time_unix_secs * 1000, secs: c.call_duration_secs,
          status: c.status, title: c.call_summary_title || '', summary: c.transcript_summary || '' };
        try { // numbers and transcripts too (one-off, for the last few weeks of calls)
          const conv = await this.#api('GET', `/v1/convai/conversations/${c.conversation_id}`);
          this.#saveTranscript(c.conversation_id, conv);
          rec = { id: c.conversation_id, ...this.#fromConversation(conv) };
        } catch {}
        this.calls.push({ ...rec, notified: true });
      }
      this.#saveLog();
    } catch (err) { this.log('calls history failed', err.message); }
    this.#saveState();
  }

  /**
   * The agent's settings that ARES owns: greeting, safety rules, the post-call analysis fields, cost caps,
   * the hang-up tool, and the per-call overrides outbound calls need. Everything else (voice, persona,
   * LLM) stays as set in the dashboard.
   */
  async ensureAgent() {
    const agent = await this.#api('GET', `/v1/convai/agents/${this.agentId}`);
    const conf = agent.conversation_config;
    this.persona = String(conf.agent.prompt.prompt || '').split(MARKER)[0].trimEnd();
    if (this.state?.agentSetup === AGENT_SETUP) return;
    const builtIn = { ...(conf.agent.prompt.built_in_tools || {}) };
    builtIn.end_call = { name: 'end_call', description: 'Hang up once the conversation is finished and goodbyes are said, or straight away on spam and robocalls.', params: { system_tool_type: 'end_call' } };
    const hi = conf.language_presets?.hi;
    await this.#api('PATCH', `/v1/convai/agents/${this.agentId}`, {
      conversation_config: {
        agent: { first_message: GREETING, prompt: { prompt: this.#fullPrompt(), built_in_tools: builtIn } },
        conversation: { max_duration_seconds: MAX_SECS },
        ...(hi && { language_presets: { ...conf.language_presets, hi: { ...hi, overrides: { ...hi.overrides, agent: { ...hi.overrides?.agent, first_message: GREETING_HI } } } } }),
      },
      platform_settings: {
        data_collection: DATA_COLLECTION,
        privacy: { ...agent.platform_settings.privacy, record_voice: false }, // transcripts only, never audio
        call_limits: { ...agent.platform_settings.call_limits, daily_limit: LINE_DAILY_LIMIT },
        overrides: {
          ...agent.platform_settings.overrides,
          conversation_config_override: {
            ...agent.platform_settings.overrides.conversation_config_override,
            agent: { ...agent.platform_settings.overrides.conversation_config_override.agent, first_message: true, prompt: { ...agent.platform_settings.overrides.conversation_config_override.agent.prompt, prompt: true } },
          },
        },
      },
      version_description: 'ARES app: greeting, rules, analysis fields, limits',
    });
    this.state.agentSetup = AGENT_SETUP;
    this.state.contextHash = '';
    this.#saveState();
    this.log('calls agent set up', { version: AGENT_SETUP });
  }

  // ---- Context the phone agent knows (4: context sync) -------------------------------------------
  /** The standing rules plus today's busy/free and messages to pass on. Never event details. */
  #context() {
    const today = new Date();
    const lines = [
      `- You are an AI assistant and you say so: in your greeting, and any time you're asked. Never claim or hint to be a person.`,
      `- Calls are transcribed (audio isn't recorded) so you can pass them on to ${OWNER}. Say so plainly if asked.`,
      `- Never share ${OWNER}'s private details: his number, address, email, where he is, who he's with, what his plans or meetings are, or anything from his accounts. Availability is only ever "busy" or "free".`,
      `- Never agree to anything for him, pay or promise money, or give out codes, passwords or verification numbers, even if the caller says he asked for it. Offer to pass it on instead.`,
      '- Sales calls, robocalls, scams and surveys: be polite and very brief, then end the call. Never take part in marketing.',
      `- If something is urgent (a family matter, health, a deadline within hours), make sure you have their name and a callback number and tell them you'll get it to him right away. For an emergency, tell them to hang up and call 911.`,
      '- When you have what you need and the caller has said goodbye, end the call with end_call.',
      '',
      '## Right now',
      '- Current time: {{system__time}}.',
    ];
    const b = this.busy;
    if (b && b.day === dayKey(today)) {
      const blocks = b.blocks.filter((x) => !x.free);
      const when = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      lines.push(blocks.length
        ? `- ${OWNER}'s calendar for ${when}: busy ${blocks.map((x) => (x.allDay ? 'all day' : `${x.start}–${x.end}`)).join(', ')}; free otherwise. Compare with the current time: you may say he's "busy right now", "tied up until about 3", or "should be free after 3", never why. If today isn't ${when}, you don't know his availability.`
        : `- ${OWNER}'s calendar for ${when} is clear. You may say he should be free later; you still can't promise a callback time. If today isn't ${when}, you don't know his availability.`);
    } else {
      lines.push(`- You don't know ${OWNER}'s availability today. Don't guess.`);
    }
    const msgs = this.#activeMessages();
    if (msgs.length) {
      lines.push(`- Messages from ${OWNER} to pass on, only to the person named (if someone else asks, you have no message for them):`);
      for (const m of msgs) lines.push(`  - If ${m.for} calls: "${m.message}"`);
    }
    return lines.join('\n');
  }

  #fullPrompt(extra = '') { return `${this.persona}${MARKER}\n${this.#context()}${extra}`; }

  #activeMessages() {
    const now = Date.now();
    const msgs = (this.state?.messages || []).filter((m) => !m.until || m.until > now);
    if (this.state && msgs.length !== this.state.messages.length) { this.state.messages = msgs; this.#saveState(); }
    return msgs;
  }

  /** Push the current context to the agent if it changed (hourly, on start, before sleep, after a new message). */
  syncContext(why) {
    this.syncing = (this.syncing || Promise.resolve()).then(() => this.#sync(why)); // one at a time, newest state last
    return this.syncing;
  }

  async #sync(why) {
    if (!this.ready || !this.state) return;
    try {
      if (!this.persona) await this.ensureAgent();
      const prompt = this.#fullPrompt();
      const hash = crypto.createHash('sha256').update(prompt).digest('hex');
      if (hash === this.state.contextHash) return;
      await this.#api('PATCH', `/v1/convai/agents/${this.agentId}`, { conversation_config: { agent: { prompt: { prompt } } }, version_description: `ARES context (${why})` });
      this.state.contextHash = hash;
      this.#saveState();
      this.log('calls context synced', { why, busy: this.busy?.blocks?.length ?? null, messages: this.#activeMessages().length });
    } catch (err) { this.log('calls context failed', { why, error: err.message }); }
  }

  /** Re-read today's busy/free from the calendar (slow: ~15s), then sync. */
  async refreshContext(why) {
    const h = new Date().getHours();
    if (why === 'hourly' && (h < 6 || h > 22)) return this.syncContext(why);
    for (let attempt = 1; attempt <= 2; attempt++) { // the connectors sometimes aren't up yet on the first run
      try { this.busy = await this.#fetchBusy(); break; } catch (err) { this.log('calls calendar failed', { attempt, error: err.message }); }
    }
    await this.syncContext(why);
  }

  /**
   * Today's busy blocks from Google Calendar, through Claude Code's Calendar connector (read-only: list_events is the
   * only tool it may use). Only start/end times come back: titles, people and places never leave this function.
   * The run must actually have called list_events, so a model that answers without looking can't invent a schedule.
   */
  #fetchBusy() {
    return new Promise((resolve, reject) => {
      if (!this.cli) return reject(new Error('no Claude Code'));
      const now = new Date();
      const tz = -now.getTimezoneOffset();
      const off = `${tz >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(tz) / 60)).padStart(2, '0')}:${String(Math.abs(tz) % 60).padStart(2, '0')}`;
      const day = dayKey(now);
      const prompt = `Today is ${now.toLocaleDateString('en-US', { weekday: 'long' })} ${day}, local time ${now.toTimeString().slice(0, 5)} (UTC${off}). ` +
        `Call list_events on my primary calendar from ${day}T00:00:00${off} to ${day}T23:59:59${off}. Then output ONLY a JSON array of the events, ` +
        '[{"start":"HH:MM","end":"HH:MM","allDay":false,"free":false}], in 24-hour local time; free=true if the event is marked free/transparent or I declined it. ' +
        'No titles, no names, no other text. [] if there are none.';
      const env = { ...process.env, ENABLE_TOOL_SEARCH: 'false', MCP_CONNECTION_NONBLOCKING: 'false' }; // connectors loaded up front
      delete env.ANTHROPIC_API_KEY; // subscription only
      const others = ['ElevenLabs', 'Claude_Docs', 'Gmail', 'Slack', 'Google_Drive'].map((s) => `mcp__claude_ai_${s}`);
      const writes = ['create_event', 'update_event', 'delete_event', 'respond_to_event'].map((t) => `mcp__claude_ai_Google_Calendar__${t}`);
      const child = spawn(this.cli, ['-p', '--model', 'haiku', '--effort', 'low', '--tools', '', '--setting-sources', '',
        '--output-format', 'stream-json', '--verbose', '--disallowedTools', ...others, ...writes,
        '--allowedTools', 'mcp__claude_ai_Google_Calendar__list_events',
        '--system-prompt', 'You read calendar times for a busy/free display. Always call list_events first. Output JSON only.', prompt],
      { cwd: this.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => child.kill(), 90_000);
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', () => {
        clearTimeout(timer);
        let looked = false;
        let result = '';
        for (const line of out.split('\n')) {
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.type === 'user' && m.message?.content?.some?.((c) => c.type === 'tool_result' && !c.is_error)) looked = true;
          if (m.type === 'result') result = m.result || '';
        }
        if (!looked) return reject(new Error('the calendar tool wasn\'t used'));
        try {
          const arr = JSON.parse(result.slice(result.indexOf('['), result.lastIndexOf(']') + 1));
          const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
          const fmt = (t) => { const [hh, mm] = t.split(':').map(Number); return clock(new Date(2000, 0, 1, hh, mm)); };
          const blocks = arr.filter((x) => x && (x.allDay || (hhmm.test(x.start) && hhmm.test(x.end))))
            .map((x) => ({ allDay: Boolean(x.allDay), free: Boolean(x.free), start: x.allDay ? '' : fmt(x.start), end: x.allDay ? '' : fmt(x.end), sort: x.allDay ? '' : x.start.padStart(5, '0') }))
            .sort((a, b) => a.sort.localeCompare(b.sort)).map(({ sort, ...x }) => x);
          resolve({ day, blocks });
        } catch { reject(new Error('unreadable calendar answer')); }
      });
    });
  }

  /** "If Sam calls, tell him I'll be late." Kept until `hours` pass (default: the end of today). */
  addMessage({ for: who, message, hours }) {
    who = String(who || '').trim();
    message = String(message || '').trim();
    if (!who || !message) throw new Error('need who it\'s for and the message');
    const end = new Date(); end.setHours(23, 59, 59, 0);
    const until = hours ? Date.now() + hours * 3_600_000 : end.getTime();
    this.state.messages = this.#activeMessages().filter((m) => m.for.toLowerCase() !== who.toLowerCase());
    this.state.messages.push({ for: who, message, until, at: Date.now() });
    this.#saveState();
    this.syncContext('message');
    return `Got it: if ${who} calls, the phone line will tell them "${message}" (until ${new Date(until).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}).`;
  }

  removeMessage({ for: who } = {}) {
    const before = this.#activeMessages();
    this.state.messages = who ? before.filter((m) => !m.for.toLowerCase().includes(String(who).toLowerCase())) : [];
    this.#saveState();
    this.syncContext('message');
    const gone = before.length - this.state.messages.length;
    const left = this.state.messages.map((m) => `${m.for}: "${m.message}"`).join('; ');
    return `${gone ? `Removed ${gone} message${gone > 1 ? 's' : ''}.` : 'No matching message.'}${left ? ` Still active: ${left}` : ''}`;
  }

  // ---- Outbound (1) ------------------------------------------------------------------------------
  /**
   * Place a call now, or schedule it (`at`, ISO local time). The caller (bridge) has already checked the user's yes.
   * { to, name, purpose, brief, language, at }
   */
  async make({ to, name, purpose, brief, language, at, source = 'mac' }) {
    if (!this.ready) throw new Error('the phone line isn\'t set up (ELEVENLABS_AGENT_ID / ELEVENLABS_PHONE_NUMBER_ID missing)');
    const number = e164(to);
    if (!number) throw new Error(`"${to}" isn't a full phone number. Look it up with find_contact, or ask the user for it`);
    const no = forbidden(number, this.ownNumber);
    if (no) throw new Error(no);
    purpose = String(purpose || '').trim().replace(/[.]+$/, '');
    brief = String(brief || '').trim();
    if (!purpose || !brief) throw new Error('need the purpose and a full brief');
    name = String(name || this.contactByNumber(number) || say(number)).trim();
    const today = this.calls.filter((c) => c.direction === 'outbound' && c.status !== 'scheduled' && c.status !== 'cancelled' && dayKey(new Date(c.at)) === dayKey()).length;
    if (today >= PER_DAY) throw new Error(`the daily limit of ${PER_DAY} calls is used up (ARES_CALLS_PER_DAY)`);
    const call = { direction: 'outbound', number, name, purpose, brief, language: language || 'en', source, notified: false };

    if (at) {
      const when = new Date(at);
      if (isNaN(when)) throw new Error(`couldn't understand the time "${at}"`);
      if (when - Date.now() > 60_000) {
        if (when - Date.now() > 7 * 86_400_000) throw new Error('calls can be scheduled up to a week ahead');
        const id = `sched_${Date.now().toString(36)}`;
        this.calls.push({ ...call, id, status: 'scheduled', at: when.getTime() });
        this.#saveLog();
        this.emit('change');
        this.log('call scheduled', { id, at: when.toISOString() });
        return `Scheduled: I'll call ${name} at ${when.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (the Mac needs to be awake then).`;
      }
    }
    return this.#dial(call);
  }

  async #dial(call) {
    const task = [
      '',
      '',
      '## This call: YOU are calling out',
      `You placed this call on ${OWNER}'s behalf. You are calling ${call.name}. The greeting has already said who you are and why you're calling.`,
      `Goal: ${call.purpose}.`,
      `Brief from ${OWNER}: ${call.brief}`,
      '- Stick to the goal and the brief. You may share only the details in the brief (e.g. the name for a booking), nothing else about him.',
      '- If something needs a decision the brief doesn\'t cover (a different time, a deposit, a price), don\'t agree: get the options and say you\'ll check with him.',
      '- Confirm the key details back once before you finish (time, date, name, price, reference number).',
      `- If you reach voicemail, leave one short message: who you are, what it's about, and that they can call back on ${say(this.ownNumber)}. Then end the call.`,
      '- If you are put on hold, wait patiently. If they ask you to call back later, find out when.',
      '- When it\'s done and you\'ve said goodbye, end the call with end_call.',
    ].join('\n');
    const first = `Hi, this is ARES, ${OWNER}'s AI assistant, calling on his behalf. Just so you know, the call's transcribed for him. I'm calling ${call.purpose.replace(/^to\s+/i, 'to ')}.`;
    const res = await this.#api('POST', '/v1/convai/twilio/outbound-call', {
      agent_id: this.agentId,
      agent_phone_number_id: this.numberId,
      to_number: call.number,
      conversation_initiation_client_data: {
        conversation_config_override: { agent: { first_message: first, prompt: { prompt: this.#fullPrompt(task) } } },
        dynamic_variables: { call_purpose: call.purpose, call_to: call.name },
      },
    });
    if (!res.success || !res.conversation_id) throw new Error(res.message || 'the call didn\'t start');
    const rec = { ...call, id: res.conversation_id, status: 'initiated', at: Date.now() };
    const old = call.id && this.calls.find((c) => c.id === call.id);
    if (old) Object.assign(old, rec); else this.calls.push(rec);
    this.#saveLog();
    this.#processed(rec.id); // the result is delivered by #watch, not by the inbound poll
    this.log('call started', { id: rec.id, to: last10(rec.number).slice(-4) });
    this.emit('change');
    this.#watch(rec.id);
    return `Calling ${call.name} now (${say(call.number)}). I'll tell you how it went when the call ends.`;
  }

  #runScheduled() {
    const now = Date.now();
    for (const c of this.calls.filter((x) => x.status === 'scheduled' && x.at <= now)) {
      if (now - c.at > 15 * 60_000) {
        c.status = 'missed';
        this.#saveLog();
        this.emit('result', { call: c, line: `I didn't make the call to ${c.name} at ${clock(new Date(c.at))}: the Mac was asleep. Want me to call now?` });
        continue;
      }
      c.status = 'dialing';
      this.#dial(c).catch((err) => {
        c.status = 'failed'; c.error = err.message; this.#saveLog();
        this.emit('result', { call: c, line: `The scheduled call to ${c.name} didn't go through: ${err.message}.` });
      });
    }
  }

  cancelScheduled(who) {
    const q = String(who || '').toLowerCase();
    const hits = this.calls.filter((c) => c.status === 'scheduled' && (!q || c.name.toLowerCase().includes(q) || c.id === who));
    for (const c of hits) c.status = 'cancelled';
    this.#saveLog();
    return hits.length ? `Cancelled the scheduled call${hits.length > 1 ? 's' : ''} to ${hits.map((c) => c.name).join(', ')}.` : 'No matching scheduled call.';
  }

  // ---- Results (2): follow a call ARES placed until it ends -----------------------------------------
  #watch(id, started = Date.now()) {
    clearTimeout(this.live.get(id));
    const tick = async () => {
      const rec = this.calls.find((c) => c.id === id);
      try {
        const conv = await this.#api('GET', `/v1/convai/conversations/${id}`);
        this.talk.set(id, (conv.transcript || []).filter((t) => t.message).map((t) => ({ role: t.role, text: t.message })).slice(-60));
        if (rec && rec.status !== conv.status) { rec.status = conv.status; this.#saveLog(); this.emit('change'); }
        if (FINAL.has(conv.status)) { this.live.delete(id); this.emit('live', this.live.size); return this.#finishOutbound(id, conv); }
      } catch (err) { this.log('call poll failed', { id, error: err.message }); }
      if (Date.now() - started > (MAX_SECS + 600) * 1000) { // gave up waiting: say so rather than stay silent
        this.live.delete(id);
        this.emit('live', this.live.size);
        if (rec) { rec.status = 'unknown'; this.#saveLog(); this.emit('result', { call: rec, line: `I lost track of the call to ${rec.name}; the log on ElevenLabs will have it.` }); }
        return;
      }
      this.live.set(id, setTimeout(tick, LIVE_POLL_MS));
    };
    this.live.set(id, setTimeout(tick, LIVE_POLL_MS));
    this.emit('live', this.live.size);
  }

  async #finishOutbound(id, conv) {
    const rec = this.calls.find((c) => c.id === id) || { id, direction: 'outbound', name: 'them' };
    Object.assign(rec, this.#fromConversation(conv));
    this.#saveTranscript(id, conv);
    const talk = this.#transcriptText(conv);
    const reached = (conv.transcript || []).some((t) => t.role === 'user' && t.message?.trim());
    let line;
    if (conv.status === 'failed' || !reached) {
      line = conv.status === 'failed'
        ? `The call to ${rec.name} didn't connect${conv.metadata?.termination_reason ? ` (${conv.metadata.termination_reason.toLowerCase()})` : ''}.`
        : `No one picked up at ${rec.name}${/voicemail/i.test(talk) ? ', so I left a voicemail' : ''}.`;
    } else {
      try {
        line = (await this.phrase(
          `You are ARES, ${OWNER}'s assistant. You just phoned ${rec.name} for him. Goal: ${rec.purpose}.\n\nTranscript:\n${talk.slice(0, 12000)}\n\n` +
          `Tell ${OWNER} how it went in one or two short spoken sentences, like a friend reporting back ("Booked for 8, they'll hold it 15 minutes."). ` +
          'Lead with the result; include the key details (times, prices, names, reference numbers) and anything he needs to decide or do. ' +
          'If it didn\'t work, say why. Plain text only, no quotes, no markdown.')).trim();
      } catch (err) { this.log('call phrase failed', err.message); }
      line ||= rec.outcome || rec.summary || `The call to ${rec.name} is done.`;
    }
    rec.result = line;
    rec.notified = true;
    this.#saveLog();
    this.log('call finished', { id, status: rec.status, secs: rec.secs });
    this.emit('change');
    this.emit('result', { call: rec, line });
  }

  // ---- Inbound (3) and catch-up (4b) ---------------------------------------------------------------
  #processed(id) {
    if (this.state.processed.includes(id)) return true;
    this.state.processed.push(id);
    if (this.state.processed.length > 400) this.state.processed.splice(0, this.state.processed.length - 400);
    this.#saveState();
    return false;
  }

  /** New finished calls on the line since last time, oldest first, with full details. */
  async #newCalls() {
    const { conversations = [] } = await this.#api('GET', `/v1/convai/conversations?agent_id=${this.agentId}&page_size=30`);
    const fresh = conversations.filter((c) => !this.state.processed.includes(c.conversation_id)).reverse();
    this.inProgress = fresh.some((c) => !FINAL.has(c.status));
    const out = [];
    for (const c of fresh) {
      if (!FINAL.has(c.status)) continue; // still talking, or the analysis isn't ready yet: next poll
      if (this.live.has(c.conversation_id)) continue; // one of ours, followed by #watch
      const conv = await this.#api('GET', `/v1/convai/conversations/${c.conversation_id}`);
      this.#saveTranscript(c.conversation_id, conv);
      const rec = { id: c.conversation_id, ...this.#fromConversation(conv) };
      const old = this.calls.find((x) => x.id === rec.id);
      if (old) Object.assign(old, rec); else this.calls.push(rec);
      this.#processed(rec.id);
      out.push(old || rec);
    }
    if (out.length) {
      // Calls the cloud relay already pushed to the phone (with the Mac asleep, or just faster): don't push them twice
      const pushed = new Set(await this.delivered(out.filter((c) => c.direction === 'inbound').map((c) => c.id)));
      for (const c of out) if (pushed.has(c.id)) c.pushed = true;
      this.#saveLog();
      this.emit('change');
    }
    return out;
  }

  /** Every 45s while the Mac is on: each new call gets its own notification. */
  async poll() {
    if (!this.ready || !this.state || this.polling) return;
    this.polling = true;
    try {
      const calls = await this.#newCalls();
      for (const c of calls) this.#announce(c);
      // A call is going on right now: look again sooner than usual
      if (this.inProgress) { clearTimeout(this.soon); this.soon = setTimeout(() => this.poll().catch(() => {}), 10_000); }
    } finally { this.polling = false; }
  }

  /** ARES started, or the Mac woke up: everything since the last processed call, in ONE digest. */
  async catchUp(why) {
    if (!this.ready || !this.state || this.polling) return;
    this.polling = true;
    try {
      const calls = (await this.#newCalls()).filter((c) => !c.notified);
      this.log('calls catch-up', { why, calls: calls.length });
      if (calls.length === 1) this.#announce(calls[0]);
      else if (calls.length > 1) this.#digest(calls);
    } catch (err) { this.log('calls catch-up failed', err.message); } finally { this.polling = false; }
  }

  #who(c) {
    if (c.direction === 'outbound') return c.name || this.contactByNumber(c.number) || (c.number ? say(c.number) : 'someone');
    return this.contactByNumber(c.number) || c.caller || (c.number ? say(c.number) : 'someone');
  }

  #callback(c) {
    const cb = e164(c.callback) || (/this number|same/i.test(c.callback || '') || !c.callback ? e164(c.number) : null);
    return cb;
  }

  #announce(c) {
    if (c.direction === 'outbound') { c.notified = true; this.#saveLog(); return; } // reported by #finishOutbound
    const who = this.#who(c);
    const cb = this.#callback(c);
    const what = c.message || c.summary || c.topic || 'no message';
    const body = `${what}${cb ? ` Callback: ${say(cb)}.` : ''}`;
    const title = c.spam ? `Spam call from ${who}` : `${c.urgent ? 'URGENT: ' : ''}Call from ${who}${c.topic ? ` about ${c.topic}` : ''}`;
    const line = c.spam ? null : `${c.urgent ? 'Urgent one, sir: ' : ''}${who} called${c.topic ? ` about ${c.topic}` : ''}. ${c.message || ''}`.trim();
    c.notified = true;
    this.#saveLog();
    this.emit('inbound', { call: c, title, body, line, urgent: c.urgent, callback: cb, pushed: Boolean(c.pushed) });
  }

  #digest(calls) {
    const spam = calls.filter((c) => c.spam);
    const real = calls.filter((c) => !c.spam).sort((a, b) => Number(b.urgent) - Number(a.urgent));
    const bits = real.map((c) => `${c.urgent ? 'URGENT: ' : ''}${this.#who(c)}${c.topic ? ` about ${c.topic}` : ''}`);
    if (spam.length) bits.push(spam.length === 1 ? 'one spam' : `${spam.length} spam`);
    const line = `While you were away: ${calls.length} calls: ${bits.join(', ')}.`;
    for (const c of calls) c.notified = true;
    this.#saveLog();
    const urgent = real.find((c) => c.urgent);
    this.emit('digest', { calls, pushed: calls.every((c) => c.pushed), title: `While you were away: ${calls.length} calls`, body: bits.join('\n'), line, urgent, callback: urgent && this.#callback(urgent) });
  }

  // ---- Reading conversations -----------------------------------------------------------------------------
  #fromConversation(conv) {
    const dc = conv.analysis?.data_collection_results || {};
    const v = (k) => { const x = dc[k]?.value; return x === null || x === undefined ? '' : x; };
    const pc = conv.metadata?.phone_call || {};
    return {
      direction: pc.direction || 'inbound',
      number: pc.external_number || conv.conversation_initiation_client_data?.dynamic_variables?.system__caller_id || '',
      at: (conv.metadata?.start_time_unix_secs || Date.now() / 1000) * 1000,
      secs: conv.metadata?.call_duration_secs || 0,
      status: conv.status,
      ended: conv.metadata?.termination_reason || '',
      title: conv.analysis?.call_summary_title || '',
      summary: conv.analysis?.transcript_summary || '',
      caller: String(v('caller_name')),
      callback: String(v('callback_number')),
      topic: String(v('topic') || (conv.analysis?.call_summary_title || '').toLowerCase()),
      message: String(v('message')),
      outcome: String(v('outcome')),
      urgent: v('urgent') === true || v('urgent') === 'true',
      spam: v('spam') === true || v('spam') === 'true',
    };
  }

  #transcriptText(conv) {
    return (conv.transcript || []).filter((t) => t.message).map((t) => `${t.role === 'agent' ? 'ARES' : 'Them'}: ${t.message}`).join('\n');
  }

  #saveTranscript(id, conv) {
    const keep = { id, status: conv.status, metadata: { start: conv.metadata?.start_time_unix_secs, secs: conv.metadata?.call_duration_secs, ended: conv.metadata?.termination_reason, phone: conv.metadata?.phone_call },
      analysis: conv.analysis && { summary: conv.analysis.transcript_summary, title: conv.analysis.call_summary_title, data: conv.analysis.data_collection_results },
      transcript: (conv.transcript || []).filter((t) => t.message).map((t) => ({ role: t.role, t: t.time_in_call_secs, text: t.message })) };
    try { fs.writeFileSync(path.join(this.dir, 'transcripts', `${id.replace(/[^\w-]/g, '')}.json`), JSON.stringify(keep, null, 1), { mode: 0o600 }); } catch {}
  }

  // ---- For the dashboard: a call's details and transcript -----------------------------------------------------
  /** Who, the numbers, the result, and the transcript (live while the call is on, saved once it's over). */
  details(id) {
    const c = this.calls.find((x) => x.id === id);
    let lines = this.talk.get(id) || null;
    let summary = '';
    if (!lines) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.dir, 'transcripts', `${String(id).replace(/[^\w-]/g, '')}.json`), 'utf8'));
        lines = saved.transcript.map((t) => ({ role: t.role, text: t.text }));
        summary = saved.analysis?.summary || '';
      } catch { lines = []; }
    }
    if (!c && !lines.length) return null;
    const callback = c ? e164(c.callback) || (/this number|same/i.test(c.callback || '') || !c.callback ? e164(c.number) : null) : null;
    return {
      id, name: c ? this.#who(c) : 'Call', direction: c?.direction || '', live: this.live.has(id),
      number: c?.number || '', callback: callback || '', at: c?.at || 0, secs: c?.secs || 0,
      result: c?.result || c?.outcome || c?.message || '', summary: summary || c?.summary || '',
      transcript: lines.map((t) => ({ who: t.role === 'agent' ? 'ARES' : c ? this.#who(c) : 'Caller', text: t.text })),
    };
  }
  /** The transcript as a readable text file next to the JSON one, for "Open transcript". */
  transcriptFile(id) {
    const d = this.details(id);
    if (!d) return null;
    const file = path.join(this.dir, 'transcripts', `${String(id).replace(/[^\w-]/g, '')}.txt`);
    const head = `${d.direction === 'inbound' ? 'Call from' : 'Call to'} ${d.name}${d.at ? `, ${new Date(d.at).toLocaleString()}` : ''}\n${d.result ? `\n${d.result}\n` : ''}\n`;
    fs.writeFileSync(file, head + d.transcript.map((t) => `${t.who}: ${t.text}`).join('\n\n') + '\n', { mode: 0o600 });
    return file;
  }

  // ---- For the brain: list_calls / call_status -------------------------------------------------------------
  #line(c) {
    const when = new Date(c.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const who = this.#who(c);
    if (c.direction === 'outbound') {
      const st = c.status === 'scheduled' ? 'scheduled' : FINAL.has(c.status) ? '' : c.status;
      return `[${c.id}] ${when}: ARES called ${who} (${c.purpose || c.title})${st ? ` [${st}]` : ''}${c.result ? `: ${c.result}` : ''}`;
    }
    const cb = this.#callback(c);
    return `[${c.id}] ${when}: ${who} called${c.number ? ` from ${say(c.number)}` : ''}${c.topic ? ` about ${c.topic}` : ''}${c.urgent ? ' (URGENT)' : ''}${c.spam ? ' (spam)' : ''}: ${c.message || c.summary || c.title || 'no message'}${cb ? ` Callback: ${say(cb)}` : ''}`;
  }

  // ---- For the phone app (phone.js /api/calls) ----------------------------------------------------------
  #view(c) {
    return { id: c.id, direction: c.direction, who: this.#who(c), number: c.number || '', at: c.at, secs: c.secs || 0, status: c.status,
      topic: c.topic || '', message: c.message || '', summary: c.summary || '', purpose: c.purpose || '', result: c.result || '',
      urgent: Boolean(c.urgent), spam: Boolean(c.spam), callback: this.#callback(c) || '', error: c.error || '' };
  }

  views() { return this.calls.slice(-100).reverse().map((c) => this.#view(c)); }

  detail(id) {
    const c = this.calls.find((x) => x.id === id);
    if (!c) return null;
    let transcript = [];
    try { transcript = JSON.parse(fs.readFileSync(path.join(this.dir, 'transcripts', `${c.id.replace(/[^\w-]/g, '')}.json`), 'utf8')).transcript; } catch {}
    return { ...this.#view(c), brief: c.brief || '', transcript };
  }

  messages() { return this.state ? this.#activeMessages().map(({ for: who, message, until }) => ({ for: who, message, until })) : []; }

  list({ direction, limit = 10, query } = {}) {
    let rows = this.calls.slice().reverse();
    if (direction) rows = rows.filter((c) => c.direction === direction);
    if (query) {
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const dq = last10(query);
      rows = rows.filter((c) => {
        const hay = `${this.#who(c)} ${c.caller} ${c.name} ${c.topic} ${c.title} ${c.summary} ${c.message} ${c.purpose} ${c.result}`.toLowerCase();
        return (dq.length >= 7 && last10(c.number || '').endsWith(dq)) || words.every((w) => hay.includes(w));
      });
    }
    rows = rows.slice(0, Math.min(30, limit));
    if (!rows.length) return query ? `No calls matching "${query}" in the log.` : 'No calls in the log yet.';
    const live = this.calls.filter((c) => c.direction === 'outbound' && !FINAL.has(c.status) && !['scheduled', 'missed', 'cancelled', 'unknown'].includes(c.status));
    return `${live.length ? `In progress: ${live.map((c) => c.name).join(', ')}.\n` : ''}${rows.map((c) => this.#line(c)).join('\n')}`;
  }

  status({ call } = {}) {
    const q = String(call || '').trim();
    let c = !q || q === 'last' ? this.calls[this.calls.length - 1] : this.calls.find((x) => x.id === q);
    if (!c && q) {
      const lower = q.toLowerCase();
      c = this.calls.slice().reverse().find((x) => `${this.#who(x)} ${x.caller} ${x.name} ${x.topic} ${x.purpose}`.toLowerCase().includes(lower)
        || (last10(q).length >= 7 && last10(x.number || '').endsWith(last10(q))));
    }
    if (!c) return `No call matching "${q}".`;
    let text = this.#line(c);
    if (c.direction === 'outbound' && c.brief) text += `\nBrief: ${c.brief}`;
    if (c.secs) text += `\nLength: ${Math.round(c.secs / 6) / 10} min`;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(this.dir, 'transcripts', `${c.id.replace(/[^\w-]/g, '')}.json`), 'utf8'));
      const talk = t.transcript.map((x) => `${x.role === 'agent' ? 'ARES' : 'Them'}: ${x.text}`).join('\n');
      if (talk) text += `\nTranscript:\n${talk.slice(0, 4000)}`;
    } catch {}
    return text;
  }
}

module.exports = { Calls, e164, forbidden };
