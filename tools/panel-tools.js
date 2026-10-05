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

  tool('calendar_refresh', 'Ask macOS to sync its calendar accounts now ("refresh my calendar"), so changes made on the web or the phone arrive.', {},
    async () => (await ctl('calendar/refresh', {})).message);
}

module.exports = { register };
