// Autonomy (docs/autonomy-prompt.md, parts 1-5) without the installed app or a real Claude session:
//   node scripts/test-autonomy.js            fast checks with a fake job runner (no Claude usage)
//   node scripts/test-autonomy.js --real     also runs ONE tiny real project with Claude Code (haiku) in a temp folder
// Covers: project workspaces (never inside ~/My AI), the brief gate, pause/resume, the kill switch, caps and the
// run-per-day limit, routine schedules and triggers, goal step sequencing, tier 3 for git push in a code session,
// the audit log, and suggestions that never create a routine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..', 'src'); // the app's code
const { Autonomy } = require(path.join(root, 'autonomy.js'));
const { Audit } = require(path.join(root, 'audit.js'));
const sandbox = require(path.join(root, 'worker-sandbox.js'));
const support = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-auto-'));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  ${String(detail).replace(/\s+/g, ' ').slice(0, 150)}` : ''}`); if (!ok) failures++; };

/** A stand-in for jobs.js: the same surface autonomy.js uses, with jobs that finish when the test says so. */
class FakeJobs extends EventEmitter {
  constructor() { super(); this.jobs = []; this.limits = () => ({ maxProjects: 1, maxJobs: 2 }); this.audit = null; this.dir = support; this.running_ = new Set(); }
  get running() { return this.jobs.filter((j) => j.status === 'running' || j.status === 'approval'); }
  get active() { return this.jobs.filter((j) => ['running', 'approval', 'queued'].includes(j.status)); }
  get paused() { return this.jobs.filter((j) => j.status === 'paused'); }
  get(id) { return this.jobs.find((j) => j.id === id) || null; }
  view(j) { return j; }
  folder(id) { return path.join(support, id); }
  events() { return []; }
  save() {}
  start(o) { const j = { id: `j${this.jobs.length + 1}`, status: 'running', steps: 0, summary: '', turns: [], ...o, ...(o.project ? { project: { phase: 'plan', note: 'starting', tests: null, commit: null, run: null, url: null, iteration: 0, verified: null, ...o.project } } : {}) }; this.jobs.push(j); fs.mkdirSync(this.folder(j.id), { recursive: true }); this.emit('change', j); return j; }
  continue(id, text, source) { const j = this.get(id); j.status = 'running'; j.turns.push({ text, source }); return j; }
  cancel(id) { const j = this.get(id); if (!j || !this.active.includes(j)) return false; j.status = 'cancelled'; return true; }
  pause(id, why) { const j = this.get(id); if (!j || !['running', 'approval', 'queued'].includes(j.status)) return false; j.status = 'paused'; j.pausedWhy = why; return true; }
  resume(id) { const j = this.get(id); if (!j || j.status !== 'paused') return false; j.status = 'running'; return true; }
  pump() {}
  syncProject() {}
  finish(id, status = 'done', summary = 'done it') { const j = this.get(id); j.status = status; j.summary = summary; this.emit('finished', j); }
}

