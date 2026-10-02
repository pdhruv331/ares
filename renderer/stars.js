// Background starfield (C1): three depths of slowly drifting, twinkling stars behind the brain.
// Reacts to ARES's state (a touch faster and brighter while she listens, thinks or speaks) and stops
// drawing while the window is hidden.
(() => {
  const canvas = document.getElementById('stars');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const LAYERS = [
    { depth: 0.25, size: 0.6, alpha: 0.35, count: 0.00018 }, // far: many, faint, slow
    { depth: 0.55, size: 0.9, alpha: 0.55, count: 0.00008 },
    { depth: 1.0, size: 1.4, alpha: 0.85, count: 0.00003 },  // near: few, bright, faster
  ];
  const ENERGY = { idle: 1, listening: 1.8, thinking: 2.6, speaking: 2 };
  let stars = [];
  let w = 0;
  let h = 0;
  let energy = 1;
  let target = 1;
  let last = performance.now();
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const dpr = sceneDpr();
    const density = window.SCENE_DPR === 1 ? 0.6 : 1; // the simpler scene (wallpaper on battery): fewer stars
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = LAYERS.flatMap((layer) => Array.from({ length: Math.round(w * h * layer.count * density) }, () => ({
      layer, x: Math.random() * w, y: Math.random() * h, phase: Math.random() * Math.PI * 2, rate: 0.6 + Math.random() * 1.4,
    })));
  }

  const gate = Perf.gate();
  function frame(now) {
    requestAnimationFrame(frame);
    if (!gate(now)) { if (document.hidden) last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    energy += (target - energy) * Math.min(1, dt * 2); // ease between states
    const t = now / 1000;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#bdf6ff';
    for (const s of stars) {
      const { depth, size, alpha } = s.layer;
      if (!reduceMotion) {
        s.x -= depth * 6 * energy * dt;          // gentle leftward drift, nearer = faster
        s.y += depth * 1.2 * energy * dt;        // with a slight fall, so it doesn't feel like a conveyor
        if (s.x < -2) { s.x = w + 2; s.y = Math.random() * h; }
        if (s.y > h + 2) { s.y = -2; s.x = Math.random() * w; }
      }
      const twinkle = 0.65 + 0.35 * Math.sin(t * s.rate + s.phase);
      ctx.globalAlpha = Math.min(1, alpha * twinkle * (0.85 + 0.15 * energy));
      ctx.beginPath();
      ctx.arc(s.x, s.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  window.Stars = { setState: (state) => { target = ENERGY[state] || 1; } };
  new ResizeObserver(resize).observe(canvas);
  addEventListener('scene-quality', resize);
  resize();
  requestAnimationFrame(frame);
})();
