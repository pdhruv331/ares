// ARES's own MCP server: Mac controls, timers, and the permission gate for everything else.
// Spawned by Claude Code (via ELECTRON_RUN_AS_NODE); talks back to the ARES app over a
// localhost bridge (ARES_BRIDGE + ARES_TOKEN) for timers and action confirmations.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { execFile } = require('child_process');

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
});
const osa = (script) => run('/usr/bin/osascript', ['-e', script]);
const asString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string literal

async function bridge(path, body) {
  const res = await fetch(`${process.env.ARES_BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ARES_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ARES bridge ${res.status}`);
  return res.json();
}

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (err) => ({ content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true });
// A tool returns a string, or { message, image: { data (base64), mimeType } } when there's a picture for the brain to look at
const tool = (name, description, inputSchema, fn) => server.registerTool(name, { description, inputSchema }, async (args) => {
  try {
    const r = await fn(args);
    if (r && typeof r === 'object') return { content: [{ type: 'text', text: r.message || '' }, ...(r.image ? [{ type: 'image', data: r.image.data, mimeType: r.image.mimeType }] : [])] };
    return ok(r);
  } catch (err) { return fail(err); }
});

const server = new McpServer({ name: 'ares', version: '1.0.0' });

// ---- Apps -------------------------------------------------------------------------
tool('open_app', 'Open (or bring to the front) a Mac application by name, e.g. "Safari", "Spotify", "Notes".',
  { name: z.string() },
  async ({ name }) => { await run('/usr/bin/open', ['-a', name]); return `Opened ${name}.`; });

tool('quit_app', 'Quit a running Mac application by name.',
  { name: z.string() },
  async ({ name }) => { await osa(`tell application ${asString(name)} to quit`); return `Quit ${name}.`; });

tool('open_url', "Open a web page in the user's default browser (http or https links only).",
  { url: z.string() },
  async ({ url }) => {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) links can be opened');
    await run('/usr/bin/open', [u.href]);
    return `Opened ${u.hostname} in the browser.`;
  });

// ---- Sound & media ------------------------------------------------------------------
tool('set_volume', 'Set the Mac output volume (0-100), or mute/unmute.',
  { level: z.number().min(0).max(100).optional(), muted: z.boolean().optional() },
  async ({ level, muted }) => {
    if (level !== undefined) await osa(`set volume output volume ${Math.round(level)}`);
    if (muted !== undefined) await osa(`set volume output muted ${muted}`);
    return `Volume ${await osa('output volume of (get volume settings)')}${muted ? ' (muted)' : ''}.`;
  });

tool('media_control', 'Control music playback in Spotify or Apple Music: play, pause, next, previous, or now_playing.',
  { action: z.enum(['play', 'pause', 'next', 'previous', 'now_playing']), app: z.enum(['Spotify', 'Music']).optional() },
  async ({ action, app }) => {
    const running = await osa('tell application "System Events" to get name of every process whose background only is false');
    const target = app || (running.includes('Spotify') ? 'Spotify' : 'Music');
    if (action === 'now_playing') {
      return osa(`tell application ${asString(target)} to if player state is playing then return (name of current track) & " by " & (artist of current track) else return "Nothing playing"`);
    }
    const verb = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' }[action];
    await osa(`tell application ${asString(target)} to ${verb}`);
    return `${target}: ${action}.`;
  });

// ---- Timers (handled by the ARES app so she can announce them) -------------------------
tool('set_timer', 'Start a timer. ARES announces it out loud when it finishes.',
  { seconds: z.number().positive(), label: z.string().optional() },
  async ({ seconds, label }) => (await bridge('/timer', { seconds, label })).message);

tool('list_timers', 'List running timers.', {}, async () => (await bridge('/timers', {})).message);

// ---- Claude plan limits ---------------------------------------------------------------
tool('claude_usage', "How much of the user's Claude subscription limits is used and left: the 5-hour window and the weekly window, "
  + 'with reset times. Says whether each number is exact (reported by Claude Code) or an estimate. Use for "how much of my Claude limit is left?".',
  {}, async () => (await bridge('/claude-usage', {})).message);

