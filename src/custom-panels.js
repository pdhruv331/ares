// Custom panels (docs/panels-prompt.md, section 5): "add a panel showing …". A panel is a declarative SPEC, JSON in
// <support>/panels/<id>.json: { id, title, kind, template, source, refresh, pinned, enabled, size }. Never code: the
// renderer draws each template in ARES's own style, and a source can only run what the user approved.
//
// Sources: built-in providers (calendar, tasks, weather, jobs, projects, claude usage, now playing), an Apple Shortcut,
// a shell command from an allowlist (tier 3 the first time a command is seen), a JSON or RSS URL (GET, no credentials,
// public hosts only), a local file inside the control.js folder scope, "ask Claude" (a tool-less one-shot: no faster
// than every 30 min, holds while the usage reserve says so), or static data (a countdown's target).
// Templates: value (+ gauge), list, checklist, text, image, chart, countdown.
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMPLATES = ['value', 'gauge', 'list', 'checklist', 'text', 'image', 'chart', 'countdown'];
const KINDS = ['day', 'work', 'needs'];
const SOURCES = ['builtin', 'shortcut', 'shell', 'url', 'file', 'claude', 'static'];
const PROVIDERS = ['calendar', 'tasks', 'weather', 'jobs', 'projects', 'claude-usage', 'now-playing'];
const MIN_REFRESH = { claude: 1800, shell: 30, shortcut: 60, url: 60, file: 15, builtin: 15, static: 3600 };
const TICK_MS = 5000;
const PREVIEW_TTL = 15 * 60_000;
const MAX_TEXT = 4000;

const run = (cmd, args, { timeout = 20_000, env, shell = false } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 4e6, env, shell }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').pop() || 'failed')) : resolve(String(stdout))));
});
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `panel-${crypto.randomBytes(3).toString('hex')}`;
const pick = (obj, p) => { // "a.b[0].c" into JSON
  if (!p) return obj;
  let cur = obj;
  for (const part of String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) { if (cur == null) return undefined; cur = cur[part]; }
  return cur;
};
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.eE+-]/g, '')); return Number.isFinite(n) ? n : null; };

