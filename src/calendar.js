// The calendar, local and live (docs/panels-prompt.md, section 3): events and Reminders read through EventKit by the
// "ARES Calendar" helper (native/AresCalendar.swift), refreshed the moment macOS reports a change, written through the
// same helper with the approval tiers. When EventKit isn't authorized (or holds no calendars) the Google Calendar
// connector in dashboard.js stays the fallback, untouched.
//
// Emits: 'update' { type: 'calendar', calendar: { events (a wide range), calendars, source, at, google } } for the panel,
//        'near' events (now → end of tomorrow) for NEXT and LEAVE BY, 'permission' { events, reminders }.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DAY = 86_400_000;
const RANGE = { back: 5 * 7 * DAY, ahead: 9 * 7 * DAY }; // the MONTH view can walk a little; further asks the helper
const BACKSTOP_MS = 10 * 60_000;
const GOOGLE = /google|gmail|googlemail/i;

class CalendarKit extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.helper      the "ARES Calendar.app" bundle
   * @param {string} o.supportDir
   * @param {Function} o.log  @param {Function} o.readSettings  @param {Function} o.writeSettings
   * @param {(level, what, ctx) => object|null} o.tier   control.js's tier gate (audit + the user's yes)
   * @param {(line: string) => void} [o.notice]
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.events = [];       // the wide range, soonest first
    this.calendars = [];
    this.permission = { events: 'unknown', reminders: 'unknown' };
    this.at = 0;
    this.error = '';
    this.pending = new Map(); // request id -> { resolve, reject, timer }
    this.seq = 0;
    this.conn = null;
    this.restarts = 0;
    this.remindersCache = { list: [], lists: [], at: 0 };
  }

  get enabled() { return this.readSettings().calendar?.eventkit !== false; }
  get authorized() { return this.permission.events === 'authorized'; }
  /** EventKit is the source of truth right now (authorized, connected, and it has calendars). */
  get ready() { return this.enabled && this.authorized && Boolean(this.conn?.sock) && this.calendars.length > 0; }
  get google() { return this.calendars.some((c) => GOOGLE.test(c.source) || GOOGLE.test(c.title)); }

  snapshot() {
    return { events: this.events, calendars: this.calendars.map((c) => ({ title: c.title, source: c.source, color: c.color })), source: this.ready ? 'eventkit' : null,
      at: this.at, google: this.google, permission: this.permission, error: this.error };
  }
  near(now = Date.now()) {
    const end = new Date(now + DAY); end.setHours(23, 59, 59, 999);
    return this.events.filter((e) => !e.declined && e.end > now && e.start <= end.getTime());
  }

  // ---- The helper, over a UNIX socket (launched as an app so macOS can name it in the permission prompt) --------------------
  start() {
    if (!this.enabled || this.conn) return;
    if (!fs.existsSync(this.helper)) { this.error = 'the ARES Calendar helper is missing: run npm run build'; this.log('calendar', { error: this.error }); return; }
    const sock = path.join(this.supportDir, 'calendar.sock');
    try { fs.unlinkSync(sock); } catch {}
    const conn = { sock: null, server: null, gone: false, queued: [] };
    this.conn = conn;
    const gone = (why) => {
      if (conn.gone) return;
      conn.gone = true;
      clearTimeout(conn.timer);
      try { conn.server?.close(); } catch {}
      try { conn.sock?.destroy(); } catch {}
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`calendar helper ${why}`)); }
      this.pending.clear();
      if (this.conn !== conn) return;
      this.conn = null;
      this.log('calendar helper gone', { why });
      this.emit('update', this.message());
      if (this.quitting) return;
      if (++this.restarts > 4) { this.error = `the calendar helper keeps stopping (${why})`; return; }
      setTimeout(() => this.start(), 2000 * this.restarts);
    };
    conn.server = net.createServer((s) => {
      if (conn.sock) { s.destroy(); return; }
      conn.sock = s;
      clearTimeout(conn.timer);
      let buf = '';
      s.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { this.onLine(JSON.parse(line)); } catch (err) { this.log('calendar line', { error: err.message }); }
        }
      });
      s.on('close', () => gone('hung up'));
      s.on('error', () => gone('socket error'));
      for (const cmd of conn.queued) this.write(cmd);
      conn.queued = null;
    });
    conn.server.on('error', (err) => { this.log('calendar', { error: `socket: ${err.message}` }); gone('socket'); });
    conn.server.listen(sock, () => {
      const opener = spawn('open', ['-a', this.helper, '--args', '--serve', sock], { stdio: 'ignore' });
      opener.on('exit', (code) => { if (code) { this.log('calendar', { error: `open failed (${code})` }); gone(`open ${code}`); } });
    });
    conn.timer = setTimeout(() => { if (!conn.sock) { this.log('calendar', { error: 'helper did not connect' }); gone('no connection'); } }, 8000);
    clearInterval(this.backstop);
    this.backstop = setInterval(() => { if (this.ready) this.refresh('backstop'); }, BACKSTOP_MS);
  }
  stop() {
    this.quitting = true;
    clearInterval(this.backstop);
    const c = this.conn;
    if (!c) return;
    this.write({ cmd: 'quit' });
    this.conn = null;
    c.gone = true;
    setTimeout(() => { try { c.sock?.destroy(); } catch {} try { c.server?.close(); } catch {} }, 300);
  }
  write(m) {
    const c = this.conn;
    if (!c) return false;
    if (!c.sock) { c.queued?.push(m); return true; }
    try { c.sock.write(JSON.stringify(m) + '\n'); return true; } catch { return false; }
  }
  /** A command with an answer: resolves with the helper's line ({type: 'events' | 'done' | …}). */
  request(m, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error('the calendar helper is not running'));
      const id = `r${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('the calendar helper did not answer')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.write({ ...m, id })) { clearTimeout(timer); this.pending.delete(id); reject(new Error('the calendar helper is not reachable')); }
    });
  }

  onLine(m) {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.type === 'error') p.reject(new Error(m.message || 'failed')); else p.resolve(m);
      return;
    }
    switch (m.type) {
      case 'ready': this.restarts = 0; break;
      case 'permission': {
        const was = this.permission;
        this.permission = { events: m.events, reminders: m.reminders };
        this.log('calendar permission', this.permission);
        this.emit('permission', this.permission);
        if (this.authorized) this.loadCalendars().then(() => this.refresh('start'));
        else if (was.events !== m.events) this.emit('update', this.message());
        break;
      }
      case 'changed': // anything, anywhere: refresh now (debounced a touch, the helper already waits 300 ms)
        clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => { this.refresh('changed'); this.emit('reminders-changed'); }, 200);
        break;
      case 'error': this.log('calendar helper error', { message: m.message }); break;
    }
  }

  /** The prompt: Calendars (full access) for "ARES Calendar", and Reminders when the tasks panel wants them. */
  authorize({ reminders = false } = {}) {
    if (!this.conn) this.start();
    this.write({ cmd: 'auth', reminders });
    this.writeSettings({ calendar: { ...(this.readSettings().calendar || {}), asked: true } });
  }
  async loadCalendars() {
    try {
      const r = await this.request({ cmd: 'calendars' });
      this.calendars = r.list || [];
      this.remindersCache.lists = r.reminderLists || [];
    } catch (err) { this.log('calendar calendars failed', err.message); }
  }
  message() { return { type: 'calendar', calendar: this.snapshot() }; }

  /** Re-read the whole range; the panel and NEXT follow. */
  refresh(why) {
    if (!this.authorized || !this.conn) return null;
    if (this.refreshing) { this.again = true; return this.refreshing; }
    const now = Date.now();
    this.refreshing = this.request({ cmd: 'events', from: now - RANGE.back, to: now + RANGE.ahead }).then((r) => {
      const list = (r.list || []).map(normalize).filter(Boolean).sort((a, b) => a.start - b.start);
      const changed = JSON.stringify(list) !== JSON.stringify(this.events);
      this.events = list;
      this.at = Date.now();
      this.error = '';
      if (changed || why === 'start') {
        this.log('calendar', { events: list.length, why, calendars: this.calendars.length });
        this.emit('update', this.message());
        this.emit('near', this.near());
      }
    }, (err) => { this.error = err.message; this.log('calendar refresh failed', err.message); })
      .finally(() => { this.refreshing = null; if (this.again) { this.again = false; this.refresh('again'); } });
    return this.refreshing;
  }
  /** Ask macOS to sync its accounts (Google changes made elsewhere arrive when it does), then re-read. */
  async sync(why = 'asked') {
    if (!this.conn) return false;
    try { await this.request({ cmd: 'refresh' }); } catch {}
    setTimeout(() => this.refresh(why), 1500);
    return true;
  }
  /** Events in any range (the panel walking months away from the cache). */
  async range(from, to) {
    if (!this.ready) return this.events.filter((e) => e.end > from && e.start < to);
    const r = await this.request({ cmd: 'events', from, to });
    return (r.list || []).map(normalize).filter(Boolean);
  }

  // ---- Finding events the way people name them -----------------------------------------------------------------------------------
  /** "the dentist", "my 1:1 with Ana on Friday": by words of the title, soonest first, optionally on a day. */
  find({ title, date, after = Date.now() - DAY } = {}) {
    const words = String(title || '').toLowerCase().split(/[^a-z0-9:]+/).filter((w) => w.length > 1 && !['the', 'my', 'with', 'and', 'at', 'on', 'for'].includes(w));
    const day = date ? startOfDay(date) : null;
    const score = (e) => {
      const t = e.title.toLowerCase();
      const hit = words.filter((w) => t.includes(w)).length;
      return hit ? hit / words.length + (t === String(title).toLowerCase() ? 1 : 0) : 0;
    };
    const scored = this.events.filter((e) => e.end > after && (!day || (e.start < day + DAY && e.end > day)))
      .map((e) => ({ e, s: score(e) })).filter((x) => x.s > 0.49).sort((a, b) => b.s - a.s || a.e.start - b.e.start);
    const hits = scored.map((x) => x.e);
    hits.tie = scored.length > 1 && scored[0].s === scored[1].s; // several events fit the words equally: ask which
    return hits;
  }

  // ---- Writes, through the helper (the tiers are applied by the bridge routes below) --------------------------------------------
  async add(ev) {
    const r = await this.request({ cmd: 'add', ...ev });
    this.refresh('wrote');
    return normalize(r.event);
  }
  async update(ev, patch) {
    const r = await this.request({ cmd: 'update', eventId: ev.id, occurrence: ev.recurring ? ev.start : undefined, ...patch });
    this.refresh('wrote');
    return normalize(r.event);
  }
  async remove(ev) {
    await this.request({ cmd: 'delete', eventId: ev.id, occurrence: ev.recurring ? ev.start : undefined });
    this.refresh('wrote');
    return true;
  }

  // ---- Reminders (the TASKS panel's local source) --------------------------------------------------------------------------------
  get remindersAuthorized() { return this.permission.reminders === 'authorized'; }
  async reminders(force = false) {
    if (!this.remindersAuthorized || !this.conn) return this.remindersCache;
    if (!force && Date.now() - this.remindersCache.at < 5000) return this.remindersCache;
    const r = await this.request({ cmd: 'reminders' });
    this.remindersCache = { list: (r.list || []).map((x) => ({ ...x, due: Number.isFinite(x.due) ? x.due : null })), lists: r.lists || [], at: Date.now() };
    return this.remindersCache;
  }
  reminderAdd(o) { return this.request({ cmd: 'reminder-add', ...o }).then((r) => { this.remindersCache.at = 0; return r.reminder; }); }
  reminderComplete(id, undo = false) { return this.request({ cmd: 'reminder-complete', reminderId: id, undo }).then(() => { this.remindersCache.at = 0; return true; }); }
  reminderUpdate(id, patch) { return this.request({ cmd: 'reminder-update', reminderId: id, ...patch }).then((r) => { this.remindersCache.at = 0; return r.reminder; }); }

  // ---- Bridge routes (control.routes['calendar/…']): the brain's calendar tools when EventKit is the source ---------------------
  routes() {
    const when = (e) => `${new Date(e.start).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}${e.allDay ? ' (all day)' : ` ${hhmm(e.start)}–${hhmm(e.end)}`}`;
    const line = (e) => `${when(e)}: ${e.title}${e.location ? ` @ ${e.location.split(',')[0]}` : ''}${e.calendar ? ` [${e.calendar}]` : ''}`;
    const notReady = () => (!this.enabled ? 'EventKit is switched off in settings; use the Google Calendar connector tools instead.'
      : !this.authorized ? `ARES doesn't have Calendars access yet (${this.permission.events}). Call calendar_setup, or use the Google Calendar connector tools.`
        : !this.calendars.length ? 'macOS Calendar has no calendars. ' + GOOGLE_HELP : null);
    return {
      'calendar/status': (_a, ctx) => {
        this.tier(1, { what: 'checked the calendar source', kind: 'calendar' }, ctx);
        const lines = [`EventKit: ${this.enabled ? this.permission.events : 'off'}${this.ready ? ' (live, the source of truth)' : ''}.`];
        if (this.calendars.length) lines.push(`Calendars in macOS Calendar: ${this.calendars.map((c) => `${c.title} (${c.source})`).join(', ')}.`);
        lines.push(this.google ? 'The Google Calendar is in macOS Calendar: changes made there, on the phone or on the web arrive when macOS syncs (minutes).' : `No Google account calendar in macOS Calendar. ${GOOGLE_HELP}`);
        if (this.at) lines.push(`Last read ${new Date(this.at).toLocaleTimeString('en-GB')}, ${this.events.length} events cached.`);
        return { message: lines.join('\n') };
      },
      'calendar/setup': (_a, ctx) => {
        const hold = this.tier(2, { what: 'asked macOS for Calendars access (the ARES Calendar prompt)', kind: 'calendar' }, ctx);
        if (hold) return hold;
        if (this.authorized) return { message: 'Calendars access is already granted.' };
        if (this.permission.events === 'denied') return { message: 'Calendars access was denied earlier: the user can allow "ARES Calendar" under System Settings ▸ Privacy & Security ▸ Calendars, then say "connect my calendar" again.' };
        this.notice?.('macOS is about to ask you to let ARES Calendar see your calendars, sir: that\'s how I read and update them right here on the Mac, without any cloud call.');
        this.authorize();
        return { message: 'The macOS prompt is up on the Mac ("ARES Calendar" wants full access to Calendars). Tell the user to click Allow; the calendar panel fills in by itself after that.' };
      },
      'calendar/list': ({ from, to, query } = {}, ctx) => {
        const nr = notReady(); if (nr) return { message: nr };
        this.tier(1, { what: `read the calendar${query ? ` for "${query}"` : ''}`, kind: 'calendar' }, ctx);
        const a = parseWhen(from) ?? startOfDay(Date.now()), b = parseWhen(to, true) ?? a + (query ? RANGE.ahead : 7 * DAY); // words: the whole cache
        let list = this.events.filter((e) => e.end > a && e.start < b && !e.declined);
        if (query) list = this.find({ title: query, after: a }).filter((e) => e.start < b);
        if (!list.length) return { message: `Nothing${query ? ` matching "${query}"` : ''} between ${new Date(a).toLocaleDateString('en-GB')} and ${new Date(b).toLocaleDateString('en-GB')}.` };
        return { message: list.slice(0, 60).map(line).join('\n') };
      },
      'calendar/add': async ({ title, start, end, all_day, location, notes, calendar } = {}, ctx) => {
        const nr = notReady(); if (nr) return { message: nr };
        const s = parseWhen(start); if (!title || !s) return { message: 'Needs a title and a start ("2026-10-07T16:00", or "tomorrow 14:00").' };
        const e = parseWhen(end) ?? (all_day ? startOfDay(s) + DAY : s + 3_600_000);
        const hold = this.tier(2, { what: `added "${title}" ${new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} to the calendar`, kind: 'calendar' }, ctx);
        if (hold) return hold;
        try { const ev = await this.add({ title: String(title).slice(0, 120), start: all_day ? startOfDay(s) : s, end: e, allDay: Boolean(all_day), location: location || '', notes: notes || '', calendar: calendar || '' }); return { message: `Added: ${line(ev)}.`, event: ev }; }
        catch (err) { return { message: `Couldn't add it: ${err.message}` }; }
      },
      'calendar/move': async ({ title, date, start, end, duration_min } = {}, ctx) => {
        const nr = notReady(); if (nr) return { message: nr };
        const hits = this.find({ title, date: parseWhen(date) });
        if (!hits.length) return { message: `No upcoming event like "${title}". Use calendar_events to list them.` };
        if (hits.tie && !date) return { message: `Which one? ${hits.slice(0, 5).map(line).join('; ')}. Say the date too.` };
        const ev = hits[0];
        const s = parseWhen(start); if (!s) return { message: 'Needs the new start time.' };
        const len = duration_min ? duration_min * 60_000 : ev.end - ev.start;
        const hold = this.tier(2, { what: `moved "${ev.title}" from ${when(ev)} to ${new Date(s).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, kind: 'calendar' }, ctx);
        if (hold) return hold;
        try { const out = await this.update(ev, { start: s, end: parseWhen(end) ?? s + len }); return { message: `Moved: ${line(out)}.`, event: out }; }
        catch (err) { return { message: `Couldn't move it: ${err.message}` }; }
      },
      'calendar/delete': async ({ title, date } = {}, ctx) => {
        const nr = notReady(); if (nr) return { message: nr };
        const hits = this.find({ title, date: parseWhen(date) });
        if (!hits.length) return { message: `No upcoming event like "${title}".` };
        if (hits.tie && !date) return { message: `Which one? ${hits.slice(0, 5).map(line).join('; ')}. Say the date too.` };
        const ev = hits[0];
        const hold = this.tier(3, { what: `deleted "${ev.title}" (${when(ev)}) from the calendar`, why: 'deleting is always confirmed', kind: 'calendar' }, ctx);
        if (hold) return hold;
        try { await this.remove(ev); return { message: `Deleted "${ev.title}" (${when(ev)}).` }; } catch (err) { return { message: `Couldn't delete it: ${err.message}` }; }
      },
      'calendar/refresh': async (_a, ctx) => {
        this.tier(1, { what: 'asked macOS to refresh the calendars', kind: 'calendar' }, ctx);
        return { message: (await this.sync('asked')) ? 'Refreshing: macOS is syncing its calendar accounts; the panel updates when new events arrive.' : 'The calendar helper is not running.' };
      },
    };
  }
}

