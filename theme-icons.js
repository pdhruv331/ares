// ARES icons for the Desktop's items and a few chosen folders (docs/ares-theme-prompt.md, part 4).
//
// macOS has no safe way to change the default folder icon, so each item gets its own custom icon (NSWorkspace
// setIcon:forFile:, through native/AresTheme.swift). Before that, the item's own icon data is saved in the theme's
// originals (theme-prefs.js): the Finder-info and resource-fork extended attributes where a custom icon lives, and
// for a folder its hidden "Icon\r" file. Restoring removes ARES's icon and writes those back byte for byte.
// ~/Desktop is watched, so new items get an ARES icon too.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BrowserWindow, ipcMain } = require('electron');
const { run } = require('./theme-prefs');

const KINDS = {
  image: /\.(png|jpe?g|gif|heic|webp|svg|tiff?|bmp|raw|psd)$/i,
  pdf: /\.pdf$/i,
  code: /\.(js|mjs|cjs|ts|tsx|jsx|py|swift|java|kt|c|cc|cpp|h|hpp|go|rs|rb|sh|zsh|html?|css|scss|php|sql|ya?ml|ipynb)$/i,
  data: /\.(json|csv|tsv|xml|plist|toml|log)$/i,
  archive: /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|pkg|iso)$/i,
  document: /\.(docx?|pages|txt|md|rtf|key|pptx?|xlsx?|numbers|drawio|odt|epub)$/i,
};
const ICON_FILE = 'Icon\r';
const X_INFO = 'com.apple.FinderInfo', X_RSRC = 'com.apple.ResourceFork';

function kindOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.isDirectory()) return path.extname(file) ? null : 'folder'; // .app and other bundles keep their own icons
  for (const [k, re] of Object.entries(KINDS)) if (re.test(file)) return k;
  return 'generic';
}

class Icons {
  constructor({ dir, helper, originals, log, appDir }) {
    Object.assign(this, { helper, originals, log, appDir });
    this.dir = path.join(dir, 'icons');
    this.desktop = path.join(os.homedir(), 'Desktop');
    this.watcher = null;
    this.busy = Promise.resolve();
  }

