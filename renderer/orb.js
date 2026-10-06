// The corner orb's page (orb.js in the main process has the window, the pointer, the rules and the actions).
// Everything drawn is on one canvas: the mini reactor (Reactor.Engine, `small`), the violet progress ring, the comet
// while she thinks, the waveform ring while she listens, the amber / green pulse rings. Idle it draws at 3 fps (the
// reactor barely turning); it goes to 30 fps only while something moves. The DOM holds the text: hint, caption, card,
// menu and drop chips. The orb's centre is --ox/--oy (from the corner), and every hit area is reported to the main
// process, which makes the window interactive only there.
(() => {
  const $ = (id) => document.getElementById(id);
  const field = $('field'), stage = $('stage'), ctx = stage.getContext('2d');
  const hint = $('hint'), caption = $('caption'), card = $('card'), menu = $('menu'), chips = $('chips'), badge = $('badge');
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COL = { cyan: [62, 230, 255], violet: [167, 139, 250], amber: [255, 181, 71], green: [74, 222, 128], red: [248, 113, 113], blue: [96, 150, 255], grey: [127, 140, 153] };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
  const R = 16;               // the orb's radius (≈32 pt across)
  const MARGIN = 24;          // from the corner
  const C = 100;              // the canvas's centre

  // ---- State (from the main process) ----
  const S = {
    on: false, corner: 'br', power: 'online',
    state: 'idle', level: 0, target: 0, attention: false,
    ptt: null,                // 'listening' | 'thinking' | null (hold to talk)
    needs: { count: 0 }, job: null, call: null, usage: { pct: 0 }, muted: false,
    hover: false, drag: { on: false, near: 0 }, portal: false,
    sounds: { enabled: true, silent: false },
  };
  const mini = new Reactor.Engine();
  let ox = 0, oy = 0;

  function place(corner) {
    S.corner = corner;
    document.documentElement.className = `c-${corner}`;
    const right = corner.endsWith('r'), bottom = corner.startsWith('b');
    ox = right ? innerWidth - MARGIN - R : MARGIN + R;
    oy = bottom ? innerHeight - MARGIN - R : MARGIN + R;
    document.documentElement.style.setProperty('--ox', `${ox}px`);
    document.documentElement.style.setProperty('--oy', `${oy}px`);
    const k = devicePixelRatio || 1;
    stage.width = stage.height = 200 * k;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    postHits();
  }

  // ---- Drawing ----
  let raf = 0, last = 0, t0 = performance.now();
  let scale = 1, glow = 0;      // smoothed: hold / drag swell, hover glow
  const pulses = [];            // { at, colour }: outward rings
  let lastPulse = 0;
  let flashUntil = 0;
  const busy = () => S.state !== 'idle' || S.ptt || S.level > 0.02 || S.target > 0.02 || pulses.length || S.drag.on || Math.abs(scale - targetScale()) > 0.01
    || Math.abs(glow - (S.hover ? 1 : 0)) > 0.02 || S.needs.count > 0 || S.call || performance.now() < flashUntil || (S.job && S.job.running && S.job.progress == null);
  const targetScale = () => (S.drag.on ? 1 + 0.4 * S.drag.near : S.ptt === 'listening' ? 1.14 : S.hover ? 1.04 : 1);
  function frame(now) {
    raf = 0;
    if (!S.on && now - offAt > 700) { ctx.clearRect(0, 0, 200, 200); return; }
    raf = requestAnimationFrame(frame);
    const fast = busy();
    if (now - last < (fast ? 33 : 330)) return;
    const dt = Math.min(0.4, (now - (last || now)) / 1000);
    last = now;
    const t = (now - t0) / 1000;
    S.level += (S.target - S.level) * Math.min(1, dt * 12);
    scale += (targetScale() - scale) * Math.min(1, dt * 10);
    glow += ((S.hover ? 1 : 0) - glow) * Math.min(1, dt * 8);
    ctx.clearRect(0, 0, 200, 200);
    const standby = S.power === 'standby' || S.power === 'tostandby' || S.power === 'fromstandby';
    // Pulses: needs-you (amber) and a call (green), one ring every 2.4 s
    const pulseColour = S.call ? COL.green : S.needs.count > 0 ? COL.amber : null;
    if (pulseColour && t - lastPulse > 2.4) { lastPulse = t; pulses.push({ at: t, colour: pulseColour }); }
    for (let i = pulses.length - 1; i >= 0; i--) if (t - pulses[i].at > 1.3) pulses.splice(i, 1);
    for (const p of pulses) {
      const k = (t - p.at) / 1.3;
      ctx.strokeStyle = rgba(p.colour, 0.55 * (1 - k)); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(C, C, (R + 6) * scale + k * 26, 0, Math.PI * 2); ctx.stroke();
    }
    // The reactor
    const st = S.ptt === 'listening' ? 'listening' : S.ptt === 'thinking' ? 'thinking' : S.state;
    mini.setState(standby ? 'idle' : st);
    mini.forceHue = standby ? COL.blue : null;
    mini.pace = standby ? 0.15 : fast ? 1 : 0.12;
    const usageTint = S.usage.pct >= 95 ? 1 : S.usage.pct >= 80 ? 0.5 : 0;
    mini.update(dt, { level: S.level, attention: S.attention || usageTint > 0 });
    if (!S.attention && usageTint > 0) mini.attention = Math.min(mini.attention, usageTint);
    const alpha = standby ? 0.55 + 0.1 * Math.sin(t * 1.6) : 1;
    mini.draw(ctx, C, C, R * scale, { small: true, alpha });
    // Hover: a touch more glow
    if (glow > 0.02) {
      const g = ctx.createRadialGradient(C, C, R * scale * 0.6, C, C, R * scale * 1.9);
      g.addColorStop(0, rgba(COL.cyan, 0.16 * glow)); g.addColorStop(1, rgba(COL.cyan, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(C, C, R * scale * 1.9, 0, Math.PI * 2); ctx.fill();
    }
    // Progress ring: the main running job (violet)
    if (S.job && S.job.running && !standby) {
      const rr = (R + 5.5) * scale;
      ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(COL.violet, 0.18); ctx.beginPath(); ctx.arc(C, C, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = rgba(COL.violet, 0.9);
      if (S.job.progress != null) { ctx.beginPath(); ctx.arc(C, C, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, Math.min(1, S.job.progress))); ctx.stroke(); }
      else { const a = t * 1.4; ctx.beginPath(); ctx.arc(C, C, rr, a, a + 1.2); ctx.stroke(); } // no numbers yet: a crawling arc
    }
    // Thinking: the violet comet circling
    if (st === 'thinking') {
      const a0 = t * 4.2, rr = (R + 5) * scale;
      for (let i = 0; i < 18; i++) {
        const a = a0 - i * 0.07, k = 1 - i / 18;
        ctx.fillStyle = rgba(COL.violet, 0.9 * k);
        ctx.beginPath(); ctx.arc(C + Math.cos(a) * rr, C + Math.sin(a) * rr, 2.2 * k + 0.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Listening (hold to talk): a waveform ring following the voice
    if (st === 'listening') {
      const lv = S.level, rr = (R + 4) * scale;
      ctx.strokeStyle = rgba(COL.cyan, 0.55 + lv * 0.4); ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const w = lv * 3.4 * Math.sin(a * 5 + t * 7) + lv * 1.8 * Math.sin(a * 9 - t * 11);
        i ? ctx.lineTo(C + Math.cos(a) * (rr + w), C + Math.sin(a) * (rr + w)) : ctx.moveTo(C + Math.cos(a) * (rr + w), C + Math.sin(a) * (rr + w));
      }
      ctx.stroke();
    }
    // Usage ≥ 95%: a thin amber ring
    if (S.usage.pct >= 95 && !standby) { ctx.strokeStyle = rgba(COL.amber, 0.7); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(C, C, (R + 9) * scale, 0, Math.PI * 2); ctx.stroke(); }
    // The portal is open: a thin bright ring says "click to close"
    if (S.portal) { ctx.strokeStyle = rgba(COL.cyan, 0.85); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(C, C, (R + 3) * scale, 0, Math.PI * 2); ctx.stroke(); }
    // Muted: a small grey mark at the foot of the orb
    if (S.muted) { ctx.fillStyle = rgba(COL.grey, 0.9); ctx.beginPath(); ctx.arc(C + R * 0.75, C + R * 0.75, 2.2, 0, Math.PI * 2); ctx.fill(); }
  }
  let offAt = 0;
  function setOn(on) {
    if (on === S.on) return;
    S.on = on;
    field.classList.toggle('on', on);
    if (!on) { offAt = performance.now(); closeMenu(); hideChips(); }
    if (!raf) raf = requestAnimationFrame(frame);
    setTimeout(postHits, 60);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  // ---- Hit areas (the main process makes the window interactive only there) ----
  let lastHits = '';
  function postHits() {
    const rects = [];
    const all = !menu.hidden || !chips.hidden;
    if (S.on) {
      const r = (R + 7) * Math.max(1, scale);
      rects.push({ x: Math.round(ox - r), y: Math.round(oy - r), w: Math.round(r * 2), h: Math.round(r * 2) });
      if (!card.hidden) { const b = card.getBoundingClientRect(); rects.push({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }); }
    }
    const key = JSON.stringify({ rects, all });
    if (key === lastHits) return;
    lastHits = key;
    window.orb.hits({ rects, all });
  }

  // ---- The orb: click, hold, right-click ----
  const HOLD_MS = 350;
  let holdTimer = null, holding = false, downAt = 0;
  const overOrb = (e) => Math.hypot(e.clientX - ox, e.clientY - oy) <= (R + 7) * Math.max(1, scale);
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !overOrb(e)) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    downAt = performance.now();
    Sounds.play('tick');
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { holding = true; window.orb.send({ type: 'hold' }); }, HOLD_MS);
  });
  const up = (e) => {
    if (!downAt) return;
    clearTimeout(holdTimer);
    const held = holding;
    holding = false; downAt = 0;
    try { stage.releasePointerCapture(e.pointerId); } catch {}
    if (held) window.orb.send({ type: 'release' });
    else if (overOrb(e)) window.orb.send({ type: 'click' });
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('contextmenu', (e) => { e.preventDefault(); if (overOrb(e)) openMenu(); });
  stage.addEventListener('pointerenter', () => { S.hover = true; kick(); });
  stage.addEventListener('pointerleave', () => { S.hover = false; kick(); });

  // ---- The quick menu ----
  function openMenu() { hideChips(); hideCard(true); menu.hidden = false; postHits(); kick(); window.orb.send({ type: 'open', what: 'menu' }); }
  function closeMenu() { if (menu.hidden) return; menu.hidden = true; postHits(); window.orb.send({ type: 'closed', what: 'menu' }); }
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    Sounds.play('tick');
    closeMenu();
    window.orb.send({ type: 'menu', act });
  });
  // A click anywhere else in the window (the window takes every click while something is open) closes what's open
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#menu, #chips, #card')) return;
    if (!menu.hidden || !chips.hidden) { if (!overOrb(e)) { closeMenu(); hideChips(); } }
  }, true);

  // ---- Cards ----
  let cardRec = null;
  function showCard(c) {
    hideCard(true);
    cardRec = c;
    card.style.setProperty('--k', { needs: '255, 181, 71', call: '74, 222, 128', work: '167, 139, 250', red: '248, 113, 113' }[c.kind] || '62, 230, 255');
    $('cardLabel').textContent = String(c.label || '').toUpperCase();
    $('cardTag').textContent = String(c.tag || '').toUpperCase();
    $('cardTitle').textContent = c.title || '';
    $('cardDetail').textContent = c.detail || '';
    $('cardActs').innerHTML = (c.actions || []).map((a) => `<button data-act="${esc(a.act)}" class="${a.red ? 'red' : ''}">${esc(a.label).toUpperCase()}</button>`).join('');
    card.hidden = false;
    card.classList.toggle('with-caption', caption.classList.contains('on'));
    const content = card.querySelector('.cd-content');
    for (const b of card.querySelectorAll('.br')) b.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0.25, offset: 0.6 }, { opacity: 1 }], { duration: 320, easing: 'steps(6, end)' });
    content.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], { duration: 360, delay: 80, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'backwards' });
    card.querySelector('.cd-life i').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: c.ttl, easing: 'linear', fill: 'forwards' });
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => hideCard(), c.ttl);
    if (c.sound) Sounds.play(c.sound);
    setTimeout(postHits, 40);
  }
  let cardTimer = null;
  function hideCard(now = false) {
    if (card.hidden) return;
    clearTimeout(cardTimer);
    const done = () => { card.hidden = true; cardRec = null; postHits(); };
    if (now) return done();
    card.animate([{ transform: 'scale(1, 1)', opacity: 1 }, { transform: 'scale(1, 0.04)', filter: 'brightness(2.2)', offset: 0.55 }, { transform: 'scale(0.02, 0.04)', opacity: 0 }],
      { duration: 260, easing: 'cubic-bezier(.5,0,.7,.4)', fill: 'forwards' }).finished.then(done, done);
  }
  card.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!cardRec) return;
    Sounds.play('tick');
    window.orb.send({ type: 'card', id: cardRec.id, act: act || 'open' });
    hideCard();
  });

  // ---- Drop chips ----
  let chipRec = null;
  function showChips(c) {
    closeMenu();
    chipRec = c;
    chips.innerHTML = c.items.map((it) => `<div class="chip" data-act="${esc(it.act)}">${esc(it.label)}${it.sub ? `<span class="nm">${esc(it.sub)}</span>` : ''}</div>`).join('');
    chips.hidden = false;
    requestAnimationFrame(() => chips.classList.add('on'));
    [...chips.children].forEach((el, i) => { el.style.transitionDelay = `${i * 45}ms`; });
    setHint(c.hint || '');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(hideChips, 15_000);
    postHits();
  }
  let chipTimer = null;
  function hideChips() {
    if (chips.hidden) return;
    clearTimeout(chipTimer);
    chips.classList.remove('on');
    chips.hidden = true;
    chipRec = null;
    setHint('');
    postHits();
    window.orb.send({ type: 'closed', what: 'chips' });
  }
  chips.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || !chipRec) return;
    Sounds.play('tick');
    window.orb.send({ type: 'chip', id: chipRec.id, act });
    hideChips();
  });

  // ---- Drag and drop onto the orb ----
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const hasText = (e) => [...(e.dataTransfer?.types || [])].some((t) => /text|url/i.test(t));
  document.addEventListener('dragenter', (e) => { e.preventDefault(); S.drag = { on: true, near: 1 }; setHint('drop to hand it to ARES'); kick(); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) || hasText(e) ? 'copy' : 'none'; });
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget) return; S.drag = { on: false, near: 0 }; if (chips.hidden) setHint(''); kick(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    S.drag = { on: false, near: 0 };
    kick();
    const files = [...(e.dataTransfer?.files || [])].map((f) => window.orb.filePath(f)).filter(Boolean);
    if (files.length) return window.orb.send({ type: 'drop', files });
    const url = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) || '';
    const text = e.dataTransfer.getData('text/plain') || url;
    if (text.trim()) return window.orb.send({ type: 'drop', text: text.trim(), url: /^https?:\/\//i.test(url || text.trim()) ? (url || text.trim()) : '' });
    setHint('');
  });

  // ---- Hint, caption, badge ----
  function setHint(text, flash = false) {
    hint.classList.remove('flash');
    hint.textContent = String(text || '').toUpperCase();
    hint.classList.toggle('on', Boolean(text));
    if (text && flash) { void hint.offsetWidth; hint.classList.add('flash'); flashUntil = performance.now() + 1400; kick(); }
  }
  // The caption runs the window's word sync itself (renderer/comms.js mirror): the schedule arrives once per sentence
  // (segments, each word's start as a fraction of the sentence, the clock's position), and this page keeps time from
  // there; lit counts from the window snap it whenever that page gets a frame of its own.
  let captionTimer = null, cap = null, capRaf = 0;
  function setCaption(m) {
    clearTimeout(captionTimer);
    if (m.off || !S.on) { cap = null; caption.classList.remove('on'); card.classList.remove('with-caption'); return; }
    if (m.segs) cap = { segs: m.segs, starts: m.starts, total: m.total, seg: -1, n: -1, clock: null, done: false };
    if (!cap) return;
    if (m.clock) cap.clock = { ...m.clock, at: performance.now() };
    if (m.done) { cap.done = true; cap.clock = null; }
    if (m.n != null) paintCaption(m.n, m.n > cap.n || m.done);
    caption.classList.add('on');
    card.classList.toggle('with-caption', !card.hidden);
    if (m.done) captionTimer = setTimeout(() => { cap = null; caption.classList.remove('on'); card.classList.remove('with-caption'); }, m.hold || 2200);
    else if (!capRaf) capRaf = requestAnimationFrame(captionTick);
  }
  function captionTick() {
    capRaf = 0;
    if (!cap || cap.done || !S.on) return;
    capRaf = requestAnimationFrame(captionTick);
    if (!cap.clock) return;
    const c = cap.clock, t = c.t + (performance.now() - c.at) / 1000;
    const k = (t - c.start) / Math.max(0.2, c.end - c.start);
    let n = 0;
    for (const seg of cap.starts) for (const st of seg) if (k >= st - 0.01) n++;
    if (n > cap.n) paintCaption(n);
  }
  /** Show the segment holding word n: words before n lit, word n-1 the one being spoken (comms.js paint). */
  function paintCaption(n, forward = true) {
    if (!cap) return;
    n = Math.min(n, cap.total);
    if (!forward && n < cap.n) return; // a stale count from the window never pulls the line back
    let seg = 0, before = 0;
    for (let i = 0; i < cap.segs.length; i++) { const len = cap.segs[i].length; if (n <= before + len || i === cap.segs.length - 1) { seg = i; break; } before += len; }
    if (n >= cap.total) { seg = cap.segs.length - 1; before = cap.total - cap.segs[seg].length; }
    if (seg !== cap.seg) {
      cap.seg = seg;
      caption.innerHTML = cap.segs[seg].map((w) => `<span>${esc(w)}</span>`).join(' ');
      caption.animate([{ opacity: 0.2, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
    }
    cap.n = n;
    const local = n - before;
    [...caption.children].forEach((s, i) => { s.className = i < local - 1 ? 'lit' : i === local - 1 ? 'now' : ''; });
  }
  function setBadge(n) { badge.hidden = !(n > 0); badge.textContent = n > 9 ? '9+' : String(n); }

  // ---- From the main process ----
  window.orb.on((m) => {
    switch (m.type) {
      case 'show': if (m.corner && m.corner !== S.corner) place(m.corner); setOn(Boolean(m.on)); break;
      case 'corner': place(m.corner); break;
      case 'scene': {
        const s = m.msg;
        if (s.type === 'state') { S.state = s.state; if (s.state !== 'speaking' && s.state !== 'listening') S.target = 0; if (s.state !== 'thinking' && S.ptt === 'thinking') S.ptt = null; }
        else if (s.type === 'level') S.target = Math.min(1, (s.v || 0) * 1.5);
        else if (s.type === 'attention') S.attention = Boolean(s.on);
        kick();
        break;
      }
      case 'power': S.power = m.mode; kick(); break;
      case 'signals': {
        const was = S.needs.count, wasCall = Boolean(S.call);
        S.needs = m.needs || { count: 0 }; S.job = m.job || null; S.call = m.call || null; S.usage = m.usage || { pct: 0 }; S.muted = Boolean(m.muted);
        setBadge(S.needs.count);
        if ((S.needs.count > was || (S.call && !wasCall)) && S.on) { lastPulse = -10; Sounds.play('attend'); }
        kick();
        break;
      }
      case 'ptt':
        S.ptt = m.phase || null;
        if (m.phase === 'listening') { setHint(m.hint || 'listening… release to send'); Sounds.play('ptt-on'); }
        else if (m.phase === 'thinking') { setHint(''); Sounds.play('ptt-off'); }
        else setHint('');
        kick(); postHits();
        break;
      case 'caption': setCaption(m); break;
      case 'card': showCard({ ttl: 9000, ...m.card }); break;
      case 'hide-card': hideCard(); break;
      case 'chips': showChips(m); break;
      case 'drag': S.drag = { on: Boolean(m.on), near: m.near ?? (m.on ? 0.5 : 0) }; if (m.on && !chips.hidden) hideChips(); if (!m.on && chips.hidden && !S.ptt) setHint(''); else if (m.on) setHint('drop to hand it to ARES'); kick(); postHits(); break;
      case 'caret': field.classList.toggle('caret', Boolean(m.near)); break;
      case 'portal': S.portal = Boolean(m.open); if (m.open) Sounds.play('portal'); else if (m.sound !== false) Sounds.play('portal-close'); kick(); break;
      case 'flash': setHint(m.text, true); break;
      case 'hint': setHint(m.text || ''); break;
      case 'sounds': Sounds.enabled = m.enabled !== false; Sounds.silent = Boolean(m.silent); break;
      case 'sound': Sounds.play(m.name); break;
      case 'menu': if (m.open) openMenu(); else closeMenu(); break;
    }
  });
  addEventListener('resize', () => place(S.corner));
  place('br');
  Sounds.preload();
  window.orb.ready();
})();