// ---- The user's Claude Code sessions ---------------------------------------------------------
tool('claude_sessions', "The user's Claude Code sessions (in the Claude app, the terminal, or run by ARES): with no session, a list of "
  + 'recent ones and what each is doing (working, needs permission, waiting, finished, errored, and where it is open). With a session '
  + '(its name, folder, words from it, or id), a short summary of what it did, where it is now and what it is waiting on. '
  + 'Use for "what are my Claude sessions doing?" and "how\'s the wallpaper session going?". ARES jobs are marked [ARES job].',
  { session: z.string().optional() },
  async ({ session }) => (await bridge('/claude/sessions', { session })).message);

tool('claude_session_reply', "Send the user's message to one of their Claude Code sessions (\"tell the GUI session to also fix the subtitle bug\"). "
  + 'ARES-run sessions get it as a follow-up; the user\'s closed sessions are continued in place in the background. A session open in the Claude app '
  + 'or a terminal is never written to: the result says so, and you can offer a copy instead (fork: true, only after the user says yes).',
  { session: z.string().describe('the session: its name, folder, words from it, or id'), message: z.string(), fork: z.boolean().optional() },
  async (args) => (await bridge('/claude/reply', args)).message);

tool('claude_session_start', 'Start a new Claude Code session in one of the user\'s project folders to do a task ("start a Claude session in my portfolio '
  + 'folder to update the projects page"). Runs in the background by default, with risky steps waiting for their OK and a push when done. '
  + 'on_phone: true when they want to drive it from their phone (Claude Code Remote Control: it opens in the Claude app). '
  + 'ares_repo: true ONLY when they explicitly ask to work on ARES itself (its own code); it then runs on a new git branch.',
  { folder: z.string().describe('a path, or the folder\'s name as they said it'), task: z.string(), title: z.string().optional(), on_phone: z.boolean().optional(), ares_repo: z.boolean().optional() },
  async ({ folder, task, title, on_phone, ares_repo }) => (await bridge('/claude/start', { folder, task, title, onPhone: on_phone, aresRepo: ares_repo })).message);

tool('claude_session_to_phone', 'Put an existing Claude Code session on the user\'s phone (Remote Control, in the Claude app): a closed one, or one ARES ran. '
  + 'Sessions open in the Claude app on the Mac need Remote Control switched on there instead; the result says so.',
  { session: z.string() }, async (args) => (await bridge('/claude/phone', args)).message);

tool('claude_session_open', 'Open a Claude Code session on the Mac in Terminal, resumed in its folder ("open it in Claude Code"), so the user can take over.',
  { session: z.string() }, async (args) => (await bridge('/claude/open', args)).message);

tool('claude_session_stop', 'Stop what ARES is running for a Claude session (pause it; a later reply picks it up), or end a Remote Control session ARES started.',
  { session: z.string() }, async (args) => (await bridge('/claude/stop', args)).message);

tool('cancel_timer', 'Cancel a running timer by its label (or all timers).',
  { label: z.string().optional() },
  async ({ label }) => (await bridge('/timer/cancel', { label })).message);

// ---- Reminders & Notes ---------------------------------------------------------------
tool('create_reminder', 'Add a reminder to the Reminders app, optionally with a due date/time (ISO 8601, local time).',
  { title: z.string(), due: z.string().optional(), list: z.string().optional() },
  async ({ title, due, list }) => {
    const props = [`name:${asString(title)}`];
    let prelude = '';
    if (due) {
      const d = new Date(due);
      if (isNaN(d)) throw new Error(`couldn't understand the date "${due}"`);
      prelude = `set dueDate to current date
        set year of dueDate to ${d.getFullYear()}
        set month of dueDate to ${d.getMonth() + 1}
        set day of dueDate to ${d.getDate()}
        set time of dueDate to ${d.getHours() * 3600 + d.getMinutes() * 60}
        `;
      props.push('due date:dueDate', 'remind me date:dueDate');
    }
    const target = list ? `list ${asString(list)}` : 'default list';
    await osa(`${prelude}tell application "Reminders" to make new reminder at end of ${target} with properties {${props.join(', ')}}`);
    return `Reminder added: ${title}${due ? ` (due ${new Date(due).toLocaleString()})` : ''}.`;
  });

