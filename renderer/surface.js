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
    if (next !== 'desktop') { interactive = true; held = false; }
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

  // ---- Click-through: forwarded mouse moves are hit-tested; the window takes clicks only where there's something
  // of ARES's under the pointer, and keeps them while a button is held (dragging an orb across the desktop).
  const HIT = '.dp, .dp-card, .titlebar button, .status-panel, .comms, .comms-tab, .work, .drop-card, .work-preview, #closeHint';
  let interactive = false;
  let held = false;
  // Something open over the desktop (a detail card, COMMS, the status panel, Work): the whole window takes clicks, so
  // one click anywhere closes it, as in the app (it can't have the keyboard here, so there's no Esc)
  const popover = () => { // (Dash, Work and Comms are later scripts' globals, not window properties)
    try { return Boolean(Dash.card || Work.isOpen || Comms.isOpen || !document.getElementById('statusPanel').hidden); } catch { return false; }
  };
  function wants(x, y) {
    if (held || popover()) return true;
    const el = document.elementFromPoint(x, y);
    if (el?.closest(HIT)) return !el.closest('[hidden]');
    if (el?.closest('#subs') && document.getElementById('subs').innerText.trim()) return true; // a subtitle: click opens COMMS
    return Boolean(window.JobOrbs?.pick?.(x, y));
  }
  function update(x, y) {
    if (name !== 'desktop') return;
    const on = wants(x, y);
    if (on === interactive) return;
    interactive = on;
    window.ares.surface.interactive(on);
  }
  addEventListener('mousemove', (e) => update(e.clientX, e.clientY), true);
  addEventListener('pointerdown', () => { held = true; }, true);
  addEventListener('pointerup', (e) => { held = false; update(e.clientX, e.clientY); }, true);
  addEventListener('pointercancel', () => { held = false; }, true);
  document.addEventListener('mouseleave', () => { if (!held) update(-1, -1); });

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
    get interactive() { return interactive; },
    hold(m) { pinned = Boolean(m); if (m) { applyMode(m); if (m.state) herState = m.state; } },
    /** ARES's state (for 60 fps while she listens or speaks). */
    state(s) { herState = s; },
  };
})();
