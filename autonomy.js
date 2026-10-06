// Autonomy (docs/autonomy-prompt.md, sections 1-4), on top of work mode (jobs.js): PROJECTS (Claude Code sessions in
// their own workspace under ~/ARES Projects, built to a brief with a verify loop), GOALS (a plan of steps run as jobs),
// ROUTINES (scheduled or event-triggered jobs, with suggestions never auto-created), LIMITS (caps, the usage reserve,
// runs per day) and the KILL SWITCH (pause everything at once, resume per item). State lives in <support>/autonomy.json.
// Hard rules: subscription only (jobs.js strips the API key); ARES never touches her own code (projects can't be made
// in or under ~/My AI); tier 3 always needs the user's yes, whatever a page or file says.
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact } = require('./redact');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, 'ARES Projects');
const ARES_DIRS = [path.join(HOME, 'My AI')];
const DEFAULTS = { maxProjects: 1, maxJobs: 2, maxRunMin: 90, maxRunsPerDay: 20, usagePauseAt: 85, verifyRounds: 2 };
const OWNER_ONLY = "Refused: that starts or changes autonomous work, and this request wasn't verified as the owner's (Voice ID is off, or the voice didn't match). Tell the user briefly: they can type it, use push-to-talk, or turn Voice ID on.";
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const slugify = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const when = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const today = () => new Date().toISOString().slice(0, 10);

const PLAN_SYSTEM = `You turn a personal goal into a short plan of concrete steps a background assistant can run one after another. Answer with JSON only: {"title":"3-5 words","steps":[{"title":"short","task":"a complete, self-contained brief for a worker: what to do, what to produce, how to judge it's done","kind":"job"|"project"}]}. kind "project" only for building software (an app, script, site); otherwise "job" (research, writing, analysis, organising). 2 to 6 steps. Each step must be doable without asking the user anything; where a choice matters, say what to assume. Never include steps that send messages, spend money, delete things or need the user's passwords: leave those for the user and say so in the last step's task.`;
const GRADE_SYSTEM = `You are a strict verifier for a software project built by an automated session. Judge ONLY whether the definition of done is met, from the evidence given (the brief, the session's report, the test result, the files present). Answer with JSON only: {"pass":true|false,"notes":"what is missing or wrong, concretely, in one to three sentences; empty if it passes"}. Claims without evidence don't count.`;

