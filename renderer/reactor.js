// The reactor look (docs/reactor-prompt.md): ARES's arc reactor, ported from the phone's ReactorView.kt, and the dot-matrix
// schematic sheet behind it (SchematicView.kt). Pure 2D-canvas drawing, no DOM and no app state: the same code draws the
// window, the live desktop, the wallpaper backdrop, the screen saver, the lock-screen still and the mini reactor in the dock.
//
//   const engine = new Reactor.Engine();        engine.setState('speaking'); engine.update(dt, { level, pulse, attention, offline });
//   engine.draw(ctx, cx, cy, r, { small });     the reactor: tick ring + scanner, four counter-turning rings, the waveform
//                                               ring, ten coils in a chase, the core and its sparks. `small` (the dock orb,
//                                               r < ~60): no sparks, no scanner.
//   const back = new Reactor.Backdrop();         back.resize(w, h, dpr); back.draw(ctx, { cx, cy, r, hue, dt, level, speaking })
//                                               near-black sheet, a 14 px dot grid in the reactor's colour (brightest near it),
//                                               construction rings, crosshair, angle marks, a slow radar sweep, and ripples
//                                               rolling out across the dots while she speaks. The static part is rendered
//                                               once per colour/geometry and only tinted after that.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reactor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TAU = Math.PI * 2;
  const RAD = Math.PI / 180;
  const COLORS = {
    cyan: [62, 230, 255], purple: [157, 140, 255], white: [242, 251, 255], amber: [255, 181, 71],
    green: [74, 222, 128], red: [248, 113, 113], grey: [127, 140, 153], ink: [3, 7, 13],
  };
  const STATE_COLOR = { idle: 'cyan', listening: 'cyan', thinking: 'purple', speaking: 'white', offline: 'amber' };
  const ENERGY = { idle: 0, offline: 0, listening: 0.55, speaking: 0.8, thinking: 1 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1)})`;
  const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const key = (c) => `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;

  // Segmented rings: radius (of r), dashes (on, off in degrees), turn speed (deg/s at rest), width (of r), alpha
  const RINGS = [
    { rad: 0.86, on: 28, off: 14, speed: 9, width: 0.028, alpha: 190 / 255 },
    { rad: 0.78, on: 7, off: 7, speed: -16, width: 0.012, alpha: 120 / 255 },
    { rad: 0.66, on: 52, off: 30, speed: 24, width: 0.034, alpha: 220 / 255 },
    { rad: 0.56, on: 12, off: 24, speed: -38, width: 0.016, alpha: 150 / 255 },
  ];

  // A soft glow sprite per colour (instead of a blur filter, which is slow): white centre → colour → clear
  const sprites = new Map();
  function sprite(c) {
    const k = key(c);
    let s = sprites.get(k);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = 96;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    grad.addColorStop(0, rgba(mix(c, COLORS.white, 0.55), 1));
    grad.addColorStop(0.2, rgba(c, 0.85));
    grad.addColorStop(0.5, rgba(c, 0.28));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 96, 96);
    if (sprites.size > 40) sprites.clear();
    sprites.set(k, s);
    return s;
  }
  const glow = (ctx, c, x, y, size, alpha) => {
    if (alpha <= 0.003 || size <= 0) return;
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.drawImage(sprite(c), x - size, y - size, size * 2, size * 2);
    ctx.globalAlpha = 1;
  };

  // ---- The reactor ----------------------------------------------------------------------------------------------------
  class Engine {
    constructor(seed = 7) {
      this.state = 'idle';
      this.level = 0;      // her voice (speaking) or yours (listening), smoothed
      this.energy = 0;     // 0 at rest → 1 fully alive (smooth state changes)
      this.hue = [...COLORS.cyan];
      this.spin = 0;       // the main rings (deg)
      this.scan = 0;       // the scanner on the tick ring (deg)
      this.chase = 0;      // the lit coil travelling around the core (deg)
      this.t = 0;
      this.pulse = 0;      // wake-word / absorb flash, decays
      this.attention = 0;  // amber tint while something needs the user's yes
      this.offline = false;
      this.sparks = [];    // { x, y, vx, vy, life, size } in units of r
      this.spawn = 0;
      this.flash = 0;      // a brief flare of the core (an orb sunk into it)
      let s = seed;
      this.rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }
    setState(st) {
      if (st === this.state) return;
      if (st === 'thinking') this.burst(14);
      this.state = st;
    }
    get target() { return this.offline ? COLORS.amber : COLORS[STATE_COLOR[this.state] || 'cyan']; }
    /** Sparks out of the core: `n` of them, at a `power` (1 = the usual drift). */
    burst(n, power = 1) {
      for (let i = 0; i < n; i++) {
        const a = this.rnd() * TAU;
        const sp = (0.25 + this.rnd() * 0.45) * power;
        this.sparks.push({ x: Math.cos(a) * 0.3, y: Math.sin(a) * 0.3, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, size: 0.008 + this.rnd() * 0.012 });
      }
      while (this.sparks.length > 90) this.sparks.shift();
    }
    /** Advance the animation. `level` 0..1 (only used while listening or speaking), `pulse` ≥ 0 a wake flash, `attention` 0..1. */
    update(dt, live = {}) {
      dt = clamp(dt, 0, 0.05);
      const st = this.state;
      this.offline = Boolean(live.offline);
      const wantLevel = st === 'speaking' || st === 'listening' ? clamp(live.level || 0, 0, 1) : 0;
      this.level += (wantLevel - this.level) * Math.min(1, dt * 16);
      const wantEnergy = this.offline ? 0 : (ENERGY[st] ?? 0);
      this.energy += (wantEnergy - this.energy) * Math.min(1, dt * 3);
      this.attention += ((live.attention ? 1 : 0) - this.attention) * Math.min(1, dt * 2.5);
      let target = this.target;
      if (this.attention > 0.01 && !this.offline) target = mix(target, COLORS.amber, this.attention * 0.5);
      this.hue = mix(this.hue, target, Math.min(1, dt * 4));
      this.pulse = Math.max(live.pulse || 0, this.pulse * Math.exp(-dt * 3));
      this.flash *= Math.exp(-dt * 4);
      const pace = 1 + this.energy * (st === 'thinking' ? 6 : 2.2);
      this.spin += dt * 10 * pace;
      this.scan += dt * (40 + this.energy * 160 + this.pulse * 120);
      this.chase += dt * (90 + this.energy * 420 + this.level * 300);
      this.t += dt;
      // Sparks: a trickle at rest, a stream while she works or speaks
      this.spawn += dt * (2 + this.energy * 22 + this.level * 30 + this.pulse * 20);
      while (this.spawn >= 1) { this.spawn -= 1; this.burst(1); }
      for (let i = this.sparks.length - 1; i >= 0; i--) {
        const s = this.sparks[i];
        s.life -= dt * 0.9;
        if (s.life <= 0) { this.sparks.splice(i, 1); continue; }
        s.x += s.vx * dt; s.y += s.vy * dt;
        s.vx *= 1 - dt * 0.6; s.vy *= 1 - dt * 0.6;
      }
    }
    /** Draw at (cx, cy) with radius r. `small`: the mini reactor (no sparks, no scanner). `alpha`: whole-reactor opacity. */
    draw(ctx, cx, cy, r, { small = false, alpha = 1 } = {}) {
      if (r < 4) return;
      const c = this.hue, t = this.t, energy = this.energy, level = this.level, dim = this.offline;
      const lit0 = dim ? 0.5 : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.translate(cx, cy);
      // Outer tick ring with the scanner: a bright wedge sweeping round, the ticks behind it lit
      ctx.lineWidth = Math.max(0.8, r * 0.01);
      for (let i = 0; i < 90; i++) {
        const deg = i * 4, a = deg * RAD;
        const behind = ((this.scan - deg) % 360 + 360) % 360; // how far past this tick the scanner is
        const lit = small ? 0 : clamp(1 - behind / 70, 0, 1);
        const inner = i % 9 === 0 ? r * 0.9 : r * 0.945;
        ctx.strokeStyle = rgba(c, (45 + lit * 190) / 255 * lit0 * (0.6 + 0.4 * (dim ? 1 : 1)));
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.stroke();
      }
      if (!small) { // the scanner's glow trail (three soft passes)
        const a1 = this.scan * RAD, a0 = a1 - 40 * RAD;
        for (const [w, k] of [[0.09, 0.08], [0.05, 0.14], [0.02, 0.28]]) {
          ctx.lineWidth = r * w;
          ctx.strokeStyle = rgba(c, (0.25 + energy * 0.35 + this.pulse * 0.3) * k * lit0);
          ctx.beginPath(); ctx.arc(0, 0, r * 0.95, a0, a1); ctx.stroke();
        }
      }
      // Segmented rings turning against each other
      for (const ring of RINGS) {
        const rad = r * ring.rad, circ = TAU * rad;
        ctx.setLineDash([circ * ring.on / 360, circ * ring.off / 360]);
        ctx.lineWidth = Math.max(0.8, r * ring.width);
        ctx.strokeStyle = rgba(c, dim ? ring.alpha / 2 : ring.alpha * (0.7 + energy * 0.3));
        ctx.beginPath(); ctx.arc(0, 0, rad, this.spin * ring.speed / 10 * RAD, this.spin * ring.speed / 10 * RAD + TAU); ctx.stroke();
      }
      ctx.setLineDash([]);
      // The waveform ring: her voice (or yours) ripples it
      const wr = r * 0.47;
      if (level > 0.02 || energy > 0.05) {
        const amp = wr * (0.02 + level * 0.16 + energy * 0.015);
        ctx.beginPath();
        for (let i = 0; i <= 120; i++) {
          const a = i / 120 * TAU;
          const wob = Math.sin(a * 7 + t * 9) * 0.5 + Math.sin(a * 11 - t * 13) * 0.3 + Math.sin(a * 3 + t * 4) * 0.2;
          const rr = wr + amp * wob;
          if (i) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.lineWidth = Math.max(0.8, r * 0.012);
        ctx.strokeStyle = rgba(c, (90 + level * 160) / 255 * lit0);
        ctx.stroke();
      }
      // Coils around the core, lit in a chase
      const coilR = r * 0.4;
      ctx.lineWidth = Math.max(1, r * 0.045);
      for (let i = 0; i < 10; i++) {
        const deg = i * 36, a = deg * RAD;
        const d = ((this.chase - deg) % 360 + 360) % 360;
        const lit = clamp(1 - d / 110, 0, 1);
        ctx.strokeStyle = rgba(c, (50 + lit * 200 * (0.4 + energy * 0.6 + level * 0.5)) / 255 * lit0);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * (coilR - r * 0.035), Math.sin(a) * (coilR - r * 0.035));
        ctx.lineTo(Math.cos(a) * (coilR + r * 0.035), Math.sin(a) * (coilR + r * 0.035));
        ctx.stroke();
      }
      // Core: breathes at rest, swells with the voice, flickers while thinking; a soft glow around it
      const breathe = (Math.sin(t * 1.4) + 1) * 0.025;
      const flicker = this.state === 'thinking' && !dim ? (Math.sin(t * 23) * 0.5 + Math.sin(t * 37) * 0.5) * 0.02 : 0;
      const core = r * (0.24 + breathe + level * 0.13 + energy * 0.03 + flicker + this.pulse * 0.04 + this.flash * 0.06);
      glow(ctx, c, 0, 0, core * 1.9, ((70 + energy * 90 + level * 120) / 255 + this.pulse * 0.3 + this.flash * 0.4) * lit0 * alpha);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, core);
      g.addColorStop(0, rgba(COLORS.white, 1));
      g.addColorStop(0.42, rgba(c, 1));
      g.addColorStop(1, rgba(c, 0));
      ctx.globalAlpha = (dim ? 150 / 255 : 1) * alpha;
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, core, 0, TAU); ctx.fill();
      ctx.globalAlpha = alpha;
      // Sparks
      if (!small) {
        ctx.fillStyle = rgba(c, 1);
        for (const s of this.sparks) {
          ctx.globalAlpha = s.life * 220 / 255 * alpha;
          ctx.beginPath(); ctx.arc(s.x * r, s.y * r, Math.max(0.6, s.size * r * (0.5 + s.life * 0.5)), 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  // ---- The dot-matrix schematic sheet ---------------------------------------------------------------------------------
  const PITCH = 14, DOT = 1.5;
  const SCHEMATIC_RINGS = [[1.14, 0.2, [2, 6]], [1.3, 0.15, [1, 5]], [1.62, 0.11, []], [1.95, 0.08, [6, 10]], [2.4, 0.055, []], [0.5, 0.12, [4, 4]]];
  class Backdrop {
    constructor() {
      this.mask = document.createElement('canvas');   // white dots + schematic, alpha = brightness
      this.tinted = document.createElement('canvas'); // the mask in the current colour
      this.rip = document.createElement('canvas');    // ripple rings, masked to the dots
      this.w = this.h = 0; this.dpr = 1;
      this.maskKey = ''; this.tintKey = '';
      this.ripples = [];
      this.sweep = 0;
      this.lastLevel = 0; this.lastRipple = 0; this.t = 0;
      this.font = '"SF Mono", ui-monospace, Menlo, monospace';
    }
    resize(w, h, dpr = 1) {
      this.w = w; this.h = h; this.dpr = dpr;
      for (const c of [this.mask, this.tinted, this.rip]) { c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr)); }
      this.maskKey = ''; this.tintKey = '';
    }
    /** White dots (brightest near the reactor, fading with distance) and the schematic lines, as a mask. */
    renderMask(cx, cy, r) {
      const { w, h, dpr } = this;
      const g = this.mask.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // The dot grid, centred on the reactor so a dot sits on each axis
      const x0 = cx % PITCH, y0 = cy % PITCH;
      const far = r * 3.2;
      g.fillStyle = '#fff';
      for (let y = y0; y < h + PITCH; y += PITCH) {
        for (let x = x0; x < w + PITCH; x += PITCH) {
          const d = Math.hypot(x - cx, y - cy);
          const near = clamp(1 - (d - r * 0.9) / far, 0, 1);
          const a = 0.07 + near * near * 0.5;
          g.globalAlpha = a;
          g.fillRect(x - DOT / 2, y - DOT / 2, DOT, DOT);
        }
      }
      // A soft glow in the middle of the sheet
      const v = g.createRadialGradient(cx, cy, 0, cx, cy, r * 3.1);
      v.addColorStop(0, 'rgba(255,255,255,0.09)');
      v.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalAlpha = 1; g.fillStyle = v; g.fillRect(0, 0, w, h);
      // Construction rings running off toward the edges, crosshair, diagonals
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.lineCap = 'butt';
      for (const [rr, a, dash] of SCHEMATIC_RINGS) { g.globalAlpha = a; g.setLineDash(dash); g.beginPath(); g.arc(cx, cy, r * rr, 0, TAU); g.stroke(); }
      g.setLineDash([]);
      const reach = r * 2.6;
      g.globalAlpha = 0.16; g.beginPath(); g.moveTo(cx, cy - reach); g.lineTo(cx, cy + reach); g.moveTo(cx - reach, cy); g.lineTo(cx + reach, cy); g.stroke();
      g.globalAlpha = 0.08; g.beginPath(); g.moveTo(cx - reach, cy - reach); g.lineTo(cx + reach, cy + reach); g.moveTo(cx + reach, cy - reach); g.lineTo(cx - reach, cy + reach); g.stroke();
      // Angle marks on the 1.3 ring, labels at the quarters
      g.font = `8px ${this.font}`; g.textAlign = 'center'; g.fillStyle = '#fff';
      const r0 = r * 1.3;
      for (let i = 0; i < 72; i++) {
        const a = i * 5 * RAD;
        const len = i % 18 === 0 ? 14 : i % 6 === 0 ? 8 : 4;
        g.globalAlpha = i % 18 === 0 ? 0.42 : i % 6 === 0 ? 0.25 : 0.14;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); g.stroke();
        if (i % 18 === 0) { g.globalAlpha = 0.42; g.fillText(`${i * 5}°`, cx + Math.cos(a) * (r0 + 26), cy + Math.sin(a) * (r0 + 26) + 3); }
      }
      g.globalAlpha = 1;
    }
    tint(hue) {
      const g = this.tinted.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, this.tinted.width, this.tinted.height);
      g.drawImage(this.mask, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = rgba(hue, 1);
      g.fillRect(0, 0, this.tinted.width, this.tinted.height);
      g.globalCompositeOperation = 'source-over';
    }
    /**
     * Draw one frame into `ctx` (CSS pixels; the caller set the transform). `hue` is the reactor's current colour; `level`
     * her voice level while `speaking`. `motion` false = a still frame (no sweep, no ripples). `ink` paints the near-black
     * sheet first (false on a transparent window, where the page's own background shows through).
     */
    draw(ctx, { cx, cy, r, hue = COLORS.cyan, dt = 0, level = 0, speaking = false, motion = true, ink = true }) {
      const { w, h, dpr } = this;
      if (!w || !h || r < 4) return;
      dt = clamp(dt, 0, 0.05);
      this.t += dt;
      const mk = `${Math.round(cx)},${Math.round(cy)},${Math.round(r)}`;
      if (mk !== this.maskKey) { this.maskKey = mk; this.renderMask(cx, cy, r); this.tintKey = ''; }
      const tk = `${hue[0] >> 2},${hue[1] >> 2},${hue[2] >> 2}`;
      if (tk !== this.tintKey) { this.tintKey = tk; this.tint(hue); }
      if (ink) { ctx.fillStyle = rgba(COLORS.ink, 1); ctx.fillRect(0, 0, w, h); } else ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.tinted, 0, 0, w, h);
      if (!motion) return;
      // The radar sweep between the 1.3 and 1.62 rings
      this.sweep += dt * 28;
      if (ctx.createConicGradient) {
        const sg = ctx.createConicGradient(this.sweep * RAD, cx, cy);
        sg.addColorStop(0, rgba(hue, 0.16));
        sg.addColorStop(0.12, rgba(hue, 0));
        sg.addColorStop(1, rgba(hue, 0));
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.62, 0, TAU); ctx.arc(cx, cy, r * 1.3, 0, TAU, true); ctx.fill('evenodd');
      }
      // Ripples across the dots while she speaks: a new one on each stronger syllable
      if (speaking && level > 0.04) {
        const rising = level > this.lastLevel + 0.12;
        if ((rising || level > 0.55) && this.t - this.lastRipple > 0.28) { this.lastRipple = this.t; this.ripples.push({ t0: this.t, k: clamp(0.35 + level, 0.4, 1.2) }); }
      }
      this.lastLevel += (level - this.lastLevel) * Math.min(1, dt * 10);
      this.ripples = this.ripples.filter((p) => this.t - p.t0 < 2.4);
      if (this.ripples.length) {
        const g = this.rip.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, w, h);
        g.lineCap = 'butt';
        for (const p of this.ripples) {
          const age = this.t - p.t0, k = age / 2.4;
          const rr = r * 0.55 + age * r * 1.7;
          const a = (1 - k) * (1 - k) * 0.9 * p.k;
          const wid = 26 + age * 30;
          const grad = g.createRadialGradient(cx, cy, Math.max(0, rr - wid), cx, cy, rr + wid);
          grad.addColorStop(0, 'rgba(255,255,255,0)');
          grad.addColorStop(0.5, `rgba(255,255,255,${a})`);
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          g.strokeStyle = grad; g.lineWidth = wid * 2;
          g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.stroke();
        }
        g.globalCompositeOperation = 'destination-in';
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(this.mask, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = rgba(mix(hue, COLORS.white, 0.5), 1);
        g.fillRect(0, 0, this.rip.width, this.rip.height);
        g.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(this.rip, 0, 0, w, h);
        ctx.restore();
      }
    }
  }

  return { Engine, Backdrop, COLORS, rgba, mix, glow, sprite, TAU, RAD, clamp };
});
