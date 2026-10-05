// Panels v2 (docs/panels-prompt.md) without the app: the flow layout (renderer/flow.js) in Node, with every kind of size
// change, plus the main-process pieces with fakes (an in-memory EventKit, a fake Tasks API, custom panel sources):
//   node scripts/test-panels.js [-v]
// Invariants checked after every change: no two panels overlap, nothing leaves the stage, nothing covers the brain, the
// icon walls or a panel the user placed by hand; least important panels step down first; space given back is retaken.
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = path.join(__dirname, '..');
const Flow = require(path.join(root, 'renderer', 'flow.js'));

const V = process.argv.includes('-v');
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail && (!ok || V) ? `  ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`); if (!ok) failures++; };

// ---- The flow -------------------------------------------------------------------------------------------------------
const STD = { full: { w: 214, h: 62 }, compact: { w: 170, h: 44 }, mini: { w: 130, h: 26 } };
const stage = { W: 1200, H: 700, brain: { x: 600, y: 342, r: 262 } };
const item = (id, side, rank, o = {}) => ({ id, side, rank, sizes: STD, born: rank, ...o });
const boxes = (r, items) => Object.entries(r.places).map(([id, pl]) => { const it = items.find((x) => x.id === id); const s = it.sizes[pl.tier]; return { id, x: pl.x, y: pl.y, w: s.w, h: s.h, tier: pl.tier, side: pl.side }; });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function invariants(name, o, r) {
  const bs = boxes(r, o.items);
  const bad = [];
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (a.x < 0 || a.y < 0 || a.x + a.w > o.W || a.y + a.h > o.H) bad.push(`${a.id} off-stage`);
    for (let j = i + 1; j < bs.length; j++) if (overlap(a, bs[j])) bad.push(`${a.id} overlaps ${bs[j].id}`);
    for (const w of o.walls || []) if (overlap(a, w)) bad.push(`${a.id} covers icons`);
    for (const f of o.fixed || []) if (overlap(a, f)) bad.push(`${a.id} covers a free panel`);
    if (o.brain) { const nx = Math.max(a.x, Math.min(o.brain.x, a.x + a.w)), ny = Math.max(a.y, Math.min(o.brain.y, a.y + a.h)); if (Math.hypot(o.brain.x - nx, o.brain.y - ny) < o.brain.r) bad.push(`${a.id} covers the brain`); }
  }
  check(`${name}: invariants`, !bad.length, bad.join(', '));
  return bs;
}

