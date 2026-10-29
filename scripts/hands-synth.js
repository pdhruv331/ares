// Synthetic hand clips for hands.js, in the exact shape ares-vision sends (21 joints, normalised, mirrored). Used by
// scripts/test-hands.js until (and alongside) real recordings in ~/Library/Application Support/ARES/hands/clips.
// A hand is built from a pose and a palm position; the geometry is a flat schematic of a hand facing the camera.
const { J } = require('../src/hands');

const ASPECT = 4 / 3;
// Finger layout relative to the wrist, in palm lengths (wrist→middle knuckle = 1)
const FINGERS = {
  index: { mcp: [-0.32, -0.95], dir: [-0.12, -1], segs: [0.42, 0.26, 0.2] },
  middle: { mcp: [0, -1], dir: [0, -1], segs: [0.46, 0.3, 0.22] },
  ring: { mcp: [0.3, -0.95], dir: [0.1, -1], segs: [0.42, 0.27, 0.2] },
  little: { mcp: [0.58, -0.82], dir: [0.26, -1], segs: [0.32, 0.22, 0.18] },
};
const IDX = { index: [J.INDEX_MCP, J.INDEX_PIP, J.INDEX_PIP + 1, J.INDEX_TIP], middle: [J.MIDDLE_MCP, J.MIDDLE_PIP, J.MIDDLE_PIP + 1, J.MIDDLE_TIP],
  ring: [J.RING_MCP, J.RING_PIP, J.RING_PIP + 1, J.RING_TIP], little: [J.LITTLE_MCP, J.LITTLE_PIP, J.LITTLE_PIP + 1, J.LITTLE_TIP] };

/**
 * One hand. pose: open | pinch | two | fist | thumbs | rest (fingers half-curled, side-on-ish) | peace (= two)
 * palm: {x, y} normalised frame coords of the palm centre; size: palm length as a fraction of frame height.
 */
function hand(pose, palm, size = 0.16, { side = 'right', noise = 0, curl = {} } = {}) {
  const j = new Array(21).fill(null);
  const n = () => (noise ? (Math.random() - 0.5) * noise : 0);
  // palm centre ≈ wrist + 0.55 up; wrist is below the centre
  const wx = palm.x * ASPECT, wy = palm.y + 0.5 * size;
  const put = (i, x, y, c = 0.95) => { j[i] = [(wx + x * size + n()) / ASPECT, wy + y * size + n(), c]; };
  put(J.WRIST, 0, 0);
  const curlOf = (name) => {
    if (curl[name] != null) return curl[name];
    if (pose === 'open') return 0;
    if (pose === 'fist' || pose === 'thumbs') return 1;
    if (pose === 'two' || pose === 'peace') return name === 'index' || name === 'middle' ? 0 : 1;
    if (pose === 'pinch') return name === 'index' ? 0.35 : 0.8;
    if (pose === 'rest') return 0.55;
    return 0.5;
  };
  for (const [name, f] of Object.entries(FINGERS)) {
    const c = curlOf(name);
    let x = f.mcp[0], y = f.mcp[1];
    put(IDX[name][0], x, y);
    // each segment bends further back toward the palm as curl grows
    let dir = Math.atan2(f.dir[1], f.dir[0]);
    for (let k = 0; k < 3; k++) {
      dir += c * 1.25; // radians per joint of curl
      x += Math.cos(dir) * f.segs[k]; y += Math.sin(dir) * f.segs[k];
      put(IDX[name][k + 1], x, y);
    }
  }
  // thumb: out to the index side (negative x), or up for thumbs up, or pinching the index tip
  if (pose === 'thumbs') {
    put(J.THUMB_MP - 1, -0.45, -0.3); put(J.THUMB_MP, -0.6, -0.75); put(J.THUMB_IP, -0.62, -1.15); put(J.THUMB_TIP, -0.6, -1.55);
  } else if (pose === 'pinch') {
    const tip = j[J.INDEX_TIP];
    const tx = (tip[0] * ASPECT - wx) / size, ty = (tip[1] - wy) / size;
    put(J.THUMB_MP - 1, -0.45, -0.3); put(J.THUMB_MP, -0.7, -0.6); put(J.THUMB_IP, (tx - 0.7) / 2 - 0.1, (ty - 0.6) / 2); put(J.THUMB_TIP, tx + 0.04, ty + 0.02);
  } else if (pose === 'fist' || pose === 'rest') {
    put(J.THUMB_MP - 1, -0.4, -0.3); put(J.THUMB_MP, -0.6, -0.55); put(J.THUMB_IP, -0.5, -0.8); put(J.THUMB_TIP, -0.3, -0.95);
  } else {
    put(J.THUMB_MP - 1, -0.45, -0.3); put(J.THUMB_MP, -0.85, -0.6); put(J.THUMB_IP, -1.15, -0.8); put(J.THUMB_TIP, -1.4, -0.95);
  }
  return { side, c: 0.95, j };
}

