// The scene-only views of ARES: the live desktop wallpaper, the lock-screen still and the screen saver.
// The wallpaper is a second view of the one running ARES: the main process forwards her real state, voice levels,
// wake pulses and jobs (window.wp, wallpaper-preload.js), and tells it when to pause. The screen saver has no
// bridge; its host calls window.ARESWall instead. ?mode=wallpaper | still | saver, or <body data-mode>
(() => {
  const q = new URLSearchParams(location.search);
  const MODE = q.get('mode') || document.body.dataset.mode || 'wallpaper'; // (the screen saver's file:// page can't take a query)
  if (MODE === 'still') window.SCENE_STILL = true; // brain3d keeps its frame so it can be copied
  const bridge = window.wp || null;
  const core = document.querySelector('.core');
  if (q.get('look') && window.Scene) Scene.setLook(q.get('look')); // the still is told its look on the query

  // ---- Frame rate --------------------------------------------------------------------------------------
  // 60 fps on mains, 30 and a simpler scene on battery; nothing at all while
  // paused (covered, full-screen app, locked, display asleep). Low Power Mode holds a still frame, after the
  // first couple of seconds have drawn one.
  const mode = { paused: false, still: false, battery: false, fps: 30 };
  let state = 'idle';
  let drawUntil = performance.now() + 2600;
  Perf.setPolicy(() => {
    if (MODE === 'still') return 60;
    if (mode.paused) return 0;
    if (mode.still) return performance.now() < drawUntil ? 30 : 0;
    if (MODE === 'saver') return mode.battery ? 20 : 30; // the screen saver stays light
    return mode.battery ? 30 : 60;
  });
  function setMode(m) {
    const wasBattery = mode.battery;
    if (m.still && !mode.still) drawUntil = performance.now() + 2600;
    Object.assign(mode, m);
    if (mode.battery !== wasBattery) {
      window.SCENE_DPR = mode.battery ? 1 : undefined;
      dispatchEvent(new Event('scene-quality'));
      drawUntil = performance.now() + 1500;
    }
  }

  // ---- Her state, from the running ARES ----------------------------------------------------------------
  const synth = (v, k) => Float32Array.from({ length: HUD.BARS }, (_, i) => v * (0.3 + 0.7 * Math.abs(Math.sin(i * k + performance.now() / 110))));
  function scene(msg) {
    switch (msg.type) {
      case 'state':
        state = msg.state;
        HUD.setState(state);
        window.Stars?.setState(state);
        if (state !== 'listening' && state !== 'speaking') { HUD.setLevel(0); HUD.setSpectrum(new Float32Array(HUD.BARS)); }
        break;
      case 'level':
        HUD.setLevel(msg.v);
        HUD.setSpectrum(msg.spectrum // thinned for the trip: stretch it back to the halo's resolution
          ? Float32Array.from({ length: HUD.BARS }, (_, i) => msg.spectrum[Math.floor(i * msg.spectrum.length / HUD.BARS)] || 0)
          : synth(msg.v, 0.4));
        break;
      case 'pulse':
        HUD.pulse(msg.strength ?? 1);
        window.BrainFX?.fire(msg.strength > 1.2 ? 4 : 8, 1); // neurons fire on the wake word
        drawUntil = performance.now() + 1200;
        break;
      case 'attention':
        HUD.attention(msg.on);
        break;
      case 'offline':
        HUD.offline?.(msg.on);
        break;
      case 'power': // ignition / standby / power down: this page's controller follows the window's (renderer/ignite.js)
        if (window.Scene?.power) { Scene.power.set(msg.mode, { force: true, status: msg.status }); drawUntil = performance.now() + 5000; }
        break;
      case 'power-step':
        window.Scene?.power?.step(msg.step);
        break;
      case 'power-ready':
        window.Scene?.power?.ready();
        break;
      case 'readouts': // the HOST / CLAUDE / BATTERY values (readouts.js); JOBS from the jobs this page has
        readouts = msg.readouts || null;
        pushReadouts();
        break;
      case 'spot': { // the window's brain moved or shrank (panels, icons): this one goes with it, so there's one brain
        const core = document.querySelector('.core');
        if (core) { // the first placement lands at once (no slide at launch); later moves glide like the window's
          core.style.transition = core.dataset.spot ? 'transform 1.4s cubic-bezier(.3,.7,.4,1)' : 'none';
          core.style.transform = `translate(${msg.dx || 0}px, ${msg.dy || 0}px) scale(${msg.s || 1})`;
          core.dataset.spot = '1';
        }
        lastSpot = msg;
        applyCentre();
        drawUntil = performance.now() + 1600;
        break;
      }
    }
  }
  // Under the live ARES desktop this page draws only the sheet, centred on the window's reactor (the spot message carries
  // its centre on the screen); where this page shows the reactor itself, the sheet is centred on that
  let lastSpot = null;
  function applyCentre() {
    if (!window.Scene) return;
    const m = lastSpot;
    Scene.setCentre(window.SCENE_HIDE_BRAIN && m && Number.isFinite(m.cx) ? { x: m.cx - window.screenX, y: m.cy - window.screenY, r: m.r } : null);
  }
  // The callouts' short values, as the window shows them (renderer/callouts.js)
  let readouts = null;
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
  function pushReadouts() {
    if (!window.Scene) return;
    if (!readouts || MODE !== 'wallpaper') { Scene.setReadouts(null); return; }
    const act = jobs.filter((j) => ['queued', 'running', 'approval', 'paused'].includes(j.status));
    const need = act.filter((j) => j.status === 'approval').length, working = act.filter((j) => j.status === 'running').length;
    const h = readouts.host, c = readouts.claude, b = readouts.battery;
    const five = c?.five?.pct, week = c?.week?.pct;
    Scene.setReadouts({
      jobs: { value: act.length ? `${working} WORKING${need ? ` · ${need} NEED${need === 1 ? 'S' : ''} YOU` : act.length - working ? ` · ${act.length - working} WAITING` : ''}` : 'NONE RUNNING', amber: need > 0 },
      host: { value: h ? `${String(h.name || 'MAC').toUpperCase()} · ${h.phone?.paired && !h.phone.connected ? 'PHONE OFF' : 'ONLINE'}` : 'MAC · …', amber: Boolean(h?.phone?.paired && !h.phone.connected) },
      claude: { value: c ? `5H ${pct(five)} · WEEK ${pct(week)}` : 'NO READING', amber: Number.isFinite(five) && five >= 80 },
      battery: { value: b ? `${pct(b.pct)} · ${b.charging ? 'CHARGING' : b.source === 'ac' ? 'ON POWER' : 'ON BATTERY'}` : 'NO BATTERY', amber: Boolean(b && !b.charging && b.source !== 'ac' && b.pct <= 20) },
    });
  }

  let jobs = [];
  const syncJobs = () => { window.JobOrbs?.sync(jobs); pushReadouts(); };
  addEventListener('orbs-ready', syncJobs);

  // ---- Optional clock and greeting ----------------------------------------------------------------------
  const clock = document.getElementById('clock');
  let owner = 'Dhruv';
  function tickClock() {
    if (clock.hidden) return;
    const now = new Date();
    const h = now.getHours();
    clock.querySelector('b').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
    clock.querySelector('span').textContent = `${h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${owner}`;
  }
  setInterval(tickClock, 15_000);
  function prefs(p) {
    if (p.owner) owner = p.owner;
    clock.hidden = MODE !== 'wallpaper' || !p.clock;
    tickClock();
    if (window.JobOrbs) window.JobOrbs.reduceMotion = Boolean(p.reduceMotion);
    if (p.look && window.Scene) Scene.setLook(p.look);
    // The backdrop under the live ARES desktop: the sheet only (the ARES window above draws the reactor and its orbs)
    window.SCENE_HIDE_BRAIN = p.brain === false;
    core.hidden = window.SCENE_HIDE_BRAIN;
    applyCentre();
    drawUntil = performance.now() + 1500;
  }

  // ---- The lock-screen still: one picture of the scene at this display's native resolution ------------------
  // The reactor look (docs/ignition-prompt.md §1): the cold reactor in gold ("offline", what the desktop shows while ARES is
  // quit) or the blue standby scene, drawn by the same controller as the window and the ignition helper (renderer/ignite.js),
  // at the same spot (?geo), with the cleared title band and the brighter sheet. Every size scales with the backing scale
  // because the canvases themselves are at the display's native resolution.
  async function renderStill(tint, caption) {
    const reactor = window.SCENE_LOOK === 'reactor';
    const kind = caption === 'standby' ? 'standby' : caption === 'none' ? null : 'offline';
    if (reactor && window.Scene?.power) {
      if (kind) Scene.power.set(kind, { force: true, status: { listening: false, link: q.get('link') === '1', jobs: Number(q.get('jobs')) || 0 } });
      else Scene.power.set('online', { force: true });
      Scene.power.title = 1;
      await new Promise((r) => setTimeout(r, 900)); // the sheet re-renders with the band and the brighter dots; the hue settles
    } else {
      if (caption === 'offline') HUD.offline?.(true);
      await new Promise((r) => (window.JobOrbs ? r() : addEventListener('orbs-ready', r, { once: true })));
      await new Promise((r) => setTimeout(r, 2600)); // past the boot animation, a few neurons alight
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    // The page background, then each layer where it sits
    ctx.fillStyle = reactor ? '#03070d' : '#02050a';
    ctx.fillRect(0, 0, W, H);
    const cr = core.getBoundingClientRect();
    if (reactor) {
      ctx.drawImage(document.getElementById('sheet'), 0, 0, W, H);
      ctx.drawImage(document.getElementById('hud'), cr.left * dpr, cr.top * dpr, cr.width * dpr, cr.height * dpr);
      return out.toDataURL('image/png');
    }
    const glow = ctx.createRadialGradient((cr.left + cr.width / 2) * dpr, (cr.top + cr.height / 2) * dpr, 0, (cr.left + cr.width / 2) * dpr, (cr.top + cr.height / 2) * dpr, Math.min(W, H) * 0.42);
    const glowRgb = tint ? '255, 170, 90' : '62, 230, 255';
    glow.addColorStop(0, `rgba(${glowRgb}, 0.09)`);
    glow.addColorStop(1, `rgba(${glowRgb}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(document.getElementById('stars'), 0, 0, W, H);
    if (tint) ctx.filter = 'hue-rotate(-155deg) saturate(1.15)'; // the warmer evening version (a setting): cyan becomes a soft amber
    for (const id of ['brain', 'hud']) ctx.drawImage(document.getElementById(id), cr.left * dpr, cr.top * dpr, cr.width * dpr, cr.height * dpr);
    ctx.filter = 'none';
    return out.toDataURL('image/png');
  }

  // ---- Wiring --------------------------------------------------------------------------------------------
  let held = false; // measuring: a forced mode the main process doesn't override
  window.ARESWall = { setMode, scene, jobs(list) { jobs = list || []; syncJobs(); }, prefs, hold(m) { held = Boolean(m); if (m) setMode(m); } };
  if (MODE === 'still') {
    renderStill(q.get('tint') === 'evening', q.get('caption') || '').then((png) => bridge?.stillDone(png), (err) => bridge?.stillDone(null, String(err)));
  } else if (bridge) {
    bridge.onScene(scene);
    bridge.onMode((m) => { if (!held) setMode(m); });
    bridge.onJobs(window.ARESWall.jobs);
    bridge.onPrefs(prefs);
    bridge.ready();
  }
})();
