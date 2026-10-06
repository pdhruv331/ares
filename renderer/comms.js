// SUBTITLES + COMMS: the conversation, shown the way a film would.
// - Subtitles: what you say appears as one dim quoted line while you speak. Her reply is one centred line whose
//   words light up in step with her actual voice: each sentence's clip reports how much audio has really played,
//   and the words are spread over the voiced part of that clip (leading/trailing silence trimmed from the PCM),
//   weighted by length and punctuation pauses. Without clip timing (system voice, native playback) it uses word
//   boundary events or the speech rate. Long sentences roll in segments; the line fades ~2 s after she finishes,
//   and stops exactly where she stopped when you talk over her.
// - COMMS: today's conversation on every device (Mac, phone, Telegram, calls) in a drawer that grows up from the
//   subtitle line, inside the centre column only. ⌃C, a click on the subtitle, the COMMS ▴ tab, or "show comms".
//   Esc, a click outside, or ~20 s idle closes it.
// - The typing box stays hidden until you type or click the input area.
const Comms = (() => {
  const $ = (id) => document.getElementById(id);
  const frame = document.querySelector('.frame');
  const consoleEl = document.querySelector('.console');
  const core = document.querySelector('.core');
  const subsEl = $('subs');
  const userEl = $('subUser');
  const aresEl = $('subAres');
  const tab = $('commsTab');
  const drawer = $('comms');
  const list = drawer.querySelector('.cm-list');
  const countEl = drawer.querySelector('.cm-count');
  const input = $('input');
  const reduce = () => Dash.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clean = (t) => String(t || '').replace(/\[[a-z ]+\]\s*/gi, '').replace(/\[[^\]]*$/, '').replace(/\(?https?:\/\/\S+\)?/g, '').replace(/\s+/g, ' ').trim();

  // Speech rate estimates (characters per second) for when there's no clip timing
  const RATE = { eleven: 15.5, system: 14 };
  const HOLD_AFTER = 2000; // the line stays this long after she finishes

  // ---- Your words ---------------------------------------------------------------------------------------------
  let userTimer = null;
  /** live: still speaking (partial transcript); otherwise final, and it fades shortly after. */
  function user(text, { live = false, stranger = false } = {}) {
    text = clean(text);
    clearTimeout(userTimer);
    if (!text) return;
    userEl.textContent = `“${text}”`;
    userEl.classList.toggle('stranger', stranger);
    userEl.classList.add('on');
    if (!live) userTimer = setTimeout(() => userEl.classList.remove('on'), 2600);
  }
  const userFade = () => { clearTimeout(userTimer); userEl.classList.remove('on'); };

  // ---- Her words ----------------------------------------------------------------------------------------------
  /** Split a sentence into words with relative timing weights (longer words and pauses after punctuation take longer). */
  function weigh(text) {
    const words = text.split(' ').filter(Boolean);
    let at = 0;
    const out = words.map((w) => {
      const letters = w.replace(/[^\p{L}\p{N}]/gu, '').length;
      const item = { w, start: at };
      at += Math.max(2, letters) + 1;
      item.end = at;
      if (/[.!?…]["')\]]*$/.test(w)) at += 7;
      else if (/[,;:—–-]["')\]]*$/.test(w)) at += 4;
      return item;
    });
    const total = out.length ? out[out.length - 1].end : 1;
    for (const x of out) { x.start /= total; x.end /= total; }
    return out;
  }
  /** Break a long sentence into segments that fit on one line (prefer to break after a comma). */
  function segment(words, max = 78) {
    const segs = [];
    let cur = [], len = 0;
    words.forEach((x, i) => {
      cur.push(i);
      len += x.w.length + 1;
      const next = words[i + 1];
      const comma = /[,;:—–]$/.test(x.w) && len > max * 0.45;
      if (next && (len + next.w.length > max || comma)) { segs.push(cur); cur = []; len = 0; }
    });
    if (cur.length) segs.push(cur);
    return segs;
  }

  let line = null;     // the sentence on screen
  let endTimer = null;
  let raf = null;
  const gate = Perf.gate();

  /** A sentence she's about to say. The voice code gives it a clock: () => ({ t, start, end }) in seconds of
   *  her audio (t = how much has actually played; start/end = where speech begins/ends in the clip). */
  function sentence(text) {
    text = clean(text);
    const l = { text, words: weigh(text), seg: -1, idx: -1, done: false, cut: false };
    // The clock is mirrored to the corner orb the moment the voice code attaches one (see mirror)
    let clockFn = null;
    Object.defineProperty(l, 'clock', { get: () => clockFn, set: (fn) => { clockFn = fn; if (line === l && fn) mirror(l, Math.max(0, l.idx)); }, enumerable: true });
    l.segs = segment(l.words);
    l.start = () => show(l);
    l.finish = () => { if (line === l && !l.cut) { l.done = true; paint(l, l.words.length); mirror(l, l.words.length, true); } };
    /** Rate-based clock from now (no clip timing). */
    l.estimate = (rate = RATE.eleven, delay = 0.15) => {
      const t0 = performance.now() / 1000 + delay;
      const dur = Math.max(0.6, text.length / rate);
      l.clock = () => ({ t: performance.now() / 1000 - t0, start: 0, end: dur });
    };
    /** Word boundary events (system voice): light up to the word at this character. */
    l.at = (charIndex) => {
      let n = 0;
      for (let i = 0, c = 0; i < l.words.length; i++) { if (c <= charIndex) n = i + 1; c += l.words[i].w.length + 1; }
      l.clock = null;
      l.boundary = n;
    };
    return l;
  }

  function show(l) {
    clearTimeout(endTimer);
    if (!l.text) return;
    line = l;
    aresEl.classList.remove('cut', 'notice');
    aresEl.classList.add('on');
    paint(l, 0, true);
    mirror(l, 0);
    if (!raf) raf = requestAnimationFrame(tick);
    // Covered (as the desktop under the apps) this page gets no frames: a timer keeps the orb's copy in step instead
    clearInterval(mirrorTimer);
    mirrorTimer = setInterval(() => { const cur = line; if (!cur || cur.done || cur.cut) return clearInterval(mirrorTimer); const n = litCount(cur); if (n != null) mirror(cur, n); }, 250);
  }
  let mirrorTimer = null;
  /** How many words her voice has reached, from the line's clock or word boundaries (null: no timing yet). */
  function litCount(l) {
    if (l.boundary != null && !l.clock) return l.boundary;
    if (!l.clock) return null;
    const c = l.clock();
    if (!c) return null;
    const k = (c.t - c.start) / Math.max(0.2, c.end - c.start);
    let n = 0;
    for (const w of l.words) if (k >= w.start - 0.01) n++;
    return n;
  }
  function tick(now) {
    raf = null;
    const l = line;
    if (!l || l.done || l.cut) return;
    raf = requestAnimationFrame(tick);
    if (!gate(now)) return;
    const n = litCount(l);
    if (n != null) paint(l, n);
  }
  /** Draw the segment holding word n: words before n lit, word n-1 the one being spoken. */
  function paint(l, n, force = false) {
    n = Math.min(n, l.words.length);
    const seg = Math.max(0, l.segs.findIndex((s) => s.includes(Math.min(n, l.words.length - 1))));
    if (seg !== l.seg || force) {
      l.seg = seg;
      aresEl.innerHTML = '';
      for (const i of l.segs[seg] || []) {
        const s = document.createElement('span');
        s.textContent = l.words[i].w;
        s.dataset.i = i;
        aresEl.append(s, ' ');
      }
      if (!force && !reduce()) aresEl.animate([{ opacity: 0.2, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
      l.idx = -1;
    }
    if (n === l.idx) return;
    l.idx = n;
    for (const s of aresEl.children) {
      const i = Number(s.dataset.i);
      s.className = i < n - 1 ? 'lit' : i === n - 1 ? 'now' : '';
    }
    mirror(l, n);
  }
  // The corner orb (orb.js) shows the same line above itself while the desktop is covered. A covered window gets no
  // animation frames, so the orb is given the whole schedule once per sentence (every segment's words, each word's
  // start as a fraction of the sentence, and the clock's position now) and runs the same sync itself; the lit count
  // is sent too whenever this page does get a frame, so the two never drift apart.
  let mirrored = null;
  function mirror(l, n, done = false, hold = null) {
    const fresh = mirrored !== l;
    mirrored = l;
    const msg = { type: 'caption', n, done };
    if (hold) msg.hold = hold;
    if (fresh) {
      msg.segs = l.segs.map((seg) => seg.map((i) => l.words[i].w));
      msg.starts = l.segs.map((seg) => seg.map((i) => Math.round(l.words[i].start * 1000) / 1000));
      msg.total = l.words.length;
    }
    if (l.clock) { const c = l.clock(); if (c) msg.clock = { t: c.t, start: c.start, end: c.end }; }
    window.ares.scene?.(msg);
  }
  const mirrorOff = () => { clearInterval(mirrorTimer); if (mirrored) { mirrored = null; window.ares.scene?.({ type: 'caption', off: true }); } };
  /** She was talked over: the line stops where her voice stopped. */
  function cut() {
    const l = line;
    if (!l || l.done || l.cut) return;
    l.cut = true;
    const n = Math.max(0, l.idx);
    for (const s of [...aresEl.children]) if (Number(s.dataset.i) >= n) s.remove();
    if (!aresEl.children.length) { aresEl.classList.remove('on'); return; }
    aresEl.lastChild.className = 'lit';
    aresEl.classList.add('cut');
    mirror(l, n, true, 1400);
    end(1400);
  }
  /** Her reply is over: fade the line after a moment. */
  function end(after = HOLD_AFTER) {
    clearTimeout(endTimer);
    endTimer = setTimeout(() => { aresEl.classList.remove('on'); line = null; mirrorOff(); }, after);
  }

  /** A line she shows without saying (pairing codes, tips, warnings): held long enough to read. */
  function notice(text, hold) {
    const l = sentence(text);
    if (!l.text) return;
    l.segs = [l.words.map((_, i) => i)]; // a notice may wrap to two lines rather than roll
    show(l);
    l.done = true;
    paint(l, l.words.length, true);
    aresEl.classList.add('notice');
    clearTimeout(endTimer);
    endTimer = setTimeout(() => { aresEl.classList.remove('on', 'notice'); line = null; mirrorOff(); }, hold ?? Math.min(16000, Math.max(4500, l.text.length * 70)));
  }
  const clearNotice = () => aresEl.classList.remove('notice');

  // ---- COMMS --------------------------------------------------------------------------------------------------
  const SRC = { phone: 'PHONE', telegram: 'TELEGRAM', calls: 'CALL' };
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  let items = [];
  let loaded = false;
  let isOpen = false;
  let idleTimer = null;
  let unseen = 0;
  const IDLE_MS = 20_000;

  function row(m) {
    const el = document.createElement('div');
    el.className = `cm-row ${m.who === 'ares' ? 'ares' : m.who === 'stranger' ? 'stranger' : 'user'}${m.notice ? ' notice' : ''}`;
    const time = document.createElement('time');
    time.textContent = hhmm(m.t);
    const p = document.createElement('p');
    const src = SRC[m.source];
    if (src) { const b = document.createElement('b'); b.className = 'cm-src'; b.textContent = src; p.append(b, ' '); }
    p.append(m.who === 'ares' ? m.text : `“${m.text}”`);
    el.append(time, p);
    el.title = new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return el;
  }
  function renderAll() {
    list.innerHTML = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'cm-empty';
      e.textContent = 'Nothing said yet today.';
      list.append(e);
    }
    for (const m of items) list.append(row(m));
    countEl.textContent = `${items.length} LINE${items.length === 1 ? '' : 'S'}`;
    list.scrollTop = list.scrollHeight;
  }
  function add(m) {
    if (items.length && new Date(items[0].t).toDateString() !== new Date(m.t).toDateString()) items = [];
    items.push(m);
    if (m.notice && !isOpen) notice(m.text);
    if (isOpen) {
      list.querySelector('.cm-empty')?.remove();
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
      const el = row(m);
      list.append(el);
      countEl.textContent = `${items.length} LINES`;
      if (!reduce()) el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
      if (atEnd) list.scrollTop = list.scrollHeight;
      touch();
    } else if (m.source && m.source !== 'mac') {
      unseen++;
      tab.classList.add('new');
    }
  }
  window.ares.comms.on(add);
  const load = () => window.ares.comms.history().then((h) => { items = h || []; loaded = true; });
  load();

  /** Place the drawer: bottom on the subtitle line, inside the centre column between the panel columns. */
  function placeDrawer() {
    const fr = frame.getBoundingClientRect();
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const c = Dash.centre();
    const margin = 10;
    const left = Math.max(12, stage.left - fr.left + c.left + margin);
    const right = Math.max(12, fr.right - (stage.left + c.right) + margin);
    const width = fr.width - left - right;
    const sub = subsEl.getBoundingClientRect();
    const bottom = fr.bottom - sub.bottom;
    const height = Math.min(440, Math.max(160, (sub.bottom - stage.top) * 0.66));
    Object.assign(drawer.style, { left: `${left}px`, right: `${right}px`, bottom: `${bottom}px`, maxHeight: `${height}px` });
    return { width, height, bottom, sub };
  }
  function lift(on, height = 0) {
    if (on) {
      const stageH = document.querySelector('.stage').clientHeight;
      // Just enough to keep the brain clear of the drawer's top, never off the top of the stage
      const up = reduce() ? 0 : Math.max(0, Math.min(height * 0.32, stageH * 0.12));
      core.style.setProperty('--comms-y', `${-up}px`); // (composed with the brain's placement: styles.css .core)
      core.style.setProperty('--comms-s', up ? '0.92' : '1');
      core.classList.add('comms-dim');
    } else {
      core.style.setProperty('--comms-y', '0px');
      core.style.setProperty('--comms-s', '1');
      core.classList.remove('comms-dim');
    }
  }

  async function open() {
    if (isOpen) return touch();
    isOpen = true;
    if (!loaded) await load();
    unseen = 0;
    tab.classList.remove('new');
    document.body.classList.add('comms-open');
    tab.setAttribute('aria-expanded', 'true');
    drawer.hidden = false;
    placeDrawer();
    renderAll();
    lift(true, drawer.offsetHeight);
    touch();
    if (reduce()) { drawer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 }); return; }
    // The launch unfold: a spark from the brain lands on the subtitle line, which widens into a bright line and
    // grows up into the drawer with a slight overshoot
    const st = document.querySelector('.stage').getBoundingClientRect();
    Dash.beam(st.width / 2, st.height - 4, 'day');
    drawer.animate([
      { clipPath: 'inset(calc(100% - 2px) 42% 0 42%)', filter: 'brightness(2.2)', opacity: 0.7 },
      { clipPath: 'inset(calc(100% - 2px) 0 0 0)', filter: 'brightness(2.4)', opacity: 1, offset: 0.35 },
      { clipPath: 'inset(-3% 0 0 0)', filter: 'brightness(1.3)', offset: 0.8 },
      { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1)' },
    ], { duration: 520, easing: 'cubic-bezier(.3,.7,.4,1)' });
    const rows = [...list.children].slice(-7);
    rows.forEach((r, i) => r.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 0, offset: 0.4 }, { opacity: 1, transform: 'none' }],
      { duration: 420 + (rows.length - i) * 40, easing: 'ease-out' }));
  }
  let closing = null;
  function close() {
    if (!isOpen) return false;
    isOpen = false;
    clearTimeout(idleTimer);
    document.body.classList.remove('comms-open');
    tab.setAttribute('aria-expanded', 'false');
    lift(false);
    const done = () => { if (!isOpen) drawer.hidden = true; };
    const a = reduce()
      ? drawer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140 })
      : drawer.animate([
        { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1)', opacity: 1 },
        { clipPath: 'inset(calc(100% - 2px) 0 0 0)', filter: 'brightness(2.2)', opacity: 1, offset: 0.6 },
        { clipPath: 'inset(calc(100% - 2px) 48% 0 48%)', filter: 'brightness(2.4)', opacity: 0 },
      ], { duration: 320, easing: 'cubic-bezier(.5,0,.3,1)' });
    closing = a.finished.then(done, done);
    return true;
  }
  const toggle = () => (isOpen ? close() : open());
  function touch() {
    clearTimeout(idleTimer);
    if (isOpen) idleTimer = setTimeout(close, IDLE_MS);
  }

  tab.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  subsEl.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  for (const ev of ['pointermove', 'wheel', 'pointerdown', 'scroll']) drawer.addEventListener(ev, touch, { passive: true, capture: ev === 'scroll' });
  // A click anywhere else folds it away (and still does what it was meant to)
  addEventListener('pointerdown', (e) => {
    if (isOpen && !drawer.contains(e.target) && !tab.contains(e.target) && !subsEl.contains(e.target)) close();
  }, true);
  addEventListener('resize', () => { if (isOpen) { placeDrawer(); lift(true, drawer.offsetHeight); } });

  // ---- The typing box: hidden until you type or click the input area ------------------------------------------
  const typingOn = () => consoleEl.classList.contains('typing');
  function typing(on) {
    consoleEl.classList.toggle('typing', on);
    if (on) input.focus();
  }
  input.addEventListener('input', () => { if (input.value && !typingOn()) typing(true); });
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== input && !input.value.trim() && $('dropCard').hidden) typing(false);
  }, 150));
  // A click on the empty input area at the bottom (not the subtitle or the tab) brings the box up
  consoleEl.addEventListener('click', (e) => {
    if (e.target === consoleEl || e.target.closest('.input-zone')) typing(true);
  });

  document.addEventListener('keydown', (e) => {
    // ⌃C: COMMS (on a Mac, Control-C is free; ⌘C still copies)
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyC') { e.preventDefault(); e.stopImmediatePropagation(); toggle(); return; }
    if (e.key === 'Escape') {
      if (isOpen) { close(); e.stopImmediatePropagation(); return; }
      if (typingOn() && document.activeElement === input) { input.value = ''; input.blur(); typing(false); e.stopImmediatePropagation(); }
      return;
    }
    if (isOpen && !e.metaKey && !e.ctrlKey) touch();
    // Start typing anywhere: the box appears and takes the keystroke
    const t = e.target;
    const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (!editable && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && !document.body.classList.contains('work-open')) {
      if (isOpen) close();
      typing(true);
    }
  }, true);

  return {
    user, userFade, sentence, cut, end, notice, clearNotice,
    open, close, toggle, typing,
    get isOpen() { return isOpen; },
    get state() { return { open: isOpen, items: items.length, subtitle: aresEl.classList.contains('on') ? aresEl.textContent : '', lit: aresEl.querySelectorAll('.lit,.now').length, user: userEl.classList.contains('on') ? userEl.textContent : '', typing: typingOn() }; },
  };
})();
