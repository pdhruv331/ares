// Hand gestures (docs/hand-tracking-prompt.md). The camera lives in native/AresVision.swift (ares-vision); only joint
// coordinates arrive here. This file is the gesture ENGINE: pure functions and a state machine fed one frame at a time,
// with the frame's own timestamp as its clock, so recorded streams replay exactly (scripts/test-hands.js).
//
//   off → watching (10 fps, 640×480; 5 fps on battery) → open palm held still ~0.3 s → engaged (30 fps, 1280×720)
//       → hands gone for 3 s → watching
//
// The engine only says what the hands did: cursor, down/move/up (a pinch), swipe, scroll, zoom, palm. hands-driver.js
// turns that into the same pointer events and panel calls the mouse uses; there is no second copy of the interactions.
//
// Frame: { ts (ms), aspect (camera w/h), key (s since the last key press, or null), face: [x,y,w,h] | null,
//          hands: [{ side, c, j: [[x,y,c] | null × 21] }] }   x,y normalised 0…1, top-left origin, x mirrored.

// Joint indices (the order ares-vision sends, as MediaPipe)
const J = { WRIST: 0, THUMB_MP: 2, THUMB_IP: 3, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_PIP: 10,
  MIDDLE_TIP: 12, RING_MCP: 13, RING_PIP: 14, RING_TIP: 16, LITTLE_MCP: 17, LITTLE_PIP: 18, LITTLE_TIP: 20 };

/** Every threshold, tunable from settings.json (hands.tune) without code changes. Sizes are in palm lengths. */
const DEFAULTS = {
  engageMs: 300,        // open palm held still this long while watching → engaged
  summonMs: 500,        // open palm held still this long while engaged → summon / silent stop
  graceMs: 3000,        // engaged: hands gone this long → watching
  keyQuietMs: 1000,     // everything ignored this long after any key press
  stillTol: 0.35,       // palm may wander this far (palm lengths) and still be "held"
  pinchOn: 0.30,        // thumb tip–index tip distance / palm length: pinched below this…
  pinchOff: 0.48,       // …released above this (hysteresis)
  clickMs: 380,         // pinch released sooner than this without moving = a click
  pinchWaitMs: 140,     // a new pinch waits this long for the other hand (two-hand zoom) before pressing
  dragDead: 0.035,      // the pinch must move this far (fraction of the display) before it's a drag; jitter stays a click
  bottomIgnore: 0.94,   // while watching: hands right at the bottom edge (resting on the keyboard) can't engage
  edge: 0.04,           // nor right at the frame's edges
  faceMargin: 0.55,     // "near my face": inside the face box grown by this fraction of its width
  box: { hands: 5.0, aspect: 0.62, min: 0.28, max: 0.9, minH: 0.26, pad: 0.02 }, // interaction box: width in palm lengths, centred where the palm engaged, kept inside the frame
  swipeDist: 1.1,       // two-finger swipe: at least this far (palm lengths)…
  swipeSpeed: 3.2,      // …at least this fast (palm lengths per second)…
  swipeAxis: 1.6,       // …and mostly along one axis
  swipeCooldownMs: 650, // then nothing more until the hand has settled
  scrollDead: 0.18,     // two-finger drift slower than this (palm lengths/s) doesn't scroll
  scrollMax: 2.2,       // faster than this is a swipe, not a scroll
  scrollHoldMs: 220,    // two-finger pose held this long before drift scrolls
  scrollGain: 1.6,      // display heights scrolled per box height of hand travel
  zoomTau: 90,          // zoom damping time constant (ms)
  zoomLock: 350,        // a lost hand ends the zoom after this long
  watchFps: 10, watchFpsBattery: 5, engagedFps: 30,
};

function tune(over = {}) {
  return { ...DEFAULTS, ...over, box: { ...DEFAULTS.box, ...(over.box || {}) } };
}

