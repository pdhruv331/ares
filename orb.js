// The corner orb (docs/orb-prompt.md): a ≈30 pt mini reactor in a corner of the screen while ARES's live reactor can't
// be seen (the desktop covered, theme.js's brainVisible rule), that does real work:
//
//   click        the PORTAL: ARES lifts above the apps behind a circle growing from the orb (renderer/surface.js draws it);
//                click again (⌥Space, Esc, "that's all") and it closes back into the orb, the app that was in front gets
//                focus back. While she speaks a click stops her instead ("Stopped.").
//   hold         push-to-talk: she listens without the wake word (Voice ID still checks the voice); release sends. A long
//                or screen-needing answer opens the portal; otherwise she just speaks, with the caption above the orb.
//   right-click  the quick menu (Open ARES, Hold to talk, Standby, Stop everything, Open Work, Mute for 1 hour, What's on
//                my screen?), each confirmed with a small card.
//   drop         files, text or a URL: action chips (summarise, send to phone, start a project, ask about it; explain, save
//                to memory, add to tasks, send to phone), all through the existing tools and tiers (control.js scope).
//   signals      the main job's progress (violet ring), needs-you (amber pulses + count), calls/voicemails (green), Claude
//                usage (amber tint), thinking (comet), speaking (white core + waveform), standby (dim blue).
//
// One transparent panel window in the corner, above everything, on every Space, never focused, click-through except over
// the orb's own circle and its open menu/cards/chips (the pointer is checked here, as the dock does: macOS sends no mouse
// moves to a click-through window of an inactive app). It never covers a text caret: `ares-theme orb-watch` reports the
// focused field's caret, and the orb fades to 15% while the caret is within 40 pt. The same watcher says when a drag is in
// progress, so the window can take the drop. Idle, the page draws at 3 fps.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { BrowserWindow, screen, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');

const W = 440, H = 360;        // the window: the orb in its corner plus room for the caption, menu, cards and chips
const MARGIN = 24, R = 16;     // the orb's centre is MARGIN + R from both edges of the corner
const NEAR = 220;              // px from the orb where the pointer is checked often
const DRAG_REACH = 170;        // px: a drag this close makes the window take the drop (and the orb swells)
const CARET_PT = 40;           // the orb fades when the caret is this close
const HOLD_MS = 350;           // (the page decides the hold; kept here for the docs)
const SUMMARISE = 'Summarise this for me: the key points first, then the details worth knowing, and anything that needs my attention or action.';
const CORNERS = { br: 'Bottom Right', bl: 'Bottom Left', tr: 'Top Right', tl: 'Top Left' };
const tilde = (p) => p.replace(os.homedir(), '~');
const firstSentences = (t, n = 2) => (String(t || '').match(/.+?[.!?]+(?=\s|$)/g) || [t || '']).slice(0, n).join(' ').replace(/\s+/g, ' ').trim();
const when = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

class Orb {
  /**
   * @param {object} o
   * @param {string} o.appDir  @param {string} o.helper (ares-theme)  @param {(…) => void} o.log
   * @param {() => object} o.readSettings  @param {(p: object) => void} o.writeSettings
   * @param {object} o.deps     listener, power, autonomy, jobs, control, memory, tasks, usage, calls, sessions (getters are fine)
   * @param {object} o.hooks    summon(), dismiss(), sendWindow(ch, msg), openView(view), stopSpeaking(), ask(text), silentNow(),
   *                            liveCall(), brainVisible(), fullscreen(), ownIds: string[]
   */
  constructor(o) {
    Object.assign(this, o);
    this.win = null;
    this.ready = false;
    this.on = false;             // what the page shows
    this.ctx = { summoned: false, brain: false, power: 'online', fullscreen: false };
    this.hits = { rects: [], all: false };
    this.interactive = false;
    this.display = null;
    this.drag = { on: false, files: false };
    this.caret = null;
    this.caretNear = false;
    this.portalOpen = false;
    this.ptt = null;             // 'listening' | 'thinking' | null
    this.pttAt = 0;
    this.quietUntil = 0;         // "Mute for 1 hour"
    this.cards = new Map();      // id -> { card, act: (what) => void }
    this.seq = 0;
    this.pending = null;         // a drop waiting for its chip
    this.watched = new Map();    // job id -> { kind }
    this.context = null;         // a dropped file to ask about: { files, at }
    this.callNote = null;        // a recent inbound call / voicemail
    this.usageWarned = new Set();
    this.speaking = false;
    this.ipc = [];
  }

