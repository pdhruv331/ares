// The one layout pass for the dashboard's panels (docs/panels-prompt.md, section 0): pure, no DOM, so dash.js runs it
// after every measurement and scripts/test-panels.js can run it in Node.
//
// Panels live in two columns of FLOW, left and right of the brain, in a stable order (their rank). Each has a size per
// density (full / compact / mini); a panel can change size at any time (a calendar switching views, a list growing),
// and the flow moves its neighbours to make room. Obstacles never get covered: the brain, the desktop icon walls and
// the panels the user placed by hand (free panels), which keep their spot. When a side runs out of room the LEAST
// important panels step down a density (contextual before pinned, oldest first), one step at a time, until everything
// fits; what still doesn't fit tries the other side, and only then overflows. The solve is deterministic from its
// inputs, so panels step back up by themselves when space returns.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Flow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TIERS = ['full', 'compact', 'mini'];

  const hitsRect = (x, y, w, h, r, pad) => x < r.x + r.w + pad && r.x < x + w + pad && y < r.y + r.h + pad && r.y < y + h + pad;
  const hitsCircle = (x, y, w, h, c) => {
    const nx = Math.max(x, Math.min(c.x, x + w)), ny = Math.max(y, Math.min(c.y, y + h));
    return Math.hypot(c.x - nx, c.y - ny) < c.r;
  };

  /**
   * @param {object} o
   * @param {number} o.W  @param {number} o.H      the stage
   * @param {number} [o.pad=14] [o.top=12] [o.gap=10]
   * @param {{x,y,r}|null} o.brain                   the brain's circle (nothing is laid over it)
   * @param {Array<{x,y,w,h}>} [o.walls]            desktop icon clusters
   * @param {Array<{x,y,w,h}>} [o.fixed]            free panels and the one just placed: obstacles that keep their spot
   * @param {Array<{id, side, rank, sizes: {full:{w,h}, compact:{w,h}, mini:{w,h}}, minTier?, pinned?, born?, tier?}>} o.items
   *        tier: a density the panel insists on (a card open over it), never stepped down
   * @returns {{ places: Object<string, {x,y,tier,side,col}>, overflow: string[], edges: {left:number, right:number} }}
   */
  function solve(o) {
    const { W, H, pad = 14, top = 12, gap = 10, brain = null, walls = [], fixed = [], items = [] } = o;
    const tier = {};
    for (const it of items) tier[it.id] = it.tier || 'full';
    const minOf = (it) => it.tier || it.minTier || (it.pinned ? 'compact' : 'mini');
    const canStep = (it) => TIERS.indexOf(tier[it.id]) < TIERS.indexOf(minOf(it));
    // Least important first: contextual before pinned, then oldest first; among equals the fullest steps down first
    const order = (a, b) => (Number(Boolean(a.pinned)) - Number(Boolean(b.pinned))) || ((a.born || 0) - (b.born || 0)) || (TIERS.indexOf(tier[a.id]) - TIERS.indexOf(tier[b.id]));

    const obstacles = [...walls, ...fixed];
    const blocked = (x, y, w, h) => (brain && hitsCircle(x, y, w, h, brain)) || obstacles.some((r) => hitsRect(x, y, w, h, r, gap / 2));
    // The lowest y >= from where a w×h box fits in the column at x (nothing under it), or null before the bottom
    const drop = (x, from, w, h) => {
      let y = from;
      for (let k = 0; k < 400 && y + h <= H - 4; k++) {
        if (!blocked(x, y, w, h)) return y;
        y += 3;
      }
      return null;
    };
    const half = W / 2;

    function flow(side, list) {
      const placed = {}, rest = [];
      let colEdge = side === 'left' ? pad : W - pad; // the column's outer edge
      let colW = 0, y = top, col = 0;
      for (const it of list) {
        const { w, h } = it.sizes[tier[it.id]] || it.sizes.full;
        for (;;) {
          const x = side === 'left' ? colEdge : colEdge - w;
          const onSide = side === 'left' ? x >= 0 && x + w <= half - gap : x + w <= W && x >= half + gap;
          const at = onSide ? drop(x, y, w, h) : null;
          if (at != null) { placed[it.id] = { x, y: at, tier: tier[it.id], side, col }; y = at + h + gap; colW = Math.max(colW, w); break; }
          if (!onSide || (y === top && colW === 0)) { rest.push(it); break; } // a fresh column and still no room
          colEdge = side === 'left' ? colEdge + colW + gap : colEdge - colW - gap; // next column
          colW = 0; y = top; col++;
        }
      }
      return { placed, rest };
    }

    const bySide = (s) => items.filter((it) => it.side === s).sort((a, b) => a.rank - b.rank);
    let result;
    for (let round = 0; round < 60; round++) {
      const L = flow('left', bySide('left')), R = flow('right', bySide('right'));
      // What a side can't hold goes to the end of the other side (icons may fill one side)
      const L2 = L.rest.length ? flow('right', [...bySide('right'), ...L.rest]) : null;
      const R2 = R.rest.length ? flow('left', [...bySide('left'), ...R.rest]) : null;
      const places = { ...(R2 || L).placed, ...(L2 || R).placed };
      const overflow = items.filter((it) => !places[it.id]).map((it) => it.id);
      result = { places, overflow };
      if (!overflow.length) break;
      const step = items.filter(canStep).sort(order)[0];
      if (!step) break;
      tier[step.id] = TIERS[TIERS.indexOf(tier[step.id]) + 1];
    }
    const edges = { left: pad, right: W - pad };
    for (const [id, pl] of Object.entries(result.places)) {
      const it = items.find((x) => x.id === id);
      const { w } = it.sizes[pl.tier] || it.sizes.full;
      if (pl.side === 'left') edges.left = Math.max(edges.left, pl.x + w); else edges.right = Math.min(edges.right, pl.x);
    }
    return { ...result, edges };
  }

  /** Where a dropped orb joins a side's flow: the rank just before the first docked panel below it. */
  function rankAt(side, y, docked) {
    const list = docked.filter((p) => p.side === side).sort((a, b) => a.rank - b.rank);
    const below = list.find((p) => p.y + p.h / 2 > y);
    if (!below) return (list.length ? list[list.length - 1].rank : 0) + 1;
    const i = list.indexOf(below);
    return i === 0 ? below.rank - 1 : (list[i - 1].rank + below.rank) / 2;
  }

  return { solve, rankAt, TIERS };
});
