// Job results: markdown (marked, GFM) sanitised with DOMPurify, then enhanced in place with Chart.js charts,
// Mermaid diagrams, highlighted code, job-folder images and live mini-apps. Every library is bundled locally
// (renderer/vendor, see scripts/vendor.mjs). Links never navigate: web links become data-href anchors
// (opened in the browser by the app) and job files become data-file anchors (previewed in the panel).
const Markdown = (() => {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** ares-job://<id>/<path>: a file inside that job's folder, served by the main process (work-files.js).
   *  The phone app serves the same files over its own API instead (configure()). */
  let fileUrl = (id, p) => `ares-job://${id}/${String(p).split('/').map(encodeURIComponent).join('/')}`;
  /** A relative path inside the job folder, or null (absolute paths, other schemes and ../ are not files). */
  const localPath = (href) => {
    let p = String(href || '').trim();
    if (!p || /^[a-z][\w+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('#')) return null;
    try { p = decodeURIComponent(p); } catch {}
    p = p.replace(/^\.\//, '').split(/[?#]/)[0];
    return p.split('/').some((s) => s === '..' || s.startsWith('.')) ? null : p;
  };

  // Charts follow the dataviz rules: a small categorical palette in a fixed order, distinguishable on the
  // dark HUD (and a darker set for printed PDFs), thin gridlines, no chart junk.
  const PALETTE = {
    dark: ['#3ee6ff', '#a78bfa', '#ffb547', '#4ade80', '#f472b6', '#60a5fa', '#fb7185', '#a3e635'],
    light: ['#0e7490', '#6d28d9', '#b45309', '#15803d', '#be185d', '#1d4ed8', '#b91c1c', '#4d7c0f'],
  };

  let job = null; // the job being rendered (for file URLs)
  // Chart and diagram sources stay in memory (not in attributes: the sanitiser rightly drops markup-like values)
  const blocks = new Map();
  let blockSeq = 0;
  const keep = (text) => { const k = String(++blockSeq); blocks.set(k, text); if (blocks.size > 400) blocks.delete(blocks.keys().next().value); return k; };
  const renderer = {
    code({ text, lang }) {
      const kind = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      if (kind === 'chart') return `<div class="md-chart" data-block="${keep(text)}"></div>`;
      if (kind === 'mermaid') return `<div class="md-mermaid" data-block="${keep(text)}"></div>`;
      if (kind === 'app') {
        const p = localPath(text.trim().split('\n')[0]);
        return p ? `<div class="md-app" data-app="${esc(p)}"></div>` : '';
      }
      return `<pre class="md-code"><code data-lang="${esc(kind)}">${esc(text)}</code></pre>`;
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (/^https?:\/\//i.test(href)) return `<a data-href="${esc(href)}" title="${esc(href)}">${inner}</a>`;
      const p = localPath(href);
      return p ? `<a class="md-filelink" data-file="${esc(p)}" title="${esc(p)}">${inner}</a>` : inner;
    },
    image({ href, title, text }) {
      const p = localPath(href);
      if (!p) return text ? `<em class="md-img">[image: ${esc(text)}]</em>` : ''; // web images: no network in here
      const cap = title || '';
      return `<figure class="md-figure"><img src="${fileUrl(job, p)}" alt="${esc(text)}" data-file="${esc(p)}" loading="lazy">${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`;
    },
  };
  marked.use({ gfm: true, renderer });

  const PURIFY = {
    ALLOWED_URI_REGEXP: /^ares-job:/i, // src/href only ever point at job files (see configure())
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style'],
  };

  /** Markdown → safe HTML string (enhance() afterwards, once it's in the page). */
  function render(md, jobId) {
    job = jobId;
    const html = marked.parse(String(md || ''));
    return DOMPurify.sanitize(html, PURIFY);
  }

  // ---- Enhancers ----------------------------------------------------------------------------------
  const charts = new WeakMap();
  function chart(el, theme) {
    let cfg;
    try { cfg = JSON.parse(blocks.get(el.dataset.block)); } catch { el.innerHTML = '<div class="md-error">This chart\'s data couldn\'t be read.</div>'; return; }
    if (!cfg || typeof cfg !== 'object' || !cfg.data) { el.innerHTML = '<div class="md-error">Not a chart.</div>'; return; }
    const colors = PALETTE[theme];
    const ink = theme === 'dark' ? '#cfefff' : '#1f2937';
    const grid = theme === 'dark' ? 'rgba(62,230,255,0.10)' : 'rgba(0,0,0,0.08)';
    const round = ['pie', 'doughnut', 'polarArea'].includes(cfg.type);
    (cfg.data.datasets || []).forEach((ds, i) => {
      const c = colors[i % colors.length];
      if (round) {
        ds.backgroundColor ??= (cfg.data.labels || ds.data || []).map((_, k) => colors[k % colors.length]);
        ds.borderColor ??= theme === 'dark' ? '#061019' : '#fff';
      } else {
        ds.borderColor ??= c;
        ds.backgroundColor ??= (ds.type || cfg.type) === 'line' ? c : `${c}cc`;
        ds.pointRadius ??= (ds.type || cfg.type) === 'line' ? 2 : undefined;
      }
      ds.borderWidth ??= round ? 1 : 2;
    });
    cfg.options = cfg.options || {};
    Object.assign(cfg.options, { responsive: true, maintainAspectRatio: false, animation: theme === 'dark' ? cfg.options.animation : false });
    Chart.defaults.color = ink;
    Chart.defaults.font.family = '-apple-system, "SF Pro Text", sans-serif';
    Chart.defaults.borderColor = grid;
    const box = document.createElement('div');
    box.className = 'md-chart-box';
    box.style.height = `${Math.min(700, Math.max(180, Number(cfg.height) || 320))}px`;
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    el.replaceChildren(box);
    try { charts.set(el, new Chart(canvas, cfg)); } catch (err) { el.innerHTML = `<div class="md-error">Chart error: ${esc(err.message)}</div>`; }
  }

  let mermaidLoad = null;
  const loadMermaid = () => (mermaidLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('vendor/mermaid.min.js', document.baseURI).href; // 5 MB: only loaded when a result has a diagram
    s.onload = () => resolve(window.mermaid);
    s.onerror = () => reject(new Error('mermaid failed to load'));
    document.head.appendChild(s);
  }));
  let seq = 0;
  async function diagram(el, theme) {
    try {
      const mermaid = await loadMermaid();
      const dark = theme === 'dark';
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: 'base',
        fontFamily: '-apple-system, "SF Pro Text", sans-serif',
        htmlLabels: false, flowchart: { htmlLabels: false }, // pure SVG text, so the sanitiser keeps the labels
        themeVariables: dark
          ? { darkMode: true, background: '#061019', primaryColor: '#0b2a36', primaryBorderColor: '#3ee6ff', primaryTextColor: '#e6fbff',
            secondaryColor: '#1d1640', secondaryBorderColor: '#a78bfa', tertiaryColor: '#0a1a24', tertiaryBorderColor: '#5fb8cc',
            lineColor: '#5fb8cc', textColor: '#cfefff', edgeLabelBackground: '#061019', clusterBkg: '#081822', clusterBorder: '#1f4a58',
            noteBkgColor: '#1d1640', noteTextColor: '#e6fbff', actorBkg: '#0b2a36', actorBorder: '#3ee6ff', actorTextColor: '#e6fbff', signalColor: '#cfefff', signalTextColor: '#cfefff' }
          : { primaryColor: '#e0f2f7', primaryBorderColor: '#0e7490', primaryTextColor: '#0f172a', lineColor: '#475569', secondaryColor: '#ede9fe', tertiaryColor: '#f8fafc' },
      });
      const { svg } = await mermaid.render(`mmd-${Date.now()}-${seq++}`, blocks.get(el.dataset.block) || '');
      el.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'] });
    } catch (err) {
      el.innerHTML = `<div class="md-error">Diagram error: ${esc(String(err.message || err).split('\n')[0])}</div><pre class="md-code"><code>${esc(blocks.get(el.dataset.block) || '')}</code></pre>`;
    }
  }

  function app(el, { interactive }) {
    const p = el.dataset.app;
    if (!interactive) { el.innerHTML = `<div class="md-app-print">Interactive app: ${esc(p)} (open it in ARES)</div>`; return; }
    el.innerHTML = `<div class="md-app-bar"><span>APP · ${esc(p)}</span><button class="icon-btn" data-app-full>FULLSCREEN</button></div>`;
    const frame = document.createElement('iframe');
    // No allow-same-origin: an opaque origin with no access to ARES; the server adds CSP (no network) on top
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = fileUrl(job, p);
    el.appendChild(frame);
  }

  /** Bring a rendered result to life. theme: 'dark' (HUD) or 'light' (print). */
  async function enhance(root, jobId, { theme = 'dark', interactive = true } = {}) {
    job = jobId;
    root.querySelectorAll('.md-chart').forEach((el) => chart(el, theme));
    root.querySelectorAll('pre.md-code code').forEach((el) => {
      const lang = el.dataset.lang;
      if (lang && window.hljs?.getLanguage(lang)) el.innerHTML = hljs.highlight(el.textContent, { language: lang }).value;
      else if (window.hljs && el.textContent.length < 20000) el.innerHTML = hljs.highlightAuto(el.textContent).value;
    });
    root.querySelectorAll('.md-app').forEach((el) => app(el, { interactive }));
    const images = [...root.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
    await Promise.all([...root.querySelectorAll('.md-mermaid')].map((el) => diagram(el, theme)), ...images.filter(Boolean));
  }

  /** Where job files live, for a page that isn't the Mac app (the phone): a URL builder and the pattern it makes. */
  function configure({ fileUrl: f, fileUrlPattern }) {
    fileUrl = f;
    PURIFY.ALLOWED_URI_REGEXP = fileUrlPattern;
  }

  return { render, enhance, esc, configure, fileUrl: (id, p) => fileUrl(id, p) };
})();