tool('create_note', 'Create a note in the Notes app.',
  { title: z.string(), body: z.string() },
  async ({ title, body }) => {
    const html = `<h1>${title}</h1><p>${body.replace(/\n/g, '<br>')}</p>`;
    await osa(`tell application "Notes" to make new note with properties {body:${asString(html)}}`);
    return `Note created: ${title}.`;
  });

// ---- System ------------------------------------------------------------------------------
tool('lock_screen', 'Put the display to sleep, which locks the Mac.', {},
  async () => { await run('/usr/bin/pmset', ['displaysleepnow']); return 'Screen locked.'; });

tool('battery_status', 'Battery level and charging state.', {},
  async () => (await run('/usr/bin/pmset', ['-g', 'batt'])).split('\n').slice(1).join(' ').replace(/\s+/g, ' '));

// ---- Contacts (imported address book, kept on the Mac) -------------------------------------------------
tool('find_contact',
  "Look someone up in the user's contacts by name, nickname, relationship (e.g. \"mum\") or company. Returns phone " +
  'numbers and emails. Use it before calling, texting, WhatsApping or emailing someone by name. If several match, ask which.',
  { name: z.string() },
  async ({ name }) => (await bridge('/contacts/find', { name })).message);

// ---- Long-term memory (memory.md on the Mac) ---------------------------------------------------------
tool('remember',
  'Save a fact about the user to your long-term memory, so you know it in future conversations: people in their life, ' +
  'preferences, routines, plans with dates, how they like things done. One short third-person sentence, e.g. ' +
  '"The user\'s sister is called Priya." Don\'t save passwords, codes or card numbers.',
  { fact: z.string() },
  async ({ fact }) => (await bridge('/memory/remember', { fact })).message);

tool('recall_memory', 'Read everything currently in your long-term memory about the user.',
  {},
  async () => (await bridge('/memory/recall', {})).message);

tool('forget', 'Remove facts from your long-term memory when the user asks you to forget something. ' +
  'Give a few key words; every fact containing all of them is removed.',
  { about: z.string() },
  async ({ about }) => (await bridge('/memory/forget', { about })).message);

// ---- The user's own phrasing (intent.js) -----------------------------------------------------------
tool('teach_phrase',
  'Learn how the user phrases a short remark, so the ARES app understands it instantly next time. Use it when ' +
  'they correct how you took one ("no, I meant carry on", "when I say righto I mean thanks"), or when an ' +
  'ARES note says you treated a remark as something it wasn\'t. phrase: their exact words (short). meaning: ' +
  'stop (be quiet now), continue (carry on / just listening), yes, no, thanks (thanks or acknowledgement), ' +
  'repeat (say that again), nevermind (drop it), sleep (done for now, wait for your name), or chat (not a ' +
  'command, just talking).',
  { phrase: z.string(), meaning: z.enum(['stop', 'continue', 'yes', 'no', 'thanks', 'repeat', 'nevermind', 'sleep', 'chat']) },
  async ({ phrase, meaning }) => (await bridge('/intent/teach', { phrase, meaning })).message);

// ---- Phone (the ARES phone app) -------------------------------------------------------------------
tool('phone_action',
  "Do something on the user's PHONE instead of the Mac: open a web page, call or text someone, open WhatsApp, " +
  'start directions, compose an email, or search Spotify/YouTube. Use it whenever the user is on their phone and asks ' +
  'to open, call, text, message, navigate or play something. It opens on the phone straight away (or as a tap-to-open ' +
  'card). You don\'t know phone numbers unless the user gives one; without a number, call/text open the dialer or ' +
  'composer for them to pick the contact.',
  {
    kind: z.enum(['open_url', 'call', 'text', 'whatsapp', 'directions', 'map', 'email', 'spotify', 'youtube']),
    target: z.string().optional().describe('URL, phone number, place/address, email address or search query'),
    message: z.string().optional().describe('Pre-filled text for text/whatsapp/email'),
    subject: z.string().optional().describe('Email subject'),
    label: z.string().optional().describe('Short button label, e.g. "Directions to Heathrow"'),
  },
  async (args) => (await bridge('/phone-action', args)).message);

