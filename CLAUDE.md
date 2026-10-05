# ARES: notes for Claude sessions

ARES is a personal Electron assistant (main process: `main.js`; renderer: `renderer/`; Android app: `android/`).
Build and install with `npm run build`. The support folder is `~/Library/Application Support/ARES`.

## Don't spend the user's ElevenLabs credits on testing

- **Dev builds (`npm start` / `npx electron .`) speak with the free local backup voice** (Kokoro, `voice.js` +
  `kokoro-worker.js`), not Katherine. Keep it that way. Only set `ARES_DEV_ELEVEN=1` when the user explicitly
  asks to test with Katherine.
- Test scripts that need TTS must use Kokoro or mock ElevenLabs. See `scripts/test-voice.js`, which mocks
  `fetch` and costs nothing. Never loop real ElevenLabs TTS requests in a test.
- The installed app has the same option in the menu bar: "Use Backup Voice While I'm Building/Testing".
- To force a fallback test without spending credits, use an invalid key (`ELEVENLABS_API_KEY=sk_invalid…`
  in the environment). A rejected key costs nothing.

## Never touch the phone line from voice work

The phone agent ("ARES Calls", Hope voice, Twilio number) runs in ElevenLabs' cloud. Don't change its
voice, model or config, the Twilio number's primary webhook, or `calls.js` call paths as a side effect of
other work. Voicemails from the Twilio fallback are read-only, in `voicemail.js`.

## Testing a running instance

Use an isolated dev instance: `ARES_USER_DATA=/private/tmp/ares-harness-… ARES_PHONE_PORT=8799
ARES_TEST_PAIR_CODE=… npx electron . --remote-debugging-port=9334`, and drive it over CDP (Playwright
`connectOverCDP`). Symlink `models/kokoro-v1_0` from the real support folder into the harness. A plain dev
run without `ARES_USER_DATA` shares the user's real jobs and paired phones.

## Git

The project became a git repo on 2026-10-01. Commit after each working step. Secrets (`.env`, keystores,
`google-services.json`) and large models are gitignored. Never commit them.

## Wallpaper, screen saver, lock-screen still

