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
const path = require('path');

const firstSentences = (t, n = 2) => (String(t || '').replace(/\s+/g, ' ').match(/.+?[.!?]+(?=\s|$)/g) || [String(t || '')]).slice(0, n).join(' ').trim().slice(0, 240);
const short = (id) => String(id).slice(0, 8);

class ClaudeControl extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./claude-sessions').ClaudeSessions} o.sessions
   * @param {object} o.jobs  jobs.js
   */
  constructor({ log, sessions, jobs }) {
    super();
    this.log = log;
    this.sessions = sessions;
    this.jobs = jobs;
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

  /** For the phone app: the list as data. */
  list() { return this.sessions.list({ limit: 25 }); }
}

module.exports = { ClaudeControl };
