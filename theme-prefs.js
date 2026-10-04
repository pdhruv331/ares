// The ARES theme's memory of the user's own setup (docs/ares-theme-prompt.md): before the theme changes anything, the
// original is saved here, once. Turning the theme off puts every saved original back and forgets it.
//
// <support>/theme/originals.json: { "<id>": { kind, …what restore() needs }, … }
//   pref    a macOS preference (CFPreferences, as `defaults`): { domain, key, exists, plist (base64 XML) }
//   script  a value read and set through AppleScript (System Events appearance/dock preferences): { get, set, value }
//   icon    a file or folder's custom Finder icon (theme-icons.js): { path, had, xattrs }
//   file    a file the theme wrote or replaced: { path, existed, content (base64) }
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30_000, ...opts }, (err, out, stderr) => {
  if (err) { err.stderr = String(stderr || '').trim(); return reject(err); }
  resolve(String(out));
}));
const osa = (script) => run('/usr/bin/osascript', ['-e', script]).then((s) => s.trim());

/** A JS value as an XML plist document. Numbers are integers unless wrapped: { real: 0.5 }. */
function plist(v) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const node = (x) => {
    if (x === true) return '<true/>';
    if (x === false) return '<false/>';
    if (typeof x === 'number') return Number.isInteger(x) ? `<integer>${x}</integer>` : `<real>${x}</real>`;
    if (typeof x === 'string') return `<string>${esc(x)}</string>`;
    if (Array.isArray(x)) return `<array>${x.map(node).join('')}</array>`;
    if (x && typeof x === 'object' && 'real' in x && Object.keys(x).length === 1) return `<real>${x.real}</real>`;
    return `<dict>${Object.entries(x).map(([k, y]) => `<key>${esc(k)}</key>${node(y)}`).join('')}</dict>`;
  };
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${node(v)}</plist>`).toString('base64');
}

class Originals {
  constructor({ dir, helper, log }) {
    this.dir = dir;
    this.file = path.join(dir, 'originals.json');
    this.helper = helper;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), { mode: 0o600 }); }
  has(id) { return id in this.data; }
  get ids() { return Object.keys(this.data); }
  get(id) { return this.data[id]; }
  /** Remember the original for `id`, unless it already is (a second apply must never save ARES's own values). */
  keep(id, rec) { if (!this.has(id)) { this.data[id] = rec; this.save(); } }
  forget(id) { delete this.data[id]; this.save(); }

  helperJson(args) {
    return run(this.helper, args).then((o) => JSON.parse(o), (err) => { try { return JSON.parse(err.stdout || ''); } catch { throw err; } });
  }

  // ---- Preferences (CFPreferences) ----
  async readPref(domain, key) { return this.helperJson(['pref-get', domain, key]); }
  /** Save the original, then write `value` (a JS value for plist(); null removes the setting). True if it stuck. */
  async setPref(domain, key, value) {
    const id = `pref:${domain}:${key}`;
    if (!this.has(id)) { const cur = await this.readPref(domain, key); this.keep(id, { kind: 'pref', domain, key, exists: cur.exists, plist: cur.plist || null }); }
    const r = await this.helperJson(['pref-set', domain, key, value == null ? '-' : plist(value)]).catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) this.log('theme pref not saved', { domain, key });
    return Boolean(r.ok);
  }
  /** Save a setting's original without changing it (something else is about to change it). */
  async keepPref(domain, key) {
    const id = `pref:${domain}:${key}`;
    if (this.has(id)) return;
    const cur = await this.readPref(domain, key);
    this.keep(id, { kind: 'pref', domain, key, exists: cur.exists, plist: cur.plist || null });
  }
  async restorePref(rec) {
    const r = await this.helperJson(['pref-set', rec.domain, rec.key, rec.exists ? rec.plist : '-']).catch((err) => ({ ok: false, error: err.message }));
    return Boolean(r.ok);
  }

  // ---- AppleScript-backed settings (System Events: the supported way to flip dark mode, Dock and menu bar hiding) ----
  async setScript(id, { get, set }, value) {
    if (!this.has(id)) this.keep(id, { kind: 'script', get, set, value: await osa(get) });
    await osa(set.replace('%s', value));
  }
  async restoreScript(rec) { await osa(rec.set.replace('%s', rec.value)); }

  // ---- Files the theme writes in the user's space (a profile, a settings file) ----
  keepFile(id, file) {
    if (this.has(id)) return;
    const existed = fs.existsSync(file);
    this.keep(id, { kind: 'file', path: file, existed, content: existed ? fs.readFileSync(file).toString('base64') : null });
  }
  restoreFile(rec) {
    if (rec.existed) fs.writeFileSync(rec.path, Buffer.from(rec.content, 'base64'));
    else fs.rmSync(rec.path, { force: true, recursive: true });
  }

  /** Put back everything matching `prefix` (all of it with ''), newest first. Returns what couldn't be restored. */
  async restore(prefix = '', restorers = {}) {
    const failed = [];
    for (const id of this.ids.filter((x) => x.startsWith(prefix)).reverse()) {
      const rec = this.data[id];
      try {
        const fn = restorers[rec.kind] || { pref: (r) => this.restorePref(r), script: (r) => this.restoreScript(r).then(() => true), file: (r) => { this.restoreFile(r); return true; } }[rec.kind];
        const ok = fn ? await fn(rec) : false;
        if (ok === false) { failed.push(id); continue; }
        this.forget(id);
      } catch (err) {
        this.log('theme restore failed', { id, error: err.stderr || err.message });
        failed.push(id);
      }
    }
    return failed;
  }
}

module.exports = { Originals, plist, osa, run };