  // ---- Settings ----------------------------------------------------------------------------------------------
  get opts() {
    const t = this.readSettings().theme?.orb || {};
    return { enabled: t.enabled !== false, corner: CORNERS[t.corner] ? t.corner : 'br', hideFullscreen: t.hideFullscreen !== false };
  }
  save(patch) {
    const s = this.readSettings();
    this.writeSettings({ theme: { ...(s.theme || {}), orb: { ...(s.theme?.orb || {}), ...patch } } });
    this.prefs();
  }
  prefs() {
    const o = this.opts;
    if (o.enabled && !this.win) this.start();
    else if (!o.enabled && this.win) this.stop();
    if (this.win) { this.place(true); this.send({ type: 'corner', corner: o.corner }); this.update(); }
  }
  /** The ◉ → Theme Options lines. */
  menu(refresh) {
    const o = this.opts;
    const act = (fn) => (item) => { fn(item); refresh?.(); };
    return [
      { label: 'Corner Orb', type: 'checkbox', checked: o.enabled, click: act((item) => this.save({ enabled: item.checked })) },
      { label: 'Orb Corner', submenu: Object.entries(CORNERS).map(([k, label]) => ({ label, type: 'radio', checked: o.corner === k, click: act(() => this.save({ corner: k })) })) },
      { label: 'Hide the Orb in Full Screen', type: 'checkbox', checked: o.hideFullscreen, click: act((item) => this.save({ hideFullscreen: item.checked })) },
    ];
  }