tool('notify_phone',
  "Send a notification to the user's phone (it arrives even when the app is closed). Optional buttons can open a link " +
  'or ask you something when tapped (e.g. "Snooze 10 min" -> ask "set a 10 minute timer").',
  {
    title: z.string(),
    body: z.string(),
    buttons: z.array(z.object({ title: z.string(), url: z.string().optional(), ask: z.string().optional() })).max(2).optional(),
  },
  async (args) => (await bridge('/notify', args)).message);

// ---- Real phone calls (the ARES phone line, calls.js) -------------------------------------------------
tool('make_call',
  'Phone someone on the user\'s behalf from the ARES phone line: an AI voice agent calls, handles the conversation, and ' +
  'you get the result afterwards (booking a table, confirming an appointment, asking opening hours, passing on a message). ' +
  'Before calling, tell the user in ONE short sentence who (name and number), what you\'ll say or ask, and when, and ask ' +
  'them to confirm; only call once they say yes. Get the number with find_contact, or ask the user. For "call me" or ' +
  '"my mobile", use the user\'s own number from memory, or ask. Only calls the user asked for: never marketing, cold or ' +
  'unsolicited calls. The agent only knows what you put in the brief, so make it complete but share nothing private beyond ' +
  'what the task needs.',
  {
    to: z.string().describe('Phone number with country code, e.g. +15551234567 (US numbers can be 10 digits)'),
    name: z.string().describe('Who is being called, e.g. "Luigi\'s" or "Dr Patel\'s office"'),
    purpose: z.string().describe('Short phrase said at the start of the call, e.g. "to book a table for four at 8 tonight"'),
    brief: z.string().describe('Everything the agent needs: the task, details (names for bookings, dates, times), acceptable alternatives, what not to agree to'),
    at: z.string().optional().describe('ISO local date-time to call later instead of now (up to a week ahead)'),
    language: z.enum(['en', 'hi']).optional(),
  },
  async (args) => (await bridge('/calls/make', args)).message);

tool('list_calls',
  'The phone line\'s call log: who called, what about, callback numbers, and the calls you placed with their results. ' +
  'Use it for "did the dentist call back?", "any calls?", "who called this morning?". query filters by name, topic or number.',
  { query: z.string().optional(), direction: z.enum(['inbound', 'outbound']).optional(), limit: z.number().optional() },
  async (args) => (await bridge('/calls/list', args)).message);

tool('call_status',
  'Details of one call: whether a call you placed is still going, its result, and the transcript. call: an id from ' +
  'list_calls, a name, a number, or "last".',
  { call: z.string().optional() },
  async (args) => (await bridge('/calls/status', args)).message);

tool('cancel_scheduled_call', 'Cancel a call you scheduled for later (by name, or all if omitted).',
  { call: z.string().optional() },
  async (args) => (await bridge('/calls/cancel', args)).message);

tool('leave_call_message',
  'Leave a message for a specific caller with the phone line: "if Sam calls, tell him I\'ll be late". The agent only ' +
  'tells that person. Callers can\'t be verified, so never put anything private in it. Lasts until the end of today unless hours is given.',
  { for: z.string().describe('Who it\'s for, e.g. "Sam" or "the plumber"'), message: z.string(), hours: z.number().optional() },
  async (args) => (await bridge('/calls/message', args)).message);

tool('remove_call_message', 'Take back a message left with the phone line (by who it was for, or all if omitted).',
  { for: z.string().optional() },
  async (args) => (await bridge('/calls/unmessage', args)).message);

