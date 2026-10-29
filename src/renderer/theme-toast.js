// ARES notifications' page (theme-notify.js): each alert materializes like a dashboard panel (renderer/dash.js
// materialize: brackets flicker on, a scan line sweeps down revealing the content, the text decodes), then folds away
// by itself or on click.
(() => {
  const stack = document.getElementById('stack');
  const KIND = { day: '62,230,255', work: '167,139,250', call: '74,222,128', needs: '255,181,71' };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const live = new Map(); // id -> { el, timer, toast }
  const GLYPHS = '▚▞▖▗▘▝◢◣◤◥01#%&';

  function decode(el, ms) {
    const final = el.textContent;
    if (!final || reduce) return;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const n = Math.floor(final.length * k);
      el.textContent = final.slice(0, n) + [...final.slice(n)].map((c) => (c === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join('');
      if (k < 1) requestAnimationFrame(step); else el.textContent = final;
    };
    requestAnimationFrame(step);
  }

  function show(t) {
    const el = document.createElement('div');
    el.className = 'tp';
    el.style.setProperty('--c', KIND[t.kind] || KIND.day);
    el.innerHTML = `<div class="tp-back"></div><i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br bo"></i>
      <div class="tp-content"><div class="tp-head"><span>${esc(t.label).toUpperCase()}</span><span>${esc(t.tag).toUpperCase()}</span></div>
      <div class="tp-value">${esc(t.value)}</div><div class="tp-detail">${esc(t.detail)}</div></div>
      <div class="tp-life"><i></i></div><div class="tp-scan"></div>`;
    stack.prepend(el);
    while (stack.children.length > 4) dismiss(Number(stack.lastElementChild.dataset.id), true);
    el.dataset.id = t.id;
    const rec = { el, toast: t, timer: null };
    live.set(t.id, rec);
    el.addEventListener('click', () => { window.theme.send('theme-toast-act', { type: 'open', toast: t }); dismiss(t.id); });
    materialize(el);
    const life = el.querySelector('.tp-life i');
    life.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: t.ttl, easing: 'linear', fill: 'forwards' });
    rec.timer = setTimeout(() => dismiss(t.id), t.ttl);
    setTimeout(postHits, 60);
  }

  function materialize(el) {
    if (reduce) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 }); return; }
    for (const b of el.querySelectorAll('.br')) b.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0.25, offset: 0.6 }, { opacity: 1 }], { duration: 360, easing: 'steps(6, end)' });
    const content = el.querySelector('.tp-content'), back = el.querySelector('.tp-back');
    for (const x of [content, back]) x.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], { duration: 440, delay: 120, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'backwards' });
    el.querySelector('.tp-scan').animate([{ top: '0%', opacity: 1 }, { top: '100%', opacity: 1, offset: 0.92 }, { top: '100%', opacity: 0 }], { duration: 480, delay: 120, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'backwards' });
    for (const x of el.querySelectorAll('.tp-value, .tp-detail')) decode(x, 520);
    el.animate([{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 420, delay: 380, easing: 'ease-out' });
  }

  function dismiss(id, now = false) {
    const rec = live.get(id);
    if (!rec) return;
    live.delete(id);
    clearTimeout(rec.timer);
    const done = () => { rec.el.remove(); postHits(); };
    if (now || reduce) return done();
    // Fold to a line, then a point (the dashboard's fold)
    rec.el.animate([
      { transform: 'scale(1, 1)', filter: 'brightness(1)', opacity: 1 },
      { transform: 'scale(1, 0.04)', filter: 'brightness(2.2)', opacity: 1, offset: 0.55 },
      { transform: 'scale(0.02, 0.04)', filter: 'brightness(2.5)', opacity: 0 },
    ], { duration: 280, easing: 'cubic-bezier(.5,0,.7,.4)', fill: 'forwards' }).finished.then(done, done);
  }

  function postHits() {
    const rects = [...live.values()].map(({ el }) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
    window.theme.send('theme-hits', rects);
  }
  function pointer(x, y) {
    for (const { el } of live.values()) {
      const r = el.getBoundingClientRect();
      el.classList.toggle('hover', x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    }
  }

  window.theme.on('theme-toast', (m) => {
    if (m.type === 'show') show(m.toast);
    else if (m.type === 'pointer') pointer(m.x, m.y);
  });
  window.theme.send('theme-ready');
})();
