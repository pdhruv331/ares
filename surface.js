// Where the one ARES window lives (docs/live-desktop-prompt.md). With "ARES as Wallpaper" on, the window IS the desktop:
//
//   desktop  above the desktop icons, just below every app window, on all Spaces, transparent, click-through except
//            over panels and orbs (the renderer hit-tests forwarded mouse moves and asks for clicks when needed)
//   lifted   summoned ("Hey ARES" / ⌥Space, default): the same window rises above the apps, fully interactive, and
//            sinks back when dismissed or when another app is clicked
//   window   the classic separate window ("Open ARES window" summon mode, or with the wallpaper off)
//
// One window and one renderer throughout, so the dashboard, subtitles, orbs and conversation are the same ARES
// everywhere. The starry backdrop below the icons is wallpaper.js.
const { screen } = require('electron');

// On every Space without Electron's process-type juggling (by default it hides and re-shows the Dock icon to do this,
// which made macOS switch Spaces and could leave the window behind on one Space)
const ALL_SPACES = { visibleOnFullScreen: false, skipTransformProcessType: true };
const HIT_MS = 40; // how often the pointer is checked against ARES's clickable areas as the desktop

// Just below normal app windows (NSNormalWindowLevel is 0). Not down in the desktop band (kCGDesktopIconWindowLevel + 1):
// macOS treats clicks there as clicks on the wallpaper ("click wallpaper to reveal desktop" sweeps the windows away and
// the click never arrives). Transparent and click-through, so the icons below still show and still take their clicks.
const DESKTOP_LEVEL = -1;
const SINK_MS = 240;                     // the renderer fades the lifted glass out first

class Surface {
  constructor({ win, log, opts, onChange }) {
    this.win = win;
    this.log = log;
    this.opts = opts;        // () => { enabled, summon: 'lift' | 'window' }
    this.onChange = onChange; // (name) => void
    this.name = 'window';
    this.windowBounds = null; // where the classic window was last
    this.interactive = true;
    this.hits = { rects: [], all: false, held: false }; // the renderer's clickable areas (window coordinates)
    this.hitTimer = null;
    win.setVisibleOnAllWorkspaces(true, ALL_SPACES);
    win.on('blur', () => { if (this.name === 'lifted' && !this.holdLift) setTimeout(() => { if (this.name === 'lifted' && !win.isFocused()) this.sink(); }, 120); });
    for (const e of ['move', 'resize']) win.on(e, () => { if (this.name === 'window' && !win.isFullScreen()) this.windowBounds = win.getBounds(); });
  }

  get desktopOn() { return this.opts().enabled; }
  display() { return screen.getPrimaryDisplay(); }

  send(name) {
    if (!this.win.isDestroyed()) this.win.webContents.send('surface', { name });
    this.onChange?.(name);
  }

  /** The live desktop. */
  desktop() {
    const w = this.win;
    if (w.isFullScreen()) { w.once('leave-full-screen', () => this.desktop()); w.setFullScreen(false); return; }
    if (this.name === 'window') this.windowBounds = w.getBounds();
    this.name = 'desktop';
    w.setAlwaysOnTop(true, 'normal', DESKTOP_LEVEL);
    w.setVisibleOnAllWorkspaces(true, ALL_SPACES);
    w.setHiddenInMissionControl?.(true);
    w.setResizable(false); w.setMovable(false); w.setHasShadow(false);
    w.setFocusable(false); // clicking a panel never takes the keyboard from the app you're in
    w.setBounds(this.display().workArea);
    this.setInteractive(false);
    w.showInactive();
    this.send('desktop');
    this.checkPointer();
  }

