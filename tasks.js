// The TASKS panel's data (docs/panels-prompt.md, section 4): open tasks from Google Tasks (the API directly, OAuth
// "Desktop app" client, sign-in in the browser with a loopback redirect and PKCE, the refresh token in the macOS Keychain
// through the ARES Calendar helper: never a file, never logged) or from Apple Reminders (EventKit, local, no setup).
// Polled every ~2 minutes while the panel shows, refreshed right after any change ARES makes. Writes go through the tiers.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const { parseWhen } = require('./calendar');

const DAY = 86_400_000;
const POLL_MS = 2 * 60_000;
const API = 'https://tasks.googleapis.com/tasks/v1';
const SCOPE = 'https://www.googleapis.com/auth/tasks';
const KC = { client: 'google-tasks-client', refresh: 'google-tasks-refresh' };
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

const SETUP_STEPS = [
  'Open console.cloud.google.com and create a project (any name, e.g. "ARES").',
  'APIs & Services ▸ Library: search "Tasks API" and Enable it.',
  'APIs & Services ▸ OAuth consent screen: External, app name "ARES", add your own Gmail as a test user.',
  'APIs & Services ▸ Credentials ▸ Create credentials ▸ OAuth client ID ▸ Application type "Desktop app" ▸ Create ▸ Download JSON.',
  'In ARES: ◉ menu ▸ Connect Google Tasks… and pick that JSON. Your browser opens for sign-in; ARES keeps only the refresh token, in the Keychain.',
  'Rather not? Say "use Reminders for my tasks": the same panel from Apple Reminders, no setup.',
];

class Tasks extends EventEmitter {
  /**
   * @param {object} o
   * @param {{get,set,delete}} o.keychain   calendar.js keychain(helperApp)
   * @param {import('./calendar').CalendarKit} o.calendar   for Reminders
   * @param {Function} o.readSettings  @param {Function} o.writeSettings  @param {Function} o.log
   * @param {(level, what, ctx) => object|null} o.tier
   * @param {(url: string) => void} o.openExternal
   * @param {(line: string) => void} [o.notice]
   * @param {Function} [o.fetch]    (tests)
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.fetch = o.fetch || ((...a) => globalThis.fetch(...a));
    this.tasks = [];
    this.lists = [];
    this.at = 0;
    this.error = '';
    this.access = null; // { token, exp }
    this.client = null; // { id, secret }
    this.hasRefresh = false;
    this.visible = false;
    this.undo = new Map(); // task id -> timer (a completed task can come back for 5 s)
  }

  get prefs() { return this.readSettings().tasks || {}; }
  /** 'google' | 'reminders' | null: the user's choice, else whatever is connected. */
  get source() {
    const p = this.prefs;
    if (p.source === 'google' && this.hasRefresh) return 'google';
    if (p.source === 'reminders' && this.calendar?.remindersAuthorized) return 'reminders';
    if (p.source) return null; // chosen but not connected yet
    return this.hasRefresh ? 'google' : this.calendar?.remindersAuthorized ? 'reminders' : null;
  }
  snapshot() {
    return { tasks: this.tasks, lists: this.lists.map((l) => ({ id: l.id, title: l.title, on: this.listOn(l.id) })), source: this.source, chosen: this.prefs.source || null,
      at: this.at, error: this.error, setup: this.source ? null : { google: this.hasRefresh, reminders: Boolean(this.calendar?.remindersAuthorized), steps: SETUP_STEPS } };
  }
  message() { return { type: 'tasks', tasks: this.snapshot() }; }
  listOn(id) { const on = this.prefs.lists; return !Array.isArray(on) || !on.length || on.includes(id); }

  async start() {
    this.client = await this.readClient();
    this.hasRefresh = Boolean(await this.keychain.get(KC.refresh));
    this.calendar?.on('reminders-changed', () => { if (this.source === 'reminders') this.refresh('changed'); });
    this.calendar?.on('permission', () => { if (this.source === 'reminders') this.refresh('permission'); else this.emit('update', this.message()); });
    this.emit('update', this.message());
    if (this.source) this.refresh('start');
  }
  stop() { clearInterval(this.timer); this.loop?.close(); }
  setVisible(on) {
    this.visible = on;
    clearInterval(this.timer);
    if (!on) return;
    if (this.source && Date.now() - this.at > 30_000) this.refresh('shown');
    this.timer = setInterval(() => { if (this.source) this.refresh('poll'); }, POLL_MS);
  }
  async readClient() {
    try { const j = JSON.parse((await this.keychain.get(KC.client)) || 'null'); return j?.id ? j : null; } catch { return null; }
  }

