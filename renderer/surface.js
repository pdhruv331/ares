// The ARES window as the live desktop (surface.js in the main process). One page, three looks:
//   desktop  transparent over the desktop icons (the starry backdrop is below them), no typing box, no window buttons;
//            clicks pass through to Finder except over panels, orbs and the status area; paced like the wallpaper
//   lifted   summoned above the apps: the dark glass fades in, fully interactive; fades out again when it sinks
//   window   the classic window
const Surface = (() => {
  const root = document.documentElement;
  let name = 'window';
  let mode = { paused: false, still: false, battery: false };
  let herState = 'idle';
  let drawUntil = 0;

  function set(next) {
    if (next === name) return;
    name = next;
    for (const s of ['desktop', 'lifted', 'sinking', 'window']) root.classList.toggle(`s-${s}`, s === next);
    drawUntil = performance.now() + 2500;
    if (next !== 'desktop') { held = false; lastHits = ''; }
    window.SCENE_NO_SPIN = next === 'desktop' || next === 'sinking'; // the brain holds still as the desktop
    dispatchEvent(new CustomEvent('surface', { detail: next }));
  }

  // ---- Frame pacing on the desktop: paused when covered, full screen, locked or asleep; 30 fps, 60 while she listens
  // or speaks, 18 on battery, a still frame in Low Power Mode. Lifted or as a window, Perf's normal rules apply.
  Perf.setPolicy(() => {
    if (name !== 'desktop') return undefined;
    if (mode.paused) return 0;
    if (mode.still) return performance.now() < drawUntil ? 30 : 0;
    if (mode.battery) return 18;
    return herState === 'listening' || herState === 'speaking' ? 60 : 30;
  });

  // ---- Click-through: the window takes clicks only over ARES's own things. The main process checks the pointer against
  // the areas reported here (macOS doesn't pass mouse moves to a click-through window of an inactive app). While a
  // detail card, COMMS, the status panel or Work is open, or a button is held (dragging an orb), it takes them all.
  const HIT = '.dp, .dp-card, .titlebar button, .comms-tab, .drop-card, #closeHint';
  let held = false;
  // Something open over the desktop: the whole window takes clicks, so one click anywhere closes it, as in the app
  // (it can't have the keyboard here, so there's no Esc)
  const popover = () => { // (Dash, Work and Comms are later scripts' globals, not window properties)
    try { return Boolean(Dash.card || Work.isOpen || Comms.isOpen || !document.getElementById('statusPanel').hidden); } catch { return false; }
  };
  let lastHits = '';
  function reportHits() {
    if (name !== 'desktop') return;
    const rects = [];
    for (const el of document.querySelectorAll(HIT)) {
      if (el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) rects.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }
    const subs = document.getElementById('subs');
    if (subs.innerText.trim()) { const r = subs.getBoundingClientRect(); rects.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }); }
    for (const o of window.JobOrbs?.hits?.() || []) rects.push({ x: Math.round(o.x - o.r), y: Math.round(o.y - o.r), w: Math.round(o.r * 2), h: Math.round(o.r * 2) });
    const hits = { rects, all: popover(), held };
    const key = JSON.stringify(hits);
    if (key === lastHits) return;
    lastHits = key;
    window.ares.surface.hits(hits);
  }
  setInterval(() => { if (!mode.paused) reportHits(); }, 120);
  addEventListener('pointerdown', () => { held = true; reportHits(); }, true);
  addEventListener('pointerup', () => { held = false; setTimeout(reportHits, 30); }, true);
  addEventListener('pointercancel', () => { held = false; reportHits(); }, true);

  window.ares.surface.on(({ name: next }) => set(next));
  let pinned = false; // measuring: a forced mode the main process doesn't override (hold(null) releases it)
  window.ares.surface.onMode((m) => { if (!pinned) applyMode(m); });
  // Where things stand now (the first messages may have come before this page was listening)
  addEventListener('load', () => window.ares.surface.state().then((st) => {
    set(st.name);
    if (st.mode) applyMode(st.mode);
    if (st.icons) dispatchEvent(new CustomEvent('desk-icons', { detail: st.icons }));
  }));
  function applyMode(m) {
    if (m.still && !mode.still) drawUntil = performance.now() + 2500;
    const wasBattery = mode.battery;
    mode = { paused: Boolean(m.paused), still: Boolean(m.still), battery: Boolean(m.battery) };
    if (name === 'desktop' && mode.battery !== wasBattery) { window.SCENE_DPR = mode.battery ? 1 : undefined; dispatchEvent(new Event('scene-quality')); }
  }

  return {
    get name() { return name; },
    get paused() { return name === 'desktop' && mode.paused; },
    get hits() { return lastHits ? JSON.parse(lastHits) : null; },
    hold(m) { pinned = Boolean(m); if (m) { applyMode(m); if (m.state) herState = m.state; } },
    /** ARES's state (for 60 fps while she listens or speaks). */
    state(s) { herState = s; },
  };
})();
