// The dashboard around the brain: the top bar (greeting, one-line weather, status), the thought ticker and activity
// pulse, and the floating panels: "your day" on the left (NEXT, TIMER, LEAVE BY), "what ARES is doing" on the right
// (WORK, CALL, NOW PLAYING, REMEMBERED, INBOX), each only while it's relevant.
//
// Panels are FRIDAY-style content inside four EDITH corner brackets. Info about the user's day MATERIALIZES (bracket
// flicker, scan line, decoding text); things ARES creates LAUNCH FROM THE BRAIN (a spark and beam, then the panel
// unfolds). Any panel can be grabbed: it folds into a small labelled orb that can be thrown (calm physics), docks
// into an invisible magnetic slot when it slows near a free one, or is closed by throwing it into the brain.
// When there are more panels than slots, every panel steps down a tier (FULL → COMPACT → MINI) to fit.
// A plain click (no drag) unfolds a panel in place into a DETAIL CARD with more about it and a few actions.
const Dash = (() => {
  const $ = (id) => document.getElementById(id);
  const stage = document.querySelector('.stage');
  const core = document.querySelector('.core');
  const layer = $('panels');
  const fxCanvas = $('fx');
  const fx = fxCanvas.getContext('2d');
  const closeHint = $('closeHint');

  let prefs = { reduceMotion: false, magnetic: true, panels: {}, owner: 'Dhruv' };
  const reduce = () => prefs.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Colour by kind: cyan = my day, violet = work, green = calls, amber = needs me
  const KIND = { day: '62,230,255', work: '167,139,250', call: '74,222,128', needs: '255,181,71' };
  const TIERS = { full: { w: 214, h: 62 }, compact: { w: 170, h: 44 }, mini: { w: 130, h: 26 } };
  const LEVELS = [['full', 1], ['compact', 1], ['mini', 1], ['mini', 2], ['mini', 3]];
  const PAD = 14, TOP = 12, GAP = 10;
  const PHYS = { throw: 0.55, maxSpeed: 9, friction: 0.965, bounce: 0.6, unfold: 0.35, dock: 2.4, dockReach: 80, brainCatch: 58, orbR: 11 };

  const pad2 = (n) => String(Math.max(0, n)).padStart(2, '0');
  const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const up = (s) => String(s || '').toUpperCase();

  // ---- Top bar ------------------------------------------------------------------------------------------
  function greet() {
    const h = new Date().getHours();
    const word = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 22 ? 'Evening' : 'Late night';
    $('greeting').textContent = `${word}, ${prefs.owner}`;
  }
  setInterval(greet, 60_000);

  function setWeather(w) {
    const el = $('weather');
    el.hidden = !w;
    if (w) { el.textContent = w.text; el.title = w.place ? `Weather in ${w.place}` : ''; }
  }

  // Status: "● all systems ok", or amber with a short reason when something breaks. Click for the full list.
  const health = {}; // key -> reason ('' = fine)
  let voiceInfo = [];  // which voice she's using and the credits left (not problems: shown in the panel, never amber)
  let integrations = null;
  const GOOGLE = { calendar: 'Calendar', gmail: 'Gmail', drive: 'Drive' };
  // What's broken, and the one click toward fixing it
  const FIXES = {
    brain: { label: 'LOG IN AGAIN', fix: 'claude', hint: 'opens Terminal: type /login' },
    brainFound: { label: 'INSTALL', url: 'https://docs.claude.com/en/docs/claude-code/setup' },
    voice: { label: 'CHECK KEY', fix: 'voice', hint: 'shows the .env with ELEVENLABS_API_KEY' },
    credits: { label: 'USAGE', url: 'https://elevenlabs.io/app/subscription' },
    mic: { label: 'OPEN SETTINGS', fix: 'mic' },
  };
  function problemList() {
    const out = Object.entries(health).filter(([, r]) => r).map(([k, r]) => ({ text: r,
      // Only a rejected key is fixed in the .env: credits, outages and the network fix themselves (she switches back)
      ...(k === 'voice' && !/key/.test(r) ? {} : FIXES[k] || {}),
      ...(k === 'mic' && /speech/.test(r) && { fix: 'speech' }) }));
    if (integrations) {
      const signIn = Object.keys(GOOGLE).filter((k) => integrations[k] === 'pending').map((k) => GOOGLE[k]);
      if (signIn.length) out.push({ text: `${signIn.join(' & ')} needs sign-in`, label: 'SIGN IN', fix: 'claude', hint: 'opens Terminal: type /mcp' });
    }
    return out;
  }
  const problems = () => problemList().map((x) => x.text);
  function renderFixes() {
    const box = $('statusFix');
    const list = problemList();
    box.innerHTML = '';
    for (const x of list) {
      const row = document.createElement('div');
      row.className = 'fix-row';
      row.innerHTML = '<span></span>';
      row.firstChild.textContent = x.text + (x.hint ? ` (${x.hint})` : '');
      if (x.fix || x.url) {
        const b = document.createElement('button');
        b.className = 'dc-btn';
        b.textContent = x.label;
        b.addEventListener('click', () => window.ares.dash.act(x.url ? 'url' : 'fix', x.url ? { url: x.url } : { key: x.fix }));
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    for (const line of voiceInfo) {
      const row = document.createElement('div');
      row.className = 'fix-row';
      row.innerHTML = '<span></span>';
      row.firstChild.textContent = line;
      box.appendChild(row);
    }
    const re = document.createElement('button');
    re.className = 'dc-btn';
    re.textContent = 'RECHECK';
    re.addEventListener('click', () => { window.ares.dash.act('fix', { key: 'recheck' }); re.textContent = 'CHECKING…'; });
    const row = document.createElement('div');
    row.className = 'fix-row';
    row.innerHTML = `<span>${list.length ? '' : 'all systems ok'}</span>`;
    row.appendChild(re);
    box.appendChild(row);
  }
  function renderStatus() {
    if (!$('statusPanel').hidden) renderFixes();
    const list = problems();
    const pill = $('statusBtn');
    pill.classList.toggle('warn', list.length > 0);
    $('statusText').textContent = list.length ? `${list[0]}${list.length > 1 ? ` +${list.length - 1}` : ''}` : 'all systems ok';
    pill.title = list.length ? list.join('\n') : 'All systems ok';
  }
  function setHealth(key, ok, reason = '') {
    const was = health[key] || '';
    health[key] = ok ? '' : reason || 'error';
    if (was !== health[key]) { renderStatus(); if (!ok) blip('needs'); }
  }
  $('statusBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('statusPanel');
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    renderFixes();
    window.dispatchEvent(new Event('status-open'));
    // The same unfold as a detail card: a line from the pill, then the full list
    if (!reduce()) panel.animate([{ clipPath: 'inset(0 0 calc(100% - 2px) 60%)', filter: 'brightness(2)' }, { clipPath: 'inset(0 0 calc(100% - 2px) 0)', offset: 0.35 },
      { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1)' }], { duration: 380, easing: 'cubic-bezier(.3,.7,.4,1)' });
  });
  document.addEventListener('click', (e) => { if (!$('statusPanel').contains(e.target)) $('statusPanel').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('statusPanel').hidden) { $('statusPanel').hidden = true; e.stopImmediatePropagation(); } }, true);
  window.ares.onIntegrations((s) => { integrations = s; renderStatus(); });
  window.ares.integrations().then((s) => { integrations = s; renderStatus(); });
  window.ares.brainAvailable().then((on) => setHealth('brainFound', on, 'Claude Code not found'));

  // ---- Thought ticker + activity pulse -------------------------------------------------------------------
  const tickerEl = $('ticker');
  let tickerTimer = null;
  let activityAt = 0;
  function say(text, kind = 'day', hold = 9000) {
    tickerEl.classList.remove('dim');
    tickerEl._text = text;
    decode(tickerEl, 320);
    blip(kind);
    clearTimeout(tickerTimer);
    if (hold) tickerTimer = setTimeout(calm, hold);
  }
  function calm() { tickerEl.classList.add('dim'); tickerEl._text = 'standing by'; tickerEl.textContent = 'standing by'; }
  calm();

  const pulseCanvas = $('pulse');
  const pctx = pulseCanvas.getContext('2d');
  const blips = [];
  let pulseRaf = null;
  let pulseLast = 0;
  function sizePulse() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    pulseCanvas.width = pulseCanvas.clientWidth * dpr;
    pulseCanvas.height = pulseCanvas.clientHeight * dpr;
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPulse(0);
  }
  function drawPulse(dt) {
    const w = pulseCanvas.clientWidth, h = pulseCanvas.clientHeight, mid = h / 2;
    pctx.clearRect(0, 0, w, h);
    pctx.lineWidth = 1;
    pctx.strokeStyle = 'rgba(62,230,255,0.16)';
    pctx.beginPath(); pctx.moveTo(0, mid); pctx.lineTo(w, mid); pctx.stroke();
    for (let i = blips.length - 1; i >= 0; i--) {
      const b = blips[i];
      b.x -= 70 * dt;
      if (b.x < -10) { blips.splice(i, 1); continue; }
      pctx.strokeStyle = `rgba(${KIND[b.kind]},${0.25 + 0.7 * clamp(b.x / w, 0, 1)})`;
      pctx.beginPath();
      pctx.moveTo(b.x - 8, mid); pctx.lineTo(b.x - 4, mid - 5); pctx.lineTo(b.x - 1, mid + 4); pctx.lineTo(b.x + 2, mid - 2); pctx.lineTo(b.x + 6, mid);
      pctx.stroke();
    }
  }
  const pulseGate = Perf.gate();
  function pulseFrame(t) {
    if (!blips.length) { pulseRaf = null; drawPulse(0); return; }
    pulseRaf = requestAnimationFrame(pulseFrame);
    if (!pulseGate(t)) return;
    const dt = Math.min(0.05, pulseLast ? (t - pulseLast) / 1000 : 0.016);
    pulseLast = t;
    drawPulse(dt);
  }
  function blip(kind = 'day') {
    blips.push({ x: pulseCanvas.clientWidth + 8, kind });
    if (!pulseRaf) { pulseLast = 0; pulseRaf = requestAnimationFrame(pulseFrame); }
  }
  new ResizeObserver(sizePulse).observe(pulseCanvas);

  // ---- Text decode: scrambled glyphs resolving into the real words ------------------------------------
  const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>/';
  function decode(el, ms = 500) {
    if (reduce()) { el.textContent = el._text; return; }
    const start = performance.now();
    const token = (el._decoding = {});
    const step = (now) => {
      if (el._decoding !== token) return;
      const text = el._text || '';
      const k = Math.min(1, (now - start) / ms);
      const n = Math.floor(text.length * k);
      let out = text.slice(0, n);
      for (let i = n; i < text.length; i++) out += /[\s·:→\-.,%°]/.test(text[i]) ? text[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      el.textContent = out;
      if (k < 1) requestAnimationFrame(step); else el._decoding = null;
    };
    requestAnimationFrame(step);
  }
  function setText(el, text) {
    text = String(text ?? '');
    if (el._text === text) return;
    el._text = text;
    if (!el._decoding) el.textContent = text;
  }

  // ---- Panels: model ----------------------------------------------------------------------------------------
  const panels = new Map(); // id -> panel
  const dismissed = new Set(); // dismissKeys thrown into the brain: they stay closed until they change
  let tier = 'full';
  let cols = 1;
  let slots = { left: [], right: [] };
  let W = stage.clientWidth, H = stage.clientHeight;
  // The brain fills the stage: centred 8px above the middle, halo radius 44% of the shorter side (as in neural.js)
  const brainR = () => Math.min(W, H) * 0.44;
  const brain = () => ({ x: W / 2, y: H / 2 - 8, r: brainR() * 0.85 });
  const kindKey = (id) => id.split(':')[0];

  function makeEl(p) {
    const el = document.createElement('div');
    el.className = 'dp';
    el.innerHTML = `<div class="dp-in">
      <i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br bo"></i>
      <div class="dp-content">
        <div class="dp-body"><div class="dp-head"><span class="dp-label"></span><span class="dp-tag"></span></div>
          <div class="dp-value"></div><div class="dp-detail"></div></div>
        <div class="dp-gauge"><svg viewBox="0 0 38 30"><path class="track" pathLength="100" d="M5 25 A14 14 0 0 1 33 25"/><path class="arc" pathLength="100" d="M5 25 A14 14 0 0 1 33 25"/></svg>
          <div class="eq"><i></i><i></i><i></i><i></i><i></i></div></div>
        <div class="dp-mini"><b></b><span></span></div>
        <div class="dp-under"><i></i></div>
      </div>
      <i class="dp-scan"></i>
    </div>`;
    const q = (s) => el.querySelector(s);
    p.el = el;
    p.parts = { inner: q('.dp-in'), content: q('.dp-content'), label: q('.dp-label'), tag: q('.dp-tag'), value: q('.dp-value'), detail: q('.dp-detail'),
      gauge: q('.dp-gauge'), arc: q('.arc'), eq: q('.eq'), mini: q('.dp-mini span'), under: q('.dp-under i'), scan: q('.dp-scan'), brackets: el.querySelectorAll('.br') };
    el.addEventListener('pointerdown', (e) => press(p, e));
    layer.appendChild(el);
  }

  function fill(p) {
    const s = p.spec;
    p.el.style.setProperty('--c', KIND[s.kind] || KIND.day);
    p.el.dataset.kind = s.kind;
    setText(p.parts.label, up(s.label));
    setText(p.parts.tag, up(s.tag));
    setText(p.parts.value, up(s.value));
    setText(p.parts.detail, up(s.detail));
    setText(p.parts.mini, `${up(s.short || s.label)} · ${up(s.miniValue ?? s.value)}`);
    const g = s.gauge || {};
    p.el.classList.toggle('g-arc', g.type === 'arc');
    p.el.classList.toggle('g-eq', g.type === 'eq');
    const v = clamp(g.v ?? 0, 0, 1);
    p.parts.arc.style.strokeDasharray = `${v * 100} 100`;
    p.parts.under.style.width = `${(g.type === 'arc' ? v : g.type === 'eq' ? 1 : 0) * 100}%`;
  }

  /** Show or update a panel. spec: { kind, side, label, tag, value, detail, short, gauge, anim, onClick, ttl, dismissKey, managed } */
  function show(id, spec) {
    const key = spec.dismissKey || id;
    if (dismissed.has(key)) return null;
    let p = panels.get(id);
    if (p) {
      if (p.mode === 'leaving') return p;
      p.spec = { ...p.spec, ...spec };
      if (spec.ttl) p.expires = Date.now() + spec.ttl;
      fill(p);
      return p;
    }
    p = { id, spec, mode: 'entering', x: 0, y: 0, tx: 0, ty: 0, slot: null, side: spec.side, expires: spec.ttl ? Date.now() + spec.ttl : 0 };
    panels.set(id, p);
    makeEl(p);
    fill(p);
    layout();
    place(p);
    p.x = p.tx; p.y = p.ty;
    position(p);
    enter(p);
    return p;
  }

  function hide(id) {
    const p = panels.get(id);
    if (!p || p.mode === 'leaving' || p.mode === 'absorbing') return;
    if (p.mode === 'orb' || p.mode === 'flying' || p.mode === 'docking') return; // in the user's hand: let it land first
    if (p.mode === 'detail') { closeCard().then(() => hide(id)); return; }
    p.mode = 'leaving';
    exit(p).then(() => drop(p));
  }

  function drop(p) {
    p.el.remove();
    panels.delete(p.id);
    layout();
  }

  const position = (p) => { p.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`; };
  const size = () => TIERS[tier];
  const center = (p) => ({ x: p.x + size().w / 2, y: p.y + size().h / 2 });
  const sideOf = (p) => (p.slot ? p.slot.side : center(p).x < W / 2 ? 'left' : 'right');
  const resting = () => [...panels.values()].filter((p) => p.mode === 'rest' || p.mode === 'entering');

  // ---- Invisible magnetic slots and adaptive density ---------------------------------------------------------
  function rectHitsCircle(x, y, w, h, c) {
    const nx = clamp(c.x, x, x + w), ny = clamp(c.y, y, y + h);
    return Math.hypot(c.x - nx, c.y - ny) < c.r;
  }
  function buildSlots(t, n) {
    const { w, h } = TIERS[t];
    const rows = Math.max(1, Math.floor((H - TOP * 2 + GAP) / (h + GAP)));
    const b = brain();
    const out = { left: [], right: [] };
    for (const side of ['left', 'right']) {
      for (let c = 0; c < n; c++) {
        for (let r = 0; r < rows; r++) {
          const x = side === 'left' ? PAD + c * (w + GAP) : W - PAD - w - c * (w + GAP);
          const y = TOP + r * (h + GAP);
          if (x < 0 || x + w > W || rectHitsCircle(x, y, w, h, b)) continue;
          out[side].push({ side, i: out[side].length, x, y });
        }
      }
    }
    return out;
  }
  const occupied = (slot, except) => [...panels.values()].some((q) => q !== except && q.mode !== 'leaving' && q.mode !== 'absorbing'
    && (q.slot === slot || (!q.slot && q.mode === 'rest' && Math.abs(q.x - slot.x) < size().w * 0.6 && Math.abs(q.y - slot.y) < size().h * 0.6)));

  /** Pick the richest tier where every panel fits, then keep docked panels on their slots. */
  function layout() {
    W = stage.clientWidth; H = stage.clientHeight;
    if (!W || !H) return;
    const live = [...panels.values()].filter((p) => p.mode !== 'leaving' && p.mode !== 'absorbing');
    const need = { left: live.filter((p) => (p.slot?.side || p.side) === 'left').length, right: live.filter((p) => (p.slot?.side || p.side) === 'right').length };
    let pick = LEVELS[LEVELS.length - 1];
    for (const lv of LEVELS) {
      const s = buildSlots(lv[0], lv[1]);
      if (s.left.length >= need.left && s.right.length >= need.right) { pick = lv; break; }
    }
    const changed = pick[0] !== tier || pick[1] !== cols;
    const old = slots;
    [tier, cols] = pick;
    slots = buildSlots(tier, cols);
    layer.dataset.tier = tier;
    for (const p of panels.values()) p.el.dataset.tier = tier;
    // Docked panels: same slot index where it still exists; on a tier change, re-pack each side in order
    for (const side of ['left', 'right']) {
      const docked = live.filter((p) => p.slot && p.slot.side === side).sort((a, b) => a.slot.i - b.slot.i);
      docked.forEach((p, k) => {
        const s = changed ? slots[side][k] : slots[side][p.slot.i] || slots[side][k];
        if (s) { p.slot = s; p.tx = s.x; p.ty = s.y; } else { p.slot = null; }
      });
    }
    for (const p of live) if (!p.slot) { p.tx = clamp(p.tx, PAD / 2, W - size().w - PAD / 2); p.ty = clamp(p.ty, 4, H - size().h - 4); }
    if (changed || old !== slots) wake();
  }

  /** Where a new panel goes: where the user last left one like it, else the next free slot on its side. */
  function place(p) {
    const saved = prefs.panels[kindKey(p.id)];
    if (saved && Number.isFinite(saved.fx)) {
      const x = saved.fx * W, y = saved.fy * H;
      const near = prefs.magnetic && nearestSlot(x + size().w / 2, y + size().h / 2, p, 24);
      if (near) return dock(p, near);
      p.slot = null;
      p.tx = clamp(x, PAD / 2, W - size().w - PAD / 2);
      p.ty = clamp(y, 4, H - size().h - 4);
      return;
    }
    const s = slots[p.side].find((q) => !occupied(q, p));
    if (s) return dock(p, s);
    const col = slots[p.side][slots[p.side].length - 1] || { x: p.side === 'left' ? PAD : W - PAD - size().w, y: TOP };
    p.slot = null; p.tx = col.x; p.ty = col.y;
  }
  function dock(p, s) { p.slot = s; p.side = s.side; p.tx = s.x; p.ty = s.y; }
  function nearestSlot(cx, cy, p, reach) {
    let best = null, bd = reach;
    for (const s of [...slots.left, ...slots.right]) {
      if (occupied(s, p)) continue;
      const d = Math.hypot(s.x + size().w / 2 - cx, s.y + size().h / 2 - cy);
      if (d < bd) { best = s; bd = d; }
    }
    return best;
  }

  let saveTimer = null;
  function remember(p) {
    const k = kindKey(p.id);
    if (p.slot) delete prefs.panels[k];
    else prefs.panels[k] = { fx: +(p.x / W).toFixed(4), fy: +(p.y / H).toFixed(4) };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.ares.dash.savePanels(prefs.panels), 400);
  }

  /** "Tidy up": every panel glides back home. */
  function tidy() {
    prefs.panels = {};
    window.ares.dash.savePanels({});
    const live = resting();
    for (const p of live) { p.side = p.spec.side; p.slot = null; }
    layout();
    for (const side of ['left', 'right']) {
      live.filter((p) => p.side === side).sort((a, b) => a.y - b.y).forEach((p, k) => { if (slots[side][k]) dock(p, slots[side][k]); });
    }
    wake();
  }

  // ---- Appear / disappear ------------------------------------------------------------------------------------
  const rgbOf = (p) => KIND[p.spec.kind] || KIND.day;
  function decodeAll(p, ms = 500) {
    for (const k of ['label', 'tag', 'value', 'detail', 'mini']) decode(p.parts[k], ms);
  }
  const flash = (p, delay = 0) => p.parts.inner.animate([{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 420, delay, easing: 'ease-out' });

  function enter(p) {
    if (reduce()) {
      p.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
      p.mode = 'rest';
      return;
    }
    if (p.spec.anim === 'launch') return launch(p);
    materialize(p);
  }

  /** HOLOGRAM MATERIALIZE: brackets flicker on, a scan line sweeps down revealing the content, the text decodes. */
  function materialize(p) {
    const { brackets, content, scan } = p.parts;
    for (const b of brackets) b.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0.25, offset: 0.6 }, { opacity: 1 }], { duration: 360, easing: 'steps(6, end)' });
    content.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], { duration: 440, delay: 120, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'backwards' });
    scan.animate([{ top: '0%', opacity: 1 }, { top: '100%', opacity: 1, offset: 0.92 }, { top: '100%', opacity: 0 }], { duration: 480, delay: 120, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'backwards' });
    // Sparks at the scan line's leading edge
    const t0 = performance.now() + 120;
    const { w, h } = size();
    fxJobs.push((now) => {
      const k = (now - t0) / 440;
      if (k < 0) return true;
      if (k > 1) return false;
      if (Math.random() < 0.5) sparks.push({ x: p.x + Math.random() * w, y: p.y + k * h, vx: (Math.random() - 0.5) * 30, vy: 10 + Math.random() * 30, life: 0, max: 0.35, c: rgbOf(p), s: 1.2 });
      return true;
    });
    decodeAll(p, 520);
    flash(p, 380);
    setTimeout(() => { if (p.mode === 'entering') p.mode = 'rest'; }, 560);
    wake();
  }

  /** LAUNCH FROM BRAIN: a spark leaves the brain trailing a beam to the panel's spot; shockwave; the panel unfolds. */
  function launch(p) {
    p.el.style.visibility = 'hidden';
    const b = brain();
    const c = center(p);
    beams.push({ x0: b.x, y0: b.y, x1: c.x, y1: c.y, t: 0, dur: 0.46, c: rgbOf(p), trail: [], done: () => {
      rings.push({ x: c.x, y: c.y, r: 4, max: 70, t: 0, dur: 0.5, c: rgbOf(p) });
      p.el.style.visibility = '';
      unfold(p);
      setTimeout(() => { if (p.mode === 'entering') p.mode = 'rest'; }, 480);
    } });
    wake();
  }
  /** Point → thin horizontal line → full size with a slight overshoot; text decodes. */
  function unfold(p) {
    p.parts.inner.style.transform = '';
    p.parts.inner.style.opacity = '';
    p.parts.inner.animate([
      { transform: 'scale(0.02, 0.02)', opacity: 0.6 },
      { transform: 'scale(1, 0.04)', opacity: 1, offset: 0.4 },
      { transform: 'scale(1.04, 1.06)', offset: 0.78 },
      { transform: 'scale(1, 1)' },
    ], { duration: 420, easing: 'cubic-bezier(.3,.7,.4,1)' });
    decodeAll(p, 480);
    flash(p, 260);
  }
  /** Fold to a line, then a point. The folded state is left as an inline style (not a filled animation, whose
   *  end state Chromium can keep applying after it's cancelled); unfold() clears it. */
  function fold(p, ms = 260) {
    const inner = p.parts.inner;
    inner.style.transform = 'scale(0.02, 0.04)';
    inner.style.opacity = '0';
    return inner.animate([
      { transform: 'scale(1, 1)', filter: 'brightness(1)', opacity: 1 },
      { transform: 'scale(1, 0.04)', filter: 'brightness(2.2)', opacity: 1, offset: 0.55 },
      { transform: 'scale(0.02, 0.04)', filter: 'brightness(2.5)', opacity: 0.8 },
    ], { duration: ms, easing: 'cubic-bezier(.5,0,.7,.4)' }).finished.catch(() => {});
  }

  function exit(p) {
    if (reduce()) return p.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
    if (p.spec.anim === 'launch') {
      // Fold to a line, then a spark flies back into the brain
      return fold(p, 300).then(() => new Promise((resolve) => {
        p.el.style.visibility = 'hidden';
        const b = brain();
        const c = center(p);
        beams.push({ x0: c.x, y0: c.y, x1: b.x, y1: b.y, t: 0, dur: 0.38, c: rgbOf(p), trail: [], done: () => { HUD.pulse(0.5); resolve(); } });
        wake();
      }));
    }
    // Squeeze into a bright horizontal line and blink out
    return p.parts.inner.animate([
      { transform: 'scale(1, 1)', filter: 'brightness(1)', opacity: 1 },
      { transform: 'scale(1, 0.03)', filter: 'brightness(2.6)', opacity: 1, offset: 0.6 },
      { transform: 'scale(1.06, 0.02)', filter: 'brightness(3)', opacity: 1, offset: 0.8 },
      { transform: 'scale(0, 0.02)', filter: 'brightness(3)', opacity: 0 },
    ], { duration: 360, easing: 'ease-in', fill: 'forwards' }).finished;
  }

  // ---- Grab, throw, dock, close -------------------------------------------------------------------------------
  const hand = { p: null, samples: [] };
  // Click vs grab: only moving the pointer more than ~5px makes the orb (after a ~250ms hold, any small move does).
  // Press and release without moving is a click: it opens the panel's details.
  const GRAB_MOVE = 5, HOLD_MS = 250, HOLD_MOVE = 2;
  function press(p, e) {
    if (e.button !== 0 || p.mode !== 'rest' || hand.p) return;
    e.preventDefault();
    p.press = { x: e.clientX, y: e.clientY, at: performance.now() };
    // Follow the pointer at the window level (pointer capture alone proved unreliable once the panel folds away)
    const id = e.pointerId;
    const move = (ev) => { if (ev.pointerId === id) drag(p, ev); };
    const up = (ev) => {
      if (ev.pointerId !== id) return;
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', up, true);
      letGo(p, ev);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  }
  function stagePoint(cx, cy) { const r = stage.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; }
  function drag(p, e) {
    if (p.press) {
      const moved = Math.hypot(e.clientX - p.press.x, e.clientY - p.press.y);
      if (moved > (performance.now() - p.press.at > HOLD_MS ? HOLD_MOVE : GRAB_MOVE)) grab(p, e.clientX, e.clientY);
    }
    if (hand.p !== p) return;
    const pt = stagePoint(e.clientX, e.clientY);
    p.ox = clamp(pt.x, PHYS.orbR, W - PHYS.orbR);
    p.oy = clamp(pt.y, PHYS.orbR, H - PHYS.orbR);
    hand.samples.push({ t: performance.now(), x: p.ox, y: p.oy });
    while (hand.samples.length > 12) hand.samples.shift();
    const b = brain();
    const d = Math.hypot(p.ox - b.x, p.oy - b.y);
    if (d < 26) { hand.p = null; absorb(p); } // dragged deep into the centre
  }
  function letGo(p, e) {
    if (p.press && hand.p !== p) { // a plain click
      p.press = null;
      if (e.type === 'pointerup') openCard(p);
      return;
    }
    p.press = null;
    if (hand.p !== p) return;
    hand.p = null;
    // Release velocity from the last ~80 ms of movement, in px per frame
    const now = performance.now();
    const recent = hand.samples.filter((s) => now - s.t < 90);
    let vx = 0, vy = 0;
    if (recent.length > 1) {
      const a = recent[0], z = recent[recent.length - 1];
      const dt = Math.max(8, z.t - a.t);
      vx = ((z.x - a.x) / dt) * 16.67 * PHYS.throw;
      vy = ((z.y - a.y) / dt) * 16.67 * PHYS.throw;
      const sp = Math.hypot(vx, vy);
      if (sp > PHYS.maxSpeed) { vx *= PHYS.maxSpeed / sp; vy *= PHYS.maxSpeed / sp; }
    }
    p.vx = vx; p.vy = vy;
    const b = brain();
    if (Math.hypot(p.ox - b.x, p.oy - b.y) < PHYS.brainCatch) return absorb(p);
    p.mode = 'flying';
    wake();
  }

  /** GRAB: the panel folds (line, then point) into a small glowing labelled orb that follows the cursor. */
  function grab(p, cx, cy) {
    if (hand.p || p.mode !== 'rest') return;
    p.press = null;
    hand.p = p;
    hand.samples = [];
    p.mode = 'orb';
    const c = center(p);
    const pt = stagePoint(cx, cy);
    p.ox = pt.x; p.oy = pt.y; p.vx = 0; p.vy = 0; p.trail = [];
    p.orbA = 0;
    p.slot = null;
    layout();
    fold(p, 170);
    rings.push({ x: c.x, y: c.y, r: 4, max: 36, t: 0, dur: 0.35, c: rgbOf(p) });
    wake();
  }

  /** Into the brain: a short spiral, the brain pulses, a ring ripples out; the panel is closed. */
  function absorb(p) {
    const b = brain();
    p.mode = 'absorbing';
    p.abs = { t: 0, a0: Math.atan2(p.oy - b.y, p.ox - b.x), r0: Math.hypot(p.ox - b.x, p.oy - b.y) };
    dismissed.add(p.spec.dismissKey || p.id);
    p.spec.onDismiss?.();
    closeHint.hidden = true;
    HUD.hover(0);
    wake();
  }

  /** The orb opens back into the panel where it stopped (or at the slot that pulled it in). */
  function land(p, slot) {
    const { w, h } = size();
    if (slot) {
      dock(p, slot);
    } else {
      p.slot = null;
      let x = clamp(p.ox - w / 2, PAD / 2, W - w - PAD / 2);
      let y = clamp(p.oy - h / 2, 4, H - h - 4);
      // Never on top of the brain: nudge it out along the line from the centre
      const b = brain();
      for (let k = 0; k < 60 && rectHitsCircle(x, y, w, h, b); k++) {
        const dx = x + w / 2 - b.x, dy = y + h / 2 - b.y, d = Math.hypot(dx, dy) || 1;
        x = clamp(x + (dx / d) * 6, PAD / 2, W - w - PAD / 2);
        y = clamp(y + (dy / d) * 6, 4, H - h - 4);
      }
      // Landing next to another panel: line the edges up
      for (const q of resting()) {
        if (q === p) continue;
        if (Math.abs(x - q.x) < 10) x = q.x;
        else if (Math.abs(x + w - (q.x + w)) < 10) x = q.x;
        if (Math.abs(y - q.y) < 10) y = q.y;
        else if (Math.abs(y - (q.y + h + GAP)) < 10) y = q.y + h + GAP;
        else if (Math.abs(y + h + GAP - q.y) < 10) y = q.y - h - GAP;
      }
      p.tx = x; p.ty = y;
    }
    p.x = p.tx; p.y = p.ty;
    p.side = sideOf(p);
    position(p);
    p.mode = 'entering';
    p.parts.inner.getAnimations().forEach((a) => a.cancel());
    p.parts.inner.style.transform = '';
    p.parts.inner.style.opacity = '';
    rings.push({ x: p.x + w / 2, y: p.y + h / 2, r: 4, max: 60, t: 0, dur: 0.45, c: rgbOf(p) });
    if (reduce()) p.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 }); else unfold(p);
    setTimeout(() => { if (p.mode === 'entering') p.mode = 'rest'; }, 450);
    layout();
    remember(p);
    wake();
  }

  // ---- Click for details: the panel unfolds in place into a detail card -----------------------------------------
  const CARD_W = 300;
  let card = null; // { p, el, parts, timer, sig, closing }
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function openCard(p) {
    if (card?.p === p) { closeCard(); return; }
    if (card) closeCard();
    if (p.mode !== 'rest') return;
    const d = details(p);
    if (!d) return p.spec.onClick?.();
    p.mode = 'detail';
    p.el.style.visibility = 'hidden';
    const el = document.createElement('div');
    el.className = 'dp-card';
    el.style.setProperty('--c', rgbOf(p));
    el.innerHTML = `<i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br bo"></i>
      <div class="dc-in"><div class="dp-head"><span class="dc-label"></span><span class="dc-tag"></span></div>
        <div class="dc-value"></div><div class="dc-rows"></div><div class="dc-text"></div><div class="dc-actions"></div></div>`;
    const q = (sel) => el.querySelector(sel);
    card = { p, el, parts: { inner: q('.dc-in'), label: q('.dc-label'), tag: q('.dc-tag'), value: q('.dc-value'), rows: q('.dc-rows'), text: q('.dc-text'), actions: q('.dc-actions') }, sig: '' };
    layer.appendChild(el);
    renderCard(d, true);
    // Where it opens: over the panel, growing away from the window edge, kept inside the stage
    const { w, h } = size();
    const ch = Math.min(el.offsetHeight, H - 16);
    const cx = clamp(p.side === 'right' || center(p).x > W / 2 ? p.x + w - CARD_W : p.x, 8, W - CARD_W - 8);
    const cy = clamp(p.y, 8, H - ch - 8);
    Object.assign(el.style, { left: `${cx}px`, top: `${cy}px`, width: `${CARD_W}px`, maxHeight: `${H - 16}px` });
    card.home = { left: p.x, top: p.y, width: w, height: h };
    card.box = { left: cx, top: cy, width: CARD_W, height: ch };
    card.timer = setInterval(() => { if (card?.p === p) renderCard(details(p)); }, 1000);
    if (d.load) d.load().then(() => card?.p === p && renderCard(details(p)));
    blip(p.spec.kind);
    if (reduce()) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 }); return; }
    // The launch unfold, with the brackets widening: panel → a wide line → the full card, slight overshoot
    const px = (b) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    const line = { ...card.box, top: p.y + h / 2 - 1, height: 2 };
    el.style.height = `${ch}px`;
    el.animate([
      { ...px(card.home), filter: 'brightness(1.6)' },
      { ...px({ ...line, left: card.home.left + (card.box.left - card.home.left) * 0.5, width: (card.home.width + CARD_W) / 2 }), offset: 0.2 },
      { ...px(line), filter: 'brightness(2.2)', offset: 0.42 },
      { ...px({ ...card.box, top: card.box.top - 2, height: ch + 4 }), filter: 'brightness(1.3)', offset: 0.8 },
      { ...px(card.box), filter: 'brightness(1)' },
    ], { duration: 460, easing: 'cubic-bezier(.3,.7,.4,1)' }).finished.then(() => { if (card?.el === el) el.style.height = ''; }, () => {});
    card.parts.inner.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: 520 });
    for (const k of ['label', 'tag', 'value']) decode(card.parts[k], 480);
  }

  /** Fold the card back into its panel. Resolves once the panel is showing again. */
  function closeCard() {
    if (!card || card.closing) return card?.closing || Promise.resolve();
    const c = card;
    clearInterval(c.timer);
    const p = c.p;
    const done = () => {
      c.el.remove();
      if (card === c) card = null;
      if (p.mode === 'detail') p.mode = 'rest';
      p.el.style.visibility = '';
      if (p.expires) p.expires = Math.max(p.expires, Date.now() + 5000); // a memory flash gets a moment more after reading
      if (!reduce()) flash(p);
      wake();
    };
    if (reduce()) { c.closing = c.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished.then(done, done); return c.closing; }
    const px = (b) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    const now = { left: c.el.offsetLeft, top: c.el.offsetTop, width: c.el.offsetWidth, height: c.el.offsetHeight };
    const home = { left: p.x, top: p.y, width: size().w, height: size().h };
    c.parts.inner.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' });
    c.closing = c.el.animate([
      { ...px(now), filter: 'brightness(1)' },
      { ...px({ ...now, top: now.top + now.height / 2 - 1, height: 2 }), filter: 'brightness(2.2)', offset: 0.5 },
      { ...px({ ...home, top: home.top + home.height / 2 - 1, height: 2 }), offset: 0.75 },
      { ...px(home), filter: 'brightness(1.4)' },
    ], { duration: 340, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' }).finished.then(done, done);
    return c.closing;
  }

  function renderCard(d, first = false) {
    if (!card || !d) return;
    const P = card.parts;
    setText(P.label, up(d.label));
    setText(P.tag, up(d.tag));
    setText(P.value, d.value);
    P.value.hidden = !d.value;
    P.rows.innerHTML = (d.rows || []).filter((r) => r && r[1]).map(([k, v, link]) =>
      `<div class="dc-row"><b>${esc(k)}</b>${link ? `<a data-url="${esc(link)}">${esc(v)}</a>` : `<span>${esc(v)}</span>`}</div>`).join('');
    // Scrolling text (transcripts, progress): keep the reader's place unless they're at the bottom
    const T = P.text;
    const atEnd = T.scrollTop + T.clientHeight >= T.scrollHeight - 4;
    const html = (d.text || []).map((t) => (typeof t === 'string' ? `<p>${esc(t)}</p>`
      : t.html ? t.html : `<p${t.cls ? ` class="${t.cls}"` : ''}>${t.who ? `<b>${esc(t.who)}</b> ` : ''}${esc(t.t)}</p>`)).join('');
    if (T.innerHTML !== html && !T.querySelector('textarea')) { T.innerHTML = html; if (first || atEnd) T.scrollTop = T.scrollHeight; }
    T.hidden = !html && !T.querySelector('textarea');
    // Actions: only rebuilt when they change (so a pending "sure?" isn't wiped by the once-a-second refresh)
    const sig = (d.actions || []).map((a) => a.label).join('|');
    if (sig !== card.sig && !P.actions.querySelector('.confirming')) {
      card.sig = sig;
      P.actions.innerHTML = '';
      for (const a of d.actions || []) {
        const b = document.createElement('button');
        b.className = `dc-btn${a.danger ? ' danger' : ''}`;
        b.textContent = b.dataset.label = a.label;
        b.title = a.title || '';
        b.addEventListener('click', (e) => { e.stopPropagation(); runAction(a, b); });
        P.actions.appendChild(b);
      }
    }
    P.actions.hidden = !P.actions.children.length;
  }

  /** Changing or deleting something here asks once more ("SURE? YES"): the click-through form of the "yes" gate. */
  function runAction(a, b) {
    // Any other click drops a pending "sure?"
    for (const x of card?.parts.actions.querySelectorAll('.confirming') || []) {
      if (x !== b) { clearTimeout(x.t); x.classList.remove('confirming'); x.textContent = x.dataset.label; }
    }
    if (a.confirm && !b.classList.contains('confirming')) {
      b.classList.add('confirming');
      b.textContent = `${a.confirm} YES`;
      clearTimeout(b.t);
      b.t = setTimeout(() => { b.classList.remove('confirming'); b.textContent = a.label; }, 4000);
      return;
    }
    clearTimeout(b.t);
    b.classList.remove('confirming');
    Promise.resolve(a.run()).then((r) => {
      if (a.say) say(a.say, card?.p.spec.kind || 'day');
      if (a.close !== false && r !== false) closeCard();
      else if (card) renderCard(details(card.p));
    });
  }
  layer.addEventListener('click', (e) => {
    const u = e.target.closest?.('[data-url]');
    if (u) { e.stopPropagation(); act('url', { url: u.dataset.url }); }
  });
  // Click outside the card folds it back (a click on another panel then opens that one)
  addEventListener('pointerdown', (e) => { if (card && !card.el.contains(e.target)) closeCard(); }, true);

  const act = (action, arg) => window.ares.dash.act(action, arg);
  /** Something that sends or changes things outside ARES: said to ARES as a typed request, so the brain's "yes" gate applies. */
  const ask = (text) => { window.dispatchEvent(new CustomEvent('ares-ask', { detail: text })); return true; };
  const maps = (loc) => `https://maps.apple.com/?daddr=${encodeURIComponent(loc)}&dirflg=d`;
  const physical = (loc) => loc && !/https?:|zoom|meet\.google|teams|webex|hangout|facetime|^online$|^virtual$|^phone/i.test(loc);
  const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return t >= 3600 ? `${Math.floor(t / 3600)}:${pad2(Math.floor((t % 3600) / 60))}:${pad2(t % 60)}` : `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`; };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const cache = new Map(); // detail data fetched from the main process: 'call:<id>' / 'job:<id>' -> { at, value }
  const fetched = (key, fn, maxAge) => {
    const c = cache.get(key);
    const load = () => fn().then((v) => { cache.set(key, { at: Date.now(), value: v }); return v; }, () => null);
    return { value: c?.value, load: !c || Date.now() - c.at > maxAge ? load : null };
  };

  /** What a panel's card shows: { label, tag, value, rows: [[key, value, link?]], text, actions, load? }. */
  function details(p) {
    const s = p.spec;
    const d = s.info || {};
    const base = { label: s.label, tag: s.tag, value: s.value };
    const now = Date.now();
    switch (d.type) {
      case 'next': {
        const ev = d.ev;
        const loc = ev.location || '';
        return { ...base, value: ev.title,
          rows: [['When', `${hhmm(ev.start)} → ${hhmm(ev.end)}${ev.start > now ? ` · in ${countdown(ev.start - now).slice(2)}${ev.start - now < 100 * 60_000 ? ' MIN' : ''}` : ' · now'}`],
            ['Where', loc], ['With', (ev.attendees || []).join(', ')], ['Join', ev.link ? host(ev.link) : '', ev.link]],
          text: ev.notes ? [ev.notes] : [],
          actions: [
            physical(loc) && { label: 'DIRECTIONS', run: () => act('url', { url: maps(loc) }) },
            ev.link && { label: 'JOIN', run: () => act('url', { url: ev.link }) },
            ev.start > now && { label: 'REMIND ME LATER', title: '15 minutes before it starts',
              run: () => act('remind', { label: ev.title, seconds: Math.max(60, (ev.start - now) / 1000 - 15 * 60) }),
              say: `reminder set for ${hhmm(Math.max(now + 60_000, ev.start - 15 * 60_000))}` },
          ].filter(Boolean) };
      }
      case 'timer': {
        const tm = data.timers.find((t) => t.label === d.label);
        if (!tm) return null;
        const left = tm.paused ? tm.left : tm.endsAt - now;
        return { ...base, value: mmss(left), tag: tm.paused ? 'PAUSED' : s.tag,
          rows: [['Timer', tm.label === 'timer' ? '' : tm.label], ['Started', tm.started ? hhmm(tm.started) : ''],
            ['Length', mmss(tm.total)], ['Ends', tm.paused ? 'paused' : hhmm(tm.endsAt)]],
          actions: [
            { label: tm.paused ? 'RESUME' : 'PAUSE', run: () => act('timer', { label: tm.label, op: tm.paused ? 'resume' : 'pause' }), close: false },
            { label: '+5 MIN', run: () => act('timer', { label: tm.label, op: 'add' }), close: false },
            { label: 'CANCEL', danger: true, run: () => act('timer', { label: tm.label, op: 'cancel' }) },
          ] };
      }
      case 'leave': {
        const lv = data.leave;
        if (!lv) return null;
        const who = lv.attendees?.length ? lv.attendees.join(', ') : `the people I'm meeting for ${lv.title}`;
        return { ...base, value: `LEAVE ${hhmm(lv.at)}`,
          rows: [['For', `${lv.title} · ${hhmm(lv.start)}`], ['To', lv.location], ['Drive', lv.drive ? `${lv.drive} min${lv.distance ? ` · ${lv.distance}` : ''}` : `about ${lv.minutes} min (guess)`],
            ['Via', (lv.via || []).join(' → ')], ['From', lv.estimate ? 'city centre (set your home address)' : 'home']],
          actions: [
            { label: 'OPEN IN MAPS', run: () => act('url', { url: maps(lv.location) }) },
            { label: "TEXT I'M LATE", title: 'ARES drafts it and asks before sending', run: () => ask(`Text ${who} that I'm running a few minutes late for ${lv.title}.`) },
          ] };
      }
      case 'work': case 'result': {
        const j = data.jobs.find((x) => x.id === d.id);
        if (!j) return null;
        const f = fetched(`job:${j.id}`, () => window.ares.work.detail(j.id), 3000);
        const events = f.value?.events || [];
        const steps = events.filter((e) => e.type === 'step' || e.type === 'note').slice(-6);
        const sources = [...new Map(events.filter((e) => e.url).map((e) => [host(e.url), e.url])).entries()].slice(-5);
        const ask4 = j.status === 'approval';
        const mins = j.started ? Math.round(((j.finished || now) - j.started) / 60_000) : 0;
        return { ...base, value: j.title, load: f.load,
          rows: [['Status', ask4 ? `needs your OK: ${j.approval?.what || ''}` : j.status === 'running' ? `working · ${jobPct(j)}%` : j.status],
            ['Step', j.status === 'running' ? data.steps.get(j.id) || '' : ''], ['Time', mins ? `${mins} min` : ''],
            ...sources.map(([h, u], i) => [i ? '' : 'Sources', h, u])],
          text: steps.map((e) => ({ t: e.text, cls: e.type })),
          actions: [
            ask4 && { label: 'APPROVE', run: () => window.ares.work.answer(j.id, true), say: 'approved.' },
            ask4 && { label: 'DECLINE', danger: true, run: () => window.ares.work.answer(j.id, false) },
            { label: 'OPEN IN WORK', run: () => window.dispatchEvent(new CustomEvent('orb-open', { detail: j.id })) },
            ['running', 'queued', 'approval'].includes(j.status) && { label: 'CANCEL JOB', danger: true, confirm: 'SURE?', run: () => window.ares.work.cancel(j.id), say: 'job cancelled.' },
          ].filter(Boolean) };
      }
      case 'call': {
        const f = fetched(`call:${d.id}`, () => act('call-details', { id: d.id }), p.id === 'call' ? 2500 : 60_000);
        const c = f.value;
        const live = p.id === 'call';
        const lines = c?.transcript || [];
        return { ...base, value: c?.name || s.value, load: f.load,
          rows: [['Status', live ? 'live now' : c?.direction === 'inbound' ? 'called you' : 'finished'],
            ['When', c?.at ? hhmm(c.at) : ''], ['Length', c?.secs ? mmss(c.secs * 1000) : ''], ['Number', c?.callback || c?.number || '']],
          text: [...(!live && (c?.result || s.detail) ? [{ t: c?.result || s.detail, cls: 'summary' }] : []),
            ...lines.map((l) => ({ who: l.who, t: l.text })), ...(live && !lines.length ? ['(the transcript appears as they talk)'] : [])],
          actions: [
            !live && { label: 'CALL BACK', title: 'ARES confirms before calling', run: () => ask(`Call ${c?.name || s.value} back${c?.callback ? ` on ${c.callback}` : ''}.`) },
            !live && { label: 'TEXT BACK', title: 'ARES drafts it and asks before sending', run: () => ask(`Text ${c?.name || s.value} back${c?.callback ? ` on ${c.callback}` : ''}.`) },
            lines.length && { label: 'OPEN TRANSCRIPT', run: () => act('call-transcript', { id: d.id }), close: false },
          ].filter(Boolean) };
      }
      case 'music': {
        const m = data.music;
        if (!m) return null;
        const pos = m.playing ? Math.min(m.dur || Infinity, m.pos + (now - m.at) / 1000) : m.pos;
        return { ...base, value: m.title, tag: m.playing ? m.app : 'PAUSED',
          rows: [['Artist', m.artist], ['Album', m.album], ['Time', m.dur ? `${mmss(pos * 1000)} / ${mmss(m.dur * 1000)}` : '']],
          actions: [
            { label: m.playing ? 'PAUSE' : 'PLAY', run: () => act('music', { op: 'toggle' }), close: false },
            { label: 'SKIP', run: () => act('music', { op: 'next' }), close: false },
            { label: `OPEN ${up(m.app)}`, run: () => act('music', { op: 'open' }) },
          ] };
      }
      case 'memory': {
        const editing = card?.p === p && card.editing;
        return { ...base, value: '',
          text: editing ? [] : [d.fact],
          actions: editing
            ? [{ label: 'SAVE', run: () => saveEdit(p), close: false }, { label: 'CANCEL', run: () => { card.editing = false; card.parts.text.innerHTML = ''; }, close: false }]
            : [{ label: 'EDIT', run: () => startEdit(p), close: false },
              { label: 'FORGET', danger: true, confirm: 'FORGET?', run: () => act('memory-forget', { fact: d.fact }).then((ok) => { if (ok) { dismissed.add(p.spec.dismissKey || p.id); setTimeout(() => hide(p.id), 380); } return ok; }), say: 'forgotten.' }] };
      }
      case 'mail': {
        const mails = data.emails;
        if (!mails.length) return null;
        return { ...base, value: '',
          text: mails.map((m) => ({ html: `<div class="dc-mail"><b>${esc(m.from)}</b><i>${esc(m.subject)}</i><p>${esc(m.summary)}</p>
            <span><button class="dc-btn" data-mail="open" data-id="${esc(m.id)}">OPEN IN GMAIL</button><button class="dc-btn" data-mail="draft" data-id="${esc(m.id)}" title="Only drafts it; nothing is sent">DRAFT A REPLY</button></span></div>` })),
          actions: [] };
      }
    }
    return null;
  }
  // INBOX buttons live inside each email's block
  layer.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-mail]');
    if (!b) return;
    e.stopPropagation();
    const m = data.emails.find((x) => x.id === b.dataset.id);
    if (!m) return;
    if (b.dataset.mail === 'open') act('url', { url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.id)}` });
    else { ask(`Draft a reply to the email from ${m.from} about "${m.subject}". Only create a draft, don't send it.`); closeCard(); }
  });
  function startEdit(p) {
    card.editing = true;
    const ta = document.createElement('textarea');
    ta.className = 'dc-edit';
    ta.value = p.spec.info.fact;
    card.parts.text.innerHTML = '';
    card.parts.text.appendChild(ta);
    card.parts.text.hidden = false;
    renderCard(details(p));
    ta.focus();
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(p); } e.stopPropagation(); });
  }
  async function saveEdit(p) {
    const ta = card?.parts.text.querySelector('textarea');
    if (!ta) return false;
    const fact = await act('memory-edit', { old: p.spec.info.fact, fact: ta.value });
    if (!fact) return false;
    card.editing = false;
    card.parts.text.innerHTML = '';
    show(p.id, { value: fact, info: { type: 'memory', fact } });
    say('memory updated.', 'work');
    return true;
  }

  // ---- The effects canvas and the motion loop (runs only while something moves) --------------------------------
  const beams = [];   // spark + fading beam + particle stream
  const rings = [];   // shockwaves and ring bursts
  const sparks = [];  // particles
  const fxJobs = [];  // per-frame callbacks (scan-line sparks); return false when finished
  let raf = null;
  let lastT = 0;
  const fxGate = Perf.gate();
  function sizeFx() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    fxCanvas.width = stage.clientWidth * dpr;
    fxCanvas.height = stage.clientHeight * dpr;
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function wake() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!fxGate(t)) return;
    const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0.016);
    lastT = t;
    const f = dt * 60; // physics constants are per 60 fps frame
    let busy = step(dt, f, t);
    busy = drawFx(dt, t) || busy;
    if (!busy) { cancelAnimationFrame(raf); raf = null; fx.clearRect(0, 0, W, H); }
  }

  function step(dt, f, t) {
    let busy = false;
    const b = brain();
    const { w, h } = size();
    let hover = 0;
    for (const p of panels.values()) {
      if (p.mode === 'rest' || p.mode === 'entering') {
        // Glide toward home (tier changes, tidy up, window resizes)
        const dx = p.tx - p.x, dy = p.ty - p.y;
        if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) {
          const k = 1 - Math.pow(0.84, f);
          p.x += dx * k; p.y += dy * k;
          position(p);
          busy = true;
        } else if (dx || dy) { p.x = p.tx; p.y = p.ty; position(p); }
        continue;
      }
      if (p.mode === 'orb') {
        busy = true;
        hover = Math.max(hover, 1 - clamp((Math.hypot(p.ox - b.x, p.oy - b.y) - 40) / 140, 0, 1));
        p.trail.push([p.ox, p.oy]);
        if (p.trail.length > 10) p.trail.shift();
        continue;
      }
      if (p.mode === 'flying' || p.mode === 'docking') {
        busy = true;
        if (p.mode === 'docking') {
          const sx = p.dock.x + w / 2, sy = p.dock.y + h / 2;
          p.vx = (p.vx + (sx - p.ox) * 0.08 * f) * Math.pow(0.78, f);
          p.vy = (p.vy + (sy - p.oy) * 0.08 * f) * Math.pow(0.78, f);
          if (occupied(p.dock, p)) p.mode = 'flying';
          else if (Math.hypot(sx - p.ox, sy - p.oy) < 1.2 && Math.hypot(p.vx, p.vy) < 0.4) { p.ox = sx; p.oy = sy; land(p, p.dock); continue; }
        } else {
          const fr = Math.pow(PHYS.friction, f);
          p.vx *= fr; p.vy *= fr;
        }
        p.ox += p.vx * f; p.oy += p.vy * f;
        const R = PHYS.orbR;
        if (p.ox < R) { p.ox = R; p.vx = Math.abs(p.vx) * PHYS.bounce; }
        if (p.ox > W - R) { p.ox = W - R; p.vx = -Math.abs(p.vx) * PHYS.bounce; }
        if (p.oy < R) { p.oy = R; p.vy = Math.abs(p.vy) * PHYS.bounce; }
        if (p.oy > H - R) { p.oy = H - R; p.vy = -Math.abs(p.vy) * PHYS.bounce; }
        // Bounce off resting panels (circle vs rect); they flash
        for (const q of resting()) {
          const nx = clamp(p.ox, q.x, q.x + w), ny = clamp(p.oy, q.y, q.y + h);
          const dx = p.ox - nx, dy = p.oy - ny, d = Math.hypot(dx, dy);
          if (d >= R || p.mode === 'docking') continue;
          const ux = d ? dx / d : 0, uy = d ? dy / d : -1;
          p.ox = nx + ux * R; p.oy = ny + uy * R;
          const vn = p.vx * ux + p.vy * uy;
          if (vn < 0) { p.vx -= (1 + PHYS.bounce) * vn * ux; p.vy -= (1 + PHYS.bounce) * vn * uy; }
          q.el.classList.remove('hit'); void q.el.offsetWidth; q.el.classList.add('hit');
        }
        if (Math.hypot(p.ox - b.x, p.oy - b.y) < PHYS.brainCatch) { absorb(p); continue; }
        p.trail.push([p.ox, p.oy]);
        if (p.trail.length > 14) p.trail.shift();
        const sp = Math.hypot(p.vx, p.vy);
        if (p.mode === 'flying' && prefs.magnetic && sp < PHYS.dock) {
          const s = nearestSlot(p.ox, p.oy, p, PHYS.dockReach);
          if (s) { p.mode = 'docking'; p.dock = s; }
        }
        if (p.mode === 'flying' && sp < PHYS.unfold) land(p, null);
        continue;
      }
      if (p.mode === 'absorbing') {
        busy = true;
        const a = p.abs;
        a.t += dt / 0.45;
        const k = Math.min(1, a.t);
        const r = a.r0 * (1 - k * k);
        const ang = a.a0 + k * 5;
        p.ox = b.x + Math.cos(ang) * r; p.oy = b.y + Math.sin(ang) * r;
        p.orbScale = 1 - k;
        p.trail.push([p.ox, p.oy]);
        if (p.trail.length > 12) p.trail.shift();
        if (k >= 1) {
          HUD.pulse(1.7);
          rings.push({ x: b.x, y: b.y, r: b.r * 0.5, max: b.r * 1.5, t: 0, dur: 0.7, c: rgbOf(p) });
          blip(p.spec.kind);
          drop(p);
        }
      }
    }
    // Resting panels that overlap push gently apart (docked ones hold their slot)
    const rest = resting().filter((p) => p.mode === 'rest');
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const A = rest[i], B = rest[j];
        const ox = Math.min(A.tx + w, B.tx + w) - Math.max(A.tx, B.tx);
        const oy = Math.min(A.ty + h, B.ty + h) - Math.max(A.ty, B.ty);
        if (ox <= 0 || oy <= 0) continue;
        const [mx, my] = ox < oy ? [Math.sign(A.tx - B.tx || 1) * Math.min(ox, 2), 0] : [0, Math.sign(A.ty - B.ty || 1) * Math.min(oy, 2)];
        const movers = [A, B].filter((p) => !p.slot);
        if (!movers.length) continue;
        for (const p of movers) {
          const s = p === A ? 1 : -1;
          const nx = clamp(p.tx + (mx * s) / movers.length, PAD / 2, W - w - PAD / 2);
          const ny = clamp(p.ty + (my * s) / movers.length, 4, H - h - 4);
          if (nx !== p.tx || ny !== p.ty) busy = true; // (pinned against a wall: stop trying)
          p.tx = nx; p.ty = ny;
        }
      }
    }
    // Free panels never settle on the brain (a window resize can bring it to them): nudge them away
    for (const p of rest) {
      if (p.slot || !rectHitsCircle(p.tx, p.ty, w, h, b)) continue;
      const dx = p.tx + w / 2 - b.x, dy = p.ty + h / 2 - b.y, d = Math.hypot(dx, dy) || 1;
      const nx = clamp(p.tx + (dx / d) * 3, PAD / 2, W - w - PAD / 2);
      const ny = clamp(p.ty + (dy / d) * 3, 4, H - h - 4);
      if (nx !== p.tx || ny !== p.ty) busy = true;
      p.tx = nx; p.ty = ny;
    }
    // Carrying an orb near the brain: it brightens, and says what letting go will do
    HUD.hover(hover);
    const showHint = hand.p && hover > 0.45;
    if (showHint !== !closeHint.hidden) closeHint.hidden = !showHint;
    if (showHint) { closeHint.style.left = `${b.x}px`; closeHint.style.top = `${Math.max(8, b.y - brainR() - 30)}px`; }
    return busy;
  }

  function drawFx(dt, t) {
    fx.clearRect(0, 0, W, H);
    fx.save();
    fx.globalCompositeOperation = 'lighter';
    let busy = false;
    for (let i = fxJobs.length - 1; i >= 0; i--) { if (!fxJobs[i](t)) fxJobs.splice(i, 1); else busy = true; }
    // Beams: a bright spark on a slight curve, trailing a fading beam and a particle stream
    for (let i = beams.length - 1; i >= 0; i--) {
      const m = beams[i];
      busy = true;
      m.t += dt / m.dur;
      const k = Math.min(1, m.t);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const mx = (m.x0 + m.x1) / 2 - (m.y1 - m.y0) * 0.18, my = (m.y0 + m.y1) / 2 + (m.x1 - m.x0) * 0.18;
      const x = (1 - e) * (1 - e) * m.x0 + 2 * (1 - e) * e * mx + e * e * m.x1;
      const y = (1 - e) * (1 - e) * m.y0 + 2 * (1 - e) * e * my + e * e * m.y1;
      m.trail.push([x, y]);
      if (m.trail.length > 18) m.trail.shift();
      for (let j = 1; j < m.trail.length; j++) {
        fx.strokeStyle = `rgba(${m.c},${(j / m.trail.length) * 0.7})`;
        fx.lineWidth = 1 + (j / m.trail.length) * 1.6;
        fx.beginPath(); fx.moveTo(...m.trail[j - 1]); fx.lineTo(...m.trail[j]); fx.stroke();
      }
      if (Math.random() < 0.8) sparks.push({ x, y, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, life: 0, max: 0.4, c: m.c, s: 1.1 });
      glow(x, y, 9, m.c, 1);
      if (m.t >= 1) { beams.splice(i, 1); m.done?.(); }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      busy = true;
      r.t += dt / r.dur;
      if (r.t >= 1) { rings.splice(i, 1); continue; }
      const k = 1 - Math.pow(1 - r.t, 3);
      fx.lineWidth = 1.5 * (1 - r.t) + 0.5;
      fx.strokeStyle = `rgba(${r.c},${(1 - r.t) * 0.8})`;
      fx.beginPath(); fx.arc(r.x, r.y, r.r + (r.max - r.r) * k, 0, Math.PI * 2); fx.stroke();
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      busy = true;
      s.life += dt;
      if (s.life > s.max) { sparks.splice(i, 1); continue; }
      s.x += s.vx * dt; s.y += s.vy * dt;
      fx.fillStyle = `rgba(${s.c},${1 - s.life / s.max})`;
      fx.fillRect(s.x - s.s / 2, s.y - s.s / 2, s.s, s.s);
    }
    // Orbs: smaller, brighter and labelled, so they can't be confused with the job orbs
    for (const p of panels.values()) {
      if (!['orb', 'flying', 'docking', 'absorbing'].includes(p.mode)) continue;
      busy = true;
      const c = rgbOf(p);
      const scale = p.mode === 'absorbing' ? p.orbScale : 1;
      p.orbA = Math.min(1, (p.orbA || 0) + dt * 6);
      for (let j = 1; j < p.trail.length; j++) {
        fx.strokeStyle = `rgba(${c},${(j / p.trail.length) * 0.45 * p.orbA})`;
        fx.lineWidth = (j / p.trail.length) * 5 * scale;
        fx.beginPath(); fx.moveTo(...p.trail[j - 1]); fx.lineTo(...p.trail[j]); fx.stroke();
      }
      glow(p.ox, p.oy, PHYS.orbR * 2.4 * scale, c, p.orbA);
      fx.fillStyle = `rgba(255,255,255,${0.95 * p.orbA})`;
      fx.beginPath(); fx.arc(p.ox, p.oy, 3.2 * scale, 0, Math.PI * 2); fx.fill();
      fx.strokeStyle = `rgba(${c},${0.9 * p.orbA})`;
      fx.lineWidth = 1.2;
      fx.beginPath(); fx.arc(p.ox, p.oy, PHYS.orbR * scale, 0, Math.PI * 2); fx.stroke();
      if (scale > 0.5) {
        fx.globalCompositeOperation = 'source-over';
        fx.font = '600 8px "SF Mono", Menlo, monospace';
        fx.textAlign = 'center';
        fx.fillStyle = `rgba(${c},${0.95 * p.orbA})`;
        fx.fillText(up(p.spec.short || p.spec.label).split('').join(' '), p.ox, p.oy - PHYS.orbR - 6);
        fx.globalCompositeOperation = 'lighter';
      }
    }
    fx.restore();
    return busy;
  }
  function glow(x, y, r, c, a) {
    const g = fx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.9 * a})`);
    g.addColorStop(0.25, `rgba(${c},${0.8 * a})`);
    g.addColorStop(1, `rgba(${c},0)`);
    fx.fillStyle = g;
    fx.beginPath(); fx.arc(x, y, r, 0, Math.PI * 2); fx.fill();
  }

  new ResizeObserver(() => { sizeFx(); layout(); wake(); }).observe(stage);
  sizeFx();

  // Double-click on empty space: every panel glides back home
  core.addEventListener('dblclick', (e) => {
    if (window.JobOrbs?.pick?.(e.clientX, e.clientY)) return;
    tidy();
  });

  // ---- Data → panels --------------------------------------------------------------------------------------------
  const data = { events: [], leave: null, music: null, timers: [], call: null, jobs: [], steps: new Map(), emails: [] };
  const EST = { small: 4, medium: 10, large: 25 }; // minutes: a rough job length when the worker keeps no checklist

  function countdown(ms) {
    const m = Math.max(0, Math.round(ms / 60_000));
    return m < 100 ? `T-${m}` : `T-${Math.floor(m / 60)}H${pad2(m % 60)}`;
  }
  function jobPct(j) {
    if (j.progress?.total) return Math.round((j.progress.done / j.progress.total) * 100);
    if (!j.started) return 0;
    const mins = (Date.now() - j.started) / 60_000;
    return Math.min(92, Math.round(100 * (1 - Math.exp(-mins / (EST[j.size] || 10)))));
  }

  /** Rebuild every data-driven panel from the latest state (runs every second, and on each change). */
  function reconcile() {
    const now = Date.now();
    const want = new Map();

    // NEXT: the event in progress, or the next one starting within 12 hours
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const timed = data.events.filter((e) => !e.allDay && e.end > now);
    const ev = timed.find((e) => e.start <= now) || timed.find((e) => e.start - now < 12 * 3_600_000);
    if (ev) {
      const left = timed.filter((e) => e.start <= today.getTime()).length;
      const live = ev.start <= now;
      const name = ev.title.length > 14 ? ev.title.split(/\s+/)[0] : ev.title;
      want.set('next', {
        kind: 'day', side: 'left', anim: 'materialize', label: live ? 'NOW' : 'NEXT', tag: pad2(left || 1), short: name.slice(0, 8),
        value: live ? `${ev.title}` : `${ev.title} · ${countdown(ev.start - now)}`, miniValue: live ? 'NOW' : countdown(ev.start - now),
        detail: live ? `UNTIL ${hhmm(ev.end)}` : `${hhmm(ev.start)} → ${hhmm(ev.end)}${ev.location ? ` · ${ev.location.split(',')[0]}` : ''}`,
        gauge: { type: 'arc', v: live ? (now - ev.start) / (ev.end - ev.start) : 1 - (ev.start - now) / (2 * 3_600_000) },
        dismissKey: `next:${ev.title}:${ev.start}`, info: { type: 'next', ev },
      });
    }

    // LEAVE BY: only in the 45 minutes before it matters; amber once it's time to go
    const lv = data.leave;
    if (lv && now > lv.at - 45 * 60_000 && now < lv.start) {
      const late = now >= lv.at - 5 * 60_000;
      want.set('leave', {
        kind: late ? 'needs' : 'day', side: 'left', anim: 'materialize', label: 'LEAVE BY', tag: `${lv.minutes}M`, short: 'LEAVE',
        value: hhmm(lv.at), detail: `${lv.place}${lv.estimate ? ' · EST' : ''}`,
        gauge: { type: 'arc', v: 1 - (lv.at - now) / (45 * 60_000) }, dismissKey: `leave:${lv.key}`, info: { type: 'leave' },
      });
    }

    // TIMERS
    data.timers.forEach((tm, i) => {
      const ms = Math.max(0, tm.paused ? tm.left : tm.endsAt - now);
      const s = Math.ceil(ms / 1000);
      const text = s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}` : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
      want.set(`timer:${tm.label}`, {
        kind: 'day', side: 'left', anim: 'materialize', label: 'TIMER', tag: tm.paused ? 'PAUSED' : pad2(i + 1), short: tm.label === 'timer' ? 'TIMER' : tm.label.slice(0, 8),
        value: text, detail: tm.label === 'timer' ? '' : tm.label, gauge: { type: 'arc', v: tm.total ? ms / tm.total : 0 },
        dismissKey: `timer:${tm.label}:${tm.started}`, info: { type: 'timer', label: tm.label },
      });
    });

    // WORK: each running job (amber when it needs a yes)
    let needsYes = false;
    for (const j of data.jobs.filter((x) => ['running', 'queued', 'approval'].includes(x.status))) {
      const pct = jobPct(j);
      const ask = j.status === 'approval';
      needsYes ||= ask;
      want.set(`work:${j.id}`, {
        kind: ask ? 'needs' : 'work', side: 'right', anim: 'launch', label: ask ? 'NEEDS YOU' : 'WORK',
        tag: ask ? 'OK?' : j.status === 'queued' ? 'QUEUED' : `${pct}%`, short: ask ? 'OK?' : 'WORK',
        value: j.title, miniValue: ask ? 'OK?' : `${pct}%`,
        detail: ask ? (j.approval?.what || 'waiting for your yes') : data.steps.get(j.id) || (j.status === 'queued' ? 'waiting its turn' : 'starting'),
        gauge: { type: 'arc', v: ask ? 1 : pct / 100 }, info: { type: 'work', id: j.id },
      });
    }

    // CALL: live while the phone agent is on a call
    if (data.call?.live) {
      const secs = Math.floor((now - (data.call.since || now)) / 1000);
      want.set('call', {
        kind: 'call', side: 'right', anim: 'launch', label: 'CALL', tag: 'LIVE', short: 'CALL',
        value: data.call.name, detail: `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`, gauge: { type: 'eq' }, miniValue: 'LIVE',
        dismissKey: `call:${data.call.id}`, ...(data.call.id && { info: { type: 'call', id: data.call.id } }),
      });
    }

    // NOW PLAYING
    // NOW PLAYING (and for five minutes after it's paused, so play is one click away)
    const m = data.music;
    if (m && (m.playing || now - (m.pausedAt || now) < 5 * 60_000 || card?.p.id === 'music')) {
      const pos = m.playing ? Math.min(m.dur || Infinity, m.pos + (now - m.at) / 1000) : m.pos;
      want.set('music', {
        kind: 'day', side: 'right', anim: 'materialize', label: m.playing ? 'NOW PLAYING' : 'PAUSED', tag: m.app, short: 'MUSIC',
        value: m.title, detail: m.artist, gauge: { type: 'arc', v: m.dur ? pos / m.dur : 0 }, dismissKey: `music:${m.title}`, info: { type: 'music' },
      });
    }

    // INBOX: important unread emails (amber)
    const mails = data.emails;
    if (mails.length) {
      want.set('inbox:mail', {
        kind: 'needs', side: 'right', anim: 'launch', label: 'INBOX', tag: pad2(mails.length), short: 'INBOX',
        value: mails[0].from || mails[0].subject, detail: mails[0].subject, miniValue: `${mails.length} NEW`,
        dismissKey: `mail:${mails.map((x) => x.id).join(',')}`, info: { type: 'mail' },
      });
    }

    for (const [id, spec] of want) show(id, { ...spec, managed: true });
    for (const p of panels.values()) {
      if (p.spec.managed && !want.has(p.id)) hide(p.id);
      if (p.expires && now > p.expires && p.mode !== 'detail') hide(p.id); // not while it's being read
    }
    HUD.attention(needsYes);
  }
  setInterval(() => { if (!document.hidden) reconcile(); }, 1000);

  // Things ARES creates: launched from the brain, and gone after a while
  function transient(id, spec) { show(id, { anim: 'launch', side: 'right', ...spec }); blip(spec.kind); }

  window.ares.dash.on((msg) => {
    switch (msg.type) {
      case 'weather': setWeather(msg.weather); break;
      case 'events': data.events = msg.events || []; break;
      case 'leave': data.leave = msg.leave; break;
      case 'music': data.music = msg.music; break;
      case 'timers': data.timers = msg.timers || []; break;
      case 'call': data.call = msg.call; if (msg.call?.live) say(`on a call with ${msg.call.name}…`, 'call'); break;
      case 'call-done':
        data.call = null;
        transient(`callsum:${msg.id}`, { kind: 'call', label: 'CALL · DONE', tag: 'SUMMARY', short: 'CALL', value: msg.name, detail: msg.line, ttl: 3 * 60_000, info: { type: 'call', id: msg.id } });
        break;
      case 'memory':
        transient('memory', { kind: 'work', label: 'REMEMBERED', tag: 'MEM', short: 'MEM', value: msg.fact, detail: '', ttl: 5000, dismissKey: `mem:${msg.fact}`, info: { type: 'memory', fact: msg.fact } });
        say('noted.', 'work');
        break;
      case 'inbox':
        transient(`inbox:${msg.id}`, { kind: 'needs', label: msg.label || 'INBOX', tag: 'NEW', short: 'INBOX', value: msg.value, detail: msg.detail, ttl: 30 * 60_000,
          ...(/^call-/.test(msg.id) && { info: { type: 'call', id: msg.id.slice(5) } }) });
        break;
      case 'emails': data.emails = msg.emails || []; if (data.emails.length) blip('needs'); break;
      case 'activity': activityAt = Date.now(); say(msg.text, 'work'); break;
      case 'health': setHealth(msg.key, msg.ok, msg.reason); break;
      case 'voice': voiceInfo = [msg.line, msg.credits].filter(Boolean); if (!$('statusPanel').hidden) renderFixes(); break;
    }
    reconcile();
  });

  // Work: jobs, their latest step, and results launched from the brain when a job finishes
  window.ares.work.list().then((all) => { data.jobs = all; reconcile(); });
  window.ares.work.onChange((job) => {
    const i = data.jobs.findIndex((j) => j.id === job.id);
    const was = i >= 0 ? data.jobs[i].status : null;
    if (i >= 0) data.jobs[i] = job; else data.jobs.push(job);
    const active = (s) => ['running', 'queued', 'approval'].includes(s);
    if (was && active(was) && (job.status === 'done' || job.status === 'failed')) {
      hide(`work:${job.id}`);
      setTimeout(() => transient(`result:${job.id}`, {
        kind: job.status === 'done' ? 'work' : 'needs', label: 'WORK', tag: job.status === 'done' ? 'DONE' : 'FAILED', short: 'DONE',
        value: job.title, detail: job.status === 'done' ? 'ready · click to open' : job.error || 'it ran into a problem', gauge: { type: 'arc', v: 1 },
        ttl: 10 * 60_000, info: { type: 'result', id: job.id },
      }), 700);
    }
    if (job.seen) hide(`result:${job.id}`);
    if (job.status === 'approval' && was !== 'approval') say(`${job.title}: needs your OK`, 'needs');
    reconcile();
  });
  window.ares.work.onEvent((id, evt) => {
    if (evt.type !== 'step' && evt.type !== 'note') return;
    if (evt.type === 'step') data.steps.set(id, evt.text);
    blip('work');
    if (Date.now() - activityAt > 4000 && evt.type === 'step') say(`work: ${evt.text.charAt(0).toLowerCase()}${evt.text.slice(1)}`, 'work', 6000);
  });
  window.ares.work.onRemoved((id) => { data.jobs = data.jobs.filter((j) => j.id !== id); hide(`result:${id}`); reconcile(); });

  // ---- Start -------------------------------------------------------------------------------------------------------
  const applyPrefs = (p) => {
    const hadMagnet = prefs.magnetic;
    prefs = { ...prefs, ...p, panels: p.panels || prefs.panels };
    greet();
    if (hadMagnet !== prefs.magnetic) layout();
  };
  window.ares.uiPrefs().then((p) => {
    applyPrefs(p);
    window.ares.dash.state().then((s) => {
      setWeather(s.weather);
      Object.assign(data, { events: s.events || [], leave: s.leave, music: s.music, timers: s.timers || [], call: s.call, emails: s.inbox || [] });
      reconcile();
    });
  });
  window.ares.onUiPrefs(applyPrefs);

  return {
    tidy,
    say,
    blip,
    health: setHealth,
    /** ARES's own state, for the ticker. */
    state(s) {
      if (s === 'listening') say('listening…', 'day', 0);
      else if (s === 'thinking') { if (Date.now() - activityAt > 1500) say('thinking…', 'work', 0); }
      else if (s === 'speaking') say('speaking…', 'day', 0);
      else { clearTimeout(tickerTimer); tickerTimer = setTimeout(calm, 4000); }
    },
    get panels() { return [...panels.values()].map((p) => ({ id: p.id, mode: p.mode, x: p.x, y: p.y, slot: p.slot && `${p.slot.side}${p.slot.i}`, tier })); },
    /** Esc: fold an open detail card back. True if there was one. */
    closeCard() { if (!card) return false; closeCard(); return true; },
    get card() { return card && { id: card.p.id, text: card.el.innerText }; },
    show, hide, // for testing and tuning from the console
    get reduceMotion() { return reduce(); },
    /** The centre column between the left and right panel columns (stage px): COMMS never covers panels. */
    centre() {
      const { w } = size();
      const edge = PAD + cols * (w + GAP);
      return { left: edge, right: W - edge, width: W, height: H };
    },
    /** A spark from the brain to a point in the stage (the first half of the launch animation); resolves on arrival. */
    beam(x, y, kind = 'day') {
      return new Promise((resolve) => {
        if (reduce() || document.hidden) return resolve();
        const b = brain(), c = KIND[kind] || KIND.day;
        beams.push({ x0: b.x, y0: b.y, x1: x, y1: y, t: 0, dur: 0.3, c, trail: [], done: () => {
          rings.push({ x, y, r: 4, max: 56, t: 0, dur: 0.42, c });
          resolve();
        } });
        wake();
      });
    },
  };
})();