  // ---- Lifecycle ----------------------------------------------------------------------------------------------
  start() {
    if (this.win || !this.opts.enabled) return;
    this.display = this.displayFor(screen.getCursorScreenPoint());
    const b = this.bounds();
    this.win = new BrowserWindow({
      ...b, type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, fullscreenable: false, acceptFirstMouse: true, show: false,
      webPreferences: { preload: path.join(this.appDir, 'orb-preload.js'), contextIsolation: true, backgroundThrottling: false },
    });
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.win.setHiddenInMissionControl?.(true);
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.loadFile(path.join(this.appDir, 'renderer', 'orb.html'));
    this.win.once('ready-to-show', () => this.win?.showInactive());
    this.win.webContents.on('render-process-gone', () => { this.ready = false; });
    const on = (ch, fn) => { const h = (e, m) => { if (this.win && e.sender === this.win.webContents) fn(m); }; ipcMain.on(ch, h); this.ipc.push([ch, h]); };
    on('orb-ready', () => { this.ready = true; this.send({ type: 'corner', corner: this.opts.corner }); this.update(); this.send({ type: 'show', on: this.on, corner: this.opts.corner }); this.caretWatch(this.on); this.refresh(); this.pushSounds(); });
    on('orb-hits', (h) => { this.hits = { rects: h?.rects || [], all: Boolean(h?.all) }; this.check(); });
    on('orb-act', (m) => this.act(m).catch((err) => this.log('orb act failed', { type: m?.type, error: err.message })));
    this.onDisplays = () => this.place(true);
    for (const e of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(e, this.onDisplays);
    this.watch();
    this.tick();
    this.soundTimer = setInterval(() => { if (this.on) this.pushSounds(); }, 60_000);
    this.log('orb started', { corner: this.opts.corner });
  }
  stop() {
    clearTimeout(this.timer); this.timer = null;
    clearInterval(this.soundTimer);
    for (const [ch, h] of this.ipc) ipcMain.removeListener(ch, h);
    this.ipc = [];
    if (this.onDisplays) for (const e of ['display-metrics-changed', 'display-added', 'display-removed']) screen.removeListener(e, this.onDisplays);
    const w = this.watcher; this.watcher = null; try { w?.kill(); } catch {}
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
    this.on = false;
  }
  send(msg) { if (this.win && this.ready && !this.win.isDestroyed()) this.win.webContents.send('orb', msg); }

  // ---- Where: the corner of the display with the pointer -----------------------------------------------------
  displayFor(p) { try { return screen.getDisplayNearestPoint(p); } catch { return screen.getPrimaryDisplay(); } }
  bounds() {
    const a = (this.display || screen.getPrimaryDisplay()).workArea;
    const c = this.opts.corner;
    return { x: c.endsWith('r') ? a.x + a.width - W : a.x, y: c.startsWith('b') ? a.y + a.height - H : a.y, width: W, height: H };
  }
  place(force = false) {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.bounds(), cur = this.win.getBounds();
    if (force || b.x !== cur.x || b.y !== cur.y) this.win.setBounds(b);
  }
  /** The orb's centre in screen coordinates. */
  centre() {
    const b = this.win ? this.win.getBounds() : this.bounds();
    const c = this.opts.corner;
    return { x: c.endsWith('r') ? b.x + W - MARGIN - R : b.x + MARGIN + R, y: c.startsWith('b') ? b.y + H - MARGIN - R : b.y + MARGIN + R };
  }

  // ---- Visibility -----------------------------------------------------------------------------------------------
  /** From main.js: where the ARES window is, whether the brain can be seen, the power mode, a full-screen Space. */
  setContext(patch) { Object.assign(this.ctx, patch); this.update(); }
  get visible() {
    const o = this.opts;
    if (!this.win || !o.enabled) return false;
    const pm = this.ctx.power;
    if (pm === 'dormant' || pm === 'charging' || pm === 'spindown') return false; // offline: the ignition helper owns the desktop
    if (this.ctx.summoned && !this.portalOpen) return false;
    if (this.ctx.brain) return false;
    if (this.ctx.fullscreen && o.hideFullscreen) return false;
    return true;
  }
  update() {
    const v = this.visible;
    if (v !== this.on) {
      this.on = v;
      this.log('orb', v ? 'shown' : 'hidden');
      this.send({ type: 'show', on: v, corner: this.opts.corner });
      this.caretWatch(v);
      if (v) this.pushSounds();
      if (!v) this.pending = null;
    }
    this.send({ type: 'power', mode: this.ctx.power });
  }
  /** The ARES window moved (surface.js). The portal closes if she sank some other way (Esc, a click on another app). */
  surface(name) {
    const summoned = name === 'lifted' || name === 'window';
    if (this.portalOpen && !summoned) { this.portalOpen = false; this.send({ type: 'portal', open: false, sound: false }); this.refocus(); }
    this.setContext({ summoned });
  }

  // ---- The pointer: hit-testing, drag reach, which display ------------------------------------------------------
  tick() {
    if (!this.win) return;
    const near = this.check();
    this.timer = setTimeout(() => this.tick(), near ? 60 : 250);
  }
  check() {
    if (!this.win || this.win.isDestroyed()) return false;
    const p = screen.getCursorScreenPoint();
    // The orb follows the pointer between displays (after a moment there, so a pass across doesn't move it)
    const d = this.displayFor(p);
    if (d.id !== this.display?.id) {
      this.displayChangeAt ||= Date.now();
      if (Date.now() - this.displayChangeAt > 500 && !this.portalOpen && !this.ptt && !this.pending) { this.display = d; this.displayChangeAt = 0; this.place(true); }
    } else this.displayChangeAt = 0;
    const b = this.win.getBounds();
    const x = p.x - b.x, y = p.y - b.y;
    const c = this.centre();
    const dist = Math.hypot(p.x - c.x, p.y - c.y);
    const near = dist < NEAR;
    let over = this.on && (this.hits.all || this.hits.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
    if (this.on && this.drag.on) {
      const k = Math.max(0, Math.min(1, 1 - dist / DRAG_REACH));
      if (k !== this.dragNear) { this.dragNear = k; this.send({ type: 'drag', on: true, near: k }); }
      if (dist < DRAG_REACH) over = true;
    }
    if (over !== this.interactive) { this.interactive = over; this.win.setIgnoreMouseEvents(!over, { forward: true }); }
    return near || this.drag.on;
  }

  // ---- ares-theme orb-watch: drags in progress, the caret -------------------------------------------------------
  watch() {
    if (this.watcher || !fs.existsSync(this.helper)) return;
    const p = spawn(this.helper, ['orb-watch'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.watcher = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if ('trusted' in m && !m.trusted) this.log('orb watch: no Accessibility (caret fade off)');
        if ('drag' in m) {
          this.drag = { on: Boolean(m.drag), files: Boolean(m.files) };
          this.dragNear = -1;
          if (!m.drag) this.send({ type: 'drag', on: false });
          this.check();
        }
        if ('caret' in m) { this.caret = Array.isArray(m.caret) ? m.caret : null; this.caretCheck(); }
      }
    });
    p.on('exit', () => { if (this.watcher === p) { this.watcher = null; if (this.win) setTimeout(() => this.watch(), 5000); } });
    if (this.on) this.caretWatch(true);
  }
  caretWatch(on) { try { this.watcher?.stdin.write(on ? 'caret on\n' : 'caret off\n'); } catch {} if (!on && this.caretNear) { this.caretNear = false; this.send({ type: 'caret', near: false }); } }
  /** Never over a text cursor: within ~40 pt of the orb the orb fades to 15%. */
  caretCheck() {
    let near = false;
    if (this.caret && this.on) {
      const [cx, cy, cw, ch] = this.caret, o = this.centre();
      const dx = Math.max(cx - o.x, 0, o.x - (cx + cw)), dy = Math.max(cy - o.y, 0, o.y - (cy + ch));
      near = Math.hypot(dx, dy) - R < CARET_PT;
    }
    if (near !== this.caretNear) { this.caretNear = near; this.send({ type: 'caret', near }); }
  }

  // ---- Live feeds -------------------------------------------------------------------------------------------------
  /** The window's scene (her state, voice level, attention) and her captions (renderer/comms.js's word sync). */
  scene(msg) {
    if (msg.type === 'caption') { if (this.on) this.send({ type: 'caption', ...msg }); return; }
    if (msg.type === 'state') this.speaking = msg.state === 'speaking'; // (the orb's turn ends with reply-done → turnDone, not with her state)
    if (msg.type === 'level' && !this.on) return;
    if (['state', 'level', 'attention'].includes(msg.type)) this.send({ type: 'scene', msg: msg.type === 'level' ? { type: 'level', v: msg.v } : msg });
  }
  /** Something changed that the orb shows: jobs, calls, usage, mute. */
  refresh() {
    if (!this.win) return;
    const t0 = Date.now(); this.refreshes = (this.refreshes || 0) + 1;
    const jobs = this.deps.jobs?.list?.() || [];
    const approvals = jobs.filter((j) => j.status === 'approval');
    const failed = jobs.filter((j) => j.status === 'failed' && !j.seen);
    const waiting = this.claudeWaiting();
    const items = [
      ...approvals.map((j) => ({ kind: 'approval', id: j.id, title: j.title, detail: j.approval?.what || 'needs your OK' })),
      ...waiting.map((s) => ({ kind: 'claude', id: s.id, title: s.title, detail: s.detail })),
      ...failed.map((j) => ({ kind: 'failed', id: j.id, title: j.title, detail: j.error || 'failed' })),
    ];
    this.needs = { count: items.length, items };
    const running = jobs.filter((j) => j.status === 'running' || j.status === 'approval').sort((a, b) => (b.project ? 1 : 0) - (a.project ? 1 : 0) || (b.started || 0) - (a.started || 0));
    const main = running[0];
    const job = main ? { title: main.title, running: true, progress: main.progress?.total ? main.progress.done / main.progress.total : null } : null;
    const live = this.hooks.liveCall?.();
    const note = this.callNote && Date.now() - this.callNote.at < 90_000 ? this.callNote : null;
    const call = live ? { kind: 'live', name: live.name } : note ? { kind: note.kind, name: note.name } : null;
    const snap = this.deps.usage?.snapshot?.();
    const pct = Math.max(snap?.windows?.five_hour?.pct ?? 0, snap?.windows?.seven_day?.pct ?? 0);
    this.send({ type: 'signals', needs: { count: items.length }, job, call, usage: { pct }, muted: this.speechMuted });
    this.refreshMs = Math.max(this.refreshMs || 0, Date.now() - t0);
  }
  /** Claude Code sessions waiting on the user, from the hook store in memory and the live registry (both cheap; the transcript
   *  scan in sessions.list() took ~180 ms of the main process per call, which stuttered the wake). */
  claudeWaiting() {
    try {
      const s = this.deps.sessions; if (!s?.hooks) return [];
      if (!this.sessionsCache || Date.now() - this.sessionsCache.at > 15_000) {
        const live = s.live?.() || new Map();
        const meta = s.desktopMeta?.() || new Map();
        const list = [];
        for (const [id, h] of Object.entries(s.hooks)) {
          if (h.event !== 'Notification' || !/permission|elicitation|needs_input/.test(h.type || '') || Date.now() - h.at > 2 * 3600_000) continue;
          if (live.size && !live.has(id)) continue; // its process is gone: nothing is waiting any more
          const l = live.get(id);
          list.push({ id, title: meta.get(id)?.title || (l?.cwd ? path.basename(l.cwd) : 'Claude Code'), detail: /permission/.test(h.type) ? 'needs permission' : h.text || 'waiting for your answer' });
        }
        this.sessionsCache = { at: Date.now(), list };
      }
      return this.sessionsCache.list;
    } catch { return []; }
  }
  /** A job finished: a result card for the ones the orb started. */
  jobFinished(job) {
    const w = this.watched.get(job.id);
    this.refresh();
    if (!w) return;
    this.watched.delete(job.id);
    if (job.status === 'done') this.card({ kind: 'work', label: w.kind === 'summary' ? 'SUMMARY READY' : 'DONE', tag: 'WORK', title: job.title, detail: firstSentences(job.summary || ''), sound: 'chime', ttl: 14_000,
      actions: [{ label: 'Open ›', act: 'open' }] }, (a) => { if (a === 'open') this.hooks.openView(`job:${job.id}`); });
    else this.card({ kind: 'red', label: 'JOB FAILED', tag: 'WORK', title: job.title, detail: job.error || '', actions: [{ label: 'Review', act: 'open' }] }, (a) => { if (a === 'open') this.hooks.openView(`job:${job.id}`); });
  }
  /** An inbound call or a voicemail (read-only state from calls.js / voicemail.js): the green pulse and a card. */
  callEvent({ kind, name, line }) {
    this.callNote = { kind, name, at: Date.now() };
    this.refresh();
    if (!this.on) return;
    this.card({ kind: 'call', label: kind === 'voicemail' ? 'VOICEMAIL' : 'INCOMING CALL', tag: 'ARES LINE', title: name || 'Unknown caller', detail: firstSentences(line || '', 1), ttl: 20_000,
      actions: [{ label: 'Open ›', act: 'open' }] }, (a) => { if (a === 'open') this.hooks.openView('call'); });
  }
  /** Claude usage at 80% / 95%: one card per window. */
  usageWarn(w) {
    const id = `${w.window}@${w.resetsAt}@${w.pct >= 95 ? 95 : 80}`;
    this.refresh();
    if (this.usageWarned.has(id)) return;
    this.usageWarned.add(id);
    if (!this.on) return;
    this.card({ kind: 'needs', label: `CLAUDE ${w.pct}%`, tag: 'USAGE', title: `${w.pct}% of your ${w.label} limit used`, detail: w.resetsAt ? `Resets ${when(w.resetsAt)}` : '', ttl: 12_000 });
  }
  /** The listener (main.js): a push-to-talk capture ended without words, or was ignored. */
  listenerEvent(evt) {
    if (!this.ptt) return;
    if (evt.type === 'command') { this.ptt = 'thinking'; this.send({ type: 'ptt', phase: 'thinking' }); return; }
    if (evt.type === 'timeout' || evt.type === 'ignored') { this.ptt = null; this.send({ type: 'ptt', phase: null }); this.context = null; }
  }
  /** Is a turn the orb started still running (for "does the answer need the screen")? */
  get turnActive() { return this.ptt === 'thinking' || (this.ptt === 'listening' && Date.now() - this.pttAt < 60_000) || Boolean(this.askedAt && Date.now() - this.askedAt < 90_000); }
  turnDone() { this.askedAt = 0; if (this.ptt === 'thinking') { this.ptt = null; this.send({ type: 'ptt', phase: null }); } }
  /** A dropped file the next question is about (consumed once, within two minutes). */
  takeContext() {
    const c = this.context; this.context = null;
    if (!c || Date.now() - c.at > 120_000) return '';
    return `(ARES note: the user dropped ${c.files.length === 1 ? `the file ${tilde(c.files[0])}` : `these files: ${c.files.map(tilde).join(', ')}`} on your orb and is asking about ${c.files.length === 1 ? 'it' : 'them'}. Read ${c.files.length === 1 ? 'it' : 'them'} with read_file as needed; they're the subject of this question.)\n\n`;
  }
  get speechMuted() { return Date.now() < this.quietUntil; }
  async pushSounds() {
    const enabled = this.deps.power?.opts?.sounds !== false;
    const silent = this.speechMuted || Boolean(await this.hooks.silentNow?.().catch(() => false));
    this.send({ type: 'sounds', enabled, silent });
  }

  // ---- Cards --------------------------------------------------------------------------------------------------
  card(c, onAct = null) {
    const id = ++this.seq;
    const card = { id, ttl: 9000, ...c };
    this.cards.set(id, { card, act: onAct });
    for (const k of [...this.cards.keys()]) if (k < id - 6) this.cards.delete(k);
    this.send({ type: 'card', card });
    this.log('orb card', { label: card.label, title: card.title });
    return id;
  }

  // ---- The portal ---------------------------------------------------------------------------------------------
  async portal(open, why = 'orb') {
    if (open) {
      if (this.portalOpen) return;
      if (['dormant', 'charging', 'spindown'].includes(this.ctx.power)) return;
      this.portalOpen = true;
      this.prevFront = await this.frontApp();
      const c = this.centre();
      const wa = screen.getPrimaryDisplay().workArea; // (the ARES window lifts on the primary display)
      this.hooks.sendWindow('portal', { open: true, x: Math.max(0, Math.min(wa.width, c.x - wa.x)), y: Math.max(0, Math.min(wa.height, c.y - wa.y)) });
      this.send({ type: 'portal', open: true });
      this.hooks.summon();
      this.log('orb portal open', { why, from: this.prevFront });
      this.update();
    } else {
      if (!this.portalOpen) return;
      this.portalOpen = false;
      this.hooks.sendWindow('portal', { open: false });
      this.send({ type: 'portal', open: false });
      this.log('orb portal close', { why });
      setTimeout(() => { this.hooks.dismiss(); setTimeout(() => this.refocus(), 320); }, 560);
    }
  }
  frontApp() {
    return new Promise((resolve) => execFile(this.helper, ['front'], { timeout: 2000 }, (err, out) => { try { resolve(err ? '' : JSON.parse(out).front || ''); } catch { resolve(''); } }));
  }
  /** The app that was in front before the portal gets its focus back (cursor and selection are its own). */
  refocus() {
    const id = this.prevFront; this.prevFront = '';
    if (!id || (this.hooks.ownIds || []).includes(id)) return;
    execFile(this.helper, ['refocus', id], { timeout: 2000 }, () => {});
  }

  // ---- Push-to-talk -----------------------------------------------------------------------------------------------
  pttStart(ms = 30_000, hint = null) {
    const l = this.deps.listener;
    if (!l || ['dormant', 'charging', 'spindown'].includes(this.ctx.power)) return false;
    if (this.speaking) this.hooks.stopSpeaking();
    this.ptt = 'listening'; this.pttAt = Date.now();
    l.listen(ms, false); // not "trusted": Voice ID still applies (docs/orb-prompt.md §3)
    this.send({ type: 'ptt', phase: 'listening', hint });
    return true;
  }
  pttRelease() {
    if (this.ptt !== 'listening') return;
    this.deps.listener?.send('finish');
    this.ptt = 'thinking'; // (a capture without words comes back as a timeout and clears this)
    this.send({ type: 'ptt', phase: 'thinking' });
    setTimeout(() => { if (this.ptt === 'thinking' && Date.now() - this.pttAt > 55_000) this.turnDone(); }, 60_000);
  }

  // ---- What the page asks for ---------------------------------------------------------------------------------------
  async act(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'click': return this.click();
      case 'hold': return this.pttStart();
      case 'release': return this.pttRelease();
      case 'menu': return this.menuAct(m.act);
      case 'card': { const rec = this.cards.get(m.id); this.cards.delete(m.id); return rec?.act?.(m.act || 'open'); }
      case 'drop': return this.drop(m);
      case 'chip': return this.chip(m);
      case 'open': case 'closed': return; // the menu or chips (the page reports its hits anyway)
    }
  }
  click() {
    if (this.speaking) { this.hooks.stopSpeaking(); this.send({ type: 'flash', text: 'Stopped.' }); return; }
    if (this.portalOpen) return this.portal(false, 'click');
    if (this.needs?.count) return this.needsCard();
    if (this.callNote && Date.now() - this.callNote.at < 90_000) return this.callEvent(this.callNote);
    if (this.hooks.liveCall?.()) return this.card({ kind: 'call', label: 'ON A CALL', tag: 'ARES LINE', title: this.hooks.liveCall().name, actions: [{ label: 'Open ›', act: 'open' }] }, (a) => { if (a === 'open') this.hooks.openView('call'); });
    return this.portal(true, 'click');
  }
  /** Needs me: the first request, with APPROVE / REVIEW (approval through the existing jobs flow). */
  needsCard() {
    const it = this.needs.items[0];
    if (!it) return;
    if (it.kind === 'approval') {
      this.card({ kind: 'needs', label: 'NEEDS YOUR OK', tag: 'WORK', title: it.title, detail: it.detail, ttl: 25_000, actions: [{ label: 'Approve', act: 'approve' }, { label: 'Review', act: 'review' }] }, (a) => {
        if (a === 'approve') { this.deps.jobs.answer(it.id, true, 'approved from the orb'); this.card({ kind: 'work', label: 'APPROVED', tag: 'WORK', title: it.title, ttl: 4000 }); }
        else this.hooks.openView(`job:${it.id}`);
      });
    } else if (it.kind === 'claude') {
      this.card({ kind: 'needs', label: 'CLAUDE CODE', tag: 'WAITING', title: it.title, detail: it.detail, ttl: 20_000, actions: [{ label: 'Review', act: 'review' }] }, () => this.hooks.openView('work'));
    } else {
      this.card({ kind: 'red', label: 'JOB FAILED', tag: 'WORK', title: it.title, detail: it.detail, ttl: 20_000, actions: [{ label: 'Review', act: 'review' }] }, () => this.hooks.openView(`job:${it.id}`));
    }
  }
  menuAct(act) {
    switch (act) {
      case 'open': return this.portal(true, 'menu');
      case 'talk': return this.pttStart(8000, 'listening…') && this.send({ type: 'hint', text: 'listening…' });
      case 'standby': {
        const ok = this.deps.power?.standby(true, 'orb menu');
        return this.card(ok ? { kind: 'day', label: 'STANDING BY', tag: 'POWER', title: 'Ears muted, services held', detail: 'Click the orb, ⌥⇧Space or the menu to wake', ttl: 6000 }
          : { kind: 'red', label: 'STANDBY', tag: 'POWER', title: `Can't stand by while ${this.deps.power?.mode || 'busy'}`, ttl: 5000 });
      }
      case 'stopall': {
        const a = this.deps.autonomy; if (!a) return;
        const paused = a.stopAll('orb menu');
        return this.card({ kind: 'red', label: 'ALL WORK PAUSED', tag: 'AUTONOMY', title: paused.length ? `${paused.length} job${paused.length === 1 ? '' : 's'} paused` : 'Nothing was running', detail: paused.join(', ') || 'Goals and routines are on hold', ttl: 20_000, sound: 'attend',
          actions: [{ label: 'Resume', act: 'resume' }] }, (x) => { if (x === 'resume') { a.resumeAll(); this.card({ kind: 'work', label: 'RESUMED', tag: 'AUTONOMY', title: 'Everything carries on', ttl: 4000 }); } });
      }
      case 'work': return this.hooks.openView('work');
      case 'mute': {
        this.quietUntil = Date.now() + 3600_000;
        this.refresh(); this.pushSounds();
        return this.card({ kind: 'day', label: 'MUTED FOR 1 HOUR', tag: 'ARES', title: `No speech or sounds until ${when(this.quietUntil)}`, detail: 'Pushes still reach your phone', ttl: 7000, actions: [{ label: 'Unmute', act: 'unmute' }] },
          (x) => { if (x === 'unmute') { this.quietUntil = 0; this.refresh(); this.pushSounds(); this.card({ kind: 'day', label: 'UNMUTED', tag: 'ARES', title: 'Speaking again', ttl: 3000 }); } });
      }
      case 'screen': return this.ask("What's on my screen right now? Look at the window in front and tell me in two or three sentences.");
    }
  }
  /** A question for the brain through the window (its usual path: spoken answer, caption, COMMS). */
  ask(text) {
    this.askedAt = Date.now();
    this.hooks.ask(text);
    this.send({ type: 'ptt', phase: 'thinking' });
    this.ptt = 'thinking';
  }