  // ---- Reading ------------------------------------------------------------------------------------------------------------
  refresh(why) {
    if (this.refreshing) return this.refreshing;
    const src = this.source;
    if (!src) { this.tasks = []; this.emit('update', this.message()); return null; }
    this.refreshing = (src === 'google' ? this.readGoogle() : this.readReminders()).then((tasks) => {
      const sorted = tasks.sort(byUrgency);
      const changed = JSON.stringify(sorted) !== JSON.stringify(this.tasks);
      this.tasks = sorted;
      this.at = Date.now();
      this.error = '';
      if (changed || why === 'start') { this.log('tasks', { source: src, open: sorted.length, why }); this.emit('update', this.message()); }
    }, (err) => { this.error = err.message; this.log('tasks failed', { source: src, error: err.message }); this.emit('update', this.message()); })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async readGoogle() {
    const lists = (await this.api('/users/@me/lists?maxResults=50')).items || [];
    this.lists = lists.map((l) => ({ id: l.id, title: l.title }));
    const out = [];
    for (const l of lists.filter((x) => this.listOn(x.id))) {
      const r = await this.api(`/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=100`);
      for (const t of r.items || []) {
        if (!t.title || t.status === 'completed') continue;
        out.push({ id: t.id, title: t.title, notes: t.notes || '', due: t.due ? dueMs(t.due) : null, list: l.title, listId: l.id, source: 'google', link: t.webViewLink || '' });
      }
    }
    return out;
  }
  async readReminders() {
    const r = await this.calendar.reminders(true);
    this.lists = r.lists.map((l) => ({ id: l.id, title: l.title }));
    return r.list.filter((x) => !x.completed && this.listOn(x.listId)).map((x) => ({ id: x.id, title: x.title, notes: x.notes || '', due: x.due, list: x.list, listId: x.listId, source: 'reminders', allDay: x.allDay }));
  }

  // ---- Writing -----------------------------------------------------------------------------------------------------------------
  defaultList() { const on = this.prefs.lists; return this.lists.find((l) => (!on?.length || on.includes(l.id))) || this.lists[0]; }
  async add({ title, due, notes, list }) {
    if (this.source === 'google') {
      const l = (list && this.lists.find((x) => x.title.toLowerCase() === String(list).toLowerCase())) || this.defaultList();
      if (!l) throw new Error('no task list');
      const t = await this.api(`/lists/${encodeURIComponent(l.id)}/tasks`, { method: 'POST', body: { title, notes: notes || undefined, due: due ? new Date(startOfDay(due)).toISOString() : undefined } });
      await this.refresh('wrote');
      return { id: t.id, title: t.title, due: due || null, list: l.title };
    }
    const r = await this.calendar.reminderAdd({ title, due: due || undefined, notes: notes || '', list: list || this.prefs.remindersList || '' });
    await this.refresh('wrote');
    return { id: r.id, title: r.title, due: r.due ?? null, list: r.list };
  }
  async complete(id, undo = false) {
    const t = this.tasks.find((x) => x.id === id) || this.done?.get(id);
    if (!t) throw new Error('no such task');
    if (t.source === 'google') await this.api(`/lists/${encodeURIComponent(t.listId)}/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: undo ? { status: 'needsAction', completed: null } : { status: 'completed' } });
    else await this.calendar.reminderComplete(id, undo);
    (this.done ||= new Map()).set(id, t);
    await this.refresh('wrote');
    return t;
  }
  async move(id, due) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error('no such task');
    if (t.source === 'google') await this.api(`/lists/${encodeURIComponent(t.listId)}/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: { due: due ? new Date(startOfDay(due)).toISOString() : null } });
    else await this.calendar.reminderUpdate(id, { due: due ?? null, allDay: true });
    await this.refresh('wrote');
    return { ...t, due };
  }
  find(words) {
    const w = String(words || '').toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1);
    return this.tasks.map((t) => ({ t, s: w.filter((x) => t.title.toLowerCase().includes(x)).length / Math.max(1, w.length) })).filter((x) => x.s > 0.49).sort((a, b) => b.s - a.s).map((x) => x.t);
  }

  // ---- Google OAuth: Desktop-app client, loopback redirect, PKCE; the refresh token lives in the Keychain ------------------------
  /** Step 1 of the one-time setup: the downloaded OAuth client JSON (read once, kept in the Keychain, the file is left alone). */
  async setClientFile(file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = j.installed || j.web || j;
    if (!c.client_id) throw new Error('that file has no client_id (download the OAuth client JSON of type "Desktop app")');
    this.client = { id: c.client_id, secret: c.client_secret || '' };
    await this.keychain.set(KC.client, JSON.stringify(this.client));
    this.log('tasks client stored', { ok: true });
    return true;
  }
  /** Step 2: sign in. Opens the browser; resolves when Google calls back on the loopback port. */
  async signIn() {
    if (!this.client) this.client = await this.readClient();
    if (!this.client) throw new Error('no OAuth client yet: Connect Google Tasks… first (the client JSON)');
    this.loop?.close();
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/oauth') { res.writeHead(404).end(); return; }
        const page = (t) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><meta charset=utf-8><body style="font:16px -apple-system;background:#06111a;color:#cfefff;display:grid;place-items:center;height:100vh;margin:0"><div>${t}<br><small>You can close this tab.</small></div>`);
        try {
          if (u.searchParams.get('state') !== state) throw new Error('state mismatch');
          if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error'));
          const code = u.searchParams.get('code');
          const body = new URLSearchParams({ code, client_id: this.client.id, client_secret: this.client.secret, redirect_uri: `http://127.0.0.1:${server.address().port}/oauth`, grant_type: 'authorization_code', code_verifier: verifier });
          const r = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
          const tok = await r.json();
          if (!tok.refresh_token) throw new Error(tok.error_description || tok.error || 'no refresh token (remove ARES under myaccount.google.com ▸ Security ▸ Third-party access and try again)');
          await this.keychain.set(KC.refresh, tok.refresh_token);
          this.hasRefresh = true;
          this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
          this.writeSettings({ tasks: { ...this.prefs, source: 'google' } });
          page('ARES is connected to Google Tasks.');
          this.log('tasks signed in', { ok: true });
          this.emit('update', this.message());
          this.refresh('signin');
          resolve(true);
        } catch (err) { page(`Sign-in failed: ${err.message}`); reject(err); }
        finally { setTimeout(() => server.close(), 500); this.loop = null; }
      });
      this.loop = server;
      server.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${server.address().port}/oauth`;
        const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: this.client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state })}`;
        this.openExternal(url);
      });
      setTimeout(() => { if (this.loop === server) { server.close(); this.loop = null; reject(new Error('sign-in timed out')); } }, 5 * 60_000);
    });
  }
  async token() {
    if (this.access && this.access.exp > Date.now()) return this.access.token;
    if (!this.client) this.client = await this.readClient();
    const refresh = await this.keychain.get(KC.refresh);
    if (!refresh || !this.client) { this.hasRefresh = false; throw new Error('Google Tasks is not connected'); }
    const body = new URLSearchParams({ client_id: this.client.id, client_secret: this.client.secret, refresh_token: refresh, grant_type: 'refresh_token' });
    const r = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const tok = await r.json();
    if (!tok.access_token) {
      if (tok.error === 'invalid_grant') { await this.keychain.delete(KC.refresh); this.hasRefresh = false; }
      throw new Error(`Google sign-in expired (${tok.error || r.status}): connect Google Tasks again`);
    }
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
    return this.access.token;
  }
  async api(path, { method = 'GET', body } = {}) {
    const t = await this.token();
    const r = await this.fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Google Tasks ${r.status}`);
    return j;
  }
  async disconnect() {
    await this.keychain.delete(KC.refresh);
    this.hasRefresh = false; this.access = null; this.tasks = [];
    this.writeSettings({ tasks: { ...this.prefs, source: undefined } });
    this.emit('update', this.message());
  }
  useReminders() {
    this.writeSettings({ tasks: { ...this.prefs, source: 'reminders' } });
    if (!this.calendar?.remindersAuthorized) { this.notice?.('macOS is asking you to let ARES Calendar see your Reminders, sir: that\'s the tasks panel.'); this.calendar?.authorize({ reminders: true }); }
    else this.refresh('chosen');
    this.emit('update', this.message());
  }

  // ---- Bridge routes (control.routes['tasks/…']) ------------------------------------------------------------------------------------
  routes() {
    const line = (t) => `${t.title}${t.due ? ` (due ${dueLabel(t.due)})` : ''}${t.list ? ` [${t.list}]` : ''}`;
    const need = () => (this.source ? null : `No task source yet. ${this.prefs.source === 'google' ? 'Google Tasks isn\'t connected: ' : ''}Google Tasks takes a one-time setup:\n${SETUP_STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    return {
      'tasks/status': (_a, ctx) => { this.tier(1, { what: 'checked the task source', kind: 'tasks' }, ctx); return { message: this.source ? `Tasks come from ${this.source === 'google' ? 'Google Tasks' : 'Apple Reminders'}: ${this.tasks.length} open${this.lists.length ? `, lists: ${this.lists.map((l) => l.title).join(', ')}` : ''}.` : need() }; },
      'tasks/setup': ({ source } = {}, ctx) => {
        const hold = this.tier(2, { what: `set up tasks from ${source}`, kind: 'tasks' }, ctx);
        if (hold) return hold;
        if (source === 'reminders') { this.useReminders(); return { message: this.calendar?.remindersAuthorized ? 'Tasks now come from Apple Reminders.' : 'macOS is asking the user to allow ARES Calendar to see Reminders; the tasks panel fills in once they click Allow.' }; }
        if (this.hasRefresh) { this.writeSettings({ tasks: { ...this.prefs, source: 'google' } }); this.refresh('chosen'); return { message: 'Tasks now come from Google Tasks.' }; }
        return { message: `Google Tasks needs the one-time setup, done at the Mac:\n${SETUP_STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n')}` };
      },
      'tasks/list': (_a, ctx) => {
        const nr = need(); if (nr) return { message: nr };
        this.tier(1, { what: 'read the task list', kind: 'tasks' }, ctx);
        return { message: this.tasks.length ? this.tasks.map(line).join('\n') : 'Nothing on the list.' };
      },
      'tasks/add': async ({ title, due, notes, list } = {}, ctx) => {
        const nr = need(); if (nr) return { message: nr };
        if (!title) return { message: 'Needs a title.' };
        const d = due ? parseWhen(due) : null;
        const hold = this.tier(2, { what: `added task "${title}"${d ? ` due ${dueLabel(d)}` : ''}`, kind: 'tasks' }, ctx);
        if (hold) return hold;
        try { const t = await this.add({ title: String(title).slice(0, 200), due: d, notes, list }); return { message: `Added: ${line(t)}.` }; } catch (err) { return { message: `Couldn't add it: ${err.message}` }; }
      },
      'tasks/complete': async ({ title } = {}, ctx) => {
        const nr = need(); if (nr) return { message: nr };
        const hits = this.find(title);
        if (!hits.length) return { message: `No open task like "${title}". Open: ${this.tasks.slice(0, 10).map((t) => t.title).join(', ') || 'none'}.` };
        const hold = this.tier(2, { what: `ticked off "${hits[0].title}"`, kind: 'tasks' }, ctx);
        if (hold) return hold;
        try { await this.complete(hits[0].id); return { message: `Done: "${hits[0].title}" ticked off.` }; } catch (err) { return { message: `Couldn't complete it: ${err.message}` }; }
      },
      'tasks/move': async ({ title, due } = {}, ctx) => {
        const nr = need(); if (nr) return { message: nr };
        const hits = this.find(title);
        if (!hits.length) return { message: `No open task like "${title}".` };
        const d = due ? parseWhen(due) : null;
        if (due && !d) return { message: `Couldn't read the date "${due}".` };
        const hold = this.tier(2, { what: `moved task "${hits[0].title}" to ${d ? dueLabel(d) : 'no date'}`, kind: 'tasks' }, ctx);
        if (hold) return hold;
        try { await this.move(hits[0].id, d); return { message: `"${hits[0].title}" is now due ${d ? dueLabel(d) : 'whenever'}.` }; } catch (err) { return { message: `Couldn't move it: ${err.message}` }; }
      },
    };
  }
}

/** Google's due dates are dates (RFC 3339 at midnight UTC): the local day. */
function dueMs(iso) { const m = String(iso).match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; }
function dueLabel(ms) {
  const today = startOfDay(Date.now()), d = startOfDay(ms);
  if (d < today) return 'LATE';
  if (d === today) return 'TODAY';
  if (d === today + DAY) return 'TOMORROW';
  if (d < today + 7 * DAY) return new Date(d).toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase();
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase();
}
/** Late first, then due today, then dated (soonest first), then the rest. */
function byUrgency(a, b) {
  const today = startOfDay(Date.now());
  const rank = (t) => (t.due == null ? 3 : startOfDay(t.due) < today ? 0 : startOfDay(t.due) === today ? 1 : 2);
  return rank(a) - rank(b) || (a.due ?? Infinity) - (b.due ?? Infinity) || a.title.localeCompare(b.title);
}

module.exports = { Tasks, SETUP_STEPS, dueLabel, byUrgency, dueMs };
