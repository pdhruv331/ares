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

  // ---- Custom panels: specs as data, every source type with fakes, preview → keep, the usage pause -----------------------------
  const fs = require('fs'), os = require('os');
  const { CustomPanels } = require(path.join(root, 'custom-panels.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-panels-'));
  const scratch = fs.mkdtempSync(path.join(os.homedir(), 'Downloads', '.ares-panels-test-'));
  let pset = {};
  let usageOk = true;
  const claudeCalls = [];
  const cp = new CustomPanels({ dir, readSettings: () => pset, writeSettings: (p2) => Object.assign(pset, p2), log: () => {}, tier: (level, what, ctx) => { audit.push({ level, ...what }); return level === 3 && !ctx.confirm?.().allow ? { message: 'Not confirmed yet.' } : null; },
    oneShot: async (prompt) => { claudeCalls.push(prompt); return '{"text": "Markets are calm today."}'; }, usage: { reserve: () => (usageOk ? { ok: true } : { ok: false, why: 'the 5-hour Claude limit is at 92%' }) },
    isPublicUrl: async (u) => !/localhost|127\.0\.0\.1/.test(u), classify: (p2) => (p2.startsWith(scratch) ? 'inside' : p2.includes('.ssh') ? 'blocked' : 'outside'),
    providers: { weather: () => ({ value: '14°', label: 'RAIN · London' }), tasks: () => ({ items: [{ text: 'Buy milk', status: 'TODAY' }] }) } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/coingecko/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ bitcoin: { usd: 64321.5 } }) };
    if (/rss/.test(url)) return { ok: true, status: 200, text: async () => '<rss><channel><item><title>First story</title><link>https://x.test/1</link></item><item><title>Second &amp; third</title></item></channel></rss>' };
    return { ok: false, status: 500, text: async () => '' };
  };
  try {
    cp.load();
    const bad = (() => { try { cp.validate({ title: 'x', template: 'iframe', source: { type: 'static', value: 1 } }); return null; } catch (e) { return e.message; } })();
    check('spec validation: unknown template refused', /template must be/.test(bad), bad);
    const badSrc = (() => { try { cp.validate({ title: 'x', template: 'value', source: { type: 'eval', code: 'rm -rf' } }); return null; } catch (e) { return e.message; } })();
    check('spec validation: unknown source refused', /source\.type/.test(badSrc), badSrc);
    const creds = (() => { try { cp.validate({ title: 'x', template: 'value', source: { type: 'url', url: 'https://user:pw@x.test/a' } }); return null; } catch (e) { return e.message; } })();
    check('spec validation: credentials in URLs refused', /credentials/.test(creds), creds);
    const r = cp.routes();
    // url + pick → value
    const pv1 = await r['panels/preview']({ title: 'BTC', template: 'value', source: { type: 'url', url: 'https://api.coingecko.com/x', pick: 'bitcoin.usd', unit: 'USD' }, refresh: 600 }, yes);
    check('preview from a JSON URL', /Preview up/.test(pv1.message) && cp.view().some((v) => v.preview && v.id === 'btc' && v.data.value === '64321.5'), pv1.message.slice(0, 120));
    check('nothing saved before keep', !fs.existsSync(path.join(dir, 'btc.json')));
    const kept = r['panels/keep']({ id: 'btc', pin: true }, yes);
    check('keep saves the spec (pinned)', /Kept "BTC", pinned/.test(kept.message) && JSON.parse(fs.readFileSync(path.join(dir, 'btc.json'), 'utf8')).pinned === true, kept.message);
    // RSS → list
    const pv2 = await r['panels/preview']({ title: 'NEWS', template: 'list', source: { type: 'url', url: 'https://feeds.test/rss' } }, yes);
    const news = cp.view().find((v) => v.id === 'news');
    check('RSS feed → list items', news?.data.items.length === 2 && news.data.items[1].text === 'Second & third', JSON.stringify(news?.data));
    check('discard drops the preview', r['panels/discard']({ id: 'news' }, yes).message === 'Discarded.' && !cp.view().some((v) => v.id === 'news'));
    // private URL refused
    const pv3 = await r['panels/preview']({ title: 'LOCAL', template: 'value', source: { type: 'url', url: 'http://localhost:8080/x' } }, yes);
    check('private host refused with a quiet reason', /source failed: only public hosts/.test(pv3.message), pv3.message.slice(0, 120));
    // file inside the scope; outside refused
    fs.writeFileSync(path.join(scratch, 'count.json'), JSON.stringify({ open: 7, max: 10 }));
    const pv4 = await r['panels/preview']({ title: 'OPEN', template: 'gauge', source: { type: 'file', path: path.join(scratch, 'count.json'), pick: 'open', max: 10 } }, yes);
    const open = cp.view().find((v) => v.id === 'open');
    check('file source → gauge', open?.data.value === '7' && Math.abs(open.data.gauge - 0.7) < 1e-9, JSON.stringify(open?.data));
    const pv5 = await r['panels/preview']({ title: 'KEYS', template: 'text', source: { type: 'file', path: '~/.ssh/id_rsa' } }, yes);
    check('blocked file refused', /off limits/.test(pv5.message), pv5.message.slice(0, 120));
    // shell: tier 3 the first time, then allowlisted
    const held = await r['panels/preview']({ title: 'DISK', template: 'value', source: { type: 'shell', command: 'df -h / | tail -1 | awk \'{print $5}\'' } }, no);
    check('shell command held for a yes the first time', /Not confirmed/.test(held.message) && !(pset.panels?.allowedCommands || []).length, held.message.slice(0, 100));
    const ok = await r['panels/preview']({ title: 'DISK', template: 'value', source: { type: 'shell', command: 'df -h / | tail -1 | awk \'{print $5}\'' } }, yes);
    const disk = cp.view().find((v) => v.id === 'disk');
    check('shell command allowed with a yes and run', /Preview up/.test(ok.message) && /\d+%/.test(disk?.data.value || ''), `${ok.message.slice(0, 80)} ${JSON.stringify(disk?.data)}`);
    check('allowlist persisted per command', (pset.panels.allowedCommands || []).length === 1);
    // builtin providers
    await r['panels/preview']({ title: 'WEATHER', template: 'value', source: { type: 'builtin', provider: 'weather' } }, yes);
    check('built-in provider', cp.view().find((v) => v.id === 'weather')?.data.value === '14°');
    // countdown
    await r['panels/preview']({ title: 'FLIGHT', template: 'countdown', source: { type: 'static', value: { target: '2026-10-30T07:00', label: 'Lisbon' } }, kind: 'needs' }, yes);
    check('countdown target parsed', cp.view().find((v) => v.id === 'flight')?.data.target === new Date(2026, 9, 30, 7).getTime());
    // ask Claude: min refresh 30 min, pauses near the limit
    const ac = await r['panels/preview']({ title: 'MARKETS', template: 'text', source: { type: 'claude', prompt: 'How are the markets?' }, refresh: 60 }, yes);
    const mk = cp.view().find((v) => v.id === 'markets');
    check('ask Claude one-shot, refresh clamped to 30 min', claudeCalls.length === 1 && mk?.refresh === 1800 && mk.data.text === 'Markets are calm today.', `${claudeCalls.length} ${mk?.refresh}`);
    r['panels/keep']({ id: 'markets' }, yes);
    usageOk = false;
    await cp.refresh(cp.specs.get('markets'));
    check('ask Claude pauses near the usage limit (— with the reason)', claudeCalls.length === 1 && /paused: the 5-hour/.test(cp.states.get('markets').error), cp.states.get('markets').error);
    usageOk = true;
    // edit + remove + toggle
    const ed = await r['panels/edit']({ name: 'BTC', refresh: 1200, kind: 'work' }, yes);
    check('edit a kept panel', /every 1200s/.test(ed.message) && cp.specs.get('btc').kind === 'work', ed.message);
    check('toggle off', /is off/.test(r['panels/toggle']({ name: 'btc', on: false }, yes).message) && cp.specs.get('btc').enabled === false);
    check('remove', /Removed "BTC"/.test(r['panels/remove']({ name: 'btc' }, yes).message) && !fs.existsSync(path.join(dir, 'btc.json')));
    // reload from disk
    const cp2 = new CustomPanels({ dir, readSettings: () => pset, writeSettings: () => {}, log: () => {}, tier: () => null });
    check('specs reload from disk', cp2.load() === 1 && cp2.specs.has('markets'));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { fakeCalendar };
}

module.exports = { run, fakeCalendar };