// ---- Geometry (pure) ---------------------------------------------------------------------------------------------
/** Joints in a uniform space (x scaled by the camera aspect, so distances mean the same both ways). */
function uniform(hand, aspect) {
  return hand.j.map((p) => (p ? { x: p[0] * aspect, y: p[1], c: p[2] } : null));
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (...ps) => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

/** What can be measured about one hand; null when the palm itself isn't seen well enough. */
function features(hand, aspect = 4 / 3) {
  const u = uniform(hand, aspect);
  let w = u[J.WRIST], im = u[J.INDEX_MCP], mm = u[J.MIDDLE_MCP], lm = u[J.LITTLE_MCP];
  // One missing knuckle is filled in from its neighbours; without a wrist or the middle knuckle there's no palm to measure
  im ||= mm && lm ? { x: 2 * mm.x - lm.x, y: 2 * mm.y - lm.y } : null;
  lm ||= mm && im ? { x: 2 * mm.x - im.x, y: 2 * mm.y - im.y } : null;
  mm ||= im && lm ? mid(im, lm) : null;
  if (!w || !im || !mm || !lm) return null;
  const size = dist(w, mm);
  if (size < 0.02) return null;
  const palm = mid(w, im, mm, lm);
  // A finger is straight when its tip is well beyond its knuckle from the wrist, curled when it folds back
  const reach = (tip, mcp) => (u[tip] && u[mcp] ? dist(w, u[tip]) / Math.max(1e-6, dist(w, u[mcp])) : null);
  const fingers = { index: reach(J.INDEX_TIP, J.INDEX_MCP), middle: reach(J.MIDDLE_TIP, J.MIDDLE_MCP),
    ring: reach(J.RING_TIP, J.RING_MCP), little: reach(J.LITTLE_TIP, J.LITTLE_MCP) };
  const pinch = u[J.THUMB_TIP] && u[J.INDEX_TIP] ? dist(u[J.THUMB_TIP], u[J.INDEX_TIP]) / size : null;
  const thumbOut = u[J.THUMB_TIP] ? dist(u[J.THUMB_TIP], im) / size : null;
  const spread = dist(im, lm) / size; // knuckles across: ~0.6+ facing the camera, small side-on
  const twoTip = u[J.INDEX_TIP] && u[J.MIDDLE_TIP] ? mid(u[J.INDEX_TIP], u[J.MIDDLE_TIP]) : null;
  const thumbUp = u[J.THUMB_TIP] ? (im.y - u[J.THUMB_TIP].y) / size : null;
  return { size, palm, palmN: { x: palm.x / aspect, y: palm.y }, fingers, pinch, thumbOut, spread, twoTip, thumbUp, aspect };
}

const STRAIGHT = 1.45, CURLED = 1.2;
/** Pose: 'pinch' | 'open' | 'two' | 'thumbs' | 'other'. wasPinch keeps a pinch until it's clearly released. */
function classify(f, wasPinch = false, o = DEFAULTS) {
  if (!f) return 'none';
  const { index, middle, ring, little } = f.fingers;
  const straight = (r) => r != null && r > STRAIGHT;
  const curled = (r) => r != null && r < CURLED;
  if (f.pinch != null) {
    if (wasPinch ? f.pinch < o.pinchOff : f.pinch < o.pinchOn && index != null && index > 1.1) return 'pinch'; // (not a fist)
  }
  if (straight(index) && straight(middle) && straight(ring) && straight(little) && (f.thumbOut ?? 0) > 0.3 && f.spread > 0.4) return 'open';
  if (straight(index) && straight(middle) && curled(ring) && curled(little)) return 'two';
  if (curled(index) && curled(middle) && curled(ring) && curled(little) && (f.thumbUp ?? 0) > 0.6) return 'thumbs';
  return 'other';
}

/** The interaction box: sized by the hand (near or far works the same), centred where the palm engaged (so wherever
 *  the hand naturally is, the whole display is in reach), and kept inside the frame. Uniform space (x × aspect). */
function boxFor(size, aspect, o = DEFAULTS, centre = null) {
  const b = o.box;
  const c = centre || { x: 0.5 * aspect, y: 0.6 };
  let w = Math.min(b.max * aspect, Math.max(b.min * aspect, size * b.hands));
  let h = w * b.aspect;
  // Near the bottom of the frame: the box can't reach below it, so it shrinks a little, then shifts up
  h = Math.max(b.minH, Math.min(h, 2 * (1 - b.pad - c.y)));
  w = Math.min(w, h / b.aspect);
  const cy = Math.min(Math.max(c.y, h / 2 + b.pad), 1 - b.pad - h / 2);
  const cx = Math.min(Math.max(c.x, w / 2 + b.pad), aspect - b.pad - w / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
/** A point (uniform space) → the display, 0…1 each way. */
function toDisplay(p, box) {
  const c = (v) => Math.min(1, Math.max(0, v));
  return { x: c((p.x - box.x) / box.w), y: c((p.y - box.y) / box.h) };
}

function nearFace(f, face, o = DEFAULTS) {
  if (!face) return false;
  const [x, y, w, h] = face;
  const m = w * o.faceMargin;
  const p = f.palmN;
  return p.x > x - m && p.x < x + w + m && p.y > y - m && p.y < y + h + m * 0.5; // (a chin on a hand sits inside the box)
}

// ---- The state machine ---------------------------------------------------------------------------------------------
class HandEngine {
  /** opts: thresholds (tune()); onTarget(pt) → is there something of ARES's under this display point (for near-face pinches) */
  constructor(opts = {}, { onTarget = () => true, battery = () => false } = {}) {
    this.o = tune(opts);
    this.onTarget = onTarget;
    this.battery = battery;
    this.reset('watching');
  }

  reset(state = 'off') {
    this.state = state;
    this.slots = {};          // per hand side: pose, pose history, dwell, swipe buffers
    this.primary = null;      // the side that's driving the cursor
    this.lastValidAt = 0;
    this.sizeEma = null;      // palm length, slowly smoothed: the box doesn't breathe with every frame
    this.boxCentre = null;    // where the palm engaged (uniform space)
    this.pinch = null;        // { phase: 'wait'|'down'|'drag', at, anchor, side }
    this.zoom = null;         // { d0, scale, mid, sides, lostAt }
    this.zoomBlock = false;   // after a zoom: no new pinch until both hands have let go
    this.cursor = null;
    this.lost = true;
    this.t = 0;
  }

  setOpts(over) { this.o = tune(over); }

  /** The camera settings this state wants. */
  camera() {
    if (this.state === 'engaged') return { fps: this.o.engagedFps, res: 'high' };
    if (this.state === 'watching') return { fps: this.battery() ? this.o.watchFpsBattery : this.o.watchFps, res: 'low' };
    return null;
  }

  /** One frame in, actions out. */
  feed(frame) {
    const out = [];
    if (this.state === 'off') return out;
    const now = frame.ts;
    const dt = this.t ? Math.max(1, now - this.t) : 33;
    this.t = now;
    const o = this.o;
    // Typing: nothing counts for a second after any key press (and a held pinch lets go)
    if (frame.key != null && frame.key * 1000 < o.keyQuietMs) {
      this.release(out, true);
      this.endZoom(out);
      for (const s of Object.values(this.slots)) { s.openSince = null; s.swipe = []; }
      this.expire(now, out);
      return out;
    }
    const aspect = frame.aspect || 4 / 3;
    const hands = [];
    for (const h of frame.hands || []) {
      const f = features(h, aspect);
      if (!f) continue;
      const slot = this.slot(h.side, f);
      const pose = classify(f, slot.pose === 'pinch', o);
      hands.push({ side: slot.key, f, pose, slot });
    }
    // Which hands count: not at the edges, not at the face (unless pinching on something), and while watching not
    // down low either (resting, typing); engaged, reaching down is deliberate
    this.face = frame.face || null; // (kept for the near-face rule)
    const valid = hands.filter((h) => {
      const p = h.f.palmN;
      if (p.x < o.edge || p.x > 1 - o.edge || p.y < o.edge || p.y > 1 - o.edge) return false;
      if (this.state !== 'engaged' && p.y > o.bottomIgnore) return false;
      if (!nearFace(h.f, frame.face, o)) return true;
      if (this.state !== 'engaged') return false;
      if (this.pinch && this.pinch.side === h.side && this.pinch.phase !== 'wait') return true;
      return h.pose === 'pinch' && this.onTarget(this.pointFor(h.f));
    });
    this.lastHands = hands.map((h) => ({ side: h.side, pose: h.pose, valid: valid.includes(h) })); // (for the preview)
    this.lastBox = hands[0] ? boxFor(this.sizeEma ?? hands[0].f.size, aspect, o, this.boxCentre) : null;
    for (const h of hands) { // pose history (also for hands that don't count: a pose must re-form after it)
      h.slot.prevPose = h.slot.pose;
      h.slot.pose = h.pose;
      h.slot.seenAt = now;
      h.slot.valid = valid.includes(h);
      if (h.pose !== 'open' || !h.slot.valid) { h.slot.openSince = null; if (h.slot.valid) h.slot.armed = true; }
    }
    if (valid.length) this.lastValidAt = now;

    if (this.state === 'watching') {
      for (const h of valid) {
        if (h.pose === 'open' && h.f.spread > 0.45 && this.dwell(h, now) >= o.engageMs) {
          this.state = 'engaged';
          this.primary = h.side;
          this.sizeEma = h.f.size;
          this.boxCentre = { x: h.f.palm.x, y: h.f.palm.y + h.f.size * 0.4 }; // a touch below the palm: hands drop as they relax
          h.slot.armed = false; // the palm that engaged has to drop before a palm counts again
          h.slot.openSince = null;
          out.push({ type: 'state', state: 'engaged' }, { type: 'camera', ...this.camera() });
          break;
        }
      }
      return out;
    }

    // ---- engaged
    if (!valid.length) { this.expire(now, out); return out; }
    this.lost = false;
    // Two hands pinching: zoom, locked in until both let go (it can't turn into a one-hand grab halfway)
    const pinching = valid.filter((h) => h.pose === 'pinch');
    if (this.zoom) { this.updateZoom(valid, now, dt, out); return out; }
    if (this.zoomBlock) { if (!pinching.length) this.zoomBlock = false; }
    if (pinching.length >= 2 && !this.zoomBlock && (!this.pinch || this.pinch.phase === 'wait')) {
      this.pinch = null;
      this.startZoom(pinching[0], pinching[1], out);
      return out;
    }
    let p = valid.find((h) => h.side === this.primary);
    if (!p) { p = valid.length === 1 ? valid[0] : valid.reduce((a, b) => (this.cursor && dist(this.pointFor(a.f), this.cursor) < dist(this.pointFor(b.f), this.cursor) ? a : b)); this.primary = p.side; }
    if (!this.pinch || this.pinch.phase === 'wait') this.sizeEma = this.sizeEma == null ? p.f.size : this.sizeEma + (p.f.size - this.sizeEma) * Math.min(1, dt / 800);
    const pt = this.pointFor(p.f);

    // Pinch: wait (for a second hand) → down → drag (once it has really moved) → up
    if (p.pose === 'pinch' && !this.zoomBlock) {
      if (!this.pinch) this.pinch = { phase: 'wait', at: now, anchor: pt, side: p.side };
      const k = this.pinch;
      const moved = Math.hypot(pt.x - k.anchor.x, pt.y - k.anchor.y) > o.dragDead;
      if (k.phase === 'wait' && (moved || now - k.at >= o.pinchWaitMs)) { k.phase = 'down'; out.push({ type: 'down', ...k.anchor }); }
      if (k.phase === 'down' && moved) k.phase = 'drag';
      if (k.phase === 'drag') out.push({ type: 'move', ...pt });
      this.cursor = k.phase === 'drag' ? pt : k.anchor; // the ring holds still until the pinch really moves
      out.push({ type: 'cursor', ...this.cursor, pose: 'pinch' });
    } else {
      if (this.pinch) this.release(out);
      this.cursor = pt;
      out.push({ type: 'cursor', ...pt, pose: p.pose });
    }
    if (p.pose === 'two') this.twoFinger(p, now, out); else { p.slot.swipe = []; p.slot.twoSince = null; }
    // Open palm, held still (and re-presented since the last one): summon, or a silent stop while she speaks
    if (p.pose === 'open' && p.slot.armed !== false && this.dwell(p, now) >= o.summonMs) {
      p.slot.armed = false;
      p.slot.openSince = null;
      out.push({ type: 'palm' });
    }
    return out;
  }

  /** How long this hand has held an open palm without wandering. */
  dwell(h, now) {
    const s = h.slot;
    if (!s.openSince || dist(h.f.palm, s.openAt) > this.o.stillTol * h.f.size) { s.openSince = now; s.openAt = h.f.palm; }
    return now - s.openSince;
  }

  slot(side, f) {
    let key = side;
    if (!side || side === '?') { // unknown chirality: the nearest known slot, else a new one
      const near = Object.entries(this.slots).filter(([, s]) => s.palm).sort((a, b) => dist(a[1].palm, f.palm) - dist(b[1].palm, f.palm))[0];
      key = near && dist(near[1].palm, f.palm) < f.size * 2 ? near[0] : `?${Object.keys(this.slots).length}`;
    }
    const s = this.slots[key] ||= { key, armed: true, swipe: [] };
    s.palm = f.palm;
    return s;
  }

  /** The cursor: the palm's centre (steady through a pinch), through the interaction box. */
  pointFor(f) {
    return toDisplay(f.palm, boxFor(this.sizeEma ?? f.size, f.aspect, this.o, this.boxCentre));
  }

  twoFinger(h, now, out) {
    const o = this.o, s = h.slot, f = h.f;
    if (!f.twoTip) return;
    s.twoSince ??= now;
    s.swipe.push({ t: now, x: f.twoTip.x, y: f.twoTip.y, size: f.size });
    while (s.swipe.length && now - s.swipe[0].t > 320) s.swipe.shift();
    const a = s.swipe[0], z = s.swipe[s.swipe.length - 1];
    const span = (z.t - a.t) / 1000;
    if (span < 0.08) return;
    const dx = (z.x - a.x) / f.size, dy = (z.y - a.y) / f.size;
    const d = Math.hypot(dx, dy), speed = d / span;
    if (s.cool && now < s.cool) return;
    if (s.cool) { // after a swipe: wait for the hand to settle (its return trip isn't another swipe)
      if (speed > o.scrollDead * 2) return;
      s.cool = null;
    }
    if (d > o.swipeDist && speed > o.swipeSpeed && Math.max(Math.abs(dx), Math.abs(dy)) > o.swipeAxis * Math.min(Math.abs(dx), Math.abs(dy))) {
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      out.push({ type: 'swipe', dir });
      s.cool = now + o.swipeCooldownMs;
      s.swipe = [];
      return;
    }
    // Slow vertical drift: scroll. From the last two samples (the swipe window is too long for a smooth scroll)
    if (now - s.twoSince < o.scrollHoldMs || s.swipe.length < 2) return;
    const b = s.swipe[s.swipe.length - 2];
    const st = Math.max(0.001, (z.t - b.t) / 1000);
    const vy = (z.y - b.y) / f.size / st, vx = (z.x - b.x) / f.size / st;
    if (Math.abs(vy) > o.scrollDead && Math.abs(vy) < o.scrollMax && Math.abs(vy) > 1.5 * Math.abs(vx) && speed < o.scrollMax) {
      const box = boxFor(this.sizeEma ?? f.size, f.aspect, o, this.boxCentre);
      out.push({ type: 'scroll', dy: -((z.y - b.y) / box.h) * o.scrollGain }); // hand up: further down the page (natural)
    }
  }

  startZoom(a, b, out) {
    const pa = this.pointFor(a.f), pb = this.pointFor(b.f);
    this.zoom = { d0: Math.max(0.05, dist(a.f.palm, b.f.palm)), raw: 1, scale: 1, sides: [a.side, b.side], lostAt: null };
    const m = mid(pa, pb);
    out.push({ type: 'zoom', phase: 'start', x: m.x, y: m.y, scale: 1, a: pa, b: pb });
  }

  updateZoom(valid, now, dt, out) {
    const z = this.zoom;
    const hs = z.sides.map((s) => valid.find((h) => h.side === s));
    const held = hs.filter((h) => h && h.pose === 'pinch');
    if (!held.length) return this.endZoom(out);
    if (hs[0] && hs[1]) {
      z.lostAt = null;
      if (held.length === 2) z.raw = dist(hs[0].f.palm, hs[1].f.palm) / z.d0;
      const k = 1 - Math.exp(-dt / this.o.zoomTau);
      z.scale += (z.raw - z.scale) * k;
      const pa = this.pointFor(hs[0].f), pb = this.pointFor(hs[1].f);
      const m = mid(pa, pb);
      this.cursor = m;
      out.push({ type: 'zoom', phase: 'update', x: m.x, y: m.y, scale: +z.scale.toFixed(4), a: pa, b: pb });
    } else if ((z.lostAt ??= now) && now - z.lostAt > this.o.zoomLock) this.endZoom(out);
  }

  endZoom(out) {
    if (!this.zoom) return;
    out.push({ type: 'zoom', phase: 'end', scale: +this.zoom.scale.toFixed(4) });
    this.zoom = null;
    this.zoomBlock = true;
  }

  /** The pinch let go: a click if it was quick and didn't move, else the end of a drag (a throw, if it was moving). */
  release(out, cancel = false) {
    const k = this.pinch;
    if (!k) return;
    this.pinch = null;
    if (k.phase === 'wait') { if (!cancel) out.push({ type: 'down', ...k.anchor }, { type: 'up', ...k.anchor, click: true }); return; }
    const at = k.phase === 'drag' ? this.cursor || k.anchor : k.anchor;
    out.push({ type: 'up', ...at, click: k.phase === 'down' && !cancel, cancel });
  }

  /** No usable hands this frame: after the grace period, back to watching. */
  expire(now, out) {
    if (this.state !== 'engaged') return;
    if (!this.lost) { this.lost = true; out.push({ type: 'cursor', lost: true }); }
    if (now - this.lastValidAt < this.o.graceMs) return;
    this.release(out, true);
    this.endZoom(out);
    this.zoomBlock = false;
    this.state = 'watching';
    this.primary = null;
    this.cursor = null;
    for (const s of Object.values(this.slots)) { s.armed = true; s.openSince = null; s.swipe = []; s.cool = null; }
    out.push({ type: 'state', state: 'watching' }, { type: 'camera', ...this.camera() });
  }

  /** Off (the camera is going off): anything held lets go. */
  stop() {
    const out = [];
    if (this.state === 'off') return out;
    this.release(out, true);
    this.endZoom(out);
    this.reset('off');
    out.push({ type: 'state', state: 'off' });
    return out;
  }
  start() { if (this.state === 'off') this.reset('watching'); return [{ type: 'state', state: 'watching' }, { type: 'camera', ...this.camera() }]; }
}

/** Replay a recorded/synthetic clip through a fresh engine: every action, in order (for tests and the harness). */
function replay(clip, opts = {}, { startEngaged = false, onTarget } = {}) {
  const e = new HandEngine({ ...(clip.tune || {}), ...opts }, { onTarget });
  const actions = [];
  if (startEngaged) { e.state = 'engaged'; e.lastValidAt = clip.frames[0]?.ts ?? 0; e.lost = true; }
  for (const fr of clip.frames) for (const a of e.feed({ aspect: clip.aspect, ...fr })) actions.push({ ...a, ts: fr.ts });
  return actions;
}

module.exports = { J, DEFAULTS, tune, features, classify, boxFor, toDisplay, nearFace, HandEngine, replay };
