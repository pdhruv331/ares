// Neural HUD: a live, slowly rotating 3D "brain" of digital neurons. Signals travel along synapses
// and fire the neurons they reach, which can set off their neighbours, so activity spreads in
// cascades. How much it fires, where, and in what colour follows what ARES is doing.
// Same interface as the old reactor HUD (hud.js): setState, setLevel, setSpectrum, BARS.
// Around the brain: the voice halo (one wavy ring that breathes, listens, thinks and speaks) over a soft glow pedestal.
const HUD = (() => {
  const canvas = document.getElementById('hud');
  const ctx = canvas.getContext('2d');
  const BARS = 120;

  // fire: spontaneous firings per second · spread: chance a signal carries on to each next synapse
  const PALETTE = {
    idle:      { r: 62,  g: 230, b: 255, spin: 1.0, fire: 2.5, spread: 0.22, glow: 0.8,  region: null },
    listening: { r: 130, g: 240, b: 255, spin: 1.1, fire: 4,   spread: 0.32, glow: 1.0,  region: 'temporal' },
    thinking:  { r: 167, g: 139, b: 250, spin: 2.4, fire: 26,  spread: 0.6,  glow: 1.2,  region: null }, // violet: amber means "needs you"
    speaking:  { r: 80,  g: 235, b: 255, spin: 1.4, fire: 7,   spread: 0.42, glow: 1.05, region: 'speech' },
  };

  let state = 'idle';
  let level = 0;
  let targetLevel = 0;
  let spectrum = new Float32Array(BARS);
  const color = { ...PALETTE.idle };
  let angle = 0;
  let bootStart = null;
  let last = 0;
  let use3D = false;        // brain3d.mjs renders the real brain; this file then only draws the rings
  let offline = false;      // no brain: the reactor look shows amber

  // ---- Build the brain (seeded, so it's the same shape every launch) ---------------------
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  const nodes = []; // { p: [x,y,z], region, glow, edges: [] }
  function pointIn(c, r, surface) {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const d = [s * Math.cos(th), u, s * Math.sin(th)];
    const depth = surface ? 0.84 + 0.16 * Math.sqrt(rand()) : Math.cbrt(rand()) * 0.8;
    const fold = 1 + 0.07 * Math.sin(d[0] * 9 + d[2] * 7) * Math.sin(d[1] * 8 + d[2] * 5); // cortical folds
    return [c[0] + d[0] * r[0] * depth * fold, c[1] + d[1] * r[1] * depth * fold, c[2] + d[2] * r[2] * depth * fold];
  }
  function regionOf([x, y, z], part) {
    if (part !== 'cortex') return part;
    if (Math.abs(x) > 0.3 && y < 0.05 && z > -0.3 && z < 0.35) return 'temporal'; // hearing
    if (x > 0 && z > 0.2 && y < 0.25) return 'speech';                             // front-left: speech
    if (z < -0.42) return 'occipital';
    return 'cortex';
  }
  const add = (p, part) => nodes.push({ p, region: regionOf(p, part), glow: 0, edges: [] });

  for (const side of [-1, 1]) {
    let n = 0;
    while (n < 230) {
      const surface = n < 200;
      const p = pointIn([side * 0.25, 0.06, 0], [0.33, 0.46, 0.66], surface);
      if (side * p[0] < 0.035) continue; // the gap between the hemispheres
      if (p[1] < -0.3 && p[2] < -0.25) continue; // leave room for the cerebellum
      add(p, 'cortex');
      n++;
    }
  }
  for (let i = 0; i < 60; i++) add(pointIn([0, -0.36, -0.44], [0.34, 0.16, 0.2], true), 'cerebellum');
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    add([(rand() - 0.5) * 0.06, -0.26 - t * 0.44, -0.18 - t * 0.08 + (rand() - 0.5) * 0.05], 'stem');
  }

  // Synapses: each neuron links to its nearest neighbours, plus long "white matter" links across
  const edges = []; // { a, b, len }
  const seen = new Set();
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function link(a, b) {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    const e = edges.push({ a, b, len: dist(nodes[a].p, nodes[b].p) }) - 1;
    nodes[a].edges.push(e);
    nodes[b].edges.push(e);
  }
  nodes.forEach((n, i) => {
    const near = nodes.map((m, j) => [j, dist(n.p, m.p)]).filter(([j, d]) => j !== i && d < 0.2).sort((x, y) => x[1] - y[1]);
    for (const [j] of near.slice(0, 3)) link(i, j);
  });
  const cortex = nodes.map((n, i) => [n, i]).filter(([n]) => n.region !== 'cerebellum' && n.region !== 'stem' && n.p[1] > 0);
  for (let k = 0; k < 28; k++) { // corpus callosum
    const l = cortex.filter(([n]) => n.p[0] < -0.1);
    const r = cortex.filter(([n]) => n.p[0] > 0.1);
    link(l[Math.floor(rand() * l.length)][1], r[Math.floor(rand() * r.length)][1]);
  }
  const byRegion = {};
  nodes.forEach((n, i) => (byRegion[n.region] ??= []).push(i));

  // ---- Signals ---------------------------------------------------------------------------------
  const pulses = []; // { e, from, t, strength }
  const MAX_PULSES = 420;
  function fire(i, strength) {
    const n = nodes[i];
    n.glow = Math.min(1.6, n.glow + strength);
    for (const e of n.edges) {
      if (pulses.length >= MAX_PULSES) break;
      if (rand() < 0.55 * strength) pulses.push({ e, from: i, t: 0, strength: strength * 0.9 });
    }
  }
  function pickNode() {
    const region = PALETTE[state].region;
    const pool = region && rand() < 0.65 ? byRegion[region] : null;
    return pool ? pool[Math.floor(rand() * pool.length)] : Math.floor(rand() * nodes.length);
  }

  function simulate(dt, t) {
    const p = PALETTE[state];
    const audioDriven = state === 'listening' || state === 'speaking';
    const rate = p.fire * (audioDriven ? 0.4 + level * 3 : 1);
    let spontaneous = rate * dt;
    while (spontaneous > 0) {
      if (rand() < Math.min(1, spontaneous)) fire(pickNode(), audioDriven ? 0.6 + level : 0.9);
      spontaneous -= 1;
    }
    for (let k = pulses.length - 1; k >= 0; k--) {
      const s = pulses[k];
      const e = edges[s.e];
      s.t += (dt * 1.1) / Math.max(0.05, e.len);
      if (s.t < 1) continue;
      pulses.splice(k, 1);
      const to = s.from === e.a ? e.b : e.a;
      nodes[to].glow = Math.min(1.6, nodes[to].glow + s.strength * 0.7);
      // Carry on through the next synapses (this is what makes activity cascade)
      for (const next of nodes[to].edges) {
        if (next === s.e || pulses.length >= MAX_PULSES) continue;
        if (rand() < p.spread * s.strength) pulses.push({ e: next, from: to, t: 0, strength: s.strength * 0.86 });
      }
    }
    const decay = Math.exp(-dt * 3.2);
    for (const n of nodes) n.glow *= decay;
  }

  // ---- Drawing ---------------------------------------------------------------------------------
  function resize() {
    const dpr = sceneDpr(3);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);
  addEventListener('scene-quality', resize);
  resize();

  const rgba = (a, c = color) => `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${a})`;

  // Pre-rendered glow sprite, recoloured when the state colour changes
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  let spriteKey = '';
  function refreshSprite() {
    const key = `${color.r | 0},${color.g | 0},${color.b | 0}`;
    if (key === spriteKey) return;
    spriteKey = key;
    const s = sprite.getContext('2d');
    s.clearRect(0, 0, 64, 64);
    const g = s.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, rgba(0.9));
    g.addColorStop(0.5, rgba(0.25));
    g.addColorStop(1, rgba(0));
    s.fillStyle = g;
    s.fillRect(0, 0, 64, 64);
  }
  const blob = (x, y, size, alpha) => {
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  };

  // ---- The voice halo (R2: one ring) and the glow pedestal (R4) ---------------------------------------------
  const TAU = Math.PI * 2;
  const AMBER = { r: 255, g: 181, b: 71 };
  const RING_POINTS = 144;
  const halo = {
    energy: 0,                    // wake pulse / "sucked into the brain" spike; decays
    attention: 0, attTarget: 0,   // amber while a job or call needs a yes
    hover: 0, hoverTarget: 0,     // an orb carried near the brain
    comet: -Math.PI / 2, cometOn: 0,
  };
  const hc = { r: 62, g: 230, b: 255 }; // the halo's own colour (state colour, tinted amber when needed)

  function ringPath(cx, cy, base, t, amp, voice) {
    const speed = 0.35;
    ctx.beginPath();
    for (let k = 0; k <= RING_POINTS; k++) {
      const a = (k / RING_POINTS) * TAU;
      const wave = Math.sin(a * 3 + t * speed) * 0.6 + Math.sin(a * 5 - t * speed * 1.3) * 0.4;
      const shimmer = Math.sin(a * 23 + t * 2.7) * 0.35;
      const sp = voice ? spectrum[Math.floor((k / RING_POINTS) * BARS) % BARS] || 0 : 0;
      const r = base + wave * amp + shimmer + sp * voice;
      const x = cx + Math.cos(a - Math.PI / 2) * r, y = cy + Math.sin(a - Math.PI / 2) * r;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
  }

  function drawHalo(cx, cy, R, dt, t) {
    const s = t / 1000;
    const H = halo;
    H.energy *= Math.exp(-dt * 3);
    H.attention += (H.attTarget - H.attention) * Math.min(1, dt * 2.5);
    H.hover += (H.hoverTarget - H.hover) * Math.min(1, dt * 6);
    H.cometOn += ((state === 'thinking' ? 1 : 0) - H.cometOn) * Math.min(1, dt * 3);
    const mix = H.attention * 0.65;
    for (const k of ['r', 'g', 'b']) hc[k] = color[k] + (AMBER[k] - color[k]) * mix;
    const col = (a, c = hc) => `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${Math.max(0, Math.min(1, a))})`;

    const listeningNow = state === 'listening', speakingNow = state === 'speaking';
    const voiced = listeningNow || speakingNow ? level : 0;
    const bright = (listeningNow ? 1.25 : 1) * (1 + H.energy * 1.4 + H.hover * 0.6 + voiced * 0.5);
    const base = R * 0.9 * (1 + 0.012 * Math.sin(s * 0.9)) + H.energy * 7;   // idle breathing
    const amp = 1.4 + voiced * 9;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    // The one halo ring: it breathes, wiggles with her real voice, and glows
    const voice = voiced ? R * 0.07 * (speakingNow ? 1 : -0.6) : 0;
    ringPath(cx, cy, base, s, amp, voice);
    ctx.lineWidth = 7; ctx.strokeStyle = col(0.05 * bright); ctx.stroke();
    ctx.lineWidth = 3.5; ctx.strokeStyle = col(0.1 * bright); ctx.stroke();
    ctx.lineWidth = 1.4; ctx.strokeStyle = col(0.8 * Math.min(1.6, bright)); ctx.stroke();

    // Thinking: a bright comet with a fading tail races around the ring
    if (H.cometOn > 0.02) {
      H.comet += dt * 2.8;
      const TAIL = 28;
      ctx.lineCap = 'round';
      for (let i = 0; i < TAIL; i++) {
        const a0 = H.comet - (i + 1) * 0.045, a1 = H.comet - i * 0.045;
        ctx.lineWidth = 3 * (1 - i / TAIL) + 0.5;
        ctx.strokeStyle = col(H.cometOn * 0.9 * Math.pow(1 - i / TAIL, 1.6));
        ctx.beginPath(); ctx.arc(cx, cy, base, a0, a1); ctx.stroke();
      }
      refreshSprite();
      const hx = cx + Math.cos(H.comet) * base, hy = cy + Math.sin(H.comet) * base;
      blob(hx, hy, 26, H.cometOn);
      ctx.globalAlpha = H.cometOn;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hx, hy, 1.8, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function drawPedestal(cx, cy, R, t) {
    const px = cx, py = cy + R * 0.93;
    const rx = R * 0.62, ry = R * 0.1;
    const speak = state === 'speaking' ? level : 0;
    const b = (1 + speak * 1.4 + halo.energy * 0.6) * (0.9 + 0.1 * Math.sin(t / 1400));
    const col = (a) => `rgba(${hc.r | 0}, ${hc.g | 0}, ${hc.b | 0}, ${Math.max(0, Math.min(1, a))})`;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(px, py);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, col(0.2 * b));
    g.addColorStop(0.55, col(0.07 * b));
    g.addColorStop(1, col(0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill();
    ctx.restore();
  }

  let geometry = { cx: 0, cy: 0, R: 0 };
  function draw(t) {
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    const { width: w, height: h } = canvas.getBoundingClientRect();
    const p = PALETTE[state];
    for (const k of ['r', 'g', 'b', 'spin', 'glow']) color[k] += (p[k] - color[k]) * 0.05;
    level += (targetLevel - level) * 0.25;
    if (window.SCENE_LOOK === 'reactor') { // the reactor look (scene.js) draws this canvas; the halo's values still tick
      const H = halo;
      H.energy *= Math.exp(-dt * 3);
      H.attention += (H.attTarget - H.attention) * Math.min(1, dt * 2.5);
      H.hover += (H.hoverTarget - H.hover) * Math.min(1, dt * 6);
      return;
    }
    ctx.clearRect(0, 0, w, h);
    bootStart ??= t;
    const boot = Math.min(1, (t - bootStart) / 1600);
    const ease = 1 - Math.pow(1 - boot, 3);
    angle += dt * 0.16 * color.spin;
    const cx = w / 2;
    const cy = h / 2 - 8;
    const R = Math.min(w, h) * 0.44 * ease;
    geometry = { cx, cy, R: Math.min(w, h) * 0.44 };
    if (R < 20) return;
    drawPedestal(cx, cy, R, t);
    drawHalo(cx, cy, R, dt, t);
    if (use3D) return;
    refreshSprite();
    simulate(dt, t);

    // Project the rotating brain
    const S = R * 0.96;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const tilt = -0.3 + 0.06 * Math.sin(t / 4000);
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const breathe = 0.88 + 0.12 * Math.sin(t / 1300);
    const proj = nodes.map(({ p: [x, y, z] }) => {
      const x1 = x * cosA + z * sinA;
      const z1 = -x * sinA + z * cosA;
      const y1 = y * cosT - z1 * sinT;
      const z2 = y * sinT + z1 * cosT;
      const f = 3.2 / (3.2 - z2);
      return { x: cx + x1 * S * f, y: cy - y1 * S * f, depth: Math.max(0.15, Math.min(1, (z2 + 0.85) / 1.7)) };
    });

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Soft core glow (stronger while thinking)
    const coreA = (state === 'thinking' ? 0.22 : 0.1) * breathe * color.glow;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 1.1);
    g.addColorStop(0, rgba(coreA));
    g.addColorStop(1, rgba(0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - S * 1.2, cy - S * 1.2, S * 2.4, S * 2.4);

    // Synapses, batched by depth so the back of the brain recedes
    ctx.lineWidth = 0.6;
    for (let bucket = 0; bucket < 4; bucket++) {
      ctx.beginPath();
      for (const e of edges) {
        const a = proj[e.a], b = proj[e.b];
        const d = (a.depth + b.depth) / 2;
        if (Math.min(3, Math.floor(d * 4)) !== bucket) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.strokeStyle = rgba((0.05 + bucket * 0.04) * breathe * color.glow);
      ctx.stroke();
    }

    // Neurons
    ctx.fillStyle = rgba(1);
    for (let i = 0; i < nodes.length; i++) {
      const q = proj[i];
      const n = nodes[i];
      const base = 0.35 + 0.6 * q.depth;
      ctx.globalAlpha = Math.min(1, base * breathe * 0.8 + n.glow * 0.6);
      const r = (0.7 + q.depth * 1.1) * (1 + n.glow * 0.8);
      ctx.fillRect(q.x - r / 2, q.y - r / 2, r, r);
      if (n.glow > 0.08) blob(q.x, q.y, 6 + n.glow * 20 * q.depth, n.glow * 0.9 * color.glow);
    }

    // Signals in flight: a bright head with a short trail along the synapse
    ctx.lineWidth = 1.2;
    for (const s of pulses) {
      const e = edges[s.e];
      const [A, B] = s.from === e.a ? [proj[e.a], proj[e.b]] : [proj[e.b], proj[e.a]];
      const hx = A.x + (B.x - A.x) * s.t, hy = A.y + (B.y - A.y) * s.t;
      const tt = Math.max(0, s.t - 0.35);
      const d = (A.depth + B.depth) / 2;
      ctx.globalAlpha = Math.min(1, 0.55 * s.strength * d * color.glow);
      ctx.strokeStyle = rgba(1);
      ctx.beginPath();
      ctx.moveTo(A.x + (B.x - A.x) * tt, A.y + (B.y - A.y) * tt);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      blob(hx, hy, 5 + 7 * s.strength * d, 0.8 * s.strength);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  const gate = Perf.gate();
  function frame(t) {
    requestAnimationFrame(frame);
    if (!gate(t) || window.SCENE_HIDE_BRAIN) return;
    try { draw(t); } catch (e) { console.error('HUD frame failed', e); }
  }
  requestAnimationFrame(frame);

  return {
    setState(s) {
      if (!PALETTE[s]) return;
      if (s === 'thinking' && state !== 'thinking') for (let i = 0; i < 6; i++) fire(pickNode(), 1); // spark of thought
      state = s;
    },
    setLevel(v) { targetLevel = Math.max(0, Math.min(1, v)); },
    // For the 3D brain (brain3d.mjs): an orb carried close, or a wake/absorb pulse, brightens it
    live: () => ({ state, level, color: { ...color, glow: color.glow * (1 + halo.hover * 0.9 + halo.energy * 0.8) },
      pulse: halo.energy, attention: halo.attention, hover: halo.hover, offline, spectrum }),
    /** No brain (Claude Code missing or signed out): the reactor runs amber. */
    offline(on) { offline = Boolean(on); },
    get isOffline() { return offline; },
    /** A short bright pulse (wake word). `strength` 1.6 = something was just sucked into the brain. */
    pulse(strength = 1) {
      halo.energy = Math.max(halo.energy, strength);
    },
    /** Amber tint while a job or call is waiting for the user's yes. */
    attention(on) { halo.attTarget = on ? 1 : 0; },
    /** 0..1: how close a carried orb is to the brain. */
    hover(v) { halo.hoverTarget = Math.max(0, Math.min(1, v)); },
    /** Where the brain is, in the stage's coordinates. */
    geometry: () => geometry,
    stats: () => {},
    enable3D: () => { use3D = true; },
    setSpectrum(arr) { spectrum = arr; },
    BARS,
  };
})();