  // ---- Drops ---------------------------------------------------------------------------------------------------
  drop(m) {
    if (!this.on) return;
    const id = ++this.seq;
    if (m.files?.length) {
      const files = [...new Set(m.files.map(String).filter((f) => path.isAbsolute(f)))].slice(0, 20);
      if (!files.length) return;
      const names = files.map((f) => path.basename(f));
      this.pending = { id, kind: 'files', files };
      this.log('orb drop', { files: names });
      this.send({ type: 'chips', id, hint: names.length === 1 ? names[0] : `${names.length} files`, items: [
        { label: 'SUMMARISE', act: 'summarise' }, { label: 'SEND TO PHONE', act: 'phone' }, { label: 'START PROJECT', act: 'project' }, { label: 'ASK ABOUT IT…', act: 'ask' }] });
    } else if (m.text) {
      const text = String(m.text).slice(0, 8000), url = String(m.url || '');
      this.pending = { id, kind: 'text', text, url };
      this.log('orb drop', { text: text.length, url: Boolean(url) });
      this.send({ type: 'chips', id, hint: url ? new URL(url).hostname : `${text.split(/\s+/).length} words`, items: [
        { label: 'EXPLAIN', act: 'explain' }, { label: 'SAVE TO MEMORY', act: 'memory' }, { label: 'ADD TO TASKS', act: 'tasks' }, { label: 'SEND TO PHONE', act: 'phone' }] });
    }
  }
  ctxFor() { return { source: 'orb', verified: true, turn: 0, confirm: (what) => ({ allow: true, said: `clicked (${what})` }) }; } // a click on the orb is the owner's own hand
  async chip(m) {
    const p = this.pending;
    if (!p || p.id !== m.id) return;
    this.pending = null;
    if (p.kind === 'text') return this.textAct(m.act, p);
    // Files stay inside control.js's folder rules: blocked never, outside only after a yes
    const control = this.deps.control;
    const classes = p.files.map((f) => ({ f, c: control ? control.classify(f) : 'inside' }));
    const blocked = classes.filter((x) => x.c === 'blocked');
    if (blocked.length) return this.card({ kind: 'red', label: "CAN'T TAKE THAT", tag: 'FILES', title: blocked.map((x) => path.basename(x.f)).join(', '), detail: 'Keys, Library and my own files stay off limits', ttl: 8000 });
    const outside = classes.filter((x) => x.c === 'outside');
    if (outside.length && !m.allowed) {
      return this.card({ kind: 'needs', label: 'OUTSIDE MY FOLDERS', tag: 'FILES', title: outside.map((x) => path.basename(x.f)).join(', '), detail: `${tilde(path.dirname(outside[0].f))} isn't one of the folders I may use. Just this once?`, ttl: 25_000,
        actions: [{ label: 'Allow once', act: 'allow' }, { label: 'Cancel', act: 'cancel' }] }, (a) => { if (a === 'allow') { this.pending = p; this.chip({ ...m, allowed: true }); } });
    }
    if (outside.length) control?.audit?.record({ what: `orb: allowed once outside the folders: ${outside.map((x) => tilde(x.f)).join(', ')}`, tier: 3, kind: 'files', source: 'orb', approval: 'clicked Allow once on the orb' });
    return this.fileAct(m.act, p);
  }
  async fileAct(act, p) {
    const { files } = p;
    const stem = files.length === 1 ? path.basename(files[0]).replace(/\.[^.]+$/, '') : `${files.length} files`;
    const control = this.deps.control;
    switch (act) {
      case 'summarise': {
        const jobs = this.deps.jobs;
        const job = jobs.start({ title: `Summary: ${stem}`.slice(0, 80), task: SUMMARISE, size: 'medium', source: 'orb', inputs: files });
        this.watched.set(job.id, { kind: 'summary' });
        control?.audit?.record({ what: `orb: summarise ${files.map(tilde).join(', ')}`, tier: 1, kind: 'files', source: 'orb' });
        return this.card({ kind: 'work', label: 'ON IT', tag: 'WORK', title: job.title, detail: 'The summary comes back here and in COMMS', ttl: 5000 });
      }
      case 'phone': {
        if (!control) return;
        const sent = [];
        for (const f of files) {
          const r = control.classify(f) === 'inside'
            ? await control.handle('phone/send', { kind: 'file', path: f }, this.ctxFor()).catch((err) => ({ message: err.message, failed: true }))
            : await control.pushFile(f, { title: 'From your Mac' }).then((x) => ({ message: x.sent ? 'sent' : "The phone app isn't set up for notifications yet.", failed: !x.sent }), (err) => ({ message: err.message, failed: true }));
          if (!r.failed && !/isn't set up|isn't reachable/.test(r.message || '')) sent.push(path.basename(f)); else return this.card({ kind: 'red', label: 'NOT SENT', tag: 'PHONE', title: path.basename(f), detail: firstSentences(r.message || '', 1), ttl: 9000 });
        }
        return this.card({ kind: 'day', label: 'SENT TO PHONE', tag: 'PHONE', title: sent.join(', '), detail: 'It arrives as a notification with Open', ttl: 6000, sound: 'chime' });
      }
      case 'project':
        this.ask(`I dropped ${files.length === 1 ? `the file ${tilde(files[0])}` : `these files: ${files.map(tilde).join(', ')}`} on your orb and want to start a project from ${files.length === 1 ? 'it' : 'them'}. Read ${files.length === 1 ? 'it' : 'them'} first, then propose a brief (title, goal, constraints, definition of done), read it back to me and wait for my yes before start_project.`);
        return this.portal(true, 'project'); // the brief needs the screen
      case 'ask':
        this.context = { files, at: Date.now() };
        return this.pttStart(12_000, `ask about ${files.length === 1 ? path.basename(files[0]) : 'them'}… I'm listening`);
    }
  }
  async textAct(act, p) {
    const { text, url } = p;
    switch (act) {
      case 'explain': return this.ask(url ? `Explain this page to me in a few sentences: ${url}` : `Explain this to me in a few sentences:\n\n${text}`);
      case 'memory': {
        const fact = (url && url === text ? `Link the user saved: ${url}` : text).slice(0, 400);
        this.deps.memory?.add(fact);
        return this.card({ kind: 'day', label: 'REMEMBERED', tag: 'MEMORY', title: fact, ttl: 6000, sound: 'chime' });
      }
      case 'tasks': {
        const t = this.deps.tasks;
        if (!t?.add) return this.card({ kind: 'red', label: 'TASKS', tag: 'ARES', title: 'Tasks aren\'t set up yet', ttl: 6000 });
        try { await t.add({ title: text.split('\n')[0].slice(0, 140), notes: url && url !== text ? url : undefined }); return this.card({ kind: 'day', label: 'ADDED TO TASKS', tag: 'TASKS', title: text.split('\n')[0].slice(0, 140), ttl: 6000, sound: 'chime' }); }
        catch (err) { return this.card({ kind: 'red', label: 'NOT ADDED', tag: 'TASKS', title: firstSentences(err.message, 1), ttl: 8000 }); }
      }
      case 'phone': {
        const control = this.deps.control; if (!control) return;
        const r = await control.handle('phone/send', url ? { kind: 'link', url, text: url === text ? '' : text.slice(0, 1500) } : { kind: 'text', text }, this.ctxFor()).catch((err) => ({ message: err.message, failed: true }));
        const ok = !r.failed && /^Sent/.test(r.message || '');
        return this.card({ kind: ok ? 'day' : 'red', label: ok ? 'SENT TO PHONE' : 'NOT SENT', tag: 'PHONE', title: url ? new URL(url).hostname : text.slice(0, 80), detail: ok ? '' : firstSentences(r.message || '', 1), ttl: 6000, sound: ok ? 'chime' : undefined });
      }
    }
  }

