// ARES colour themes for apps (docs/ares-theme-prompt.md, part 6), each one reversible:
//  - Terminal: an "ARES" profile (made by native/AresTheme.swift with archived NSColors), set as the default and
//    startup profile. Off: the previous default/startup profiles, and the ARES profile removed.
//  - VS Code: an "ARES" colour-theme extension (a .vsix installed with VS Code's own CLI) and workbench.colorTheme.
//    Off: the previous colorTheme value (or none) and the extension uninstalled.
//  - Chrome: an unpacked theme folder; Chrome only lets the user load it (chrome://extensions → Load unpacked).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, osa, plist } = require('./theme-prefs');

const P = { bg: '#02070c', bg2: '#06121a', fg: '#cfefff', cyan: '#3ee6ff', violet: '#a78bfa', green: '#4ade80', amber: '#ffb547', red: '#ff5c7a', muted: '#5d8797', white: '#effcff' };
const ANSI = [P.bg2, P.red, P.green, P.amber, '#3ea8ff', P.violet, P.cyan, P.fg, '#24414e', '#ff8aa0', '#86efac', '#ffd08a', '#7cc4ff', '#c4b5fd', '#9bf3ff', P.white];
const VSCODE = { cli: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', settings: path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json'), ext: 'ares.ares-theme' };

