// Animated arc-reactor HUD. Driven by a state ('idle' | 'listening' | 'thinking' | 'speaking')
// and an audio level/spectrum fed in from app.js.
const HUD = (() => {
  const canvas = document.getElementById('hud');
  const ctx = canvas.getContext('2d');
  const BARS = 120;

  const PALETTE = {
    idle:      { r: 62,  g: 230, b: 255, spin: 1.0 },
    listening: { r: 90,  g: 240, b: 255, spin: 1.4 },
    thinking:  { r: 255, g: 181, b: 71,  spin: 4.0 },
    speaking:  { r: 62,  g: 230, b: 255, spin: 1.8 },
  };

  let state = 'idle';
  let level = 0;           // smoothed 0..1
  let targetLevel = 0;
  let spectrum = new Float32Array(BARS);
  let color = { ...PALETTE.idle };
  let angle = 0;
  let bootStart = null;    // boot-up animation start time

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // Track the canvas box itself (window resize fires mid-transition when going fullscreen)
  new ResizeObserver(resize).observe(canvas);
  resize();

  const rgba = (a) => `rgba(${color.r | 0}, ${color.g | 0}, ${color.b | 0}, ${a})`;

  function ring(cx, cy, r, width, alpha) {
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(alpha);
    ctx.stroke();
  }

  function arcs(cx, cy, r, width, alpha, rot, segments) {
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(alpha);
    for (const [start, len] of segments) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, r), rot + start, rot + start + len);
      ctx.stroke();
    }
  }

  function ticks(cx, cy, r, count, len, alpha, rot, majorEvery = 0) {
    ctx.strokeStyle = rgba(alpha);
    for (let i = 0; i < count; i++) {
      const a = rot + (i / count) * Math.PI * 2;
      const major = majorEvery && i % majorEvery === 0;
      const l = major ? len * 2.2 : len;
      ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * (r - l), cy + Math.sin(a) * (r - l));
      ctx.stroke();
    }
  }

  function frame(t) {
    requestAnimationFrame(frame);
    try { draw(t); } catch (e) { console.error('HUD frame failed', e); }
  }

  function draw(t) {
    const { width: w, height: h } = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, w, h);

    // Ease toward the palette for the current state
    const p = PALETTE[state];
    for (const k of ['r', 'g', 'b', 'spin']) color[k] += (p[k] - color[k]) * 0.06;
    level += (targetLevel - level) * 0.25;
    bootStart ??= t;
    const boot = Math.min(1, (t - bootStart) / 1400);
    const ease = 1 - Math.pow(1 - boot, 3);

    angle += 0.002 * color.spin;
    const cx = w / 2, cy = h / 2 - 8;
    const R = Math.min(w, h) * 0.44 * ease;
    if (R < 20) return;

    // Outer scale
    ring(cx, cy, R, 1, 0.25);
    ticks(cx, cy, R - 3, 180, 4, 0.35, -angle * 0.3, 15);
    arcs(cx, cy, R + 6, 2, 0.6, angle * 0.5, [[0, 0.5], [Math.PI * 0.66, 0.25], [Math.PI * 1.3, 0.7]]);

    // Middle rotating dashed band
    arcs(cx, cy, R * 0.76, 6, 0.18, -angle * 1.3, Array.from({ length: 24 }, (_, i) => [i * (Math.PI / 12), Math.PI / 20]));
    arcs(cx, cy, R * 0.70, 1.5, 0.55, angle * 2, [[0, 1.1], [Math.PI, 1.1]]);

    // Spectrum bars
    const inner = R * 0.47;
    const barMax = R * 0.18;
    for (let i = 0; i < BARS; i++) {
      const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
      // idle shimmer when there's no audio
      const idle = 0.06 + 0.04 * Math.sin(t / 600 + i * 0.5);
      const v = Math.max(idle, spectrum[i]);
      const len = 2 + v * barMax;
      ctx.strokeStyle = rgba(0.35 + v * 0.65);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len));
      ctx.stroke();
    }
    ring(cx, cy, inner - 4, 1, 0.5);

    // Arc reactor segments
    const segIn = R * 0.26, segOut = R * 0.38;
    const segs = 10;
    for (let i = 0; i < segs; i++) {
      const a0 = angle * -0.8 + (i / segs) * Math.PI * 2 + 0.04;
      const a1 = a0 + (Math.PI * 2) / segs - 0.08;
      ctx.beginPath();
      ctx.arc(cx, cy, segOut, a0, a1);
      ctx.arc(cx, cy, segIn, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = rgba(0.10 + level * 0.25);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(0.7);
      ctx.stroke();
    }

    // Glowing core
    const pulse = state === 'thinking' ? 0.08 * Math.sin(t / 120) : 0.03 * Math.sin(t / 700);
    const coreR = R * (0.17 + level * 0.07 + pulse);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.25, rgba(0.9));
    g.addColorStop(0.5, rgba(0.25));
    g.addColorStop(1, rgba(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ring(cx, cy, coreR, 2, 0.9);

    // Crosshair readouts
    ctx.fillStyle = rgba(0.6);
    ctx.font = '9px "SF Mono", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(((angle * 180) / Math.PI) % 360).toString().padStart(3, '0')}°`, cx, cy - R - 14);
    ctx.textAlign = 'left';
    ctx.fillText(`LVL ${(level * 100).toFixed(0).padStart(3, '0')}`, cx + R + 12, cy + 3);
    ctx.textAlign = 'right';
    ctx.fillText(state.toUpperCase(), cx - R - 12, cy + 3);
  }
  requestAnimationFrame(frame);

  return {
    setState(s) { if (PALETTE[s]) state = s; },
    setLevel(v) { targetLevel = Math.max(0, Math.min(1, v)); },
    setSpectrum(arr) { spectrum = arr; },
    BARS,
  };
})();