class CustomPanels extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir             <support>/panels
   * @param {Function} o.readSettings  @param {Function} o.writeSettings  @param {Function} o.log
   * @param {(level, what, ctx) => object|null} o.tier
   * @param {(prompt, opts) => Promise<string>} [o.oneShot]      claude.oneShot
   * @param {{ reserve(limits): {ok, why} }} [o.usage]             claude-usage
   * @param {(url) => Promise<boolean>} [o.isPublicUrl]           egress.js
   * @param {(p) => 'blocked'|'inside'|'outside'|'work'} [o.classify]   control.classify
   * @param {Object<string, () => any>} [o.providers]            built-in data: name -> () => raw
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.specs = new Map();     // id -> spec
    this.states = new Map();    // id -> { data, error, at, nextAt, running }
    this.previews = new Map();  // id -> { spec, data, error, at, expires }
    this.providers = o.providers || {};
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // ---- Specs on disk ------------------------------------------------------------------------------------------------------------
  load() {
    this.specs.clear();
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith('.json'))) {
      try { const spec = this.validate(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))); this.specs.set(spec.id, spec); }
      catch (err) { this.log('custom panel unreadable', { file: f, error: err.message }); }
    }
    return this.specs.size;
  }
  save(spec) {
    fs.writeFileSync(path.join(this.dir, `${spec.id}.json`), JSON.stringify(spec, null, 2));
    this.specs.set(spec.id, spec);
    const st = this.states.get(spec.id); if (st) st.nextAt = 0;
    this.emit('update', this.message());
  }
  remove(id) {
    try { fs.unlinkSync(path.join(this.dir, `${id}.json`)); } catch {}
    this.specs.delete(id); this.states.delete(id);
    this.emit('update', this.message());
  }
  /** A spec is data: every field checked and clamped, nothing else kept. */
  validate(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('a panel spec is an object');
    const template = TEMPLATES.includes(raw.template) ? raw.template : null;
    if (!template) throw new Error(`template must be one of ${TEMPLATES.join(', ')}`);
    const src = raw.source && typeof raw.source === 'object' ? raw.source : { type: 'static', value: raw.value };
    if (!SOURCES.includes(src.type)) throw new Error(`source.type must be one of ${SOURCES.join(', ')}`);
    const source = { type: src.type };
    switch (src.type) {
      case 'builtin': if (!PROVIDERS.includes(src.provider)) throw new Error(`provider must be one of ${PROVIDERS.join(', ')}`); source.provider = src.provider; break;
      case 'shortcut': if (!src.name) throw new Error('shortcut.name missing'); source.name = String(src.name).slice(0, 100); if (src.input != null) source.input = String(src.input).slice(0, 1000); break;
      case 'shell': if (!src.command) throw new Error('shell.command missing'); source.command = String(src.command).slice(0, 500); break;
      case 'url': {
        let u; try { u = new URL(String(src.url)); } catch { throw new Error('url is not a URL'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) URLs');
        if (u.username || u.password) throw new Error('no credentials in URLs');
        source.url = u.href.slice(0, 1000); if (src.rss) source.rss = true; break;
      }
      case 'file': if (!src.path) throw new Error('file.path missing'); source.path = String(src.path).slice(0, 500); break;
      case 'claude': if (!src.prompt) throw new Error('claude.prompt missing'); source.prompt = String(src.prompt).slice(0, 2000); break;
      case 'static': {
        if (raw.template === 'countdown') { const t = src.value?.target ?? src.target; source.value = { target: typeof t === 'number' ? t : String(t || '').slice(0, 40), label: String(src.value?.label ?? src.label ?? '').slice(0, 80) }; }
        else source.value = src.value;
        break;
      }
    }
    if (src.pick) source.pick = String(src.pick).slice(0, 200);
    if (src.unit) source.unit = String(src.unit).slice(0, 12);
    if (src.max != null && num(src.max) != null) source.max = num(src.max);
    const id = raw.id ? slug(raw.id) : slug(raw.title || template);
    const minR = MIN_REFRESH[source.type] || 15;
    return { id, title: String(raw.title || id).slice(0, 60), kind: KINDS.includes(raw.kind) ? raw.kind : 'day', template, source,
      refresh: Math.max(minR, Math.min(86_400, Number(raw.refresh) || (source.type === 'claude' ? 3600 : 300))),
      pinned: Boolean(raw.pinned), enabled: raw.enabled !== false, size: ['full', 'compact'].includes(raw.size) ? raw.size : 'full', created: raw.created || Date.now() };
  }

  // ---- Running sources ----------------------------------------------------------------------------------------------------------
  start() { this.load(); this.timer = setInterval(() => this.tick(), TICK_MS); this.tick(); }
  stop() { clearInterval(this.timer); }
  tick() {
    const now = Date.now();
    let running = 0;
    for (const spec of this.specs.values()) {
      if (!spec.enabled) continue;
      const st = this.states.get(spec.id) || { data: null, error: '', at: 0, nextAt: 0 };
      this.states.set(spec.id, st);
      if (st.running || st.nextAt > now || running >= 2) continue;
      running++;
      this.refresh(spec, st);
    }
    for (const [id, pv] of this.previews) if (pv.expires < now) { this.previews.delete(id); this.emit('update', this.message()); }
  }
  async refresh(spec, st = this.states.get(spec.id)) {
    if (!st) { st = { data: null, error: '', at: 0, nextAt: 0 }; this.states.set(spec.id, st); }
    st.running = true;
    try {
      const raw = await this.fetchSource(spec);
      st.data = this.shape(spec, raw);
      st.error = '';
    } catch (err) {
      st.error = err.message;
      this.log('custom panel failed', { id: spec.id, error: err.message });
    }
    st.at = Date.now();
    st.nextAt = st.at + spec.refresh * 1000;
    st.running = false;
    this.emit('update', this.message());
  }
  refreshNow(id) { const spec = this.specs.get(id); if (!spec) return false; const st = this.states.get(id); if (st) st.nextAt = 0; this.tick(); return true; }

  allowed() { return (this.readSettings().panels?.allowedCommands || []).filter((x) => typeof x === 'string'); }
  allow(command) { this.writeSettings({ panels: { ...(this.readSettings().panels || {}), allowedCommands: [...new Set([...this.allowed(), command])] } }); }

  async fetchSource(spec) {
    const src = spec.source;
    let raw;
    switch (src.type) {
      case 'static': return src.value;
      case 'builtin': {
        const fn = this.providers[src.provider];
        if (!fn) throw new Error(`no provider "${src.provider}"`);
        raw = await fn(spec);
        break;
      }
      case 'shortcut': {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-panel-'));
        try {
          const args = ['run', src.name, '-o', path.join(dir, 'out.txt')];
          if (src.input != null) { fs.writeFileSync(path.join(dir, 'in.txt'), src.input); args.push('-i', path.join(dir, 'in.txt')); }
          await run('/usr/bin/shortcuts', args, { timeout: 60_000 });
          raw = fs.existsSync(path.join(dir, 'out.txt')) ? fs.readFileSync(path.join(dir, 'out.txt'), 'utf8') : '';
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        break;
      }
      case 'shell': {
        if (!this.allowed().includes(src.command)) throw new Error('command not approved yet (say yes to the panel preview to allow it)');
        const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8' };
        raw = await run('/bin/sh', ['-c', src.command], { timeout: 20_000, env });
        break;
      }
      case 'url': {
        if (this.isPublicUrl && !(await this.isPublicUrl(src.url))) throw new Error('only public hosts');
        const res = await fetch(src.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'ARES/0.1 (personal desktop panel)', Accept: 'application/json, application/rss+xml, application/atom+xml, text/*;q=0.8' } });
        if (!res.ok) throw new Error(`${new URL(src.url).hostname} ${res.status}`);
        const text = (await res.text()).slice(0, 2_000_000);
        raw = src.rss || /^\s*<\?xml|<rss|<feed/i.test(text) ? parseFeed(text) : parseJsonOrText(text);
        break;
      }
      case 'file': {
        const p = src.path.replace(/^~(?=\/|$)/, os.homedir());
        const where = this.classify ? this.classify(p) : 'inside';
        if (where !== 'inside') throw new Error(where === 'blocked' ? 'that file is off limits' : "that file isn't in a folder ARES may use");
        const text = fs.readFileSync(p, 'utf8').slice(0, 200_000);
        raw = parseJsonOrText(text);
        break;
      }
      case 'claude': {
        if (!this.oneShot) throw new Error('no Claude');
        const r = this.usage?.reserve(this.readSettings().claudeReserve || {});
        if (r && !r.ok) throw new Error(`paused: ${r.why}`);
        const text = await this.oneShot(`${src.prompt}\n\nAnswer for a small dashboard panel of type "${spec.template}". Reply with JSON only: ${TEMPLATE_HINT[spec.template]}. No prose, no markdown fences.`,
          { model: 'haiku', timeoutMs: 90_000, system: 'You fill a tiny dashboard panel for a personal assistant. You have no tools: answer from what you know, briefly. JSON only.' });
        raw = parseJsonOrText(text);
        break;
      }
    }
    if (src.pick) raw = pick(raw, src.pick);
    return raw;
  }

  /** Raw source output → the template's data (see renderer/panels.js templates). Anything odd becomes "—" with a reason. */
  shape(spec, raw) {
    const t = spec.template, src = spec.source;
    const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();
    const itemText = (x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : x?.text ?? x?.title ?? x?.name ?? x?.label ?? x?.summary ?? asText(x));
    const items = (v) => (Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : v?.list || v?.results || v?.data || (typeof v === 'string' ? v.split('\n').filter(Boolean) : [])) || [];
    switch (t) {
      case 'value': case 'gauge': {
        const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
        const value = v.value ?? v.price ?? v.count ?? v.total ?? v.temperature ?? v.temp ?? raw;
        const n = num(value);
        const max = src.max ?? num(v.max);
        return { value: asText(value).slice(0, 24), unit: v.unit || src.unit || '', label: asText(v.label || v.detail || '').slice(0, 60), change: v.change != null ? asText(v.change).slice(0, 16) : '',
          gauge: v.gauge != null ? Math.max(0, Math.min(1, num(v.gauge) ?? 0)) : n != null && max ? Math.max(0, Math.min(1, n / max)) : null };
      }
      case 'list': return { items: items(raw).slice(0, 12).map((x) => ({ text: asText(itemText(x)).slice(0, 80), status: asText(x?.status ?? x?.state ?? x?.value ?? '').slice(0, 16), kind: KINDS.includes(x?.kind) ? x.kind : /fail|late|down|error|overdue|blocked/i.test(x?.status || '') ? 'needs' : /running|open|wip|progress/i.test(x?.status || '') ? 'work' : 'day', url: /^https:\/\//.test(x?.url || x?.link || '') ? (x.url || x.link).slice(0, 300) : '' })) };
      case 'checklist': return { items: items(raw).slice(0, 12).map((x) => ({ text: asText(itemText(x)).slice(0, 80), done: Boolean(x?.done ?? x?.checked ?? x?.completed ?? /^\s*(\[x\]|✓|✔)/i.test(String(x))) })) };
      case 'text': return { text: asText(raw?.text ?? raw?.summary ?? raw?.content ?? raw).slice(0, MAX_TEXT) };
      case 'image': { const u = asText(raw?.url ?? raw?.image ?? raw?.src ?? raw); if (!/^(https:\/\/|data:image\/)/.test(u)) throw new Error('no https image URL'); return { url: u.slice(0, 2000), caption: asText(raw?.caption ?? raw?.title ?? '').slice(0, 60) }; }
      case 'chart': {
        const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        let series = Array.isArray(raw) ? raw : v.series || v.values || v.points || v.history || [];
        series = series.map((x) => (typeof x === 'object' ? num(x?.value ?? x?.y ?? x?.price ?? x?.close) : num(x))).filter((x) => x != null).slice(-48);
        const value = v.value ?? v.price ?? series[series.length - 1];
        const change = v.change ?? (series.length > 1 && series[0] ? `${(((series[series.length - 1] - series[0]) / Math.abs(series[0])) * 100).toFixed(1)}%` : '');
        return { value: asText(value).slice(0, 24), unit: v.unit || src.unit || '', change: asText(change).slice(0, 16), series, label: asText(v.label || '').slice(0, 60) };
      }
      case 'countdown': {
        const v = raw && typeof raw === 'object' ? raw : { target: raw };
        const target = typeof v.target === 'number' ? v.target : (require('./calendar').parseWhen(v.target) ?? Date.parse(v.target));
        if (!Number.isFinite(target)) throw new Error('countdown needs a target date');
        return { target, label: asText(v.label || '').slice(0, 60), from: v.from || spec.created };
      }
    }
    return { text: asText(raw) };
  }

  // ---- What the window gets ------------------------------------------------------------------------------------------------------
  view() {
    const list = [];
    for (const spec of this.specs.values()) {
      const st = this.states.get(spec.id) || {};
      list.push({ id: spec.id, title: spec.title, kind: spec.kind, template: spec.template, pinned: spec.pinned, enabled: spec.enabled, size: spec.size, refresh: spec.refresh,
        source: describeSource(spec.source), data: st.data || null, error: st.error || '', at: st.at || 0, preview: false });
    }
    for (const pv of this.previews.values()) {
      list.push({ id: pv.spec.id, title: pv.spec.title, kind: pv.spec.kind, template: pv.spec.template, pinned: pv.spec.pinned, enabled: true, size: pv.spec.size, refresh: pv.spec.refresh,
        source: describeSource(pv.spec.source), data: pv.data, error: pv.error, at: pv.at, preview: true });
    }
    return list;
  }
  message() { return { type: 'custom', panels: this.view() }; }

  // ---- Preview → keep -------------------------------------------------------------------------------------------------------------
  /** Build the spec, run its source once, show it dashed. Nothing is saved until keep(). */
  async preview(raw) {
    const spec = this.validate(raw);
    if (this.specs.has(spec.id) && !raw.id) spec.id = `${spec.id}-${crypto.randomBytes(2).toString('hex')}`;
    const pv = { spec, data: null, error: '', at: 0, expires: Date.now() + PREVIEW_TTL };
    try { pv.data = this.shape(spec, await this.fetchSource(spec)); } catch (err) { pv.error = err.message; }
    pv.at = Date.now();
    this.previews.set(spec.id, pv);
    this.emit('update', this.message());
    return pv;
  }
  keep(id, { pin } = {}) {
    const pv = this.previews.get(id);
    if (!pv) return null;
    this.previews.delete(id);
    if (pin != null) pv.spec.pinned = Boolean(pin);
    this.save(pv.spec);
    this.states.set(id, { data: pv.data, error: pv.error, at: pv.at, nextAt: pv.at + pv.spec.refresh * 1000 });
    this.emit('update', this.message());
    return pv.spec;
  }
  discard(id) { const had = this.previews.delete(id); if (had) this.emit('update', this.message()); return had; }
  async edit(id, patch) {
    const base = this.specs.get(id) || this.previews.get(id)?.spec;
    if (!base) throw new Error(`no panel "${id}"`);
    const spec = this.validate({ ...base, ...patch, source: patch.source ? patch.source : base.source, id });
    if (this.previews.has(id)) { this.previews.get(id).spec = spec; const pv = this.previews.get(id); try { pv.data = this.shape(spec, await this.fetchSource(spec)); pv.error = ''; } catch (err) { pv.error = err.message; } this.emit('update', this.message()); return spec; }
    this.save(spec);
    return spec;
  }
  toggle(id, on) { const spec = this.specs.get(id); if (!spec) return false; spec.enabled = on != null ? Boolean(on) : !spec.enabled; this.save(spec); return spec.enabled; }
  setPinned(id, on) { const spec = this.specs.get(id); if (!spec) return false; spec.pinned = Boolean(on); this.save(spec); return true; }
  findByName(name) {
    const n = String(name || '').toLowerCase().trim();
    return this.specs.get(n) || this.specs.get(slug(n)) || [...this.specs.values()].find((s) => s.title.toLowerCase() === n) || [...this.specs.values()].find((s) => s.title.toLowerCase().includes(n) || n.includes(s.title.toLowerCase()));
  }

  // ---- Bridge routes (control.routes['panels/…']) ------------------------------------------------------------------------------------
  routes() {
    const line = (p) => `${p.title} [${p.id}] · ${p.template} · ${p.source}${p.enabled ? '' : ' · off'}${p.pinned ? ' · pinned' : ''}${p.preview ? ' · PREVIEW (not kept)' : ''}${p.error ? ` · — ${p.error}` : ''}`;
    return {
      'panels/list': (_a, ctx) => { this.tier(1, { what: 'listed the custom panels', kind: 'panels' }, ctx); const v = this.view(); return { message: v.length ? v.map(line).join('\n') : 'No custom panels yet.' }; },
      'panels/preview': async (raw, ctx) => {
        let spec;
        try { spec = this.validate(raw); } catch (err) { return { message: `The spec isn't right: ${err.message}` }; }
        if (spec.source.type === 'shell' && !this.allowed().includes(spec.source.command)) {
          const hold = this.tier(3, { what: `allowed the shell command for a panel: ${spec.source.command}`, why: 'a command ARES has not run before', kind: 'panels' }, ctx);
          if (hold) return { message: `${hold.message} The panel would run this command every ${spec.refresh}s: ${spec.source.command}` };
          this.allow(spec.source.command);
        } else {
          const hold = this.tier(2, { what: `previewed a panel "${spec.title}" (${spec.template}, ${describeSource(spec.source)})`, kind: 'panels' }, ctx);
          if (hold) return hold;
        }
        const pv = await this.preview({ ...raw, id: spec.id });
        return { message: `Preview up on the Mac: "${pv.spec.title}" [${pv.spec.id}]${pv.error ? ` (its source failed: ${pv.error})` : ''}. ` +
          `Data: ${JSON.stringify(pv.data).slice(0, 300)}. Ask the user: keep it, keep it pinned, change something, or discard? Then call panel_keep / panel_edit / panel_discard with id "${pv.spec.id}".`, preview: pv.spec };
      },
      'panels/keep': ({ id, pin } = {}, ctx) => {
        const pv = this.previews.get(id);
        if (!pv) return { message: `No preview "${id}" to keep.` };
        const hold = this.tier(2, { what: `kept the panel "${pv.spec.title}"${pin ? ' (pinned)' : ''}`, kind: 'panels' }, ctx);
        if (hold) return hold;
        const spec = this.keep(id, { pin });
        return { message: `Kept "${spec.title}"${spec.pinned ? ', pinned' : ''}. It refreshes every ${spec.refresh}s.`, spec };
      },
      'panels/discard': ({ id } = {}, ctx) => { this.tier(1, { what: `discarded the panel preview "${id}"`, kind: 'panels' }, ctx); return { message: this.discard(id) ? 'Discarded.' : `No preview "${id}".` }; },
      'panels/edit': async ({ id, name, ...patch } = {}, ctx) => {
        const spec = this.specs.get(id) || this.previews.get(id)?.spec || this.findByName(name || id);
        if (!spec) return { message: `No panel "${name || id}".` };
        if (patch.source?.type === 'shell' && !this.allowed().includes(patch.source.command)) {
          const hold = this.tier(3, { what: `allowed the shell command for a panel: ${patch.source.command}`, why: 'a command ARES has not run before', kind: 'panels' }, ctx);
          if (hold) return hold;
          this.allow(patch.source.command);
        }
        const hold = this.tier(2, { what: `edited the panel "${spec.title}"`, kind: 'panels' }, ctx);
        if (hold) return hold;
        try { const out = await this.edit(spec.id, patch); return { message: `Updated "${out.title}": ${out.template}, ${describeSource(out.source)}, every ${out.refresh}s.` }; }
        catch (err) { return { message: `Couldn't change it: ${err.message}` }; }
      },
      'panels/remove': ({ id, name } = {}, ctx) => {
        const spec = this.specs.get(id) || this.findByName(name || id);
        if (!spec) return { message: `No panel "${name || id}".` };
        const hold = this.tier(2, { what: `removed the panel "${spec.title}"`, kind: 'panels' }, ctx);
        if (hold) return hold;
        this.remove(spec.id);
        return { message: `Removed "${spec.title}".` };
      },
      'panels/toggle': ({ id, name, on } = {}, ctx) => {
        const spec = this.specs.get(id) || this.findByName(name || id);
        if (!spec) return { message: `No panel "${name || id}".` };
        const hold = this.tier(2, { what: `switched the panel "${spec.title}" ${on === false ? 'off' : 'on'}`, kind: 'panels' }, ctx);
        if (hold) return hold;
        return { message: `"${spec.title}" is ${this.toggle(spec.id, on) ? 'on' : 'off'}.` };
      },
    };
  }
}

const TEMPLATE_HINT = {
  value: '{"value": "…", "unit": "", "label": "one short line", "change": ""}', gauge: '{"value": 42, "max": 100, "label": "one short line"}',
  list: '{"items": [{"text": "…", "status": "one word"}]} (at most 8)', checklist: '{"items": [{"text": "…", "done": false}]} (at most 8)',
  text: '{"text": "two or three short sentences"}', image: '{"url": "https://…"}', chart: '{"value": "…", "change": "+1.2%", "series": [numbers]}',
  countdown: '{"target": "YYYY-MM-DDTHH:MM", "label": "…"}',
};
function describeSource(s) {
  switch (s.type) {
    case 'builtin': return `built-in ${s.provider}`;
    case 'shortcut': return `Shortcut "${s.name}"`;
    case 'shell': return `shell: ${s.command}`;
    case 'url': { try { return `${s.rss ? 'RSS' : 'URL'} ${new URL(s.url).hostname}`; } catch { return 'URL'; } }
    case 'file': return `file ${s.path}`;
    case 'claude': return 'ask Claude';
    default: return 'static';
  }
}
function parseJsonOrText(text) {
  const t = String(text).trim();
  if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch {} }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  const n = Number(t.replace(/,/g, ''));
  return t && Number.isFinite(n) && /^-?[\d.,]+$/.test(t) ? n : t;
}
/** RSS / Atom, the little that a panel needs: titles (with links), newest first as given. */
function parseFeed(xml) {
  const items = [];
  const unesc = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
  for (const m of String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const title = unesc((block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = (block.match(/<link\b[^>]*href="([^"]+)"/i) || block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
    if (title) items.push({ text: title, url: unesc(link), status: '' });
    if (items.length >= 12) break;
  }
  if (!items.length) throw new Error('no items in the feed');
  return items;
}

module.exports = { CustomPanels, TEMPLATES, SOURCES, PROVIDERS, parseFeed, parseJsonOrText };
