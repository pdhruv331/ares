// The ARES window as the live desktop (surface.js in the main process). One page, three looks:
//   desktop  transparent over the desktop icons (the starry backdrop is below them), no typing box, no window buttons;
//            clicks pass through to Finder except over panels, orbs and the status area; paced like the wallpaper
//   lifted   summoned above the apps: the dark glass fades in, fully interactive; fades out again when it sinks.
//            BLENDED (the ARES OS theme): no glass, no window chrome, click-through except over her things; lifted
//            for one panel (html.panel-lift, data-lift = work | status | call | job), only that panel shows
//   window   the classic window
const Surface = (() => {
  const root = document.documentElement;
  let name = 'window';
  let mode = { paused: false, still: false, battery: false };
  let herState = 'idle';
  let drawUntil = 0;

  let blend = false;
  function set(next, extra = {}) {
    blend = Boolean(extra.blend);
    root.classList.toggle('blend', blend);
    root.classList.toggle('panel-lift', next === 'lifted' && Boolean(extra.panel));
    if (next === 'lifted' && extra.panel) root.dataset.lift = extra.panel; else delete root.dataset.lift;
    if (next === name) return;
    name = next;
    if (next === 'desktop' || next === 'window') portalClear(); // (sunk some other way: no circle left behind)
    for (const s of ['desktop', 'lifted', 'sinking', 'window']) root.classList.toggle(`s-${s}`, s === next);
    drawUntil = performance.now() + 2500;
    if (next !== 'desktop') { held = false; lastHits = ''; }
    window.SCENE_NO_SPIN = next === 'desktop' || next === 'sinking'; // the brain holds still as the desktop
    dispatchEvent(new CustomEvent('surface', { detail: next }));
  }

  // ---- Frame pacing on the desktop: paused when covered, full screen, locked or asleep (nothing drawn at all); 60 fps on
  // mains power, 30 on battery, a still frame in Low Power Mode. Lifted or as a window, Perf's normal rules apply.
  Perf.setPolicy(() => {
    if (name !== 'desktop') return undefined;
    if (mode.paused) return 0;
    if (mode.still) return performance.now() < drawUntil ? 30 : 0;
    return mode.battery ? 30 : 60;
  });

  // ---- Click-through: the window takes clicks only over ARES's own things. The main process checks the pointer against
  // the areas reported here (macOS doesn't pass mouse moves to a click-through window of an inactive app). While a
  // detail card, COMMS, the status panel or Work is open, or a button is held (dragging an orb), it takes them all.
  const HIT = '.dp, .dp-card, .titlebar button, .comms-tab, .drop-card, #closeHint';
  // Lifted and blended, she also takes clicks on what's only there when she's up: the typing box, COMMS, Work, status
  const HIT_LIFTED = `${HIT}, .input-zone, #comms, #work, #statusPanel, #subs`;
  let held = false;
  // Something open over the desktop: the whole window takes clicks, so one click anywhere closes it, as in the app
  // (it can't have the keyboard here, so there's no Esc)
  const popover = () => { // (Dash, Work and Comms are later scripts' globals, not window properties)
    try { return Boolean(Dash.card || Work.isOpen || Comms.isOpen || Callouts.isOpen || !document.getElementById('statusPanel').hidden); } catch { return false; }
  };
  let lastHits = '';
  function reportHits() {
    const lifted = name === 'lifted' && blend;
    if (name !== 'desktop' && !lifted) return;
    const rects = [];
    for (const el of document.querySelectorAll(lifted ? HIT_LIFTED : HIT)) {
      if (el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) rects.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }
    const subs = document.getElementById('subs');
    if (subs.innerText.trim()) { const r = subs.getBoundingClientRect(); rects.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }); }
    for (const o of window.JobOrbs?.hits?.() || []) rects.push({ x: Math.round(o.x - o.r), y: Math.round(o.y - o.r), w: Math.round(o.r * 2), h: Math.round(o.r * 2) });
    for (const c of window.Scene?.hits?.() || []) rects.push({ x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) });
    const hits = { rects, all: popover(), held: held || Boolean(window.Scene?.held) };
    const key = JSON.stringify(hits);
    if (key === lastHits) return;
    lastHits = key;
    window.ares.surface.hits(hits);
  }
  setInterval(() => { if (!mode.paused) reportHits(); }, 120);
  addEventListener('pointerdown', () => { held = true; reportHits(); }, true);
  addEventListener('pointerup', () => { held = false; setTimeout(reportHits, 30); }, true);
  addEventListener('pointercancel', () => { held = false; reportHits(); }, true);

  // As the desktop (and lifted while blended) the backdrop window below draws the dot-matrix sheet: this page's copy is hidden
  window.SCENE_TRANSPARENT = true; // the frame's own background is the ink (it fades for the glass, and away as the desktop)
  window.SCENE_BACKDROP_OFF = () => name === 'desktop' || name === 'sinking' || (blend && name === 'lifted');
  window.ares.surface.on(({ name: next, blend: b, panel }) => set(next, { blend: b, panel }));
  let pinned = false; // measuring: a forced mode the main process doesn't override (hold(null) releases it)
  window.ares.surface.onMode((m) => { if (!pinned) applyMode(m); });
  // Where things stand now (the first messages may have come before this page was listening)
  addEventListener('load', () => window.ares.surface.state().then((st) => {
    set(st.name, { blend: st.blend, panel: st.panel });
    if (st.mode) applyMode(st.mode);
    if (st.icons) dispatchEvent(new CustomEvent('desk-icons', { detail: st.icons }));
  }));
  function applyMode(m) {
    if (m.still && !mode.still) drawUntil = performance.now() + 2500;
    const wasBattery = mode.battery;
    mode = { paused: Boolean(m.paused), still: Boolean(m.still), battery: Boolean(m.battery) };
    if (name === 'desktop' && mode.battery !== wasBattery) { window.SCENE_DPR = mode.battery ? 1 : undefined; dispatchEvent(new Event('scene-quality')); }
  }

  // ---- The portal (docs/orb-prompt.md §2): summoned from the corner orb, ARES is revealed behind a circle that grows from
  // the orb's centre to the whole screen, a thin bright edge on the growing circle, ~0.6 s ease-in-out; closing runs it
  // back into the orb (the main process sinks the window as it reaches it).
  const PORTAL_MS = 600;
  let portalAnim = null, portalEdge = null;
  function portal({ open, x, y }) {
    const body = document.body;
    if (open) {
      portalAt = { x, y };
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 2;
      portalAnim?.cancel();
      body.style.clipPath = `circle(0px at ${x}px ${y}px)`;
      portalAnim = body.animate([{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${r}px at ${x}px ${y}px)` }], { duration: PORTAL_MS, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' });
      portalAnim.finished.then(() => { if (portalAt) { body.style.clipPath = ''; portalAnim?.cancel(); portalAnim = null; } }, () => {});
      edge(x, y, 0, r);
    } else if (portalAt) {
      const { x: px, y: py } = portalAt;
      const r = Math.hypot(Math.max(px, innerWidth - px), Math.max(py, innerHeight - py)) + 2;
      portalAnim?.cancel();
      portalAnim = body.animate([{ clipPath: `circle(${r}px at ${px}px ${py}px)` }, { clipPath: `circle(0px at ${px}px ${py}px)` }], { duration: PORTAL_MS, easing: 'cubic-bezier(.6,0,.4,1)', fill: 'forwards' });
      edge(px, py, r, 0);
      const anim = portalAnim;
      anim.finished.then(() => { if (portalAnim === anim) { portalAt = null; } }, () => {});
    }
  }
  let portalAt = null;
  function edge(x, y, r0, r1) {
    portalEdge?.remove();
    const e = portalEdge = document.createElement('div');
    e.className = 'portal-edge';
    e.style.left = `${x}px`; e.style.top = `${y}px`;
    document.body.append(e);
    e.animate([{ width: `${r0 * 2}px`, height: `${r0 * 2}px`, opacity: 1 }, { width: `${r1 * 2}px`, height: `${r1 * 2}px`, opacity: 1, offset: 0.9 }, { width: `${r1 * 2}px`, height: `${r1 * 2}px`, opacity: 0 }],
      { duration: PORTAL_MS, easing: r1 > r0 ? 'cubic-bezier(.45,0,.2,1)' : 'cubic-bezier(.6,0,.4,1)', fill: 'forwards' }).finished.then(() => { if (portalEdge === e) { e.remove(); portalEdge = null; } }, () => {});
  }
  function portalClear() {
    if (!portalAt && !portalAnim) return;
    portalAnim?.cancel(); portalAnim = null; portalAt = null;
    document.body.style.clipPath = '';
    portalEdge?.remove(); portalEdge = null;
  }
  window.ares.orb?.onPortal?.((p) => portal(p || {}));

  return {
    get name() { return name; },
    get portal() { return Boolean(portalAt); },
    get paused() { return name === 'desktop' && mode.paused; },
    get hits() { return lastHits ? JSON.parse(lastHits) : null; },
    hold(m) { pinned = Boolean(m); if (m) { applyMode(m); if (m.state) herState = m.state; } },
    /** ARES's state (for 60 fps while she listens or speaks). */
    state(s) { herState = s; },
  };
})();
