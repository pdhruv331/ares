// Translucency when things overlap (docs/reactor-prompt.md, section 6), one general rule: whatever is on top stays solid;
// anything it covers fades to ~20% and comes back when it's clear (~0.15 s each way, the fade itself is done by each
// owner). Stacking order, bottom to top: job orbs and their labels → callout labels → panels (the expanded calendar is
// just a wide panel) → detail cards and callout cards → orbs being dragged or thrown (the panels' and the jobs').
// This complements the flow (flow.js moves panels out of the way where it can); this handles what reflow can't: moving
// orbs, floating cards, cards over the reactor area. Hit-testing already follows the same order (DOM above the canvas,
// callouts before orbs in scene.js), so a faded thing is only clickable when it's on top.
const Overlap = (() => {
  if (!window.Scene || typeof Dash === 'undefined') return null;
  const Z = { orb: 0, callout: 1, panel: 2, card: 3, flying: 4 };
  const hits = (a, b) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2;
  const state = { orb: new Map(), callout: new Map(), panel: new Map() };

  function tick() {
    if (document.hidden) return;
    const items = [];
    const reactor = window.SCENE_LOOK === 'reactor';
    if (reactor) {
      for (const r of window.JobOrbs.rects()) items.push({ kind: r.flying ? 'flying' : 'orb', id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, z: r.flying ? Z.flying : Z.orb });
      for (const c of Scene.calloutRects()) items.push({ kind: 'callout', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, z: Z.callout });
    }
    const st = Dash.stageRect;
    for (const p of Dash.panels) {
      if (p.mode === 'rest' || p.mode === 'entering') items.push({ kind: 'panel', id: p.id, x: st.left + p.x, y: st.top + p.y, w: p.w, h: p.h, z: Z.panel });
      else if (['orb', 'flying', 'docking', 'absorbing'].includes(p.mode) && Number.isFinite(p.ox)) items.push({ kind: 'flying', id: p.id, x: st.left + p.ox - 14, y: st.top + p.oy - 14, w: 28, h: 28, z: Z.flying });
    }
    const cb = Dash.cardBox;
    if (cb) items.push({ kind: 'card', id: 'card', x: st.left + cb.left, y: st.top + cb.top, w: cb.width, h: cb.height, z: Z.card });
    const cc = window.Callouts?.cardRect?.();
    if (cc) items.push({ kind: 'card', id: 'ccard', x: cc.x, y: cc.y, w: cc.w, h: cc.h, z: Z.card });

    const covered = { orb: new Set(), callout: new Set(), panel: new Set() };
    for (const it of items) {
      if (it.z >= Z.flying || !(it.kind in covered)) continue;
      if (items.some((o) => o !== it && o.z > it.z && hits(o, it))) covered[it.kind].add(it.id);
    }
    const apply = (kind, fn) => {
      const seen = new Set();
      for (const it of items) {
        if (it.kind !== kind || seen.has(it.id)) continue;
        seen.add(it.id);
        const on = covered[kind].has(it.id);
        if (state[kind].get(it.id) === on) continue;
        state[kind].set(it.id, on);
        fn(it.id, on);
      }
      for (const id of [...state[kind].keys()]) if (!seen.has(id)) { state[kind].delete(id); fn(id, false); }
    };
    apply('orb', (id, on) => window.JobOrbs.fade(id, on));
    apply('callout', (id, on) => Scene.fadeCallout(id, on));
    apply('panel', (id, on) => Dash.fade(id, on));
  }
  setInterval(tick, 100);
  return { tick };
})();