const GOOGLE_HELP = 'To add it: System Settings ▸ Internet Accounts ▸ Add Account ▸ Google, sign in, and switch on Calendars. Until then the Google Calendar connector is the fallback.';
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** "2026-10-07T16:00", "2026-10-07", "tomorrow 14:00", "friday 16:00", "today", "next monday" → epoch ms (local), or null. */
function parseWhen(s, endOfDay = false) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  const t = String(s).trim().toLowerCase();
  let m = t.match(/^(\d{4})-(\d\d)-(\d\d)(?:[t ](\d\d):(\d\d))?/);
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : endOfDay ? 23 : 0, m[5] ? +m[5] : endOfDay ? 59 : 0); return d.getTime(); }
  const d = new Date(); d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, 0, 0);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (/^tomorrow/.test(t)) d.setDate(d.getDate() + 1);
  else if (/^yesterday/.test(t)) d.setDate(d.getDate() - 1);
  else if ((m = t.match(/^(next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*/))) {
    const want = days.findIndex((x) => x.startsWith(m[2]));
    let diff = (want - d.getDay() + 7) % 7;
    if (diff === 0 && (m[1] || !/\d/.test(t))) diff = m[1] ? 7 : 0;
    if (m[1] && diff < 7 && diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
  } else if (!/^today|^now/.test(t)) return Number.isFinite(Date.parse(s)) ? Date.parse(s) : null;
  m = t.match(/(\d{1,2})(?::(\d\d))?\s*(am|pm)?(?!\d)/);
  if (m && !/^\d{4}-/.test(t)) {
    let h = +m[1]; const min = m[2] ? +m[2] : 0;
    if (m[3] === 'pm' && h < 12) h += 12; if (m[3] === 'am' && h === 12) h = 0;
    if (/afternoon/.test(t) && h < 12) h += 12;
    d.setHours(h, min, 0, 0);
  } else if (/afternoon/.test(t)) d.setHours(14, 0, 0, 0);
  else if (/morning/.test(t)) d.setHours(9, 0, 0, 0);
  else if (/evening/.test(t)) d.setHours(18, 0, 0, 0);
  return d.getTime();
}
function normalize(x) {
  if (!x || !x.title || !Number.isFinite(x.start)) return null;
  return { id: String(x.id || ''), title: String(x.title).slice(0, 120), start: x.start, end: Number.isFinite(x.end) && x.end > x.start ? x.end : x.start + 3_600_000,
    allDay: Boolean(x.allDay), location: String(x.location || '').slice(0, 200), notes: String(x.notes || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
    link: /^https:\/\//.test(x.link || '') ? String(x.link).slice(0, 300) : '', attendees: (x.attendees || []).map((a) => String(a).slice(0, 60)).slice(0, 8),
    calendar: String(x.calendar || '').slice(0, 60), color: x.color || '', recurring: Boolean(x.recurring), declined: Boolean(x.declined), organizer: x.organizer || '' };
}

/** Keychain through the helper's binary (the secret travels on stdin/stdout, never argv, never a file). */
function keychain(helperApp) {
  const bin = path.join(helperApp, 'Contents', 'MacOS', 'ares-calendar');
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = execFile(bin, ['keychain', ...args], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
  return {
    get: (service) => run(['get', service]).catch(() => null),
    set: (service, secret) => run(['set', service], secret).then(() => true),
    delete: (service) => run(['delete', service]).then(() => true).catch(() => false),
  };
}

module.exports = { CalendarKit, parseWhen, normalize, keychain, DAY };
