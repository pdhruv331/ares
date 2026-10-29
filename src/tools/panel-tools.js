// Panels v2 for the brain (docs/panels-prompt.md): the calendar through macOS Calendar (EventKit, local and live),
// the tasks panel, and custom panels. Thin calls over the bridge to calendar.js / tasks.js / panels.js in the app,
// which hold the tiers (adds and moves: tier 2, deletes: tier 3) and the audit log. Registered by tools/mac.js.
const { z } = require('zod');

function register({ tool, bridge }) {
  const ctl = (name, args = {}) => bridge(`/control/${name}`, args);

  // ---- Calendar (EventKit first; the Google Calendar connector tools remain the fallback when it says so) ----------------
  tool('calendar_status', 'Where the calendar comes from: macOS Calendar through EventKit (live, local, free) or the Google Calendar connector, '
    + 'which calendars exist, and whether the Google account is in macOS Calendar (with the steps to add it if not).', {},
  async () => (await ctl('calendar/status', {})).message);

  tool('calendar_setup', 'Connect the calendar through macOS: brings up the Calendars permission prompt for "ARES Calendar" on the Mac. '
    + 'Use when calendar_status says access is not determined, or the user says "connect my calendar".', {},
  async () => (await ctl('calendar/setup', {})).message);

  tool('calendar_events', 'The user\'s events from macOS Calendar (every calendar), in a date range, optionally filtered by words of the title. '
    + 'Prefer this over the Google Calendar connector: it is instant and uses no Claude. Dates: "2026-10-07", "today", "tomorrow", "friday", "next monday".',
  { from: z.string().optional().describe('Start day (default today)'), to: z.string().optional().describe('End day (default a week later)'), query: z.string().optional().describe('Words of the title, e.g. "dentist"') },
  async (a) => (await ctl('calendar/list', a)).message);

  tool('calendar_add', 'Add an event to the calendar through macOS (instant; shows in the panel at once). Tier 2: just do it and tell the user. '
    + '"Block 2 hours of deep work tomorrow afternoon" → title "Deep work", start "tomorrow 14:00", end "tomorrow 16:00".',
  { title: z.string(), start: z.string().describe('"2026-10-07T16:00", "tomorrow 14:00", "friday 16:00"'), end: z.string().optional().describe('Default: one hour later'),
    all_day: z.boolean().optional(), location: z.string().optional(), notes: z.string().optional(), calendar: z.string().optional().describe('Calendar name, default the user\'s default calendar') },
  async (a) => (await ctl('calendar/add', a)).message);

  tool('calendar_move', 'Move an existing event (found by words of its title, and the day if there are several) to a new time. Tier 2. '
    + '"Move the dentist to Friday at 4" → title "dentist", start "friday 16:00".',
  { title: z.string(), date: z.string().optional().describe('The day it is on now, when the title alone is ambiguous'), start: z.string().describe('The new start'),
    end: z.string().optional(), duration_min: z.number().optional() },
  async (a) => (await ctl('calendar/move', a)).message);

  tool('calendar_delete', 'Delete an event (by words of its title, and the day when ambiguous). Always needs the user\'s yes first: the result says to ask; '
    + 'describe exactly which event will go and do it once they say yes.',
  { title: z.string(), date: z.string().optional() },
  async (a) => (await ctl('calendar/delete', a)).message);

  tool('calendar_show', 'Show the calendar panel on the Mac in a view: "show me my week" → view "week"; "what\'s on the 20th?" → view "month" with that date '
    + '(also answer from calendar_events); "what about next week?" → view "week", week_offset 1; "collapse it" → view "day".',
  { view: z.enum(['day', 'week', 'month']), date: z.string().optional().describe('A day to select in MONTH'), week_offset: z.number().int().optional() },
  async (a) => (await ctl('calendar/show', a)).message);

  // ---- Tasks (Google Tasks or Apple Reminders, tasks.js) --------------------------------------------------------------------
  tool('tasks_status', 'Where the tasks panel\'s tasks come from (Google Tasks or Apple Reminders), how many are open, and the one-time setup steps if nothing is connected.', {},
    async () => (await ctl('tasks/status', {})).message);
  tool('tasks_setup', 'Choose the task source: "reminders" (Apple Reminders through macOS, no setup; may bring up a Reminders permission prompt) or "google" '
    + '(Google Tasks: the steps come back for the user to do at the Mac). "Use Reminders for my tasks" → reminders.',
  { source: z.enum(['google', 'reminders']) }, async (a) => (await ctl('tasks/setup', a)).message);
  tool('tasks_list', 'The user\'s open tasks ("what\'s on my list?"), late first, then due today, then dated, then the rest.', {},
    async () => (await ctl('tasks/list', {})).message);
  tool('tasks_add', 'Add a task ("add buy milk to my tasks"). Tier 2: just do it and tell the user.',
    { title: z.string(), due: z.string().optional().describe('"tomorrow", "friday", "2026-10-09"'), notes: z.string().optional(), list: z.string().optional() },
    async (a) => (await ctl('tasks/add', a)).message);
  tool('tasks_complete', 'Tick a task off by words of its title ("tick off book flights"). Tier 2.', { title: z.string() },
    async (a) => (await ctl('tasks/complete', a)).message);
  tool('tasks_move', 'Change a task\'s due date ("move X to tomorrow"); an empty due removes the date. Tier 2.', { title: z.string(), due: z.string().optional() },
    async (a) => (await ctl('tasks/move', a)).message);

  // ---- Custom panels ("add a panel showing …", custom-panels.js) ----------------------------------------------------------------
  const sourceSchema = z.object({
    type: z.enum(['builtin', 'shortcut', 'shell', 'url', 'file', 'claude', 'static']),
    provider: z.enum(['calendar', 'tasks', 'weather', 'jobs', 'projects', 'claude-usage', 'now-playing']).optional().describe('builtin: ARES\'s own live data'),
    name: z.string().optional().describe('shortcut: the Shortcut\'s name'), input: z.string().optional(),
    command: z.string().optional().describe('shell: one command line; the user approves it the first time (tier 3)'),
    url: z.string().optional().describe('url: a JSON or RSS URL, GET only, no credentials, public hosts'), rss: z.boolean().optional(),
    path: z.string().optional().describe('file: a text/JSON file inside the user\'s folders'),
    prompt: z.string().optional().describe('claude: what to answer (a tool-less one-shot, at most every 30 min, pauses near the usage limits)'),
    value: z.any().optional().describe('static: the data itself; for a countdown { target: "YYYY-MM-DDTHH:MM", label }'),
    pick: z.string().optional().describe('A path into the JSON, e.g. "bitcoin.usd" or "items[0].title"'),
    unit: z.string().optional(), max: z.number().optional().describe('gauge: the full-scale value'),
  });
  const panelFields = {
    title: z.string().describe('Short, as the header: "BTC", "OPEN PRS", "FLIGHT"'),
    template: z.enum(['value', 'gauge', 'list', 'checklist', 'text', 'image', 'chart', 'countdown']),
    source: sourceSchema,
    kind: z.enum(['day', 'work', 'needs']).optional().describe('Colour: day (cyan, default), work (violet), needs (amber: time-critical)'),
    refresh: z.number().int().optional().describe('Seconds between refreshes (minimums apply per source; claude ≥ 1800)'),
    pinned: z.boolean().optional(),
  };
  tool('panel_preview', 'Create a custom panel from a spec and show it as a dashed PREVIEW with real data; nothing is saved until panel_keep. '
    + '"Show the BTC price every 10 minutes" → template chart or value, source { type: "url", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", pick: "bitcoin.usd", unit: "USD" }, refresh 600. '
    + '"A countdown to my flight on the 30th" → template countdown, source { type: "static", value: { target: "2026-10-30T07:00", label: "Flight" } }, kind "needs". '
    + '"My open GitHub PRs" → list from a shell command (gh pr list --json title,state) or a JSON URL. Then ask: keep, keep + pin, edit, or discard.',
  panelFields, async (a) => (await ctl('panels/preview', a)).message);
  tool('panel_keep', 'Save a previewed panel (the user said keep it / yes), optionally pinned.', { id: z.string(), pin: z.boolean().optional() },
    async (a) => (await ctl('panels/keep', a)).message);
  tool('panel_discard', 'Drop a preview the user doesn\'t want.', { id: z.string() }, async (a) => (await ctl('panels/discard', a)).message);
  tool('panel_edit', '"Edit the X panel …": change a saved panel or a preview (title, template, source, refresh, kind, pinned).',
    { id: z.string().optional(), name: z.string().optional().describe('The panel\'s title when the id is unknown'), ...Object.fromEntries(Object.entries(panelFields).map(([k, v]) => [k, v.optional()])) },
    async (a) => (await ctl('panels/edit', a)).message);
  tool('panel_remove', '"Remove the X panel": deletes a saved custom panel.', { id: z.string().optional(), name: z.string().optional() }, async (a) => (await ctl('panels/remove', a)).message);
  tool('panel_toggle', 'Switch a custom panel on or off without removing it.', { id: z.string().optional(), name: z.string().optional(), on: z.boolean() }, async (a) => (await ctl('panels/toggle', a)).message);
  tool('panel_list', 'The custom panels: ids, templates, sources, on/off, pinned, previews, and the reason when one shows "—".', {}, async () => (await ctl('panels/list', {})).message);

  tool('calendar_refresh', 'Ask macOS to sync its calendar accounts now ("refresh my calendar"), so changes made on the web or the phone arrive.', {},
    async () => (await ctl('calendar/refresh', {})).message);
}

module.exports = { register };