class Autonomy extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./jobs').Jobs} o.jobs  @param {object} o.audit  (audit.js)  @param {string} o.supportDir
   * @param {Function} o.readSettings  @param {Function} o.writeSettings  @param {Function} o.log
   * @param {(prompt: string, opts?: object) => Promise<string>} o.oneShot   a tool-less Claude call (claude.js)
   * @param {(n: object) => Promise<number>} o.push   pushToPhones   @param {(line: string) => void} o.notice
   * @param {() => string|null} o.phoneUrl   @param {string} o.cli   the claude binary (for the handover)
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.file = path.join(o.supportDir, 'autonomy.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.state = {}; }
    this.state = { paused: false, pausedAt: null, goals: [], routines: [], runs: { day: today(), n: 0 }, seen: {}, suggested: {}, ...this.state };
    this.runs = new Map(); // project id -> the dev-server process ("run it")
    this.jobs.limits = () => this.limits();
    this.jobs.audit = this.audit;
    this.jobs.on('finished', (job) => this.onFinished(job).catch((err) => this.log('autonomy finished handler failed', err.message)));
    this.tick = setInterval(() => this.tickRoutines(), 30_000);
    this.tick.unref?.();
    // Goals that were mid-step when ARES quit: their running job was requeued by jobs.js; nothing to do until it finishes
    this.save();
    this.routes = {
      'project/start': (a, c) => this.startProject(a, c),
      'project/list': () => this.listProjects(),
      'project/status': (a) => this.projectStatus(a),
      'project/control': (a, c) => this.projectControl(a, c),
      'goal/set': (a, c) => this.setGoal(a, c),
      'goal/list': () => this.listGoals(),
      'goal/cancel': (a, c) => this.cancelGoal(a, c),
      'routine/create': (a, c) => this.createRoutine(a, c),
      'routine/list': () => this.listRoutines(),
      'routine/control': (a, c) => this.routineControl(a, c),
      'stop': (a, c) => this.stopAllRoute(a, c),
      'resume': (a, c) => this.resumeRoute(a, c),
      'status': () => ({ message: this.statusLine() }),
    };
  }

  save() {
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 1)); fs.renameSync(this.file + '.tmp', this.file); } catch (err) { this.log('autonomy save failed', err.message); }
    this.emit('change');
  }
  limits() { return { ...DEFAULTS, ...(this.readSettings().autonomy || {}) }; }
  setLimits(patch) { this.writeSettings({ autonomy: { ...this.limits(), ...patch } }); this.jobs.pump(); }

  async handle(name, args = {}, ctx = {}) {
    const route = this.routes[name];
    if (!route) return { message: `Unknown autonomy call "${name}".` };
    try { return await route(args, ctx); } catch (err) { this.log('autonomy failed', { name, error: err.message }); return { message: `Failed: ${redact(err.message)}` }; }
  }
  owner(ctx) { return ctx.verified ? null : { message: OWNER_ONLY }; }

  /** The day's count of runs started on their own (routines and goal steps), against maxRunsPerDay. */
  countRun() {
    if (this.state.runs.day !== today()) this.state.runs = { day: today(), n: 0 };
    this.state.runs.n++;
    this.save();
  }
  runsLeft() {
    if (this.state.runs.day !== today()) return this.limits().maxRunsPerDay;
    return Math.max(0, this.limits().maxRunsPerDay - this.state.runs.n);
  }

  // ---- The view for panels and the phone ---------------------------------------------------------------------------
  view() {
    return {
      paused: this.state.paused, pausedAt: this.state.pausedAt, limits: this.limits(), runsLeft: this.runsLeft(),
      projects: this.jobs.jobs.filter((j) => j.project).map((j) => this.jobs.view(j)),
      goals: this.state.goals, routines: this.state.routines.map((r) => ({ ...r, nextRun: this.nextRun(r) })),
      paused_jobs: this.jobs.paused.map((j) => ({ id: j.id, title: j.title, why: j.pausedWhy })),
    };
  }
  statusLine() {
    const v = this.view();
    const projects = v.projects.filter((p) => ['queued', 'running', 'approval', 'paused'].includes(p.status));
    const goals = v.goals.filter((g) => g.status === 'running' || g.status === 'paused' || g.status === 'stuck');
    const routines = v.routines.filter((r) => r.enabled);
    return `${v.paused ? 'EVERYTHING IS PAUSED (kill switch). ' : ''}Projects: ${projects.length ? projects.map((p) => `${p.title} (${p.status}${p.project?.phase ? `, ${p.project.phase}` : ''})`).join('; ') : 'none active'}. ` +
      `Goals: ${goals.length ? goals.map((g) => `${g.title} (step ${g.current + 1}/${g.steps.length}, ${g.status})`).join('; ') : 'none active'}. ` +
      `Routines on: ${routines.length ? routines.map((r) => `${r.title} (${this.describeSchedule(r.schedule)})`).join('; ') : 'none'}. ` +
      `Autonomous runs left today: ${v.runsLeft}. Caps: ${v.limits.maxProjects} project + ${v.limits.maxJobs} jobs at once, ${v.limits.maxRunMin} min per session.`;
  }

  // ---- PROJECTS ------------------------------------------------------------------------------------------------------
  projectJobs() { return this.jobs.jobs.filter((j) => j.project); }
  findProject(ref) {
    const r = String(ref || '').toLowerCase().trim();
    const list = this.projectJobs();
    if (!r || /^(it|this|that|the project|latest)$/.test(r)) return [...list].reverse().find((j) => ['running', 'approval', 'queued', 'paused'].includes(j.status)) || list[list.length - 1] || null;
    return list.find((j) => j.id === r) || list.find((j) => j.project.slug === slugify(r)) || [...list].reverse().find((j) => j.title.toLowerCase().includes(r))
      || [...list].reverse().find((j) => r.split(/\s+/).filter((w) => w.length > 3).some((w) => j.title.toLowerCase().includes(w))) || null;
  }

  async startProject({ title, goal, constraints = '', definition_of_done, done, source }, ctx) {
    const owner = this.owner(ctx); if (owner) return owner;
    if (!title || !goal) throw new Error('a project needs a title and a goal');
    const dod = definition_of_done || done || '';
    if (!dod) return { message: 'Not started: the brief needs a definition of done (how we\'ll know it\'s finished). Agree it with the user, then call again.' };
    // Tier 3: the brief is read back and the user says yes (the same gate as every other consequential action)
    const d = ctx.confirm ? ctx.confirm(`start project ${title}`) : { allow: true };
    if (!d.allow) return { message: 'Not started yet. Read the brief back to the user in a few sentences (title, goal, constraints, definition of done) and ask if they\'re happy with it. Start only after they say yes.' };
    if (this.state.paused) return { message: 'Everything is paused (the kill switch). Ask the user to resume first ("resume everything").' };
    let slug = slugify(title);
    let folder = path.join(PROJECTS_DIR, slug);
    for (let n = 2; fs.existsSync(folder); n++) { slug = `${slugify(title)}-${n}`; folder = path.join(PROJECTS_DIR, slug); }
    if (ARES_DIRS.some((d) => folder.toLowerCase().startsWith(d.toLowerCase()))) throw new Error('projects never live inside ARES\'s own code');
    fs.mkdirSync(path.join(folder, '.ares'), { recursive: true });
    const brief = `# ${title}\n\n## Goal\n${goal}\n\n## Constraints\n${constraints || 'None beyond ARES\'s rules: stay in this folder, never push, deploy, send or spend without the user\'s yes.'}\n\n## Definition of done\n${dod}\n\n_Started by ARES on ${new Date().toISOString()}_\n`;
    fs.writeFileSync(path.join(folder, 'BRIEF.md'), brief);
    fs.writeFileSync(path.join(folder, '.ares', 'status.json'), JSON.stringify({ phase: 'plan', note: 'reading the brief' }));
    fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules/\n.venv/\n__pycache__/\n.DS_Store\n.ares/status.json\n');
    await new Promise((resolve) => execFile('git', ['init', '-q'], { cwd: folder }, () => execFile('git', ['add', '-A'], { cwd: folder }, () => execFile('git', ['-c', 'user.name=ARES', '-c', 'user.email=ares@localhost', 'commit', '-q', '-m', 'Project brief'], { cwd: folder }, () => resolve()))));
    const job = this.jobs.start({
      kind: 'code', folder, title: String(title).slice(0, 60), source: source || ctx.source || 'mac', size: 'project',
      task: `Build this project to its brief. Start with the PLAN phase.\n\n${brief}`,
      project: { slug, brief: { goal, constraints, done: dod } },
    });
    this.audit.record({ what: `started project "${title}" in ~/ARES Projects/${slug}`, tier: 3, kind: 'project', source: job.source, approval: `the user agreed the brief ("${String(d.said || 'yes').slice(0, 40)}")` });
    this.log('project start', { id: job.id, slug });
    return { message: `Project "${job.title}" started [${job.id}] in ~/ARES Projects/${slug}. It plans, builds, tests and verifies itself against the definition of done; progress shows as its orb and in the Work panel and the phone's Work screen; the app will say when it's done. Tell the user briefly that it's under way.`, job: job.id };
  }

  listProjects() {
    const list = this.projectJobs();
    if (!list.length) return { message: 'No projects yet.' };
    return { message: list.slice(-10).map((j) => this.describeProject(j)).join('\n') };
  }
  describeProject(j) {
    const p = j.project;
    const st = j.status === 'done' ? (p.verified === false ? 'done, but not fully verified' : 'done') : j.status === 'approval' ? `waiting for the user's OK: ${j.approval?.what}` : j.status;
    return `${j.title} [${j.id}]: ${st}${['running', 'paused', 'queued'].includes(j.status) ? ` · phase ${p.phase}${p.note ? ` (${p.note})` : ''}` : ''}${p.tests ? ` · tests: ${p.tests}` : ''}${p.commit ? ` · last commit: ${p.commit}` : ''}${j.summary ? ` · ${j.summary.slice(0, 200)}` : ''}${p.url ? ` · serves ${p.url}` : ''}`;
  }
  projectStatus({ project }) {
    const j = this.findProject(project);
    if (!j) return { message: `No project matching "${project}".` };
    const events = this.jobs.events(j.id).slice(-6).map((e) => `${new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ${e.text}`);
    return { message: `${this.describeProject(j)}\nFolder: ~/ARES Projects/${j.project.slug}\nRecent:\n${events.join('\n') || '(nothing yet)'}` };
  }

  async projectControl({ project, action }, ctx) {
    const j = this.findProject(project);
    if (!j) return { message: `No project matching "${project}".` };
    const act = String(action || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!['open_folder', 'preview'].includes(act)) { const owner = this.owner(ctx); if (owner) return owner; }
    switch (act) {
      case 'pause': return { message: this.jobs.pause(j.id, 'paused by the user') ? `Paused "${j.title}". Its work so far is kept; "resume" picks it up.` : `"${j.title}" isn't running.` };
      case 'resume':
        if (this.state.paused) return { message: 'Everything is paused by the kill switch: say "resume everything" first.' };
        return { message: this.jobs.resume(j.id) ? `Resumed "${j.title}".` : j.status === 'done' ? `"${j.title}" is finished; a follow-up (continue_job) is how to change it.` : `"${j.title}" isn't paused.` };
      case 'stop': return { message: this.jobs.cancel(j.id) ? `Stopped "${j.title}". The folder and its commits stay.` : `"${j.title}" isn't running.` };
      case 'open_in_claude_code': case 'open': {
        if (this.jobs.active.includes(j)) this.jobs.pause(j.id, 'handed over to the user');
        const command = `cd ${shq(j.folder)} && ${shq(this.cli)} --resume ${j.sessionId}`;
        const as = `tell application "Terminal"\nactivate\ndo script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
        await new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', as], { timeout: 15_000 }, () => resolve()));
        this.audit.record({ what: `handed project "${j.title}" over in Claude Code (Terminal)`, tier: 2, kind: 'project', source: ctx.source, approval: 'tier 2' });
        return { message: `Opened "${j.title}" in Terminal on the Mac with claude --resume, in its folder. ARES's own run is paused so they don't both write; "resume the project" hands it back.` };
      }
      case 'open_folder': { const { shell } = require('electron'); await shell.openPath(j.folder); return { message: `Opened ~/ARES Projects/${j.project.slug} in Finder.` }; }
      case 'run': return this.runProject(j, ctx);
      case 'stop_run': { const r = this.runs.get(j.id); if (!r) return { message: `Nothing of "${j.title}" is running.` }; r.proc.kill(); this.runs.delete(j.id); return { message: `Stopped ${r.cmd}.` }; }
      case 'send_to_phone': return this.sendProject(j);
      default: throw new Error(`unknown action "${action}" (pause, resume, stop, open_in_claude_code, open_folder, run, stop_run, send_to_phone)`);
    }
  }

  /** "Run it": the command the project declared (status.json run), inside its folder; a preview link for the phone over Tailscale. */
  async runProject(j, ctx) {
    const cmd = j.project.run;
    if (!cmd) return { message: `"${j.title}" hasn't declared how to run it (no "run" in its status). Tell the user what the folder holds, or ask the project (continue_job) to add a run command.` };
    if (this.runs.has(j.id)) return { message: `It's already running: ${cmd}${j.project.url ? ` at ${j.project.url}` : ''}.` };
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` };
    delete env.ANTHROPIC_API_KEY;
    const proc = spawn('/bin/zsh', ['-lc', cmd], { cwd: j.folder, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    proc.stdout.on('data', (c) => { out = (out + c).slice(-4000); });
    proc.stderr.on('data', (c) => { out = (out + c).slice(-4000); });
    proc.on('exit', (code) => { this.runs.delete(j.id); this.log('project run exit', { id: j.id, code }); });
    this.runs.set(j.id, { proc, cmd, started: Date.now() });
    this.audit.record({ what: `ran project "${j.title}": ${cmd}`, tier: 2, kind: 'project', source: ctx.source, approval: 'tier 2: inside the workspace' });
    await new Promise((r) => setTimeout(r, 2500));
    const url = j.project.url || (out.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\S*/) || [])[0] || null;
    if (url && !j.project.url) { j.project.url = url; this.jobs.save(); }
    const preview = url && this.phoneUrl() ? `${this.phoneUrl()}/api/projects/${j.id}/preview/` : null;
    return { message: `Running ${cmd} in ~/ARES Projects/${j.project.slug}${url ? `; it serves ${url}` : ''}${preview ? `. On the phone it's at ${preview} (only over Tailscale)` : ''}.${this.runs.has(j.id) ? '' : ` It exited straight away: ${redact(out.trim().split('\n').slice(-3).join(' ')).slice(0, 300)}`}` };
  }
  /** phone.js: where a project's preview is served, for the Tailscale-only proxy. */
  previewTarget(id) {
    const j = this.jobs.get(id);
    const url = j?.project?.url;
    if (!url || !this.runs.has(id)) return null;
    try { const u = new URL(url); return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? u : null; } catch { return null; }
  }

  /** A finished project to the phone: the summary, a zip of the workspace (no node_modules/.git), and the preview link if it runs. */
  async sendProject(j) {
    const zipName = `${j.project.slug}.zip`;
    const zipPath = path.join(this.jobs.folder(j.id), zipName);
    await new Promise((resolve) => execFile('/usr/bin/zip', ['-qr', zipPath, '.', '-x', 'node_modules/*', '.git/*', '.venv/*', '*/node_modules/*', '*/.git/*'], { cwd: j.folder, timeout: 120_000 }, () => resolve()));
    const preview = this.previewTarget(j.id) && this.phoneUrl() ? `${this.phoneUrl()}/api/projects/${j.id}/preview/` : null;
    const base = this.phoneUrl() || '';
    const sent = await this.push({ title: `Project: ${j.title}`, body: j.summary || `${j.status}.`, tag: `job-${j.id}`, job: j.id,
      buttons: [{ title: 'Open', job: j.id, url: `${base}/?job=${j.id}` }, ...(fs.existsSync(zipPath) ? [{ title: 'Zip', url: `${base}/api/jobs/${j.id}/file/${encodeURIComponent(zipName)}?download`, file: { api: `/api/jobs/${j.id}/file/${encodeURIComponent(zipName)}`, name: zipName, mime: 'application/zip', size: fs.statSync(zipPath).size } }] : []),
        ...(preview ? [{ title: 'Preview', url: preview }] : [])].slice(0, 3) });
    return { message: sent ? `Sent "${j.title}" to the phone: the summary, ${fs.existsSync(zipPath) ? 'a zip of the project' : 'its files'}${preview ? ' and the preview link' : ''}.` : "The phone app isn't set up for notifications yet." };
  }

  /** A project session ended: verify against the definition of done; one more round if it falls short; then deliver. */
  async verifyProject(j) {
    const p = j.project;
    if (j.status !== 'done') return;
    this.jobs.syncProject(j);
    let files = '';
    try { files = require('child_process').execFileSync('git', ['ls-files'], { cwd: j.folder, timeout: 5000 }).toString().split('\n').filter(Boolean).slice(0, 80).join(', '); } catch {}
    const prompt = `BRIEF:\n${JSON.stringify(p.brief, null, 1)}\n\nSESSION REPORT:\n${j.summary || '(none)'}\n\nLATEST TEST RESULT (from the session's status file): ${p.tests || '(none recorded)'}\nLAST COMMIT: ${p.commit || '(none)'}\nFILES: ${files || '(none)'}\n\nDoes this meet the definition of done?`;
    let verdict = { pass: true, notes: '' };
    try {
      const raw = await this.oneShot(prompt, { system: GRADE_SYSTEM, timeoutMs: 120_000 });
      verdict = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    } catch (err) { this.log('project grade failed', err.message); verdict = { pass: null, notes: 'could not be verified' }; }
    this.audit.record({ what: `verified project "${j.title}": ${verdict.pass === false ? 'not yet' : verdict.pass ? 'passes' : 'unverified'}${verdict.notes ? ` (${verdict.notes.slice(0, 160)})` : ''}`, tier: 1, kind: 'project', source: j.source });
    if (verdict.pass === false && (p.iteration || 0) < this.limits().verifyRounds && !this.state.paused) {
      p.iteration = (p.iteration || 0) + 1;
      p.verified = false;
      this.jobs.save();
      this.jobs.events(j.id); // keep ordering
      this.jobs.continue(j.id, `Verification against the definition of done found gaps: ${verdict.notes}\nFix them, run the tests again, update .ares/status.json, commit, and give the REPORT again.`, 'ares');
      return;
    }
    p.verified = verdict.pass;
    p.verifyNotes = verdict.notes || '';
    this.jobs.save();
    this.jobs.emit('change', this.jobs.view(j));
    if (verdict.pass === false) this.notice?.(`The ${j.title} project finished but didn't fully pass its own check: ${verdict.notes}`);
    await this.sendProject(j).catch((err) => this.log('project send failed', err.message));
  }

  // ---- GOALS --------------------------------------------------------------------------------------------------------------
  findGoal(ref) {
    const r = String(ref || '').toLowerCase().trim();
    const g = this.state.goals;
    if (!r || /^(it|this|that|latest)$/.test(r)) return [...g].reverse().find((x) => x.status === 'running' || x.status === 'stuck' || x.status === 'paused') || g[g.length - 1] || null;
    return g.find((x) => x.id === r) || [...g].reverse().find((x) => x.title.toLowerCase().includes(r) || x.text.toLowerCase().includes(r)) || null;
  }
  async setGoal({ goal, source }, ctx) {
    const owner = this.owner(ctx); if (owner) return owner;
    if (!goal) throw new Error('what is the goal?');
    if (this.state.paused) return { message: 'Everything is paused (the kill switch). Ask the user to resume first.' };
    let plan;
    try {
      const raw = await this.oneShot(`THE GOAL, in the user's words: ${goal}\n\nToday is ${new Date().toDateString()}.`, { system: PLAN_SYSTEM, timeoutMs: 120_000 });
      plan = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    } catch (err) { throw new Error(`I couldn't plan that (${err.message})`); }
    if (!Array.isArray(plan.steps) || !plan.steps.length) throw new Error('the plan came back empty');
    const g = { id: `g-${crypto.randomBytes(3).toString('hex')}`, text: String(goal).slice(0, 500), title: String(plan.title || goal).slice(0, 60), status: 'running', created: Date.now(), current: 0,
      steps: plan.steps.slice(0, 6).map((s) => ({ title: String(s.title || '').slice(0, 60), task: String(s.task || ''), kind: s.kind === 'project' ? 'project' : 'job', jobId: null, status: 'pending', summary: '' })), source: source || ctx.source || 'mac' };
    this.state.goals.push(g);
    this.save();
    this.audit.record({ what: `goal set: "${g.title}" (${g.steps.length} steps)`, tier: 2, kind: 'goal', source: g.source, approval: 'tier 2' });
    this.runGoalStep(g);
    return { message: `Goal "${g.title}" set [${g.id}], ${g.steps.length} steps: ${g.steps.map((s, i) => `${i + 1}. ${s.title}`).join('; ')}. The first step is running as a job now; each step's result feeds the next, and the app reports as they finish. Tell the user the plan in a sentence.` };
  }
  runGoalStep(g) {
    if (g.status !== 'running' || this.state.paused) return;
    const step = g.steps[g.current];
    if (!step) { g.status = 'done'; g.finished = Date.now(); this.save(); this.deliverGoal(g); return; }
    if (this.runsLeft() <= 0) { g.status = 'waiting'; g.note = 'the day\'s limit of autonomous runs is used up; it carries on tomorrow'; this.save(); this.push({ title: `Goal waiting: ${g.title}`, body: g.note, tag: `goal-${g.id}` }).catch(() => {}); return; }
    const context = g.steps.slice(0, g.current).filter((s) => s.summary).map((s, i) => `Step ${i + 1} (${s.title}) found: ${s.summary}`).join('\n');
    const task = `${step.task}\n\nThis is step ${g.current + 1} of ${g.steps.length} of the user's goal: "${g.text}".${context ? `\nWhat earlier steps found:\n${context}` : ''}`;
    const job = this.jobs.start({ title: `${g.title} · ${step.title}`.slice(0, 80), task, size: 'medium', source: 'goal', goalId: g.id });
    step.jobId = job.id;
    step.status = 'running';
    this.countRun();
    this.save();
    this.log('goal step', { goal: g.id, step: g.current, job: job.id });
  }
  async deliverGoal(g) {
    const lines = g.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.summary || s.status}`);
    this.audit.record({ what: `goal done: "${g.title}"`, tier: 2, kind: 'goal', source: g.source, approval: 'tier 2' });
    this.notice?.(`Goal done, sir: ${g.title}. ${g.steps[g.steps.length - 1]?.summary || ''}`.slice(0, 300));
    await this.push({ title: `Goal done: ${g.title}`, body: lines.join('\n').slice(0, 1400), tag: `goal-${g.id}`, buttons: [{ title: 'Open', job: g.steps[g.steps.length - 1]?.jobId, url: `${this.phoneUrl() || ''}/?job=${g.steps[g.steps.length - 1]?.jobId}` }] }).catch(() => {});
  }
  listGoals() {
    const g = this.state.goals;
    if (!g.length) return { message: 'No goals set.' };
    return { message: g.slice(-8).map((x) => `${x.title} [${x.id}]: ${x.status}${x.note ? ` (${x.note})` : ''}, step ${Math.min(x.current + 1, x.steps.length)}/${x.steps.length}: ${x.steps.map((s, i) => `${i + 1}. ${s.title} (${s.status})`).join('; ')}`).join('\n') };
  }
  cancelGoal({ goal }, ctx) {
    const owner = this.owner(ctx); if (owner) return owner;
    const g = this.findGoal(goal);
    if (!g) return { message: `No goal matching "${goal}".` };
    if (g.status === 'done' || g.status === 'cancelled') return { message: `"${g.title}" is already ${g.status}.` };
    g.status = 'cancelled';
    const step = g.steps[g.current];
    if (step?.jobId) this.jobs.cancel(step.jobId);
    this.save();
    this.audit.record({ what: `goal cancelled: "${g.title}"`, tier: 2, kind: 'goal', source: ctx.source, approval: 'tier 2' });
    return { message: `Cancelled the goal "${g.title}".` };
  }

  // ---- ROUTINES ------------------------------------------------------------------------------------------------------------
  /** { every: 'day'|'weekday'|'week'|'hour'|'N minutes'|'N hours', at: 'HH:MM', days: ['mon',…], on: 'unlock'|'wake'|'morning' } */
  parseSchedule({ every, at, days, on }) {
    if (on) { const ev = String(on).toLowerCase(); if (!['unlock', 'wake'].includes(ev)) throw new Error('on: unlock or wake'); return { kind: 'event', event: ev }; }
    const e = String(every || 'day').toLowerCase().trim();
    let m;
    if ((m = e.match(/^(\d+)\s*(minutes?|mins?|hours?|hrs?)$/))) { const n = Number(m[1]); const minutes = /h/.test(m[2]) ? n * 60 : n; if (minutes < 10) throw new Error('at least every 10 minutes'); return { kind: 'interval', minutes }; }
    if (e === 'hour' || e === 'hourly') return { kind: 'interval', minutes: 60 };
    const time = String(at || '08:00').trim();
    const t = time.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!t) throw new Error('at: a time like 08:00 or 6pm');
    let h = Number(t[1]); const min = Number(t[2] || 0);
    if (t[3]) { if (/pm/i.test(t[3]) && h < 12) h += 12; if (/am/i.test(t[3]) && h === 12) h = 0; }
    if (h > 23 || min > 59) throw new Error('a valid time');
    let dayList;
    if (Array.isArray(days) && days.length) dayList = days.map((d) => DAY_NAMES.indexOf(String(d).slice(0, 3).toLowerCase())).filter((d) => d >= 0);
    else if (e === 'weekday' || e === 'weekdays') dayList = [1, 2, 3, 4, 5];
    else if (e === 'weekend' || e === 'weekends') dayList = [0, 6];
    else if (DAY_NAMES.includes(e.slice(0, 3)) || e.startsWith('every ')) { const d = DAY_NAMES.indexOf(e.replace(/^every /, '').slice(0, 3)); if (d >= 0) dayList = [d]; }
    else if (e === 'week' || e === 'weekly') dayList = [new Date().getDay()];
    else if (e !== 'day' && e !== 'daily') throw new Error(`every: day, weekday, weekend, week, a day name, hour, or "N minutes"`);
    return { kind: 'daily', hour: h, minute: min, days: dayList || null };
  }
  describeSchedule(s) {
    if (!s) return '?';
    if (s.kind === 'event') return s.event === 'unlock' ? 'when the Mac is unlocked' : 'when the Mac wakes';
    if (s.kind === 'interval') return s.minutes % 60 === 0 ? `every ${s.minutes / 60} hour${s.minutes > 60 ? 's' : ''}` : `every ${s.minutes} minutes`;
    const t = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
    if (!s.days) return `daily at ${t}`;
    const names = s.days.map((d) => DAY_NAMES[d]).join(', ');
    return `${names === 'mon, tue, wed, thu, fri' ? 'weekdays' : names === 'sun, sat' ? 'weekends' : names} at ${t}`;
  }
  nextRun(r) {
    const s = r.schedule;
    if (!r.enabled || !s || s.kind === 'event') return null;
    const now = Date.now();
    if (s.kind === 'interval') return (r.lastRun || now) + s.minutes * 60_000 - (r.lastRun ? 0 : 0);
    const d = new Date(); d.setSeconds(0, 0);
    for (let i = 0; i < 8; i++) {
      const c = new Date(d); c.setDate(d.getDate() + i); c.setHours(s.hour, s.minute, 0, 0);
      if (c.getTime() > now && (!s.days || s.days.includes(c.getDay())) && (!r.lastRun || c.getTime() > r.lastRun + 60_000)) return c.getTime();
    }
    return null;
  }
  createRoutine({ title, task, every, at, days, on, source }, ctx) {
    const owner = this.owner(ctx); if (owner) return owner;
    if (!title || !task) throw new Error('a routine needs a title and what to do');
    const schedule = this.parseSchedule({ every, at, days, on });
    // An interval routine's first run is one interval from now, not this instant
    const r = { id: `r-${crypto.randomBytes(3).toString('hex')}`, title: String(title).slice(0, 60), task: String(task).slice(0, 4000), schedule, enabled: true, created: Date.now(), lastRun: schedule.kind === 'interval' ? Date.now() : null, runs: [], source: source || ctx.source || 'mac' };
    this.state.routines.push(r);
    this.save();
    this.audit.record({ what: `routine created: "${r.title}" ${this.describeSchedule(schedule)}`, tier: 2, kind: 'routine', source: r.source, approval: 'tier 2' });
    const next = this.nextRun(r);
    return { message: `Routine "${r.title}" [${r.id}] set: ${this.describeSchedule(schedule)}${next ? `, first run ${when(next)}` : ''}. Each run is a background job whose result goes to the phone. It's listed with an on/off switch in Work → Routines.` };
  }
  findRoutine(ref) {
    const r = String(ref || '').toLowerCase().trim();
    const list = this.state.routines;
    return list.find((x) => x.id === r) || [...list].reverse().find((x) => x.title.toLowerCase().includes(r)) || null;
  }
  listRoutines() {
    const list = this.state.routines;
    if (!list.length) return { message: 'No routines.' };
    return { message: list.map((r) => `${r.title} [${r.id}]: ${r.enabled ? 'on' : 'off'}, ${this.describeSchedule(r.schedule)}${r.lastRun ? `, last ran ${when(r.lastRun)}` : ''}${this.nextRun(r) ? `, next ${when(this.nextRun(r))}` : ''}`).join('\n') };
  }
  routineControl({ routine, action }, ctx) {
    const owner = this.owner(ctx); if (owner) return owner;
    const r = this.findRoutine(routine);
    if (!r) return { message: `No routine matching "${routine}".` };
    const act = String(action || '').toLowerCase();
    if (act === 'on' || act === 'enable') { r.enabled = true; this.save(); return { message: `"${r.title}" is on; next ${this.nextRun(r) ? when(this.nextRun(r)) : this.describeSchedule(r.schedule)}.` }; }
    if (act === 'off' || act === 'disable') { r.enabled = false; this.save(); return { message: `"${r.title}" is off.` }; }
    if (act === 'delete' || act === 'remove') { this.state.routines = this.state.routines.filter((x) => x !== r); this.save(); this.audit.record({ what: `routine deleted: "${r.title}"`, tier: 2, kind: 'routine', source: ctx.source, approval: 'tier 2' }); return { message: `Deleted "${r.title}".` }; }
    if (act === 'run' || act === 'now') { const job = this.runRoutine(r, 'asked'); return { message: job ? `Running "${r.title}" now [${job.id}].` : 'It couldn\'t start (paused, or the day\'s run limit is used up).' }; }
    throw new Error('action: on, off, run or delete');
  }
  runRoutine(r, why = 'scheduled') {
    if (this.state.paused) return null;
    if (why === 'scheduled' && this.runsLeft() <= 0) { this.log('routine held', { id: r.id, why: 'runs per day' }); return null; }
    const job = this.jobs.start({ title: r.title, task: `${r.task}\n\n(This is the routine "${r.title}", run ${why === 'scheduled' ? 'on its schedule' : 'on request'} on ${new Date().toLocaleString('en-GB')}. The user may be away: the result goes to their phone, so make it self-contained.)`, size: 'small', source: 'routine', routineId: r.id });
    r.lastRun = Date.now();
    r.runs = [...(r.runs || []), { at: r.lastRun, jobId: job.id }].slice(-20);
    this.countRun();
    this.save();
    this.audit.record({ what: `routine "${r.title}" ran (${why})`, tier: 2, kind: 'routine', source: 'routine', approval: 'tier 2: scheduled routine' });
    return job;
  }
  tickRoutines() {
    if (this.state.paused || this.dormant) return; // (dormant: power.js)
    const now = Date.now();
    for (const r of this.state.routines) {
      if (!r.enabled || r.schedule.kind === 'event') continue;
      const due = r.schedule.kind === 'interval' ? !r.lastRun || now - r.lastRun >= r.schedule.minutes * 60_000 : (() => {
        const d = new Date(); const s = r.schedule;
        if (s.days && !s.days.includes(d.getDay())) return false;
        const target = new Date(d); target.setHours(s.hour, s.minute, 0, 0);
        return now >= target.getTime() && now - target.getTime() < 10 * 60_000 && (!r.lastRun || r.lastRun < target.getTime()); // within 10 min of the slot, once
      })();
      if (due) this.runRoutine(r, 'scheduled');
    }
  }
  /** Mac events (unlock, wake): the routines waiting on them. */
  event(name) {
    if (this.state.paused) return;
    for (const r of this.state.routines) {
      if (r.enabled && r.schedule.kind === 'event' && r.schedule.event === name && (!r.lastRun || Date.now() - r.lastRun > 60 * 60_000)) this.runRoutine(r, name);
    }
  }

  // ---- Suggestions: a repeated pattern may become a routine, only when the user says so ------------------------------------
  observe(text) {
    const key = String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
    if (key.split(' ').length < 3) return;
    const seen = this.state.seen[key] || [];
    const d = new Date();
    const entry = { day: today(), hour: d.getHours() + d.getMinutes() / 60 };
    if (!seen.some((e) => e.day === entry.day)) seen.push(entry);
    this.state.seen[key] = seen.slice(-14);
    // Keep the table small: forget keys not seen for a month
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    for (const [k, v] of Object.entries(this.state.seen)) if (!v.some((e) => e.day >= cutoff)) delete this.state.seen[k];
    this.save();
  }
  /** A note for the brain when a pattern deserves offering a routine (once per pattern). */
  suggestion() {
    for (const [key, seen] of Object.entries(this.state.seen)) {
      if (seen.length < 3 || this.suggested[key]) continue;
      const hours = seen.map((e) => e.hour);
      const spread = Math.max(...hours) - Math.min(...hours);
      if (spread > 1.5) continue;
      const h = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
      this.suggested[key] = Date.now();
      this.state.suggested = this.suggested;
      this.save();
      return `(ARES note: the user has asked "${key}…" on ${seen.length} different days around ${h}:00. After answering, offer ONCE, in one short sentence, to make it a routine at that time; create it with create_routine only if they say yes. Never create a routine unasked.)\n\n`;
    }
    return '';
  }
  get suggested() { return (this.state.suggested ||= {}); }

  // ---- LIMITS and the KILL SWITCH ---------------------------------------------------------------------------------------------
  /** Claude usage near the limit (claude-usage.js warn): projects pause by themselves; chat keeps its reserve. */
  usage(pct) {
    if (pct < this.limits().usagePauseAt) return;
    for (const j of this.jobs.running.filter((x) => x.project)) {
      this.jobs.pause(j.id, 'usage limit');
      this.notice?.(`Pausing the ${j.title} project: the Claude limit is at ${pct}%. It picks up when there's room.`);
      this.push({ title: `Project paused: ${j.title}`, body: `The Claude limit is at ${pct}%. It resumes when the window resets.`, tag: `job-${j.id}` }).catch(() => {});
    }
  }
  /** Room again (a window reset): projects paused for usage carry on. */
  usageOk() {
    if (this.state.paused) return;
    for (const j of this.jobs.paused.filter((x) => x.pausedWhy === 'usage limit')) this.jobs.resume(j.id);
  }

  stopAll(why = 'kill switch') {
    const paused = [];
    for (const j of [...this.jobs.running, ...this.jobs.jobs.filter((x) => x.status === 'queued')]) if (this.jobs.pause(j.id, why)) paused.push(j.title);
    for (const r of this.runs.values()) { try { r.proc.kill(); } catch {} }
    this.runs.clear();
    for (const g of this.state.goals) if (g.status === 'running' || g.status === 'waiting') g.status = 'paused';
    this.state.paused = true;
    this.state.pausedAt = Date.now();
    this.save();
    this.audit.record({ what: `KILL SWITCH: everything paused (${why})${paused.length ? `: ${paused.join(', ')}` : ''}`, tier: 1, kind: 'autonomy', source: why });
    this.log('autonomy stop all', { why, paused: paused.length });
    this.emit('paused', { why, paused });
    return paused;
  }
  stopAllRoute(_a, ctx) {
    const owner = this.owner(ctx); if (owner) return owner;
    const paused = this.stopAll(ctx.source || 'asked');
    return { message: `Everything is paused${paused.length ? `: ${paused.join(', ')}` : ' (nothing was running)'}. Routines won't fire and goals wait. "Resume everything", or resume one project or job by name.` };
  }
  resumeAll() {
    this.state.paused = false;
    this.state.pausedAt = null;
    for (const j of this.jobs.paused) this.jobs.resume(j.id);
    for (const g of this.state.goals) if (g.status === 'paused') { g.status = 'running'; if (!g.steps[g.current]?.jobId || this.jobs.get(g.steps[g.current].jobId)?.status === 'cancelled') this.runGoalStep(g); }
    this.save();
    this.audit.record({ what: 'resumed everything', tier: 1, kind: 'autonomy' });
    this.emit('resumed');
  }
  resumeRoute({ what }, ctx) {
    const owner = this.owner(ctx); if (owner) return owner;
    const w = String(what || 'everything').toLowerCase().trim();
    if (/^(everything|all|it all)$/.test(w)) { this.resumeAll(); return { message: 'Resumed everything: paused jobs and projects carry on, goals continue, routines run again.' }; }
    const j = this.findProject(w) || this.jobs.paused.find((x) => x.title.toLowerCase().includes(w)) || null;
    if (j && j.status === 'paused') { if (this.state.paused) { this.state.paused = false; this.save(); } this.jobs.resume(j.id); return { message: `Resumed "${j.title}".` }; }
    const g = this.findGoal(w);
    if (g && g.status === 'paused') { g.status = 'running'; this.save(); this.runGoalStep(g); return { message: `Resumed the goal "${g.title}".` }; }
    return { message: `Nothing paused matches "${what}". Paused: ${this.jobs.paused.map((x) => x.title).join(', ') || 'nothing'}.` };
  }

  // ---- Job completions feed projects and goals -----------------------------------------------------------------------------------
  async onFinished(job) {
    const j = this.jobs.get(job.id);
    if (!j) return;
    if (j.project) return this.verifyProject(j);
    if (j.goalId) {
      const g = this.state.goals.find((x) => x.id === j.goalId);
      if (!g || g.status === 'cancelled') return;
      const step = g.steps.find((s) => s.jobId === j.id);
      if (!step) return;
      step.status = j.status;
      step.summary = (j.summary || j.error || '').slice(0, 600);
      if (j.status === 'done') { g.current++; this.save(); this.runGoalStep(g); }
      else { g.status = 'stuck'; g.note = `step ${g.current + 1} (${step.title}) ${j.status}: ${j.error || ''}`; this.save(); this.push({ title: `Goal stuck: ${g.title}`, body: g.note, tag: `goal-${g.id}` }).catch(() => {}); }
    }
  }

  shutdown() {
    clearInterval(this.tick);
    for (const r of this.runs.values()) { try { r.proc.kill(); } catch {} }
  }
}

module.exports = { Autonomy, PROJECTS_DIR, DEFAULTS };