class AppThemes {
  constructor({ dir, helper, originals, log }) {
    Object.assign(this, { helper, originals, log });
    this.dir = path.join(dir, 'apps');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  helperJson(args) { return run(this.helper, args).then((o) => JSON.parse(o)); }
  get vscodeInstalled() { return fs.existsSync(VSCODE.cli); }

  // ---- Terminal ------------------------------------------------------------------------------------------------
  async terminal() {
    const file = path.join(this.dir, 'ARES.terminal');
    await this.helperJson(['terminal-profile', file, JSON.stringify({ name: 'ARES', bg: P.bg, fg: P.fg, bold: P.white, cursor: P.cyan, selection: '#14424f', ansi: ANSI })]);
    const { plist: profile } = await this.helperJson(['plist-file', file]);
    const merged = await this.helperJson(['pref-merge', 'com.apple.Terminal', 'Window Settings', 'ARES', profile]);
    this.originals.keep('app:terminal-profile', { kind: 'termprofile', existed: merged.existed });
    await this.originals.setPref('com.apple.Terminal', 'Default Window Settings', 'ARES');
    await this.originals.setPref('com.apple.Terminal', 'Startup Window Settings', 'ARES');
    if (await running('Terminal')) {
      // A running Terminal only knows the profiles it started with: opening the file adds ARES (and one window)
      await run('/usr/bin/open', ['-g', file]).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      await osa('tell application "Terminal" to set default settings to settings set "ARES"').catch(() => {});
      await osa('tell application "Terminal" to set startup settings to settings set "ARES"').catch(() => {});
    }
    return true;
  }
  async restoreTerminal(rec) {
    if (rec.kind === 'termprofile') {
      if (!rec.existed) await this.helperJson(['pref-merge', 'com.apple.Terminal', 'Window Settings', 'ARES', '-']);
      return true;
    }
    return false;
  }
  /** After the prefs are back: a running Terminal also gets its previous default/startup profiles. */
  async terminalLive(defaultName, startupName) {
    if (!(await running('Terminal'))) return;
    if (defaultName) await osa(`tell application "Terminal" to set default settings to settings set "${defaultName.replace(/"/g, '')}"`).catch(() => {});
    if (startupName) await osa(`tell application "Terminal" to set startup settings to settings set "${startupName.replace(/"/g, '')}"`).catch(() => {});
  }

  // ---- VS Code -------------------------------------------------------------------------------------------------
  vscodeThemeJson() {
    return {
      name: 'ARES', type: 'dark',
      colors: {
        'editor.background': P.bg, 'editor.foreground': P.fg, 'editorCursor.foreground': P.cyan, 'editor.lineHighlightBackground': '#3ee6ff0d',
        'editor.selectionBackground': '#3ee6ff33', 'editor.inactiveSelectionBackground': '#3ee6ff1a', 'editorLineNumber.foreground': '#2b4a57',
        'editorLineNumber.activeForeground': P.cyan, 'editorIndentGuide.background1': '#3ee6ff14', 'editorBracketMatch.border': '#3ee6ff80',
        'editorWidget.background': P.bg2, 'editorWidget.border': '#3ee6ff33', 'editorGroupHeader.tabsBackground': P.bg,
        'tab.activeBackground': P.bg2, 'tab.inactiveBackground': P.bg, 'tab.activeBorderTop': P.cyan, 'tab.activeForeground': P.white, 'tab.inactiveForeground': P.muted, 'tab.border': P.bg,
        'sideBar.background': '#03090e', 'sideBar.foreground': '#9cc7d6', 'sideBarSectionHeader.background': P.bg, 'sideBarTitle.foreground': P.cyan,
        'activityBar.background': P.bg, 'activityBar.foreground': P.cyan, 'activityBar.inactiveForeground': '#2f5866', 'activityBarBadge.background': P.violet,
        'statusBar.background': P.bg, 'statusBar.foreground': P.cyan, 'statusBar.border': '#3ee6ff26', 'statusBar.debuggingBackground': P.amber,
        'titleBar.activeBackground': P.bg, 'titleBar.activeForeground': P.fg, 'titleBar.inactiveBackground': P.bg, 'titleBar.border': '#3ee6ff1f',
        'panel.background': P.bg, 'panel.border': '#3ee6ff26', 'terminal.background': P.bg, 'terminal.foreground': P.fg, 'terminalCursor.foreground': P.cyan,
        'focusBorder': '#3ee6ff80', 'button.background': '#3ee6ff26', 'button.foreground': P.white, 'button.hoverBackground': '#3ee6ff40',
        'input.background': P.bg2, 'input.border': '#3ee6ff26', 'list.activeSelectionBackground': '#3ee6ff26', 'list.hoverBackground': '#3ee6ff12',
        'list.inactiveSelectionBackground': '#3ee6ff17', 'badge.background': P.violet, 'badge.foreground': P.bg, 'scrollbarSlider.background': '#3ee6ff1f',
        'gitDecoration.modifiedResourceForeground': P.amber, 'gitDecoration.untrackedResourceForeground': P.green, 'gitDecoration.deletedResourceForeground': P.red,
        'editorError.foreground': P.red, 'editorWarning.foreground': P.amber, 'editorInfo.foreground': P.cyan,
        ...Object.fromEntries(['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].flatMap((n, i) => [[`terminal.ansi${n}`, ANSI[i]], [`terminal.ansiBright${n}`, ANSI[i + 8]]])),
      },
      tokenColors: [
        { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#4c7383', fontStyle: 'italic' } },
        { scope: ['keyword', 'storage', 'storage.type', 'keyword.control'], settings: { foreground: P.violet } },
        { scope: ['string', 'string.quoted'], settings: { foreground: P.green } },
        { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: P.amber } },
        { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: P.cyan } },
        { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#9bf3ff' } },
        { scope: ['variable', 'variable.other'], settings: { foreground: P.fg } },
        { scope: ['variable.parameter'], settings: { foreground: '#ffd08a' } },
        { scope: ['entity.name.tag'], settings: { foreground: P.cyan } },
        { scope: ['entity.other.attribute-name'], settings: { foreground: P.violet } },
        { scope: ['keyword.operator', 'punctuation'], settings: { foreground: '#7fb6c6' } },
        { scope: ['markup.heading'], settings: { foreground: P.cyan, fontStyle: 'bold' } },
      ],
    };
  }
  async vsix() {
    const root = path.join(this.dir, 'vscode-build');
    fs.rmSync(root, { recursive: true, force: true });
    const ext = path.join(root, 'extension');
    fs.mkdirSync(path.join(ext, 'themes'), { recursive: true });
    const pkg = { name: 'ares-theme', displayName: 'ARES', publisher: 'ares', version: '1.0.0', engines: { vscode: '^1.60.0' }, categories: ['Themes'],
      contributes: { themes: [{ label: 'ARES', uiTheme: 'vs-dark', path: './themes/ares-color-theme.json' }] } };
    fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(ext, 'themes', 'ares-color-theme.json'), JSON.stringify(this.vscodeThemeJson(), null, 2));
    fs.writeFileSync(path.join(root, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Language="en-US" Id="ares-theme" Version="1.0.0" Publisher="ares"/><DisplayName>ARES</DisplayName>
    <Description xml:space="preserve">ARES colour theme</Description><Categories>Themes</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.60.0"/></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>`);
    fs.writeFileSync(path.join(root, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>`);
    const out = path.join(this.dir, 'ares-theme.vsix');
    fs.rmSync(out, { force: true });
    await run('/usr/bin/zip', ['-qr', out, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: root });
    return out;
  }
  async vscode() {
    if (!this.vscodeInstalled) return false;
    const vsix = await this.vsix();
    await run(VSCODE.cli, ['--install-extension', vsix, '--force'], { timeout: 120_000 });
    this.originals.keep('app:vscode-ext', { kind: 'vscodeext' });
    // workbench.colorTheme: only that one line changes; the original value (or its absence) is kept
    const file = VSCODE.settings;
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{\n}\n';
    const re = /("workbench\.colorTheme"\s*:\s*)"((?:[^"\\]|\\.)*)"/;
    const m = re.exec(text);
    if (!this.originals.has('app:vscode-theme')) this.originals.keep('app:vscode-theme', { kind: 'vscodetheme', had: Boolean(m), value: m ? m[2] : null, created: !fs.existsSync(file) });
    if (m) text = text.replace(re, '$1"ARES"');
    else text = text.replace('{', '{\n    "workbench.colorTheme": "ARES",');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return true;
  }
  async restoreVscode(rec) {
    if (rec.kind === 'vscodeext') {
      await run(VSCODE.cli, ['--uninstall-extension', VSCODE.ext], { timeout: 120_000 }).catch((err) => this.log('vscode uninstall', err.stderr || err.message));
      // The CLI leaves the folder for VS Code to sweep up on its next launch: remove ARES's own folder now
      const dir = path.join(os.homedir(), '.vscode', 'extensions');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.startsWith(`${VSCODE.ext}-`)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      return true;
    }
    if (rec.kind === 'vscodetheme') {
      const file = VSCODE.settings;
      if (!fs.existsSync(file)) return true;
      if (rec.created) { fs.rmSync(file); return true; }
      let text = fs.readFileSync(file, 'utf8');
      if (rec.had) text = text.replace(/("workbench\.colorTheme"\s*:\s*)"ARES"/, `$1${JSON.stringify(rec.value)}`);
      else text = text.replace(/\n\s*"workbench\.colorTheme": "ARES",/, '');
      fs.writeFileSync(file, text);
      return true;
    }
    return false;
  }

  // ---- Chrome ----------------------------------------------------------------------------------------------------
  chrome() {
    const dir = path.join(this.dir, 'chrome-ares-theme');
    fs.mkdirSync(dir, { recursive: true });
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'ARES', version: '1.0', description: 'ARES colour theme',
      theme: {
        colors: {
          frame: rgb('#02070c'), frame_inactive: rgb('#02070c'), toolbar: rgb('#06121a'), tab_text: rgb(P.white), tab_background_text: rgb(P.muted),
          bookmark_text: rgb('#9cc7d6'), ntp_background: rgb('#02050a'), ntp_text: rgb(P.fg), ntp_link: rgb(P.cyan), button_background: rgb('#06121a'),
          omnibox_background: rgb('#02070c'), omnibox_text: rgb(P.fg), toolbar_button_icon: rgb(P.cyan), toolbar_text: rgb(P.fg),
        },
        properties: { ntp_background_alignment: 'center' },
      },
    }, null, 2));
    return dir;
  }
}

const running = (name) => run('/usr/bin/pgrep', ['-x', name]).then(() => true, () => false);

module.exports = { AppThemes, PALETTE: P, plist };
