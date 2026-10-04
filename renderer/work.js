// The Work panel: background jobs (jobs.js in the main process), their live progress, and their results,
// rendered richly (markdown.js): charts, diagrams, images, file previews, mini-apps, and actions.
const Work = (() => {
  const $ = (id) => document.getElementById(id);
  const panel = $('work');
  const list = $('jobList');
  const detail = $('jobDetail');
  const esc = Markdown.esc;
  let jobs = [];
  let openId = null;
  let events = [];
  let files = [];
  let fresh = false; // the next render is the panel opening, so its rows cascade in
  let view = 'job';     // 'job' (one job's results) or 'gallery' (every past job as a card)
  let filter = null;    // ids matching the search box, or null for all
  let version = null;   // an earlier version of the open job's result being viewed, or null for the latest
  let focused = null;   // what "show me the chart" last pointed at, for "make it bigger"

  const STATUS = { queued: 'QUEUED', running: 'WORKING', approval: 'NEEDS YOUR OK', done: 'DONE', failed: 'FAILED', cancelled: 'CANCELLED' };
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
    html: 'app', htm: 'app', md: 'text', txt: 'text', json: 'text', py: 'text', js: 'text' };
  const kindOf = (p) => KIND[ext(p)] || 'file';
  const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

  function badge() {
    const active = jobs.filter(isActive).length;
    const unseen = jobs.filter((j) => !isActive(j) && !j.seen && j.status !== 'cancelled').length;
    $('workCount').textContent = active || unseen || '';
    $('workBtn').classList.toggle('busy', active > 0);
    $('workBtn').classList.toggle('attention', jobs.some((j) => j.status === 'approval') || (unseen > 0 && !active));
  }

  function renderList() {
    const shown = jobs.filter((j) => !filter || filter.has(j.id));
    list.innerHTML = shown.length ? '' : jobs.length ? '<li class="empty">Nothing matches that.</li>'
      : '<li class="empty">No jobs yet. Ask ARES to research, write or analyse something, say "do this as a job", or drop files here.</li>';
    $('galleryBtn').classList.toggle('active', view === 'gallery');
    for (const j of [...shown].reverse()) {
      const li = document.createElement('li');
      li.className = `job ${j.status}${j.id === openId && view === 'job' ? ' open' : ''}${!j.seen && !isActive(j) ? ' unseen' : ''}`;
      li.innerHTML = `<span class="job-dot"></span><span class="job-title">${esc(j.title)}</span><span class="job-meta">${STATUS[j.status]} · ${when(j.created)}</span>`;
      li.onclick = () => show(j.id);
      list.appendChild(li);
    }
    badge();
    orbs()?.sync(jobs);
  }

  const stepLine = (e) => {
    const cls = e.type === 'step' ? `step ${e.kind || ''}` : e.type;
    const text = e.url ? `<a data-href="${esc(e.url)}" title="${esc(e.url)}">${esc(e.text)}</a>` : esc(e.text);
    return `<li class="${cls}"><time>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>${text}</li>`;
  };

  /** Sources: pages the worker read, titled by the result's own links where it cites them. */
  function sources(result) {
    const titles = new Map();
    // The fullest name the result gives a link (its Sources list usually beats an inline "source")
    for (const m of String(result || '').matchAll(/(?<!!)\[([^\]]{2,120})\]\((https?:\/\/[^)\s]+)\)/g)) if ((titles.get(m[2]) || '').length < m[1].length) titles.set(m[2], m[1]);
    const urls = [...new Set([...events.filter((e) => e.url).map((e) => e.url), ...titles.keys()])];
    return urls.slice(0, 40).map((u) => ({ url: u, host: host(u), title: titles.get(u) || host(u) }));
  }
  const chip = (s) => `<a class="source" data-href="${esc(s.url)}" title="${esc(s.url)}"><i>${esc(s.host[0] || '?').toUpperCase()}</i><span>${esc(s.title)}</span><small>${esc(s.host)}</small></a>`;

  const fileCard = (f) => {
    const k = kindOf(f.path);
    const thumb = k === 'img' ? `<img src="${Markdown.fileUrl(openId, f.path)}" alt="" loading="lazy">` : `<b>${esc(ext(f.path).toUpperCase() || 'FILE')}</b>`;
    return `<div class="file-card ${k}" data-preview="${esc(f.path)}" title="${esc(f.path)}"><div class="thumb">${thumb}</div>
      <div class="meta"><span>${esc(f.path.split('/').pop())}</span><small>${size(f.size)}</small></div>
      <button class="icon-btn" data-openfile="${esc(f.path)}" title="Open in its app">OPEN</button></div>`;
  };

  async function renderDetail() {
    unzoom();
    focused = null;
    if (view === 'gallery') return renderGallery();
    if (!openId) { detail.innerHTML = '<div class="work-empty">Pick a job.</div>'; return; }
    const d = await window.ares.work.detail(openId);
    if (!d) { openId = null; return renderDetail(); }
    const { job } = d;
    if (version && version > d.versions) version = null;
    const old = version ? await window.ares.work.version(job.id, version) : null;
    const result = old ?? d.result;
    events = d.events;
    files = d.files;
    const srcs = sources(result);
    const done = !isActive(job);
    // Deliverables first (documents, decks, sheets, PDFs, apps); the worker's scripts and data fold into one row
    const DELIVER = new Set(['doc', 'deck', 'sheet', 'pdf', 'app']);
    const given = files.filter((f) => f.path.startsWith('inputs/'));
    files = files.filter((f) => !f.path.startsWith('inputs/'));
    const docs = files.filter((f) => DELIVER.has(kindOf(f.path)) || (ext(f.path) === 'csv'))
      .sort((a, b) => ['doc', 'deck', 'sheet', 'pdf', 'app', 'text'].indexOf(kindOf(a.path)) - ['doc', 'deck', 'sheet', 'pdf', 'app', 'text'].indexOf(kindOf(b.path)));
    const working = files.filter((f) => !docs.includes(f) && kindOf(f.path) !== 'img');
    const pics = files.filter((f) => kindOf(f.path) === 'img');
    detail.innerHTML = `
      <header class="job-head">
        <div><h2>${esc(job.title)}</h2>
          <div class="job-sub"><span class="chip ${job.status}">${STATUS[job.status]}</span> ${when(job.created)}${job.started ? ` · ${took(job)}` : ''} · ${job.steps} steps${job.turns?.length > 1 ? ` · ${job.turns.length - 1} follow-up${job.turns.length > 2 ? 's' : ''}` : ''}</div></div>
      </header>
      <div class="work-actions">
        ${isActive(job) ? '<button class="icon-btn" data-act="cancel">CANCEL</button>' : ''}
        ${result && done ? '<button class="icon-btn" data-act="pdf">SAVE AS PDF</button>' : ''}
        ${done ? '<button class="icon-btn" data-act="slides">MAKE SLIDES</button>' : ''}
        ${done ? '<button class="icon-btn" data-act="continue">CONTINUE</button>' : ''}
        <button class="icon-btn" data-act="folder">OPEN FOLDER</button>
        ${done && !job.dismissed && job.status !== 'cancelled' ? '<button class="icon-btn" data-act="dismiss" title="Put it away: the orb sinks into the brain, and the job stays in this list">DISMISS</button>' : ''}
        <button class="icon-btn" data-act="phone" title="A notification on your phone, with an Open button">SEND TO PHONE</button>
        ${done ? '<button class="icon-btn danger" data-act="delete" title="Delete this job and its files (they go to the Trash)">DELETE</button>' : ''}
        <span class="work-status" id="workStatus"></span>
      </div>
      <form class="continue-box" id="continueBox" hidden>
        <input id="continueText" autocomplete="off" spellcheck="true" placeholder="What should change? e.g. make the intro shorter, add pricing…" />
        <button class="icon-btn" type="submit">SEND</button>
      </form>
      ${d.versions ? `<div class="versions">Versions: ${Array.from({ length: d.versions }, (_, i) => `<button class="icon-btn${version === i + 1 ? ' active' : ''}" data-ver="${i + 1}" title="Before: ${esc(job.turns?.[i + 1]?.text || '')}">${i + 1}</button>`).join('')}<button class="icon-btn${version ? '' : ' active'}" data-ver="0">LATEST</button></div>` : ''}
      ${version ? `<div class="old-version">You're looking at version ${version}, from before “${esc(job.turns?.[version]?.text || 'a follow-up')}”. <a data-ver="0">Back to the latest</a></div>` : ''}
      ${job.turns?.length > 1 ? `<details class="turns"><summary>Brief and follow-ups (${job.turns.length})</summary><ol>${job.turns.map((t, i) => `<li><time>${when(t.at)}</time><b>${i ? 'Follow-up' : 'Brief'}</b> ${esc(t.text.split('\n\nThe user gave you')[0].slice(0, 600))}</li>`).join('')}</ol></details>` : ''}
      ${given.length ? `<div class="working given">Your files: ${given.map((f) => `<a data-preview="${esc(f.path)}" title="${esc(f.path)}">${esc(f.path.slice(7))}</a>`).join(' · ')}</div>` : ''}
      ${job.status === 'approval' && job.approval ? `
        <div class="approval-box"><div><b>Needs your OK:</b> ${esc(job.approval.what)}${job.approval.command ? `<pre class="approval-cmd">${esc(job.approval.command)}</pre>` : ''}</div>
          <div><button class="icon-btn yes" data-act="yes">YES</button><button class="icon-btn" data-act="no">NO</button></div></div>` : ''}
      ${job.status === 'failed' ? `<div class="approval-box failed">${esc(job.error || 'Failed')}</div>` : ''}
      ${docs.length ? `<div class="file-grid">${docs.map(fileCard).join('')}</div>` : ''}
      ${working.length ? `<div class="working">Working files: ${working.map((f) => `<a data-preview="${esc(f.path)}" title="${esc(f.path)}">${esc(f.path)}</a>`).join(' · ')}</div>` : ''}
      ${srcs.length ? `<div class="sources">${srcs.slice(0, 8).map(chip).join('')}${srcs.length > 8 ? `<button class="source more" data-more>+${srcs.length - 8} more</button><span class="more-sources" hidden>${srcs.slice(8).map(chip).join('')}</span>` : ''}</div>` : ''}
      <article class="md" id="jobResult"></article>
      ${d.credits?.length ? `<div class="credits">Photos: ${d.credits.map((c) => `<a data-href="${esc(c.profile)}">${esc(c.name)}</a>`).join(', ')} on <a data-href="https://unsplash.com/?utm_source=ARES&amp;utm_medium=referral">Unsplash</a></div>` : ''}
      ${pics.length && !result ? `<div class="file-grid">${pics.map(fileCard).join('')}</div>` : ''}
      <details class="progress" ${result ? '' : 'open'}><summary>Progress</summary><ul id="jobSteps">${events.map(stepLine).join('')}</ul></details>`;
    const art = $('jobResult');
    const opened = fresh;
    fresh = false;
    if (opened) cascade(detail, 120, 8);
    if (result) {
      art.innerHTML = Markdown.render(result, job.id);
      cascade(art, opened ? 300 : 0);
      Markdown.enhance(art, job.id, { theme: 'dark' }).then(() => { if (openId === job.id) detail.scrollTop = 0; });
    }
    detail.scrollTop = 0;
    if (done && !job.seen) window.ares.work.seen(job.id);
    if (typeof Drop !== 'undefined' && Drop.pending) Drop.refresh();
  }

  // ---- Gallery: every past job as a card, searchable ------------------------------------------------
  async function renderGallery() {
    const cards = await window.ares.work.gallery();
    if (view !== 'gallery') return;
    const byId = new Map(cards.map((c) => [c.id, c]));
    const shown = [...jobs].reverse().filter((j) => !filter || filter.has(j.id));
    const q = $('workSearch').value.trim();
    detail.innerHTML = `
      <header class="job-head"><div><h2>Gallery</h2><div class="job-sub">${shown.length} of ${jobs.length} job${jobs.length === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}</div></div></header>
      <div class="gallery">${shown.map((j) => {
        const c = byId.get(j.id) || {};
        const thumb = c.thumb ? `<img src="${Markdown.fileUrl(j.id, c.thumb)}" alt="" loading="lazy">` : `<span>${esc((c.kinds?.[0] || j.title[0] || '?').toUpperCase())}</span>`;
        return `<div class="g-card ${j.status}${j.dismissed ? ' dismissed' : ''}" data-job="${esc(j.id)}" tabindex="0">
          <div class="g-thumb">${thumb}</div>
          <div class="g-body"><b>${esc(j.title)}</b><small><i class="g-dot"></i>${STATUS[j.status]} · ${when(j.created)}</small>
            <p>${esc(c.snippet || j.summary || j.task || '')}</p>
            ${c.kinds?.length ? `<div class="g-kinds">${c.kinds.map((k) => `<em>${esc(k.toUpperCase())}</em>`).join('')}</div>` : ''}</div></div>`;
      }).join('') || '<div class="work-empty">Nothing matches that.</div>'}</div>`;
    const opened = fresh;
    fresh = false;
    cascade(detail.querySelector('.gallery'), opened ? 200 : 0, 24);
    detail.scrollTop = 0;
  }

  /** Show one job in the open panel (or open the panel on it). */
  function show(id) {
    view = 'job';
    if (id !== openId) version = null;
    if (!panel.hidden && !closing && id === openId) { renderList(); return renderDetail(); }
    return open(id);
  }
  function showGallery() {
    view = 'gallery';
    if (panel.hidden || closing) return open(openId, { gallery: true });
    orbs()?.land(openId);
    renderList();
    renderDetail();
  }

  let searchTimer = null;
  $('workSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('workSearch').value.trim();
      filter = q ? new Set(await window.ares.work.search(q)) : null;
      renderList();
      if (view === 'gallery') renderDetail();
    }, 140);
  });
  $('galleryBtn').addEventListener('click', () => (view === 'gallery' ? show(openId) : showGallery()));

  /** Rows arrive one after another (the panel's content "cascades" in). */
  function cascade(root, delay = 0, max = 40) {
    if (reduceMotion) return;
    [...root.children].slice(0, max).forEach((el, i) => { el.style.animationDelay = `${delay + i * 34}ms`; el.classList.add('cascade'); });
  }

  const status = (t) => { const s = $('workStatus'); if (s) s.textContent = t || ''; };

  // ---- Preview overlay ------------------------------------------------------------------------------
  const overlay = $('workPreview');
  async function preview(p) {
    const k = kindOf(p);
    const url = Markdown.fileUrl(openId, p);
    const body = overlay.querySelector('.pv-body');
    overlay.querySelector('.pv-title').textContent = p;
    overlay.querySelector('[data-pv-open]').dataset.openfile = p;
    overlay.hidden = false;
    body.innerHTML = '<div class="pv-wait">Preparing preview…</div>';
    if (k === 'img') body.innerHTML = `<img src="${url}" alt="">`;
    else if (k === 'app') body.innerHTML = `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${url}"></iframe>`;
    else if (k === 'text') {
      const text = await fetch(url).then((r) => r.text()).catch(() => '');
      body.innerHTML = ext(p) === 'md' ? `<article class="md">${Markdown.render(text, openId)}</article>` : `<pre class="md-code"><code>${esc(text.slice(0, 200000))}</code></pre>`;
      if (ext(p) === 'md') Markdown.enhance(body, openId);
    } else if (k === 'pdf' || k === 'doc' || k === 'deck' || k === 'sheet') {
      const pv = await window.ares.work.preview(openId, p);
      if (overlay.hidden || overlay.querySelector('.pv-title').textContent !== p) return; // closed or switched meanwhile
      if (pv?.pages?.length) {
        body.innerHTML = `<div class="pv-pages">${pv.pages.map((pg, i) => `<img src="${Markdown.fileUrl(openId, pg)}" alt="Page ${i + 1}" loading="lazy">`).join('')}${
          pv.total > pv.pages.length ? `<div class="pv-wait">Showing the first ${pv.pages.length} of ${pv.total} pages. Open it in its app for the rest.</div>` : ''}</div>`;
      } else body.innerHTML = `<div class="pv-wait">${esc(pv?.error || 'No preview for this file.')}</div>`;
    } else body.innerHTML = '<div class="pv-wait">No preview for this kind of file. Open it in its app.</div>';
  }
  const closePreview = () => { overlay.hidden = true; overlay.querySelector('.pv-body').innerHTML = ''; };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-pv-close]')) return closePreview();
    const o = e.target.closest('[data-openfile]');
    if (o) window.ares.work.open(openId, o.dataset.openfile);
  });

  // ---- Clicks -----------------------------------------------------------------------------------------
  detail.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-job]');
    if (card) return show(card.dataset.job);
    const ver = e.target.closest('[data-ver]');
    if (ver) { version = Number(ver.dataset.ver) || null; return renderDetail(); }
    const a = e.target.closest('[data-href]');
    if (a) { e.preventDefault(); return window.ares.openExternal(a.dataset.href); }
    const o = e.target.closest('[data-openfile]');
    if (o) { e.stopPropagation(); return window.ares.work.open(openId, o.dataset.openfile); }
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
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') window.ares.work.cancel(openId);
    if (act === 'folder') window.ares.work.open(openId);
    if (act === 'dismiss') close({ dismiss: true });
    if (act === 'delete') {
      const r = await window.ares.work.delete(openId);
      if (r?.error) status(r.error);
    }
    if (act === 'yes' || act === 'no') window.ares.work.answer(openId, act === 'yes');
    if (act === 'phone') {
      const r = await window.ares.work.sendToPhone(openId);
      status(r?.error ? r.error : 'Sent to your phone');
    }
    if (act === 'pdf') {
      status('Making the PDF…');
      const r = await window.ares.work.savePdf(openId);
      status(r?.file ? `Saved ${r.file}` : `PDF failed: ${r?.error || 'unknown error'}`);
    }
    if (act === 'slides') {
      const r = await window.ares.work.continue(openId, 'Turn this result into a polished slide deck (.pptx) using the pptx skill: a title slide, one idea per slide, the key charts and images, and a sources slide. Save it in the folder and link it from result.md.');
      status(r?.error ? r.error : 'Making slides…');
    }
    if (act === 'continue') {
      const box = $('continueBox');
      box.hidden = !box.hidden;
      if (!box.hidden) $('continueText').focus();
    }
  });
  detail.addEventListener('submit', async (e) => {
    if (e.target.id !== 'continueBox') return;
    e.preventDefault();
    const text = $('continueText').value.trim();
    if (!text) return;
    const r = await window.ares.work.continue(openId, text);
    status(r?.error ? r.error : 'Follow-up sent');
    if (!r?.error) { $('continueText').value = ''; e.target.hidden = true; }
  });


  // ---- Zoom: "make it bigger" on a chart, diagram, table, picture or mini-app ----------------------------
  let zoomed = null;
  function zoom(el) {
    unzoom();
    if (el.matches('.md-app')) { el.classList.add('full'); el.querySelector('[data-app-full]').textContent = 'EXIT FULLSCREEN'; zoomed = el; return; }
    zoomed = el;
    el.classList.add('zoomed');
    const back = document.createElement('div');
    back.className = 'zoom-backdrop';
    back.onclick = unzoom;
    panel.appendChild(back);
    window.dispatchEvent(new Event('resize')); // charts refit their new size
  }
  function unzoom() {
    if (!zoomed) return false;
    if (zoomed.matches('.md-app')) { zoomed.classList.remove('full'); const b = zoomed.querySelector('[data-app-full]'); if (b) b.textContent = 'FULLSCREEN'; }
    zoomed.classList.remove('zoomed');
    panel.querySelector('.zoom-backdrop')?.remove();
    zoomed = null;
    window.dispatchEvent(new Event('resize'));
    return true;
  }

  /** Esc and "go back": one step back at a time, and finally close. */
  function back() {
    if (unzoom()) return 'unzoom';
    const full = detail.querySelector('.md-app.full');
    if (full) { full.classList.remove('full'); full.querySelector('[data-app-full]').textContent = 'FULLSCREEN'; return 'unzoom'; }
    if (!overlay.hidden) { closePreview(); return 'preview'; }
    if (version) { version = null; renderDetail(); return 'version'; }
    close();
    return 'close';
  }

  // ---- Voice control while the panel is open ("show me the chart", "open the second source"…) ------------
  const ORD = { first: 1, one: 1, '1st': 1, second: 2, two: 2, '2nd': 2, third: 3, three: 3, '3rd': 3, fourth: 4, four: 4, '4th': 4,
    fifth: 5, five: 5, '5th': 5, sixth: 6, six: 6, '6th': 6, seventh: 7, seven: 7, eighth: 8, eight: 8, ninth: 9, nine: 9, tenth: 10, ten: 10, last: -1, final: -1 };
  const ORDS = Object.keys(ORD).join('|');
  const nth = (arr, n) => (n === -1 ? arr[arr.length - 1] : arr[(n || 1) - 1]);
  const ordinal = (w) => (w ? ORD[w] ?? (Number(w) || 1) : 1);
  const PARTS = [
    [/^(charts?|graphs?|plots?)$/, '.md-chart', 'chart'],
    [/^(diagrams?|flow ?charts?|mermaid|mind ?maps?|timelines?)$/, '.md-mermaid', 'diagram'],
    [/^tables?$/, '.md .md-table, .md > table', 'table'],
    [/^(images?|pictures?|photos?|screenshots?|screens?|maps?)$/, '.md figure, .md p > img', 'picture'],
    [/^(apps?|mini ?apps?|calculators?|tools?|widgets?)$/, '.md-app', 'mini-app'],
    [/^(sources?|links?|references?)$/, '.sources', 'sources'],
    [/^(files?|documents?|deliverables?|downloads?)$/, '.file-grid', 'files'],
    [/^(progress|steps|log)$/, '.progress', 'progress'],
    [/^(versions?)$/, '.versions', 'versions'],
  ];
  const FILEKIND = [
    [/^(deck|slides?|slide deck|presentation|power ?point|keynote)$/, ['deck']],
    [/^(doc|document|word( doc(ument)?)?|report|write ?up)$/, ['doc']],
    [/^(spreadsheet|excel|sheet|workbook|numbers|csv)$/, ['sheet', 'text']],
    [/^(pdf)$/, ['pdf']],
    [/^(file|attachment)$/, ['doc', 'deck', 'sheet', 'pdf', 'app']],
  ];
  function flash(el) {
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    el.classList.remove('voice-focus');
    void el.offsetWidth;
    el.classList.add('voice-focus');
    setTimeout(() => el.classList.remove('voice-focus'), 1800);
    focused = el;
  }
  const matchJob = (name) => {
    const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !/^(the|my|that|this|about|for|on|with|job|one)$/.test(w));
    if (!words.length) return null;
    let best = null, bestScore = 0;
    for (const j of [...jobs].reverse()) {
      const t = `${j.title} ${j.task}`.toLowerCase();
      const title = j.title.toLowerCase();
      const score = words.reduce((n, w) => n + (title.includes(w) ? 2 : t.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { best = j; bestScore = score; }
    }
    return bestScore >= Math.max(2, words.length) ? best : null;
  };

  /**
   * A spoken or typed command about the Work panel, handled right here without the brain. Returns
   * { reply } when it was one ('' = done silently), or null to let the brain have it.
   */
  function command(raw) {
    const t = String(raw).toLowerCase().replace(/[“”"!?.,]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(hey )?ares /, '').replace(/^(ok(ay)?|right|now|so) /, '').replace(/^(please |can you |could you |would you |will you )+/, '').replace(/ please$/, '').trim();
    const isOpen = !panel.hidden && !closing;
    let m;
    // These work with the panel closed too
    if (/^(show( me)?|open|pull up|bring up|let me see|go to) (the |my )?(work )?(gallery|all (of )?(my )?(work|jobs|results)|past (work|jobs)|my work|previous (work|jobs))$/.test(t)) { showGallery(); return { reply: '' }; }
    if ((m = t.match(/^(show( me)?|open|pull up|bring up|let me see) (the |my |that )?(.+?) (job|research|report|results?|work|analysis|comparison|deck|document)$/)) && !/^(it|this|that)$/.test(m[4])) {
      const j = matchJob(m[4]);
      if (j) { show(j.id); return { reply: '' }; }
      if (!isOpen) return null; // the brain can work out a vaguer one (show_job)
    }
    if (!isOpen) return null;

    if (/^(close|hide) (this|that|it|the (panel|results?|work|job|gallery))$|^close( work)?$|^put (it|this|that) away$|^(i'?m )?done with (this|that|it)$/.test(t)) { close(); return { reply: '' }; }
    if (/^dismiss (this|that|it|the job)$/.test(t)) {
      const j = jobs.find((x) => x.id === openId);
      if (view !== 'job' || !j || isActive(j)) return { reply: "That one's still going, sir." };
      close({ dismiss: true });
      return { reply: '' };
    }
    if (/^(go )?back$|^go back (a step|one)$|^never ?mind$/.test(t)) { back(); return { reply: '' }; }
    if (/^send (this|that|it|the (job|results?|report))( over)? to (my )?(phone|mobile)$/.test(t)) {
      if (view !== 'job' || !openId) return { reply: 'Open the job you want to send first, sir.' };
      window.ares.work.sendToPhone(openId).then((r) => status(r?.error ? r.error : 'Sent to your phone'));
      return { reply: 'Sent to your phone.' };
    }
    if ((m = t.match(/^(scroll|page|go) (down|up)( a bit| more)?$|^(down|up)$/))) {
      const dir = m[2] || m[4];
      detail.scrollBy({ top: (dir === 'down' ? 1 : -1) * detail.clientHeight * 0.8, behavior: reduceMotion ? 'auto' : 'smooth' });
      return { reply: '' };
    }
    if (/^(go to |scroll to |back to )?(the )?top$/.test(t)) { detail.scrollTo({ top: 0, behavior: 'smooth' }); return { reply: '' }; }
    if (/^(go to |scroll to )?(the )?(bottom|end)$/.test(t)) { detail.scrollTo({ top: detail.scrollHeight, behavior: 'smooth' }); return { reply: '' }; }
    if ((m = t.match(/^(next|previous|last|the next|the previous) (job|one|result)$/))) {
      const order = [...jobs].reverse().filter((j) => !filter || filter.has(j.id));
      const i = order.findIndex((j) => j.id === openId);
      const j = order[/next/.test(m[1]) ? i + 1 : i - 1];
      if (!j) return { reply: `That's the ${/next/.test(m[1]) ? 'last' : 'first'} one, sir.` };
      show(j.id);
      return { reply: '' };
    }
    if (view === 'gallery') {
      if ((m = t.match(new RegExp(`^(open|show( me)?) (the )?(${ORDS}|\\d+)( one| job| card)?$`)))) {
        const j = nth([...jobs].reverse().filter((x) => !filter || filter.has(x.id)), ordinal(m[4]));
        if (!j) return { reply: "There isn't one that far down, sir." };
        show(j.id);
        return { reply: '' };
      }
      return null;
    }
    // Versions
    if ((m = t.match(/^(show( me)?|go to|open) (the )?(latest|current|newest) (version|one)$/))) { version = null; renderDetail(); return { reply: '' }; }
    if ((m = t.match(new RegExp(`^(show( me)?|go to|open) (the )?(?:version (\\d+)|(${ORDS}|previous|original|old|older) version)$`)))) {
      const count = detail.querySelectorAll('[data-ver]:not([data-ver="0"])').length;
      if (!count) return { reply: "There's only the one version so far, sir." };
      const w = m[5];
      const n = m[4] ? Number(m[4]) : w === 'previous' || w === 'old' || w === 'older' ? (version ? Math.max(1, version - 1) : count) : w === 'original' ? 1 : ordinal(w) === -1 ? count : ordinal(w);
      if (n < 1 || n > count) return { reply: `There are ${count} earlier version${count === 1 ? '' : 's'}, sir.` };
      version = n;
      renderDetail();
      return { reply: '' };
    }
    // Bigger / smaller
    if (/^(make (it|this|that) )?(bigger|larger)$|^(zoom in|enlarge( it)?|blow (it|that) up|full ?screen( it)?|expand (it|this|that))$/.test(t)) {
      if (focused && !focused.matches('.sources, .file-grid, .progress, .versions')) { zoom(focused); return { reply: '' }; }
      if (!document.body.classList.contains('fullscreen')) window.ares.toggleFullscreen();
      return { reply: '' };
    }
    if (/^(make (it|this|that) )?smaller$|^(zoom out|shrink (it|this|that)|exit full ?screen|normal size)$/.test(t)) {
      if (unzoom()) return { reply: '' };
      if (document.body.classList.contains('fullscreen')) window.ares.toggleFullscreen();
      return { reply: '' };
    }
    // Sources: "open the second source", "open the autoexpress one"
    if ((m = t.match(new RegExp(`^open (the )?(${ORDS}|\\d+)? ?(source|link|site|website|article|page|reference)$`)))) {
      const chips = [...detail.querySelectorAll('.sources a.source')];
      const c = nth(chips, ordinal(m[2]));
      if (!c) return { reply: chips.length ? `There are only ${chips.length} sources, sir.` : 'This one has no sources.' };
      window.ares.openExternal(c.dataset.href);
      return { reply: '' };
    }
    if ((m = t.match(/^open (the )?(.+?) (source|link|site|article|page)$/))) {
      const w = m[2].replace(/\s+/g, '');
      const c = [...detail.querySelectorAll('.sources a.source')].find((a) => (a.textContent + a.dataset.href).toLowerCase().replace(/\s+/g, '').includes(w));
      if (c) { window.ares.openExternal(c.dataset.href); return { reply: '' }; }
      return { reply: `I can't see a ${m[2]} source in this one, sir.` };
    }
    // Files: "open the deck", "show me the spreadsheet", "open it in Keynote"
    if ((m = t.match(/^open (it|this|that|the (\w+( \w+)?)) in (its app|the app|keynote|powerpoint|word|excel|numbers|pages|preview|finder)$/))) {
      const kinds = m[2] ? FILEKIND.find(([re]) => re.test(m[2]))?.[1] : null;
      const f = files.find((x) => (kinds ? kinds.includes(kindOf(x.path)) : ['doc', 'deck', 'sheet', 'pdf'].includes(kindOf(x.path))));
      if (m[4] === 'finder') { window.ares.work.open(openId); return { reply: '' }; }
      if (!f) return { reply: "There's no file like that in this one, sir." };
      window.ares.work.open(openId, f.path);
      return { reply: '' };
    }
    if ((m = t.match(new RegExp(`^(open|show( me)?|preview|let me see) (the |that )?(${ORDS}|\\d+)? ?(.+?)$`)))) {
      const n = ordinal(m[4]);
      const what = m[5].trim();
      const fk = FILEKIND.find(([re]) => re.test(what));
      if (fk) {
        const f = nth(files.filter((x) => fk[1].includes(kindOf(x.path))), n);
        if (!f) return { reply: `There's no ${what} in this one, sir.` };
        preview(f.path);
        return { reply: '' };
      }
      const part = PARTS.find(([re]) => re.test(what));
      if (part) {
        const els = [...detail.querySelectorAll(part[1])];
        const el = nth(els, n);
        if (!el) return { reply: els.length ? `There ${els.length === 1 ? 'is only one' : `are only ${els.length}`}, sir.` : `There's no ${part[2]} in this one, sir.` };
        if (el.matches('details')) el.open = true;
        flash(el);
        return { reply: '' };
      }
      if (/^(summary|key takeaways?|takeaways|conclusion|intro(duction)?)$/.test(what)) {
        const h = [...detail.querySelectorAll('.md h1, .md h2, .md h3')].find((x) => x.textContent.toLowerCase().includes(what.split(' ').pop().replace(/s$/, '')));
        if (h) { flash(h); return { reply: '' }; }
        detail.scrollTo({ top: 0, behavior: 'smooth' });
        return { reply: '' };
      }
    }
    return null;
  }

  /** For the brain: what's on screen, so "make it shorter" goes to the right job. */
  function contextNote() {
    if (panel.hidden || closing) return '';
    if (view === 'gallery') return '(ARES note: the Work gallery is open on the Mac. show_job opens one of the jobs.)\n\n';
    const j = jobs.find((x) => x.id === openId);
    if (!j) return '';
    return `(ARES note: the Work panel is open on the Mac showing the job "${j.title}" [${j.id}] (${j.status}${version ? `, an earlier version of its result` : ''}). ` +
      'If the user asks to change, add to or redo it, that is a follow-up to this job: call continue_job with its id.)\n\n';
  }

  // ---- Opening and closing: the panel grows out of the job's orb, and folds back into it -------------
  const orbs = () => window.JobOrbs;
  let closing = false;
  let reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const applyMotion = (p) => {
    reduceMotion = Boolean(p?.reduceMotion) || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (orbs()) orbs().reduceMotion = reduceMotion;
  };
  window.ares.uiPrefs?.().then(applyMotion);
  window.ares.onUiPrefs?.(applyMotion);
  /** Where the panel grows from when there's no orb to open: the WORK button. */
  // Where Work unfolds from and folds back to: its button, or (the ARES theme hides that) the bar item it was opened from
  const buttonPoint = () => {
    const r = $('workBtn').getBoundingClientRect();
    if (r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    return window.ARES_BAR_ORIGIN || { x: innerWidth / 2, y: 0 };
  };
  const settle = () => panel.getAnimations().forEach((a) => a.cancel());
  // A hidden window doesn't animate (no frames), so never wait on an animation for long
  const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

  function grow(from) {
    settle();
    if (reduceMotion) return panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    const r = panel.getBoundingClientRect();
    panel.style.transformOrigin = `${from.x - r.left}px ${from.y - r.top}px`;
    return panel.animate([
      { transform: 'scale(0.02)', opacity: 0, borderRadius: '50%', boxShadow: '0 0 80px rgba(62, 230, 255, 0.6)' },
      { opacity: 1, offset: 0.22 },
      { transform: 'scale(1.014)', borderRadius: '10px', offset: 0.76 },
      { transform: 'scale(1)', opacity: 1, borderRadius: '10px', boxShadow: '0 0 40px rgba(62, 230, 255, 0.08)' },
    ], { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
  }
  function fold(into) {
    settle();
    if (reduceMotion) return panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
    const r = panel.getBoundingClientRect();
    panel.style.transformOrigin = `${into.x - r.left}px ${into.y - r.top}px`;
    return panel.animate([
      { transform: 'scale(1)', opacity: 1, borderRadius: '10px' },
      { transform: 'scale(1.01)', offset: 0.15 },
      { opacity: 1, offset: 0.7 },
      { transform: 'scale(0.02)', opacity: 0, borderRadius: '50%' },
    ], { duration: 320, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
  }

  let opening = 0;
  async function open(id, { gallery = false } = {}) {
    const target = id ?? openId ?? jobs[jobs.length - 1]?.id ?? null;
    if (!gallery && id != null) view = 'job';
    if (!panel.hidden && !closing) { // already open: just switch jobs
      if (target !== openId || view === 'job') { if (target !== openId) version = null; openId = target; orbs()?.park(openId); renderList(); renderDetail(); }
      return;
    }
    if (closing) { // re-opened mid-fold: unfold where it is
      closing = false;
      settle();
      openId = target;
      if (view === 'job') orbs()?.park(openId);
      renderList(); renderDetail();
      return;
    }
    const mine = ++opening;
    openId = target;
    closePreview();
    renderList();
    fresh = true;
    renderDetail();
    const from = (view === 'job' && openId && await within(orbs()?.launch(openId), 800)) || buttonPoint();
    if (mine !== opening) return;
    panel.hidden = false;
    document.body.classList.add('work-open');
    grow(from);
  }
  /** Close; with dismiss, the finished job is put away and its orb sinks into the brain. */
  async function close({ dismiss = false } = {}) {
    if (panel.hidden || closing) return;
    closing = true;
    opening++;
    closePreview();
    const id = openId;
    unzoom();
    const into = (view === 'job' && id && orbs()?.has(id) && orbs().screenPos(id)) || buttonPoint();
    await within(fold(into).finished, 700);
    if (!closing) return; // re-opened meanwhile
    closing = false;
    panel.hidden = true;
    settle();
    document.body.classList.remove('work-open');
    if (dismiss && id) window.ares.work.dismiss(id);
    else orbs()?.land(id);
  }
  const toggle = () => (panel.hidden || closing ? open() : close());

  window.ares.work.onChange((job) => {
    const i = jobs.findIndex((j) => j.id === job.id);
    const was = i >= 0 ? jobs[i].status : null;
    if (i >= 0) jobs[i] = job; else jobs.push(job);
    renderList();
    if (!panel.hidden && job.id === openId && was !== job.status) renderDetail();
  });
  window.ares.work.onRemoved((id) => {
    jobs = jobs.filter((j) => j.id !== id);
    if (openId === id) {
      openId = jobs[jobs.length - 1]?.id ?? null;
      if (!panel.hidden) { orbs()?.park(openId); renderDetail(); }
    }
    renderList();
  });
  window.ares.work.onEvent((id, evt) => {
    if (panel.hidden || id !== openId) return;
    const ul = $('jobSteps');
    if (!ul || evt.type === 'done' || evt.type === 'approval') return renderDetail();
    ul.insertAdjacentHTML('beforeend', stepLine(evt));
  });

  $('workBtn').addEventListener('click', toggle);
  window.ares.work.onShow((id) => (id ? show(id) : showGallery()));
  window.addEventListener('orb-open', (e) => open(e.detail));
  window.addEventListener('orbs-ready', () => { applyMotion({ reduceMotion }); orbs().sync(jobs); });
  panel.querySelector('.work-close').addEventListener('click', close);
  window.ares.work.list().then((all) => { jobs = all; renderList(); });

  return { open, close, toggle, back, show, showGallery, command, contextNote,
    get isOpen() { return !panel.hidden && !closing; }, get openJob() { return view === 'job' && !panel.hidden && !closing ? jobs.find((j) => j.id === openId) || null : null; } };
})();