  /** The art (renderer/theme-art.js), drawn once and kept in the support folder. */
  async art() {
    const want = ['folder', 'document', 'image', 'pdf', 'code', 'archive', 'data', 'generic'];
    if (want.every((k) => fs.existsSync(path.join(this.dir, `${k}.png`)))) return true;
    fs.mkdirSync(this.dir, { recursive: true });
    const win = new BrowserWindow({ show: false, width: 512, height: 512, paintWhenInitiallyHidden: true,
      webPreferences: { preload: path.join(this.appDir, 'theme-preload.js'), contextIsolation: true, backgroundThrottling: false } });
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => done(null), 20_000);
      const onDone = (e, map) => { if (e.sender === win.webContents) done(map); };
      function done(map) { clearTimeout(timer); ipcMain.removeListener('theme-art-done', onDone); resolve(map); }
      ipcMain.on('theme-art-done', onDone);
      win.loadFile(path.join(this.appDir, 'renderer', 'theme-art.html'));
    });
    if (!win.isDestroyed()) win.destroy();
    if (!got) { this.log('theme icon art failed'); return false; }
    for (const [k, url] of Object.entries(got)) fs.writeFileSync(path.join(this.dir, `${k}.png`), Buffer.from(url.split(',')[1], 'base64'));
    return true;
  }
  file(kind) { return path.join(this.dir, `${kind}.png`); }

  // ---- The originals --------------------------------------------------------------------------------------------
  async xattr(name, file) {
    try { return (await run('/usr/bin/xattr', ['-px', name, file])).replace(/\s+/g, ''); } catch { return null; }
  }
  async snapshot(file) {
    const rec = { kind: 'icon', path: file, info: await this.xattr(X_INFO, file), rsrc: await this.xattr(X_RSRC, file), iconFile: null };
    const inner = path.join(file, ICON_FILE);
    if (fs.existsSync(inner)) rec.iconFile = { info: await this.xattr(X_INFO, inner), rsrc: await this.xattr(X_RSRC, inner) };
    return rec;
  }
  async writeX(name, hex, file) {
    if (hex) await run('/usr/bin/xattr', ['-wx', name, hex, file]);
    else await run('/usr/bin/xattr', ['-d', name, file]).catch(() => {});
  }
  /** Back to exactly what it was: ARES's icon removed, the saved attributes (and a folder's Icon\r) written back. */
  async restoreOne(rec) {
    if (!fs.existsSync(rec.path)) { this.log('theme icon: item gone, nothing to restore', path.basename(rec.path)); return true; }
    await run(this.helper, ['set-icon', rec.path, '-']).catch(() => {});
    if (rec.iconFile) {
      const inner = path.join(rec.path, ICON_FILE);
      if (!fs.existsSync(inner)) fs.writeFileSync(inner, '');
      await this.writeX(X_RSRC, rec.iconFile.rsrc, inner);
      await this.writeX(X_INFO, rec.iconFile.info, inner);
    }
    await this.writeX(X_RSRC, rec.rsrc, rec.path).catch(() => {}); // a folder has no resource fork to write
    await this.writeX(X_INFO, rec.info, rec.path);
    const now = await this.snapshot(rec.path);
    const same = now.info === rec.info && (fs.statSync(rec.path).isDirectory() || now.rsrc === rec.rsrc)
      && JSON.stringify(now.iconFile) === JSON.stringify(rec.iconFile);
    if (!same) this.log('theme icon restore differs', { item: path.basename(rec.path) });
    return same;
  }

  // ---- Applying -------------------------------------------------------------------------------------------------
  async applyOne(file) {
    const kind = kindOf(file);
    if (!kind) return false;
    const id = `icon:${file}`;
    if (!this.originals.has(id)) this.originals.keep(id, await this.snapshot(file));
    const r = await run(this.helper, ['set-icon', file, this.file(kind)]).then(() => true, (err) => { this.log('theme icon failed', { item: path.basename(file), error: err.stderr || err.message }); return false; });
    return r;
  }
  desktopItems() {
    try {
      return fs.readdirSync(this.desktop).filter((n) => !n.startsWith('.') && !n.startsWith('~$') && n !== ICON_FILE).map((n) => path.join(this.desktop, n));
    } catch { return []; }
  }
  /** The Desktop's items and the chosen folders; then keep watching the Desktop. */
  async apply(folders = []) {
    if (!(await this.art())) return { applied: 0, failed: 1 };
    let applied = 0, failed = 0;
    for (const f of [...this.desktopItems(), ...folders.filter((f) => fs.existsSync(f))]) {
      if (await this.applyOne(f)) applied++; else if (kindOf(f)) failed++;
    }
    this.watch();
    this.log('theme icons applied', { applied, failed });
    return { applied, failed };
  }
  watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.desktop, () => { clearTimeout(this.watchTimer); this.watchTimer = setTimeout(() => this.newcomers(), 1500); });
    } catch (err) { this.log('theme desktop watch failed', err.message); }
  }
  newcomers() {
    this.busy = this.busy.then(async () => {
      for (const f of this.desktopItems()) if (!this.originals.has(`icon:${f}`)) await this.applyOne(f);
    }).catch(() => {});
  }
  unwatch() { this.watcher?.close(); this.watcher = null; clearTimeout(this.watchTimer); }

  /** Every item ARES gave an icon, back to its own. Returns the ids that didn't come back exactly. */
  async restore() {
    this.unwatch();
    await this.busy;
    return this.originals.restore('icon:', { icon: (rec) => this.restoreOne(rec) });
  }
}

module.exports = { Icons, kindOf };