/** A clip builder: push frames at a given fps with an easing path between keyframes. */
class Clip {
  constructor({ fps = 30, aspect = ASPECT, tune } = {}) { this.fps = fps; this.aspect = aspect; this.frames = []; this.t = 0; this.tune = tune; this.face = [0.42, 0.06, 0.16, 0.2]; }
  /** hold(ms, hands) — hands: array of hand specs {pose, palm, size, side} or a function (progress 0…1) → specs */
  hold(ms, hands, extra = {}) {
    const n = Math.max(1, Math.round((ms / 1000) * this.fps));
    for (let i = 0; i < n; i++) {
      const p = n > 1 ? i / (n - 1) : 1;
      const specs = typeof hands === 'function' ? hands(p) : hands;
      this.frames.push({ ts: Math.round(this.t), face: this.face, key: extra.key ?? null, hands: specs.map((s) => hand(s.pose, s.palm, s.size, s)) });
      this.t += 1000 / this.fps;
    }
    return this;
  }
  /** move(ms, from, to, pose) with ease-in-out */
  move(ms, from, to, pose, opts = {}) {
    const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
    return this.hold(ms, (p) => { const e = opts.linear ? p : ease(p); return [{ pose, palm: { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }, size: opts.size, side: opts.side, curl: opts.curl }]; }, opts);
  }
  empty(ms) { return this.hold(ms, []); }
  build() { return { aspect: this.aspect, fps: this.fps, tune: this.tune, frames: this.frames }; }
}

/** Engage: open palm held still at chest height. Reused as a prefix by the other positive clips. */
function engaged(c = new Clip()) { return c.hold(500, [{ pose: 'open', palm: { x: 0.5, y: 0.45 } }]).hold(400, [{ pose: 'fist', palm: { x: 0.5, y: 0.45 } }]); }

