STEP 0, SAFETY FIRST (only if the project isn't a git repo yet): git init with a thorough .gitignore (.env and any keys/tokens, android keystores + keystore.properties, google-services.json, user data like memory/contacts/voiceprint, models/brain-src, dist/, node_modules/, build outputs). Scan for secrets and show me the results BEFORE the first commit. Make a baseline commit, tag it pre-wallpaper, and commit after each working step below. (The full reliability work is a later session: docs/reliability-prompt.md.)

Build "ARES everywhere on the Mac": a live desktop wallpaper, an ARES screen saver, and a matching lock-screen still. See the project notes. This comes AFTER the GUI update (docs/gui-update-prompt.md) is built; reuse its scene: renderer/stars.js, the brain (brain3d.mjs), the R2 halo and R4 pedestal, and the job orbs.

1. LIVE DESKTOP WALLPAPER (unlocked Mac)
- A separate Electron BrowserWindow per display, sitting at DESKTOP level: behind all app windows AND below the desktop icons (macOS type:'desktop' or the right window level, verify on this macOS version), covering the display's full bounds, visible on all Spaces, not in the Dock, Cmd-Tab or Mission Control, and never taking focus.
- Fully click-through (setIgnoreMouseEvents(true)), so desktop icons, Finder and right-click all work normally.
- Renders the ARES scene: the C1 stars, the brain slowly rotating, the breathing halo, the pedestal, and the job orbs orbiting when work is running. No panels, input or chat log on the wallpaper. At most an optional very subtle clock and greeting (a setting, default off).
- LIVE-CONNECTED to the running ARES (the same main process, over IPC): the halo reacts to real listening and speaking levels, neurons fire on the wake word, the colour eases to violet while thinking, and orbs follow the real job states. It must feel like ARES herself is the desktop.
- Summoning: "Hey ARES" or ⌥Space brings the normal ARES window to the front as today. When it's dismissed, she's just the wallpaper again. The wallpaper and the main window share one ARES (one brain, one listener); the wallpaper is only a second view.
- Performance and battery (important):
  - Pause rendering completely when the desktop isn't visible: a full-screen app is in front, or the desktop is fully covered (use a small native helper (Swift, CGWindowList) if Electron can't tell reliably), the screen is locked, or the display sleeps.
  - Render at 30 fps (60 only while she's actively listening or speaking), and at 15–20 fps with a simpler scene on battery.
  - Also drop to a still frame when Low Power Mode is on.
  - Measure CPU/GPU before and after and report it to me.
- Multiple displays: the wallpaper on every display, or only the main one (a setting).
- Tray toggle "ARES as wallpaper" (default ON once built), persisted in settings. Turning it off restores the normal desktop instantly.
- Launch at login already exists; the wallpaper starts with ARES.

2. ARES SCREEN SAVER (idle Mac, before lock)
- Build a native macOS screen saver (.saver bundle, Swift ScreenSaverView + WKWebView) that shows the ARES scene animating: stars, brain, halo breathing, pedestal. Build our own small one rather than a third-party screen saver.
- It runs standalone from bundled local files (no network, nothing exposed), so it works even if ARES isn't running. If ARES IS running, optionally reflect a simple state (e.g. "jobs running" orbs) through a small read-only local file ARES writes. Never open a network port for it.
- Sign it with the existing "ARES Local Signing" identity. Install into ~/Library/Screen Savers, and walk me through selecting it in System Settings → Screen Saver (I choose it myself).
- Keep it light on battery (30 fps cap, simpler on battery).

3. LOCK SCREEN STILL
- macOS doesn't allow live third-party lock screens, so render a high-resolution STILL of the ARES scene (brain + halo + pedestal + stars, no text) at each display's native resolution, using an offscreen render of the same scene, saved as PNG in the ARES support folder.
- Set it as the macOS desktop picture, which the lock screen shows, per display. Ask me before changing my wallpaper the first time, and save my previous wallpaper so a tray item "Restore my original wallpaper" (and turning the feature off) puts it back exactly.
- Optionally re-render occasionally, e.g. a warmer tint in the evening (a setting, default off).
- It's fine that the live wallpaper window covers the still while unlocked; the still is what shows when locked and briefly at login.

3b. DESKTOP ICONS vs THE WALLPAPER
- Default: ARES works AROUND my desktop icons. Read their positions from Finder's scripting interface (desktop position of every item on the desktop), and re-check when items are added or moved (watch ~/Desktop).
  - Keep the brain, halo and job orbs clear of the icon area (shift the composition smoothly).
  - Gently darken and dim the stars behind icon clusters, so labels stay readable.
- Toggle in the ◉ menu: "Hide desktop icons while ARES is the wallpaper" (the Finder/Desktop & Dock "show items on desktop" preference). Ask the first time, save my original setting, and restore it when switched off. Files stay in ~/Desktop; nothing moves.

4. SAFETY and HYGIENE
- No system-file hacks, SIP changes, or replacing Apple's aerial videos. Only supported APIs.
- Everything can be switched off from the ARES tray, and switching off fully restores my setup.
- Test on my real Mac: icons clickable, windows above it, Mission Control/Spaces normal, pause when covered, battery impact reported, screen saver selectable, lock screen shows the still. Build with npm run build, restart ARES and verify.