  /** Summoned: the desktop rises above the apps. */
  lift() {
    const w = this.win;
    if (w.isFullScreen()) { w.focus(); return; }
    this.name = 'lifted';
    w.setFocusable(true);
    w.setVisibleOnAllWorkspaces(true, ALL_SPACES);
    w.setHiddenInMissionControl?.(true);
    w.setAlwaysOnTop(true, 'floating');
    w.setBounds(this.display().workArea);
    this.setInteractive(true);
    w.show();
    w.focus();
    this.send('lifted');
  }

  /** Back down to the desktop, after the renderer's fade. */
  sink() {
    if (this.name !== 'lifted') return;
    this.win.webContents.send('surface', { name: 'sinking' });
    this.name = 'sinking';
    setTimeout(() => { if (this.name === 'sinking') this.desktop(); }, SINK_MS);
  }

  /** The classic window. */
  window() {
    const w = this.win;
    this.name = 'window';
    w.setAlwaysOnTop(false);
    w.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    w.setHiddenInMissionControl?.(false);
    w.setFocusable(true); w.setResizable(true); w.setMovable(true); w.setHasShadow(true);
    const d = this.display().workArea;
    const b = this.windowBounds || { width: 1100, height: 720, x: Math.round(d.x + (d.width - 1100) / 2), y: Math.round(d.y + (d.height - 720) / 2) };
    w.setBounds(b);
    this.setInteractive(true);
    w.show();
    w.focus();
    this.send('window');
  }

  /** Summon (wake word, ⌥Space, the tray). */
  show() {
    if (!this.desktopOn) { if (this.name !== 'window') this.window(); else { this.win.show(); this.win.focus(); } return; }
    if (this.opts().summon === 'window') this.window(); else this.lift();
  }

  /** Dismiss (Esc, ✕, ⌥Space again): back to being the desktop, or hidden when the wallpaper is off. */
  hide() {
    const w = this.win;
    if (!this.desktopOn) {
      if (w.isFullScreen()) { w.once('leave-full-screen', () => w.hide()); w.setFullScreen(false); } else w.hide();
      return;
    }
    if (this.name === 'lifted') return this.sink();
    if (this.name === 'window') this.desktop();
  }

  /** The wallpaper switch changed. */
  sync() {
    if (this.desktopOn) { if (!this.summoned) this.desktop(); } // an open window stays one until it's dismissed
    else if (this.name !== 'window') { this.window(); this.win.hide(); }
  }

  /** Summoned to the user (visible and in front)? */
  get summoned() { return this.name === 'lifted' || (this.name === 'window' && this.win.isVisible()); }

  /** The renderer's clickable areas as the desktop: { rects: [{x,y,w,h}], all (a popover is open), held (dragging) }. */
  setHits(h) { this.hits = { rects: h.rects || [], all: Boolean(h.all), held: Boolean(h.held) }; this.checkPointer(); }

  /**
   * As the desktop the window ignores the mouse except over ARES's own things. macOS doesn't pass mouse moves to a
   * click-through window of an app that isn't active, so the pointer is checked here instead, against the areas the
   * renderer reports: clicks land on panels, orbs and buttons whichever app is active, and everywhere else they go
   * to the desktop and its icons.
   */
  checkPointer() {
    const desk = this.name === 'desktop' || this.name === 'sinking';
    if (!desk) { clearInterval(this.hitTimer); this.hitTimer = null; return this.setInteractive(true); }
    this.hitTimer ??= setInterval(() => this.checkPointer(), HIT_MS);
    const p = screen.getCursorScreenPoint(), b = this.win.getBounds();
    const x = p.x - b.x, y = p.y - b.y;
    const over = this.hits.all || this.hits.held
      || this.hits.rects.some((r) => x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4);
    if (over !== this.interactive) this.setInteractive(over);
  }

  setInteractive(on) {
    if (this.name === 'desktop' || this.name === 'sinking') {
      this.interactive = on;
      this.win.setIgnoreMouseEvents(!on, { forward: true });
    } else {
      this.interactive = true;
      this.win.setIgnoreMouseEvents(false);
    }
  }
}

module.exports = { Surface };
