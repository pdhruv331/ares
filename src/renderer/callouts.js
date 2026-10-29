// The reactor's readout callouts (docs/reactor-prompt.md, section 5), the window's side: JOBS, HOST, CLAUDE and BATTERY
// get their live values here (jobs from the Work feed, the rest from readouts.js in the main process), scene.js draws them
// beside the reactor, and a click opens a CARD next to the label: EDITH brackets unfolding, a slightly see-through
// backing, a few rows and actions. Voice opens them too ("how's my Claude usage?", app.js). One card at a time; a click
// elsewhere, Esc, or the label again closes it.
const Callouts = (() => {
  const layer = document.getElementById('panels');
  if (!layer || !window.Scene) return { open() {}, close() {}, get isOpen() { return false; }, cardRect: () => null };
  const CARD_W = 236;
  let jobs = [];
  let info = { host: null, claude: null, battery: null };
  let card = null; // { id, el, timer }

  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
  const when = (ms) => {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  };
  const mins = (m) => (!Number.isFinite(m) || m < 0 ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const jobPct = (j) => {
    if (j.progress?.total) return Math.round((j.progress.done / j.progress.total) * 100);
    if (!j.started) return 0;
    const m = (Date.now() - j.started) / 60_000;
    return Math.min(92, Math.round(100 * (1 - Math.exp(-m / ({ small: 4, medium: 10, large: 25 }[j.size] || 10)))));
  };

  // ---- The four readouts: a short value, and amber when it matters ------------------------------------------------------
  const active = () => jobs.filter((j) => ['queued', 'running', 'approval', 'paused'].includes(j.status));
  function values() {
    const act = active();
    const need = act.filter((j) => j.status === 'approval').length;
    const working = act.filter((j) => j.status === 'running').length;
    const h = info.host, c = info.claude, b = info.battery;
    const five = c?.five?.pct, week = c?.week?.pct;
    return {
      jobs: { value: act.length ? `${working} WORKING${need ? ` · ${need} NEED${need === 1 ? 'S' : ''} YOU` : act.length - working ? ` · ${act.length - working} WAITING` : ''}` : 'NONE RUNNING', amber: need > 0 },
      host: { value: h ? `${String(h.name || 'MAC').toUpperCase()} · ${h.phone?.connected ? 'ONLINE' : h.phone?.paired ? 'PHONE OFF' : 'ONLINE'}` : 'MAC · …', amber: Boolean(h?.phone?.paired && !h.phone.connected) },
      claude: { value: c ? `5H ${pct(five)} · WEEK ${pct(week)}` : 'NO READING', amber: Number.isFinite(five) && five >= 80 },
      battery: { value: b ? `${pct(b.pct)} · ${b.charging ? 'CHARGING' : b.source === 'ac' ? 'ON POWER' : 'ON BATTERY'}` : 'NO BATTERY', amber: Boolean(b && !b.charging && b.source !== 'ac' && b.pct <= 20) },
    };
  }
  function push() { Scene.setReadouts(values()); if (card) render(); }

  // ---- Cards ------------------------------------------------------------------------------------------------------------------
  const bar = (v, amber) => `<div class="cc-bar${amber ? ' amber' : ''}"><i style="width:${Math.max(0, Math.min(100, Number(v) || 0))}%"></i></div>`;
  const row = (k, v) => `<div class="cc-row"><b>${esc(k)}</b><span>${v}</span></div>`;
  function content(id) {
    const h = info.host, c = info.claude, b = info.battery;
    if (id === 'jobs') {
      const act = active();
      const waiting = act.find((j) => j.status === 'approval');
      return {
        tag: act.length ? `${act.length} ACTIVE` : 'IDLE',
        body: act.length ? act.map((j) => `<div class="cc-job${j.status === 'approval' ? ' amber' : ''}"><span>${esc(j.title)}</span><em>${j.status === 'approval' ? 'NEEDS YOU' : j.status === 'paused' ? 'PAUSED' : j.status === 'queued' ? 'QUEUED' : `${jobPct(j)}%`}</em>${bar(j.status === 'approval' ? jobPct(j) : jobPct(j), j.status === 'approval')}</div>`).join('')
          : '<div class="cc-note">Nothing running, sir.</div>',
        actions: [
          waiting && { label: 'APPROVE', amber: true, run: () => window.ares.work.answer(waiting.id, true) },
          { label: 'OPEN WORK', run: () => { if (typeof Work !== 'undefined') Work.open(); } },
          act.length && { label: 'STOP ALL', danger: true, run: () => window.ares.autonomy.act('stop', {}) },
        ].filter(Boolean),
      };
    }
    if (id === 'host') {
      return {
        tag: h?.phone?.connected ? 'ONLINE' : 'ONLINE',
        body: h ? [
          row('UPTIME', esc(h.uptime || '—')),
          row('PHONE', h.phone?.paired ? (h.phone.connected ? `connected${h.phone.name ? ` · ${esc(h.phone.name)}` : ''}` : '<span class="amber">not connected</span>') : 'not paired'),
          row('TAILSCALE', h.tailscale == null ? 'not set up' : h.tailscale ? 'running' : '<span class="amber">off</span>'),
          row('REACHABLE', h.reachable ? 'stay reachable on' : 'off'),
          row('THEME', h.theme ? 'ARES OS theme on' : 'off'),
        ].join('') : '<div class="cc-note">Reading…</div>',
        actions: [
          { label: 'LOCK', run: () => window.ares.readouts.act('lock') },
          { label: 'SLEEP', run: () => window.ares.readouts.act('sleep') },
        ],
      };
    }
    if (id === 'claude') {
      const five = c?.five, week = c?.week;
      return {
        tag: five ? `${five.pct}%${five.exact ? '' : ' EST.'}` : 'NO READING',
        body: [
          `<div class="cc-gauge"><b>5-HOUR</b><span>${five ? `${five.pct}%` : '—'}${five?.resetsAt ? ` · resets ${esc(when(five.resetsAt))}` : ''}</span>${bar(five?.pct, five && five.pct >= 80)}</div>`,
          `<div class="cc-gauge"><b>WEEKLY</b><span>${week ? `${week.pct}%` : '—'}${week?.resetsAt ? ` · resets ${esc(when(week.resetsAt))}` : ''}</span>${bar(week?.pct, week && week.pct >= 80)}</div>`,
          row('RESERVE', c?.reserve ? `chat kept free above ${c.reserve.fiveHour}% / ${c.reserve.weekly}%` : '—'),
          row('BUSIEST', c?.busiest ? esc(c.busiest) : 'nothing running'),
        ].join(''),
        actions: [
          { label: 'PAUSE PROJECTS', run: () => window.ares.readouts.act('pause-projects') },
          { label: 'DETAILS', run: () => document.getElementById('statusBtn')?.click() },
        ],
      };
    }
    if (id === 'battery') {
      return {
        tag: b ? `${pct(b.pct)}${b.charging ? ' ⚡' : ''}` : '—',
        body: b ? [
          `<div class="cc-gauge"><b>CHARGE</b><span>${pct(b.pct)}${b.timeLeft != null && mins(b.timeLeft) ? ` · ${b.charging ? 'full in' : 'about'} ${mins(b.timeLeft)}${b.charging ? '' : ' left'}` : ''}</span>${bar(b.pct, !b.charging && b.pct <= 20)}</div>`,
          row('POWER', b.charging ? 'charging' : b.source === 'ac' ? 'mains' : 'battery'),
          row('LOW POWER', b.lowPower ? 'on' : 'off'),
          row('AWAKE', b.awake?.length ? b.awake.map(esc).join(', ') : 'nothing keeping the Mac awake'),
        ].join('') : '<div class="cc-note">No battery reading.</div>',
        actions: [b && !b.lowPower && { label: 'LOW POWER ON', run: () => window.ares.readouts.act('lowpower') }].filter(Boolean),
      };
    }
    return { tag: '', body: '', actions: [] };
  }
  function render() {
    if (!card) return;
    const d = content(card.id);
    const sig = JSON.stringify(d.body) + d.tag + d.actions.map((a) => a.label).join();
    if (sig === card.sig) return;
    card.sig = sig;
    card.el.querySelector('.dc-tag').textContent = d.tag;
    card.el.querySelector('.cc-body').innerHTML = d.body;
    const acts = card.el.querySelector('.dc-actions');
    acts.innerHTML = '';
    for (const a of d.actions) {
      const b = document.createElement('button');
      b.className = `dc-btn${a.danger ? ' danger' : ''}${a.amber ? ' amber' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        b.disabled = true;
        try { const r = await a.run(); if (r?.message) window.ares.comms.note('ares', r.message, { notice: true }); } catch (err) { window.ares.comms.note('ares', `That didn't work, sir: ${err.message}.`, { notice: true }); }
        b.disabled = false;
        if (a.label === 'OPEN WORK' || a.label === 'DETAILS') close();
      });
      acts.appendChild(b);
    }
    place();
  }
  function place() {
    if (!card) return;
    const box = Scene.calloutBox(card.id);
    const st = Dash.stageRect;
    if (!box) return;
    const h = card.el.offsetHeight || 120;
    const left = box.right ? box.x + box.w + 10 : box.x - CARD_W - 10;
    const top = box.y - 8;
    const x = Math.max(8, Math.min(st.width - CARD_W - 8, left - st.left));
    const y = Math.max(8, Math.min(st.height - h - 8, top - st.top));
    card.el.style.left = `${Math.round(x)}px`;
    card.el.style.top = `${Math.round(y)}px`;
  }
  function open(id) {
    if (!['jobs', 'host', 'claude', 'battery'].includes(id)) return false;
    if (card?.id === id) { close(); return true; }
    if (card) close(true);
    const el = document.createElement('div');
    el.className = `dp-card callout-card cc-${id}`;
    el.style.setProperty('--c', values()[id]?.amber ? '255,181,71' : '62,230,255');
    el.innerHTML = `<i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br bo"></i>
      <div class="dc-in"><div class="dp-head"><span class="dc-label">${id.toUpperCase()}</span><span class="dc-tag"></span></div>
        <div class="cc-body"></div><div class="dc-actions"></div></div>`;
    el.style.width = `${CARD_W}px`;
    layer.appendChild(el);
    card = { id, el, sig: '', timer: setInterval(render, 1000) };
    Scene.setOpenCallout(id);
    render();
    window.ares.readouts?.detail?.().then((d) => { if (d) { info = { ...info, ...d }; push(); } }).catch(() => {});
    const reduce = Dash.reduceMotion;
    if (!reduce) {
      const box = Scene.calloutBox(id);
      el.style.transformOrigin = box?.right ? '0% 10%' : '100% 10%';
      el.animate([
        { transform: 'scaleX(0.04) scaleY(0.5)', opacity: 0.6, filter: 'brightness(2)' },
        { transform: 'scaleX(1.02) scaleY(0.98)', opacity: 1, offset: 0.7 },
        { transform: 'scale(1)', filter: 'brightness(1)' },
      ], { duration: 160, easing: 'cubic-bezier(.3,.7,.4,1)' });
      el.querySelector('.dc-in').animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: 220 });
    }
    return true;
  }
  function close(quiet = false) {
    if (!card) return false;
    const c = card;
    card = null;
    clearInterval(c.timer);
    Scene.setOpenCallout(null);
    if (quiet || Dash.reduceMotion) { c.el.remove(); return true; }
    c.el.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scaleX(0.04) scaleY(0.5)', opacity: 0 }], { duration: 130, easing: 'ease-in', fill: 'forwards' })
      .finished.then(() => c.el.remove(), () => c.el.remove());
    return true;
  }

  // ---- Wiring -----------------------------------------------------------------------------------------------------------------
  window.addEventListener('callout-click', (e) => open(e.detail));
  addEventListener('pointerdown', (e) => { if (card && !card.el.contains(e.target) && Scene.calloutAt(e.clientX, e.clientY) !== card.id) close(); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && card) close(); });
  addEventListener('panels-layout', () => {
    const st = Dash.stageRect, edges = Dash.desk.edges;
    Scene.setColumns(edges ? { left: st.left + edges.left, right: st.left + edges.right } : null);
    place();
  });
  addEventListener('scene-look', () => { if (window.SCENE_LOOK !== 'reactor') close(true); });
  window.ares.work.list().then((all) => { jobs = all; push(); });
  window.ares.work.onChange((job) => { const i = jobs.findIndex((j) => j.id === job.id); if (i >= 0) jobs[i] = job; else jobs.push(job); push(); });
  window.ares.work.onRemoved((id) => { jobs = jobs.filter((j) => j.id !== id); push(); });
  window.ares.readouts?.on?.((d) => { info = { ...info, ...d }; push(); });
  window.ares.readouts?.get?.().then((d) => { if (d) { info = { ...info, ...d }; push(); } }).catch(() => {});
  setInterval(() => { if (jobs.some((j) => j.status === 'running')) push(); }, 5000); // the % moves with time
  push();

  return {
    open, close,
    get isOpen() { return Boolean(card); },
    get openId() { return card?.id || null; },
    /** The open card on screen (client px), for the translucency rule. */
    cardRect() { if (!card) return null; const r = card.el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; },
    get values() { return values(); },
  };
})();
window.Callouts = Callouts;
