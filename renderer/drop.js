// Drag and drop: files dropped anywhere on ARES wait by the input ("summarise this", "turn this into slides"),
// and the next thing said or typed becomes a job with them, or a follow-up on the job open in the Work panel.
const Drop = (() => {
  const $ = (id) => document.getElementById(id);
  const zone = $('dropZone');
  const card = $('dropCard');
  const input = $('input');
  const esc = Markdown.esc;
  const PLACEHOLDER = input.placeholder;
  let files = [];     // absolute paths
  let target = null;  // a finished job to add them to, or null for a new job
  let expires = null;

  const name = (p) => p.split('/').pop();
  const stem = () => (files.length === 1 ? name(files[0]).replace(/\.[^.]+$/, '') : `${files.length} files`);
  const PRESET = {
    summarise: { title: () => `Summary: ${stem()}`, text: 'Summarise this for me: the key points first, then the details worth knowing, and anything that needs my attention or action.' },
    slides: { title: () => `Slides: ${stem()}`, text: 'Turn this into a polished slide deck (.pptx) with the pptx skill: a title slide, one idea per slide, the key numbers as charts, and a closing summary. Link it from result.md.' },
  };
  // "Summarise these notes and list who…" + offsite.md → "Summary: offsite"
  const KINDS = [[/summar|tl;?dr|gist|key points/i, 'Summary'], [/slide|deck|presentation/i, 'Slides'], [/compar|\bvs\b|versus|differen/i, 'Comparison'],
    [/checklist|to-?do|action|tasks?\b/i, 'Actions'], [/translat/i, 'Translation'], [/analy|insight|trend/i, 'Analysis'],
    [/rewrite|edit|improve|proofread|polish|tidy/i, 'Edit'], [/email|reply|letter/i, 'Draft'], [/chart|graph|visuali/i, 'Charts'], [/explain|what does|what is/i, 'Explainer']];
  const titleFor = (text) => `${KINDS.find(([re]) => re.test(text))?.[1] || 'Files'}: ${stem()}`.slice(0, 80);

  function render() {
    card.hidden = !files.length;
    input.placeholder = files.length ? `What should I do with ${files.length === 1 ? 'it' : 'them'}? Say it or type it…` : PLACEHOLDER;
    if (!files.length) return;
    const job = Work.openJob;
    const canAdd = job && !['queued', 'running', 'approval'].includes(job.status);
    if (!canAdd) target = null;
    card.innerHTML = `
      <div class="drop-files">${files.map((f, i) => `<span class="drop-chip" title="${esc(f)}">${esc(name(f))}<button data-rm="${i}" title="Remove">✕</button></span>`).join('')}</div>
      <div class="drop-actions">
        <button class="icon-btn" data-go="summarise">SUMMARISE</button>
        <button class="icon-btn" data-go="slides">MAKE SLIDES</button>
        ${canAdd ? `<button class="icon-btn${target ? ' active' : ''}" data-target title="Give them to this job as a follow-up instead of starting a new one">ADD TO “${esc(job.title)}”</button>` : ''}
        <span>or tell me what to do with ${files.length === 1 ? 'it' : 'them'}</span>
        <button class="icon-btn" data-clear title="Forget these files">✕</button>
      </div>`;
  }
  function clear() {
    files = []; target = null; clearTimeout(expires);
    render();
  }

  /** Start the job (or follow-up) with the files. Returns { reply } for ARES to say. */
  async function start(instruction, title, spoken = null) {
    const r = await window.ares.work.withFiles({ instruction, files, jobId: target, title, spoken });
    if (r?.error) return { reply: `I couldn't start that, sir: ${r.error}` };
    const added = Boolean(target);
    clear();
    return { reply: added ? `Added to ${r.title}. I'll let you know when it's updated.` : "On it. I'll let you know when it's ready." };
  }

  // The dropped files wait for an instruction: the next thing said or typed
  async function consume(text, { voice = false } = {}) {
    return start(text, target ? null : titleFor(text), voice ? text : null);
  }

  const say = (reply) => window.dispatchEvent(new CustomEvent('ares-say', { detail: reply }));
  card.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { files.splice(Number(rm.dataset.rm), 1); return render(); }
    if (e.target.closest('[data-clear]')) return clear();
    if (e.target.closest('[data-target]')) { target = target ? null : Work.openJob?.id || null; return render(); }
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (go) {
      const p = PRESET[go];
      const r = await start(p.text, target ? null : p.title());
      say(r.reply);
    }
  });

  // Dragging files over the window: a drop target over everything (and never let Chromium open the file itself)
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.hidden = false; });
  document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; zone.hidden = true; } });
  document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'none'; });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    add([...(e.dataTransfer?.files || [])].map((f) => window.ares.work.filePath(f)).filter(Boolean));
  });
  function add(paths) {
    if (!paths.length) return;
    files = [...new Set([...files, ...paths])].slice(0, 20);
    // Dropped while a finished job is open: they probably belong to it
    const job = Work.openJob;
    target = job && !['queued', 'running', 'approval'].includes(job.status) ? job.id : null;
    clearTimeout(expires);
    expires = setTimeout(clear, 10 * 60_000);
    render();
    Comms.typing(true);
  }

  return { get pending() { return files.length > 0; }, add, consume, clear, refresh: render };
})();
