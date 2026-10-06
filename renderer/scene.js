// The scene on every surface (docs/reactor-prompt.md): the reactor look (renderer/reactor.js) in the #hud canvas, the dot-matrix
// schematic in the full-bleed #matrix canvas, the job orbs in orbit, and the four readout callouts. The brain look stays
// available: stars.js, neural.js and brain3d.mjs keep drawing when window.SCENE_LOOK is 'brain' and hold off otherwise.
//
// Drives from the same inputs the brain used: HUD (neural.js) holds her state, voice level, wake pulse and the amber
// "needs you" tint, and every page already tells it those. window.JobOrbs is the one orbs API (sync / hits / pick /
// launch / park / land / screenPos); it forwards to this file's orbs in the reactor look and to brain3d's in the brain
// look. Clicks on orbs raise 'orb-open' (work.js), an orb thrown into the reactor raises 'orb-absorbed'. Callout labels
// are drawn here (the wallpaper shows them too); their hover, cards and actions live in callouts.js (the window only).
const Scene = (() => {
  const hud = document.getElementById('hud');
  const matrix = document.getElementById('matrix'); // the sheet's moving parts (sweep, ripples), at 1×
  const sheet = document.getElementById('sheet');   // the sheet itself (dots, schematic), drawn once per colour/geometry
  const core = hud?.parentElement;
  if (!hud || !core) return null;
  const ctx = hud.getContext('2d');
  const mctx = matrix?.getContext('2d');
  const sctx = sheet?.getContext('2d');
  const { Engine, Backdrop, COLORS, rgba, mix, glow, TAU, clamp } = Reactor;
  const root = document.documentElement;
  const reduceMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');

  // ---- The look ----------------------------------------------------------------------------------------------------------
  let look = window.SCENE_LOOK === 'brain' ? 'brain' : 'reactor';
  const applyLook = () => {
    window.SCENE_LOOK = look;
    root.classList.toggle('look-reactor', look === 'reactor');
    root.classList.toggle('look-brain', look === 'brain');
  };
  applyLook();
  const isReactor = () => look === 'reactor';

  // ---- Geometry ----------------------------------------------------------------------------------------------------------
  // The reactor: radius ≈ 26% of the stage height (22% of its width in a narrow window), centred a little below the middle.
  // The #hud canvas moves with .core (dash.js shifts it clear of desktop icons and wide columns; COMMS lifts it), so what's
  // drawn here is in canvas coordinates, and screen positions go through the canvas's on-screen rectangle.
  let w = 0, h = 0;
  let bootStart = null;
  let boot = 0;
  const radiusFor = (W, H) => Math.min(H * 0.26, W * 0.22);
  // A geometry override (canvas px): the lock-screen still, the ignition helper and the live window place the reactor identically
  // (docs/ignition-prompt.md); set from the page's query or by Scene.setGeometry(). Nothing else changes where it draws.
  let geometryOverride = window.SCENE_GEOMETRY || null;
  function geometry() {
    if (geometryOverride) return { w, h, cx: geometryOverride.cx, cy: geometryOverride.cy, r: geometryOverride.r * boot };
    return { w, h, cx: w / 2, cy: h / 2 + h * 0.03, r: radiusFor(w, h) * boot };
  }
  // A cold start (?power=cold): the reactor begins as the offline still, full size and gold, and the charge-to-wake brightens it
  const pageQuery = new URLSearchParams(location.search);
  const coldStart = pageQuery.get('power') === 'cold' || window.SCENE_POWER === 'cold';
  let rect = { left: 0, top: 0, width: 1, height: 1 };
  const scaleOf = () => (w ? rect.width / w : 1);
  const toClient = (x, y) => ({ x: rect.left + x * scaleOf(), y: rect.top + y * scaleOf() });
  const fromClient = (x, y) => ({ x: (x - rect.left) / scaleOf(), y: (y - rect.top) / scaleOf() });
  let sizeKey = '';
  function resize() { // (only reallocates the canvases when a size or the pixel ratio changed: that's expensive)
    const dpr = sceneDpr();
    rect = hud.getBoundingClientRect();
    w = hud.clientWidth; h = hud.clientHeight;
    const mw = matrix?.clientWidth || 0, mh = matrix?.clientHeight || 0;
    const key = `${w}x${h}@${dpr}|${mw}x${mh}`;
    if (key === sizeKey) return;
    sizeKey = key;
    hud.width = Math.round(w * dpr); hud.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (matrix) {
      const sdpr = Math.min(dpr, 2);
      matrix.width = Math.round(mw); matrix.height = Math.round(mh);
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      if (sheet) { sheet.width = Math.round(mw * sdpr); sheet.height = Math.round(mh * sdpr); sctx.setTransform(sdpr, 0, 0, sdpr, 0, 0); }
      backdrop.resize(mw, mh, sdpr, 1);
      lastBack = 0;
    }
  }

  const engine = new Engine();
  const backdrop = new Backdrop();
  // Ignition / standby / power down (renderer/ignite.js): drives the engine's cold / hue / pace, paints the extras, takes the holds
  const power = window.Ignite ? new Ignite.Controller(engine, { replica: Boolean(window.SCENE_REPLICA) }) : null;
  if (power && coldStart) power.set('offline');
  else if (power && window.SCENE_POWER === 'standby') power.set('standby', { force: true });
  let readouts = null;     // { jobs: {value, amber}, host, claude, battery } (callouts.js / the wallpaper bridge)
  let columns = null;      // the panel columns' inner edges (stage px) the callouts keep clear of
  let openCallout = null;  // the callout whose card is open
  let hoverCallout = null;
  let centreOverride = null; // the backdrop centred on another window's reactor (the wallpaper under the live desktop)

  // ---- Job orbs ------------------------------------------------------------------------------------------------------------
  // One orb per job on a faint dotted orbit just outside the reactor (slightly elliptical), drifting round (faster while
  // she's busy), labelled on the outward side with the job's name and its % (or NEEDS YOU), a thin progress ring around it.
  // Same data and interactions as the brain's orbs: click for details, grab → throw with the panels' physics, throw into
  // the reactor to put a finished job away (or cancel a running one), project orbs larger.
  const ORB_COLOR = { queued: 'cyan', running: 'cyan', approval: 'amber', done: 'green', failed: 'red', paused: 'grey' };
  const ORB_SIZE = { small: 0.028, medium: 0.034, large: 0.04, project: 0.05 }; // of r
  const ORB_LABEL = { queued: 'QUEUED', paused: 'PAUSED', done: 'DONE', failed: 'FAILED', approval: 'NEEDS YOU' };
  const PHYS = { throw: 0.55, maxSpeed: 9, friction: 0.965, bounce: 0.6, unfold: 0.35, catch: 58 }; // catch: at least this, or the core (0.5 r)
  const catchR = () => Math.max(PHYS.catch, geometry().r * 0.5);
  const EST = { small: 4, medium: 10, large: 25 };
  const FINISHED = ['done', 'failed'];
  const SHOW_DAYS = 3;
  const orbs = new Map();
  let orbSpin = 0;
  let lastJobs = [];
  let runningJobs = 0;
  let reduceMotion = false;
  const ease = { out: (k) => 1 - Math.pow(1 - k, 3), inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2), in: (k) => k * k * k };
  const idSeed = (s) => { let x = 2166136261; for (const ch of String(s)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return (x >>> 0) % 2147483646 + 1; };
  const jobPct = (j) => {
    if (j.progress?.total) return Math.round((j.progress.done / j.progress.total) * 100);
    if (!j.started) return 0;
    const mins = (Date.now() - j.started) / 60_000;
    return Math.min(92, Math.round(100 * (1 - Math.exp(-mins / (EST[j.size] || 10)))));
  };
  const orbRadius = (orb, g) => Math.max(4, g.r * (ORB_SIZE[orb.job.project ? 'project' : orb.job.size] || ORB_SIZE.medium)) * orb.shrink * (1 + orb.flare * 0.5);
  function orbitPoint(angle, g, out = {}) { out.x = g.cx + Math.cos(angle) * g.r * 1.28; out.y = g.cy + Math.sin(angle) * g.r * 1.16; return out; }
  function makeOrb(job) {
    const seed = idSeed(job.id);
    const orb = { id: job.id, job, angle: (seed % 360) * TAU / 360, target: 0, x: 0, y: 0, vx: 0, vy: 0,
      mode: 'orbit', t: 0, dur: 1, from: null, to: null, done: null, alpha: 0, show: 1, flare: 0, shrink: 1, fade: 1, fadeTo: 1, pulse: seed % 97 / 97 };
    orbs.set(job.id, orb);
    return orb;
  }
  function move(orb, mode, to, dur) {
    orb.done?.();
    orb.mode = mode; orb.t = 0; orb.dur = dur;
    orb.from = { x: orb.x, y: orb.y };
    orb.to = to || null;
    return new Promise((res) => { orb.done = () => { orb.done = null; res(); }; });
  }
  function dropOrb(orb) { orbs.delete(orb.id); orb.done?.(); }
  const orbColor = (orb) => (orb.job.status === 'running' || orb.job.status === 'queued' ? engine.hue : COLORS[ORB_COLOR[orb.job.status]] || engine.hue);
  const label = (j) => {
    const name = String(j.title || j.id).toUpperCase().replace(/\s+/g, ' ');
    const short = name.length > 22 ? `${name.slice(0, 21)}…` : name;
    const tail = ORB_LABEL[j.status] || `${jobPct(j)}%`;
    return `${short} · ${tail}`;
  };
  function screenOf(orb) {
    const g = geometry();
    const p = toClient(orb.x, orb.y);
    return { x: p.x, y: p.y, r: orbRadius(orb, g) * scaleOf() };
  }

  const held = { orb: null, samples: [], moved: false, start: null };
  let hint = null;
  function updateOrbs(dt, t) {
    const g = geometry();
    const busy = engine.energy > 0.2 || runningJobs > 0;
    orbSpin += dt * (0.09 + (busy ? 0.14 : 0)) * (reduceMotion ? 0 : 1);
    const list = [...orbs.values()].filter((o) => o.mode !== 'absorbing');
    list.forEach((o, i) => { o.target = i * TAU / Math.max(1, list.length) + orbSpin + (idSeed(o.id) % 100) / 100 * 0.25; });
    for (const orb of [...orbs.values()]) {
      const st = orb.job.status;
      let d = ((orb.target - orb.angle) % TAU + TAU) % TAU; if (d > Math.PI) d -= TAU;
      orb.angle += d * Math.min(1, dt * 1.6);
      const home = orbitPoint(orb.angle, g);
      orb.flare *= Math.exp(-dt * 4);
      orb.fade += (orb.fadeTo - orb.fade) * Math.min(1, dt / 0.15);
      if (orb.mode === 'orbit') { orb.x = home.x; orb.y = home.y; }
      else if (orb.mode === 'held') { /* follows the pointer */ }
      else if (orb.mode === 'thrown') {
        const f = dt * 60;
        orb.x += orb.vx * f; orb.y += orb.vy * f;
        orb.vx *= Math.pow(PHYS.friction, f); orb.vy *= Math.pow(PHYS.friction, f);
        const R = orbRadius(orb, g);
        if (orb.x < R) { orb.x = R; orb.vx = Math.abs(orb.vx) * PHYS.bounce; }
        if (orb.x > w - R) { orb.x = w - R; orb.vx = -Math.abs(orb.vx) * PHYS.bounce; }
        if (orb.y < R) { orb.y = R; orb.vy = Math.abs(orb.vy) * PHYS.bounce; }
        if (orb.y > h - R) { orb.y = h - R; orb.vy = -Math.abs(orb.vy) * PHYS.bounce; }
        if (Math.hypot(orb.x - g.cx, orb.y - g.cy) < catchR()) { absorb(orb); continue; }
        if (Math.hypot(orb.vx, orb.vy) < PHYS.unfold) move(orb, 'returning', null, 0.9);
      } else {
        orb.t = Math.min(1, orb.t + dt / orb.dur);
        const k = orb.t;
        if (orb.mode === 'launching') { orb.flare = 1.2 * ease.out(k); }
        else if (orb.mode === 'returning') { orb.x = orb.from.x + (home.x - orb.from.x) * ease.inOut(k); orb.y = orb.from.y + (home.y - orb.from.y) * ease.inOut(k); }
        else if (orb.mode === 'sinking' || orb.mode === 'absorbing') {
          const a0 = orb.a0, r0 = orb.r0;
          const rr = r0 * (1 - k * k), ang = a0 + k * 5;
          orb.x = g.cx + Math.cos(ang) * rr; orb.y = g.cy + Math.sin(ang) * rr;
          orb.shrink = 1 - k * 0.85; orb.show = 1 - ease.in(k) * 0.6;
        } else if (orb.mode === 'fading') orb.show = 1 - k;
        if (k >= 1) {
          if (orb.mode === 'launching') { orb.mode = 'parked'; orb.done?.(); }
          else if (orb.mode === 'returning') { orb.mode = 'orbit'; orb.done?.(); }
          else if (orb.mode === 'sinking' || orb.mode === 'fading') { dropOrb(orb); continue; }
          else if (orb.mode === 'absorbing') {
            engine.flash = 1; engine.burst(10, 1.3);
            HUD.pulse?.(1.7);
            const id = orb.id, status = orb.job.status;
            dropOrb(orb);
            window.dispatchEvent(new CustomEvent('orb-absorbed', { detail: { id, status } }));
            continue;
          }
        }
      }
      const wantAlpha = orb.mode === 'parked' ? 0 : 1; // hidden behind the Work panel once it's open
      orb.alpha += (wantAlpha - orb.alpha) * Math.min(1, dt * (wantAlpha ? 2.5 : 6));
      orb.beat = st === 'running' ? 0.72 + 0.28 * Math.sin(t * TAU / 1.8 + orb.pulse * 6)
        : st === 'approval' ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * TAU / 0.9))
        : st === 'done' ? 0.82 + 0.12 * Math.sin(t * TAU / 3.4) : st === 'queued' ? 0.5 : 0.45;
    }
  }
  function absorb(orb) {
    const g = geometry();
    orb.mode = 'absorbing'; orb.t = 0; orb.dur = 0.45;
    orb.a0 = Math.atan2(orb.y - g.cy, orb.x - g.cx); orb.r0 = Math.hypot(orb.x - g.cx, orb.y - g.cy);
    orb.done?.(); orb.done = null;
    if (hint) hint.hidden = true;
    HUD.hover?.(0);
  }
  function drawOrbit(g) {
    if (!orbs.size) return;
    ctx.save();
    ctx.setLineDash([1, 7]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(engine.hue, 0.22);
    ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.r * 1.28, g.r * 1.16, 0, 0, TAU); ctx.stroke();
    ctx.restore();
  }
  function drawOrb(orb, g) {
    const a = orb.alpha * orb.show * orb.fade * (power ? power.fade : 1);
    if (a <= 0.01) return;
    const c = orbColor(orb), R = orbRadius(orb, g), beat = orb.beat ?? 0.6;
    ctx.save();
    glow(ctx, c, orb.x, orb.y, R * 3.2 * (1 + orb.flare), a * (0.35 + 0.5 * beat + orb.flare * 0.6));
    ctx.globalAlpha = a;
    const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, R);
    grad.addColorStop(0, rgba(COLORS.white, 1));
    grad.addColorStop(0.5, rgba(mix(c, COLORS.white, 0.3), 1));
    grad.addColorStop(1, rgba(c, 0.85));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(orb.x, orb.y, R, 0, TAU); ctx.fill();
    // A thin progress ring, filling with the job's progress (full for a finished one)
    const j = orb.job;
    const pct = FINISHED.includes(j.status) ? 100 : j.status === 'approval' ? jobPct(j) : jobPct(j);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(c, 0.25); ctx.beginPath(); ctx.arc(orb.x, orb.y, R + 4, 0, TAU); ctx.stroke();
    if (pct > 0) { ctx.strokeStyle = rgba(c, 0.5 + beat * 0.5); ctx.beginPath(); ctx.arc(orb.x, orb.y, R + 4, -Math.PI / 2, -Math.PI / 2 + TAU * pct / 100); ctx.stroke(); }
    // The label, on the outward side
    if (orb.mode !== 'parked' && orb.mode !== 'launching' && !document.body.classList.contains('work-open')) {
      const dx = orb.x - g.cx, dy = orb.y - g.cy, d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const lx = orb.x + ux * (R + 10), ly = orb.y + uy * (R + 10);
      ctx.font = `${j.project ? 10 : 9}px "SF Mono", ui-monospace, Menlo, monospace`;
      ctx.letterSpacing = '0.12em';
      ctx.textAlign = ux > 0.25 ? 'left' : ux < -0.25 ? 'right' : 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(j.status === 'paused' ? COLORS.grey : c, j.status === 'done' || j.status === 'failed' ? 0.7 : 0.95);
      ctx.shadowColor = rgba(c, 0.6); ctx.shadowBlur = 8;
      const text = label(j);
      ctx.fillText(text, lx, ly + (ctx.textAlign === 'center' ? uy * 8 : 0));
      orb.labelBox = { x: ctx.textAlign === 'left' ? lx : ctx.textAlign === 'right' ? lx - ctx.measureText(text).width : lx - ctx.measureText(text).width / 2,
        y: ly - 7 + (ctx.textAlign === 'center' ? uy * 8 : 0), w: ctx.measureText(text).width, h: 14 };
    } else orb.labelBox = null;
    ctx.restore();
  }

  // ---- Callouts: anchor on the first schematic ring → a short diagonal → a horizontal tick → label and value -----------------
  const CALLOUTS = [
    { id: 'jobs', angle: -118 }, { id: 'host', angle: -62 },
    { id: 'claude', angle: 142 }, { id: 'battery', angle: 38 },
  ];
  const TICK = 40;
  const calloutGeo = new Map(); // id -> { ax, ay, ex, ey, tx, align, box, bottom }
  const calloutFade = new Map(); // id -> { v, to }
  let bottomDim = 1;
  function layoutCallouts(g) {
    calloutGeo.clear();
    if (!readouts || g.r < 30 || (power && power.mode !== 'online')) return; // (standby and every transition: callouts hidden)
    const s = scaleOf();
    for (const c of CALLOUTS) {
      let deg = c.angle;
      const right = Math.cos(deg * Reactor.RAD) > 0;
      const bottom = Math.sin(deg * Reactor.RAD) > 0;
      const d = readouts[c.id] || {};
      ctx.font = '8.5px "SF Mono", ui-monospace, Menlo, monospace'; ctx.letterSpacing = '0.12em';
      const tw = Math.max(ctx.measureText(String(d.value || '—')).width, ctx.measureText(c.id.toUpperCase()).width) + 10;
      let geo;
      for (let k = 0; k < 7; k++) { // pull toward vertical, a little at a time, while the text would sit on a panel column
        const a = deg * Reactor.RAD;
        const ax = g.cx + Math.cos(a) * g.r * 1.14, ay = g.cy + Math.sin(a) * g.r * 1.14;
        const ex = g.cx + Math.cos(a) * g.r * 1.9, ey = g.cy + Math.sin(a) * g.r * 1.9;
        const tx = ex + (right ? TICK : -TICK);
        const bx = right ? ex + 2 : ex - Math.max(TICK, tw) + 2;
        const box = { x: bx - 4, y: ey - 15, w: Math.max(TICK, tw) + 8, h: 30 };
        geo = { ax, ay, ex, ey, tx, right, bottom, box, align: right ? 'left' : 'right' };
        if (!columns) break;
        const sx0 = rect.left + box.x * s, sx1 = sx0 + box.w * s;
        const crosses = (right && sx1 > columns.right) || (!right && sx0 < columns.left);
        if (!crosses) break;
        deg += (bottom ? 1 : -1) * (right ? 1 : -1) * 4; // toward the vertical axis
      }
      calloutGeo.set(c.id, geo);
    }
  }
  function drawCallouts(g, dt) {
    if (!calloutGeo.size) return;
    bottomDim += (((engine.state === 'speaking' && !openCallout) ? 0.15 : 1) - bottomDim) * Math.min(1, dt * 6);
    ctx.save();
    ctx.font = '8.5px "SF Mono", ui-monospace, Menlo, monospace';
    ctx.letterSpacing = '0.14em';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'alphabetic';
    for (const c of CALLOUTS) {
      const geo = calloutGeo.get(c.id);
      if (!geo) continue;
      const d = readouts[c.id] || {};
      const f = calloutFade.get(c.id) || { v: 1, to: 1 };
      f.v += (f.to - f.v) * Math.min(1, dt / 0.15);
      calloutFade.set(c.id, f);
      const hot = hoverCallout === c.id || openCallout === c.id;
      const col = d.amber ? COLORS.amber : engine.hue;
      const k = (geo.bottom ? bottomDim : 1) * f.v * (hot ? 1.35 : 1) * (power ? power.fade : 1);
      ctx.strokeStyle = rgba(col, 0.42 * k);
      ctx.beginPath(); ctx.moveTo(geo.ax, geo.ay); ctx.lineTo(geo.ex, geo.ey); ctx.lineTo(geo.tx, geo.ey); ctx.stroke();
      // The anchor dot (pulsing while its card is open)
      const pulse = openCallout === c.id ? 1 + 0.6 * (0.5 + 0.5 * Math.sin(engine.t * 6)) : 1;
      ctx.fillStyle = rgba(col, 0.9 * k);
      ctx.beginPath(); ctx.arc(geo.ax, geo.ay, 2.5 * pulse, 0, TAU); ctx.fill();
      if (openCallout === c.id) { ctx.strokeStyle = rgba(col, 0.35 * k); ctx.beginPath(); ctx.arc(geo.ax, geo.ay, 6 + 3 * (pulse - 1), 0, TAU); ctx.stroke(); }
      ctx.textAlign = geo.align;
      const x = geo.right ? geo.ex + 2 : geo.ex - 2;
      ctx.fillStyle = rgba(col, 0.88 * k);
      ctx.fillText(c.id.toUpperCase() + (hot ? '  ›' : ''), x, geo.ey - 5);
      ctx.fillStyle = rgba(col, 0.55 * k);
      ctx.fillText(String(d.value || '—'), x, geo.ey + 11);
    }
    ctx.restore();
  }
  /** The callout under a point (client coordinates). */
  function calloutAt(cx, cy) {
    const p = fromClient(cx, cy);
    for (const [id, geo] of calloutGeo) {
      const b = geo.box;
      if (p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 2 && p.y <= b.y + b.h + 2) return id;
    }
    return null;
  }
  const clientBox = (b) => { const s = scaleOf(); const p = toClient(b.x, b.y); return { x: p.x, y: p.y, w: b.w * s, h: b.h * s }; };

  // ---- Pointer: orbs (click, grab, throw) and callouts (hover, click) ---------------------------------------------------------
  const press = { orb: null, callout: null, x: 0, y: 0 };
  function pickOrb(x, y, slop = 16) {
    let best = null, bestD = Infinity;
    for (const orb of orbs.values()) {
      if (!['orbit', 'returning'].includes(orb.mode) || orb.alpha < 0.3) continue;
      const s = screenOf(orb);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < Math.max(slop, s.r * 2) && d < bestD) { best = orb; bestD = d; }
    }
    return best;
  }
  function ensureHint() {
    if (hint) return hint;
    hint = document.createElement('div');
    hint.className = 'close-hint orb-hint';
    hint.hidden = true;
    core.parentElement.appendChild(hint);
    return hint;
  }
  core.addEventListener('pointerdown', (e) => {
    if (!isReactor() || e.button !== 0) return;
    if (power) { // holding the core (wake / standby) or the notch (power down): never a click, never an orb
      const p = fromClient(e.clientX, e.clientY);
      if (power.pointer('down', p.x, p.y, geometry())) { press.power = true; press.orb = null; press.callout = null; try { core.setPointerCapture(e.pointerId); } catch {} return; }
    }
    const id = calloutAt(e.clientX, e.clientY);
    if (id) { press.callout = id; press.orb = null; return; }
    const orb = pickOrb(e.clientX, e.clientY, e.pointerType === 'touch' ? 30 : 16);
    press.orb = orb; press.callout = null; press.x = e.clientX; press.y = e.clientY;
    held.moved = false;
  });
  core.addEventListener('pointermove', (e) => {
    if (!isReactor()) return;
    if (power) {
      const p = fromClient(e.clientX, e.clientY);
      const over = power.pointer('move', p.x, p.y, geometry());
      if (press.power) { if (!power.hold) { press.power = false; try { core.releasePointerCapture(e.pointerId); } catch {} } return; }
      if (over) { core.style.cursor = 'pointer'; return; }
    }
    if (press.orb && !held.orb && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6 && !reduceMotion) {
      held.orb = press.orb; held.samples = [];
      held.orb.done?.(); held.orb.done = null;
      held.orb.mode = 'held';
      try { core.setPointerCapture(e.pointerId); } catch {}
    }
    if (held.orb) {
      const p = fromClient(e.clientX, e.clientY);
      const g = geometry(), R = orbRadius(held.orb, g);
      held.orb.x = clamp(p.x, R, w - R); held.orb.y = clamp(p.y, R, h - R);
      held.samples.push({ t: performance.now(), x: held.orb.x, y: held.orb.y });
      while (held.samples.length > 12) held.samples.shift();
      const d = Math.hypot(held.orb.x - g.cx, held.orb.y - g.cy);
      const near = clamp(1 - (d - catchR()) / (g.r * 0.9), 0, 1);
      HUD.hover?.(near);
      const el = ensureHint();
      const show = near > 0.45;
      el.hidden = !show;
      if (show) {
        el.textContent = FINISHED.includes(held.orb.job.status) ? 'RELEASE TO PUT AWAY' : held.orb.job.status === 'paused' ? 'RELEASE TO CANCEL' : 'RELEASE TO CANCEL';
        const c = toClient(g.cx, g.cy - g.r - 30), sr = core.parentElement.getBoundingClientRect();
        el.style.left = `${c.x - sr.left}px`; el.style.top = `${Math.max(8, c.y - sr.top)}px`;
      }
      if (d < 26) { letGo(e, true); }
      return;
    }
    const id = calloutAt(e.clientX, e.clientY);
    const over = id || pickOrb(e.clientX, e.clientY);
    core.style.cursor = over ? 'pointer' : '';
    if (id !== hoverCallout) { hoverCallout = id; window.dispatchEvent(new CustomEvent('callout-hover', { detail: id })); }
  });
  function letGo(e, deep = false) {
    const orb = held.orb;
    held.orb = null;
    try { core.releasePointerCapture(e.pointerId); } catch {}
    if (hint) hint.hidden = true;
    HUD.hover?.(0);
    if (!orb) return;
    const g = geometry();
    if (deep || Math.hypot(orb.x - g.cx, orb.y - g.cy) < catchR()) return absorb(orb);
    const now = performance.now();
    const recent = held.samples.filter((s) => now - s.t < 90);
    let vx = 0, vy = 0;
    if (recent.length > 1) {
      const a = recent[0], z = recent[recent.length - 1];
      const dt = Math.max(8, z.t - a.t);
      vx = ((z.x - a.x) / dt) * 16.67 * PHYS.throw; vy = ((z.y - a.y) / dt) * 16.67 * PHYS.throw;
      const sp = Math.hypot(vx, vy);
      if (sp > PHYS.maxSpeed) { vx *= PHYS.maxSpeed / sp; vy *= PHYS.maxSpeed / sp; }
    }
    orb.vx = vx; orb.vy = vy;
    orb.mode = 'thrown';
  }
  core.addEventListener('pointerup', (e) => {
    if (!isReactor()) return;
    if (press.power) { press.power = false; power.pointer('up', 0, 0, geometry()); try { core.releasePointerCapture(e.pointerId); } catch {} return; }
    if (held.orb) return letGo(e);
    if (press.orb) { const orb = press.orb; press.orb = null; if (hint) hint.hidden = true; window.dispatchEvent(new CustomEvent('orb-open', { detail: orb.id })); return; }
    if (press.callout) { const id = press.callout; press.callout = null; if (calloutAt(e.clientX, e.clientY) === id) window.dispatchEvent(new CustomEvent('callout-click', { detail: id })); }
  });
  core.addEventListener('pointercancel', (e) => { if (held.orb) letGo(e); press.orb = null; press.callout = null; if (press.power) { press.power = false; power?.pointer('cancel', 0, 0, geometry()); } });
  core.addEventListener('mouseleave', () => { core.style.cursor = ''; power?.pointer('up', 0, 0, geometry()); if (hoverCallout) { hoverCallout = null; window.dispatchEvent(new CustomEvent('callout-hover', { detail: null })); } });

  // ---- The orbs API (window.JobOrbs forwards here in the reactor look) --------------------------------------------------------
  const reactorOrbs = {
    sync(jobs) {
      lastJobs = jobs;
      const now = Date.now();
      const active = jobs.filter((j) => ['queued', 'running', 'approval', 'paused'].includes(j.status));
      const finished = jobs.filter((j) => FINISHED.includes(j.status) && !j.dismissed && !(j.seen && now - (j.finished || j.created) > SHOW_DAYS * 864e5))
        .sort((x, y) => (y.finished || 0) - (x.finished || 0)).slice(0, Math.max(2, 10 - active.length));
      const want = new Map([...active, ...finished].map((j) => [j.id, j]));
      runningJobs = jobs.filter((j) => j.status === 'running').length;
      const g = geometry();
      for (const [id, orb] of orbs) {
        if (want.has(id) || ['sinking', 'fading', 'absorbing'].includes(orb.mode)) continue;
        const j = jobs.find((x) => x.id === id);
        if (j?.dismissed && !reduceMotion) { orb.alpha = 1; orb.mode = 'sinking'; orb.t = 0; orb.dur = 1.3; orb.a0 = Math.atan2(orb.y - g.cy, orb.x - g.cx); orb.r0 = Math.hypot(orb.x - g.cx, orb.y - g.cy); }
        else move(orb, 'fading', null, 0.5);
      }
      for (const j of want.values()) {
        const orb = orbs.get(j.id) || makeOrb(j);
        if (orb.mode === 'sinking' || orb.mode === 'fading') { orb.mode = 'orbit'; orb.show = 1; orb.shrink = 1; }
        const was = orb.job.status;
        if (was !== j.status && FINISHED.includes(j.status) && !FINISHED.includes(was)) { orb.flare = 1; engine.burst(5); }
        if (was !== 'approval' && j.status === 'approval') orb.flare = 0.7;
        orb.job = j;
      }
    },
    has: (id) => orbs.has(id) && !['sinking', 'fading', 'absorbing'].includes(orbs.get(id).mode),
    hits() {
      if (!w || !isReactor()) return [];
      return [...orbs.values()].filter((o) => ['orbit', 'returning', 'thrown', 'held'].includes(o.mode) && o.alpha >= 0.3)
        .map((o) => { const s = screenOf(o); return { x: s.x, y: s.y, r: Math.max(16, s.r * 2) }; });
    },
    screenPos(id) { const o = orbs.get(id); return o && w ? screenOf(o) : null; },
    async launch(id) {
      const orb = orbs.get(id);
      if (!orb || !w || ['sinking', 'fading', 'absorbing'].includes(orb.mode)) return null;
      if (orb.mode === 'parked') return screenOf(orb);
      if (reduceMotion) { orb.mode = 'parked'; orb.t = 1; return null; }
      await move(orb, 'launching', null, 0.3);
      engine.burst(6);
      return screenOf(orb);
    },
    park(id) {
      for (const o of orbs.values()) if (o.id !== id && (o.mode === 'parked' || o.mode === 'launching')) move(o, 'returning', null, reduceMotion ? 0.01 : 0.9);
      const orb = orbs.get(id);
      if (orb && orb.mode !== 'parked') { orb.mode = 'parked'; orb.t = 1; orb.alpha = 0; orb.done = null; }
    },
    land(id) {
      for (const o of orbs.values()) {
        if (o.mode !== 'parked' && o.mode !== 'launching') continue;
        if (o.id === id) { o.alpha = 1; o.flare = reduceMotion ? 0 : 0.8; }
        move(o, 'returning', null, reduceMotion ? 0.01 : 0.9);
      }
    },
    pick(x, y, slop = 16) { return pickOrb(x, y, slop)?.job || null; },
    set reduceMotion(on) { reduceMotion = Boolean(on) || reduceMotionQuery.matches; },
    /** Orbs and their labels on screen (client px), for the translucency rule. */
    rects() {
      const out = [];
      for (const o of orbs.values()) {
        if (o.alpha < 0.3 || o.mode === 'parked') continue;
        const s = screenOf(o);
        const flying = o.mode === 'held' || o.mode === 'thrown';
        out.push({ id: o.id, x: s.x - s.r - 6, y: s.y - s.r - 6, w: (s.r + 6) * 2, h: (s.r + 6) * 2, flying });
        if (o.labelBox && !flying) out.push({ id: o.id, ...clientBox(o.labelBox), label: true });
      }
      return out;
    },
    fade(id, on) { const o = orbs.get(id); if (o) o.fadeTo = on ? 0.2 : 1; },
    /** Testing (the harness): an orb's fade target, and a throw without a pointer. */
    fadeOf: (id) => orbs.get(id)?.fadeTo ?? null,
    modeOf: (id) => orbs.get(id)?.mode ?? null,
    throw(id, vx, vy) { const o = orbs.get(id); if (!o) return false; o.done?.(); o.done = null; o.mode = 'thrown'; o.vx = vx; o.vy = vy; return true; },
  };
  // One window.JobOrbs for work.js and surface.js, whichever look is on. brain3d.mjs registers itself as JobOrbs3D.
  const active = () => (isReactor() ? reactorOrbs : window.JobOrbs3D) || reactorOrbs;
  window.JobOrbs = {
    sync(jobs) { lastJobs = jobs; active().sync(jobs); },
    has: (id) => active().has(id),
    hits: () => active().hits(),
    screenPos: (id) => active().screenPos(id),
    launch: (id) => active().launch(id),
    park: (id) => active().park(id),
    land: (id) => active().land(id),
    pick: (x, y, slop) => active().pick(x, y, slop),
    set reduceMotion(on) { reduceMotion = Boolean(on) || reduceMotionQuery.matches; if (window.JobOrbs3D) window.JobOrbs3D.reduceMotion = on; },
    rects: () => (isReactor() ? reactorOrbs.rects() : []),
    fade: (id, on) => reactorOrbs.fade(id, on),
  };

  // ---- Frame -------------------------------------------------------------------------------------------------------------------
  const gate = Perf.gate();
  let last = 0, lastBack = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (!gate(t)) { if (document.hidden) last = t; return; }
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    if (!isReactor()) return;
    rect = hud.getBoundingClientRect();
    const live = HUD.live();
    engine.setState(live.state);
    if (power) { // (before the engine's update: the controller sets what it should look like this frame)
      power.update(dt);
      for (const ev of power.events.splice(0)) {
        if (ev === 'wake') backdrop.ripples.push({ t0: backdrop.t, k: 1.7 }); // the shockwave relighting the dots
        window.dispatchEvent(new CustomEvent('power', { detail: ev }));
      }
    }
    engine.update(dt, { level: live.level, pulse: live.pulse, attention: live.attention, offline: live.offline && !(power && power.mode !== 'online') });
    bootStart ??= t;
    boot = coldStart || geometryOverride ? 1 : 1 - Math.pow(1 - Math.min(1, (t - bootStart) / 1600), 3);
    const g = geometry();
    const motion = !window.SCENE_STILL && !reduceMotion;
    // The sheet: full-bleed, centred on the reactor wherever it sits (or on another window's reactor: the backdrop under the live
    // desktop, where this page's own reactor canvas is hidden and has no size)
    // (30 fps at most, 20 with nothing but the sweep moving: it's a whole display's worth of pixels)
    const backFps = backdrop.ripples.length || live.state === 'speaking' ? 30 : 20;
    if (matrix && mctx && !window.SCENE_BACKDROP_OFF?.() && (t - lastBack >= 1000 / backFps - 2 || !lastBack)) {
      const bdt = lastBack ? Math.min(0.1, (t - lastBack) / 1000) : dt;
      lastBack = t;
      const mr = matrix.getBoundingClientRect();
      const c = centreOverride || (w ? { x: rect.left - mr.left + g.cx * scaleOf(), y: rect.top - mr.top + g.cy * scaleOf(), r: g.r * scaleOf() }
        : { x: mr.width / 2, y: mr.height / 2 + mr.height * 0.03, r: radiusFor(mr.width, mr.height) * boot });
      const cr = Math.max(c.r, radiusFor(mr.width, mr.height) * 0.2);
      let hue = engine.hue;
      if (power) { const sh = power.sheet({ cx: c.x, cy: c.y, r: cr }); backdrop.setOpts(sh.opts); hue = sh.hue; }
      backdrop.draw(mctx, { staticCtx: sctx, cx: c.x, cy: c.y, r: cr, hue, dt: bdt, level: live.level, speaking: live.state === 'speaking', motion: motion && !(power && power.mode === 'offline'), ink: !window.SCENE_TRANSPARENT });
    }
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    if (window.SCENE_HIDE_BRAIN) return; // (the wallpaper backdrop under the live ARES desktop: the window draws the reactor)
    updateOrbs(dt, t / 1000);
    power?.drawUnder(ctx, g);
    if (!power || power.fade > 0.01) drawOrbit(g);
    engine.draw(ctx, g.cx, g.cy, power ? power.radius(g.r) : g.r, { alpha: 1 });
    const flying = [];
    for (const orb of orbs.values()) { if (orb.mode === 'held' || orb.mode === 'thrown' || orb.mode === 'absorbing') flying.push(orb); else drawOrb(orb, g); }
    layoutCallouts(g);
    drawCallouts(g, dt);
    for (const orb of flying) drawOrb(orb, g);
    power?.drawOver(ctx, g);
  }
  new ResizeObserver(resize).observe(hud);
  if (matrix) new ResizeObserver(resize).observe(matrix);
  addEventListener('scene-look', () => { lastBack = 0; backdrop.staticKey = ''; });
  addEventListener('scene-quality', resize);
  resize();
  requestAnimationFrame(frame);
  window.dispatchEvent(new Event('orbs-ready'));

  return {
    get look() { return look; },
    setLook(next) {
      next = next === 'brain' ? 'brain' : 'reactor';
      if (next === look) return;
      look = next;
      applyLook();
      if (window.JobOrbs3D) window.JobOrbs3D.sync(isReactor() ? [] : lastJobs);
      reactorOrbs.sync(isReactor() ? lastJobs : []);
      bootStart = null;
      window.dispatchEvent(new CustomEvent('scene-look', { detail: look }));
    },
    get engine() { return engine; },
    get backdrop() { return backdrop; },
    get reduceMotion() { return reduceMotion; },
    /** The reactor in the #hud canvas's own coordinates. */
    geometry,
    /** The reactor on screen (client px). */
    screen() { const g = geometry(); const c = toClient(g.cx, g.cy); return { x: c.x, y: c.y, r: g.r * scaleOf() }; },
    radiusFor,
    /** The wallpaper under the live desktop: draw the sheet around another window's reactor (client px here), or null. */
    setCentre(c) { centreOverride = c ? { x: c.x, y: c.y, r: c.r } : null; },
    setReadouts(d) { readouts = d; },
    get readouts() { return readouts; },
    setColumns(c) { columns = c; },
    setOpenCallout(id) { openCallout = id; },
    get hoverCallout() { return hoverCallout; },
    calloutAt,
    /** Where a callout's label sits (client px), for its card. */
    calloutBox(id) { const geo = calloutGeo.get(id); return geo ? { ...clientBox(geo.box), right: geo.right, bottom: geo.bottom } : null; },
    calloutRects() { return [...calloutGeo].map(([id, geo]) => ({ id, ...clientBox(geo.box) })); },
    fadeCallout(id, on) { const f = calloutFade.get(id) || { v: 1, to: 1 }; f.to = on ? 0.2 : 1; calloutFade.set(id, f); },
    /** Client rectangles the window takes clicks on as the live desktop: the callout labels. */
    hits() {
      if (!isReactor() || window.SCENE_HIDE_BRAIN) return [];
      const out = [...calloutGeo.values()].map((geo) => clientBox(geo.box));
      if (power && !power.replica && w) { // the core (hold for standby / wake) and, in standby, the power notch
        const g = geometry(), cr = g.r * 0.35;
        out.push(clientBox({ x: g.cx - cr, y: g.cy - cr, w: cr * 2, h: cr * 2 }));
        if (power.mode === 'standby') { const n = Ignite.layout(g.cx, g.cy, g.r, 1).notch; out.push(clientBox({ x: n.x - n.r - 6, y: n.y - n.r - 6, w: (n.r + 6) * 2, h: (n.r + 6) * 2 })); }
      }
      return out;
    },
    /** Ignition / standby / power down (renderer/ignite.js): the controller, and the geometry override. */
    power,
    setGeometry(g) { geometryOverride = g ? { cx: g.cx, cy: g.cy, r: g.r } : null; lastBack = 0; backdrop.staticKey = ''; },
    orbs: reactorOrbs,
    get held() { return Boolean(held.orb); },
  };
})();
window.Scene = Scene; // (a top-level const isn't a window property; other scripts and the pages' bridges look here)
