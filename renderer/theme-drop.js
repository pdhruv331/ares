// The ARES bar's status and WORK drop-downs (theme-drop.js has the window). Filled before they're shown, so they appear
// complete; then kept current while open.
(() => {
  const card = document.getElementById('card'), body = document.getElementById('body');
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const act = (a) => window.theme.send('theme-drop-act', a);
  let kind = null;

  function status(d) {
    const s = d.system || {};
    const pct = (v) => `${Math.round((v || 0) * 100)}%`;
    const up = s.uptime != null ? `${Math.floor(s.uptime / 86400)}d ${Math.floor(s.uptime / 3600) % 24}h ${Math.floor(s.uptime / 60) % 60}m` : '—';
    const problems = (d.problems || []).map((p, i) => `<div class="row"><span class="line amber">${esc(p.text)}${p.hint ? ` <span class="line muted">(${esc(p.hint)})</span>` : ''}</span>
      ${p.fix || p.url ? `<button class="btn amber" data-fix="${i}">${esc(p.label || 'FIX')}</button>` : ''}</div>`).join('');
    const lines = (list, amberAt80) => (list || []).map((l) => {
      const n = Number(/(\d+)% used/.exec(l)?.[1]);
      // As in the panel: Claude limits are quiet until 80%; the voice lines are always amber
      return `<div class="line ${amberAt80 && !(n >= 80) ? 'muted' : 'amber'}">${esc(l)}</div>`;
    }).join('');
    const integ = (d.integrations || []).map((it) => `<li class="${it.state}"><span class="dot"></span>${esc(it.text)}</li>`).join('');
    return `
      <div>${problems}${lines(d.claude, true)}${lines(d.voice, false)}
        <div class="row" style="margin-top:6px"><span class="line muted">${(d.problems || []).length ? '' : 'all systems ok'}</span><button class="btn" data-act="recheck">RECHECK</button></div></div>
      ${integ ? `<h4>INTEGRATIONS</h4><ul>${integ}</ul>` : ''}
      <h4>SYSTEM</h4>
      <div class="stat"><label>HOST</label><div class="val">${esc(s.user ? `${s.user}@${s.host}` : '—')}</div></div>
      <div class="stat"><label>CPU LOAD</label><div class="bar"><i data-k="cpu" style="width:${pct(s.cpu)}"></i></div><span data-v="cpu">${pct(s.cpu)}</span></div>
      <div class="stat"><label>MEMORY</label><div class="bar"><i data-k="mem" style="width:${pct(s.memUsed)}"></i></div><span data-v="mem">${pct(s.memUsed)}</span></div>
      <div class="stat"><label>UPTIME</label><div class="val" data-v="up">${up}</div></div>
      <div class="stat"><label>DATE</label><div class="val">${esc(new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</div></div>`;
  }

  const STATUS_WORD = { running: 'WORKING', queued: 'QUEUED', approval: 'NEEDS YOUR OK', done: 'DONE', failed: 'FAILED', cancelled: 'CANCELLED' };
  function work(d) {
    const job = (j) => `<div class="job ${esc(j.status)}" data-job="${esc(j.id)}">
        <span class="jd"></span><span class="jt">${esc(j.title)}</span><span class="js">${STATUS_WORD[j.status] || esc(j.status).toUpperCase()}</span>
        ${j.status === 'approval' && j.ask ? `<div class="ask">${esc(j.ask)}</div>
          <div class="acts"><button class="btn solid" data-answer="yes" data-id="${esc(j.id)}">APPROVE</button><button class="btn amber" data-answer="no" data-id="${esc(j.id)}">DECLINE</button></div>` : ''}
      </div>`;
    const active = (d.active || []).map(job).join(''), recent = (d.recent || []).map(job).join('');
    return `${active ? `<h4>WORKING</h4><div>${active}</div>` : ''}
      ${recent ? `<h4>RECENT</h4><div>${recent}</div>` : ''}
      ${!active && !recent ? '<div class="empty">No jobs yet. Ask ARES to research, write or build something and it runs here.</div>' : ''}
      <div class="foot"><button class="btn" data-act="folder">FOLDER</button><button class="btn" data-act="work">OPEN WORK</button></div>`;
  }

  let last = null;
  function render(k, d) {
    kind = k;
    last = d;
    card.className = `card ${k}`;
    body.innerHTML = k === 'status' ? status(d) : work(d);
    requestAnimationFrame(() => { const r = document.body.getBoundingClientRect(); window.theme.send('theme-drop-size', { w: r.width, h: r.height }); });
  }
  /** While open: the live figures only (no re-layout under the pointer) unless the content itself changed. */
  function update(k, d) {
    if (k !== kind) return;
    if (k === 'status' && last && JSON.stringify({ ...d, system: null }) === JSON.stringify({ ...last, system: null })) {
      const s = d.system || {};
      for (const [key, v] of [['cpu', s.cpu], ['mem', s.memUsed]]) {
        const pct = `${Math.round((v || 0) * 100)}%`;
        const bar = body.querySelector(`[data-k="${key}"]`), val = body.querySelector(`[data-v="${key}"]`);
        if (bar) bar.style.width = pct;
        if (val) val.textContent = pct;
      }
      last = d;
      return;
    }
    render(k, d);
  }
  /** Opening: the brackets flick on and a scan line sweeps down (quick: it's a menu). */
  function open() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const b of card.querySelectorAll('.br')) b.animate([{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 0.4, offset: 0.7 }, { opacity: 1 }], { duration: 200, easing: 'steps(4, end)' });
    body.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], { duration: 160, easing: 'cubic-bezier(.5,0,.3,1)' });
    card.querySelector('.scan').animate([{ top: '0%', opacity: 1 }, { top: '100%', opacity: 1, offset: 0.9 }, { top: '100%', opacity: 0 }], { duration: 180, easing: 'cubic-bezier(.5,0,.3,1)' });
  }

  body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.fix != null) return act({ type: 'fix', problem: last?.problems?.[Number(b.dataset.fix)] });
    if (b?.dataset.answer) return act({ type: 'answer', id: b.dataset.id, yes: b.dataset.answer === 'yes' });
    if (b?.dataset.act) return act({ type: b.dataset.act });
    const j = e.target.closest('[data-job]');
    if (j) act({ type: 'job', id: j.dataset.job });
  });

  window.theme.on('theme-drop', (m) => {
    if (m.type === 'fill') render(m.kind, m.data);
    else if (m.type === 'update') update(m.kind, m.data);
    else if (m.type === 'open') open();
  });
  window.theme.send('theme-ready');
})();
