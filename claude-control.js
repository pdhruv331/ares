// ARES as the user's remote control for Claude Code: see their sessions, hear when one finishes or needs them,
// reply to it, start new ones (optionally on their phone through Claude Code's own Remote Control).
// claude-sessions.js reads Claude Code's files; this module decides what to do and keeps the rules:
//   - never write into a session another client has open (the desktop app keeps its sessions' processes alive);
//   - sessions ARES runs itself are code jobs (jobs.js), so they get the approval tiers, the Work screen and pushes;
//   - transcripts stay local, only short redacted summaries go to the phone.
const { EventEmitter } = require('events');

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
