// The user's Claude Code sessions, as ARES sees them: what's running, what's waiting on them, what finished.
//
// Read-only views of Claude Code's own files (nothing here writes to them):
//   ~/.claude/projects/<folder>/<session>.jsonl   transcripts (can be tens of MB: only the head and tail are read)
//   ~/.claude/sessions/<pid>.json                 one per running interactive Claude Code process: session id,
//                                                 folder, busy/idle, and which client (claude-desktop, cli…)
//   ~/Library/Application Support/Claude/claude-code-sessions/…/local_*.json   the desktop app's titles
// plus the events the user's global Claude Code hooks post to ARES (hook(): Stop, Notification, StopFailure…).
//
// Transcripts stay on the Mac. What leaves (summaries, notification text) goes through redact() first.
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact } = require('./redact');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const LIVE = path.join(CLAUDE_DIR, 'sessions');
const DESKTOP = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
// ARES's own Claude processes (the brain, dashboard, calls, workers) keep their transcripts here too
const ARES_DIR = /\/Library\/Application Support\/ares(\/|$)|\/ares-harness-/i;
// Throwaway sessions (scratch folders, temp test runs): not worth listing
const SCRATCH = /^\/(private\/)?(tmp|var\/folders)\//;
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 384 * 1024;

const tilde = (p) => (p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p || '');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// Prompts Claude Code writes itself (slash commands, hook output, interrupts), not the user's words
const SYNTHETIC = /^\s*(<(command-|local-command|system-reminder|task-notification|bash-|user-prompt-submit-hook)|\[Request interrupted)/;

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function lines(text, dropFirst) {
  const all = text.split('\n');
  if (dropFirst) all.shift(); // a tail read starts mid-line
  const out = [];
  for (const l of all) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

class ClaudeSessions extends EventEmitter {
  /**
   * @param {object} o
   * @param {(prompt: string, opts: object) => Promise<string>} o.oneShot  a tool-less Claude call (claude.js)
   * @param {(sessionId: string) => object|null} o.aresJob  the ARES job that owns a session, if any (jobs.js)
   * @param {string} o.file  where hook state is kept between launches
   */
  constructor({ log, oneShot, aresJob = () => null, file }) {
    super();
    this.log = log || (() => {});
    this.oneShot = oneShot;
    this.aresJob = aresJob;
    this.file = file;
    this.cache = new Map(); // transcript path -> { mtime, size, info }
    this.hooks = {};        // sessionId -> { event, type, at, text }
    try { this.hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {}; } catch {}
    this.desktop = { at: 0, map: new Map() };
  }

  save() {
    // Keep a week of hook state
    const cutoff = Date.now() - 7 * 864e5;
    this.hooks = Object.fromEntries(Object.entries(this.hooks).filter(([, h]) => h.at > cutoff));
    try { fs.writeFileSync(this.file, JSON.stringify({ hooks: this.hooks }), { mode: 0o600 }); } catch {}
  }

  // ---- Sources -------------------------------------------------------------------------------------------
  /** Running interactive Claude Code processes, by session id. */
  live() {
    const out = new Map();
    let names = [];
    try { names = fs.readdirSync(LIVE).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
    for (const f of names) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(LIVE, f), 'utf8'));
        if (!d.sessionId || !alive(d.pid)) continue;
        out.set(d.sessionId, { pid: d.pid, status: d.status, client: d.entrypoint, name: d.name, cwd: d.cwd, at: d.statusUpdatedAt || d.updatedAt });
      } catch {}
    }
    return out;
  }

  /** The desktop app's titles and archive flags, by Claude Code session id (cached for 30 s). */
  desktopMeta() {
    if (Date.now() - this.desktop.at < 30_000) return this.desktop.map;
    const map = new Map();
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3 && !e.name.startsWith('deleted_')) walk(p, depth + 1);
        else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
          try {
            const d = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (d.cliSessionId) map.set(d.cliSessionId, { title: d.title, archived: Boolean(d.isArchived), at: d.lastActivityAt });
          } catch {}
        }
      }
    };
    walk(DESKTOP, 0);
    this.desktop = { at: Date.now(), map };
    return map;
  }

  /** Recent transcript files, newest first. */
  transcripts({ days = 7 } = {}) {
    const cutoff = Date.now() - days * 864e5;
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
    for (const d of dirs) {
      const dir = path.join(PROJECTS, d.name);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = path.join(dir, f);
        try {
          const st = fs.statSync(file);
          if (st.mtimeMs >= cutoff) out.push({ id: f.slice(0, -6), file, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** What a transcript says about itself: folder, title, first prompt, last exchange, errors. Cached by mtime. */
  info(t) {
    const hit = this.cache.get(t.file);
    if (hit && hit.mtime === t.mtime && hit.size === t.size) return hit.info;
    const head = lines(readSlice(t.file, 0, Math.min(HEAD_BYTES, t.size)), false);
    const tailStart = Math.max(0, t.size - TAIL_BYTES);
    const tail = t.size <= HEAD_BYTES ? head : lines(readSlice(t.file, tailStart, t.size - tailStart), tailStart > 0);
    const info = { id: t.id, file: t.file, cwd: '', title: '', firstPrompt: '', lastUser: '', lastUserAt: 0, lastText: '', lastAt: t.mtime, error: null, sidechainOnly: true };
    for (const e of head) {
      if (!info.cwd && e.cwd) info.cwd = e.cwd;
      if (!info.firstPrompt && e.type === 'user' && !e.isMeta && !e.isSidechain) {
        const s = textOf(e.message?.content);
        if (s && !SYNTHETIC.test(s)) info.firstPrompt = s;
      }
    }
    for (const e of tail) {
      if (e.cwd) info.cwd = e.cwd;
      if (e.type === 'custom-title' && e.customTitle) info.title = e.customTitle;
      else if (e.type === 'agent-name' && e.agentName && !info.title) info.title = e.agentName;
      if (e.isSidechain) continue;
      if (e.type === 'user' || e.type === 'assistant') info.sidechainOnly = false;
      if (e.type === 'user' && !e.isMeta) {
        const s = textOf(e.message?.content);
        if (s && !SYNTHETIC.test(s)) { info.lastUser = s; info.lastUserAt = Date.parse(e.timestamp) || 0; info.error = null; }
      } else if (e.type === 'assistant') {
        const s = textOf(e.message?.content);
        if (s.trim()) info.lastText = s;
        if (e.isApiErrorMessage) info.error = clip(s || e.error, 160);
        else if (s.trim()) info.error = null;
      }
    }
    this.cache.set(t.file, { mtime: t.mtime, size: t.size, info });
    return info;
  }

  // ---- The list ------------------------------------------------------------------------------------------
  /**
   * Recent sessions with a status: working | permission | waiting | idle | finished | errored.
   * `open`: which client has it open right now ('Claude app', 'terminal', 'ARES'), null when nothing does.
   */
  list({ days = 7, limit = 15, includeArchived = false } = {}) {
    const live = this.live();
    const meta = this.desktopMeta();
    const out = [];
    for (const t of this.transcripts({ days })) {
      let info;
      try { info = this.info(t); } catch { continue; }
      if (info.sidechainOnly) continue; // a subagent's own file, or empty
      const job = this.aresJob(t.id);
      if ((ARES_DIR.test(info.cwd) || SCRATCH.test(info.cwd)) && !job) continue; // ARES's own helpers, scratch runs
      const m = meta.get(t.id);
      if (m?.archived && !includeArchived) continue;
      const l = live.get(t.id);
      const h = this.hooks[t.id];
      const view = {
        id: t.id,
        title: clip(job?.title || m?.title || l?.name || info.title || info.firstPrompt || path.basename(info.cwd || '') || 'Untitled', 70),
        folder: tilde(job?.folder || info.cwd),
        cwd: job?.folder || info.cwd,
        ares: Boolean(job),
        jobId: job?.id || null,
        lastAt: Math.max(info.lastAt, l?.at || 0, h?.at || 0),
        open: job && job.running ? 'ARES' : l ? (l.client === 'claude-desktop' ? 'Claude app' : l.client === 'cli' ? 'terminal' : l.client || 'another client') : null,
        status: 'finished',
        detail: '',
      };
      // What it's doing now: an ARES job knows; otherwise the hooks, then the live process, then the transcript
      const hookNewer = h && h.at >= (info.lastUserAt || 0) - 1000;
      if (job) {
        view.status = { running: 'working', approval: 'permission', failed: 'errored', queued: 'working' }[job.status] || 'finished';
        view.detail = job.status === 'approval' ? job.approval?.what || '' : job.status === 'failed' ? job.error || '' : '';
      } else if (hookNewer && h.event === 'Notification' && /permission/.test(h.type) && l?.status !== 'idle') {
        view.status = 'permission'; view.detail = h.text;
      } else if (hookNewer && h.event === 'StopFailure') {
        view.status = 'errored'; view.detail = h.text;
      } else if (l?.status === 'busy') {
        view.status = 'working';
      } else if (hookNewer && h.event === 'Notification' && /elicitation|needs_input/.test(h.type)) {
        view.status = 'waiting'; view.detail = h.text;
      } else if (info.error) {
        view.status = 'errored'; view.detail = info.error;
      } else if (l) {
        view.status = 'idle'; // its turn is done; open in a client, waiting for the next message
      }
      if (!view.detail && info.lastText) view.detail = clip(redact(info.lastText), 160);
      out.push(view);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** A session from how the user refers to it: an id (or its start), a title, a folder, or words from its prompt. */
  find(ref, { days = 14 } = {}) {
    const all = this.list({ days, limit: 60, includeArchived: true });
    if (!ref) return all[0] || null;
    const r = String(ref).toLowerCase().replace(/\b(the|my|session|claude|code|one|that|chat)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!r) return all[0] || null;
    const byId = all.find((s) => s.id === r || (r.length >= 6 && s.id.startsWith(r)) || s.jobId === r);
    if (byId) return byId;
    const words = r.split(/\W+/).filter((w) => w.length > 2);
    const files = new Map(this.transcripts({ days }).map((t) => [t.id, t.file]));
    let best = null, top = 0;
    for (const s of all) {
      const info = this.cache.get(files.get(s.id))?.info;
      const hay = `${s.title} ${s.folder} ${info?.firstPrompt?.slice(0, 400) || ''}`.toLowerCase();
      // Title and folder words count double: "the wallpaper session" means the one called wallpaper
      const n = words.reduce((acc, w) => acc + (`${s.title} ${path.basename(s.cwd || '')}`.toLowerCase().includes(w) ? 2 : hay.includes(w) ? 1 : 0), 0);
      if (n > top) { best = s; top = n; }
    }
    return top >= 2 || words.length === 1 && top >= 1 ? best : null;
  }

  /** Is anything other than ARES holding this session open? (Then ARES must not write to it.) */
  openElsewhere(id) {
    const l = this.live().get(id);
    return l ? { client: l.client === 'claude-desktop' ? 'Claude app' : l.client === 'cli' ? 'terminal' : l.client || 'another client', status: l.status, pid: l.pid } : null;
  }

  // ---- Summaries ---------------------------------------------------------------------------------------
  /** A compact, redacted account of a session for the summariser: the ask, then the recent back-and-forth. */
  digest(id, { budget = 14_000 } = {}) {
    const t = this.transcripts({ days: 60 }).find((x) => x.id === id);
    if (!t) return null;
    const info = this.info(t);
    const start = Math.max(0, t.size - TAIL_BYTES);
    const recent = lines(readSlice(t.file, start, t.size - start), start > 0).filter((e) => !e.isSidechain && (e.type === 'user' || e.type === 'assistant'));
    const steps = [];
    for (const e of recent) {
      const content = e.message?.content;
      if (e.type === 'user') {
        if (e.isMeta) continue;
        const s = textOf(content);
        if (s && !SYNTHETIC.test(s)) steps.push(`USER: ${clip(s, 400)}`);
        for (const b of Array.isArray(content) ? content : []) {
          if (b?.type === 'tool_result' && b.is_error) steps.push(`  (tool error: ${clip(textOf(b.content) || String(b.content || ''), 160)})`);
        }
      } else {
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type === 'text' && b.text.trim()) steps.push(`CLAUDE: ${clip(b.text, 500)}`);
          else if (b.type === 'tool_use') steps.push(`  → ${b.name}${b.input?.description ? `: ${clip(b.input.description, 100)}` : b.input?.file_path ? ` ${tilde(b.input.file_path)}` : b.input?.command ? `: ${clip(b.input.command, 100)}` : ''}`);
        }
      }
    }
    let body = '';
    for (let i = steps.length - 1; i >= 0; i--) {
      if (body.length + steps[i].length > budget) break;
      body = `${steps[i]}\n${body}`;
    }
    const s = this.list({ days: 60, limit: 200, includeArchived: true }).find((x) => x.id === id);
    return redact([
      `Session: ${s?.title || info.title || '(untitled)'}`,
      `Folder: ${tilde(info.cwd)}`,
      `Status now: ${s?.status || 'unknown'}${s?.open ? ` (open in ${s.open})` : ''}${s?.detail && s.status !== 'finished' && s.status !== 'idle' ? `: ${s.detail}` : ''}`,
      `Original request: ${clip(info.firstPrompt, 600)}`,
      '',
      'Most recent activity (oldest first):',
      body.trim(),
    ].join('\n'));
  }

  /** "How's the wallpaper session going?": a short spoken summary from a tool-less one-shot. */
  async summarize(ref) {
    const s = typeof ref === 'object' && ref ? ref : this.find(ref);
    if (!s) return { ok: false, message: `I couldn't find a Claude session matching "${ref}".` };
    const digest = this.digest(s.id);
    if (!digest) return { ok: false, message: "That session's transcript isn't on this Mac." };
    const prompt = `Below is a condensed log of one of the user's Claude Code sessions. Summarise it for them in two to four short spoken sentences: what it was asked to do, what it has done, where it is now, and anything it's waiting on them for. Plain speech, no lists, no markdown, no file paths unless essential. Never repeat anything that looks like a key, token or password.\n\n${digest}`;
    try {
      const text = redact(await this.oneShot(prompt, { model: 'haiku', timeoutMs: 60_000, system: 'You summarise coding sessions briefly and accurately for their owner, to be read aloud.' }));
      return { ok: true, session: s, text: text.trim() };
    } catch (err) {
      this.log('session summary failed', err.message);
      return { ok: false, session: s, message: `I couldn't summarise it just now (${err.message}).` };
    }
  }

  /** The list, as a few sentences the brain can speak from. */
  describe(opts) {
    const list = this.list(opts);
    if (!list.length) return 'No Claude Code sessions in the last week.';
    const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const word = { working: 'working', permission: 'NEEDS PERMISSION', waiting: 'waiting for your answer', idle: 'done, waiting for your next message', finished: 'finished', errored: 'ERRORED' };
    return list.map((s) => `- ${s.ares ? '[ARES job] ' : ''}"${s.title}" in ${s.folder || '?'}: ${word[s.status] || s.status}${s.open ? `, open in ${s.open}` : ''}, last active ${ago(s.lastAt)}${s.detail && s.status !== 'finished' && s.status !== 'idle' ? ` (${clip(s.detail, 120)})` : ''} [id ${s.id.slice(0, 8)}]`).join('\n');
  }

  // ---- Hooks ---------------------------------------------------------------------------------------------
  /**
   * One event from the user's global Claude Code hooks (scripts/claude-hook.sh → the hook endpoint).
   * Emits 'event' { kind: finished|permission|input|error, session, text, turnMs } for things worth telling them.
   */
  hook(e) {
    const id = String(e?.session_id || '');
    if (!/^[0-9a-f-]{8,}$/i.test(id)) return { ok: false };
    const event = String(e.hook_event_name || '');
    const type = String(e.notification_type || e.error_type || e.reason || e.source || '');
    const text = redact(clip(e.message || e.last_assistant_message || e.error_type || '', 400));
    if (ARES_DIR.test(String(e.cwd || ''))) return { ok: true, ignored: 'ares' }; // never ARES's own (no loops)
    this.hooks[id] = { event, type, at: Date.now(), text };
    this.save();
    this.log('claude hook', { event, type, session: id.slice(0, 8) });

    let kind = null;
    if (event === 'Stop' && !e.stop_hook_active) kind = 'finished';
    else if (event === 'StopFailure') kind = 'error';
    else if (event === 'Notification' && /permission/.test(type)) kind = 'permission';
    else if (event === 'Notification' && /elicitation_dialog|elicitation_url_dialog|agent_needs_input/.test(type)) kind = 'input';
    if (!kind) return { ok: true };

    // Find (or briefly wait for) the transcript, for the title and how long the turn took
    const t = this.transcripts({ days: 2 }).find((x) => x.id === id);
    const info = t ? this.info(t) : null;
    const s = t ? this.list({ days: 2, limit: 100, includeArchived: true }).find((x) => x.id === id) : null;
    const title = s?.title || clip(info?.firstPrompt || path.basename(String(e.cwd || '')) || 'Claude', 60);
    const turnMs = info?.lastUserAt ? Date.now() - info.lastUserAt : null;
    this.emit('event', { kind, id, title, folder: tilde(String(e.cwd || info?.cwd || '')), text: kind === 'finished' ? redact(clip(e.last_assistant_message || info?.lastText || '', 300)) : text, turnMs, open: s?.open || null });
    return { ok: true };
  }
}

module.exports = { ClaudeSessions, tilde };
