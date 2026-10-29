// Hand gestures in the window (docs/hand-tracking-prompt.md). The engine (main: hands.js via vision.js) says what the
// hands did; this turns it into the SAME pointer events and calls the mouse makes, so grab, throw, dock, close-in-the-
// brain, click-for-details, COMMS and the lift are the one existing implementation. Plus the feedback the air lacks:
// a glowing ring cursor (fills on pinch, two dots for two-finger mode, a line between both hands while zooming), the
// hovered panel's EDITH brackets, a soft tick on grab and release.
const Hands = (() => {
  const stage = document.querySelector('.stage');
  const el = document.createElement('div');
  el.id = 'handCursor';
  el.className = 'hand-cursor';
  el.hidden = true;
  el.innerHTML = '<i class="hc-ring"></i><i class="hc-dot a"></i><i class="hc-dot b"></i><i class="hc-line"></i><i class="hc-ring two"></i>';
  document.body.appendChild(el);
  const line = el.querySelector('.hc-line'), ringB = el.querySelector('.hc-ring.two');

  let state = 'off';
  let pos = null;           // display point, px (window coordinates)
  let pressed = null;       // { el, id } while a synthetic pointer is down
  let hover = null;         // the panel element under the cursor
  let focus = null;         // panel id the two-finger swipes step through
  let zoom = null;          // { target, kind, base }
  const POINTER_ID = 7001;  // synthetic pointer, never clashes with the mouse (1)

  // ---- Cursor ---------------------------------------------------------------------------------------------------
  const toPx = (p) => ({ x: p.x * innerWidth, y: p.y * innerHeight });
  function showCursor(p, pose) {
    pos = toPx(p);
    el.hidden = false;
    el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    el.dataset.pose = pose || '';
    setHover(pose === 'pinch' && pressed ? hover : panelAt(pos));
  }
  function hideCursor() { el.hidden = true; el.classList.remove('zoom'); setHover(null); }
  function setHover(h) {
    if (h === hover) return;
    hover?.classList.remove('hand-hover');
    hover = h;
    hover?.classList.add('hand-hover');
    el.classList.toggle('over', Boolean(hover));
  }
  /** What's under a point of ARES's own: a panel, a detail card, COMMS, a button. */
  const under = (p) => document.elementFromPoint(p.x, p.y);
  const panelAt = (p) => under(p)?.closest?.('.dp, .dp-card, #comms, .comms-tab, #statusPanel, #work') || null;

  // ---- Pinch → the pointer the panels already listen to ---------------------------------------------------------
  const pev = (type, p, target) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: POINTER_ID, pointerType: 'pen',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y });
  function down(p) {
    const px = toPx(p);
    const t = under(px);
    if (!t) return;
    pressed = { el: t, at: performance.now(), start: px };
    tick(660);
    t.dispatchEvent(pev('pointerdown', px, t)); // dash.js press(): the panel decides click vs grab from the movement
  }
  function move(p) {
    if (!pressed) return;
    const px = toPx(p);
    window.dispatchEvent(pev('pointermove', px)); // dash.js drag(): the orb follows
  }
  function up(p, { click, cancel } = {}) {
    if (!pressed) return;
    const px = toPx(p);
    const t = pressed.el;
    pressed = null;
    tick(520);
    if (cancel) { window.dispatchEvent(pev('pointercancel', px)); return; }
    window.dispatchEvent(pev('pointerup', px)); // dash.js letGo(): a click opens details, a throw flies
    // Things that act on click rather than pointer (buttons, the COMMS tab, links): a quick pinch clicks them
    if (click && !t.closest('.dp')) {
      const b = t.closest('button, a, [data-url], .comms-tab, .cm-row, .job, .file-card');
      if (b && b.isConnected) b.click();
      else if (!t.closest('.dp-card, #comms, #work, #statusPanel')) { Dash.closeCard(); Comms.close(); } // a click on nothing closes what's open
    }
  }

  // ---- Two-finger swipes: focus, lift, dismiss, tabs -----------------------------------------------------------
  const resting = () => Dash.panels.filter((p) => p.mode === 'rest' || p.mode === 'entering').sort((a, b) => a.x - b.x || a.y - b.y);
  const focused = () => (focus && document.querySelector(`.dp[data-id="${CSS.escape(focus)}"]`)) || null;
  function setFocus(id) {
    focused()?.classList.remove('hand-focus');
    focus = id;
    const f = focused();
    f?.classList.add('hand-focus');
    if (f) { f.classList.remove('hit'); void f.offsetWidth; f.classList.add('hit'); }
  }
  function swipe(dir) {
    const card = Dash.card;
    if (dir === 'left' || dir === 'right') {
      if (card) { // tabs inside a details view, when it has any
        const tabs = [...document.querySelectorAll('.dp-card [role="tab"], .dp-card .dc-tab')];
        const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true' || t.classList.contains('active'));
        if (tabs.length) return tabs[(i + (dir === 'right' ? 1 : -1) + tabs.length) % tabs.length].click();
        // otherwise step to the neighbouring panel's details
      }
      const list = resting();
      if (!list.length) return;
      const cur = card?.id || focus;
      const i = list.findIndex((p) => p.id === cur);
      const next = list[(i === -1 ? (dir === 'right' ? 0 : list.length - 1) : (i + (dir === 'right' ? 1 : -1) + list.length) % list.length)];
      setFocus(next.id);
      if (card) { Dash.closeCard(); setTimeout(() => Dash.openCard(next.id), 380); }
      return;
    }
    if (dir === 'up') {
      if (Surface.name === 'desktop') return window.ares.hands.act('summon'); // lift ARES
      const f = focused() ? focus : hover?.classList.contains('dp') ? hover.dataset.id : null;
      if (f && !card) return Dash.openCard(f); // expand the focused panel
      if (!card && !Comms.isOpen) Comms.open();
      return;
    }
    if (dir === 'down') {
      if (card) return Dash.closeCard();
      if (Comms.isOpen) return Comms.close();
      if (Work.isOpen) return Work.back();
      const f = focused() ? focus : hover?.classList.contains('dp') ? hover.dataset.id : null;
      if (f) { Dash.dismiss(f); setFocus(null); return; } // into the brain, as a throw would
      if (Surface.name === 'lifted') window.ares.hands.act('hide'); // sink back to the wallpaper
    }
  }

  // ---- Scroll: wherever a reader would scroll ------------------------------------------------------------------
  function scroll(dy) {
    const t = (pos && under(pos)?.closest?.('.dc-text, .cm-list, #jobList, .work-detail, .md, .pv-body'))
      || document.querySelector('.dp-card .dc-text:not([hidden])') || (Comms.isOpen ? document.querySelector('#comms .cm-list') : null);
    if (!t) return;
    t.scrollBy({ top: dy * t.clientHeight, behavior: 'instant' });
    t.dispatchEvent(new Event('scroll'));
    Comms.touch?.();
  }

  // ---- Two-hand zoom: spread a panel into its details, squeeze a card shut, zoom an image, zoom the scene --------
  const core = document.querySelector('.core');
  function zoomStart(a) {
    const m = toPx(a);
    const t = under(m);
    const img = t?.closest?.('img, canvas.chart, .md-app, .pv-body, .mermaid');
    const card = t?.closest?.('.dp-card');
    const panel = t?.closest?.('.dp');
    const kind = img && !panel ? 'image' : card ? 'card' : panel ? 'panel' : 'scene';
    const target = kind === 'image' ? img : kind === 'card' ? card : kind === 'panel' ? panel : core;
    const base = kind === 'image' ? Number(target.dataset.handZoom || 1) : kind === 'scene' ? Number(core.style.getPropertyValue('--hand-zoom') || 1) : 1;
    zoom = { kind, target, base, scale: 1 };
    el.classList.add('zoom');
    if (kind === 'panel') target.classList.add('hand-zooming');
  }
  function zoomUpdate(a) {
    if (!zoom) return;
    zoom.scale = a.scale;
    const z = zoom, s = Math.max(0.3, Math.min(3, z.base * a.scale));
    const pa = toPx(a.a), pb = toPx(a.b);
    pos = toPx(a);
    el.hidden = false;
    el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    // the line between the hands
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    line.style.width = `${Math.hypot(dx, dy)}px`;
    line.style.transform = `translate(${pa.x - pos.x}px, ${pa.y - pos.y}px) rotate(${Math.atan2(dy, dx)}rad)`;
    ringB.style.transform = `translate(${pb.x - pos.x}px, ${pb.y - pos.y}px)`;
    el.querySelector('.hc-ring:not(.two)').style.transform = `translate(${pa.x - pos.x}px, ${pa.y - pos.y}px)`;
    if (z.kind === 'scene') core.style.setProperty('--hand-zoom', String(Math.max(0.7, Math.min(1.4, s))));
    else if (z.kind === 'image') { z.target.style.transform = `scale(${Math.max(1, Math.min(3, s))})`; z.target.style.transformOrigin = 'center'; }
    else if (z.kind === 'panel') z.target.style.setProperty('--hand-scale', String(Math.max(0.5, Math.min(1.6, s))));
    else if (z.kind === 'card') z.target.style.setProperty('--hand-scale', String(Math.max(0.6, Math.min(1.08, s))));
  }
  function zoomEnd(a) {
    const z = zoom;
    zoom = null;
    el.classList.remove('zoom');
    el.querySelector('.hc-ring:not(.two)').style.transform = '';
    if (!z) return;
    const s = a.scale;
    if (z.kind === 'scene') { const v = Math.max(0.7, Math.min(1.4, z.base * s)); core.style.setProperty('--hand-zoom', String(Math.abs(v - 1) < 0.08 ? 1 : v)); return; }
    if (z.kind === 'image') { const v = Math.max(1, Math.min(3, z.base * s)); z.target.dataset.handZoom = String(v); z.target.style.transform = v > 1.02 ? `scale(${v})` : ''; return; }
    z.target.style.removeProperty('--hand-scale');
    z.target.classList.remove('hand-zooming');
    if (z.kind === 'panel') {
      if (s > 1.3) Dash.openCard(z.target.dataset.id);          // spread: toward its details view
      else if (s < 0.6) Dash.collapse(z.target.dataset.id);     // squeeze: folds into an orb and settles back
    } else if (z.kind === 'card' && s < 0.75) Dash.closeCard();
  }

  // ---- Open palm: summon, or a silent stop while she speaks ------------------------------------------------------
  function palm() {
    if (App.state === 'speaking' || App.state === 'thinking') return App.stopSilently('a raised hand');
    if (Surface.name === 'desktop') return window.ares.hands.act('summon');
    if (Surface.name === 'window' && !document.hasFocus()) return window.ares.hands.act('summon');
  }

  // ---- Feedback: a soft tick that follows the system volume (it's just app audio) --------------------------------
  let ac = null;
  function tick(freq) {
    try {
      ac ||= new AudioContext();
      const t = ac.currentTime;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 0.7, t + 0.05);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.08);
    } catch {}
  }

  // ---- Actions from the engine ----------------------------------------------------------------------------------
  function apply(a) {
    switch (a.type) {
      case 'state':
        state = a.state;
        document.documentElement.dataset.hands = state;
        if (state !== 'engaged') { if (pressed) up(pos ? { x: pos.x / innerWidth, y: pos.y / innerHeight } : { x: 0.5, y: 0.5 }, { cancel: true }); hideCursor(); setFocus(null); }
        else { el.classList.remove('appear'); void el.offsetWidth; el.classList.add('appear'); tick(880); }
        dispatchEvent(new CustomEvent('hands', { detail: state }));
        break;
      case 'cursor': if (a.lost) hideCursor(); else showCursor(a, a.pose); break;
      case 'down': if (a.mac) tick(660); else down(a); break;
      case 'move': move(a); break;
      case 'up': if (a.mac) tick(520); else up(a, a); break;
      case 'swipe': tick(a.dir === 'down' ? 440 : 720); swipe(a.dir); break;
      case 'scroll': scroll(a.dy); break;
      case 'zoom': if (a.phase === 'start') { zoomStart(a); } else if (a.phase === 'update') zoomUpdate(a); else zoomEnd(a); break;
      case 'palm': tick(600); palm(); break;
      default: break;
    }
  }
  window.ares.hands.onActions((list) => { for (const a of list) apply(a); });

  return {
    get state() { return state; },
    get cursor() { return pos; },
    get focus() { return focus; },
    /** Development: feed a clip (scripts/hands-synth.js shape) through the live engine and watch it drive the scene. */
    test(clip, opts) { return window.ares.hands.replay(clip, opts); },
    apply, // (for driving from the console)
  };
})();
