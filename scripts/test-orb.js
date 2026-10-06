// The corner orb (orb.js, docs/orb-prompt.md §9) without the brain, the listener or the installed app, in a bare Electron
// process:   npx electron scripts/test-orb.js
// Fakes stand in for the listener, power, autonomy, jobs, memory, tasks, usage and the window hooks; control.js is the
// real one (scope rules) with a scratch folder in ~/Downloads (removed after), the push to the phone is faked. The orb's
// own window IS created (transparent, in the corner, for ~5 s) so hits and interactivity are the real thing. No Claude
// call, nothing spoken, nothing sent anywhere.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.homedir(), 'Downloads', '.ares-orb-test-'));
const support = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-orb-support-'));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`); if (!ok) failures++; };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {}); // (the orb's window comes and goes: the test decides when to exit)
app.whenReady().then(async () => {
  const { Orb } = require(path.join(root, 'orb.js'));
  const { Control } = require(path.join(root, 'control.js'));
  const log = [];
  let settings = { control: { folders: [] }, theme: { orb: { enabled: true, corner: 'br', hideFullscreen: true } } };
  const pushed = [];
  const control = new Control({
    helper: path.join(root, 'native/build/ares-control'), themeHelper: path.join(root, 'native/build/ares-theme'),
    supportDir: support, appDir: root, readSettings: () => settings, writeSettings: (p) => Object.assign(settings, p), log: () => {},
    push: async (n) => { pushed.push(n); return 1; }, phoneUrl: () => 'https://mac.example.ts.net', notice: () => {},
  });
  const listener = Object.assign(new EventEmitter(), { sent: [], listens: [], listen(ms, trusted) { this.listens.push({ ms, trusted }); }, send(c) { this.sent.push(c); } });
  const power = { mode: 'online', opts: { sounds: true }, standby(on, why) { this.mode = on ? 'standby' : 'online'; this.why = why; return true; } };
  const autonomy = Object.assign(new EventEmitter(), { paused: false, stopAll(why) { this.paused = true; this.why = why; return ['Report', 'Site']; }, resumeAll() { this.paused = false; } });
  const jobs = Object.assign(new EventEmitter(), {
    jobs: [], answers: [],
    list() { return this.jobs; },
    start(o) { const j = { id: `j${this.jobs.length + 1}`, status: 'running', started: Date.now(), ...o }; this.jobs.push(j); return j; },
    answer(id, yes, why) { this.answers.push({ id, yes, why }); const j = this.jobs.find((x) => x.id === id); if (j) { j.status = 'running'; j.approval = null; } },
  });
  const memory = { facts: [], add(f) { this.facts.push(f); return f; } };
  const tasks = { added: [], async add(t) { this.added.push(t); } };
  const usage = { pct: 10, snapshot() { return { windows: { five_hour: { pct: this.pct, resetsAt: Date.now() + 3600e3 } } }; } };
  const sessions = { list() { return [{ id: 's1', title: 'Fix the tests', status: 'permission', detail: 'wants to run npm test' }]; } };
  const hooks = { calls: [], summon() { this.calls.push('summon'); }, dismiss() { this.calls.push('dismiss'); }, sendWindow(ch, m) { this.calls.push(`${ch}:${JSON.stringify(m)}`); },
    openView(v) { this.calls.push(`open:${v}`); }, stopSpeaking() { this.calls.push('stop'); }, ask(t) { this.calls.push(`ask:${t.slice(0, 40)}`); }, silentNow: async () => false, liveCall: () => null, ownIds: ['com.github.Electron'] };
  const orb = new Orb({ appDir: root, helper: path.join(root, 'native/build/ares-theme'), log: (...p) => log.push(p), readSettings: () => settings, writeSettings: (p) => Object.assign(settings, p),
    deps: { listener, power, autonomy, jobs, control, memory, tasks, usage, sessions }, hooks });
  // What the page is told
  const sent = [];
  const origSend = orb.send.bind(orb);
  orb.send = (m) => { sent.push(m); origSend(m); };
  const last = (type) => [...sent].reverse().find((m) => m.type === type);
  orb.refocus = () => { hooks.calls.push('refocus'); };

  orb.start();
  await tick(1500); // the page loads and reports its hits
  check('window created in the bottom-right corner', orb.win && orb.win.getBounds().x > 0 && orb.win.getBounds().y > 0, JSON.stringify(orb.win?.getBounds()));

  // ---- visibility ---------------------------------------------------------------------------------------------
  orb.setContext({ summoned: false, brain: false, power: 'online', fullscreen: false });
  check('shown when the desktop is covered', orb.visible && orb.on);
  orb.setContext({ brain: true });
  check('hidden when the desktop reactor is visible', !orb.visible);
  orb.setContext({ brain: false, summoned: true });
  check('hidden when ARES is lifted', !orb.visible);
  orb.setContext({ summoned: false, power: 'standby' });
  check('shown (dim) in standby', orb.visible && last('power')?.mode === 'standby');
  orb.setContext({ power: 'dormant' });
  check('gone when offline (dormant)', !orb.visible);
  orb.setContext({ power: 'online', fullscreen: true });
  check('hidden in a full-screen Space (setting on)', !orb.visible);
  settings.theme.orb.hideFullscreen = false;
  orb.update();
  check('…shown there with the setting off', orb.visible);
  settings.theme.orb.hideFullscreen = true;
  orb.setContext({ fullscreen: false });
  check('shown again', orb.visible && orb.on);
  check('standby/online push the power mode to the page', last('power')?.mode === 'online');

  // ---- click-through and hits ---------------------------------------------------------------------------------
  await tick(300);
  check('the page reported the orb circle as its hit area', orb.hits.rects.length >= 1 && !orb.hits.all, JSON.stringify(orb.hits));
  check('click-through everywhere else (not interactive with the pointer away)', orb.interactive === false);
  const c = orb.centre();
  const r0 = orb.hits.rects[0];
  check('the hit rect is centred on the orb', r0 && Math.abs(r0.x + r0.w / 2 + orb.win.getBounds().x - c.x) < 3 && Math.abs(r0.y + r0.h / 2 + orb.win.getBounds().y - c.y) < 3, JSON.stringify({ r0, c }));
  // Caret proximity: a caret 20 pt from the orb fades it; one 200 pt away doesn't
  check('caret near → fade', orb.test('caret', { rect: [c.x - 36, c.y - 10, 2, 16] }) === true && last('caret')?.near === true);
  check('caret far → no fade', orb.test('caret', { rect: [c.x - 300, c.y - 10, 2, 16] }) === false && last('caret')?.near === false);
  check('no caret → no fade', orb.test('caret', { rect: null }) === false);
  // Drag reach: with a drag in progress the window takes the drop near the orb (the pointer here is wherever it is; the rule is checked directly)
  orb.drag = { on: true, files: true }; orb.dragNear = -1;
  orb.check();
  check('a drag in progress tells the page (swell as it nears)', last('drag')?.on === true && typeof last('drag').near === 'number');
  orb.drag = { on: false }; orb.send({ type: 'drag', on: false }); orb.check();

  // ---- the portal -----------------------------------------------------------------------------------------------
  hooks.calls.length = 0;
  await orb.portal(true, 'test');
  check('portal open: the window is told where the circle grows from, then summoned', hooks.calls[0]?.startsWith('portal:{"open":true') && hooks.calls.includes('summon'), hooks.calls.join(' | '));
  check('the orb stays while the portal is open (summoned)', (orb.surface('lifted'), orb.visible && orb.portalOpen));
  hooks.calls.length = 0;
  await orb.portal(false, 'test');
  check('portal close: the window runs the circle back…', hooks.calls[0] === 'portal:{"open":false}');
  await tick(1000);
  check('…then sinks and the previous app gets focus back', hooks.calls.includes('dismiss') && hooks.calls.indexOf('refocus') > hooks.calls.indexOf('dismiss'), hooks.calls.join(' | '));
  orb.surface('desktop');
  // Sunk some other way (Esc, a click elsewhere): the portal state clears
  await orb.portal(true, 'test'); orb.surface('lifted'); hooks.calls.length = 0;
  orb.surface('desktop');
  check('sunk by Esc: the portal closes without the reveal and refocuses', !orb.portalOpen && hooks.calls.includes('refocus') && last('portal')?.open === false);

  // ---- push-to-talk ---------------------------------------------------------------------------------------------
  listener.listens.length = 0; listener.sent.length = 0;
  await orb.act({ type: 'hold' });
  check('hold: the listener captures without the wake word, Voice ID still applies (not trusted)', listener.listens.length === 1 && listener.listens[0].trusted === false && orb.ptt === 'listening', JSON.stringify(listener.listens));
  check('…and the page shows "listening… release to send"', last('ptt')?.phase === 'listening');
  await orb.act({ type: 'release' });
  check('release: the capture is finished now', listener.sent.includes('finish') && orb.ptt === 'thinking');
  orb.listenerEvent({ type: 'command', text: 'what time is it' });
  check('the command came: thinking', orb.ptt === 'thinking' && orb.turnActive);
  orb.scene({ type: 'state', state: 'speaking' });
  check('her answer: the turn is still the orb\'s until it ends', orb.turnActive);
  orb.turnDone();
  check('reply done: the turn is over', !orb.turnActive && orb.ptt === null);
  await orb.act({ type: 'hold' }); orb.listenerEvent({ type: 'timeout' });
  check('a hold with nothing said clears quietly', orb.ptt === null && last('ptt')?.phase === null);
  // Click while she speaks = stop her
  hooks.calls.length = 0;
  orb.scene({ type: 'state', state: 'speaking' });
  await orb.act({ type: 'click' });
  check('click while speaking stops her, "Stopped." flashes', hooks.calls.includes('stop') && last('flash')?.text === 'Stopped.' && !hooks.calls.includes('summon'));
  orb.scene({ type: 'state', state: 'idle' });

  // ---- captions ----------------------------------------------------------------------------------------------
  sent.length = 0;
  orb.scene({ type: 'caption', segs: [['Good', 'evening,', 'sir.']], starts: [[0, 0.3, 0.7]], total: 3, n: 0, clock: { t: 0, start: 0, end: 2 } });
  orb.scene({ type: 'caption', n: 3, done: true });
  check('captions reach the page while the orb shows', sent.filter((m) => m.type === 'caption').length === 2 && sent[0].segs?.[0].length === 3);
  orb.setContext({ brain: true }); sent.length = 0;
  orb.scene({ type: 'caption', segs: [['x']], starts: [[0]], total: 1, n: 0 });
  check('…and not while it\'s hidden', !sent.some((m) => m.type === 'caption'));
  orb.setContext({ brain: false });

  // ---- the quick menu --------------------------------------------------------------------------------------------
  await orb.act({ type: 'menu', act: 'stopall' });
  check('Stop everything: the kill switch, a red card with the count and RESUME', autonomy.paused && last('card')?.card.label === 'ALL WORK PAUSED' && /2 jobs/.test(last('card').card.title) && last('card').card.actions[0].act === 'resume');
  await orb.act({ type: 'card', id: last('card').card.id, act: 'resume' });
  check('RESUME resumes everything', !autonomy.paused && last('card')?.card.label === 'RESUMED');
  await orb.act({ type: 'menu', act: 'standby' });
  check('Standby: the ignition standby', power.mode === 'standby' && power.why === 'orb menu' && last('card')?.card.label === 'STANDING BY');
  power.mode = 'online';
  await orb.act({ type: 'menu', act: 'mute' });
  check('Mute for 1 hour: speech muted, pushes untouched', orb.speechMuted && last('card')?.card.label === 'MUTED FOR 1 HOUR');
  await orb.act({ type: 'card', id: last('card').card.id, act: 'unmute' });
  check('UNMUTE', !orb.speechMuted);
  hooks.calls.length = 0;
  await orb.act({ type: 'menu', act: 'work' });
  check('Open Work', hooks.calls.includes('open:work'));
  hooks.calls.length = 0;
  await orb.act({ type: 'menu', act: 'screen' });
  check('What\'s on my screen? asks the brain through the window (look_at_screen)', hooks.calls.some((x) => x.startsWith("ask:What's on my screen")) && orb.turnActive);
  orb.turnDone();
  hooks.calls.length = 0;
  await orb.act({ type: 'menu', act: 'open' });
  check('Open ARES: the portal', orb.portalOpen && hooks.calls.includes('summon'));
  await orb.portal(false); await tick(700); orb.surface('desktop');

  // ---- signals -------------------------------------------------------------------------------------------------------
  jobs.jobs.push({ id: 'p1', title: 'Website', status: 'running', project: {}, started: Date.now() - 5000, progress: { done: 3, total: 4 } });
  orb.refresh();
  check('job progress: the main running job (a project) fills the ring', Math.abs(last('signals').job.progress - 0.75) < 0.01 && last('signals').job.title === 'Website');
  jobs.jobs.push({ id: 'a1', title: 'Send the email', status: 'approval', approval: { what: 'email the team' }, started: Date.now() });
  orb.refresh();
  check('needs me: approvals + a Claude session waiting', last('signals').needs.count === 2 && orb.needs.items[0].kind === 'approval');
  hooks.calls.length = 0;
  await orb.act({ type: 'click' });
  check('click → the request card with APPROVE / REVIEW (no portal)', last('card')?.card.label === 'NEEDS YOUR OK' && last('card').card.actions.map((a) => a.act).join() === 'approve,review' && !hooks.calls.includes('summon'));
  await orb.act({ type: 'card', id: last('card').card.id, act: 'approve' });
  check('APPROVE goes through the jobs flow', jobs.answers.length === 1 && jobs.answers[0].id === 'a1' && jobs.answers[0].yes === true);
  orb.refresh();
  check('…and the count drops', last('signals').needs.count === 1);
  await orb.act({ type: 'click' });
  check('next: the Claude session waiting, REVIEW opens Work', last('card')?.card.label === 'CLAUDE CODE' && (await orb.act({ type: 'card', id: last('card').card.id, act: 'review' }), hooks.calls.includes('open:work')));
  orb.callEvent({ kind: 'inbound', name: 'Sam', line: 'Sam called about Friday.' });
  check('incoming call: green signal + card', last('signals').call?.name === 'Sam' && last('card')?.card.label === 'INCOMING CALL');
  orb.callNote = null;
  usage.pct = 85; orb.usageWarn({ window: 'five_hour', label: '5-hour', pct: 85, resetsAt: Date.now() + 3600e3 });
  check('usage 85%: amber tint + a one-time card with the reset time', last('signals').usage.pct === 85 && last('card')?.card.label === 'CLAUDE 85%' && /Resets/.test(last('card').card.detail));
  sent.length = 0; orb.usageWarn({ window: 'five_hour', label: '5-hour', pct: 85, resetsAt: Date.now() + 3600e3 });
  check('…only once', !sent.some((m) => m.type === 'card'));
  usage.pct = 96; orb.usageWarn({ window: 'five_hour', label: '5-hour', pct: 96, resetsAt: Date.now() + 3600e3 });
  check('usage 96%: a stronger card', last('signals').usage.pct === 96 && last('card')?.card.label === 'CLAUDE 96%');
  usage.pct = 10; orb.refresh();

  // ---- drops ----------------------------------------------------------------------------------------------------------
  fs.writeFileSync(path.join(scratch, 'notes.txt'), 'Hello from the orb test.\n');
  const inside = path.join(scratch, 'notes.txt');
  orb.drop({ files: [inside] });
  check('a dropped file: four chips', last('chips')?.items.map((i) => i.act).join() === 'summarise,phone,project,ask' && last('chips').hint === 'notes.txt');
  await orb.act({ type: 'chip', id: last('chips').id, act: 'summarise' });
  const sj = jobs.jobs[jobs.jobs.length - 1];
  check('SUMMARISE starts a job with the file as input', sj.title === 'Summary: notes' && sj.inputs[0] === inside && last('card')?.card.label === 'ON IT');
  sj.status = 'done'; sj.summary = 'It says hello from the orb test. That is all.';
  orb.jobFinished(sj);
  check('…its result comes back as a card with OPEN', last('card')?.card.label === 'SUMMARY READY' && last('card').card.actions[0].act === 'open' && /hello/.test(last('card').card.detail));
  hooks.calls.length = 0;
  await orb.act({ type: 'card', id: last('card').card.id, act: 'open' });
  check('OPEN shows the job', hooks.calls.includes(`open:job:${sj.id}`));
  orb.drop({ files: [inside] }); pushed.length = 0;
  await orb.act({ type: 'chip', id: last('chips').id, act: 'phone' });
  check('SEND TO PHONE: the sendbox + a push', pushed.length === 1 && pushed[0].buttons?.[0].file?.name === 'notes.txt' && last('card')?.card.label === 'SENT TO PHONE', JSON.stringify(last('card')?.card));
  orb.drop({ files: [inside] }); hooks.calls.length = 0;
  await orb.act({ type: 'chip', id: last('chips').id, act: 'project' });
  check('START PROJECT: the brain is asked for a brief (tier 3 stays with the brain) and the portal opens', hooks.calls.some((x) => x.startsWith('ask:I dropped')) && orb.portalOpen);
  await orb.portal(false); await tick(700); orb.surface('desktop'); orb.turnDone();
  orb.drop({ files: [inside] }); listener.listens.length = 0;
  await orb.act({ type: 'chip', id: last('chips').id, act: 'ask' });
  check('ASK ABOUT IT…: listening, with the file as the next question\'s context', listener.listens.length === 1 && /notes\.txt/.test(orb.takeContext()) && orb.takeContext() === '');
  orb.listenerEvent({ type: 'timeout' });
  // Out of scope: asks first
  const outside = path.join(os.homedir(), 'Projects-orb-test-does-not-exist', 'x.txt');
  orb.drop({ files: [outside] });
  await orb.act({ type: 'chip', id: last('chips').id, act: 'phone' });
  check('an out-of-scope file asks first (ALLOW ONCE / CANCEL)', last('card')?.card.label === 'OUTSIDE MY FOLDERS' && last('card').card.actions[0].act === 'allow');
  const blocked = path.join(os.homedir(), '.ssh', 'id_rsa');
  orb.drop({ files: [blocked] });
  await orb.act({ type: 'chip', id: last('chips').id, act: 'summarise' });
  check('a blocked path is refused', last('card')?.card.label === "CAN'T TAKE THAT" && !jobs.jobs.some((j) => (j.inputs || []).includes(blocked)));
  // Text and a URL
  orb.drop({ text: 'Call the dentist on Monday' });
  check('dropped text: explain / memory / tasks / phone', last('chips')?.items.map((i) => i.act).join() === 'explain,memory,tasks,phone');
  await orb.act({ type: 'chip', id: last('chips').id, act: 'memory' });
  check('SAVE TO MEMORY', memory.facts[0] === 'Call the dentist on Monday' && last('card')?.card.label === 'REMEMBERED');
  orb.drop({ text: 'Call the dentist on Monday' });
  await orb.act({ type: 'chip', id: last('chips').id, act: 'tasks' });
  check('ADD TO TASKS', tasks.added[0]?.title === 'Call the dentist on Monday' && last('card')?.card.label === 'ADDED TO TASKS');
  orb.drop({ text: 'https://example.com/page', url: 'https://example.com/page' }); pushed.length = 0;
  check('a URL: the hostname as the hint', last('chips')?.hint === 'example.com');
  await orb.act({ type: 'chip', id: last('chips').id, act: 'phone' });
  check('SEND TO PHONE (link): a push with Open', pushed.length === 1 && pushed[0].buttons?.[0].url === 'https://example.com/page' && last('card')?.card.label === 'SENT TO PHONE');
  orb.drop({ text: 'https://example.com/page', url: 'https://example.com/page' }); hooks.calls.length = 0;
  await orb.act({ type: 'chip', id: last('chips').id, act: 'explain' });
  check('EXPLAIN asks the brain', hooks.calls.some((x) => x.startsWith('ask:Explain this page')));
  orb.turnDone();

  // ---- settings ---------------------------------------------------------------------------------------------------------
  orb.save({ corner: 'tl' });
  await tick(100);
  const tl = orb.win.getBounds();
  check('corner setting moves the window (top-left)', tl.y < 100 && last('corner')?.corner === 'tl', JSON.stringify(tl));
  orb.save({ enabled: false });
  check('switched off: no window', !orb.win);
  orb.save({ enabled: true, corner: 'br' });
  await tick(300);
  check('switched on again', Boolean(orb.win));
  check('the Theme Options lines', orb.menu(() => {}).map((m) => m.label).join() === 'Corner Orb,Orb Corner,Hide the Orb in Full Screen');

  orb.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(support, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall ok');
  app.exit(failures ? 1 : 0);
}).catch((err) => { console.error(err); app.exit(2); });
