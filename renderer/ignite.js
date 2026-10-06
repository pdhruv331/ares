// Ignition, standby and power down (docs/ignition-prompt.md): the visuals shared by the ARES window (renderer/scene.js), the
// lock-screen still (renderer/wallpaper.js) and the native ignition helper's page (native/ignition.html, "ARES Ignition.app").
// Pure canvas on top of renderer/reactor.js: nothing here knows about Electron, the socket or the DOM beyond the ghost log.
//
//   Ignite.titleBlock(ctx, {...})   "ARES · OFFLINE" / "ARES · STANDBY": the middle dot exactly on the reactor's centre line,
//                                   thin fading rules with end caps, the subtitle or the standby status line
//   Ignite.layout(cx, cy, r, S)     where everything sits for a reactor at (cx, cy, r): the title's y, the cleared band
//                                   for each kind, the power notch (centred between the first ring and the title dot)
//   Ignite.drawNotch(ctx, ...)      the ⏻ socket (standby only): hover glow, the hold ring filling around it
//   new Ignite.Controller(engine)   the state machine: offline (the cold still) → charging (real progress) → wake →
//                                   online; online ⇄ standby; spindown → offline. update(dt) sets the engine's cold /
//                                   hue / pace / coils / hum each frame; drawUnder / drawOver paint the extras (streaks,
//                                   the charge ring and %, the bloom, the title, the notch). sheet() says how the dot
//                                   matrix should look (hue, options) so each page's Backdrop can follow.
//   Ignite.ghost(container)         the ghost log (bottom-left): ≤ 3 faint monospace lines, the current step pulsing
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./reactor.js'));
  else root.Ignite = factory(root.Reactor);
})(typeof self !== 'undefined' ? self : this, function (Reactor) {
  const { COLORS, rgba, mix, glow, TAU, RAD, clamp } = Reactor;
  const GOLD = COLORS.gold, BLUE = COLORS.blue, CYAN = COLORS.cyan, WHITE = COLORS.white, AMBER = COLORS.amber, GREEN = COLORS.green;
  const FONT = '"SF Mono", ui-monospace, Menlo, monospace';
  const ease = { out: (k) => 1 - Math.pow(1 - k, 3), in: (k) => k * k * k, inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2) };
  const TIMING = {
    titleFade: 0.5, chargeIn: 0.4, breath: 0.35, wake: 1.4, handover: 0.6,
    standbyIn: 1.6, standbyOut: 0.9, spindown: 3.8, holdWake: 0.7, holdStandby: 1.2, holdPower: 1.5,
  };

  // ---- Layout ------------------------------------------------------------------------------------------------------------
  // S scales every size with the display's backing scale when drawing in device pixels (the still); 1 in CSS pixels.
  function layout(cx, cy, r, S = 1) {
    const titleY = cy + r * 1.5;                 // under the reactor, inside the 1.62 ring, above where the lock screen puts its field
    const firstRing = cy + r * 1.14;             // the bottom of the first schematic ring outside the reactor
    const notch = { x: cx, y: (firstRing + titleY) / 2, r: 8 * S }; // equal distance to the ring and to the title's dot
    const bandW = 320 * S;
    return {
      titleY, notch,
      band: { offline: { x: cx - bandW / 2, y: titleY - 13 * S, w: bandW, h: 48 * S }, standby: { x: cx - bandW / 2, y: titleY - 13 * S, w: bandW, h: 72 * S } },
      pct: { x: cx, y: cy + r * 1.22 },          // the charge % while charging (the title is gone by then)
      ring: r * 1.06,                            // the charge ring, just outside the tick ring
    };
  }

  // ---- Text ---------------------------------------------------------------------------------------------------------------
  /**
   * The title block. kind 'offline' | 'standby' | 'awake'. The middle "·" sits on x = cx. `alpha` fades the whole block.
   * standby: `status` = { listening: false, link: true, jobs: n }; awake: `line` = the wake line (typed by the caller).
   */
  function titleBlock(ctx, { cx, y, S = 1, hue = GOLD, alpha = 1, kind = 'offline', status = null, line = '', glowK = 1 }) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textBaseline = 'middle';
    const title = kind === 'offline' ? 'OFFLINE' : kind === 'standby' ? 'STANDBY' : 'AWAKE';
    ctx.font = `${Math.round(12 * S)}px ${FONT}`;
    ctx.letterSpacing = `${Math.round(5 * S)}px`;
    ctx.textAlign = 'left';
    const left = 'ARES ', dot = '·', right = ` ${title}`;
    const wL = ctx.measureText(left).width, wD = ctx.measureText(dot).width, wR = ctx.measureText(right).width;
    const sp = 5 * S; // the trailing letter-spacing measureText counts
    const x0 = cx - wL - (wD - sp) / 2; // the dot's visible centre on cx
    ctx.fillStyle = rgba(mix(hue, WHITE, 0.25), 0.88);
    ctx.shadowColor = rgba(hue, 0.55 * glowK); ctx.shadowBlur = 10 * S;
    ctx.fillText(left + dot + right, x0, y);
    ctx.shadowBlur = 0;
    const xl = x0 - 6 * S, xr = x0 + wL + wD + wR - sp + 6 * S;
    // Thin rules either side, fading out, with tiny end caps
    for (const dir of [-1, 1]) {
      const from = dir < 0 ? xl : xr, to = from + dir * 78 * S;
      const grad = ctx.createLinearGradient(from, 0, to, 0);
      grad.addColorStop(0, rgba(hue, 0.5)); grad.addColorStop(1, rgba(hue, 0.05));
      ctx.strokeStyle = grad; ctx.lineWidth = Math.max(1, S);
      ctx.beginPath(); ctx.moveTo(from + dir * 12 * S, y); ctx.lineTo(to, y); ctx.stroke();
      ctx.fillStyle = rgba(hue, 0.35);
      ctx.beginPath(); ctx.arc(to, y, 1.2 * S, 0, TAU); ctx.fill();
    }
    ctx.textAlign = 'center';
    if (kind === 'offline') {
      ctx.fillStyle = rgba(hue, 0.42);
      ctx.font = `${Math.round(9 * S)}px ${FONT}`; ctx.letterSpacing = `${Math.round(3 * S)}px`;
      ctx.fillText('REACTOR COLD / SYSTEMS DOWN', cx + 1.5 * S, y + 22 * S);
    } else if (kind === 'standby') {
      // a short thin divider, a clear gap, then the status line with the green "link alive" dot
      ctx.strokeStyle = rgba(hue, 0.35); ctx.lineWidth = Math.max(1, S);
      ctx.beginPath(); ctx.moveTo(cx - 22 * S, y + 16 * S); ctx.lineTo(cx + 22 * S, y + 16 * S); ctx.stroke();
      const st = status || {};
      const parts = [st.listening ? 'LISTENING ON' : 'LISTENING OFF', st.link ? 'PHONE LINK ACTIVE' : 'PHONE LINK OFF', `${st.jobs || 0} JOB${st.jobs === 1 ? '' : 'S'} RUNNING`];
      ctx.font = `${Math.round(9 * S)}px ${FONT}`; ctx.letterSpacing = `${Math.round(3 * S)}px`;
      const text = parts.join('  /  ');
      const w = ctx.measureText(text).width - 3 * S;
      ctx.fillStyle = rgba(hue, 0.5);
      ctx.fillText(text, cx + 1.5 * S + 5 * S, y + 40 * S);
      const dx = cx - w / 2 - 4 * S;
      ctx.fillStyle = rgba(st.link ? GREEN : COLORS.grey, 0.95);
      ctx.shadowColor = rgba(st.link ? GREEN : COLORS.grey, 0.8); ctx.shadowBlur = 6 * S;
      ctx.beginPath(); ctx.arc(dx, y + 40 * S, 2 * S, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
    } else if (line) {
      ctx.fillStyle = rgba(mix(hue, WHITE, 0.4), 0.8);
      ctx.font = `${Math.round(10.5 * S)}px ${FONT}`; ctx.letterSpacing = `${Math.round(1 * S)}px`;
      const lines = String(line).split('\n').slice(0, 2);
      lines.forEach((l, i) => ctx.fillText(l, cx, y + (24 + i * 16) * S));
    }
    ctx.restore();
  }

  /** The power notch: a small ⏻ socket. hover 0..1 warms it amber with "HOLD TO POWER DOWN" beside it; hold 0..1 fills a ring. */
  function drawNotch(ctx, notch, { hue = BLUE, hover = 0, hold = 0, alpha = 1, S = 1 }) {
    if (alpha <= 0.01) return;
    const { x, y, r } = notch;
    const col = mix(hue, AMBER, clamp(hover + hold, 0, 1));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    // the port's rim
    ctx.strokeStyle = rgba(col, 0.35 + hover * 0.3); ctx.lineWidth = Math.max(1, S);
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    glow(ctx, col, x, y, r * 2.2, (0.12 + hover * 0.35 + hold * 0.3) * alpha);
    // ⏻: an arc open at the top and a bar
    ctx.strokeStyle = rgba(mix(col, WHITE, 0.3 + hover * 0.3), 0.8 + hover * 0.2); ctx.lineWidth = Math.max(1.2, 1.4 * S);
    ctx.beginPath(); ctx.arc(x, y + 0.5 * S, r * 0.52, -TAU / 4 + 0.65, -TAU / 4 - 0.65 + TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - r * 0.6); ctx.lineTo(x, y - r * 0.02); ctx.stroke();
    if (hold > 0) { // the hold ring filling clockwise from the top
      ctx.strokeStyle = rgba(AMBER, 0.9); ctx.lineWidth = Math.max(1.5, 1.8 * S);
      ctx.beginPath(); ctx.arc(x, y, r + 4 * S, -TAU / 4, -TAU / 4 + TAU * clamp(hold, 0, 1)); ctx.stroke();
    }
    ctx.restore();
  }

  /** The hold hint under the core ("HOLD TO WAKE" / "HOLD FOR STANDBY") or beside the notch ("HOLD TO POWER DOWN"). */
  function hint(ctx, text, x, y, { hue = CYAN, alpha = 1, S = 1, align = 'center' } = {}) {
    if (alpha <= 0.01 || !text) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${Math.round(8.5 * S)}px ${FONT}`; ctx.letterSpacing = `${Math.round(3 * S)}px`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(mix(hue, WHITE, 0.2), 0.85);
    ctx.shadowColor = rgba(hue, 0.6); ctx.shadowBlur = 8 * S;
    ctx.fillText(text, x + (align === 'center' ? 1.5 * S : 0), y);
    ctx.restore();
  }

  // ---- The controller -------------------------------------------------------------------------------------------------------
  class Controller {
    /**
     * @param {Reactor.Engine} engine  the page's reactor engine (its cold / forceHue / pace / coilsLit / hum / scanOn are driven here)
     * @param {object} o  { replica: true } = this page follows another's state (the wallpaper backdrop, the helper): no hold input
     */
    constructor(engine, o = {}) {
      this.engine = engine;
      this.mode = 'online';      // offline | charging | breath | wake | online | tostandby | standby | fromstandby | spindown
      this.t = 0;                // seconds in this mode
      this.charge = 0;           // real progress 0..1 (the steps), eased toward by `shown`
      this.shown = 0;
      this.steps = [];           // [{ name, status: 'start'|'ok'|'fail', detail }]
      this.failed = false;
      this.streaks = [];
      this.spawn = 0;
      this.hover = 0;            // the core's hover warmth (0..1)
      this.hold = null;          // { kind: 'wake'|'standby'|'power', k: 0..1 }
      this.notchHover = 0;
      this.title = 1;            // the title block's alpha
      this.wakeLine = '';
      this.lineShown = 0;        // typed characters of the wake line
      this.status = { listening: false, link: false, jobs: 0 }; // standby's status line
      this.bloom = 0; this.shock = 0; this.open = 0; // wake effects
      this.replica = Boolean(o.replica);
      this.S = o.S || 1;
      this.events = [];          // 'wake' | 'offline' | 'standby' | 'online' | 'commit:<hold>' — the page drains these
      this.rnd = (() => { let s = 11; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; })();
      this.from = null;          // levels at the start of a transition { cold, hue }
      this.flickered = false;
      this.hueDrain = null;
      this.hintText = '';
      this.clipR = 0;            // > 0: this page paints only a disc of clipR·r around the reactor (the helper): effects stay inside it
      this.calloutK = 0;         // the callouts drawing themselves in after a wake (0..1 over ~1.8 s; scene.js reads it)
      this.fromStandby = false;  // a spin-down that began in standby flares first (there's little left to wind down otherwise)
      this.hoverAngle = 0;       // where the pointer is, from the centre
      this.embers = [];          // drifting up out of a hovered core: { x, y, vx, vy, life, s } in units of r
      this.GLOW = 0.8;           // the hover glow's strength (the user's 80)
    }
    get S_() { return this.S; }

    /** Enter a mode (the pages call these from the socket / IPC messages). */
    set(mode, extra = {}) {
      if (mode === this.mode && !extra.force) return;
      const e = this.engine;
      this.from = { cold: e.cold, hue: [...e.hue], pace: e.pace };
      this.mode = mode; this.t = 0;
      if (mode === 'offline') { e.cold = 1; e.forceHue = GOLD; e.hue = [...GOLD]; e.pace = 0; e.scanOn = 0; e.coilsLit = -1; e.hum = 0; e.sparks.length = 0; this.title = extra.fadeTitle ? 0 : 1; this.charge = 0; this.shown = 0; this.steps = []; this.failed = false; this.streaks.length = 0; }
      if (mode === 'charging') { e.forceHue = GOLD; e.coilsLit = 0; e.scanOn = 0; this.charge = extra.charge || 0; }
      if (mode === 'standby') { e.forceHue = BLUE; e.scanOn = 0; e.coilsLit = -1; e.hum = 0; }
      if (mode === 'online') { e.forceHue = null; e.cold = 0; e.pace = 1; e.scanOn = 1; e.coilsLit = -1; e.hum = 0; e.rate = 1; e.amberSweep = 0; this.title = 0; this.streaks.length = 0; this.calloutK = 0; }
      if (mode === 'wake') { e.burst(40, 2.2); this.bloom = 1; this.shock = 0; this.open = 1; e.scanOn = 0; e.coilsLit = -1; e.hum = 0; }
      if (mode === 'spindown') { e.rate = 1; this.flickered = false; e.coilsLit = -1; this.fromStandby = this.from.cold > 0.4; }
      if (extra.status) this.status = extra.status;
      if (extra.line != null) { this.wakeLine = extra.line; this.lineShown = 0; }
    }
    /** A start-up step reported by ARES: { name, status, detail }. The charge is the share of steps finished. */
    step(s) {
      const i = this.steps.findIndex((x) => x.name === s.name);
      if (i >= 0) this.steps[i] = { ...this.steps[i], ...s }; else this.steps.push({ ...s });
      if (s.status === 'fail') this.failed = true;
      const total = Math.max(this.steps.length, s.total || 6);
      const done = this.steps.filter((x) => x.status === 'ok' || x.status === 'fail').length;
      this.charge = clamp(done / total, 0, 1);
      if (this.mode === 'offline') this.set('charging');
    }
    /** The sequence is complete: a held breath, then the wake. */
    ready() { this.charge = 1; this.readyAt = true; if (this.mode === 'offline') this.set('charging'); }

    /** Pointer input (the window and the helper; replicas ignore it). x, y in the reactor's canvas px, g = { cx, cy, r }. */
    pointer(kind, x, y, g) {
      if (this.replica) return null;
      const d = Math.hypot(x - g.cx, y - g.cy);
      const lay = layout(g.cx, g.cy, g.r, 1);
      const overCore = d < g.r * 0.35;
      const overNotch = this.mode === 'standby' && Math.hypot(x - lay.notch.x, y - lay.notch.y) < lay.notch.r + 6;
      if (kind === 'move') {
        this.wantHover = overCore ? 1 : 0;
        this.hoverAngle = Math.atan2(y - g.cy, x - g.cx);
        this.wantNotchHover = overNotch ? 1 : 0;
        if (this.hold && !(this.hold.kind === 'power' ? overNotch : overCore)) this.cancelHold();
        return overCore ? 'core' : overNotch ? 'notch' : null;
      }
      if (kind === 'down') {
        if (overNotch) { this.hold = { kind: 'power', k: 0, dur: TIMING.holdPower }; return 'notch'; }
        if (!overCore) return null;
        if (this.mode === 'offline') { this.hold = { kind: 'wake', k: 0, dur: TIMING.holdWake }; return 'core'; }
        if (this.mode === 'online') { this.hold = { kind: 'standby', k: 0, dur: TIMING.holdStandby }; return 'core'; }
        if (this.mode === 'standby') { this.hold = { kind: 'wakeup', k: 0, dur: TIMING.holdWake }; return 'core'; }
        return null;
      }
      if (kind === 'up' || kind === 'cancel') { if (this.hold) this.cancelHold(); this.wantHover = 0; this.wantNotchHover = 0; }
      return null;
    }
    cancelHold() { if (this.hold && this.hold.k < 1) this.events.push('cancel:' + this.hold.kind); this.hold = null; }
    /** The hint to show (text) for the pointer's position, or ''. */
    get hintFor() {
      if (this.hold?.kind === 'power' || this.notchHover > 0.3) return 'HOLD TO POWER DOWN';
      if (this.hover < 0.3) return '';
      return this.mode === 'offline' ? 'HOLD TO WAKE' : this.mode === 'online' ? 'HOLD FOR STANDBY' : this.mode === 'standby' ? 'HOLD TO WAKE' : '';
    }

    update(dt) {
      dt = clamp(dt, 0, 0.1);
      const e = this.engine, m = this.mode;
      this.t += dt;
      this.hover += ((this.wantHover || 0) - this.hover) * Math.min(1, dt * ((this.wantHover || 0) ? 5 : 2.5));
      this.notchHover += ((this.wantNotchHover || 0) - this.notchHover) * Math.min(1, dt * 6);
      // The hover glow (every resting state: the cold reactor, standby, online): the engine swells the core and warms the near ticks;
      // embers drift up out of the core while the pointer stays
      const resting = m === 'offline' || m === 'standby' || m === 'online';
      e.hover = resting ? this.hover : 0; e.hoverAngle = this.hoverAngle; e.glowK = this.GLOW;
      if (resting && this.hover > 0.3) { this.spawn2 = (this.spawn2 || 0) + dt * this.hover * this.GLOW * 11; while (this.spawn2 >= 1) { this.spawn2 -= 1; const a = this.rnd() * TAU; this.embers.push({ x: Math.cos(a) * 0.2, y: Math.sin(a) * 0.2, vx: (this.rnd() - 0.5) * 0.25, vy: -(0.15 + this.rnd() * 0.35), life: 1, s: 0.004 + this.rnd() * 0.006 }); } }
      for (let i = this.embers.length - 1; i >= 0; i--) { const em = this.embers[i]; em.life -= dt * 0.8; if (em.life <= 0) { this.embers.splice(i, 1); continue; } em.x += em.vx * dt; em.y += em.vy * dt; em.vy -= 0.1 * dt; }
      if (this.hold) {
        this.hold.k = Math.min(1, this.hold.k + dt / this.hold.dur);
        if (this.hold.k >= 1 && !this.hold.fired) { this.hold.fired = true; this.events.push('commit:' + this.hold.kind); }
      }
      if (m === 'offline') {
        e.cold = 1; e.pace = 0; e.forceHue = GOLD; e.hue = mix(e.hue, GOLD, Math.min(1, dt * 3));
        this.title = Math.min(1, this.title + dt / TIMING.titleFade);
        // hover: the core warms and the rings stir; holding: the core brightens with the hold
        const k = this.hover * 0.12 + (this.hold?.kind === 'wake' ? this.hold.k * 0.25 : 0);
        e.cold = 1 - k;
        e.pace = this.hover * 0.6 * this.GLOW;
        return;
      }
      if (m === 'charging') {
        // the shown charge eases toward the real one and never passes it; it holds at the current step if one is slow
        const target = this.readyAt ? 1 : Math.min(this.charge, 0.97);
        this.shown = Math.min(target, this.shown + dt * 0.22 + (target - this.shown) * Math.min(1, dt * 0.45)); // ~2.8 s for a charge that's already complete
        if (target - this.shown < 0.004) this.shown = target;
        const c = this.shown;
        this.title = Math.max(0, this.title - dt / TIMING.titleFade);
        e.forceHue = mix(GOLD, WHITE, ease.in(c) * 0.85);
        e.cold = 1 - ease.out(c) * 0.75;        // only brightens from the floor
        e.pace = 0.15 + c * c * 1.6;            // rings spin up
        e.coilsLit = Math.floor(c * 10 + 1e-6);
        e.amberSweep = c; // the ticks light amber from the bottom, both ways up, with the charge: they meet at the top at 100%
        e.hum = c * 0.9;
        e.flash = Math.max(e.flash, c * 0.4 * (0.5 + 0.5 * Math.sin(this.t * (6 + c * 18)))); // flickers faster
        // streaks pulled out of the dot matrix, spiralling into the core
        this.spawn += dt * (6 + c * 42);
        while (this.spawn >= 1) { this.spawn -= 1; const a = this.rnd() * TAU; this.streaks.push({ a, d: 1.7 + this.rnd() * 1.5, sp: 0.9 + this.rnd() * 0.8, w: 0.3 + this.rnd() * 0.7, life: 1 }); }
        for (let i = this.streaks.length - 1; i >= 0; i--) {
          const s = this.streaks[i];
          s.d -= dt * s.sp * (0.8 + c); s.a += dt * (1.6 + c * 2) / Math.max(0.3, s.d);
          if (s.d < 0.28) this.streaks.splice(i, 1);
        }
        if (this.readyAt && this.shown >= 0.995) { this.set('breath'); }
        return;
      }
      if (m === 'breath') { // the core pulls in
        const k = this.t / TIMING.breath;
        e.flash = -1.6 * Math.sin(Math.min(1, k) * Math.PI); e.hum = 0; e.pace = 0.4; e.coilsLit = 10; e.amberSweep = 1;
        this.streaks.length = 0;
        if (k >= 1) { this.set('wake'); this.events.push('wake'); }
        return;
      }
      if (m === 'wake') {
        const k = this.t / TIMING.wake;
        e.forceHue = mix(WHITE, CYAN, ease.out(clamp(k * 1.4, 0, 1)));
        e.cold = Math.max(0, 0.25 * (1 - ease.out(clamp(k * 2, 0, 1))));
        e.pace = 1 + 1.5 * (1 - k);
        e.scanOn = clamp(k * 2 - 0.5, 0, 1);
        e.amberSweep = Math.max(0, 1 - k * 2.5); // the amber lets go as the rings turn cyan
        this.bloom = Math.max(0, 1 - k * 1.6);
        this.shock = ease.out(clamp(k, 0, 1));
        this.open = Math.exp(-k * 4) * Math.sin(k * 11); // the rings spring open with a slight overshoot
        if (k >= 1) { this.set('online'); this.events.push('online'); }
        return;
      }
      if (m === 'online') {
        e.cold = 0; e.pace = 1; e.forceHue = null; e.hum = 0;
        this.calloutK = Math.min(1, this.calloutK + dt / 1.8);
        if (this.hold?.kind === 'standby') { e.cold = this.hold.k * 0.35; e.pace = 1 - this.hold.k * 0.6; } // dims a little as the ring drains
        if (this.wakeLine && this.lineShown < this.wakeLine.length) this.lineShown = Math.min(this.wakeLine.length, this.lineShown + dt * 38);
        this.title = Math.max(0, this.title - dt * 2);
        return;
      }
      if (m === 'tostandby') { // the spin-down's shape, stopping at standby's levels
        const k = clamp(this.t / TIMING.standbyIn, 0, 1);
        e.forceHue = mix(this.from.hue, BLUE, ease.inOut(k));
        e.cold = this.from.cold + (0.6 - this.from.cold) * ease.out(k);
        e.pace = this.from.pace + (0.15 - this.from.pace) * ease.out(k);
        e.scanOn = 1 - k; e.coilsLit = -1;
        if (k >= 1) { this.set('standby'); this.events.push('standby'); }
        return;
      }
      if (m === 'standby') {
        e.forceHue = BLUE; e.cold = 0.6 - this.hover * 0.1; e.pace = 0.15 + this.hover * 0.5 * this.GLOW; e.scanOn = 0;
        this.title = Math.min(1, this.title + dt / TIMING.titleFade);
        if (this.hold?.kind === 'wakeup') { e.cold = 0.6 - this.hold.k * 0.4; e.pace = 0.15 + this.hold.k; }
        if (this.hold?.kind === 'power') { // the ticks light amber outward from the bottom until they meet at the top
          e.amberSweep = this.hold.k; e.forceHue = mix(BLUE, AMBER, this.hold.k * 0.25); e.hum = this.hold.k * 0.4;
        } else { e.hum = 0; e.amberSweep = Math.max(0, e.amberSweep - dt * 3); }
        return;
      }
      if (m === 'fromstandby') {
        const k = clamp(this.t / TIMING.standbyOut, 0, 1);
        e.forceHue = mix(BLUE, CYAN, ease.out(k)); e.cold = 0.6 * (1 - ease.out(k)); e.pace = 0.15 + 1.6 * Math.sin(k * Math.PI) + k * 0.85; e.scanOn = k;
        this.title = Math.max(0, this.title - dt / 0.3);
        if (k >= 1) { this.set('online'); this.events.push('online'); }
        return;
      }
      if (m === 'spindown') { // everything winds down like a turbine, on its own curves
        // From standby there is little to wind down: a 0.55 s FLARE first (the amber ticks complete, the rings spin up and brighten
        // amber-white, the coils all light), then the same turbine wind-down from those levels
        const FLARE = 0.55;
        if (this.fromStandby && this.t < FLARE) {
          const f = ease.out(clamp(this.t / FLARE, 0, 1));
          e.amberSweep = 1; e.pace = 0.15 + 1.5 * f; e.cold = 0.6 - 0.45 * f; e.coilsLit = Math.round(10 * f);
          e.forceHue = mix(BLUE, mix(AMBER, WHITE, 0.35), f); e.hum = 0.5 * f;
          this.from = { cold: e.cold, hue: [...e.hue], pace: e.pace };
          this.title = 1 - f; // STANDBY fades out
          return;
        }
        if (this.fromStandby) e.amberSweep = Math.max(0, e.amberSweep - dt * 1.2);
        const k = clamp((this.t - (this.fromStandby ? FLARE : 0)) / TIMING.spindown, 0, 1);
        e.hum = Math.max(0, (this.fromStandby ? 0.5 : 0) * (1 - k * 3));
        e.pace = this.from.pace * Math.exp(-k * 4.2);                                         // rings decelerate
        const hueK = k < 0.32 ? ease.inOut(k / 0.32) : 1;                                  // cyan → white
        const goldK = k > 0.3 ? ease.inOut(clamp((k - 0.3) / 0.5, 0, 1)) : 0;              // → gold
        e.forceHue = mix(mix(this.from.hue, WHITE, hueK * 0.8), GOLD, goldK);
        e.cold = this.from.cold + (1 - this.from.cold) * ease.inOut(clamp((k - 0.25) / 0.65, 0, 1));
        e.scanOn = Math.max(0, 1 - k * 2.5);
        e.coilsLit = k > 0.2 ? Math.max(0, 10 - Math.floor((k - 0.2) / 0.06)) : -1;          // coils go out one by one
        if (k > 0.86 && !this.flickered) { this.flickered = true; e.flash = 0.9; }           // the core flickers once
        this.title = k > 0.8 ? Math.min(1, (k - 0.8) / 0.2) : 0;                              // the offline title fades in
        if (k >= 1) { this.set('offline'); this.events.push('offline'); }
        return;
      }
    }

    /** Opacity for the things that aren't the reactor (orbs, callouts): 1 online, dim in standby, fading in a spin-down. */
    get fade() {
      const m = this.mode;
      if (m === 'online') return 1;
      if (m === 'standby') return 0.4;
      if (m === 'tostandby') return 1 - 0.6 * clamp(this.t / TIMING.standbyIn, 0, 1);
      if (m === 'fromstandby') return 0.4 + 0.6 * clamp(this.t / TIMING.standbyOut, 0, 1);
      if (m === 'spindown') return Math.max(0, 1 - this.t / 1.6);
      return 0;
    }
    get hidesPanels() { return this.mode !== 'online'; }
    /** The frame rate this mode needs: 60 during transitions, a trickle at rest. */
    get fps() {
      if (['charging', 'breath', 'wake', 'tostandby', 'fromstandby', 'spindown'].includes(this.mode)) return 60;
      if (this.hold || this.hover > 0.02 || this.notchHover > 0.02 || this.title < 1) return 60;
      if (this.mode === 'standby') return 24;
      if (this.mode === 'offline') return 4;
      return undefined;
    }
    /** How the dot matrix should look under this state: its hue, the brightness and the cleared areas. */
    sheet(g) {
      const e = this.engine, m = this.mode, S = this.S;
      const lay = layout(g.cx, g.cy, g.r, S);
      const still = m === 'offline' || (m === 'spindown' && this.t / TIMING.spindown > 0.8);
      const standby = m === 'standby' || (m === 'tostandby' && this.t > TIMING.standbyIn * 0.7); // (the band's sheet re-render lands late in the glide, not on its first frame)
      // A clipped page (the helper) keeps the sheet gold while charging: the dots inside its disc must match the still's outside
      const charging = m === 'charging' || m === 'breath';
      return {
        hue: m === 'wake' ? mix(GOLD, CYAN, this.shock) : this.clipR && charging ? GOLD : e.hue,
        opts: { bright: still || standby || (this.clipR && charging) ? 1 : 0, warm: still || (this.clipR && charging) ? 1 : 0, hideLabel: still || standby || (this.clipR && charging), scale: S,
          band: still || (this.clipR && charging) ? lay.band.offline : standby ? lay.band.standby : null, notch: standby ? lay.notch : null },
        shock: m === 'wake' ? this.shock : 0,
      };
    }
    /** The reactor's drawn radius (the rings spring open on the wake). */
    radius(r) { return r * (1 + this.open * 0.07); }

    /** Under the reactor: the drained dots near it and the growing glow while charging. g = { cx, cy, r }. */
    drawUnder(ctx, g) {
      const m = this.mode, { cx, cy, r } = g;
      const reach = this.clipR ? Math.min(this.clipR * 0.92, 2.4) : 2.4; // how far effects may spread (of r)
      if (m === 'charging' || m === 'breath') {
        const c = this.shown;
        const drain = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * reach);
        drain.addColorStop(0, rgba(COLORS.ink, 0.22 * c)); drain.addColorStop(1, rgba(COLORS.ink, 0));
        ctx.fillStyle = drain; ctx.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);
        glow(ctx, mix(GOLD, WHITE, c * 0.6), cx, cy, r * Math.min(1.2 + c * 0.9, reach * 0.55), 0.1 + c * 0.22);
      }
      if (m === 'wake' && this.bloom > 0) glow(ctx, mix(WHITE, CYAN, 0.3), cx, cy, r * Math.min(1.6 + (1 - this.bloom) * 1.6, reach * 0.55), this.bloom * 0.9);
      if ((m === 'offline' || m === 'standby' || m === 'online') && this.hover > 0.01) { // the hover halo: a wide faint lift of the whole disc
        const hv = this.hover * this.GLOW;
        const halo = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * Math.min(1.6 + hv, reach));
        halo.addColorStop(0, rgba(this.engine.hue, 0.22 * hv * 1.4)); halo.addColorStop(1, rgba(this.engine.hue, 0));
        ctx.fillStyle = halo; ctx.fillRect(cx - r * 2.6, cy - r * 2.6, r * 5.2, r * 5.2);
      }
      // The still's soft glow is part of the floor: it stays through the charge (nothing dims below the still)
      if (m === 'offline' || m === 'charging' || m === 'breath') glow(ctx, GOLD, cx, cy, r * 1.5, 0.08);
      else if (m === 'spindown') glow(ctx, GOLD, cx, cy, r * 1.5, 0.08 * this.title);
    }

    /** Over the reactor: the streaks, the charge ring and %, the hold rings, the title block, the notch, the hints. */
    drawOver(ctx, g, { S = this.S } = {}) {
      const e = this.engine, m = this.mode, { cx, cy, r } = g;
      const lay = layout(cx, cy, r, S);
      ctx.save();
      ctx.lineCap = 'round';
      if (m === 'charging' || m === 'breath') {
        const c = this.shown, col = mix(GOLD, WHITE, c * 0.7);
        // streaks spiralling in (a short tail behind each)
        ctx.lineWidth = Math.max(1, 1.2 * S);
        for (const s of this.streaks) {
          const x = cx + Math.cos(s.a) * s.d * r, y = cy + Math.sin(s.a) * s.d * r;
          const a2 = s.a - 0.18 / Math.max(0.4, s.d), d2 = s.d + 0.12;
          ctx.strokeStyle = rgba(col, (0.25 + c * 0.5) * s.w * clamp((s.d - 0.28) / 0.5, 0, 1));
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(a2) * d2 * r, cy + Math.sin(a2) * d2 * r); ctx.lineTo(x, y); ctx.stroke();
        }
        // the segmented charge ring and the %
        const inA = clamp((1 - this.title) / 1, 0, 1);
        const segs = 40, R = lay.ring;
        for (let i = 0; i < segs; i++) {
          const a0 = -TAU / 4 + i / segs * TAU + 0.012, a1 = -TAU / 4 + (i + 1) / segs * TAU - 0.012;
          const lit = i < Math.floor(c * segs + 1e-6);
          ctx.strokeStyle = rgba(lit ? col : GOLD, (lit ? 0.9 : 0.18) * inA); ctx.lineWidth = Math.max(1, (lit ? 2.2 : 1.2) * S);
          ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
        }
        ctx.font = `${Math.round(11 * S)}px ${FONT}`; ctx.letterSpacing = `${Math.round(2 * S)}px`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = rgba(col, 0.85 * inA); ctx.shadowColor = rgba(col, 0.5); ctx.shadowBlur = 8 * S;
        ctx.fillText(`${Math.round(c * 100)}%`, cx + S, lay.pct.y);
        ctx.shadowBlur = 0;
        if (this.failed) hint(ctx, 'DEGRADED START', cx, lay.pct.y + 16 * S, { hue: AMBER, alpha: inA, S });
      }
      if (m === 'wake' && this.shock > 0 && this.shock < 1) { // the shockwave's leading edge over the reactor
        ctx.strokeStyle = rgba(mix(CYAN, WHITE, 0.5), (1 - this.shock) * 0.5); ctx.lineWidth = Math.max(1.5, 6 * S * (1 - this.shock));
        ctx.beginPath(); ctx.arc(cx, cy, r * (0.5 + this.shock * 3.2), 0, TAU); ctx.stroke();
      }
      // Embers out of a hovered core
      if (this.embers.length) {
        for (const em of this.embers) { ctx.fillStyle = rgba(mix(e.hue, WHITE, 0.4 * em.life), em.life * 0.9); ctx.beginPath(); ctx.arc(cx + em.x * r, cy + em.y * r, Math.max(0.6, em.s * r * (0.5 + em.life * 0.5)), 0, TAU); ctx.fill(); }
      }
      // The hold rings: wake / wake-up fill clockwise around the core; standby drains counter-clockwise
      if (this.hold && this.hold.kind !== 'power') {
        const k = this.hold.k, R = r * 0.42;
        const col = this.hold.kind === 'standby' ? BLUE : mix(e.hue, WHITE, 0.4);
        ctx.strokeStyle = rgba(col, 0.25); ctx.lineWidth = Math.max(1, 1.5 * S);
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
        ctx.strokeStyle = rgba(col, 0.95); ctx.lineWidth = Math.max(1.5, 2.2 * S);
        ctx.beginPath();
        if (this.hold.kind === 'standby') ctx.arc(cx, cy, R, -TAU / 4, -TAU / 4 - TAU * k, true); else ctx.arc(cx, cy, R, -TAU / 4, -TAU / 4 + TAU * k);
        ctx.stroke();
      }
      // The title block
      if (this.title > 0.01) {
        if (m === 'spindown' && this.fromStandby && this.t < 0.55) titleBlock(ctx, { cx, y: lay.titleY, S, hue: BLUE, alpha: this.title, kind: 'standby', status: this.status }); // STANDBY fading out in the flare
        else if (m === 'offline' || m === 'spindown' || m === 'charging') titleBlock(ctx, { cx, y: lay.titleY, S, hue: GOLD, alpha: this.title, kind: 'offline' });
        else if (m === 'standby' || m === 'tostandby' || m === 'fromstandby') titleBlock(ctx, { cx, y: lay.titleY, S, hue: BLUE, alpha: this.title, kind: 'standby', status: this.status });
      }
      if (m === 'standby' || m === 'tostandby') drawNotch(ctx, lay.notch, { hover: this.notchHover, hold: this.hold?.kind === 'power' ? this.hold.k : 0, S, alpha: m === 'standby' ? 1 : clamp(this.t / TIMING.standbyIn, 0, 1) });
      // The wake line, typed under the reactor
      if (m === 'online' && this.wakeLine && this.lineShown > 0) {
        const shownText = this.wakeLine.slice(0, Math.floor(this.lineShown));
        const age = this.t;
        const a = age < 0.4 ? age / 0.4 : age > 9 ? Math.max(0, 1 - (age - 9) / 1.2) : 1;
        if (a > 0) titleBlock(ctx, { cx, y: lay.titleY, S, hue: CYAN, alpha: a, kind: 'awake', line: shownText, glowK: 0.6 });
      }
      // Hints
      const text = this.hintFor;
      if (text) {
        const isNotch = text === 'HOLD TO POWER DOWN';
        const a = isNotch ? this.notchHover : this.hover;
        if (isNotch) hint(ctx, text, lay.notch.x + lay.notch.r + 12 * S, lay.notch.y, { hue: AMBER, alpha: a, S, align: 'left' });
        else hint(ctx, text, cx, cy + r * 0.52, { hue: m === 'offline' ? GOLD : m === 'standby' ? BLUE : CYAN, alpha: a * 0.9, S });
      }
      ctx.restore();
    }
  }

  // ---- The ghost log ---------------------------------------------------------------------------------------------------------
  /** Faint monospace lines at the bottom-left: "› memory ... 98 facts ✓". ≤ 3 visible; finished lines fade after ~1.5 s. */
  function ghost(container) {
    container.classList.add('ghost-log');
    const rows = new Map();
    const trim = () => { const live = [...container.children]; while (live.length > 3) { const el = live.shift(); el.remove(); } };
    return {
      step({ name, status, detail }) {
        let row = rows.get(name);
        if (!row) { row = document.createElement('div'); row.className = 'ghost-row'; rows.set(name, row); container.appendChild(row); }
        const mark = status === 'ok' ? '✓' : status === 'fail' ? '✗' : '…';
        row.textContent = `› ${name}${detail ? ` ... ${detail}` : status === 'start' ? ' ...' : ''} ${mark}`;
        row.classList.toggle('pulse', status === 'start');
        row.classList.toggle('fail', status === 'fail');
        if (status !== 'start') setTimeout(() => { row.classList.add('fade'); setTimeout(() => { row.remove(); if (rows.get(name) === row) rows.delete(name); }, 700); }, 1500);
        trim();
      },
      line(text, holdMs = 2000) {
        const row = document.createElement('div'); row.className = 'ghost-row'; row.textContent = `› ${text}`;
        container.appendChild(row); trim();
        setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 700); }, holdMs);
      },
      clear() { container.replaceChildren(); rows.clear(); },
    };
  }

  /**
   * The callouts drawing themselves in after a wake: for callout i (0..3) at overall progress k (0..1), how far along each part is.
   * Staggered 0.18 s apart over ~1.8 s: the anchor dot pops, the diagonal draws out, then the horizontal tick, the label types in,
   * the value fades in last. Each is 0..1; scene.js and the mockups share this.
   */
  function calloutReveal(k, i) {
    const kk = clamp((k * 1.8 - i * 0.18) / 1.0, 0, 1);
    return { dot: clamp(kk * 4, 0, 1), diag: ease.out(clamp(kk * 2.2, 0, 1)), tick: ease.out(clamp(kk * 2.2 - 0.7, 0, 1)), label: clamp(kk * 2.4 - 1.0, 0, 1), value: clamp(kk * 2.5 - 1.5, 0, 1) };
  }
  return { Controller, titleBlock, drawNotch, hint, layout, ghost, calloutReveal, TIMING, GOLD, BLUE, CYAN, AMBER };
});