(async () => {
  const jobs = new FakeJobs();
  const audit = new Audit(path.join(support, 'audit.jsonl'));
  const pushed = [];
  let planAnswer = JSON.stringify({ title: 'Cheaper plan', steps: [{ title: 'List plans', task: 'Find the current plans', kind: 'job' }, { title: 'Compare', task: 'Compare them to the user\'s usage', kind: 'job' }, { title: 'Recommend', task: 'Pick one and explain', kind: 'job' }] });
  let gradeAnswer = JSON.stringify({ pass: true, notes: '' });
  let settings = {};
  const a = new Autonomy({
    jobs, audit, supportDir: support, readSettings: () => settings, writeSettings: (p) => Object.assign(settings, p), log: () => {},
    oneShot: async (prompt, { system }) => (system.includes('verifier') ? gradeAnswer : planAnswer),
    push: async (n) => { pushed.push(n); return 1; }, notice: () => {}, phoneUrl: () => 'https://mac.example.ts.net', cli: '/usr/bin/true',
  });
  const owner = { source: 'phone', verified: true, turn: 1, confirm: () => ({ allow: true, said: 'yes' }) };
  const noYes = { ...owner, confirm: () => ({ allow: false, message: 'Not confirmed yet.' }) };
  const stranger = { ...owner, verified: false };

  // ---- Projects --------------------------------------------------------------------------------------------
  const heldBrief = await a.handle('project/start', { title: 'Screenshot renamer', goal: 'Rename screenshots by date', definition_of_done: 'A script that renames files' }, noYes);
  check('a project waits for the user to agree the brief', /Not started yet/.test(heldBrief.message), heldBrief.message);
  const noDod = await a.handle('project/start', { title: 'X', goal: 'Y' }, owner);
  check('a project needs a definition of done', /definition of done/.test(noDod.message), noDod.message);
  const notOwner = await a.handle('project/start', { title: 'X', goal: 'Y', definition_of_done: 'Z' }, stranger);
  check('a project needs the owner', /Refused/.test(notOwner.message), notOwner.message);
  const PROJECTS = path.join(os.homedir(), 'ARES Projects');
  const started = await a.handle('project/start', { title: 'Autonomy test project', goal: 'Rename screenshots by date', constraints: 'Python', definition_of_done: 'A script that renames files' }, owner);
  const pj = jobs.jobs.find((j) => j.project);
  check('project started as a code job in ~/ARES Projects', Boolean(pj) && pj.kind === 'code' && pj.folder.startsWith(PROJECTS) && pj.size === 'project', started.message);
  check('project workspace is a git repo with the brief', fs.existsSync(path.join(pj.folder, '.git')) && fs.readFileSync(path.join(pj.folder, 'BRIEF.md'), 'utf8').includes('Definition of done'));
  check('project is never inside ~/My AI', !pj.folder.toLowerCase().includes('/my ai/'));
  const st = await a.handle('project/status', { project: 'autonomy test' }, owner);
  check('project status answers', /phase plan/.test(st.message), st.message);
  check('pause', /Paused/.test((await a.handle('project/control', { project: 'it', action: 'pause' }, owner)).message) && pj.status === 'paused');
  check('resume', /Resumed/.test((await a.handle('project/control', { project: 'it', action: 'resume' }, owner)).message) && pj.status === 'running');
  // Verification: a failing grade sends the session back once; a passing one delivers to the phone
  gradeAnswer = JSON.stringify({ pass: false, notes: 'No tests were written.' });
  pj.status = 'done'; pj.summary = 'Wrote the script.';
  await a.onFinished(pj);
  check('a failed verification continues the session with the notes', pj.project.iteration === 1 && pj.turns.some((t) => /Verification/.test(t.text)), JSON.stringify(pj.turns));
  gradeAnswer = JSON.stringify({ pass: true, notes: '' });
  pj.status = 'done';
  await a.onFinished(pj);
  check('a passing verification marks it verified and sends it to the phone', pj.project.verified === true && pushed.some((p) => /Project:/.test(p.title)), JSON.stringify(pushed.map((p) => p.title)));
  check('project zip made for the phone', fs.existsSync(path.join(jobs.folder(pj.id), `${pj.project.slug}.zip`)));
  fs.rmSync(pj.folder, { recursive: true, force: true }); // tidy the real folder the test made

  // ---- Tiers in code sessions: git push is tier 3, installs tier 2, edits tier 1 ------------------------------------
  check('git push needs a yes (tier 3)', sandbox.classifyCode('git push -u origin main') === 'ask');
  check('vercel deploy needs a yes', sandbox.classifyCode('npx vercel --prod') === 'ask');
  check('npm install is tier 2', sandbox.classifyCode('npm install express') === 'install');
  check('running tests is tier 1', sandbox.classifyCode('npm test') === 'allow');

  // ---- Goals ---------------------------------------------------------------------------------------------------------
  const g = await a.handle('goal/set', { goal: 'find me a cheaper phone plan' }, owner);
  const goal = a.state.goals[0];
  check('goal planned into steps and the first runs as a job', /3 steps/.test(g.message) && goal.steps[0].jobId && jobs.get(goal.steps[0].jobId).source === 'goal', g.message);
  jobs.finish(goal.steps[0].jobId, 'done', 'Three plans found.');
  await new Promise((r) => setTimeout(r, 20));
  check('step 2 starts when step 1 finishes, with step 1\'s result in its brief', goal.current === 1 && goal.steps[1].jobId && /Three plans found/.test(jobs.get(goal.steps[1].jobId).task));
  jobs.finish(goal.steps[1].jobId, 'failed', '');
  await new Promise((r) => setTimeout(r, 20));
  check('a failed step leaves the goal stuck and tells the phone', goal.status === 'stuck' && pushed.some((p) => /Goal stuck/.test(p.title)));
  check('cancel goal', /Cancelled/.test((await a.handle('goal/cancel', { goal: 'cheaper' }, owner)).message) && goal.status === 'cancelled');

  // ---- Routines ---------------------------------------------------------------------------------------------------------
  const r1 = await a.handle('routine/create', { title: 'Morning brief', task: 'Brief me on my day', every: 'weekday', at: '8am' }, owner);
  const rt = a.state.routines[0];
  check('weekday routine at 8', /weekdays at 08:00/.test(r1.message) && rt.schedule.days.join() === '1,2,3,4,5' && rt.schedule.hour === 8, r1.message);
  check('next run is in the future on a weekday', (() => { const d = new Date(a.nextRun(rt)); return d.getTime() > Date.now() && d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() === 8; })());
  const r2 = await a.handle('routine/create', { title: 'Mail check', task: 'Check for important email', every: '30 minutes' }, owner);
  check('interval routine', /every 30 minutes/.test(r2.message), r2.message);
  const bad = await a.handle('routine/create', { title: 'x', task: 'y', every: '2 minutes' }, owner);
  check('too-frequent interval refused', /at least every 10/.test(bad.message), bad.message);
  const r3 = await a.handle('routine/create', { title: 'On wake', task: 'Check the calendar', on: 'wake' }, owner);
  check('event routine', /when the Mac wakes/.test(r3.message), r3.message);
  const before = jobs.jobs.length;
  a.event('wake');
  check('a wake event runs its routine as a job', jobs.jobs.length === before + 1 && jobs.jobs[jobs.jobs.length - 1].source === 'routine');
  a.event('wake');
  check('the same event within the hour does not run it again', jobs.jobs.length === before + 1);
  // A due daily routine fires once, within its ten-minute slot
  const now = new Date();
  const r4 = await a.handle('routine/create', { title: 'Due now', task: 'x', every: 'day', at: `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}` }, owner);
  const dueCount = jobs.jobs.length;
  a.tickRoutines(); a.tickRoutines();
  check('a due routine fires once per slot', jobs.jobs.length === dueCount + 1, r4.message);
  check('routine off', /is off/.test((await a.handle('routine/control', { routine: 'Due now', action: 'off' }, owner)).message));
  check('routine run now', /Running/.test((await a.handle('routine/control', { routine: 'Morning', action: 'run' }, owner)).message));
  check('routine delete', /Deleted/.test((await a.handle('routine/control', { routine: 'Mail check', action: 'delete' }, owner)).message) && !a.state.routines.find((x) => x.title === 'Mail check'));

  // ---- Suggestions: a pattern is offered once, never created -------------------------------------------------------------
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
  for (const d of days) a.state.seen['what is the weather today'] = [...(a.state.seen['what is the weather today'] || []), { day: d, hour: 8.2 }];
  const note = a.suggestion();
  check('a repeated morning request yields a one-time offer note', /offer ONCE/.test(note) && /Never create a routine unasked/.test(note), note);
  check('the same pattern is not offered twice', a.suggestion() === '');
  check('no routine was created by the suggestion', !a.state.routines.find((x) => /weather/.test(x.title)));

  // ---- Limits ---------------------------------------------------------------------------------------------------------------
  settings.autonomy = { maxRunsPerDay: 1 };
  a.state.runs = { day: new Date().toISOString().slice(0, 10), n: 1 };
  const held = a.runRoutine(a.state.routines.find((x) => x.title === 'Morning brief'), 'scheduled');
  check('runs per day cap holds scheduled routines', held === null);
  check('…but a routine run on request still goes', a.runRoutine(a.state.routines.find((x) => x.title === 'Morning brief'), 'asked') !== null);
  settings.autonomy = { maxRunsPerDay: 20, usagePauseAt: 85 };
  const proj2 = jobs.start({ title: 'Running project', kind: 'code', project: { slug: 'x', brief: {} }, folder: support });
  a.usage(90);
  check('near the usage limit, running projects pause', proj2.status === 'paused' && proj2.pausedWhy === 'usage limit');
  a.usageOk();
  check('room again resumes them', proj2.status === 'running');

  // ---- The kill switch --------------------------------------------------------------------------------------------------------
  const goal2 = (await a.handle('goal/set', { goal: 'another goal' }, owner), a.state.goals[a.state.goals.length - 1]);
  const paused = a.stopAll('test');
  check('stop everything pauses every running job and project', paused.length >= 2 && jobs.running.length === 0 && a.state.paused, paused.join(', '));
  check('goals pause too', goal2.status === 'paused');
  const tick = jobs.jobs.length;
  a.tickRoutines(); a.event('wake');
  check('nothing fires while paused', jobs.jobs.length === tick);
  const blocked = await a.handle('project/start', { title: 'Nope', goal: 'x', definition_of_done: 'y' }, owner);
  check('no new project while paused', /paused/.test(blocked.message), blocked.message);
  check('resume one by name', /Resumed/.test((await a.handle('resume', { what: 'Running project' }, owner)).message) && proj2.status === 'running');
  await a.handle('resume', { what: 'everything' }, owner);
  check('resume everything', !a.state.paused && jobs.paused.length === 0 && goal2.status === 'running');

  // ---- Audit ------------------------------------------------------------------------------------------------------------------
  const log = audit.recent(200);
  check('audit has the project start (tier 3, agreed brief)', log.some((e) => /started project/.test(e.what) && e.tier === 3 && /agreed/.test(e.approval)));
  check('audit has routines and goals (tier 2) and the kill switch', log.some((e) => e.kind === 'routine' && e.tier === 2) && log.some((e) => e.kind === 'goal') && log.some((e) => /KILL SWITCH/.test(e.what)));
  const view = a.view();
  check('the panel view has projects, goals, routines, limits', Array.isArray(view.projects) && Array.isArray(view.goals) && Array.isArray(view.routines) && view.limits.maxProjects === 1);

  // ---- Optional: one real, tiny project with Claude Code (haiku) --------------------------------------------------------------
  if (process.argv.includes('--real')) {
    console.log('  -- real project run (haiku), this uses a little Claude usage…');
    process.env.ARES_CODE_MODEL = process.env.ARES_CODE_MODEL || 'haiku'; // before jobs.js reads it
    const { Jobs } = require(path.join(root, 'jobs.js'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-auto-work-'));
    const { registry: workerTools } = require(path.join(root, 'worker-tools.js'));
    const cli = [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => fs.existsSync(p)) || 'claude';
    // A real bridge, so the session's edits and commands go through the real gate (tier 1 runs, tier 3 would wait)
    const { startBridge } = require(path.join(root, 'bridge.js'));
    let real;
    const bridge = await startBridge({ onTimerDone: () => {}, onPhoneAction: () => {}, onNotify: () => {}, findContact: () => ({}), memory: { add() {}, facts: () => [], forget: () => [] }, teachPhrase: () => ({}),
      work: { gate: (id, tool, input) => real.gate(id, tool, input), decision: (id) => real.decision(id) }, calls: null, claudeUsage: () => '', log: () => {} });
    real = new Jobs({ dir: workDir, cli, runtime: path.join(workDir, '.runtime'), log: (...m) => console.log('     ', ...m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))),
      tools: () => workerTools({ env: process.env, appDir: root, runtime: path.join(workDir, '.runtime'), bridge, egress: () => null }) });
    const ra = new Autonomy({ jobs: real, audit, supportDir: support, readSettings: () => ({ autonomy: { maxRunMin: 10 } }), writeSettings: () => {}, log: () => {}, oneShot: async () => JSON.stringify({ pass: true, notes: '' }), push: async () => 0, notice: () => {}, phoneUrl: () => null, cli });
    const r = await ra.handle('project/start', { title: 'Autonomy smoke test', goal: 'A tiny Node script hello.js that prints "hello from ARES", with a test script that runs it and checks the output.', definition_of_done: 'node hello.js prints hello from ARES; npm test passes; both committed.' }, owner);
    console.log('     ', r.message);
    const job = real.jobs.find((j) => j.project);
    await new Promise((resolve) => { real.on('finished', (j) => { if (j.id === job.id) resolve(); }); setTimeout(resolve, 9 * 60_000); });
    console.log('      status:', job.status, '| phase:', job.project.phase, '| tests:', job.project.tests, '| commit:', job.project.commit);
    check('real project finished', job.status === 'done', job.summary || job.error);
    check('real project committed in its own folder', Boolean(real.lastCommit(job)));
    fs.rmSync(job.folder, { recursive: true, force: true });
    real.shutdown();
  }

  // ---- Power routines (docs/ignition-prompt.md §4f): scheduled standby / wake, the 5-minute notice, skip tonight -----------
  {
    const acts = [];
    let mode = 'online';
    const pa = new Autonomy({
      jobs, audit, supportDir: support, readSettings: () => ({}), writeSettings: () => {}, log: () => {}, oneShot: async () => '{}',
      push: async (n) => { pushed.push(n); return 1; }, notice: () => {}, phoneUrl: () => null, cli: '/usr/bin/true',
      power: (action, why) => { acts.push(action); mode = action === 'standby' ? 'standby' : 'online'; return { ok: true, message: action }; }, powerMode: () => mode,
    });
    pa.state.paused = false; pa.state.routines = [];
    const RealDate = Date;
    const at = (h, m) => { const d = new RealDate(); d.setHours(h, m, 0, 0); return d.getTime(); };
    const freeze = (t) => { global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } }; };
    try {
      const sb = await pa.handle('routine/create', { title: 'Standby', at: '00:00', action: 'standby' }, owner);
      check('a standby routine is created without a task', /Standby scheduled: standby at 00:00/.test(sb.message), sb.message);
      const wk = await pa.handle('routine/create', { title: 'Wake', at: '7:30', action: 'wake' }, owner);
      check('a wake routine too', /Wake scheduled: wake at 07:30/.test(wk.message), wk.message);
      const again = await pa.handle('routine/create', { at: '23:30', action: 'standby' }, owner);
      check('a new standby time replaces the old one', pa.state.routines.filter((r) => r.schedule.kind === 'power' && r.schedule.action === 'standby').length === 1 && /23:30/.test(again.message), again.message);
      const sched = pa.powerSchedule();
      check('the schedule for the phone chip has both times', sched.standby === '23:30' && sched.wake === '07:30', JSON.stringify(sched));
      // 5 minutes before: the notice, once
      pushed.length = 0;
      freeze(at(23, 26)); pa.tickRoutines(); pa.tickRoutines();
      check('five minutes before, one notice with Skip tonight / Standby now', pushed.length === 1 && pushed[0].tag === 'standby-soon' && pushed[0].buttons.some((b) => b.api === '/api/power/skip'), JSON.stringify(pushed[0] || {}));
      // the hour: standby runs once
      freeze(at(23, 30)); pa.tickRoutines(); pa.tickRoutines();
      check('at the time, standby runs once', acts.join(',') === 'standby', acts.join(','));
      // the wake routine, from standby, next morning
      freeze(at(7, 31) + 86400000); pa.tickRoutines();
      check('the wake runs from standby', acts.join(',') === 'standby,wake', acts.join(','));
      // skip tonight: nothing runs at the hour
      freeze(at(22, 0) + 86400000); const skip = pa.skipPower('standby');
      check('skip tonight is remembered', skip.ok && pa.powerSchedule().skipped, skip.message);
      freeze(at(23, 30) + 86400000); pushed.length = 0; pa.tickRoutines();
      check('a skipped standby does not run and sends no notice', acts.join(',') === 'standby,wake' && pushed.length === 0, acts.join(','));
      // the day after, it's back
      freeze(at(23, 31) + 2 * 86400000); pa.tickRoutines();
      check('the night after, standby runs again', acts.join(',') === 'standby,wake,standby', acts.join(','));
      // dormant: a wake routine still ticks, an ordinary routine doesn't
      mode = 'dormant'; pa.dormant = true;
      await pa.handle('routine/create', { title: 'Brief', task: 'Brief me', every: 'day', at: '07:30' }, owner);
      const before = jobs.jobs.length;
      freeze(at(7, 31) + 3 * 86400000); pa.tickRoutines();
      check('dormant: the scheduled wake runs, ordinary routines wait', acts.at(-1) === 'wake' && jobs.jobs.length === before, acts.join(','));
      check('audit records the power routine runs', audit.recent(50).some((e) => /standby on schedule/.test(e.what)));
    } finally { global.Date = RealDate; }
  }

  fs.rmSync(support, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  a.shutdown();
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
