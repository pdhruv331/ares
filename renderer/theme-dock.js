// The ARES dock's page (theme-dock.js in the main process has the window, apps and pointer).
(() => {
  const $ = (id) => document.getElementById(id);
  const dock = $('dock'), nameEl = $('name');
  const CYAN = [62, 230, 255], VIOLET = [167, 139, 250], AMBER = [255, 181, 71];
  let apps = [], folders = [], prefs = { icons: 'glyphs', reveal: 'edge' };
  let running = new Set(), front = '', badges = {};
  const tiles = new Map(); // id -> { el, item }
  let hover = null;

  // ---- Glyphs: the real icon turned into a soft cyan outline (the edges of its shading more than of its shape) ----
  const glyphCache = new Map(); // key -> { data: ImageData | null, waiting: [canvas] }
  function glyphData(src, done) {
    const img = new Image();
    img.onload = () => {
      const t = document.createElement('canvas');
      t.width = t.height = 96;
      const tc = t.getContext('2d', { willReadFrequently: true });
      tc.drawImage(img, 0, 0, 96, 96);
      const px = tc.getImageData(0, 0, 96, 96).data;
      const v = new Float32Array(96 * 96), a = new Float32Array(96 * 96);
      for (let i = 0; i < 96 * 96; i++) {
        a[i] = px[i * 4 + 3] / 255;
        v[i] = ((0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2]) / 255) * a[i];
      }
      const out = new ImageData(96, 96);
      const at = (arr, x, y) => arr[Math.min(95, Math.max(0, y)) * 96 + Math.min(95, Math.max(0, x))];
      const sob = (arr, x, y) => Math.hypot(
        -at(arr, x - 1, y - 1) - 2 * at(arr, x - 1, y) - at(arr, x - 1, y + 1) + at(arr, x + 1, y - 1) + 2 * at(arr, x + 1, y) + at(arr, x + 1, y + 1),
        -at(arr, x - 1, y - 1) - 2 * at(arr, x, y - 1) - at(arr, x + 1, y - 1) + at(arr, x - 1, y + 1) + 2 * at(arr, x, y + 1) + at(arr, x + 1, y + 1));
      for (let y = 0; y < 96; y++) {
        for (let x = 0; x < 96; x++) {
          const e = Math.min(1, sob(a, x, y) * 0.3 + sob(v, x, y) * 2.4);
          const i = (y * 96 + x) * 4;
          const alpha = Math.max(e > 0.14 ? e : 0, a[y * 96 + x] * 0.05);
          out.data[i] = e > 0.6 ? 182 : 62; out.data[i + 1] = e > 0.6 ? 250 : 230; out.data[i + 2] = 255;
          out.data[i + 3] = Math.round(alpha * 255);
        }
      }
      done(out);
    };
    img.onerror = () => done(null);
    img.src = src;
  }
  /** A tile's glyph canvas, drawn as soon as its glyph is ready (decoding is asynchronous). */
  function glyph(item) {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const ctx = c.getContext('2d');
    if (item.kind === 'trash') { trashGlyph(ctx); return c; }
    let entry = glyphCache.get(item.id);
    if (!entry) {
      entry = { data: null, waiting: [] };
      glyphCache.set(item.id, entry);
      glyphData(item.icon, (data) => { entry.data = data; for (const w of entry.waiting.splice(0)) if (data) w.getContext('2d').putImageData(data, 0, 0); });
    }
    if (entry.data) ctx.putImageData(entry.data, 0, 0); else entry.waiting.push(c);
    return c;
  }
  function trashGlyph(ctx) {
    ctx.strokeStyle = 'rgba(62,230,255,0.95)'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(26, 30); ctx.lineTo(70, 30); ctx.moveTo(40, 30); ctx.lineTo(42, 22); ctx.lineTo(54, 22); ctx.lineTo(56, 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(30, 36); ctx.lineTo(34, 78); ctx.lineTo(62, 78); ctx.lineTo(66, 36); ctx.stroke();
    ctx.globalAlpha = 0.6;
    for (const x of [40, 48, 56]) { ctx.beginPath(); ctx.moveTo(x, 44); ctx.lineTo(x, 70); ctx.stroke(); }
  }

  // ---- Tiles ----
  function tile(item) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.innerHTML = '<i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br bo"></i><i class="run"></i><b class="badge"></b>';
    const useGlyph = prefs.icons !== 'real' || item.kind === 'trash';
    el.classList.add(useGlyph ? 'glyph' : 'real');
    let art;
    if (useGlyph) art = glyph(item);
    else {
      art = document.createElement('img');
      art.src = item.icon;
    }
    el.prepend(art);
    el.addEventListener('click', () => {
      el.classList.add('press');
      setTimeout(() => el.classList.remove('press'), 160);
      if (!item.kind && !running.has(item.id)) el.classList.add('launching');
      window.theme.send('theme-dock-act', { type: 'open', id: item.id });
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); window.theme.send('theme-dock-act', { type: 'menu', id: item.id }); });
    tiles.set(item.id, { el, item });
    return el;
  }
  function build() {
    tiles.clear();
    const half = Math.ceil(apps.length / 2);
    $('left').replaceChildren(...apps.slice(0, half).map(tile));
    $('right').replaceChildren(...apps.slice(half).map(tile));
    $('places').replaceChildren(...folders.map(tile));
    paintRunning();
    setTimeout(postHits, 50);
  }
  function paintRunning() {
    for (const [id, { el, item }] of tiles) {
      el.classList.toggle('running', running.has(id));
      el.classList.toggle('front', id === front);
      if (running.has(id)) el.classList.remove('launching');
      const b = badges[item.name] || '';
      el.classList.toggle('badged', Boolean(b));
      el.querySelector('.badge').textContent = b.length > 3 ? '99+' : b;
    }
  }

  // ---- Hit areas and hover (the main process forwards the pointer) ----
  function postHits() {
    const rects = [];
    if (dock.classList.contains('shown')) {
      for (const { el } of tiles.values()) { const r = el.getBoundingClientRect(); rects.push({ x: r.left - 7, y: r.top - 14, w: r.width + 14, h: r.height + 28 }); }
    }
    if (dock.classList.contains('orb-on')) { const r = $('orbSlot').getBoundingClientRect(); rects.push({ x: r.left - 6, y: r.top - 22, w: r.width + 12, h: r.height + 34 }); }
    window.theme.send('theme-hits', rects.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })));
  }
  function pointer(x, y) {
    let found = null;
    if (dock.classList.contains('shown')) {
      for (const t of tiles.values()) {
        const r = t.el.getBoundingClientRect();
        if (x >= r.left - 7 && x <= r.right + 7 && y >= r.top - 18 && y <= r.bottom + 14) { found = t; break; }
      }
    }
    if (found === hover) return;
    hover?.el.classList.remove('hover');
    hover = found;
    if (!found) { nameEl.classList.remove('on'); return; }
    found.el.classList.add('hover');
    const r = found.el.getBoundingClientRect();
    nameEl.textContent = found.item.name.toUpperCase();
    nameEl.style.left = `${r.left + r.width / 2 + 2}px`;
    nameEl.classList.add('on');
  }
  $('orbSlot').addEventListener('click', () => window.theme.send('theme-dock-act', { type: 'summon' }));

  // ---- The ARES orb: a white core, a halo that breathes with her real voice, violet + a comet while thinking ----
  const orb = $('orb');
  const octx = orb.getContext('2d');
  const scene = { state: 'idle', level: 0, target: 0, attention: false, ripples: [] };
  let orbOn = false, raf = 0, lastFrame = 0, t0 = performance.now();
  function sizeOrb() { const k = window.devicePixelRatio || 1; orb.width = orb.height = 160 * k; octx.setTransform(k, 0, 0, k, 0, 0); }
  function colour() { return scene.attention ? AMBER : scene.state === 'thinking' ? VIOLET : CYAN; }
  function frame(now) {
    raf = 0;
    if (!orbOn && now - orbOffAt > 900) { octx.clearRect(0, 0, 160, 160); return; }
    raf = requestAnimationFrame(frame);
    const busy = scene.state !== 'idle' || scene.level > 0.02 || scene.ripples.length;
    if (now - lastFrame < (busy ? 32 : 66)) return; // 30 fps while she's active, 15 for the slow idle breath
    const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000);
    lastFrame = now;
    const t = (now - t0) / 1000;
    scene.level += (scene.target - scene.level) * Math.min(1, dt * 12);
    const [r, g, b] = colour();
    const cx = 80, cy = 80, lv = scene.level;
    octx.clearRect(0, 0, 160, 160);
    // Halo
    const breath = 0.5 + 0.5 * Math.sin(t * (scene.state === 'idle' ? 1.3 : 2.6));
    const R = 20 + breath * 2.5 + lv * 12;
    const halo = octx.createRadialGradient(cx, cy, 4, cx, cy, R + 22);
    halo.addColorStop(0, `rgba(${r},${g},${b},${0.55 + lv * 0.3})`);
    halo.addColorStop(0.45, `rgba(${r},${g},${b},${0.16 + lv * 0.2})`);
    halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
    octx.fillStyle = halo;
    octx.beginPath(); octx.arc(cx, cy, R + 22, 0, Math.PI * 2); octx.fill();
    // The ring, rippling with the voice
    octx.strokeStyle = `rgba(${r},${g},${b},${0.55 + lv * 0.4})`;
    octx.lineWidth = 1.4;
    octx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const w = lv * 3.2 * Math.sin(a * 5 + t * 7) + lv * 1.6 * Math.sin(a * 9 - t * 11);
      const rr = R + w;
      i ? octx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : octx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    octx.stroke();
    // Ripples on loud moments
    if (lv > 0.45 && (!scene.ripples.length || t - scene.ripples[scene.ripples.length - 1] > 0.35)) scene.ripples.push(t);
    scene.ripples = scene.ripples.filter((s) => t - s < 1.1);
    for (const s of scene.ripples) {
      const k = (t - s) / 1.1;
      octx.strokeStyle = `rgba(${r},${g},${b},${0.5 * (1 - k)})`;
      octx.beginPath(); octx.arc(cx, cy, R + k * 30, 0, Math.PI * 2); octx.stroke();
    }
    // Thinking: a comet circling
    if (scene.state === 'thinking') {
      const a0 = t * 4.2;
      for (let i = 0; i < 18; i++) {
        const a = a0 - i * 0.07, k = 1 - i / 18;
        octx.fillStyle = `rgba(${r},${g},${b},${0.9 * k})`;
        octx.beginPath(); octx.arc(cx + Math.cos(a) * (R + 6), cy + Math.sin(a) * (R + 6), 2.4 * k + 0.4, 0, Math.PI * 2); octx.fill();
      }
    }
    // The white core
    const core = octx.createRadialGradient(cx, cy, 0, cx, cy, 9 + lv * 3);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.5, 'rgba(240,253,255,0.95)');
    core.addColorStop(1, `rgba(${r},${g},${b},0)`);
    octx.fillStyle = core;
    octx.beginPath(); octx.arc(cx, cy, 9 + lv * 3, 0, Math.PI * 2); octx.fill();
  }
  let orbOffAt = 0;
  function setOrb(on) {
    orbOn = on;
    dock.classList.toggle('orb-on', on);
    if (!on) orbOffAt = performance.now();
    if (!raf) raf = requestAnimationFrame(frame);
    setTimeout(postHits, 550);
  }

  // ---- From the main process ----
  window.theme.on('theme-dock', (m) => {
    switch (m.type) {
      case 'apps': apps = m.apps; folders = m.folders; glyphCache.clear(); build(); break;
      case 'prefs': { const rebuild = m.icons !== prefs.icons; prefs = { icons: m.icons, reveal: m.reveal }; if (rebuild) build(); break; }
      case 'running': running = new Set(m.running); front = m.front; badges = m.badges || {}; paintRunning(); break;
      case 'reveal': dock.classList.toggle('shown', m.on); if (!m.on) pointer(-1, -1); setTimeout(postHits, m.on ? 380 : 50); break;
      case 'pointer': pointer(m.x, m.y); break;
      case 'orb': setOrb(m.on); break;
      case 'scene': {
        const s = m.msg;
        if (s.type === 'state') scene.state = s.state;
        else if (s.type === 'level') scene.target = Math.min(1, (s.v || 0) * 1.5);
        else if (s.type === 'attention') scene.attention = s.on;
        if (s.type === 'state' && s.state !== 'speaking' && s.state !== 'listening') scene.target = 0;
        break;
      }
    }
  });
  window.addEventListener('resize', () => { sizeOrb(); postHits(); });
  sizeOrb();
  window.theme.send('theme-ready');
})();