{
  const items = [item('next', 'left', 1), item('timer', 'left', 2), item('work', 'right', 1), item('call', 'right', 2)];
  const o = { ...stage, items };
  const r = Flow.solve(o);
  const bs = invariants('four panels', o, r);
  check('all full', bs.every((b) => b.tier === 'full'));
  check('left column flows down', bs.find((b) => b.id === 'timer').y > bs.find((b) => b.id === 'next').y);
  check('right column right-aligned', bs.filter((b) => b.side === 'right').every((b) => b.x + b.w === o.W - 14));
  check('edges', r.edges.left === 14 + 214 && r.edges.right === o.W - 14 - 214, JSON.stringify(r.edges));
}
{
  // A panel grows (the calendar opening WEEK): the ones under it move down, nothing overlaps; it shrinks: they come back
  const cal = item('calendar', 'left', 1, { sizes: { full: { w: 250, h: 240 }, compact: STD.compact, mini: STD.mini }, pinned: true });
  const items = [cal, item('next', 'left', 2), item('timer', 'left', 3)];
  const before = Flow.solve({ ...stage, items });
  cal.sizes = { ...cal.sizes, full: { w: 372, h: 420 } };
  // (dash.js shifts the brain aside for a column this wide, as it does for icons: here it has moved right)
  const shifted = { ...stage, brain: { x: 760, y: 342, r: 262 } };
  const grown = Flow.solve({ ...shifted, items });
  invariants('calendar grown to week', { ...shifted, items }, grown);
  check('calendar kept full', grown.places.calendar.tier === 'full', JSON.stringify(grown.places.calendar));
  check('neighbours moved down', grown.places.next.y >= 12 + 420 + 10 || grown.places.next.x !== before.places.next.x, JSON.stringify(grown.places));
  cal.sizes = { ...cal.sizes, full: { w: 250, h: 240 } };
  const back = Flow.solve({ ...stage, items });
  check('neighbours come back', JSON.stringify(back.places) === JSON.stringify(before.places));
}
{
  // Too many panels on one side: the least important (contextual, oldest) step down first; pinned never below compact
  const items = [item('calendar', 'left', 1, { pinned: true, born: 0, sizes: { full: { w: 250, h: 240 }, compact: STD.compact, mini: STD.mini } })];
  for (let i = 0; i < 9; i++) items.push(item(`t${i}`, 'left', i + 2, { born: i + 1 }));
  const o = { ...stage, H: 520, items };
  const r = Flow.solve(o);
  const bs = invariants('crowded side', o, r);
  check('nothing overflowed', !r.overflow.length, r.overflow.join(','));
  const tiers = Object.fromEntries(bs.map((b) => [b.id, b.tier]));
  check('pinned calendar still full', tiers.calendar === 'full', JSON.stringify(tiers));
  const oldest = ['t0', 't1', 't2'].map((k) => tiers[k]), newest = ['t6', 't7', 't8'].map((k) => tiers[k]);
  const rank = (t) => Flow.TIERS.indexOf(t);
  check('oldest stepped down at least as far as newest', Math.min(...oldest.map(rank)) >= Math.max(...newest.map(rank)), JSON.stringify(tiers));
  // Space returns (taller stage): everything back to full
  const r2 = Flow.solve({ ...o, H: 2000 });
  check('space back: all full again', boxes(r2, items).every((b) => b.tier === 'full'));
}
{
  // Pinned panels never disappear: a tiny stage, everything at least placed
  const items = [item('calendar', 'left', 1, { pinned: true }), item('tasks', 'left', 2, { pinned: true }), item('next', 'left', 3), item('work', 'right', 1)];
  const o = { W: 700, H: 240, brain: { x: 350, y: 112, r: 90 }, items };
  const r = Flow.solve(o);
  invariants('tiny stage', o, r);
  check('pinned placed', r.places.calendar && r.places.tasks, JSON.stringify(r.overflow));
  check('pinned at least compact', ['full', 'compact'].includes(r.places.calendar.tier) && ['full', 'compact'].includes(r.places.tasks.tier));
}
{
  // Desktop icon walls down the right edge push the right column inwards or over to the left; nothing covers an icon
  const walls = [{ x: 1000, y: 0, w: 200, h: 700 }];
  const items = [item('next', 'left', 1), item('work', 'right', 1), item('call', 'right', 2), item('music', 'right', 3)];
  const o = { ...stage, walls, items };
  const r = Flow.solve(o);
  invariants('icon walls', o, r);
  check('every panel placed around the icons', !r.overflow.length, r.overflow.join(','));
}
{
  // A free panel (placed by hand) keeps its spot; the flow goes around it
  const fixed = [{ x: 14, y: 100, w: 214, h: 62 }];
  const items = [item('a', 'left', 1), item('b', 'left', 2), item('c', 'left', 3)];
  const o = { ...stage, fixed, items };
  const r = Flow.solve(o);
  invariants('free panel obstacle', o, r);
  check('flow skips the free panel', boxes(r, items).every((b) => !overlap(b, fixed[0])));
}
{
  // A detail card open over a docked panel: the panel's size is the card's and it keeps its density; neighbours move
  const items = [item('next', 'right', 1, { sizes: { full: { w: 300, h: 260 }, compact: { w: 300, h: 260 }, mini: { w: 300, h: 260 } }, tier: 'full' }), item('work', 'right', 2), item('call', 'right', 3)];
  const o = { ...stage, items };
  const r = Flow.solve(o);
  invariants('card open', o, r);
  check('card keeps full', r.places.next.tier === 'full');
  check('neighbour below the card', r.places.work.y >= 12 + 260 + 10 || r.places.work.x + 214 <= r.places.next.x, JSON.stringify(r.places));
}
{
  // Dropping an orb: the rank between neighbours
  const docked = [{ side: 'left', rank: 1, y: 12, h: 62 }, { side: 'left', rank: 2, y: 84, h: 62 }, { side: 'left', rank: 3, y: 156, h: 62 }];
  check('rank between first and second', Flow.rankAt('left', 100, docked) === 1.5);
  check('rank at the end', Flow.rankAt('left', 400, docked) === 4);
  check('rank before the first', Flow.rankAt('left', 0, docked) === 0);
  check('rank on an empty side', Flow.rankAt('right', 100, docked) === 1);
}

module.exports = { check, invariants };
if (require.main === module) {
  Promise.resolve(require('./test-panels-main.js')?.run?.(check)).catch((err) => { console.log('FAIL  main-process tests crashed', err.message); failures++; }).then(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nall ok');
    process.exit(failures ? 1 : 0);
  });
}
