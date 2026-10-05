// The audit log (docs/autonomy-prompt.md, section 2): every action ARES takes on the user's behalf, with its tier
// and the approval it ran under, one JSON line each in <support>/audit.jsonl. Read by the Work panel later and by
// the brain's recent_actions tool now. Never holds secrets: callers pass descriptions, not payloads.
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

class Audit {
  constructor(file, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /**
   * @param {object} e  { what, why, tier (1|2|3), source (mac|phone|telegram|job), approval (how it was allowed: 'said yes',
   *                      'tier 2', a job id…), ok (default true), kind (files|windows|ui|system|…) }
   */
  record(e) {
    const entry = { at: new Date().toISOString(), ok: true, ...e, what: redact(String(e.what || '')).slice(0, 300), why: e.why ? redact(String(e.why)).slice(0, 300) : undefined };
    try { fs.appendFileSync(this.file, JSON.stringify(entry) + '\n'); } catch (err) { this.log('audit write failed', err.message); }
    this.log('audit', { tier: entry.tier, kind: entry.kind, what: entry.what.slice(0, 80), ok: entry.ok });
    return entry;
  }

  /** The newest entries (newest last), at most n. */
  recent(n = 30) {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const lines = text.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

module.exports = { Audit };
