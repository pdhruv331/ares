// Work results in the renderer: job files served over ares-job://<job-id>/<path> (only files inside that job's
// folder, same realpath check as the worker gate), office previews converted to PDF inside the worker
// sandbox, and "Save as PDF" of a rendered result. Main process only.
const { protocol, BrowserWindow, session } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const sandbox = require('./worker-sandbox');

const SCHEME = 'ares-job';
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', md: 'text/plain', txt: 'text/plain', csv: 'text/plain', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
const OFFICE = /\.(docx?|pptx?|xlsx?|odt|odp|ods|rtf)$/i;

/** Must run before the app is ready. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

/** The file on disk for a job + relative path, or null when it isn't strictly inside that job's folder. */
function resolveJobFile(jobs, id, rel) {
  if (!jobs.get(id)) return null;
  rel = String(rel || '').replace(/^\/+/, '');
  // Worker internals stay private; only the preview cache is served from the hidden folders
  if (!rel || rel.split('/').some((seg, i) => seg.startsWith('.') && !(i === 0 && seg === '.preview'))) return null;
  const dir = fs.realpathSync.native(jobs.folder(id));
  let full;
  try { full = fs.realpathSync.native(path.resolve(dir, rel)); } catch { return null; }
  const low = (p) => (process.platform === 'darwin' ? p.toLowerCase() : p);
  if (!low(full).startsWith(low(dir) + path.sep)) return null;
  return fs.statSync(full).isFile() ? full : null;
}

function install({ jobs, log }) {
  protocol.handle(SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      const file = resolveJobFile(jobs, u.hostname, decodeURIComponent(u.pathname));
      if (!file) return new Response('Not found', { status: 404 });
      const ext = path.extname(file).slice(1).toLowerCase();
      const headers = {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };
      if (/^(html?|svg)$/.test(ext)) {
        // Worker-made pages (mini-apps): scripts run, but in an opaque origin with no network at all and no way
        // out of the iframe; they can only load their own job's files.
        const self = `${SCHEME}://${u.hostname}`;
        headers['Content-Security-Policy'] = `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${self}; style-src 'unsafe-inline' ${self}; img-src ${self} data: blob:; font-src ${self} data:; media-src ${self} data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'`;
      }
      return new Response(await fs.promises.readFile(file), { headers });
    } catch (err) {
      log('job file error', err.message);
      return new Response('Error', { status: 500 });
    }
  });

  // Belt and braces: nothing rendered in ARES's own windows (results, mini-apps, previews) may reach the network
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
    const fromPage = d.webContentsId != null;
    if (fromPage) log('renderer network blocked', { url: d.url.slice(0, 80), type: d.resourceType });
    cb({ cancel: fromPage });
  });
}

let converting = Promise.resolve();
const serial = (fn) => (converting = converting.then(fn, fn)); // one LibreOffice/poppler run at a time
const MAX_PAGES = 20;
const tool = (...candidates) => candidates.find((p) => fs.existsSync(p));

/**
 * Preview any PDF or office file as page images (office files go to PDF first with LibreOffice), cached in
 * .preview/<file>/ and redone when the file changes. Worker-made (maybe web-derived) files are converted
 * inside the same sandbox as worker commands. Resolves { pages: [relative paths], total } or { error }.
 */
async function preview(jobs, id, rel) {
  const file = resolveJobFile(jobs, id, rel);
  if (!file) return null;
  const isPdf = /\.pdf$/i.test(file);
  if (!isPdf && !OFFICE.test(file)) return null;
  const dir = jobs.folder(id);
  const name = path.basename(file);
  const outDir = path.join(dir, '.preview', name); // one folder per file: report.docx and report.pptx differ
  const list = () => fs.readdirSync(outDir).filter((f) => /^p-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
  const result = () => {
    const pages = list().map((f) => `.preview/${name}/${f}`);
    let total = pages.length;
    try { total = Number(fs.readFileSync(path.join(outDir, 'pages.txt'), 'utf8')) || total; } catch {}
    return pages.length ? { pages, total } : { error: "The preview couldn't be made. Open it in its app instead." };
  };
  try { if (fs.statSync(path.join(outDir, 'pages.txt')).mtimeMs >= fs.statSync(file).mtimeMs) return result(); } catch {}
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true });
  const profile = sandbox.writeProfile(jobs.profile(id), { jobDir: dir, runtime: jobs.runtime });
  const env = { ...process.env, TMPDIR: path.join(dir, '.tmp') };
  const boxed = (cmd, args) => new Promise((resolve) => execFile('/usr/bin/sandbox-exec', ['-f', profile, cmd, ...args], { timeout: 120_000, env }, (err, stdout) => resolve(err ? null : String(stdout))));

  let pdf = file;
  if (!isPdf) {
    const soffice = tool('/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice');
    if (!soffice) return { error: 'LibreOffice is not installed, so there is no preview. Open it in its app instead.' };
    const lo = pathToFileURL(path.join(dir, '.tmp', 'lo-profile')).href; // the support folder has a space in it
    await serial(() => boxed(soffice, [`-env:UserInstallation=${lo}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, file]));
    pdf = path.join(outDir, `${name.replace(/\.[^.]+$/, '')}.pdf`);
    if (!fs.existsSync(pdf)) return { error: "The preview couldn't be made. Open it in its app instead." };
  }
  const pdftoppm = tool('/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm');
  const pdfinfo = tool('/opt/homebrew/bin/pdfinfo', '/usr/local/bin/pdfinfo');
  if (!pdftoppm) return { error: 'Page previews need poppler (brew install poppler).' };
  const info = pdfinfo ? await boxed(pdfinfo, [pdf]) : '';
  const total = Number(info?.match(/Pages:\s+(\d+)/)?.[1]) || 0;
  await serial(() => boxed(pdftoppm, ['-png', '-r', '110', '-f', '1', '-l', String(MAX_PAGES), pdf, path.join(outDir, 'p')]));
  // pdftoppm pads page numbers (p-01.png); normalise to p-1.png
  for (const f of fs.readdirSync(outDir)) {
    const m = f.match(/^p-0*(\d+)\.png$/);
    if (m && f !== `p-${m[1]}.png`) fs.renameSync(path.join(outDir, f), path.join(outDir, `p-${m[1]}.png`));
  }
  fs.writeFileSync(path.join(outDir, 'pages.txt'), String(total || list().length));
  return result();
}

/** Render a job's result in a hidden window and print it to <folder>/<name>.pdf. Returns the file path. */
async function saveAsPdf(jobs, id, preload) {
  const job = jobs.get(id);
  if (!job) throw new Error('no such job');
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  try {
    const ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('rendering timed out')), 30_000);
      w.webContents.ipc.once('print-ready', () => { clearTimeout(t); resolve(); });
    });
    await w.loadFile(path.join(__dirname, 'renderer', 'print.html'), { query: { job: id } });
    await ready;
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    const name = `${(job.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'result')}-result.pdf`;
    const out = path.join(jobs.folder(id), name);
    fs.writeFileSync(out, pdf);
    return out;
  } finally {
    w.destroy();
  }
}

module.exports = { registerScheme, install, preview, saveAsPdf, resolveJobFile, SCHEME };