  /** Development only: drive the orb from the harness (ARES_USER_DATA set). */
  test(what, arg = {}) {
    switch (what) {
      case 'state': return { on: this.on, visible: this.visible, ctx: this.ctx, portal: this.portalOpen, ptt: this.ptt, needs: this.needs, muted: this.speechMuted, interactive: this.interactive, bounds: this.win?.getBounds(), centre: this.centre(), drag: this.drag, caretNear: this.caretNear, hits: this.hits, media: this.win?.getMediaSourceId?.(), refreshes: this.refreshes || 0, refreshMsMax: this.refreshMs || 0 };
      case 'act': return this.act(arg);
      case 'card': return this.card(arg);
      case 'call': return this.callEvent(arg);
      case 'usage': return this.usageWarn(arg);
      case 'drag': this.drag = { on: Boolean(arg.on), files: true }; this.dragNear = -1; if (!arg.on) this.send({ type: 'drag', on: false }); return this.check();
      case 'caret': this.caret = arg.rect || null; this.caretCheck(); return this.caretNear;
      case 'context': this.setContext(arg); return this.visible;
      case 'portal': return this.portal(Boolean(arg.open), 'test');
      case 'reload': this.ready = false; this.win?.webContents.reload(); return true;
      case 'metrics': { // CPU of the orb's renderer vs the rest (Electron's own metrics, since the last call)
        const pid = this.win?.webContents.getOSProcessId();
        return require('electron').app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10, orb: m.pid === pid }));
      }
      case 'refresh': this.refresh(); return this.needs;
    }
  }
}

module.exports = { Orb, HOLD_MS };
