// 3D neural HUD: a real anatomical brain (from an MRI-based model), rendered as a translucent
// hologram with neurons and travelling signals inside it. The 2D HUD (neural.js) keeps drawing the
// rings and readouts on top, and is the fallback if WebGL isn't available.
// Brain model: "Brain AS" by Agnieszka Starostecka, Wikimedia Commons, CC BY 4.0.
import * as THREE from '../node_modules/three/build/three.module.js';
import * as MESH from './brain-mesh.js';

const hud = HUD; // declared by neural.js (global lexical scope, not a window property)

function decode(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

// Where activity concentrates in each state (anatomical regions, in model space: x right, y up, z front)
const REGION = {
  temporal: (p) => Math.abs(p.x) > 0.42 && p.y < 0.15 && p.z > -0.35 && p.z < 0.45, // hearing
  speech: (p) => p.x < -0.05 && p.z > 0.3 && p.y < 0.35,                             // left frontal (Broca)
};
const BEHAVIOUR = {
  idle:      { fire: 2.5, spread: 0.22, region: null },
  listening: { fire: 4,   spread: 0.32, region: 'temporal' },
  thinking:  { fire: 26,  spread: 0.6,  region: null },
  speaking:  { fire: 7,   spread: 0.42, region: 'speech' },
};

function start() {
  const canvas = document.getElementById('brain');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const group = new THREE.Group();
  group.rotation.x = 0.22; // look slightly down onto the brain
  scene.add(group);

  // ---- Brain surface ---------------------------------------------------------------------------
  const q = decode(MESH.positions, Int16Array);
  const pos = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 3) { // scan coordinates (right, front, up) -> three.js (right, up, front)
    pos[i] = q[i] / 32767;
    pos[i + 1] = q[i + 2] / 32767;
    pos[i + 2] = q[i + 1] / 32767;
  }
  const idx = decode(MESH.indices, MESH.indexBits === 16 ? Uint16Array : Uint32Array);
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } // axis swap flips winding
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const ACTIVE = 24; // the brightest firing neurons light up the surface above them
  const active = Array.from({ length: ACTIVE }, () => new THREE.Vector4(0, 0, 0, 0));
  const shared = {
    uColor: { value: new THREE.Color(0.24, 0.9, 1) },
    uGlow: { value: 1 },
    uPulse: { value: 0 },
    uTime: { value: 0 },
    uActive: { value: active },
    uLight: { value: new THREE.Vector3(0.4, 0.8, 0.6).normalize() },
  };
  const surface = (side, opacity) => new THREE.ShaderMaterial({
    uniforms: { ...shared, uOpacity: { value: opacity } },
    vertexShader: `
      uniform float uPulse;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec3 p = position * (1.0 + uPulse * 0.025);
        vP = position;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uGlow; uniform float uPulse; uniform float uOpacity; uniform float uTime;
      uniform vec3 uLight; uniform vec4 uActive[${ACTIVE}];
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec3 n = normalize(vN);
        float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.4);        // glowing edges, see-through middle
        float fold = 0.3 + 0.7 * max(dot(n, normalize((viewMatrix * vec4(uLight, 0.0)).xyz)), 0.0); // shows the gyri
        float act = 0.0;
        for (int i = 0; i < ${ACTIVE}; i++) {
          float d = distance(vP, uActive[i].xyz);
          act += uActive[i].w * exp(-d * d * 45.0);
        }
        float scan = 0.05 * smoothstep(0.985, 1.0, sin(vP.y * 34.0 - uTime * 1.6)); // faint scanning shimmer
        act = 1.0 - exp(-act * 1.4); // soft cap so busy regions don't blow out to white
        float a = (0.07 * fold + 0.55 * rim + 0.6 * act + scan) * uGlow * (1.0 + uPulse * 1.1) * uOpacity;
        vec3 col = mix(uColor, vec3(1.0), clamp(act * 0.35 + rim * 0.15, 0.0, 0.5));
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side,
  });
  const back = new THREE.Mesh(geo, surface(THREE.BackSide, 0.35));
  const front = new THREE.Mesh(geo, surface(THREE.FrontSide, 1));
  back.renderOrder = 0;
  front.renderOrder = 2;
  group.add(back, front);

  // ---- Neurons inside the brain ------------------------------------------------------------------
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const triCount = idx.length / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const neurons = [];
  while (neurons.length < 700) {
    const t = Math.floor(rand() * triCount) * 3;
    a.fromArray(pos, idx[t] * 3); b.fromArray(pos, idx[t + 1] * 3); c.fromArray(pos, idx[t + 2] * 3);
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const p = a.clone().addScaledVector(b.clone().sub(a), u).addScaledVector(c.clone().sub(a), v);
    n.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    // Most just under the cortex (grey matter), some deeper inside
    if (rand() < 0.7) p.addScaledVector(n, -(0.025 + rand() * 0.09));
    else p.multiplyScalar(0.35 + rand() * 0.4);
    neurons.push({ p, glow: 0, edges: [] });
  }
  const edges = [];
  neurons.forEach((nr, i) => {
    const near = [];
    neurons.forEach((m, j) => { if (j !== i) { const d = nr.p.distanceTo(m.p); if (d < 0.2) near.push([j, d]); } });
    near.sort((x, y) => x[1] - y[1]);
    for (const [j, d] of near.slice(0, 3)) {
      if (neurons[j].edges.some((e) => edges[e].a === i || edges[e].b === i)) continue;
      const e = edges.push({ a: i, b: j, len: d }) - 1;
      nr.edges.push(e);
      neurons[j].edges.push(e);
    }
  });
  // The power source: a virtual neuron at the centre (around the thalamus) wired to nearby deep neurons,
  // so when it fires, signals shoot out from the core into the brain.
  const CORE_POS = new THREE.Vector3(0, 0.02, -0.04);
  const coreIdx = neurons.push({ p: CORE_POS.clone(), glow: 0, edges: [], core: true }) - 1;
  neurons.map((nr, i) => [i, nr.p.distanceTo(CORE_POS)]).filter(([i]) => i !== coreIdx)
    .sort((x, y) => x[1] - y[1]).slice(0, 16)
    .forEach(([j, d]) => {
      const e = edges.push({ a: coreIdx, b: j, len: d }) - 1;
      neurons[coreIdx].edges.push(e);
      neurons[j].edges.push(e);
    });

  const byRegion = { temporal: [], speech: [] };
  neurons.forEach((nr, i) => { for (const r in REGION) if (REGION[r](nr.p)) byRegion[r].push(i); });

  const glowMat = (sizeScale) => new THREE.ShaderMaterial({
    uniforms: { uColor: shared.uColor, uGlow: shared.uGlow, uScale: { value: 1 } },
    vertexShader: `
      attribute float glow; uniform float uScale; varying float vGlow;
      void main() {
        vGlow = glow;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = glow < 0.0 ? 0.0 : (${sizeScale.toFixed(1)} + glow * 9.0) * uScale / -mv.z; // < 0 = unused slot
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uGlow; varying float vGlow;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * (0.3 + min(vGlow, 1.0) * 0.8) * uGlow;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), clamp(vGlow * 0.6 + smoothstep(0.2, 0.0, d) * 0.5, 0.0, 1.0)), clamp(a, 0.0, 1.0));
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const nGeo = new THREE.BufferGeometry();
  nGeo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(neurons.flatMap((nr) => nr.p.toArray())), 3));
  const nGlow = new THREE.BufferAttribute(new Float32Array(neurons.length), 1);
  nGeo.setAttribute('glow', nGlow);
  const neuronMat = glowMat(2.2);
  const neuronPoints = new THREE.Points(nGeo, neuronMat);
  neuronPoints.renderOrder = 1;
  group.add(neuronPoints);

  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(edges.flatMap((e) => [...neurons[e.a].p.toArray(), ...neurons[e.b].p.toArray()])), 3));
  const synMat = new THREE.LineBasicMaterial({ color: shared.uColor.value, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending });
  const synapses = new THREE.LineSegments(sGeo, synMat);
  synapses.renderOrder = 1;
  group.add(synapses);

  // Signals in flight: a bright head plus a short trail
  const MAX = 420;
  const pulses = [];
  const pGeo = new THREE.BufferGeometry();
  const pPos = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3);
  const pGlow = new THREE.BufferAttribute(new Float32Array(MAX), 1);
  pGeo.setAttribute('position', pPos);
  pGeo.setAttribute('glow', pGlow);
  const pulseMat = glowMat(3.5);
  const pulsePoints = new THREE.Points(pGeo, pulseMat);
  pulsePoints.renderOrder = 3;
  const tGeo = new THREE.BufferGeometry();
  const tPos = new THREE.BufferAttribute(new Float32Array(MAX * 6), 3);
  tGeo.setAttribute('position', tPos);
  const trailMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const trails = new THREE.LineSegments(tGeo, trailMat);
  trails.renderOrder = 3;
  group.add(pulsePoints, trails);

  // ---- Power source ---------------------------------------------------------------------------------
  function glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }
  const coreTex = glowTexture();
  const coreMat = new THREE.SpriteMaterial({ map: coreTex, color: shared.uColor.value, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const coreHot = new THREE.SpriteMaterial({ map: coreTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const core = new THREE.Group();
  core.position.copy(CORE_POS);
  const halo = new THREE.Sprite(coreMat);
  const heart = new THREE.Sprite(coreHot);
  halo.renderOrder = heart.renderOrder = 1; // inside the brain: between the back and front surfaces
  core.add(halo, heart);
  // Style B: a small arc-reactor around the orb (thin rings turning on different axes)
  const ringMat = new THREE.MeshBasicMaterial({ color: shared.uColor.value, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const reactor = new THREE.Group();
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.003, 8, 128), ringMat);
  const ringB = new THREE.Group();
  for (let k = 0; k < 3; k++) { // segmented outer ring
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.0025, 6, 64, Math.PI * 0.45), ringMat);
    arc.rotation.z = (k * Math.PI * 2) / 3;
    ringB.add(arc);
  }
  ringB.rotation.x = Math.PI / 2.6;
  reactor.add(ringA, ringB);
  reactor.children.forEach((r) => { r.renderOrder = 1; });
  core.add(reactor);
  group.add(core);
  let coreStyle = 'orb';
  reactor.visible = false; // the arc-reactor rings style is available via setCoreStyle('reactor')
  window.setCoreStyle = (style) => { coreStyle = style; reactor.visible = style === 'reactor'; core.visible = style !== 'none'; };
  const CORE = { // heartbeat period (s) and brightness per state
    idle: { period: 3.0, base: 0.55, beat: 0.35, fire: 0.25 },
    listening: { period: 2.2, base: 0.65, beat: 0.3, fire: 0.6 },
    thinking: { period: 0.75, base: 0.68, beat: 0.3, fire: 1.8 },
    speaking: { period: 1.6, base: 0.7, beat: 0.25, fire: 1.2 },
  };
  let beatPhase = 0;
  let coreLevel = 0.6;

  // ---- Activity simulation -------------------------------------------------------------------------
  let state = 'idle';
  const fire = (i, strength) => {
    const nr = neurons[i];
    nr.glow = Math.min(1.6, nr.glow + strength);
    for (const e of nr.edges) {
      if (pulses.length >= MAX) break;
      if (rand() < 0.55 * strength) pulses.push({ e, from: i, t: 0, strength: strength * 0.9 });
    }
  };
  const pick = () => {
    const region = BEHAVIOUR[state].region;
    const pool = region && rand() < 0.65 ? byRegion[region] : null;
    return pool && pool.length ? pool[Math.floor(rand() * pool.length)] : Math.floor(rand() * neurons.length);
  };
  function simulate(dt, level) {
    const beh = BEHAVIOUR[state];
    const audio = state === 'listening' || state === 'speaking';
    let spont = (beh.fire * (audio ? 0.4 + level * 3 : 1) + Math.min(3, runningJobs) * 1.2) * dt; // a little busier while jobs run
    while (spont > 0) {
      if (rand() < Math.min(1, spont)) fire(pick(), audio ? 0.6 + level : 0.9);
      spont -= 1;
    }
    for (let k = pulses.length - 1; k >= 0; k--) {
      const s = pulses[k];
      const e = edges[s.e];
      s.t += (dt * 1.1) / Math.max(0.05, e.len);
      if (s.t < 1) continue;
      pulses.splice(k, 1);
      const to = s.from === e.a ? e.b : e.a;
      neurons[to].glow = Math.min(1.6, neurons[to].glow + s.strength * 0.7);
      for (const next of neurons[to].edges) {
        if (next === s.e || pulses.length >= MAX) continue;
        if (rand() < beh.spread * s.strength) pulses.push({ e: next, from: to, t: 0, strength: s.strength * 0.86 });
      }
    }
    const decay = Math.exp(-dt * 3.2);
    for (const nr of neurons) nr.glow *= decay;
  }

  // ---- Job orbs (work mode) -------------------------------------------------------------------------
  // Each background job is a small glowing orb on its own tilted orbit around the brain. The orbits live
  // in the scene, not the brain's group, so orbs pass in front of and behind it as they go round. No
  // strands to the brain: when a job finishes, the brain gives one faint pulse, and that's all.
  // Work (renderer/work.js) drives this through window.JobOrbs; clicks come back as an 'orb-open' event.
  const ORB_COLOR = { queued: 0xa78bfa, running: 0xa78bfa, approval: 0xffb547, done: 0x4ade80, failed: 0xf87171 };
  const ORB_SIZE = { small: 0.07, medium: 0.095, large: 0.125 };
  const ORB_SPEED = { queued: 0.6, running: 1, approval: 0.7, done: 0.28, failed: 0.22 };
  const ORB_TRAIL = 16;
  const R = geo.boundingSphere.radius;
  const orbs = new Map();
  const orbLayer = new THREE.Group();
  scene.add(orbLayer);
  let runningJobs = 0;
  let reduceMotion = false;
  const ease = { out: (k) => 1 - Math.pow(1 - k, 3), inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2), in: (k) => k * k * k };
  const idSeed = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 2147483646 + 1; };

  function makeOrb(job) {
    let s = idSeed(job.id); // the same orbit every launch
    const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    const glowMatO = new THREE.SpriteMaterial({ map: coreTex, color: ORB_COLOR[job.status] || 0xa78bfa, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    const hotMat = new THREE.SpriteMaterial({ map: coreTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    const glow = new THREE.Sprite(glowMatO);
    const hot = new THREE.Sprite(hotMat);
    const tGeo2 = new THREE.BufferGeometry();
    tGeo2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORB_TRAIL * 3), 3));
    tGeo2.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ORB_TRAIL * 3), 3));
    const trail = new THREE.Line(tGeo2, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.renderOrder = hot.renderOrder = trail.renderOrder = 5;
    orbLayer.add(trail, glow, hot);
    const orb = {
      id: job.id, job, glow, hot, trail,
      radius: R * (1.22 + r() * 0.26),
      tilt: new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 1.1, r() * Math.PI * 2, (r() - 0.5) * 0.5, 'YXZ')),
      theta: r() * Math.PI * 2,
      speed: (0.32 + r() * 0.16) * (r() < 0.5 ? 1 : -1),
      spd: 0,
      color: new THREE.Color(ORB_COLOR[job.status] || 0xa78bfa),
      pos: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(),
      mode: 'orbit', t: 0, dur: 1, done: null,
      alpha: 0, show: 1, flare: 0, shrink: 1,
    };
    orbitPoint(orb, orb.theta, orb.pos);
    orbs.set(job.id, orb);
    return orb;
  }
  function orbitPoint(orb, theta, out) {
    return out.set(Math.cos(theta) * orb.radius, 0, Math.sin(theta) * orb.radius).applyQuaternion(orb.tilt);
  }
  function dropOrb(orb) {
    orbLayer.remove(orb.trail, orb.glow, orb.hot);
    orb.glow.material.dispose(); orb.hot.material.dispose(); orb.trail.material.dispose(); orb.trail.geometry.dispose();
    orbs.delete(orb.id);
    orb.done?.();
  }
  function move(orb, mode, to, dur) {
    orb.done?.();
    orb.mode = mode; orb.t = 0; orb.dur = dur;
    orb.from.copy(orb.pos);
    if (to) orb.to.copy(to);
    return new Promise((res) => { orb.done = () => { orb.done = null; res(); }; });
  }
  /** Where an orb opening towards the viewer ends up: most of the way to the camera, drawn in a little. */
  function flyTarget(orb, out) {
    out.copy(orb.pos).lerp(camera.position, 0.58);
    out.x *= 0.85; out.y *= 0.85;
    return out;
  }

  // Sparks: a quick burst in the neurons' colour when an orb opens
  const sparks = Array.from({ length: 48 }, () => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: coreTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    sp.renderOrder = 6; sp.visible = false;
    orbLayer.add(sp);
    return { sp, v: new THREE.Vector3(), age: 1, life: 1 };
  });
  function burst(at, n, color, power = 1) {
    let k = 0;
    for (const s of sparks) {
      if (k >= n) break;
      if (s.age < s.life) continue;
      k++;
      s.sp.position.copy(at);
      s.v.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar((0.7 + rand() * 1.5) * power);
      s.age = 0; s.life = 0.45 + rand() * 0.35;
      s.sp.material.color.copy(color).lerp(new THREE.Color(0xffffff), rand() * 0.4);
      s.sp.visible = true;
    }
  }

  const toScreen = new THREE.Vector3();
  const viewPos = new THREE.Vector3();
  function screenOf(orb) {
    const r = canvas.getBoundingClientRect();
    toScreen.copy(orb.pos).project(camera);
    const dist = camera.position.distanceTo(orb.pos);
    const px = (h / 2) / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist); // pixels per world unit there
    return { x: r.left + (toScreen.x + 1) / 2 * w, y: r.top + (1 - toScreen.y) / 2 * h, r: (ORB_SIZE[orb.job.size] || ORB_SIZE.medium) * orb.shrink * px };
  }

  function updateOrbs(dt, t) {
    const coreWorld = core.getWorldPosition(new THREE.Vector3());
    const cz = new THREE.Vector3().copy(coreWorld).applyMatrix4(camera.matrixWorldInverse).z;
    const home = new THREE.Vector3();
    for (const orb of [...orbs.values()]) {
      const st = orb.job.status;
      orb.spd += ((ORB_SPEED[st] ?? 0.5) - orb.spd) * Math.min(1, dt * 1.2); // done orbs ease down to a slow drift
      orb.theta += dt * orb.speed * orb.spd;
      orbitPoint(orb, orb.theta, home);
      orb.color.lerp(new THREE.Color(ORB_COLOR[st] || 0xa78bfa), Math.min(1, dt * 3));
      if (orb.mode !== 'orbit') {
        orb.t = Math.min(1, orb.t + dt / orb.dur);
        const k = orb.t;
        if (orb.mode === 'flying') orb.pos.copy(orb.from).lerp(orb.to, ease.out(k));
        else if (orb.mode === 'returning') orb.pos.copy(orb.from).lerp(home, ease.inOut(k));
        else if (orb.mode === 'sinking') { orb.pos.copy(orb.from).lerp(coreWorld, ease.in(k)); orb.shrink = 1 - k * 0.85; orb.show = 1 - ease.in(k); }
        else if (orb.mode === 'parked') orb.pos.copy(orb.to);
        if (k >= 1 && orb.mode !== 'parked') {
          if (orb.mode === 'flying') { orb.mode = 'parked'; orb.done?.(); }
          else if (orb.mode === 'returning') { orb.mode = 'orbit'; orb.done?.(); }
          else if (orb.mode === 'sinking') { // into the brain, and a faint answering pulse
            for (let i = 0; i < 4; i++) fire(pick(), 0.7);
            fire(coreIdx, 0.8);
            dropOrb(orb);
            continue;
          } else if (orb.mode === 'fading') { dropOrb(orb); continue; }
        }
        if (orb.mode === 'fading') orb.show = 1 - k;
      }
      if (orb.mode === 'orbit') orb.pos.copy(home);

      // Brightness by status: violet breathes, amber blinks, green idles, red dims
      const beat = st === 'running' ? 0.72 + 0.28 * Math.sin(t / 1000 * Math.PI * 2 / 1.8)
        : st === 'approval' ? 0.3 + 0.7 * THREE.MathUtils.smoothstep(Math.sin(t / 1000 * Math.PI * 2 / 0.9), -0.25, 0.25)
        : st === 'done' ? 0.82 + 0.12 * Math.sin(t / 1000 * Math.PI * 2 / 3.4)
        : st === 'queued' ? 0.45 : 0.5;
      const wantAlpha = orb.mode === 'parked' && orb.t >= 1 ? 0 : 1; // hidden behind the panel once it's open
      orb.alpha += (wantAlpha - orb.alpha) * Math.min(1, dt * (wantAlpha ? 2.5 : 6));
      orb.flare *= Math.exp(-dt * 4);
      // Dim it while it's behind the brain
      viewPos.copy(orb.pos).applyMatrix4(camera.matrixWorldInverse);
      let occl = 1;
      if (viewPos.z < cz) {
        const across = Math.hypot(viewPos.x, viewPos.y) / -viewPos.z * -cz; // distance from the brain's centre, at its depth
        occl = 0.35 + 0.65 * THREE.MathUtils.smoothstep(across, R * 0.62, R * 1.02);
      }
      const size = (ORB_SIZE[orb.job.size] || ORB_SIZE.medium) * (1 + Math.min(0.25, Math.log10(1 + (orb.job.steps || 0)) * 0.1)) * orb.shrink;
      const a = orb.alpha * orb.show * occl;
      orb.glow.position.copy(orb.pos); orb.hot.position.copy(orb.pos);
      orb.glow.scale.setScalar(size * 3.4 * (1 + orb.flare * 1.4) * (0.9 + beat * 0.2));
      orb.hot.scale.setScalar(size * (0.9 + orb.flare * 0.8));
      orb.glow.material.color.copy(orb.color);
      orb.glow.material.opacity = Math.min(1, a * (0.35 + 0.6 * beat + orb.flare));
      orb.hot.material.opacity = Math.min(1, a * (0.55 + 0.45 * beat + orb.flare));
      orb.hot.material.color.copy(orb.color).lerp(new THREE.Color(0xffffff), 0.75);

      // A short comet tail along its own orbit (only while it's orbiting)
      const tp = orb.trail.geometry.attributes.position, tc = orb.trail.geometry.attributes.color;
      const tailOn = orb.mode === 'orbit' ? a : 0;
      for (let k = 0; k < ORB_TRAIL; k++) {
        orbitPoint(orb, orb.theta - Math.sign(orb.speed) * k * 0.022, home);
        tp.setXYZ(k, home.x, home.y, home.z);
        const f = Math.pow(1 - k / ORB_TRAIL, 2) * tailOn * 0.4 * (0.5 + beat * 0.5);
        tc.setXYZ(k, orb.color.r * f, orb.color.g * f, orb.color.b * f);
      }
      tp.needsUpdate = tc.needsUpdate = true;
    }
    for (const s of sparks) {
      if (s.age >= s.life) continue;
      s.age += dt;
      s.sp.position.addScaledVector(s.v, dt);
      s.v.multiplyScalar(Math.exp(-dt * 3.5));
      const f = Math.max(0, 1 - s.age / s.life);
      s.sp.material.opacity = f * f;
      s.sp.scale.setScalar(0.05 * (0.5 + f));
      if (s.age >= s.life) s.sp.visible = false;
    }
  }

  const FINISHED = ['done', 'failed'];
  const SHOW_DAYS = 3;
  window.JobOrbs = {
    /** Which jobs have orbs: anything in progress, plus finished ones not yet put away (the newest few). */
    sync(jobs) {
      const now = Date.now();
      const active = jobs.filter((j) => ['queued', 'running', 'approval'].includes(j.status));
      const finished = jobs.filter((j) => FINISHED.includes(j.status) && !j.dismissed && !(j.seen && now - (j.finished || j.created) > SHOW_DAYS * 864e5))
        .sort((x, y) => (y.finished || 0) - (x.finished || 0)).slice(0, Math.max(2, 10 - active.length));
      const want = new Map([...active, ...finished].map((j) => [j.id, j]));
      runningJobs = jobs.filter((j) => j.status === 'running').length;
      for (const [id, orb] of orbs) {
        if (want.has(id) || orb.mode === 'sinking' || orb.mode === 'fading') continue;
        const j = jobs.find((x) => x.id === id);
        if (j?.dismissed && !reduceMotion) { orb.alpha = 1; move(orb, 'sinking', null, 1.3); }
        else move(orb, 'fading', null, 0.5);
      }
      for (const j of want.values()) {
        const orb = orbs.get(j.id) || makeOrb(j);
        if (orb.mode === 'sinking' || orb.mode === 'fading') { orb.mode = 'orbit'; orb.show = 1; orb.shrink = 1; }
        const was = orb.job.status;
        if (was !== j.status && FINISHED.includes(j.status) && !FINISHED.includes(was)) { // it just finished
          orb.flare = 1;
          for (let i = 0; i < 5; i++) fire(pick(), 0.6);
        }
        if (was !== 'approval' && j.status === 'approval') orb.flare = 0.7;
        orb.job = j;
      }
    },
    has: (id) => orbs.has(id) && !['sinking', 'fading'].includes(orbs.get(id).mode),
    screenPos(id) { const o = orbs.get(id); return o && w ? screenOf(o) : null; },
    /** Opening: the orb leaves its orbit, flies towards the viewer and flares. Resolves with where the panel should grow from. */
    async launch(id) {
      const orb = orbs.get(id);
      if (!orb || !w || orb.mode === 'sinking' || orb.mode === 'fading') return null;
      if (orb.mode === 'parked') return screenOf(orb);
      if (reduceMotion) { orb.mode = 'parked'; orb.t = 1; flyTarget(orb, orb.to); return null; }
      await move(orb, 'flying', flyTarget(orb, new THREE.Vector3()), 0.32);
      orb.flare = 1;
      burst(orb.pos, 26, shared.uColor.value, 1);
      return screenOf(orb);
    },
    /** The panel switched to this job while open: park it quietly (and send any other parked orb home). */
    park(id) {
      for (const o of orbs.values()) if (o.id !== id && (o.mode === 'parked' || o.mode === 'flying')) move(o, 'returning', null, reduceMotion ? 0.01 : 0.9);
      const orb = orbs.get(id);
      if (orb && orb.mode !== 'parked') { orb.mode = 'parked'; orb.t = 1; orb.alpha = 0; orb.done = null; flyTarget(orb, orb.to); orb.pos.copy(orb.to); }
    },
    /** Closing: the panel folded back into the orb; now it drifts home to its orbit. */
    land(id) {
      for (const o of orbs.values()) {
        if (o.mode !== 'parked' && o.mode !== 'flying') continue;
        if (o.id === id) { o.alpha = 1; o.flare = reduceMotion ? 0 : 0.8; }
        move(o, 'returning', null, reduceMotion ? 0.01 : 0.9);
      }
    },
    /** The orb under a point on screen, if any (for clicks and hover). */
    pick(x, y, slop = 16) {
      let best = null, bestD = Infinity;
      for (const orb of orbs.values()) {
        if (!['orbit', 'returning'].includes(orb.mode) || orb.alpha < 0.3) continue;
        const s = screenOf(orb);
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < Math.max(slop, s.r * 2) && d < bestD) { best = orb; bestD = d; }
      }
      return best?.job || null;
    },
    set reduceMotion(on) { reduceMotion = Boolean(on); },
  };

  // Hover shows the job's name; a click opens it
  const stage = canvas.parentElement;
  const tip = document.createElement('div');
  tip.className = 'orb-tip';
  tip.hidden = true;
  stage.appendChild(tip);
  const ORB_STATUS = { queued: 'queued', running: 'working', approval: 'needs your OK', done: 'done', failed: 'failed' };
  stage.addEventListener('mousemove', (e) => {
    const j = window.JobOrbs.pick(e.clientX, e.clientY);
    stage.style.cursor = j ? 'pointer' : '';
    tip.hidden = !j;
    if (!j) return;
    const r = stage.getBoundingClientRect();
    tip.textContent = `${j.title} · ${ORB_STATUS[j.status] || j.status}`;
    tip.className = `orb-tip ${j.status}`;
    tip.style.left = `${e.clientX - r.left}px`;
    tip.style.top = `${e.clientY - r.top}px`;
  });
  stage.addEventListener('mouseleave', () => { tip.hidden = true; stage.style.cursor = ''; });
  stage.addEventListener('click', (e) => {
    const j = window.JobOrbs.pick(e.clientX, e.clientY, e.pointerType === 'touch' ? 30 : 16); // a fingertip is less precise
    if (!j) return;
    tip.hidden = true;
    window.dispatchEvent(new CustomEvent('orb-open', { detail: j.id }));
  });

  // ---- Frame --------------------------------------------------------------------------------------------
  let w = 0, h = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    w = r.width; h = r.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Fit the brain inside the HUD rings (ring radius = 44% of the smaller side, as in neural.js)
    const ring = Math.min(w, h) * 0.44;
    const brainPx = ring * 0.78;
    const radius = geo.boundingSphere.radius * 0.95;
    camera.position.set(0, 0, (h / 2) * radius / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * brainPx));
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(w, h, 0, 8, w, h); // the 2D rings sit 8px above centre
    camera.updateProjectionMatrix();
    const scale = h * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    neuronMat.uniforms.uScale.value = scale * 0.01;
    pulseMat.uniforms.uScale.value = scale * 0.01;
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const target = new THREE.Color();
  let last = 0;
  let bootStart = null;
  const gate = Perf.gate(); // declared by perf.js
  function frame(t) {
    requestAnimationFrame(frame);
    if (!gate(t)) return;
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    if (!w) return;
    const live = hud.live();
    if (live.state !== state && live.state === 'thinking') for (let i = 0; i < 6; i++) fire(pick(), 1); // spark of thought
    state = live.state;
    simulate(dt, live.level);

    bootStart ??= t;
    const boot = Math.min(1, (t - bootStart) / 1600);
    group.scale.setScalar(1 - Math.pow(1 - boot, 3));
    group.rotation.y += dt * 0.16 * live.color.spin;

    target.setRGB(live.color.r / 255, live.color.g / 255, live.color.b / 255);
    shared.uColor.value.copy(target);
    synMat.color.copy(target);
    const breathe = 0.9 + 0.1 * Math.sin(t / 1300);
    shared.uGlow.value = live.color.glow * breathe;
    shared.uTime.value = t / 1000;
    // Whole-brain pulse with her voice
    shared.uPulse.value = state === 'speaking' ? live.level : state === 'listening' ? live.level * 0.35 : 0;
    synMat.opacity = 0.07 + 0.05 * live.color.glow;

    // Power source: heartbeat, voice, and firing signals out into the brain
    const cs = CORE[state];
    beatPhase += dt / cs.period;
    const beat = Math.pow(Math.max(0, Math.sin(beatPhase * Math.PI * 2)), 6);
    const voice = state === 'speaking' || state === 'listening' ? live.level : 0;
    coreLevel += ((cs.base + cs.beat * beat + voice * 0.6) - coreLevel) * Math.min(1, dt * 10);
    if (rand() < cs.fire * dt) fire(coreIdx, 0.7);
    const size = 1.3 * coreLevel;
    halo.scale.setScalar(size * 1.4);  // soft outer glow
    heart.scale.setScalar(size * 0.5); // hot, bright centre
    coreMat.opacity = Math.min(0.75, 0.7 * coreLevel);
    coreHot.opacity = Math.min(1, 0.75 + 0.25 * coreLevel);
    ringMat.color.copy(target);
    ringMat.opacity = 0.35 + 0.4 * coreLevel;
    const spinRate = (state === 'thinking' ? 2.4 : 0.6) * live.color.spin;
    ringA.rotation.x += dt * spinRate * 0.8;
    ringA.rotation.y += dt * spinRate * 0.5;
    ringB.rotation.z -= dt * spinRate;
    reactor.quaternion.copy(camera.quaternion).premultiply(group.quaternion.clone().invert()); // face the viewer
    reactor.scale.setScalar(0.85 + coreLevel * 0.3);
    neurons[coreIdx].glow = 0; // the orb is drawn by the sprites, not as a neuron dot

    // Neuron glow, and the brightest firings lighting up the surface
    const ranked = [];
    for (let i = 0; i < neurons.length; i++) {
      nGlow.array[i] = neurons[i].glow;
      if (neurons[i].glow > 0.15) ranked.push(i);
    }
    nGlow.needsUpdate = true;
    ranked.sort((x, y) => neurons[y].glow - neurons[x].glow);
    for (let k = 0; k < ACTIVE; k++) {
      const i = ranked[k];
      if (i === undefined) active[k].set(0, 0, 0, 0);
      else active[k].set(neurons[i].p.x, neurons[i].p.y, neurons[i].p.z, neurons[i].glow * 0.5);
    }

    // Signals
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    for (let k = 0; k < MAX; k++) {
      const s = pulses[k];
      if (!s) { pGlow.array[k] = -1; pPos.setXYZ(k, 0, 0, 0); tPos.setXYZ(k * 2, 0, 0, 0); tPos.setXYZ(k * 2 + 1, 0, 0, 0); continue; }
      const e = edges[s.e];
      A.copy(neurons[s.from].p);
      B.copy(neurons[s.from === e.a ? e.b : e.a].p);
      const head = A.clone().lerp(B, s.t);
      const tail = A.clone().lerp(B, Math.max(0, s.t - 0.35));
      pPos.setXYZ(k, head.x, head.y, head.z);
      pGlow.array[k] = 0.4 + s.strength * 0.8;
      tPos.setXYZ(k * 2, tail.x, tail.y, tail.z);
      tPos.setXYZ(k * 2 + 1, head.x, head.y, head.z);
    }
    pPos.needsUpdate = pGlow.needsUpdate = tPos.needsUpdate = true;
    trailMat.opacity = 0.35 + 0.25 * live.color.glow;

    updateOrbs(dt, t);
    hud.stats({ pulses: pulses.length, neurons: neurons.length });
    renderer.render(scene, camera);
  }
  hud.enable3D();
  requestAnimationFrame(frame);
  window.dispatchEvent(new Event('orbs-ready'));
}

try {
  start();
} catch (err) {
  console.error('3D brain unavailable; using the 2D one', err);
}
