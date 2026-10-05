// Main-process pieces of panels v2 with fakes (no helper, no Claude, no network). run(check) is called by test-panels.js.
const path = require('path');
const root = path.join(__dirname, '..');
const DAY = 86_400_000;

/** A CalendarKit whose helper is an in-memory EventKit: the same request() surface, answered from a list. */
function fakeCalendar(events = []) {
  const { CalendarKit } = require(path.join(root, 'calendar.js'));
  const audit = [];
  const settings = { calendar: {} };
  const k = new CalendarKit({ helper: '/nonexistent', supportDir: '/tmp', log: () => {}, readSettings: () => settings, writeSettings: (p) => Object.assign(settings, p),
    tier: (level, what, ctx) => { audit.push({ level, ...what, ok: !(level === 3 && !ctx.confirm?.().allow) }); return level === 3 && !ctx.confirm?.().allow ? { message: 'Not confirmed yet.' } : null; } });
  let seq = 0;
  const store = events.map((e) => ({ id: `e${++seq}`, allDay: false, location: '', notes: '', link: '', attendees: [], calendar: 'Home', ...e }));
  k.conn = { sock: {} };
  k.permission = { events: 'authorized', reminders: 'authorized' };
  k.calendars = [{ title: 'Home', source: 'iCloud' }, { title: 'me@example.com', source: 'Google' }];
  k.request = async (m) => {
    switch (m.cmd) {
      case 'events': return { list: store.filter((e) => e.end > m.from && e.start < m.to) };
      case 'add': { const e = { id: `e${++seq}`, location: '', notes: '', link: '', attendees: [], calendar: m.calendar || 'Home', ...m, allDay: Boolean(m.allDay) }; delete e.cmd; store.push(e); return { event: e }; }
      case 'update': { const e = store.find((x) => x.id === m.eventId); Object.assign(e, Object.fromEntries(Object.entries(m).filter(([k2, v]) => ['title', 'start', 'end', 'location', 'notes'].includes(k2) && v != null))); return { event: e }; }
      case 'delete': { const i = store.findIndex((x) => x.id === m.eventId); store.splice(i, 1); return {}; }
      case 'refresh': return {};
      case 'reminders': return { list: [], lists: [] };
      default: throw new Error(`fake: ${m.cmd}`);
    }
  };
  return { k, store, audit, settings };
}

