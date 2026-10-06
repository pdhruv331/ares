// ARES phone remote: a small web server for the iPhone app. It listens on 127.0.0.1 only; Tailscale
// ("tailscale serve") publishes it to your own devices over HTTPS, never to the open internet.
// Phones pair once with a code shown on the Mac and get a private key (a cookie); every request needs it.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// Job files (results, pictures, documents, mini-apps) as the phone sees them
const FILE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', json: 'application/json',
  md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
// Worker-made pages run their scripts in an opaque origin: no network, no cookies, no way into the app
const MINI_APP_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; frame-ancestors 'self'";
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// What answers while ARES is dormant (everything else says she's powered down)
const COLD_OK = new Set(['/api/status', '/api/me', '/api/events', '/api/app', '/api/app/apk', '/api/push/fcm']);
const MAX_UPLOADS = 5;
const UPLOAD_LIMIT = 60e6; // base64 JSON: about 40 MB of files
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class PhoneServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.port
   * @param {string} o.root            app directory (serves phone/, the brain visual and three.js)
   * @param {() => object} o.readSettings
   * @param {(patch: object) => void} o.writeSettings
   * @param {(req: {text: string, voice: boolean}, send: (msg: object) => void) => Promise<void>} o.ask
   * @param {(send: (msg: object) => void) => Promise<void>} [o.greet]  the app was opened: a short spoken greeting (text + her voice), no brain turn
   * @param {(audio: Buffer, type: string) => Promise<string>} o.transcribe
   * @param {() => object[]} o.history
   * @param {string} o.apkDir          where android/build.sh puts ARES.apk and ARES.json (the Android app's updates)
   * @param {object} o.work            the Mac's jobs, for the phone's Work view (main.js phoneWork)
   * @param {object} o.calls           the phone line, for the app's Calls screen (main.js phoneCalls)
   * @param {() => object|null} o.firebase  Firebase options for the Android app's push (relay.js)
   * @param {(id: string) => object|null} [o.fileFor]  a file sent to the phone (control.js): { path, name, mime, size }
   * @param {() => object|null} [o.autonomy]  autonomy.js: projects, goals, routines, the kill switch
   * @param {() => object|null} [o.power]  the Mac's power state for the phone (main.js powerView): { mode, status, schedule, … }
   * @param {(action: string, why: string) => {ok: boolean, message?: string}} [o.powerAct]  standby | wake | powerdown | toggle | skip
   * @param {(device: object) => object|null} [o.relayInfo]  { url, id, key }: how this phone may ask the relay to wake a fully quit ARES
   * @param {Function} o.log
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    // Dormant (power.js): the server stays up so the phone can see the state and wake her, but only the cold routes answer
    this.cold = false;
    this.code = null;
    this.attempts = 0;
    this.listeners = new Set(); // apps holding /api/events open: { hash, native, send }
    // Only these files are served (the phone page, and the 3D brain it shares with the Mac app)
    this.files = {
      '/': 'phone/index.html',
      '/phone.js': 'phone/phone.js',
      '/sw.js': 'phone/sw.js',
      '/phone.css': 'phone/phone.css',
      '/manifest.webmanifest': 'phone/manifest.webmanifest',
      '/icon.png': 'phone/icon.png',
      '/work.js': 'phone/work.js',
      '/work.css': 'phone/work.css',
      '/renderer/markdown.js': 'renderer/markdown.js',
      '/renderer/neural.js': 'renderer/neural.js',
      '/renderer/brain3d.mjs': 'renderer/brain3d.mjs',
      '/renderer/brain-mesh.js': 'renderer/brain-mesh.js',
      '/node_modules/three/build/three.module.js': 'node_modules/three/build/three.module.js',
      '/node_modules/three/build/three.core.js': 'node_modules/three/build/three.core.js',
    };
    // The results renderer's libraries, bundled with the app (no CDN)
    for (const f of ['marked.umd.js', 'purify.min.js', 'chart.umd.min.js', 'mermaid.min.js', 'highlight.min.js', 'hljs-dark.css']) this.files[`/vendor/${f}`] = `renderer/vendor/${f}`;
  }

  start() {
    this.server = http.createServer((req, res) => this.route(req, res).catch((err) => {
      this.log('phone error', err.message);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }));
    this.server.listen(this.port, '127.0.0.1', () => this.log('phone server', { port: this.port }));
    this.server.on('error', (err) => this.log('phone server error', err.message));
    // A new Android build: tell every connected app, so it can offer to update
    fs.watchFile(this.appFile, { interval: 5000 }, () => {
      const app = this.appInfo();
      if (!app) return;
      this.log('android update available', { version: app.versionName, code: app.versionCode });
      for (const l of this.listeners) if (l.native) l.send({ type: 'update', app });
    });
  }

  stop() { this.server?.close(); this.server = null; fs.unwatchFile(this.appFile); }
  /** Power down = dormant: keep listening (the live lines stay open for the state), answer only the cold routes. */
  setCold(on) { this.cold = Boolean(on); }

  /** A short id for a paired phone (what the relay knows it by) and its wake key (made once, kept with the device). */
  deviceId(d) { return d.hash.slice(0, 16); }
  wakeKey(d) {
    if (d.wake) return d.wake;
    const wake = crypto.randomBytes(32).toString('hex');
    this.writeSettings({ phoneDevices: this.devices.map((x) => (x.hash === d.hash ? { ...x, wake } : x)) });
    return wake;
  }

  get appFile() { return path.join(this.apkDir, 'ARES.json'); }
  /** The latest Android build on this Mac: { versionCode, versionName, sha256, size }, or null. */
  appInfo() {
    try { return JSON.parse(fs.readFileSync(this.appFile, 'utf8')); } catch { return null; }
  }

  /** A fresh six-digit pairing code (shown on the Mac). */
  newCode() {
    this.code = String(crypto.randomInt(100000, 999999));
    this.attempts = 0;
    this.emit('code', this.code);
    return this.code;
  }

  get devices() { return this.readSettings().phoneDevices || []; }

  /** The paired device making this request, or null. */
  device(req) {
    const token = /(?:^|;\s*)ares_token=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    return (token && this.devices.find((d) => d.hash === sha(token))) || null;
  }
  authed(req) { return Boolean(this.device(req)); }

  unpairAll() {
    this.writeSettings({ phoneDevices: [] });
    for (const l of this.listeners) l.end();
    this.emit('devices');
  }

  /** Deliver a notification to every native app that's connected. Returns how many got it. */
  notifyNative(msg) {
    const natives = [...this.listeners].filter((l) => l.native);
    for (const l of natives) l.send({ type: 'notify', ...msg });
    return new Set(natives.map((l) => l.hash)).size;
  }
  /** Something every open app should know about live (job progress, a job seen elsewhere). */
  broadcast(msg) {
    for (const l of this.listeners) l.send(msg);
  }

  async body(req, limit = 10e6) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > limit) throw new Error('too large'); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));

    if (req.method === 'GET' && this.files[url.pathname]) {
      const file = path.join(this.root, this.files[url.pathname]);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': PAGE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...(url.pathname.startsWith('/vendor/') && { 'Cache-Control': 'private, max-age=86400' }),
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const { code, name } = JSON.parse((await this.body(req, 4096)).toString() || '{}');
      if (!this.code || String(code).trim() !== this.code) {
        if (++this.attempts >= 5) this.newCode(); // too many guesses: the old code stops working
        this.log('phone pair failed', { attempts: this.attempts });
        return json(403, { ok: false, error: 'That code is not right. Check the ARES window on your Mac.' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const device = { hash: sha(token), name: String(name || 'phone').slice(0, 40), paired: new Date().toISOString() };
      this.writeSettings({ phoneDevices: [...this.devices, device] });
      this.code = null;
      this.log('phone paired', { name: device.name });
      this.emit('paired', device);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `ares_token=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Share target before the service worker is installed: just open the app
    if (url.pathname === '/share') return res.writeHead(303, { Location: '/' }).end();
    if (!url.pathname.startsWith('/api/')) return res.writeHead(404).end();
    if (!this.authed(req)) return json(401, { ok: false, error: 'not paired' });

    // Power from the phone (docs/ignition-prompt.md §4d): the state, and standby / wake / power down over this channel.
    // Works while dormant too: that's how the orb hold wakes her without the relay.
    if (url.pathname === '/api/power' || url.pathname.startsWith('/api/power/')) return this.powerRoute(req, res, url, json);
    if (this.cold && !COLD_OK.has(url.pathname)) return json(503, { ok: false, error: 'ARES is powered down. Hold the orb to wake her.', cold: true });

    // The phone's corner readouts: host, battery, Claude windows (control.js has the fuller system_info tool)
    if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { ok: true, ...(await (this.status?.() ?? {})) });
    if (req.method === 'GET' && url.pathname === '/api/me') {
      return json(200, { ok: true, push: Boolean(this.device(req).subscription), reduceMotion: Boolean(this.readSettings().reduceMotion),
        firebase: this.firebase?.() || null, calls: Boolean(this.calls?.ready) });
    }
    // The Android app's Firebase push token: kept with the device, and handed to the relay (main.js)
    if (req.method === 'POST' && url.pathname === '/api/push/fcm') {
      const { token } = JSON.parse((await this.body(req, 8192)).toString() || '{}');
      if (!/^[\w:.-]{20,4096}$/.test(token || '')) return json(400, { ok: false });
      const me = this.device(req);
      if (me.fcm !== token) {
        this.writeSettings({ phoneDevices: this.devices.map((d) => (d.hash === me.hash ? { ...d, fcm: token } : d)) });
        this.log('phone fcm token', { name: me.name });
      }
      this.emit('fcm', { ...me, fcm: token });
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/calls' || url.pathname.startsWith('/api/calls/')) return this.callRoute(req, res, url, json);
    if (req.method === 'GET' && url.pathname === '/api/push/key') return json(200, { ok: true, key: this.pushKey() });
    if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
      const sub = JSON.parse((await this.body(req, 8192)).toString());
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint)) return json(400, { ok: false });
      const me = this.device(req);
      this.writeSettings({ phoneDevices: this.devices.map((d) => (d.hash === me.hash ? { ...d, subscription: sub } : d)) });
      this.log('phone push subscribed', { name: me.name });
      return json(200, { ok: true });
    }
    // The live line to the Mac: job progress for every app, and (for the Android app, not the web app, which
    // has Web Push) notifications and updates
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const me = this.device(req);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const l = { hash: me.hash, native: !url.searchParams.has('web'), send: (m) => res.write(JSON.stringify(m) + '\n'), end: () => res.end() };
      const ping = setInterval(() => l.send({ type: 'ping' }), 25000);
      this.listeners.add(l);
      l.send({ type: 'hello', name: me.name, app: this.appInfo(), firebase: this.firebase?.() || null, fcm: Boolean(me.fcm), power: this.power?.() || null, relay: this.relayInfo?.(me) || null });
      this.log('phone events open', { name: me.name, open: this.listeners.size });
      req.on('close', () => { clearInterval(ping); this.listeners.delete(l); });
      return;
    }
    // Android app updates, served over the same private Tailscale connection
    if (req.method === 'GET' && url.pathname === '/api/app') return json(200, { ok: true, app: this.appInfo() });
    if (req.method === 'GET' && url.pathname === '/api/app/apk') {
      const file = path.join(this.apkDir, 'ARES.apk');
      if (!this.appInfo() || !fs.existsSync(file)) return json(404, { ok: false });
      this.log('android update download', { name: this.device(req).name });
      res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/history') return json(200, { ok: true, history: this.history() });

    if (url.pathname === '/api/jobs' || url.pathname.startsWith('/api/jobs/')) return this.jobRoute(req, res, url, json);
    if (url.pathname.startsWith('/api/autonomy/')) return this.autonomyRoute(req, res, url, json);
    // A running project's dev server, reachable from the phone only over Tailscale (never a public URL)
    if (req.method === 'GET' && /^\/api\/projects\/[\w-]+\/preview(\/|$)/.test(url.pathname)) return this.previewRoute(req, res, url, json);
    // "Send this to my phone": a file the Mac registered for this one send (control.js sendbox), never a public link
    if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
      const f = this.fileFor?.(url.pathname.slice('/api/files/'.length));
      if (!f) return json(404, { ok: false, error: 'That file is no longer available from the Mac.' });
      const inline = !url.searchParams.has('download') && /^(image\/|application\/pdf|text\/plain)/.test(f.mime);
      res.writeHead(200, {
        'Content-Type': f.mime, 'Content-Length': f.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      });
      this.log('phone file download', { name: f.name, device: this.device(req).name });
      return fs.createReadStream(f.path).pipe(res);
    }
    if (url.pathname.startsWith('/api/claude/')) return this.claudeRoute(req, res, url, json);

    if (req.method === 'POST' && url.pathname === '/api/stt') {
      const audio = await this.body(req);
      const text = await this.transcribe(audio, req.headers['content-type'] || 'audio/mp4');
      return json(200, { ok: true, text });
    }

    // The app opened: greet out loud (text, then her voice sentence by sentence, like a reply; no brain turn)
    if (req.method === 'POST' && url.pathname === '/api/greet') {
      if (!this.greet) return json(503, { ok: false });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      let open = true;
      req.on('close', () => { open = false; });
      await this.greet((msg) => { if (open) res.write(JSON.stringify(msg) + '\n'); });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const { text, voice, images } = JSON.parse((await this.body(req, 15e6)).toString() || '{}');
      if (!text || typeof text !== 'string') return json(400, { ok: false });
      const pics = (Array.isArray(images) ? images : []).slice(0, 3)
        .filter((im) => /^image\/(png|jpeg|gif|webp)$/.test(im?.media_type) && typeof im.data === 'string');
      // Newline-delimited JSON, streamed: text as she writes it, then her voice sentence by sentence
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      let open = true;
      req.on('close', () => { open = false; });
      await this.ask({ text: text.slice(0, 8000), voice: Boolean(voice), images: pics }, (msg) => { if (open) res.write(JSON.stringify(msg) + '\n'); });
      return res.end();
    }

    return res.writeHead(404).end();
  }

  // ---- Power: standby, wake, power down from the phone (a paired phone is the owner; the app confirms power down itself) ------
  async powerRoute(req, res, url, json) {
    if (req.method === 'GET') return json(200, { ok: true, ...(this.power?.() || { mode: 'unknown' }) });
    if (req.method !== 'POST') return json(405, { ok: false });
    const b = JSON.parse((await this.body(req, 4096)).toString() || '{}');
    const action = String(url.pathname.split('/')[3] || b.action || '').toLowerCase();
    if (!['standby', 'wake', 'powerdown', 'toggle', 'skip'].includes(action)) return json(404, { ok: false, error: 'standby, wake, powerdown, toggle or skip' });
    const me = this.device(req);
    this.log('phone power', { action, device: me.name });
    const r = this.powerAct ? this.powerAct(action, `phone (${me.name})`) : { ok: false, message: 'power control is not running' };
    return json(r.ok ? 200 : 409, { ok: r.ok, message: r.message || '', ...(this.power?.() || {}) });
  }

  // ---- Autonomy: projects, goals, routines and the kill switch, from the phone (a paired phone is the owner) -------------
  async autonomyRoute(req, res, url, json) {
    const a = this.autonomy?.();
    if (!a) return json(503, { ok: false, error: 'Autonomy is still starting up.' });
    const name = url.pathname.slice('/api/autonomy/'.length);
    const ctx = { source: 'phone', verified: true, turn: 0, confirm: () => ({ allow: true, said: 'tapped on the phone' }) };
    if (req.method === 'GET' && name === 'state') return json(200, { ok: true, state: a.view() });
    if (req.method !== 'POST') return json(405, { ok: false });
    const b = JSON.parse((await this.body(req, 65536)).toString() || '{}');
    if (name === 'stop') return json(200, { ok: true, ...(await a.handle('stop', {}, ctx)) });
    if (name === 'resume') return json(200, { ok: true, ...(await a.handle('resume', { what: b.what }, ctx)) });
    if (name === 'act' && typeof b.name === 'string' && /^(project|goal|routine)\//.test(b.name)) { this.log('phone autonomy', { name: b.name, device: this.device(req).name }); return json(200, { ok: true, ...(await a.handle(b.name, b.args || {}, ctx)) }); }
    return json(404, { ok: false });
  }
  previewRoute(req, res, url, json) {
    const a = this.autonomy?.();
    const id = url.pathname.split('/')[3];
    const target = a?.previewTarget(id);
    if (!target) return json(404, { ok: false, error: 'That project isn\'t running right now ("run it" first).' });
    const rest = url.pathname.replace(/^\/api\/projects\/[\w-]+\/preview/, '') || '/';
    const proxy = http.request({ host: target.hostname, port: target.port || 80, path: rest + url.search, method: 'GET', headers: { ...req.headers, host: target.host, cookie: '' } }, (up) => {
      const headers = { ...up.headers, 'cache-control': 'no-store' };
      delete headers['set-cookie'];
      res.writeHead(up.statusCode || 200, headers);
      up.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) json(502, { ok: false, error: 'The project\'s server didn\'t answer.' }); else res.end(); });
    proxy.end();
  }

  // ---- Calls: the ARES phone line (calls.js), from the phone ---------------------------------------------
  // A paired phone is the owner: placing a call from the app's form (after its own confirm step) is the yes.
  async callRoute(req, res, url, json) {
    const calls = this.calls;
    if (!calls?.ready) return json(503, { ok: false, error: "The phone line isn't set up on the Mac." });
    const id = url.pathname.split('/')[3];
    if (req.method === 'GET' && !id) return json(200, { ok: true, calls: calls.views(), messages: calls.messages() });
    if (req.method === 'GET' && id) {
      const call = calls.detail(decodeURIComponent(id));
      return call ? json(200, { ok: true, call }) : json(404, { ok: false, error: 'no such call' });
    }
    if (req.method === 'POST' && !id) {
      const b = JSON.parse((await this.body(req, 16384)).toString() || '{}');
      const str = (v, n) => String(v || '').trim().slice(0, n);
      try {
        const message = await calls.make({ to: str(b.to, 40), name: str(b.name, 80), purpose: str(b.purpose, 200), brief: str(b.brief, 3000), at: str(b.at, 40) || undefined, source: 'phone' });
        this.log('phone call placed', { scheduled: Boolean(b.at) });
        return json(200, { ok: true, message });
      } catch (err) { return json(400, { ok: false, error: err.message }); }
    }
    if (req.method === 'POST' && id === 'cancel') {
      const b = JSON.parse((await this.body(req, 4096)).toString() || '{}');
      return json(200, { ok: true, message: calls.cancelScheduled(String(b.id || '')) });
    }
    return res.writeHead(404).end();
  }

  // ---- Claude Code sessions (claude-control.js), from the phone ------------------------------------------
  // Only short, redacted summaries: transcripts never leave the Mac.
  async claudeRoute(req, res, url, json) {
    const ctl = this.claude?.();
    if (!ctl) return json(503, { ok: false, error: 'Claude session control is still starting up.' });
    const parts = url.pathname.split('/').slice(3).map(decodeURIComponent); // sessions | sessions/<id>/summary …
    const body = async () => { try { return JSON.parse((await this.body(req, 16384)).toString() || '{}'); } catch { return {}; } };
    try {
      if (req.method === 'GET' && parts[0] === 'sessions' && !parts[1]) return json(200, { ok: true, sessions: ctl.list() });
      if (req.method === 'GET' && parts[0] === 'sessions' && parts[2] === 'summary') return json(200, { ok: true, ...(await ctl.status({ session: parts[1] })) });
      if (ctl.phoneRoute) {
        const out = await ctl.phoneRoute(req.method, parts, req.method === 'POST' ? await body() : {}, this.device(req));
        if (out) return json(out.status || 200, out);
      }
    } catch (err) { return json(400, { ok: false, error: err.message }); }
    return res.writeHead(404).end();
  }

  // ---- Work: the Mac's jobs, remote-controlled from the phone ------------------------------------------
  // The Mac stays the source of truth: everything here goes through the same Jobs as the Work panel.
  // A paired phone is the owner (like its chat), so it can start and follow up jobs; approvals still need an
  // explicit Yes, and only for the request that's actually waiting. Deleting stays on the Mac.
  async jobRoute(req, res, url, json) {
    const work = this.work;
    if (!work) return json(503, { ok: false, error: 'work mode is not running' });
    const me = this.device(req);
    const input = async (limit = 65536) => { try { return JSON.parse((await this.body(req, limit)).toString() || '{}'); } catch (err) { return { bad: err.message }; } };

    if (url.pathname === '/api/jobs') {
      if (req.method === 'GET') {
        const q = url.searchParams.get('q');
        if (q != null) return json(200, { ok: true, ids: work.search(q) });
        return json(200, { ok: true, jobs: work.list(), gallery: work.gallery() });
      }
      if (req.method === 'POST') {
        const b = await input(UPLOAD_LIMIT);
        if (b.bad || typeof b.text !== 'string' || !b.text.trim()) return json(400, { ok: false, error: b.bad === 'too large' ? 'Those files are too big to send from the phone.' : 'What should the job be?' });
        return this.withUploads(b.files, json, async (paths) => {
          const job = await work.start({ text: b.text.slice(0, 8000), title: b.title, link: b.link, files: paths, device: me.name });
          this.log('phone job start', { id: job.id, files: paths.length });
          return json(200, { ok: true, job });
        });
      }
      return res.writeHead(405).end();
    }

    const m = url.pathname.match(/^\/api\/jobs\/([\w-]{1,40})(?:\/(file|preview|version)\/(.+)|\/(\w[\w-]*))?$/);
    if (!m) return json(404, { ok: false });
    const [, id, sub, rest, action] = m;
    if (!work.get(id)) return json(404, { ok: false, error: 'no such job' });

    if (req.method === 'GET' && !sub && !action) return json(200, { ok: true, ...work.detail(id) });
    if (req.method === 'GET' && sub === 'version') {
      const text = work.version(id, Number(rest));
      return text == null ? json(404, { ok: false }) : json(200, { ok: true, text });
    }
    if (req.method === 'GET' && (sub === 'file' || sub === 'preview')) {
      let rel;
      try { rel = rest.split('/').map(decodeURIComponent).join('/'); } catch { return json(400, { ok: false }); }
      if (sub === 'preview') return json(200, { ok: true, ...(await work.preview(id, rel) || { error: 'No preview for this file.' }) });
      const file = work.file(id, rel); // realpath-checked: only real files strictly inside this job's folder, never hidden ones
      if (!file) return json(404, { ok: false });
      const ext = path.extname(file).slice(1).toLowerCase();
      const headers = {
        'Content-Type': FILE_TYPES[ext] || 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': /^(html?|svg)$/.test(ext) ? MINI_APP_CSP : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      };
      if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
      res.writeHead(200, headers);
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method !== 'POST' || !action) return json(405, { ok: false });

    const b = await input(action === 'continue' ? UPLOAD_LIMIT : 4096);
    if (b.bad) return json(400, { ok: false, error: b.bad === 'too large' ? 'Those files are too big to send from the phone.' : 'bad request' });
    const reply = (r) => json(r?.error ? 409 : 200, { ok: !r?.error, ...r });
    switch (action) {
      case 'continue':
        if (typeof b.text !== 'string' || !b.text.trim()) return json(400, { ok: false, error: 'What should change?' });
        return this.withUploads(b.files, json, async (paths) => reply(await work.continue(id, b.text.slice(0, 8000), paths)));
      case 'answer': return reply(work.answer(id, b.yes === true, b.at, me.name));
      case 'cancel': return reply(work.cancel(id));
      case 'dismiss': return reply(work.dismiss(id));
      case 'seen': return reply(work.seen(id, me.name));
      case 'send-to-mac': return reply(work.sendToMac(id));
      default: return json(404, { ok: false });
    }
  }

  /** Files sent from the phone (shared PDFs, screenshots…): written to a private temp folder for jobs.attach to copy. */
  async withUploads(files, json, fn) {
    const list = Array.isArray(files) ? files.slice(0, MAX_UPLOADS) : [];
    if (!list.length) {
      try { return await fn([]); } catch (err) { return json(409, { ok: false, error: err.message }); }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-phone-'));
    try {
      const paths = [];
      for (const f of list) {
        if (typeof f?.data !== 'string') continue;
        const ext = (String(f.name || '').match(/\.[a-z0-9]{1,6}$/i)?.[0] || '').toLowerCase();
        const base = path.basename(String(f.name || 'file'), ext).replace(/[^\w .()-]+/g, '_').replace(/^[.\s]+/, '').slice(0, 80) || 'file';
        let file = path.join(dir, base + ext);
        for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n})${ext}`);
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'), { mode: 0o600 });
        paths.push(file);
      }
      return await fn(paths);
    } catch (err) {
      return json(409, { ok: false, error: err.message });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

module.exports = { PhoneServer };
