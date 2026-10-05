// ARES phone app: Work. The Mac's background jobs on the phone: a live list and gallery, results rendered
// for mobile (the Mac's own markdown renderer: charts, diagrams, images, files, sandboxed mini-apps), and
// the remote controls (start, follow up, Yes/No, cancel, dismiss, send to Mac). Jobs run on the Mac; this
// is the remote. Orbs on the brain are the same as on the Mac, and a tapped orb grows into the job.
const Work = (() => {
  const $ = (id) => document.getElementById(id);
  const sheet = $('work');
  const listView = $('wkList');
  const detail = $('wkDetail');
  const esc = Markdown.esc;
  const fileUrl = (id, p) => `/api/jobs/${encodeURIComponent(id)}/file/${String(p).split('/').map(encodeURIComponent).join('/')}`;
  Markdown.configure({ fileUrl, fileUrlPattern: /^\/api\/jobs\/[\w-]+\/file\//i });

  let jobs = [];
  let cards = new Map(); // gallery cards by id
  let openId = null;     // the job in the detail view
  let events = [];
  let view = 'list';     // 'list' | 'gallery'
  let filter = null;     // ids matching the search, or null
  let version = null;    // an earlier version being viewed
  let newFiles = [];     // files picked for a new job: { name, type, data }
  let reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Inside the Android app (?app=1): just the Work view in its WebView, no chat. Closing hands back to the app.
  const EMBED = new URLSearchParams(location.search).get('app') === '1';
  let embedStart = 'job'; // what the app opened: one job, or the list
  const handBack = () => { location.hash = 'closed'; }; // the app watches for this

  const STATUS = { queued: 'QUEUED', running: 'WORKING', approval: 'NEEDS YOUR OK', done: 'DONE', failed: 'FAILED', cancelled: 'CANCELLED', paused: 'PAUSED' };
  // Autonomy on the phone (docs/autonomy-prompt.md §R, §5): projects, goals and routines tabs, the kill switch
  let mode = 'jobs';   // 'jobs' | 'projects' | 'goals' | 'routines'
  let auto = null;     // the Mac's autonomy state
  const PHASES = ['plan', 'build', 'test', 'verify', 'report'];
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const describeSchedule = (sc) => !sc ? '' : sc.kind === 'event' ? (sc.event === 'unlock' ? 'on unlock' : 'on wake') : sc.kind === 'interval' ? (sc.minutes % 60 === 0 ? `every ${sc.minutes / 60}h` : `every ${sc.minutes} min`)
    : `${sc.days ? sc.days.map((d) => DAYS[d]).join('/') : 'daily'} ${String(sc.hour).padStart(2, '0')}:${String(sc.minute).padStart(2, '0')}`;
  const autoAct = (name, args) => api('/api/autonomy/act', { name, args }).catch((err) => ({ error: err.message }));
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const took = (j) => {
    if (!j.started) return '';
    const s = Math.round(((j.finished || Date.now()) - j.started) / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };
  const isActive = (j) => ['queued', 'running', 'approval'].includes(j.status);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const ext = (p) => (String(p).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const KIND = { png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img', avif: 'img', pdf: 'pdf',
    docx: 'doc', doc: 'doc', odt: 'doc', rtf: 'doc', pptx: 'deck', ppt: 'deck', odp: 'deck', xlsx: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'text',
    md: 'text', txt: 'text', json: 'text', html: 'app', htm: 'app' };
  const kindOf = (p) => KIND[ext(p)] || 'file';
  const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const orbs = () => window.JobOrbs;

  // ---- The Mac, over the paired connection -------------------------------------------------------------
  async function api(path, body) {
    const res = await fetch(path, body === undefined ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 401) { showPair(); throw new Error('not paired'); }
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  }
  const act = (id, action, body = {}) => api(`/api/jobs/${encodeURIComponent(id)}/${action}`, body).catch((err) => ({ error: err.message }));

  /** Read a picked or shared file for sending: { name, type, data (base64) }. */
  const readFile = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, data: String(r.result).split(',')[1] || '' });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  // ---- The WORK button and the orbs --------------------------------------------------------------------
  function badge() {
    const active = jobs.filter(isActive).length;
    const unseen = jobs.filter((j) => !isActive(j) && !j.seen && j.status !== 'cancelled').length;
    $('workCount').textContent = active || unseen || '';
    $('workBtn').classList.toggle('busy', active > 0);
    $('workBtn').classList.toggle('attention', jobs.some((j) => j.status === 'approval') || (unseen > 0 && !active));
  }
  let listQueued = false;
  function refresh() {
    if (listQueued) return;
    listQueued = true;
    requestAnimationFrame(() => {
      listQueued = false;
      badge();
      orbs()?.sync(jobs);
      if (!sheet.hidden && !listView.hidden) (view === 'gallery' ? renderGallery : renderList)();
    });
  }

  // ---- List and gallery --------------------------------------------------------------------------------
  function tabsBar() {
    let bar = $('wkTabs');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'wkTabs';
      bar.className = 'wk-tabs';
      bar.innerHTML = '<button data-tab="jobs">JOBS</button><button data-tab="projects">PROJECTS</button><button data-tab="goals">GOALS</button><button data-tab="routines">ROUTINES</button>';
      $('wkSearch').insertAdjacentElement('beforebegin', bar);
      const kill = document.createElement('div');
      kill.id = 'wkKill';
      kill.className = 'wk-kill';
      kill.innerHTML = '<span id="wkKillText"></span><button class="icon-btn" id="wkKillBtn" type="button"></button>';
      bar.insertAdjacentElement('afterend', kill);
      bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (!b) return; mode = b.dataset.tab; view = 'list'; refresh(); });
      $('wkKillBtn').addEventListener('click', async () => {
        const r = auto?.paused ? await api('/api/autonomy/resume', { what: 'everything' }) : await api('/api/autonomy/stop', {});
        status(r.message || r.error || '');
        loadAuto();
      });
    }
    for (const b of bar.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === mode);
    $('wkKillText').textContent = auto?.paused ? 'EVERYTHING PAUSED' : `${auto ? `${auto.projects.filter((p) => ['running', 'queued', 'approval'].includes(p.status)).length} project · ${auto.goals.filter((g) => g.status === 'running').length} goals · ${auto.routines.filter((r) => r.enabled).length} routines on` : ''}`;
    $('wkKillBtn').textContent = auto?.paused ? 'RESUME ALL' : 'STOP ALL';
    $('wkKill').classList.toggle('paused', Boolean(auto?.paused));
  }
  async function loadAuto() {
    const r = await api('/api/autonomy/state').catch(() => null);
    if (r?.ok) { auto = r.state; refresh(); }
  }

  function renderAuto() {
    const ul = $('wkJobs');
    const items = mode === 'goals' ? auto?.goals || [] : auto?.routines || [];
    ul.innerHTML = items.length ? '' : `<li class="empty">${!auto ? 'Loading…' : mode === 'goals' ? 'No goals. Tell ARES "my goal is…" and she plans the steps.' : 'No routines. Tell ARES "every weekday at 8, …".'}</li>`;
    for (const it of [...items].reverse()) {
      const li = document.createElement('li');
      li.className = `job ${mode === 'goals' ? it.status : it.enabled ? 'running' : 'cancelled'} auto`;
      if (mode === 'goals') {
        li.innerHTML = `<span class="job-dot"></span><span class="job-title">${esc(it.title)}</span><span class="job-meta">${esc(String(it.status).toUpperCase())} · step ${Math.min(it.current + 1, it.steps.length)}/${it.steps.length}</span>
          <ol class="goal-steps">${it.steps.map((st) => `<li class="${esc(st.status)}">${esc(st.title)}${st.jobId ? ` <a data-job="${esc(st.jobId)}">open</a>` : ''}</li>`).join('')}</ol>
          ${['running', 'paused', 'stuck', 'waiting'].includes(it.status) ? `<div class="wk-row"><button class="icon-btn" data-auto="goal/cancel" data-args='${esc(JSON.stringify({ goal: it.id }))}'>CANCEL</button></div>` : ''}`;
      } else {
        li.innerHTML = `<span class="job-dot"></span><span class="job-title">${esc(it.title)}</span><span class="job-meta">${esc(describeSchedule(it.schedule))}${it.nextRun ? ` · next ${when(it.nextRun)}` : ''}</span>
          <div class="wk-row"><label class="switch ${it.enabled ? 'on' : ''}" data-auto="routine/control" data-args='${esc(JSON.stringify({ routine: it.id, action: it.enabled ? 'off' : 'on' }))}'><i></i>${it.enabled ? 'ON' : 'OFF'}</label>
            <button class="icon-btn" data-auto="routine/control" data-args='${esc(JSON.stringify({ routine: it.id, action: 'run' }))}'>RUN NOW</button>
            <button class="icon-btn" data-auto="routine/control" data-args='${esc(JSON.stringify({ routine: it.id, action: 'delete' }))}'>DELETE</button></div>`;
      }
      ul.appendChild(li);
    }
  }

  function renderList() {
    const ul = $('wkJobs');
    $('wkGallery').hidden = true;
    ul.hidden = false;
    $('wkGalleryBtn').classList.toggle('active', false);
    tabsBar();
    if (mode === 'goals' || mode === 'routines') return renderAuto();
    const pool = mode === 'projects' ? jobs.filter((j) => j.project) : jobs;
    const shown = [...pool].reverse().filter((j) => !filter || filter.has(j.id));
    ul.innerHTML = shown.length ? '' : jobs.length ? '<li class="empty">Nothing matches that.</li>'
      : '<li class="empty">No jobs yet. Type one above, say "do this as a job" in the chat, or share something to ARES and choose Make it a job.</li>';
    for (const j of shown) {
      const li = document.createElement('li');
      li.className = `job ${j.status}${!j.seen && !isActive(j) ? ' unseen' : ''}`;
      li.dataset.job = j.id;
      const doing = j.status === 'running' ? ` · ${j.steps} steps` : '';
      const phase = j.project && ['running', 'paused', 'queued', 'approval'].includes(j.status) ? ` · ${String(j.project.phase || '').toUpperCase()}` : '';
      li.innerHTML = `<span class="job-dot"></span><span class="job-title">${j.project ? '◈ ' : ''}${esc(j.title)}</span><span class="job-meta">${STATUS[j.status]}${phase}${doing} · ${when(j.created)}</span>`;
      ul.appendChild(li);
    }
  }

  function renderGallery() {
    const g = $('wkGallery');
    $('wkJobs').hidden = true;
    g.hidden = false;
    $('wkGalleryBtn').classList.toggle('active', true);
    const shown = [...jobs].reverse().filter((j) => !filter || filter.has(j.id));
    g.innerHTML = shown.map((j) => {
      const c = cards.get(j.id) || {};
      const thumb = c.thumb ? `<img src="${fileUrl(j.id, c.thumb)}" alt="" loading="lazy">` : `<span>${esc((c.kinds?.[0] || j.title[0] || '?').toUpperCase())}</span>`;
      return `<div class="g-card ${j.status}${j.dismissed ? ' dismissed' : ''}" data-job="${esc(j.id)}">
        <div class="g-thumb">${thumb}</div>
        <div class="g-body"><b>${esc(j.title)}</b><small><i class="g-dot"></i>${STATUS[j.status]} · ${when(j.created)}</small>
          <p>${esc(c.snippet || j.summary || j.task || '')}</p>
          ${c.kinds?.length ? `<div class="g-kinds">${c.kinds.map((k) => `<em>${esc(k.toUpperCase())}</em>`).join('')}</div>` : ''}</div></div>`;
    }).join('') || '<div class="work-empty">Nothing matches that.</div>';
  }

  async function load() {
    const r = await api('/api/jobs');
    if (!r.ok) return;
    jobs = r.jobs;
    cards = new Map(r.gallery.map((c) => [c.id, c]));
    refresh();
    loadAuto();
  }

  let searchTimer = null;
  listView.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-auto]');
    if (!a) return;
    let args = {};
    try { args = JSON.parse(a.dataset.args || '{}'); } catch {}
    const r = await autoAct(a.dataset.auto, args);
    status(r.message || r.error || '');
    loadAuto();
  });
  $('wkSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('wkSearch').value.trim();
      filter = q ? new Set((await api(`/api/jobs?q=${encodeURIComponent(q)}`)).ids || []) : null;
      refresh();
    }, 200);
  });
  $('wkGalleryBtn').addEventListener('click', async () => {
    view = view === 'gallery' ? 'list' : 'gallery';
    if (view === 'gallery') await load();
    refresh();
  });
  listView.addEventListener('click', (e) => {
    const j = e.target.closest('[data-job]');
    if (j) return showJob(j.dataset.job);
    if (e.target.closest('[data-close]')) close();
  });

  // ---- A new job, typed or dictated, with files ----------------------------------------------------------
  function showNewFiles() {
    $('wkNewFiles').textContent = newFiles.length ? `📎 ${newFiles.map((f) => f.name).join(', ')}` : '';
  }
  $('wkFiles').addEventListener('change', async (e) => {
    const picked = [...e.target.files].slice(0, 5);
    e.target.value = '';
    newFiles = (await Promise.all(picked.map(readFile).map((p) => p.catch(() => null)))).filter(Boolean);
    showNewFiles();
  });
  $('wkNew').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('wkNewText').value.trim();
    if (!text) return $('wkNewText').focus();
    const btn = $('wkNew').querySelector('[type=submit]');
    btn.disabled = true;
    const r = await start({ text, files: newFiles });
    btn.disabled = false;
    if (r.error) return note(r.error);
    $('wkNewText').value = '';
    newFiles = [];
    showNewFiles();
  });

  /** Start a job on the Mac and show it. Returns { job } or { error }. */
  async function start({ text, files = [], link = '' }) {
    const r = await api('/api/jobs', { text, files, link }).catch((err) => ({ error: err.message }));
    if (!r.ok) return { error: r.error || "Couldn't start it." };
    if (!jobs.some((j) => j.id === r.job.id)) jobs.push(r.job); // the live line may have brought it already
    refresh();
    showJob(r.job.id);
    return { job: r.job };
  }

  // Dictate the job ("research…") with the phone's speech recogniser
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let dictating = null;
  $('wkMic').hidden = !Rec;
  $('wkMic').addEventListener('click', () => {
    if (dictating) { dictating.stop(); return; }
    const rec = new Rec();
    const before = $('wkNewText').value.trim();
    rec.lang = 'en-GB';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => { $('wkNewText').value = [before, [...e.results].map((x) => x[0].transcript).join(' ')].filter(Boolean).join(' '); };
    rec.onend = () => { dictating = null; $('wkMic').classList.remove('live'); };
    try { rec.start(); dictating = rec; $('wkMic').classList.add('live'); } catch {}
  });

  function note(text) {
    const s = $('wkStatus') || $('wkNewFiles');
    s.textContent = text;
  }

  // ---- One job, rendered for the phone -------------------------------------------------------------------
  function sources(result) {
    const titles = new Map();
    for (const m of String(result || '').matchAll(/(?<!!)\[([^\]]{2,120})\]\((https?:\/\/[^)\s]+)\)/g)) if ((titles.get(m[2]) || '').length < m[1].length) titles.set(m[2], m[1]);
    const urls = [...new Set([...events.filter((e) => e.url).map((e) => e.url), ...titles.keys()])];
    return urls.slice(0, 40).map((u) => ({ url: u, host: host(u), title: titles.get(u) || host(u) }));
  }
  const chip = (s) => `<a class="source" data-href="${esc(s.url)}"><i>${esc(s.host[0] || '?').toUpperCase()}</i><span>${esc(s.title)}</span><small>${esc(s.host)}</small></a>`;
  const stepLine = (e) => {
    const cls = e.type === 'step' ? `step ${e.kind || ''}` : e.type;
    const text = e.url ? `<a data-href="${esc(e.url)}">${esc(e.text)}</a>` : esc(e.text);
    return `<li class="${cls}"><time>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>${text}</li>`;
  };
  const fileCard = (id, f) => {
    const k = kindOf(f.path);
    const thumb = k === 'img' ? `<img src="${fileUrl(id, f.path)}" alt="" loading="lazy">` : `<b>${esc(ext(f.path).toUpperCase() || 'FILE')}</b>`;
    return `<div class="file-card ${k}" data-preview="${esc(f.path)}"><div class="thumb">${thumb}</div>
      <div class="meta"><span>${esc(f.path.split('/').pop())}</span><small>${size(f.size)}</small></div>
      <a class="icon-btn" href="${fileUrl(id, f.path)}?download=1" download aria-label="Download">↓</a></div>`;
  };

  let rendering = 0;
  async function renderDetail({ fresh = false } = {}) {
    const mine = ++rendering;
    const id = openId;
    const d = await api(`/api/jobs/${encodeURIComponent(id)}`).catch(() => null);
    if (mine !== rendering || id !== openId) return;
    if (!d?.ok) { detail.innerHTML = `<div class="wk-top"><button class="wk-x" data-act="back" aria-label="Back">‹</button><h2>Gone</h2></div><div class="work-empty">That job isn't on the Mac any more.</div>`; return; }
    const { job } = d;
    if (version && version > d.versions) version = null;
    const old = version ? (await api(`/api/jobs/${encodeURIComponent(id)}/version/${version}`)).text : null;
    if (mine !== rendering) return;
    const result = old ?? d.result;
    events = d.events;
    const all = d.files;
    const given = all.filter((f) => f.path.startsWith('inputs/'));
    const files = all.filter((f) => !f.path.startsWith('inputs/'));
    const ORDER = ['doc', 'deck', 'sheet', 'pdf', 'app', 'text'];
    const docs = files.filter((f) => ['doc', 'deck', 'sheet', 'pdf', 'app'].includes(kindOf(f.path)) || ext(f.path) === 'csv')
      .sort((a, b) => ORDER.indexOf(kindOf(a.path)) - ORDER.indexOf(kindOf(b.path)));
    const working = files.filter((f) => !docs.includes(f) && kindOf(f.path) !== 'img');
    const pics = files.filter((f) => kindOf(f.path) === 'img');
    const srcs = sources(result);
    const done = !isActive(job);
    detail.innerHTML = `
      <div class="wk-top"><button class="wk-x" data-act="back" aria-label="Back">‹</button>
        <div class="wk-title"><h2>${esc(job.title)}</h2>
          <div class="job-sub"><span class="chip ${job.status}">${STATUS[job.status]}</span> ${when(job.created)}${job.started ? ` · ${took(job)}` : ''} · ${job.steps} steps${job.turns?.length > 1 ? ` · ${job.turns.length - 1} follow-up${job.turns.length > 2 ? 's' : ''}` : ''}</div></div></div>
      ${job.status === 'approval' && job.approval ? `
        <div class="approval-box"><div><b>Needs your OK:</b> ${esc(job.approval.what)}${job.approval.command ? `<pre class="approval-cmd">${esc(job.approval.command)}</pre>` : ''}</div>
          <div class="approval-btns"><button class="icon-btn yes" data-act="yes" data-at="${job.approval.at}">YES</button><button class="icon-btn" data-act="no" data-at="${job.approval.at}">NO</button></div></div>` : ''}
      ${job.status === 'failed' ? `<div class="approval-box failed">${esc(job.error || 'Failed')}</div>` : ''}
      ${job.project ? `<div class="project-box">
        <b>PHASE</b><span class="phase">${esc(String(job.project.phase || '?').toUpperCase())}${job.project.note ? ` · ${esc(job.project.note)}` : ''}</span>
        <b>TESTS</b><span>${esc(job.project.tests || 'none yet')}</span>
        <b>COMMIT</b><span>${esc(job.project.commit || 'none yet')}</span>
        ${job.project.verified != null ? `<b>VERIFY</b><span class="${job.project.verified ? 'ok' : 'no'}">${job.project.verified ? 'passes the definition of done' : `not yet: ${esc(job.project.verifyNotes || '')}`}</span>` : ''}
        <div class="project-steps">${PHASES.map((ph, i) => `<span class="${i < PHASES.indexOf(job.project.phase) || job.status === 'done' ? 'past' : ph === job.project.phase ? 'on' : ''}">${ph.toUpperCase()}</span>`).join('')}</div>
      </div>` : ''}
      <div class="work-actions">
        ${isActive(job) ? '<button class="icon-btn" data-act="cancel">CANCEL</button>' : ''}
        ${isActive(job) && job.status !== 'queued' ? '<button class="icon-btn" data-act="pause">PAUSE</button>' : ''}
        ${job.status === 'paused' ? '<button class="icon-btn" data-act="resume">RESUME</button>' : ''}
        ${job.project && job.project.run ? '<button class="icon-btn" data-act="run">RUN IT</button>' : ''}
        ${job.project && job.project.url && job.project.running ? `<a class="icon-btn" href="/api/projects/${esc(job.id)}/preview/" target="_blank" rel="noopener">PREVIEW</a>` : ''}
        ${job.project && done ? '<button class="icon-btn" data-act="zip">ZIP + PREVIEW</button>' : ''}
        ${done ? '<button class="icon-btn" data-act="continue">CONTINUE</button>' : ''}
        ${done ? '<button class="icon-btn" data-act="slides">MAKE SLIDES</button>' : ''}
        <button class="icon-btn" data-act="mac">SEND TO MAC</button>
        ${done && !job.dismissed && job.status !== 'cancelled' ? '<button class="icon-btn" data-act="dismiss">DISMISS</button>' : ''}
        <span class="work-status" id="wkStatus"></span>
      </div>
      <form class="continue-box" id="wkContinue" hidden>
        <input id="wkContinueText" autocomplete="off" enterkeyhint="send" placeholder="What should change?" />
        <button class="icon-btn" type="submit">SEND</button>
      </form>
      ${d.versions ? `<div class="versions">Versions: ${Array.from({ length: d.versions }, (_, i) => `<button class="icon-btn${version === i + 1 ? ' active' : ''}" data-ver="${i + 1}">${i + 1}</button>`).join('')}<button class="icon-btn${version ? '' : ' active'}" data-ver="0">LATEST</button></div>` : ''}
      ${version ? `<div class="old-version">Version ${version}, from before “${esc(job.turns?.[version]?.text || 'a follow-up')}”. <a data-ver="0">Back to the latest</a></div>` : ''}
      ${job.turns?.length > 1 ? `<details class="turns"><summary>Brief and follow-ups (${job.turns.length})</summary><ol>${job.turns.map((t, i) => `<li><time>${when(t.at)}</time><b>${i ? 'Follow-up' : 'Brief'}</b> ${esc(t.text.split('\n\nThe user gave you')[0].slice(0, 600))}</li>`).join('')}</ol></details>` : ''}
      ${given.length ? `<div class="working given">Your files: ${given.map((f) => `<a data-preview="${esc(f.path)}">${esc(f.path.slice(7))}</a>`).join(' · ')}</div>` : ''}
      ${docs.length ? `<div class="file-grid">${docs.map((f) => fileCard(id, f)).join('')}</div>` : ''}
      ${working.length ? `<div class="working">Working files: ${working.map((f) => `<a data-preview="${esc(f.path)}">${esc(f.path)}</a>`).join(' · ')}</div>` : ''}
      ${srcs.length ? `<div class="sources">${srcs.slice(0, 6).map(chip).join('')}${srcs.length > 6 ? `<button class="source more" data-more>+${srcs.length - 6} more</button><span class="more-sources" hidden>${srcs.slice(6).map(chip).join('')}</span>` : ''}</div>` : ''}
      <article class="md" id="wkResult"></article>
      ${d.credits?.length ? `<div class="credits">Photos: ${d.credits.map((c) => `<a data-href="${esc(c.profile)}">${esc(c.name)}</a>`).join(', ')} on <a data-href="https://unsplash.com/?utm_source=ARES&amp;utm_medium=referral">Unsplash</a></div>` : ''}
      ${pics.length && !result ? `<div class="file-grid">${pics.map((f) => fileCard(id, f)).join('')}</div>` : ''}
      <details class="progress" ${result ? '' : 'open'}><summary>Progress</summary><ul id="wkSteps">${events.map(stepLine).join('')}</ul></details>`;
    if (fresh) cascade(detail, 120, 8);
    if (result) {
      const art = $('wkResult');
      art.innerHTML = Markdown.render(result, id);
      if (fresh) cascade(art, 280);
      Markdown.enhance(art, id, { theme: 'dark' });
    }
    if (fresh) detail.scrollTop = 0;
    if (done && !job.seen) seen(id);
  }

  /** Opened here: the Mac's badge clears, and so does this phone's notification for it. */
  function seen(id) {
    act(id, 'seen');
    closeNotes([`job-${id}`]);
  }
  async function closeNotes(tags) {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      for (const tag of tags) for (const n of (await reg?.getNotifications({ tag })) || []) n.close();
    } catch {}
  }

  function cascade(root, delay = 0, max = 30) {
    if (reduceMotion) return;
    [...root.children].slice(0, max).forEach((el, i) => { el.style.animationDelay = `${delay + i * 34}ms`; el.classList.add('cascade'); });
  }
  const status = (t) => { const s = $('wkStatus'); if (s) s.textContent = t || ''; };

  detail.addEventListener('click', async (e) => {
    const ver = e.target.closest('[data-ver]');
    if (ver) { version = Number(ver.dataset.ver) || null; return renderDetail(); }
    const a = e.target.closest('[data-href]');
    if (a) { e.preventDefault(); if (EMBED) { location.href = a.dataset.href; return; } return window.open(a.dataset.href, '_blank', 'noopener'); } // the app opens web links in the browser
    if (e.target.closest('a[download]')) return; // the browser downloads it
    const pv = e.target.closest('[data-preview], [data-file]');
    if (pv) return preview(pv.dataset.preview || pv.dataset.file);
    const more = e.target.closest('[data-more]');
    if (more) { more.nextElementSibling.hidden = false; more.nextElementSibling.style.display = 'contents'; more.remove(); return; }
    const full = e.target.closest('[data-app-full]');
    if (full) {
      const box = full.closest('.md-app');
      box.classList.toggle('full');
      full.textContent = box.classList.contains('full') ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
      return;
    }
    const btn = e.target.closest('[data-act]');
    const what = btn?.dataset.act;
    if (!what) return;
    if (what === 'back') return back();
    if (what === 'continue') {
      const box = $('wkContinue');
      box.hidden = !box.hidden;
      if (!box.hidden) $('wkContinueText').focus();
      return;
    }
    btn.disabled = true;
    let r = {};
    if (what === 'yes' || what === 'no') r = await act(openId, 'answer', { yes: what === 'yes', at: Number(btn.dataset.at) });
    if (what === 'cancel') r = await act(openId, 'cancel');
    if (what === 'pause') r = await autoAct('project/control', { project: openId, action: 'pause' });
    if (what === 'resume') r = await autoAct('resume', { what: openId }).then((x) => (x.message ? { said: x.message } : x));
    if (what === 'run') r = await autoAct('project/control', { project: openId, action: 'run' }).then((x) => ({ said: x.message }));
    if (what === 'zip') r = await autoAct('project/control', { project: openId, action: 'send_to_phone' }).then((x) => ({ said: x.message }));
    if (what === 'dismiss') { r = await act(openId, 'dismiss'); if (!r.error) return close(); }
    if (what === 'mac') { r = await act(openId, 'send-to-mac'); if (!r.error) r.said = r.now ? 'Open on your Mac now' : "It'll open on your Mac when you're back at it"; }
    if (what === 'slides') {
      r = await act(openId, 'continue', { text: 'Turn this result into a polished slide deck (.pptx) using the pptx skill: a title slide, one idea per slide, the key charts and images, and a sources slide. Save it in the folder and link it from result.md.' });
      if (!r.error) r.said = 'Making slides…';
    }
    btn.disabled = false;
    status(r.error || r.said || '');
  });
  detail.addEventListener('submit', async (e) => {
    if (e.target.id !== 'wkContinue') return;
    e.preventDefault();
    const text = $('wkContinueText').value.trim();
    if (!text) return;
    const r = await act(openId, 'continue', { text });
    status(r.error || 'Follow-up sent');
    if (!r.error) { $('wkContinueText').value = ''; e.target.hidden = true; }
  });

  // ---- File preview: pictures, document pages (made on the Mac), mini-apps, text --------------------------
  const overlay = $('wkPreview');
  async function preview(p) {
    const id = openId;
    const k = kindOf(p);
    const url = fileUrl(id, p);
    const body = overlay.querySelector('.pv-body');
    overlay.querySelector('.pv-title').textContent = p.split('/').pop();
    overlay.querySelector('[data-pv-dl]').href = `${url}?download=1`;
    overlay.hidden = false;
    body.innerHTML = '<div class="pv-wait">Preparing preview…</div>';
    if (k === 'img') body.innerHTML = `<img src="${url}" alt="">`;
    else if (k === 'app') body.innerHTML = `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${url}"></iframe>`;
    else if (k === 'text') {
      const text = await fetch(url).then((r) => r.text()).catch(() => '');
      body.innerHTML = ext(p) === 'md' ? `<article class="md">${Markdown.render(text, id)}</article>` : `<pre class="md-code"><code>${esc(text.slice(0, 200000))}</code></pre>`;
      if (ext(p) === 'md') Markdown.enhance(body, id);
    } else if (['pdf', 'doc', 'deck', 'sheet'].includes(k)) {
      const pv = await api(`/api/jobs/${encodeURIComponent(id)}/preview/${p.split('/').map(encodeURIComponent).join('/')}`).catch(() => null);
      if (overlay.hidden || overlay.querySelector('.pv-title').textContent !== p.split('/').pop()) return;
      if (pv?.pages?.length) {
        body.innerHTML = `<div class="pv-pages">${pv.pages.map((pg, i) => `<img src="${fileUrl(id, pg)}" alt="Page ${i + 1}" loading="lazy">`).join('')}${
          pv.total > pv.pages.length ? `<div class="pv-wait">The first ${pv.pages.length} of ${pv.total} pages. Download it for the rest.</div>` : ''}</div>`;
      } else body.innerHTML = `<div class="pv-wait">${esc(pv?.error || 'No preview for this file.')}</div>`;
    } else body.innerHTML = '<div class="pv-wait">No preview for this kind of file. Download it to open it.</div>';
  }
  const closePreview = () => { overlay.hidden = true; overlay.querySelector('.pv-body').innerHTML = ''; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-pv-close]')) closePreview(); });

  // ---- Opening and closing: the sheet grows out of the job's orb (or the WORK button), and folds back ------
  const buttonPoint = () => { const r = $('workBtn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);
  const settle = () => sheet.getAnimations().forEach((a) => a.cancel());
  function grow(from) {
    settle();
    if (reduceMotion) return sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    sheet.style.transformOrigin = `${from.x}px ${from.y}px`;
    return sheet.animate([
      { transform: 'scale(0.02)', opacity: 0, borderRadius: '50%' },
      { opacity: 1, offset: 0.22 },
      { transform: 'scale(1.014)', borderRadius: '14px', offset: 0.76 },
      { transform: 'scale(1)', opacity: 1, borderRadius: '0px' },
    ], { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
  }
  function fold(into) {
    settle();
    if (reduceMotion) return sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
    sheet.style.transformOrigin = `${into.x}px ${into.y}px`;
    return sheet.animate([
      { transform: 'scale(1)', opacity: 1, borderRadius: '0px' },
      { transform: 'scale(1.01)', offset: 0.15 },
      { opacity: 1, offset: 0.7 },
      { transform: 'scale(0.02)', opacity: 0, borderRadius: '50%' },
    ], { duration: 320, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
  }

  let opening = 0;
  let closing = false;
  const isOpen = () => !sheet.hidden && !closing;
  /** Show the Work list (from the WORK button). */
  async function openList() {
    openId = null;
    detail.hidden = true;
    listView.hidden = false;
    if (isOpen()) return refresh();
    closing = false;
    sheet.hidden = false;
    hideBehind(grow(buttonPoint()));
    load();
  }
  /** Show one job: from its orb if it has one, otherwise from the button (or in place when already open). */
  async function showJob(id) {
    closePreview();
    const was = openId;
    if (id !== openId) version = null;
    openId = id;
    listView.hidden = true;
    detail.hidden = false;
    if (isOpen()) {
      if (was !== id) { orbs()?.park(id); detail.scrollTop = 0; }
      return renderDetail({ fresh: was !== id });
    }
    const mine = ++opening;
    closing = false;
    renderDetail({ fresh: true });
    const from = (orbs()?.has(id) && await within(orbs().launch(id), 800)) || buttonPoint();
    if (mine !== opening) return;
    sheet.hidden = false;
    hideBehind(grow(from));
  }
  /** Once the sheet covers the screen, stop drawing the chat underneath it (the brain is the orbs' home: it's back for the fold). */
  const hideBehind = (anim) => within(anim.finished, 700).then(() => { if (isOpen()) document.body.classList.add('work-open'); });
  async function close() {
    if (EMBED) return handBack();
    if (!isOpen()) return;
    closing = true;
    opening++;
    closePreview();
    const id = openId;
    document.body.classList.remove('work-open');
    const into = (id && orbs()?.has(id) && orbs().screenPos(id)) || buttonPoint();
    await within(fold(into).finished, 700);
    if (!closing) return;
    closing = false;
    sheet.hidden = true;
    settle();
    orbs()?.land(id);
    openId = null;
  }
  /** Back: preview → job → list → closed. */
  function back() {
    if (!overlay.hidden) return closePreview();
    const box = detail.querySelector('.md-app.full');
    if (box) { box.classList.remove('full'); return; }
    if (EMBED && (embedStart === 'job' || detail.hidden)) return handBack();
    if (!detail.hidden) {
      orbs()?.land(openId);
      openId = null;
      detail.hidden = true;
      listView.hidden = false;
      return refresh();
    }
    close();
  }

  $('workBtn').addEventListener('click', () => (isOpen() ? close() : openList()));
  window.addEventListener('orb-open', (e) => showJob(e.detail));
  window.addEventListener('orbs-ready', () => { orbs().reduceMotion = reduceMotion; orbs().sync(jobs); });
  // The phone's Back gesture steps back through the sheet instead of leaving the app
  if (!EMBED) {
    window.addEventListener('popstate', () => { if (isOpen()) { back(); if (isOpen()) history.pushState({ work: 1 }, ''); } });
    const observer = new MutationObserver(() => { if (!sheet.hidden && history.state?.work !== 1) history.pushState({ work: 1 }, ''); });
    observer.observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ---- Live from the Mac: job progress, seen elsewhere, "send this to my phone" --------------------------
  function onLive(m) {
    if (m.type === 'job') {
      const i = jobs.findIndex((j) => j.id === m.job.id);
      const was = i >= 0 ? jobs[i] : null;
      if (i >= 0) jobs[i] = m.job; else jobs.push(m.job);
      refresh();
      if (isOpen() && m.job.id === openId && !detail.hidden && (was?.status !== m.job.status || was?.approval?.at !== m.job.approval?.at || was?.dismissed !== m.job.dismissed)) renderDetail();
    } else if (m.type === 'job-event') {
      if (!isOpen() || m.id !== openId || detail.hidden) return;
      const ul = $('wkSteps');
      if (ul && m.evt.type !== 'done' && m.evt.type !== 'approval') ul.insertAdjacentHTML('beforeend', stepLine(m.evt));
    } else if (m.type === 'autonomy') {
      auto = m.state;
      refresh();
    } else if (m.type === 'job-removed') {
      jobs = jobs.filter((j) => j.id !== m.id);
      if (openId === m.id && isOpen()) back();
      refresh();
    } else if (m.type === 'clear') {
      closeNotes(m.tags);
    } else if (m.type === 'show-job') {
      if (document.visibilityState === 'visible') { showJob(m.id); closeNotes([`job-${m.id}`]); }
    }
  }
  let live = null;
  async function connect() {
    if (live) return;
    const ctrl = new AbortController();
    live = ctrl;
    let backoff = 2000;
    while (live === ctrl) {
      try {
        const res = await fetch('/api/events?web=1', { credentials: 'same-origin', signal: ctrl.signal });
        if (res.status === 401) { live = null; return showPair(); }
        backoff = 2000;
        load(); // catch up on anything missed while the line was down
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line) try { onLive(JSON.parse(line)); } catch {}
          }
        }
      } catch {}
      if (live !== ctrl) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
  // Phones suspend background pages: drop the line when hidden, pick it up (and catch up) when back
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { live?.abort(); live = null; }
    else if ($('app').hidden === false) connect();
  });
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'open-job') showJob(e.data.id); });

  /** Called once the phone is known to be paired. */
  function boot({ reduceMotion: rm } = {}) {
    reduceMotion = Boolean(rm) || reduceMotion || EMBED;
    if (orbs()) orbs().reduceMotion = reduceMotion;
    $('workBtn').hidden = false;
    load();
    connect();
    const q = new URLSearchParams(location.search);
    if (EMBED) {
      embedStart = q.get('job') ? 'job' : 'list';
      if (q.get('job')) showJob(q.get('job'));
      else { if (q.get('work') === 'gallery') view = 'gallery'; if (['projects', 'goals', 'routines'].includes(q.get('work'))) mode = q.get('work'); openList(); }
      return;
    }
    if (q.get('job')) { const id = q.get('job'); history.replaceState(null, '', '/'); setTimeout(() => showJob(id), 300); }
    else if (q.has('work')) { history.replaceState(null, '', '/'); openList(); }
  }

  return { boot, start, showJob, openList, close, back, get isOpen() { return isOpen(); } };
})();