// ---- Work mode: background jobs run by a full-strength worker (jobs.js) ------------------------------
tool('start_job',
  'Hand a real job to a background worker (a full-strength Claude with web research and files), so you stay free ' +
  'to chat: researching something properly, writing or drafting a document, analysing, comparing options in depth, ' +
  'planning, making a report or slides. The worker can\'t ask questions, so the brief must be complete and ' +
  'self-contained: the goal, every relevant detail from the conversation and your memory, preferences, and the ' +
  'format wanted. The app tells the user when it\'s done.',
  {
    title: z.string().describe('Short name for the job, 2-5 words, e.g. "Laptop comparison"'),
    task: z.string().describe('The complete brief for the worker'),
    size: z.enum(['small', 'medium', 'large']).optional().describe('Rough size of the job'),
  },
  async (args) => (await bridge('/work/start', args)).message);

tool('list_jobs', 'What background jobs are running, queued, waiting for the user, or recently finished.', {},
  async () => (await bridge('/work/list', {})).message);

tool('show_job',
  'Open a job\'s results ("show me the research", "pull up the battery report"), or the gallery of all past work ' +
  '(job: "gallery"). They open on the device the user is using; where: "mac" opens them on the Mac instead ' +
  '("open it on my Mac": right away if they\'re at it, otherwise as soon as they\'re back).',
  {
    job: z.string().describe('The job\'s id, a word from its title, or "gallery"'),
    where: z.enum(['mac', 'phone']).optional().describe('Only when the user names a device'),
  },
  async (args) => (await bridge('/work/show', args)).message);

tool('send_job_to_phone',
  'Send a job\'s results to the user\'s phone ("send this to my phone"): a notification with an Open button.',
  { job: z.string().describe('The job\'s id or a word from its title') },
  async (args) => (await bridge('/work/send-phone', args)).message);

tool('cancel_job', 'Stop a background job.',
  { job: z.string().describe('The job\'s id or a word from its title') },
  async (args) => (await bridge('/work/cancel', args)).message);

tool('continue_job',
  'Send a follow-up to a finished job, which the same worker picks up with full context ("make the intro shorter", ' +
  '"add pricing", "turn it into slides").',
  { job: z.string().describe('The job\'s id or a word from its title'), instruction: z.string() },
  async (args) => (await bridge('/work/continue', args)).message);

tool('answer_job_approval',
  'Pass on the user\'s yes or no when a background job is waiting for their OK (to send, delete or change something). ' +
  'Only approve when their own latest words are a clear yes.',
  { job: z.string().optional().describe('The job\'s id or a word from its title (default: the one waiting)'), approve: z.boolean() },
  async (args) => (await bridge('/work/answer', args)).message);

// ---- Full Mac control: files, windows, browser, screen, UI automation, system, clipboard, Shortcuts, send to phone ----
require('./control-tools').register({ tool, bridge });
// ---- Panels v2: the calendar through macOS (EventKit), tasks, custom panels --------------------------------------------
require('./panel-tools').register({ tool, bridge });
// ---- Autonomy: projects, goals, routines, the kill switch ---------------------------------------------------------
require('./autonomy-tools').register({ tool, bridge });

// ---- Permission gate -------------------------------------------------------------------------
// Claude Code asks this tool before running anything not pre-approved (calendar changes, email
// sends, deletions...). The ARES app decides: read-only actions pass; anything that acts in the
// world needs the user's latest words to be an explicit "yes".
server.registerTool('approve', {
  description: 'Internal: permission check used by ARES. Do not call directly.',
  inputSchema: { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() },
}, async ({ tool_name, input }) => {
  let decision;
  try {
    decision = await bridge('/approve', { tool: tool_name, input });
  } catch (err) {
    decision = { allow: false, message: `Couldn't reach ARES to confirm (${err.message}).` };
  }
  const result = decision.allow
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: decision.message };
  return ok(JSON.stringify(result));
});

server.connect(new StdioServerTransport());