const C = { x: 0.5, y: 0.42 }; // box centre
const CLIPS = {
  // ---- positives
  engage: () => new Clip().hold(500, [{ pose: 'open', palm: C }]).build(),
  palmStop: () => engaged().hold(300, [{ pose: 'open', palm: C }]).hold(700, [{ pose: 'open', palm: C }]).build(),
  quickPinch: () => engaged().hold(300, [{ pose: 'other', palm: { x: 0.35, y: 0.4 } }]).hold(180, [{ pose: 'pinch', palm: { x: 0.35, y: 0.4 } }]).hold(300, [{ pose: 'other', palm: { x: 0.35, y: 0.4 } }]).build(),
  grabThrow: () => engaged().hold(300, [{ pose: 'other', palm: { x: 0.35, y: 0.4 } }]).hold(250, [{ pose: 'pinch', palm: { x: 0.35, y: 0.4 } }])
    .move(380, { x: 0.35, y: 0.4 }, { x: 0.52, y: 0.42 }, 'pinch').hold(200, [{ pose: 'other', palm: { x: 0.54, y: 0.42 } }]).build(),
  dragSlow: () => engaged().hold(250, [{ pose: 'pinch', palm: { x: 0.35, y: 0.4 } }]).move(1200, { x: 0.35, y: 0.4 }, { x: 0.62, y: 0.5 }, 'pinch').hold(200, [{ pose: 'other', palm: { x: 0.62, y: 0.5 } }]).build(),
  swipeLeft: () => engaged().hold(250, [{ pose: 'two', palm: { x: 0.6, y: 0.42 } }]).move(220, { x: 0.6, y: 0.42 }, { x: 0.36, y: 0.42 }, 'two').hold(400, [{ pose: 'two', palm: { x: 0.36, y: 0.42 } }]).build(),
  swipeRight: () => engaged().hold(250, [{ pose: 'two', palm: { x: 0.4, y: 0.42 } }]).move(220, { x: 0.4, y: 0.42 }, { x: 0.64, y: 0.42 }, 'two').hold(400, [{ pose: 'two', palm: { x: 0.64, y: 0.42 } }]).build(),
  swipeUp: () => engaged().hold(250, [{ pose: 'two', palm: { x: 0.5, y: 0.62 } }]).move(220, { x: 0.5, y: 0.62 }, { x: 0.5, y: 0.4 }, 'two').hold(400, [{ pose: 'two', palm: { x: 0.5, y: 0.4 } }]).build(),
  swipeDown: () => engaged().hold(250, [{ pose: 'two', palm: { x: 0.5, y: 0.4 } }]).move(220, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.62 }, 'two').hold(400, [{ pose: 'two', palm: { x: 0.5, y: 0.62 } }]).build(),
  scroll: () => engaged().hold(300, [{ pose: 'two', palm: { x: 0.5, y: 0.6 } }]).move(1500, { x: 0.5, y: 0.6 }, { x: 0.5, y: 0.4 }, 'two', { linear: true }).build(),
  zoomIn: () => engaged().hold(200, [{ pose: 'other', palm: { x: 0.42, y: 0.42 } }, { pose: 'other', palm: { x: 0.58, y: 0.42 }, side: 'left' }])
    .hold(120, [{ pose: 'pinch', palm: { x: 0.42, y: 0.42 } }, { pose: 'pinch', palm: { x: 0.58, y: 0.42 }, side: 'left' }])
    .hold(600, (p) => [{ pose: 'pinch', palm: { x: 0.42 - 0.14 * p, y: 0.42 } }, { pose: 'pinch', palm: { x: 0.58 + 0.14 * p, y: 0.42 }, side: 'left' }])
    .hold(200, [{ pose: 'other', palm: { x: 0.28, y: 0.42 } }, { pose: 'other', palm: { x: 0.72, y: 0.42 }, side: 'left' }]).build(),
  zoomOut: () => engaged().hold(120, [{ pose: 'pinch', palm: { x: 0.28, y: 0.42 } }, { pose: 'pinch', palm: { x: 0.72, y: 0.42 }, side: 'left' }])
    .hold(600, (p) => [{ pose: 'pinch', palm: { x: 0.28 + 0.14 * p, y: 0.42 } }, { pose: 'pinch', palm: { x: 0.72 - 0.14 * p, y: 0.42 }, side: 'left' }])
    .hold(200, [{ pose: 'other', palm: { x: 0.42, y: 0.42 } }, { pose: 'other', palm: { x: 0.58, y: 0.42 }, side: 'left' }]).build(),
  // ---- negatives (nothing may fire, not even engage)
  typing: () => new Clip().hold(3000, (p) => [{ pose: 'rest', palm: { x: 0.35 + 0.02 * Math.sin(p * 40), y: 0.9 } }, { pose: 'rest', palm: { x: 0.65, y: 0.91 + 0.01 * Math.cos(p * 37) }, side: 'left' }], { key: 0.2 }).build(),
  typingOpenLow: () => new Clip().hold(2000, [{ pose: 'open', palm: { x: 0.4, y: 0.86 } }], { key: 0.3 }).build(),
  restingHands: () => new Clip().hold(4000, [{ pose: 'rest', palm: { x: 0.38, y: 0.88 } }, { pose: 'rest', palm: { x: 0.62, y: 0.87 }, side: 'left' }]).build(),
  scratchFace: () => new Clip().hold(2500, (p) => [{ pose: 'other', palm: { x: 0.5, y: 0.2 + 0.02 * Math.sin(p * 30) } }]).build(),
  chinOnHand: () => new Clip().hold(4000, [{ pose: 'fist', palm: { x: 0.5, y: 0.3 } }]).build(),
  waveAtSomeone: () => new Clip().hold(2500, (p) => [{ pose: 'open', palm: { x: 0.75 + 0.08 * Math.sin(p * 25), y: 0.3 } }]).build(),
  heldPeaceSign: () => new Clip().hold(3000, [{ pose: 'two', palm: C }]).build(),
  stretching: () => new Clip().move(800, { x: 0.5, y: 0.6 }, { x: 0.5, y: 0.03 }, 'fist').hold(1500, [{ pose: 'fist', palm: { x: 0.45, y: 0.03 } }, { pose: 'fist', palm: { x: 0.55, y: 0.03 }, side: 'left' }]).move(800, { x: 0.5, y: 0.03 }, { x: 0.5, y: 0.6 }, 'fist').build(),
  // engaged, then nothing should fire
  engagedThenPeace: () => engaged().hold(3000, [{ pose: 'two', palm: C }]).build(),
  engagedThenTyping: () => engaged().hold(2500, (p) => [{ pose: 'pinch', palm: { x: 0.4 + 0.1 * Math.sin(p * 20), y: 0.5 } }], { key: 0.1 }).build(),
  engagedScratch: () => engaged().hold(2000, [{ pose: 'pinch', palm: { x: 0.5, y: 0.22 } }]).build(),
};

module.exports = { hand, Clip, CLIPS, engaged, ASPECT };
