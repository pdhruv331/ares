// ARES as the user's remote control for Claude Code: see their sessions, hear when one finishes or needs them,
// reply to it, start new ones (optionally on their phone through Claude Code's own Remote Control).
// claude-sessions.js reads Claude Code's files; this module decides what to do and keeps the rules:
//   - never write into a session another client has open (the desktop app keeps its sessions' processes alive);
//   - sessions ARES runs itself are code jobs (jobs.js), so they get the approval tiers, the Work screen and pushes;
//   - transcripts stay local, only short redacted summaries go to the phone.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { tilde } = require('./claude-sessions');

const HOME = os.homedir();
// Folders new sessions may run in unless the user's settings say otherwise (claudeFolders)
const DEFAULT_ROOTS = ['Desktop', 'Documents', 'Developer', 'Projects', 'ARES Projects', 'code', 'src', 'dev', 'repos', 'GitHub'].map((d) => path.join(HOME, d));
const NEVER = [path.join(HOME, 'Library'), path.join(HOME, '.ssh'), path.join(HOME, '.claude'), path.join(HOME, '.config')];
const REMOTE_MAX_MS = 12 * 3600_000; // a Remote Control session ARES started stops after 12 hours
const within = (dir, p) => { const r = path.relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
const slug = (t) => String(t || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'session';
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

const firstSentences = (t, n = 2) => (String(t || '').replace(/\s+/g, ' ').match(/.+?[.!?]+(?=\s|$)/g) || [String(t || '')]).slice(0, n).join(' ').trim().slice(0, 240);
const short = (id) => String(id).slice(0, 8);

class ClaudeControl extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./claude-sessions').ClaudeSessions} o.sessions
   * @param {object} o.jobs  jobs.js
   */
  constructor({ log, sessions, jobs, cli, aresRepo, readSettings = () => ({}), workDir }) {
    super();
    this.log = log;
    this.sessions = sessions;
    this.jobs = jobs;
    this.cli = cli;
    this.aresRepo = aresRepo || path.join(HOME, 'My AI'); // ARES's own code: never touched without an explicit yes, then on a branch
    this.readSettings = readSettings;
    this.workDir = workDir;
    this.remotes = new Map(); // ARES-started Remote Control sessions: key -> { url, name, folder, proc, sessionId, started }
    this.queued = new Map();  // job id -> replies waiting for that code session's current turn to finish
    this.remoteUrl = (sessionId) => [...this.remotes.values()].find((r) => r.sessionId === sessionId)?.url || null;
    jobs.on('finished', (job) => this.flushQueued(job));
    this.recent = new Map(); // "<session>:<kind>" -> when it was last alerted (no repeats within a minute)
    sessions.on('event', (e) => this.onHookEvent(e));
  }

  // ---- Hooks: the user's global Claude Code hooks post here (tools/claude-hook.sh) ------------------------
  /**
   * Listen on localhost for hook events. The hook script finds the address and a per-launch token in
   * <dir>/claude-hook.url and claude-hook.headers (mode 600), which exist only while ARES runs.
   */
  startHooks(dir, scriptSource) {
    this.hookDir = dir;
    const token = crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/hook' || req.headers.authorization !== `Bearer ${token}`) return res.writeHead(404).end();
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        res.writeHead(204).end(); // the hook doesn't wait on what ARES does with it
        try { this.sessions.hook(JSON.parse(body)); } catch (err) { this.log('claude hook bad', err.message); }
      });
    });
    this.hookServer = server;
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      const secret = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text, { mode: 0o600 }); fs.chmodSync(f, 0o600); };
      try {
        const script = path.join(dir, 'claude-hook.sh');
        fs.writeFileSync(script, fs.readFileSync(scriptSource));
        fs.chmodSync(script, 0o700);
        secret('claude-hook.headers', `Authorization: Bearer ${token}\n`);
        secret('claude-hook.url', `http://127.0.0.1:${server.address().port}/hook`);
        this.log('claude hooks listening', { port: server.address().port });
      } catch (err) { this.log('claude hooks setup failed', err.message); }
      resolve();
    }));
  }

  stopHooks() {
    this.hookServer?.close();
    for (const f of ['claude-hook.url', 'claude-hook.headers']) { try { fs.unlinkSync(path.join(this.hookDir, f)); } catch {} }
  }

  /** Are the user's Claude Code settings sending ARES their hooks? */
  hooksInstalled() {
    try {
      const hooks = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.claude', 'settings.json'), 'utf8')).hooks || {};
      return ['Stop', 'Notification'].every((e) => JSON.stringify(hooks[e] || []).includes('claude-hook.sh'));
    } catch { return false; }
  }

  /**
   * A hook event worth telling the user about becomes an 'alert' for main.js, which picks the Mac (a quiet panel)
   * or the phone (a push), and holds phone pushes in quiet hours.
   * alert: { kind, title, body, line, tag, buttons, quietOnMac, session }
   */
  onHookEvent(e) {
    // A quick back-and-forth isn't news: only turns that took a while (or whose length is unknown)
    if (e.kind === 'finished' && e.turnMs != null && e.turnMs < 20_000) return;
    const key = `${e.id}:${e.kind}`;
    if (Date.now() - (this.recent.get(key) || 0) < 60_000) return;
    this.recent.set(key, Date.now());
    const name = `"${e.title}"`;
    const ref = `${name} Claude session [id ${short(e.id)}]`;
    const remote = this.remoteUrl?.(e.id);
    const inApp = e.open === 'Claude app';
    const buttons = [{ title: 'Summary', ask: `Summarise my ${ref}.` }];
    if (remote) buttons.push({ title: 'Open in Claude', url: remote });
    else buttons.push({ title: 'Reply', reply: `Reply to my ${ref}: ` });
    let a;
    if (e.kind === 'finished') {
      const what = firstSentences(e.text) || 'Its turn is done.';
      a = { title: `Done: ${e.title}`, body: what, line: `Your ${name} Claude session finished: ${what}`, quietOnMac: e.turnMs != null && e.turnMs < 120_000 };
    } else if (e.kind === 'permission') {
      const where = remote ? ' Approve it in the Claude app (Open in Claude).' : inApp ? ' Approve it in the Claude app on the Mac, or through Remote Control.' : '';
      a = { title: `Needs permission: ${e.title}`, body: `${e.text || 'Claude is asking for permission.'}${where}`, line: `Your ${name} Claude session needs permission: ${e.text}` };
    } else if (e.kind === 'input') {
      a = { title: `Waiting for you: ${e.title}`, body: e.text || 'Claude has a question for you.', line: `Your ${name} Claude session is waiting for you: ${e.text}` };
    } else {
      a = { title: `Claude error: ${e.title}`, body: `It stopped with an error (${e.text || 'unknown'}).`, line: `Your ${name} Claude session stopped with an error: ${e.text}` };
    }
    this.log('claude alert', { kind: e.kind, session: short(e.id), turnMs: e.turnMs });
    this.emit('alert', { ...a, kind: e.kind, session: e.id, tag: `claude-${short(e.id)}`, buttons });
  }

  /** For the brain: the list, or one session's summary. */
  async status({ session } = {}) {
    if (!session) return { message: this.sessions.describe() };
    const r = await this.sessions.summarize(session);
    if (!r.ok) return { message: r.message };
    const s = r.session;
    const where = s.open ? ` It's open in ${s.open}.` : '';
    return { message: `${s.ares ? '[ARES job] ' : ''}"${s.title}" (${s.folder}), status ${s.status}.${where}\n${r.text}` };
  }

  /** For the phone app: the list as data (with the Remote Control link for sessions ARES put on the phone). */
  list() { return this.sessions.list({ limit: 25 }).map((s) => ({ ...s, remoteUrl: this.remoteUrl(s.id) })); }

  // ---- Folders ---------------------------------------------------------------------------------------------
  roots() {
    const set = this.readSettings().claudeFolders;
    return (Array.isArray(set) && set.length ? set.map((p) => p.replace(/^~(?=\/|$)/, HOME)) : DEFAULT_ROOTS).filter((p) => fs.existsSync(p));
  }
  isAresRepo(p) { return within(this.aresRepo, p); }

  /**
   * "my portfolio folder" → /Users/…/portfolio_site: a path, or a folder name matched against the folders recent
   * sessions ran in, then folders up to three levels down in the allowed roots. Returns { folder } or { error }.
   */
  resolveFolder(ref) {
    const r = String(ref || '').trim();
    if (!r) return { error: 'Which folder should it work in?' };
    if (/^(~|\/)/.test(r)) {
      const p = path.resolve(r.replace(/^~(?=\/|$)/, HOME));
      return fs.existsSync(p) && fs.statSync(p).isDirectory() ? { folder: p } : { error: `There's no folder at ${tilde(p)}.` };
    }
    const words = r.toLowerCase().replace(/\b(my|the|folder|project|repo|directory|in)\b/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    if (!words.length) return { error: 'Which folder should it work in?' };
    const norm = (p) => path.basename(p).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const score = (p) => words.filter((w) => norm(p).includes(w)).length;
    const seen = new Set();
    const candidates = [];
    const consider = (p) => { if (!seen.has(p) && fs.existsSync(p)) { seen.add(p); const n = score(p); if (n) candidates.push({ p, n }); } };
    for (const s of this.sessions.list({ days: 90, limit: 200, includeArchived: true })) if (s.cwd && !s.ares) consider(s.cwd);
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        consider(p);
        if (depth < 3) walk(p, depth + 1);
      }
    };
    for (const root of this.roots()) walk(root, 1);
    if (!candidates.length) return { error: `I couldn't find a folder called "${r}".` };
    candidates.sort((a, b) => b.n - a.n || a.p.length - b.p.length);
    const top = candidates.filter((c) => c.n === candidates[0].n);
    if (top.length > 1 && top[1].p !== top[0].p && !within(top[0].p, top[1].p)) {
      return { error: `"${r}" could be ${top.slice(0, 3).map((c) => tilde(c.p)).join(' or ')}. Which one?` };
    }
    return { folder: top[0].p };
  }

  /** May a new session run here? `aresRepo`: the user explicitly said ARES's own code. Returns an error or null. */
  folderRule(folder, { aresRepo } = {}) {
    if (this.isAresRepo(folder)) return aresRepo ? null : "That's ARES's own code. I only work on it when you say so explicitly, and then on a new git branch.";
    if (folder === HOME || NEVER.some((n) => within(n, folder))) return `I don't start sessions in ${tilde(folder)}.`;
    if (!this.roots().some((root) => within(root, folder))) {
      return `${tilde(folder)} isn't in the folders I may work in (${this.roots().map(tilde).join(', ')}). You can add it to claudeFolders in ARES's settings.`;
    }
    return null;
  }

  /** ARES's own repo: a git worktree on a new branch, so the user's checkout (and their open sessions) stay as they are. */
  aresBranch(title) {
    return new Promise((resolve, reject) => {
      const branch = `ares/${slug(title)}-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(2).toString('hex')}`;
      const dir = path.join(this.workDir, 'worktrees', branch.replace(/\//g, '-'));
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      execFile('git', ['-C', this.aresRepo, 'worktree', 'add', '-b', branch, dir], { timeout: 60_000 }, (err, _out, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
        // A worktree keeps its git metadata in the main repo's .git: the session's sandbox may write there too
        resolve({ dir, branch, gitDir: path.join(this.aresRepo, '.git') });
      });
    });
  }

  // ---- Reply to a session -------------------------------------------------------------------------------
  /**
   * The user's message for a session. ARES's own sessions get it as a follow-up (queued if mid-turn); the user's
   * closed sessions are continued in place with `claude -p --resume`; sessions another client has open are
   * never written to: the answer says so and offers a copy (fork) instead.
   */
  async reply({ session, message, fork = false, source = 'mac' }) {
    const text = String(message || '').trim();
    if (!text) return { message: 'What should I tell it?' };
    const s = this.sessions.find(session);
    if (!s) return { message: `I couldn't find a Claude session matching "${session}".` };
    const name = `"${s.title}"`;
    const remote = this.remoteUrl(s.id);
    if (remote) return { message: `${name} is running on the user's phone through Remote Control: reply there, in the Claude app (${remote}).`, url: remote };

    const own = this.jobs.jobs.find((j) => j.kind === 'code' && j.sessionId === s.id);
    if (own) {
      if (this.jobs.active.includes(own)) {
        this.queued.set(own.id, [...(this.queued.get(own.id) || []), { text, source }]);
        return { message: `${name} is still working, so your message is queued: it goes in as soon as this turn finishes.` };
      }
      this.jobs.continue(own.id, text, source);
      return { message: `Sent to ${name}. It's working on it; you'll get the answer when it's done.`, job: own.id };
    }

    const elsewhere = this.sessions.openElsewhere(s.id);
    if (elsewhere && !fork) {
      return { message: `${name} is open in ${elsewhere.client}, so I won't write into it (two clients on one session can clash). `
        + (elsewhere.client === 'Claude app' ? 'They can reply in the Claude app, from the phone too if Remote Control is on for that session. ' : '')
        + 'Or I can start a copy of it (a fork with the same history) and send the message there: ask them.', openIn: elsewhere.client };
    }
    if (!s.cwd || !fs.existsSync(s.cwd)) return { message: `${name}'s folder (${s.folder}) isn't there any more.` };
    if (this.isAresRepo(s.cwd)) return { message: `${name} works on ARES's own code. I don't continue those on my own; they can reply in the Claude app or a terminal.` };
    const job = this.jobs.start({
      kind: 'code', folder: s.cwd, title: fork ? `${s.title} (copy)` : s.title, task: text, source,
      ...(fork ? { fork: s.id } : { sessionId: s.id, adopt: true }),
    });
    this.log('claude reply', { session: short(s.id), fork, job: job.id });
    return { message: `${fork ? `Started a copy of ${name} and sent` : `Sent`} your message${fork ? ' there' : ` to ${name}`}. It's working on it; you'll get the answer when it's done.`, job: job.id };
  }

  flushQueued(job) {
    const waiting = this.queued.get(job.id);
    if (!waiting?.length || job.status === 'cancelled') return;
    this.queued.delete(job.id);
    const text = waiting.map((w) => w.text).join('\n\n');
    setTimeout(() => { try { this.jobs.continue(job.id, text, waiting[waiting.length - 1].source); } catch (err) { this.log('queued reply failed', err.message); } }, 500);
  }

  // ---- New sessions ----------------------------------------------------------------------------------------
  /**
   * "Start a Claude session in <folder> to <task>". Headless by default (an ARES code job: progress, approvals and a
   * finish push). `onPhone`: an interactive Claude Code session with Remote Control instead, to drive from the Claude app.
   */
  async start({ folder: ref, task, title, onPhone = false, aresRepo = false, source = 'mac' }) {
    const where = this.resolveFolder(ref);
    if (where.error) return { message: where.error };
    let folder = where.folder;
    const rule = this.folderRule(folder, { aresRepo });
    if (rule) return { message: rule };
    title = String(title || task || path.basename(folder)).replace(/\s+/g, ' ').slice(0, 60);
    let note = '';
    let extraWrite = [];
    if (this.isAresRepo(folder)) {
      const wt = await this.aresBranch(title);
      folder = path.join(wt.dir, path.relative(this.aresRepo, folder));
      extraWrite = [wt.gitDir];
      note = ` It's working on a new branch, ${wt.branch}, in its own copy of the repo; your checkout is untouched.`;
    }
    if (onPhone) {
      const r = await this.startRemote({ folder, name: title, task });
      return { ...r, message: r.message + note };
    }
    if (!String(task || '').trim()) return { message: 'What should the session do?' };
    const job = this.jobs.start({ kind: 'code', folder, title, task: String(task), source, extraWrite });
    this.log('claude start', { job: job.id, folder: tilde(folder) });
    return { message: `Started a Claude session in ${tilde(folder)}: "${title}" [${job.id}].${note} It runs in the background; anything risky waits for their OK, and they'll get a push when it's done. To take over: "open it in Claude Code", or "put it on my phone".`, job: job.id };
  }

  // ---- Remote Control: a session the user drives from the Claude app ---------------------------------------
  /** Has the user accepted Claude Code's trust prompt for this folder (or a parent)? Remote Control needs it. */
  trusted(folder) {
    try {
      const projects = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')).projects || {};
      return Object.entries(projects).some(([p, v]) => v?.hasTrustDialogAccepted && within(p, folder));
    } catch { return false; }
  }

  /**
   * An interactive Claude Code session with Remote Control on, in a pseudo-terminal ARES holds (no window). Starts
   * on `task` (or continues `resumeId`); resolves with its claude.ai/code link once it's connected.
   */
  startRemote({ folder, name, task, resumeId }) {
    if (!this.trusted(folder)) {
      return Promise.resolve({ message: `Claude Code hasn't been trusted in ${tilde(folder)} yet, and Remote Control needs that. Open Claude Code in that folder once (in the Claude app or a terminal) and accept the trust prompt, then ask again.` });
    }
    name = String(name || path.basename(folder)).slice(0, 50);
    const args = ['-q', '/dev/null', this.cli, '--remote-control', name, ...(resumeId ? ['--resume', resumeId] : []), ...(task ? [String(task)] : [])];
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.ANTHROPIC_API_KEY; // subscription only
    const proc = spawn('/usr/bin/script', args, { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); // script needs a real file for stdin, not a pipe
    const key = `${Date.now().toString(36)}`;
    const entry = { key, name, folder, proc, url: null, sessionId: resumeId || null, started: Date.now() };
    this.remotes.set(key, entry);
    let out = '';
    const stop = () => this.stopRemote(key);
    entry.timer = setTimeout(stop, REMOTE_MAX_MS);
    proc.on('exit', () => { clearTimeout(entry.timer); this.remotes.delete(key); this.log('remote session ended', { name }); this.emit('remotes'); });
    this.log('remote session start', { folder: tilde(folder), resume: Boolean(resumeId) });
    return new Promise((resolve) => {
      const done = (r) => { clearTimeout(giveUp); resolve(r); };
      const giveUp = setTimeout(() => { stop(); done({ message: "Remote Control didn't connect within a minute, so I stopped it. Claude Code may need signing in again." }); }, 60_000);
      proc.stdout.on('data', (c) => {
        out = (out + c.toString()).slice(-20_000);
        const m = out.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/);
        if (m && !entry.url) {
          entry.url = m[0];
          this.findLocalSession(entry);
          this.emit('remotes');
          done({ message: `"${name}" is live on Remote Control in ${tilde(folder)}${task ? ' and working on it' : ''}. They can open it in the Claude app: ${entry.url}`, url: entry.url, remote: key });
        }
        if (/Workspace not trusted|trust this folder/i.test(out) && !entry.url) { stop(); done({ message: `Claude Code wants the folder ${tilde(folder)} trusted first. Open Claude Code there once and accept the prompt.` }); }
      });
    });
  }

  /** The local session id behind a Remote Control session (for hook alerts and "reply"): from Claude Code's process registry. */
  findLocalSession(entry, tries = 20) {
    if (entry.sessionId || tries <= 0 || !this.remotes.has(entry.key)) return;
    execFile('/usr/bin/pgrep', ['-P', String(entry.proc.pid)], (err, out) => {
      for (const pid of String(out || '').split(/\s+/).filter(Boolean)) {
        try { entry.sessionId = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'sessions', `${pid}.json`), 'utf8')).sessionId; } catch {}
      }
      if (!entry.sessionId) setTimeout(() => this.findLocalSession(entry, tries - 1), 1500);
    });
  }

  stopRemote(key) {
    const r = this.remotes.get(key);
    if (!r) return false;
    try { process.kill(-r.proc.pid, 'SIGTERM'); } catch { r.proc.kill(); }
    setTimeout(() => { try { process.kill(-r.proc.pid, 'SIGKILL'); } catch {} }, 5000);
    this.remotes.delete(key);
    return true;
  }

  /** "Put it on my phone": a closed session, or one ARES ran, continued under Remote Control. */
  async toPhone({ session }) {
    const s = this.sessions.find(session);
    if (!s) return { message: `I couldn't find a Claude session matching "${session}".` };
    const remote = this.remoteUrl(s.id);
    if (remote) return { message: `"${s.title}" is already on Remote Control: ${remote}`, url: remote };
    const own = this.jobs.jobs.find((j) => j.kind === 'code' && j.sessionId === s.id);
    if (own && this.jobs.active.includes(own)) return { message: `"${s.title}" is still working in the background. I'll be able to put it on the phone once this turn finishes (or stop it first).` };
    const elsewhere = this.sessions.openElsewhere(s.id);
    if (elsewhere) {
      return { message: `"${s.title}" is open in ${elsewhere.client}. ${elsewhere.client === 'Claude app' ? 'To use it from the phone, switch on Remote Control for that session in the Claude app (I can\'t flip that switch).' : 'Close it there first.'}` };
    }
    if (this.isAresRepo(s.cwd)) return { message: `"${s.title}" works on ARES's own code; I don't hand those over on my own.` };
    return this.startRemote({ folder: s.cwd, name: s.title, resumeId: s.id });
  }

  // ---- Hand over at the Mac, and stop ----------------------------------------------------------------------
  /** "Open it in Claude Code": a Terminal window resuming the session in its folder. */
  async open({ session }) {
    const s = this.sessions.find(session);
    if (!s) return { message: `I couldn't find a Claude session matching "${session}".` };
    const own = this.jobs.jobs.find((j) => j.kind === 'code' && j.sessionId === s.id);
    if (own && this.jobs.active.includes(own)) return { message: `"${s.title}" is still running in the background. Stop it first (or wait for this turn), then I can open it.` };
    const elsewhere = this.sessions.openElsewhere(s.id);
    if (elsewhere) return { message: `"${s.title}" is already open in ${elsewhere.client}.` };
    const command = `cd ${shq(s.cwd)} && ${shq(this.cli)} --resume ${s.id}`;
    const as = `tell application "Terminal"\nactivate\ndo script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    await new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', as], { timeout: 15_000 }, () => resolve()));
    return { message: `Opened "${s.title}" in Terminal on the Mac (claude --resume, in ${s.folder}).`, command };
  }

  /** Stop what ARES is running for a session: its background turn, or its Remote Control session. */
  stop({ session }) {
    const s = this.sessions.find(session);
    const remote = [...this.remotes.values()].find((r) => (s && r.sessionId === s.id) || r.name.toLowerCase() === String(session).toLowerCase());
    if (remote) { this.stopRemote(remote.key); return { message: `Stopped Remote Control for "${remote.name}".` }; }
    if (!s) return { message: `I couldn't find a Claude session matching "${session}".` };
    const own = this.jobs.jobs.find((j) => j.sessionId === s.id);
    if (own && this.jobs.cancel(own.id)) { this.queued.delete(own.id); return { message: `Stopped "${s.title}". Its work so far is kept; a reply picks it up again.` }; }
    return { message: `"${s.title}" isn't running anything of ARES's${s.open ? ` (it's open in ${s.open}; stop it there)` : ''}.` };
  }

  shutdown() {
    this.stopHooks();
    for (const key of [...this.remotes.keys()]) this.stopRemote(key);
  }

  // ---- The phone app's API (/api/claude/…, behind the phone pairing) -------------------------------------
  async phoneRoute(method, parts, body, device) {
    const source = 'phone';
    if (method === 'POST' && parts[0] === 'sessions' && parts[2] === 'reply') return { ok: true, ...(await this.reply({ session: parts[1], message: String(body.text || '').slice(0, 8000), fork: Boolean(body.fork), source })) };
    if (method === 'POST' && parts[0] === 'sessions' && parts[2] === 'phone') return { ok: true, ...(await this.toPhone({ session: parts[1] })) };
    if (method === 'POST' && parts[0] === 'sessions' && parts[2] === 'stop') return { ok: true, ...this.stop({ session: parts[1] }) };
    if (method === 'POST' && parts[0] === 'start') {
      this.log('phone claude start', { device: device?.name });
      return { ok: true, ...(await this.start({ folder: body.folder, task: String(body.task || '').slice(0, 8000), title: body.title, onPhone: Boolean(body.onPhone), source })) };
    }
    return null;
  }
}

module.exports = { ClaudeControl };
