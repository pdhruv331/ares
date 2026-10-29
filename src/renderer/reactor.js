// The reactor look (docs/reactor-prompt.md): ARES's arc reactor, ported from the phone's ReactorView.kt, and the dot-matrix
// schematic sheet behind it (SchematicView.kt). Pure 2D-canvas drawing, no DOM and no app state: the same code draws the
// window, the live desktop, the wallpaper backdrop, the screen saver, the lock-screen still and the mini reactor in the dock.
//
//   const engine = new Reactor.Engine();        engine.setState('speaking'); engine.update(dt, { level, pulse, attention, offline });
//   engine.draw(ctx, cx, cy, r, { small });     the reactor: tick ring + scanner, four counter-turning rings, the waveform
//                                               ring, ten coils in a chase, the core and its sparks. `small` (the dock orb,
//                                               r < ~60): no sparks, no scanner.
//   const back = new Reactor.Backdrop();         back.resize(w, h, dpr, animDpr); back.draw(ctx, { staticCtx, cx, cy, r, hue, dt, level, speaking })
//                                               near-black sheet, a 14 px dot grid in the reactor's colour (brightest near it),
//                                               construction rings, crosshair, angle marks, a slow radar sweep, and ripples
//                                               rolling out across the dots while she speaks. Two canvases: the sheet itself
//                                               (`staticCtx`) is rendered once per colour/geometry and left alone; only the
//                                               sweep and the ripples are drawn per frame (`ctx`, a transparent layer).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reactor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TAU = Math.PI * 2;
  const RAD = Math.PI / 180;
  const COLORS = {
    cyan: [62, 230, 255], purple: [157, 140, 255], white: [242, 251, 255], amber: [255, 181, 71],
    green: [74, 222, 128], red: [248, 113, 113], grey: [127, 140, 153], ink: [3, 7, 13],
    gold: [250, 196, 88], blue: [96, 150, 255], // the cold reactor (ARES off) and standby (docs/ignition-prompt.md)
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
      // Ignition / standby / power down (renderer/ignite.js drives these):
      this.cold = 0;       // 0 live → 1 the offline still's brightness (rings 0.54, ticks 0.36, coils 0.33, a soft core glow, no motion)
      this.forceHue = null; // a colour the engine holds instead of the state's (gold while cold, blue in standby)
      this.pace = 1;       // speed of every motion (1 normal; the spin-down winds it to 0, standby holds ~0.15)
      this.hum = 0;        // the tick ring's vibration while charging (0..1)
      this.coilsLit = -1;  // charge-to-wake: how many coils are lit (0..10); -1 = the normal chase
      this.scanOn = 1;     // the scanner's visibility (0..1)
      this.rate = 1;       // how fast hue changes follow (1 normal; a spin-down drains slowly)
      this.amberSweep = 0; // the power hold: ticks lit amber outward from the bottom until they meet at the top (0..1)
      this.hover = 0;      // the pointer over the core (0..1): the core swells and whitens, its glow grows, the near ticks brighten
      this.hoverAngle = 0; // where the pointer is, from the centre (rad)
      this.glowK = 0.7;    // how far the hover glow goes (the user's 70, 2026-10-06)
      this.restGlow = 0.3; // the glow at rest, nothing hovered: the core's halo is never fully cold
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
      let target = this.forceHue || this.target;
      if (this.attention > 0.01 && !this.offline && !this.forceHue) target = mix(target, COLORS.amber, this.attention * 0.5);
      this.hue = mix(this.hue, target, Math.min(1, dt * 4 * this.rate));
      this.pulse = Math.max(live.pulse || 0, this.pulse * Math.exp(-dt * 3));
      this.flash *= Math.exp(-dt * 4);
      const pace = (1 + this.energy * (st === 'thinking' ? 6 : 2.2)) * this.pace;
      this.spin += dt * 10 * pace;
      this.scan += dt * (40 + this.energy * 160 + this.pulse * 120) * this.pace;
      this.chase += dt * (90 + this.energy * 420 + this.level * 300) * this.pace;
      this.t += dt * Math.max(0.15, this.pace);
      // Sparks: a trickle at rest, a stream while she works or speaks (none while cold)
      this.spawn += dt * (2 + this.energy * 22 + this.level * 30 + this.pulse * 20) * (1 - this.cold) * Math.min(1, this.pace * 2);
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
      const cold = clamp(this.cold, 0, 1), warm = 1 - cold; // the cold still is the floor: every element only brightens from it
      const lit0 = dim ? 0.5 : 1;
      const lerp = (a, b) => a + (b - a) * warm; // (a) cold value → (b) live value
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.translate(cx, cy);
      // Outer tick ring with the scanner: a bright wedge sweeping round, the ticks behind it lit. Charging: the ring hums
      ctx.lineWidth = Math.max(0.8, r * 0.01);
      const humA = this.hum > 0 ? Math.sin(t * 90) * this.hum * r * 0.006 : 0;
      for (let i = 0; i < 90; i++) {
        const deg = i * 4, a = deg * RAD;
        const behind = ((this.scan - deg) % 360 + 360) % 360; // how far past this tick the scanner is
        const lit = small ? 0 : clamp(1 - behind / 70, 0, 1) * this.scanOn * warm;
        const inner = (i % 9 === 0 ? r * 0.9 : r * 0.945) + humA * (i % 2 ? 1 : -1);
        const fromBottom = Math.abs(((deg - 90) % 360 + 540) % 360 - 180); // 0 at the bottom tick, 180 at the top
        const amber = this.amberSweep > 0 && fromBottom <= this.amberSweep * 180;
        let prox = 0; // the ticks nearest the pointer warm up while the core is hovered
        if (this.hover > 0.01) { const da = Math.abs(((a - this.hoverAngle + Math.PI) % TAU + TAU) % TAU - Math.PI); prox = Math.max(0, 1 - da / 0.9) * this.hover; }
        ctx.strokeStyle = amber ? rgba(COLORS.amber, 0.95) : rgba(prox ? mix(c, COLORS.white, prox * 0.5) : c, Math.min(1, lerp(0.36, (45 + lit * 190) / 255 * lit0) + prox * 0.55 + this.hover * 0.08));
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * (r + humA * (i % 2 ? -1 : 1)), Math.sin(a) * (r + humA * (i % 2 ? -1 : 1)));
        ctx.stroke();
      }
      if (!small && this.scanOn > 0.01 && warm > 0.01) { // the scanner's glow trail (three soft passes)
        const a1 = this.scan * RAD, a0 = a1 - 40 * RAD;
        for (const [w, k] of [[0.09, 0.08], [0.05, 0.14], [0.02, 0.28]]) {
          ctx.lineWidth = r * w;
          ctx.strokeStyle = rgba(c, (0.25 + energy * 0.35 + this.pulse * 0.3) * k * lit0 * this.scanOn * warm);
          ctx.beginPath(); ctx.arc(0, 0, r * 0.95, a0, a1); ctx.stroke();
        }
      }
      // Segmented rings turning against each other
      for (const ring of RINGS) {
        const rad = r * ring.rad, circ = TAU * rad;
        ctx.setLineDash([circ * ring.on / 360, circ * ring.off / 360]);
        ctx.lineWidth = Math.max(0.8, r * ring.width);
        const liveA = dim ? ring.alpha / 2 : ring.alpha * (0.7 + energy * 0.3);
        ctx.strokeStyle = rgba(c, lerp(ring.alpha * 0.54 / 0.86, Math.max(liveA, ring.alpha * 0.54 / 0.86)));
        ctx.beginPath(); ctx.arc(0, 0, rad, this.spin * ring.speed / 10 * RAD, this.spin * ring.speed / 10 * RAD + TAU); ctx.stroke();
      }
      ctx.setLineDash([]);
      // The waveform ring: her voice (or yours) ripples it
      const wr = r * 0.47;
      if ((level > 0.02 || energy > 0.05) && warm > 0.01) {
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
        ctx.strokeStyle = rgba(c, (90 + level * 160) / 255 * lit0 * warm);
        ctx.stroke();
      }
      // Coils around the core, lit in a chase (charging: one lights per 10%, from the bottom, both ways up)
      const coilR = r * 0.4;
      ctx.lineWidth = Math.max(1, r * 0.045);
      for (let i = 0; i < 10; i++) {
        const deg = i * 36, a = deg * RAD;
        const d = ((this.chase - deg) % 360 + 360) % 360;
        let lit = clamp(1 - d / 110, 0, 1) * warm;
        if (this.coilsLit >= 0) { const order = [2, 3, 1, 4, 0, 5, 9, 6, 8, 7].indexOf(i); lit = order < this.coilsLit ? 0.9 + 0.1 * Math.sin(t * 6 + i) : 0; }
        ctx.strokeStyle = rgba(c, lerp(0.33, Math.max(0.33, (50 + lit * 200 * (0.4 + energy * 0.6 + level * 0.5)) / 255 * lit0)));
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * (coilR - r * 0.035), Math.sin(a) * (coilR - r * 0.035));
        ctx.lineTo(Math.cos(a) * (coilR + r * 0.035), Math.sin(a) * (coilR + r * 0.035));
        ctx.stroke();
      }
      // Core: breathes at rest, swells with the voice, flickers while thinking; a soft glow around it
      const breathe = (Math.sin(t * 1.4) + 1) * 0.025 * Math.max(0.3, Math.min(1, this.pace));
      const flicker = this.state === 'thinking' && !dim ? (Math.sin(t * 23) * 0.5 + Math.sin(t * 37) * 0.5) * 0.02 : 0;
      const hv = Math.max(this.restGlow * 0.5, this.hover * this.glowK); // the resting glow underneath, the hover above it
      const core = r * (0.24 + breathe + level * 0.13 + energy * 0.03 + flicker + this.pulse * 0.04 + this.flash * 0.06) * lerp(0.8, 1) * (1 + this.hover * this.glowK * 0.72);
      glow(ctx, c, 0, 0, core * 1.9 * (1 + hv), (lerp(0.22, (70 + energy * 90 + level * 120) / 255 + this.pulse * 0.3 + this.flash * 0.4) + hv * 0.68) * lit0 * alpha);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, core);
      g.addColorStop(0, rgba(mix(c, COLORS.white, Math.min(1, lerp(0.35, 1) + this.hover * 0.45)), 1));
      g.addColorStop(0.42, rgba(c, 1));
      g.addColorStop(1, rgba(c, 0));
      ctx.globalAlpha = (dim ? 150 / 255 : 1) * alpha * Math.min(1, lerp(0.42, 1) + this.hover * 0.5 * (1 - warm));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, core, 0, TAU); ctx.fill();
      ctx.globalAlpha = alpha;
      // Sparks
      if (!small && warm > 0.01) {
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
      // The still / standby sheet (docs/ignition-prompt.md §1, §4b): denser, brighter dots and schematic (`bright` 0..1), a
      // cleared band (stage px: { x, y, w, h }) where the title block sits, the 90° label hidden, a warm glow, and the
      // power notch's port ({ x, y, r }: every line cut around it, the dots under it left out). Changing them re-renders.
      this.opts = { bright: 0, band: null, hideLabel: false, warm: 0, notch: null, scale: 1 };
    }
    /** Set the still options above; returns true when something changed (the sheet is re-rendered on the next draw). */
    setOpts(o) {
      const next = { ...this.opts, ...o };
      const k = JSON.stringify(next);
      if (k === this.optsKey) return false;
      this.optsKey = k; this.opts = next; this.maskKey = ''; this.staticKey = '';
      return true;
    }
    resize(w, h, dpr = 1, animDpr = 1) {
      this.w = w; this.h = h; this.dpr = dpr; this.animDpr = animDpr;
      for (const c of [this.mask, this.tinted]) { c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr)); }
      this.rip.width = Math.max(1, Math.round(w * animDpr)); this.rip.height = Math.max(1, Math.round(h * animDpr));
      this.maskKey = ''; this.tintKey = ''; this.sweepKey = ''; this.staticKey = ''; this.maskAt = 0;
    }
    /** The radar wedge, rendered once per size and colour, then just rotated into place. */
    sweepSprite(r, hue) {
      const k = `${Math.round(r)}|${hue[0] >> 2},${hue[1] >> 2},${hue[2] >> 2}`;
      if (k === this.sweepKey) return this.sweepC;
      this.sweepKey = k;
      const R = r * 1.62, d = this.animDpr;
      const c = this.sweepC || (this.sweepC = document.createElement('canvas'));
      c.width = c.height = Math.max(2, Math.ceil(R * 2 * d));
      const g = c.getContext('2d');
      g.setTransform(d, 0, 0, d, 0, 0);
      g.clearRect(0, 0, R * 2, R * 2);
      if (!g.createConicGradient) return c;
      const sg = g.createConicGradient(0, R, R);
      sg.addColorStop(0, rgba(hue, 0.16));
      sg.addColorStop(0.12, rgba(hue, 0));
      sg.addColorStop(1, rgba(hue, 0));
      g.fillStyle = sg;
      g.beginPath(); g.arc(R, R, R, 0, TAU); g.arc(R, R, r * 1.3, 0, TAU, true); g.fill('evenodd');
      return c;
    }
    /** White dots (brightest near the reactor, fading with distance) and the schematic lines, as a mask. */
    renderMask(cx, cy, r) {
      const { w, h, dpr } = this;
      const o = this.opts, S = o.scale || 1; // S: the display's backing scale when the sheet is drawn in device px (the still)
      const bright = clamp(o.bright, 0, 1);
      const g = this.mask.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // The dot grid, centred on the reactor so a dot sits on each axis: brightness in 12 steps, one fill per step
      const pitch = PITCH * S * (1 - bright * 0.15), dot = DOT * S;
      const x0 = cx % pitch, y0 = cy % pitch;
      const far = r * 3.2;
      const band = o.band, notch = o.notch;
      const inBand = (x, y) => band && x >= band.x && x <= band.x + band.w && y >= band.y && y <= band.y + band.h;
      const bandFade = (x, y) => { // 1 outside the band, 0 well inside it (a soft edge so nothing crosses the text)
        if (!band) return 1;
        const dx = Math.max(band.x - x, 0, x - (band.x + band.w)), dy = Math.max(band.y - y, 0, y - (band.y + band.h));
        return clamp(Math.hypot(dx, dy) / (12 * S), 0, 1);
      };
      g.fillStyle = '#fff';
      const STEPS = 12;
      const paths = Array.from({ length: STEPS }, () => new Path2D());
      for (let y = y0; y < h + pitch; y += pitch) {
        for (let x = x0; x < w + pitch; x += pitch) {
          if (inBand(x, y)) continue;
          if (notch && Math.hypot(x - notch.x, y - notch.y) < notch.r + 5 * S) continue;
          const d = Math.hypot(x - cx, y - cy);
          const near = clamp(1 - (d - r * 0.9) / far, 0, 1) * bandFade(x, y);
          paths[Math.min(STEPS - 1, Math.round(near * near * (STEPS - 1)))].rect(x - dot / 2, y - dot / 2, dot, dot);
        }
      }
      paths.forEach((pth, i) => { g.globalAlpha = Math.min(1, (0.07 + (i / (STEPS - 1)) * 0.5) * (1 + bright * 0.3)); g.fill(pth); });
      // A soft glow in the middle of the sheet (warmer and wider on the still)
      const v = g.createRadialGradient(cx, cy, 0, cx, cy, r * (3.1 + o.warm * 0.6));
      v.addColorStop(0, `rgba(255,255,255,${0.09 + o.warm * 0.07})`);
      v.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalAlpha = 1; g.fillStyle = v; g.fillRect(0, 0, w, h);
      // Construction rings running off toward the edges, crosshair, diagonals (cut around the band and the notch)
      g.strokeStyle = '#fff'; g.lineWidth = 1 * S; g.lineCap = 'butt';
      const gain = 1 + bright; // ~2× brighter on the still
      const cut = (x, y) => (band && inBand(x, y)) || (notch && Math.hypot(x - notch.x, y - notch.y) < notch.r + 5 * S);
      const arc = (rr, a0 = 0, a1 = TAU) => { // an arc as short runs, skipping what the band or the notch would cross
        if (!band && !notch) { g.beginPath(); g.arc(cx, cy, rr, a0, a1); g.stroke(); return; }
        const n = Math.max(64, Math.round(rr / (2 * S)));
        g.beginPath();
        let open = false;
        for (let i = 0; i <= n; i++) {
          const a = a0 + (a1 - a0) * i / n, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
          if (cut(x, y)) { open = false; continue; }
          if (open) g.lineTo(x, y); else { g.moveTo(x, y); open = true; }
        }
        g.stroke();
      };
      const line = (x0, y0, x1, y1) => {
        const n = Math.max(32, Math.round(Math.hypot(x1 - x0, y1 - y0) / (2 * S)));
        g.beginPath();
        let open = false;
        for (let i = 0; i <= n; i++) {
          const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
          if (cut(x, y)) { open = false; continue; }
          if (open) g.lineTo(x, y); else { g.moveTo(x, y); open = true; }
        }
        g.stroke();
      };
      for (const [rr, a, dash] of SCHEMATIC_RINGS) { g.globalAlpha = Math.min(0.6, a * gain); g.setLineDash(dash.map((d) => d * S)); arc(r * rr); }
      g.setLineDash([]);
      const reach = r * 2.6;
      g.globalAlpha = Math.min(0.5, 0.16 * gain); line(cx, cy - reach, cx, cy + reach); line(cx - reach, cy, cx + reach, cy);
      g.globalAlpha = Math.min(0.4, 0.08 * gain); line(cx - reach, cy - reach, cx + reach, cy + reach); line(cx + reach, cy - reach, cx - reach, cy + reach);
      // Angle marks on the 1.3 ring, labels at the quarters (the 90° label hidden on the still: the title sits there)
      g.font = `${8 * S}px ${this.font}`; g.textAlign = 'center'; g.fillStyle = '#fff';
      const r0 = r * 1.3;
      for (let i = 0; i < 72; i++) {
        const a = i * 5 * RAD;
        const len = (i % 18 === 0 ? 14 : i % 6 === 0 ? 8 : 4) * S;
        const tx = cx + Math.cos(a) * r0, ty = cy + Math.sin(a) * r0;
        if (cut(tx, ty) || cut(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len))) continue;
        g.globalAlpha = Math.min(0.7, (i % 18 === 0 ? 0.42 : i % 6 === 0 ? 0.25 : 0.14) * gain);
        g.beginPath(); g.moveTo(tx, ty); g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); g.stroke();
        if (i % 18 === 0 && !(o.hideLabel && i === 18)) { g.globalAlpha = Math.min(0.7, 0.42 * gain); g.fillText(`${i * 5}°`, cx + Math.cos(a) * (r0 + 26 * S), cy + Math.sin(a) * (r0 + 26 * S) + 3 * S); }
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
    draw(ctx, { staticCtx = null, cx, cy, r, hue = COLORS.cyan, dt = 0, level = 0, speaking = false, motion = true, ink = true }) {
      const { w, h, animDpr } = this;
      if (!w || !h || r < 4) return;
      dt = clamp(dt, 0, 0.05);
      this.t += dt;
      // The sheet is re-rendered when the reactor moves or resizes, but not on every frame of a glide (a display's worth
      // of dots): at most every 0.25 s, and meanwhile the last sheet is drawn shifted to follow
      const mk = `${Math.round(cx)},${Math.round(cy)},${Math.round(r)}`;
      if (mk !== this.maskKey && (!this.maskAt || this.t - this.maskAt > 0.25 || !this.maskKey)) {
        this.maskKey = mk; this.maskAt = this.t; this.maskCx = cx; this.maskCy = cy;
        this.renderMask(cx, cy, r); this.tintKey = '';
      }
      const tk = `${hue[0] >> 2},${hue[1] >> 2},${hue[2] >> 2}`;
      if (tk !== this.tintKey) { this.tintKey = tk; this.tint(hue); }
      // The sheet: into its own canvas when it changes (geometry, colour), else once into this one
      const sctx = staticCtx || ctx;
      const ox = cx - this.maskCx, oy = cy - this.maskCy;
      const sk = `${this.maskKey}|${tk}|${ink}|${Math.round(ox)},${Math.round(oy)}`;
      if (sk !== this.staticKey || !staticCtx) {
        this.staticKey = sk;
        if (ink) { sctx.fillStyle = rgba(COLORS.ink, 1); sctx.fillRect(0, 0, w, h); } else sctx.clearRect(0, 0, w, h);
        sctx.drawImage(this.tinted, ox, oy, w, h);
      }
      if (staticCtx) ctx.clearRect(0, 0, w, h);
      if (!motion) return;
      // The radar sweep between the 1.3 and 1.62 rings
      this.sweep += dt * 28;
      const wedge = this.sweepSprite(r, hue);
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(this.sweep * RAD);
      ctx.drawImage(wedge, -r * 1.62, -r * 1.62, r * 3.24, r * 3.24);
      ctx.restore();
      // Ripples across the dots while she speaks: a new one on each stronger syllable
      if (speaking && level > 0.04) {
        const rising = level > this.lastLevel + 0.12;
        if ((rising || level > 0.55) && this.t - this.lastRipple > 0.28) { this.lastRipple = this.t; this.ripples.push({ t0: this.t, k: clamp(0.35 + level, 0.4, 1.2) }); }
      }
      this.lastLevel += (level - this.lastLevel) * Math.min(1, dt * 10);
      this.ripples = this.ripples.filter((p) => this.t - p.t0 < 2.4);
      if (this.ripples.length) {
        const g = this.rip.getContext('2d');
        g.setTransform(animDpr, 0, 0, animDpr, 0, 0);
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
        g.drawImage(this.mask, 0, 0, this.rip.width, this.rip.height);
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

  return { Engine, Backdrop, COLORS, RINGS, SCHEMATIC_RINGS, PITCH, rgba, mix, glow, sprite, TAU, RAD, clamp };
});