- `wallpaper.js` (main) + `renderer/wallpaper.{html,js,css}`: desktop-level windows, a second view of the one ARES
  (`renderer/scene-link.js` mirrors the window's scene). `native/AresDesktop.swift` (`ares-desktop`) reports when the
  desktop can't be seen and gets/sets desktop pictures. All settings live under `wallpaper` in settings.json.
- Testing: the dev instance shows a real wallpaper window on the real desktop. Capture only that window
  (`screencapture -l <CGWindowID>`), never the whole screen. `ARESWall.hold({...})` in the wallpaper page forces a
  mode for measuring. `ARES_TEST_STILL=/path/prefix` (dev only) renders the lock-screen stills to files without
  setting the desktop picture. Don't change the user's desktop picture from a test.
- Screen saver: `scripts/build-saver.sh` (also run by `npm run build`) → `~/Library/Screen Savers/ARES.saver`.

## Live desktop and desk mode

- The ARES window is the desktop (`surface.js`: desktop / lifted / window; `renderer/surface.js`: looks, click-through
  hit-testing, pacing). The wallpaper windows are the backdrop below the icons. Icons → `dash.js` walls.
- Desk mode: `desk.js` (when), `addressed.js` (is it for her), voiceprint always checked without the wake word.
  Overheard speech is never logged as text, sent to the brain or shown as subtitles; keep it that way.
- Dev-only test hooks (ignored when packaged): `window.ares.surface.test('show'|'window'|'hide')`,
  `testHear({type:'command', text, addressed:false, trusted})`, `testDesk({mic, idleMin})`, `Surface.hold({...})`.
  The dev instance can't share the mic with the installed ARES, so inject speech instead.

## Claude Code remote control (docs/claude-control-prompt.md)

- `claude-sessions.js` reads Claude Code's files read-only: transcripts (head/tail only, they get huge), the live
  registry `~/.claude/sessions/<pid>.json` (busy/idle, which client) and the desktop app's titles. `claude-control.js`
  does hooks, replies, new sessions and Remote Control; `redact.js` cleans anything that leaves the Mac.
- Never write into a session another client has open (the desktop app keeps every Code session's process alive).
  Closed sessions continue with `claude -p --resume`; open ones get a fork only when the user asks.
- Sessions ARES runs are jobs of kind `code` (jobs.js `runCode`/`gateCode`, sandbox `writeCodeProfile`/`classifyCode`).
  They and every other ARES Claude process use `--setting-sources ''`, so the user's global hooks never fire for ARES.
- Global hooks: `node scripts/claude-hooks.js` shows the settings.json diff, `--write` applies, `--remove` undoes.
  They run `~/Library/Application Support/ares/claude-hook.sh` (copied from tools/), which posts to ARES using
  claude-hook.url/.headers (written at launch, removed on quit) and always exits 0. Not async: async hooks are
  killed when a `-p` session exits.
- Remote Control from ARES: `script -q /dev/null claude --remote-control <name> [task]` with stdin from /dev/null
  (a pipe makes `script` fail). Needs the folder trusted in Claude Code. Don't run `claude remote-control --help`:
  it starts the server.
- Testing: the dev instance's hook files live in its own ARES_USER_DATA, so real hooks only reach the installed app;
  test with `claude -p … --settings '{"hooks":{"Stop":[…"<harness>/claude-hook.sh"…]}}'`. Set ARES_CODE_MODEL=haiku
  for test code sessions. Don't start test sessions in the user's real projects.

## ARES OS theme (docs/ares-theme-prompt.md)

- `theme.js` (the ◉ "ARES Theme" switch, apply/restore/verify) + `theme-prefs.js` (originals, CFPreferences through
  `native/AresTheme.swift` → `ares-theme`) + `theme-bar.js` (SketchyBar, JankyBorders) + `theme-dock.js` / `renderer/theme-dock.*`
  + `theme-icons.js` / `renderer/theme-art.*` + `theme-notify.js` / `renderer/theme-toast.*` + `theme-apps.js` (Terminal, VS Code, Chrome).
- Every original is saved once in `<support>/theme/originals.json` before anything changes; switching off restores them all
  and compares (`theme/last-restore.json`). Never write a theme setting without going through `Originals`.
- SketchyBar and JankyBorders come from Homebrew (felixkratz/formulae, both formulae trusted). ARES starts them itself with its own
  config in `~/.ares/sketchybar` (SketchyBar runs config and item scripts through `sh -c` unquoted, so no spaces in that path);
  no launch agents, nothing in ~/.config. `sketchybar --query bar` exits 0
  even with no bar running: check with `pgrep -x sketchybar`. The bar hides itself in full-screen Spaces (by design).
- The bar COVERS the macOS menu bar (topmost, same height; the menu bar itself stays at the user's own "never hide"):
  the front app's menus come from Accessibility (`ares-theme menubar/menu-items/menu-press`), ARES's own from `menuSections()`
  in main.js (the ◉ menu is the same sections joined). Mirrored icons are SketchyBar aliases (Screen Recording for SketchyBar).
- Offline: `~/.ares/sketchybar/offline.sh` (run on quit, and by the `ares.watch` item if ARES's pid in `<support>/theme/ares.pid`
  dies) puts the user's Dock settings back and lowers the bar; `resumeDock()` re-applies on launch. A dev harness
  (ARES_USER_DATA set) uses `~/.ares/sketchybar-dev` so it never rewrites the installed bar's scripts.
- Blended (theme live): summoning lifts ARES without glass or chrome and stays click-through except over her things;
  a lift for one panel (bar/dock/notification: `showWindow(panel)`) shows only that panel and sinks when it closes.
- Voice ID keeps itself current (`voiceid.js learn`, anchored to the enrolment); desk mode's "NOT MATCHED" flash and the
  drift warning in the Desk Mode menu come from it. Never learn from rejected speech except the near-miss rule.
- Drop-downs: every owner (ares.mark, ares.status, ares.jobs, menu.N) has ROWS rows made once in sketchybarrc; ARES only
  fills (`Bar.popup(…, show=false)` on hover) and shows them. Never add/remove popup items per open (that's the empty-frame
  lag). Rows highlight via row.sh inside SketchyBar. Theme callbacks into main must not touch `win` while quitting.
- The status pill and WORK drop-downs are ARES windows (`theme-drop.js`, `renderer/theme-drop.*`), not SketchyBar popups:
  filled on hover, shown after the pause, closed when the pointer leaves both them and the pill. A pointing-hand cursor
  isn't possible over any ARES overlay while another app is in front (tested 2026-10-04: macOS keeps the arrow).
- The pointer colour can't be written (com.apple.universalaccess is protected): the menu walks the user through it.
- Testing: `ARES_TEST_THEME=dock,notify,art,bar` in a harness brings up parts without touching settings; `apply` / `restore`
  change the REAL Mac (ask first). Running the standalone `Bar` against the live bar changes the real glow colour; reset it after.

## Hand gestures (docs/hand-tracking-prompt.md)

- `native/AresVision.swift` (`ares-vision`) is the ONE camera owner (face/gaze later join its request list). Frames never leave
  it: only joints, a face box and key-idle seconds go out as JSON lines. `hands.js` is the pure gesture engine (poses, interaction
  box, pinch/click/drag, two-finger swipe/scroll, two-hand zoom, guards, watching→engaged→watching); `vision.js` (main) runs the
  helper + engine and holds the camera rules (switch on, desk mode active, no Low Power Mode; lid in the helper); `renderer/hands.js`
  turns actions into the SAME pointer events and Dash/Comms calls the mouse uses (no second copy of the interactions).
- Thresholds live in settings `hands.tune` (see `DEFAULTS` in hands.js). The switch is `hands.enabled`, default off.
- Mac mode (`hands.mac`, default on): the hand drives the Mac's own pointer through `ares-theme pointer` (CGEvents, under ARES's
  Accessibility grant): a pinch is a real click/drag anywhere, two-finger drift a real scroll; ARES's panels get it through the
  normal mouse path. Swipes, zoom and the palm stay ARES's own. Off: the window gets synthetic pointer events (scene only).
- The camera stays on through "go quiet" (that's about listening); it follows the rest of desk mode's conditions.
- Tests: `node scripts/test-hands.js [-v]` replays synthetic clips (`scripts/hands-synth.js`) and any recorded clips in
  `<support>/hands/clips`; every positive must fire, no negative may. Record clips from the ◉ menu (dev only, joints only).
  In a harness, `Hands.test(clip)` in the window replays a clip through the live engine (`vision.replay`; the camera rules hold
  off for 30 s after). The main process doesn't hot-reload hands.js: restart the harness after engine changes.
- The helper is a real .app bundle ("ARES Vision.app", in Resources): a bare binary is refused the camera without a prompt. The prompt names ARES Vision.

## Full Mac control and remote-first (docs/autonomy-prompt.md, sections R and 0)

- `control.js` (main) does everything: folder scope (Desktop, Documents, Downloads, iCloud Drive + `control.folders` in settings;
  blocklist: ~/Library, dot-folders, keys, .env, password stores, ARES's code and support folder), the tiers (1 acts, 2 needs the
  owner and is logged, 3 needs the user's own "yes" through the bridge's `confirm`), the audit log (`audit.js` →
  `<support>/audit.jsonl`), and the sendbox (`/api/files/<id>` on the phone server, paired phones only, 24 h). The brain's tools
  are `tools/control-tools.js` (registered by `tools/mac.js`) → bridge `/control/<route>` → `control.handle`.
- `native/AresControl.swift` (`ares-control`): lock/sleep state, windows, window moves, the Accessibility element tree and actions,
  CGEvent clicks/typing/keys, PDF text (OCR for scans), OCR, the on-screen highlight. Screenshots are `screencapture -l <wid>`.
- UI automation: `ui_elements` then one `ui_act` per step, highlighted; RISKY titles / `irreversible: true` are tier 3. "Stop" (voice,
  `stopSpeaking`) and Esc (armed only while she drives) call `control.abort()`, which holds `ui_act` for that bridge turn.
- Screen-needing tools say plainly when the screen is locked/asleep (`screenNeeded`); everything else is designed to work locked.
- "Stay Reachable From My Phone" (settings `stayReachable`, default on) = `applyReachable()`: no idle sleep on power only.
- Testing: `npx electron scripts/test-control.js` (reads only, scratch folder in ~/Downloads, fake push, no Claude call; `--live` adds
  the highlight). Never run `--live` or UI automation tests while someone is using the Mac. Android: Files.kt (file buttons download
  through the paired connection and open), Outbox (asks queued while the Mac is offline, sent on `hello`, answered as notifications).
