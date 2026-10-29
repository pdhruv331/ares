// The ARES dock's page (theme-dock.js in the main process has the window, apps and pointer).
(() => {
  const $ = (id) => document.getElementById(id);
  const dock = $('dock'), nameEl = $('name');
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
    // Both sides of the orb the same width: the right side also carries the divider and the places
    const half = Math.min(apps.length, Math.ceil((apps.length + folders.length) / 2));
    $('left').replaceChildren(...apps.slice(0, half).map(tile));
    $('right').replaceChildren(...apps.slice(half).map(tile));
    $('places').replaceChildren(...folders.map(tile));
    paintRunning();
    requestAnimationFrame(centre);
    setTimeout(postHits, 50);
  }
  /** The orb slot's centre on the screen's centre, whatever the two sides hold. */
  function centre() {
    const slot = $('orbSlot').getBoundingClientRect(), d = dock.getBoundingClientRect();
    const offset = slot.left + slot.width / 2 - d.left;
    dock.style.left = `${Math.round(innerWidth / 2 - offset)}px`;
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
  // ---- From the main process ----
  window.theme.on('theme-dock', (m) => {
    switch (m.type) {
      case 'apps': apps = m.apps; folders = m.folders; glyphCache.clear(); build(); break;
      case 'prefs': { const rebuild = m.icons !== prefs.icons; prefs = { icons: m.icons, reveal: m.reveal }; if (rebuild) build(); break; }
      case 'running': running = new Set(m.running); front = m.front; badges = m.badges || {}; paintRunning(); break;
      case 'reveal': dock.classList.toggle('shown', m.on); if (!m.on) pointer(-1, -1); setTimeout(postHits, m.on ? 380 : 50); break;
      case 'pointer': pointer(m.x, m.y); break;
    }
  });
  window.addEventListener('resize', () => { centre(); postHits(); });
  window.theme.send('theme-ready');
})();