async function run(check) {
  const { parseWhen } = require(path.join(root, 'calendar.js'));
  // ---- when-parsing ----------------------------------------------------------------------------------------------------
  const d = new Date(2026, 9, 7, 16, 0); // 7 Oct 2026 16:00
  check('parseWhen ISO', parseWhen('2026-10-07T16:00') === d.getTime());
  const tm = new Date(); tm.setDate(tm.getDate() + 1); tm.setHours(14, 0, 0, 0);
  check('parseWhen tomorrow 14:00', parseWhen('tomorrow 14:00') === tm.getTime(), new Date(parseWhen('tomorrow 14:00')).toString());
  const tp = new Date(); tp.setDate(tp.getDate() + 1); tp.setHours(14, 0, 0, 0);
  check('parseWhen tomorrow afternoon', parseWhen('tomorrow afternoon') === tp.getTime());
  const fri = new Date(parseWhen('friday 16:00'));
  check('parseWhen friday 16:00', fri.getDay() === 5 && fri.getHours() === 16 && fri.getTime() >= Date.now() - DAY);
  check('parseWhen nonsense', parseWhen('whenever') === null);

  // ---- the EventKit routes with a fake store -------------------------------------------------------------------------------
  const now = Date.now();
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const T = t0.getTime();
  const { k, store, audit } = fakeCalendar([
    { title: 'Standup', start: T + 9.5 * 3600e3, end: T + 10 * 3600e3 },
    { title: 'Dentist', start: T + DAY + 15 * 3600e3, end: T + DAY + 16 * 3600e3, location: '12 High St' },
    { title: 'Dentist', start: T + 8 * DAY + 15 * 3600e3, end: T + 8 * DAY + 16 * 3600e3 },
  ]);
  let updates = 0, nearCount = -1;
  k.on('update', () => updates++);
  k.on('near', (list) => { nearCount = list.length; });
  await k.refresh('start');
  check('fake refresh loads events', k.events.length === 3 && updates === 1, `${k.events.length} events, ${updates} updates`);
  check('near = now to end of tomorrow', nearCount === store.filter((e) => e.end > now && e.start < T + 2 * DAY).length, `near ${nearCount}`);
  check('ready with calendars', k.ready && k.google);
  const routes = k.routes();
  const yes = { source: 'mac', verified: true, confirm: () => ({ allow: true, said: 'yes' }) };
  const no = { source: 'mac', verified: true, confirm: () => ({ allow: false }) };
  const st = routes['calendar/status']({}, yes);
  check('status mentions Google in macOS Calendar', /Google Calendar is in macOS Calendar/.test(st.message), st.message);
  const list = routes['calendar/list']({ query: 'dentist' }, yes);
  check('list by words', (list.message.match(/Dentist/g) || []).length === 2, list.message);
  const added = await routes['calendar/add']({ title: 'Deep work', start: 'tomorrow 14:00', end: 'tomorrow 16:00' }, yes);
  check('add (tier 2) writes', /Added: .*Deep work/.test(added.message) && store.some((e) => e.title === 'Deep work'), added.message);
  check('add audited at tier 2', audit.some((a) => a.level === 2 && /added "Deep work"/.test(a.what)));
  const amb = await routes['calendar/move']({ title: 'dentist', start: 'friday 16:00' }, yes);
  check('move asks which when ambiguous', /Which one\?/.test(amb.message), amb.message);
  const moved = await routes['calendar/move']({ title: 'dentist', date: 'tomorrow', start: 'friday 16:00' }, yes);
  check('move with the day', /Moved: .*Dentist/.test(moved.message), moved.message);
  const held = await routes['calendar/delete']({ title: 'standup' }, no);
  check('delete held without a yes (tier 3)', /Not confirmed/.test(held.message) && store.some((e) => e.title === 'Standup'), held.message);
  const gone = await routes['calendar/delete']({ title: 'standup' }, yes);
  check('delete with a yes', /Deleted "Standup"/.test(gone.message) && !store.some((e) => e.title === 'Standup'), gone.message);
  check('writes refreshed the cache', k.events.some((e) => e.title === 'Deep work') && !k.events.some((e) => e.title === 'Standup'));
  // A change from elsewhere (Calendar.app, the phone): the helper says "changed" → a refresh → an update for the panel
  store.push({ id: 'x', title: 'Added in Calendar.app', start: T + 3 * DAY + 10 * 3600e3, end: T + 3 * DAY + 11 * 3600e3, allDay: false, location: '', notes: '', link: '', attendees: [], calendar: 'Home' });
  const before = updates;
  k.onLine({ type: 'changed' });
  await new Promise((r) => setTimeout(r, 400));
  check('EKEventStoreChanged → the panel updates', updates > before && k.events.some((e) => e.title === 'Added in Calendar.app'));
  // Not authorized: the routes point at the fallback
  k.permission = { events: 'notDetermined', reminders: 'notDetermined' };
  const nr = routes['calendar/list']({}, yes);
  check('not authorized → fallback hint', /calendar_setup|connector/.test(nr.message), nr.message);
  k.permission = { events: 'authorized', reminders: 'authorized' };

  // ---- Tasks with a fake Google Tasks API and a fake Keychain -------------------------------------------------------------------
  const { Tasks, dueLabel } = require(path.join(root, 'tasks.js'));
  const kc = new Map([['google-tasks-client', JSON.stringify({ id: 'cid', secret: 'sec' })], ['google-tasks-refresh', 'rt-1']]);
  const api = { lists: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Work' }], tasks: { L1: [
    { id: 't1', title: 'Buy milk', status: 'needsAction', due: new Date(T + DAY).toISOString() },
    { id: 't2', title: 'Book flights', status: 'needsAction', due: new Date(T - 2 * DAY).toISOString() },
    { id: 't3', title: 'Call mum', status: 'needsAction' },
    { id: 't4', title: 'Tax return', status: 'needsAction', due: new Date(T).toISOString() }], L2: [{ id: 't5', title: 'Review PR', status: 'needsAction' }] } };
  const calls = [];
  const fakeFetch = async (url, o = {}) => {
    calls.push([o.method || 'GET', url]);
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 });
    if (!/Bearer at/.test(o.headers?.Authorization || '')) return json({ error: { message: 'no token' } }, 401);
    const u = new URL(url);
    let m;
    if (u.pathname.endsWith('/users/@me/lists')) return json({ items: api.lists });
    if ((m = u.pathname.match(/\/lists\/(\w+)\/tasks$/))) {
      if (o.method === 'POST') { const b = JSON.parse(o.body); const t = { id: `t${Date.now()}`, status: 'needsAction', ...b }; api.tasks[m[1]].push(t); return json(t); }
      return json({ items: api.tasks[m[1]].filter((t) => t.status !== 'completed') });
    }
    if ((m = u.pathname.match(/\/lists\/(\w+)\/tasks\/(\w+)$/)) && o.method === 'PATCH') { const t = api.tasks[m[1]].find((x) => x.id === m[2]); Object.assign(t, JSON.parse(o.body)); return json(t); }
    return json({ error: { message: `unexpected ${u.pathname}` } }, 404);
  };
  let tset = {};
  const tk = new Tasks({ keychain: { get: async (k2) => kc.get(k2) ?? null, set: async (k2, v) => kc.set(k2, v), delete: async (k2) => kc.delete(k2) }, calendar: k,
    readSettings: () => tset, writeSettings: (p2) => Object.assign(tset, p2), log: () => {}, tier: (level, what, ctx) => { audit.push({ level, ...what }); return null; }, openExternal: () => {}, fetch: fakeFetch });
  await tk.start();
  await tk.refresh('test');
  check('tasks read from the API', tk.source === 'google' && tk.tasks.length === 5, `${tk.source} ${tk.tasks.length}`);
  check('late first, then today, then dated, then the rest', tk.tasks.map((t) => t.title).join(',') === 'Book flights,Tax return,Buy milk,Call mum,Review PR', tk.tasks.map((t) => t.title).join(','));
  check('due labels', dueLabel(T - DAY) === 'LATE' && dueLabel(T) === 'TODAY' && dueLabel(T + DAY) === 'TOMORROW');
  check('token refreshed with the Keychain refresh token, never logged', calls.some(([, u]) => u.includes('oauth2.googleapis.com/token')) && !JSON.stringify(calls).includes('rt-1'));
  const tr = tk.routes();
  const addT = await tr['tasks/add']({ title: 'Water plants', due: 'tomorrow' }, yes);
  check('add task (tier 2)', /Added: Water plants \(due TOMORROW\)/.test(addT.message) && api.tasks.L1.some((t) => t.title === 'Water plants'), addT.message);
  const done = await tr['tasks/complete']({ title: 'flights' }, yes);
  check('tick off by words', /ticked off/.test(done.message) && api.tasks.L1.find((t) => t.id === 't2').status === 'completed', done.message);
  check('completed task gone from the panel', !tk.tasks.some((t) => t.id === 't2'));
  const undo = await tk.complete('t2', true);
  check('undo brings it back', undo.id === 't2' && api.tasks.L1.find((t) => t.id === 't2').status === 'needsAction' && tk.tasks.some((t) => t.id === 't2'));
  const mv = await tr['tasks/move']({ title: 'call mum', due: 'friday' }, yes);
  check('move task to a day', /now due/.test(mv.message) && api.tasks.L1.find((t) => t.id === 't3').due, mv.message);
  tset.tasks = { lists: ['L2'] };
  await tk.refresh('lists');
  check('only chosen lists', tk.tasks.length === 1 && tk.tasks[0].list === 'Work');
  // No source: the setup walk-through; Reminders as the alternative through the (fake) EventKit helper
  kc.delete('google-tasks-refresh'); tk.hasRefresh = false; tset = {};
  k.permission = { events: 'authorized', reminders: 'notDetermined' };
  const st2 = tr['tasks/status']({}, yes);
  check('no source → setup steps', /console\.cloud\.google\.com/.test(st2.message) && /Reminders/.test(st2.message), st2.message.slice(0, 80));
  k.request = async (m) => (m.cmd === 'reminders' ? { list: [{ id: 'r1', title: 'Renew passport', due: T - DAY, allDay: true, list: 'Reminders', listId: 'RL', completed: false }], lists: [{ id: 'RL', title: 'Reminders' }] } : { reminder: { id: 'r2', title: m.title, due: m.due, list: 'Reminders' } });
  k.permission = { events: 'authorized', reminders: 'authorized' };
  const rs = tr['tasks/setup']({ source: 'reminders' }, yes);
  await tk.refresh('reminders');
  check('Reminders as the source', /Apple Reminders/.test(rs.message) && tk.source === 'reminders' && tk.tasks[0]?.title === 'Renew passport', `${rs.message} ${tk.source} ${tk.tasks.length}`);
  const ra = await tr['tasks/add']({ title: 'Buy bread', due: 'tomorrow' }, yes);
  check('add a reminder', /Added: Buy bread/.test(ra.message), ra.message);
  return { fakeCalendar };
}

module.exports = { run, fakeCalendar };
