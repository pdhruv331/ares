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
  dies) puts the user's Dock settings back and QUITS the bar and JankyBorders (since 2026-10-05; before, the bar stayed up saying
  "ares offline"); `resumeDock()` re-applies on launch. A dev harness
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

## Autonomy (docs/autonomy-prompt.md, sections 1-5)

- `autonomy.js` (main) on top of jobs.js: PROJECTS = code jobs with `project` meta in `~/ARES Projects/<slug>` (git init, BRIEF.md,
  `PROJECT_PROMPT` in jobs.js, the session keeps `.ares/status.json` {phase, note, tests, run, url} which `syncProject` polls);
  on finish `verifyProject` grades against the definition of done with a one-shot (haiku/sonnet) and sends the session back once
  (`verifyRounds`), then zips + pushes to the phone. GOALS = a one-shot plan of steps run as jobs in sequence (source `goal`).
  ROUTINES = schedules ({daily hour/minute/days | interval | event unlock/wake}) ticked every 30 s, each run a job (source `routine`).
  Suggestions: `observe`/`suggestion` notes a repeated request for the brain to OFFER a routine once; never creates one.
- Tiers: `start_project` is tier 3 (the brief read back + the user's yes through the bridge gate); goals/routines tier 2 (owner);
  code sessions: `sandbox.classifyCode` (push/deploy/publish = ask, installs = tier 2 logged). Everything goes to `audit.jsonl`
  (Work panel LOG tab). Settings `autonomy`: maxProjects 1, maxJobs 2, maxRunMin 90, maxRunsPerDay 20, usagePauseAt 85.
- Kill switch: "stop everything" (KILL_PHRASE in main.js, before the brain), ◉ menu "Pause All Autonomous Work", the phone's STOP ALL
  and the notification's Resume all (`/api/autonomy/*`). `stopAll` pauses jobs (`jobs.pause`, status `paused`), holds goals and
  routines; `resume` per item or everything. Near the usage limit, running projects pause and resume on their own.
- UI: Work panel tabs JOBS/PROJECTS/GOALS/ROUTINES/LOG (renderer/work.js), project box + buttons, amber approval boxes, project orbs
  larger (`ORB_SIZE.project`) with labels (work.js labelLoop); phone Work view tabs + STOP ALL (phone/work.js), Android "ROUTINES" chip.
- Tests: `node scripts/test-autonomy.js` (fake runner, no Claude usage); `--real` runs one tiny haiku project end to end.

## Panels v2 (docs/panels-prompt.md)

- Layout: `renderer/flow.js` is the ONE layout pass (pure; also run by `node scripts/test-panels.js`): docked panels flow down each
  side in rank order, each at its own density; the brain, the desktop icon walls and free (hand-placed) panels are obstacles; the
  least important panels (contextual before pinned, oldest first) step down when a side runs out of room. `dash.js` measures every
  panel's `.dp-view` with one ResizeObserver, calls `layout()`, and glides (~0.45 s). A column wider than a standard panel (the
  calendar in WEEK, an open card) makes the brain shift aside (`placeBrain(strips)`). Never add a second layout path.
- Views (`renderer/panels.js`, registered with `Dash.view(name, …)`): the content sizes the panel at FULL; compact/mini use the
  standard rows from the spec. Clicks inside a view go through `[data-act]`. Pins live in `prefs.panels[kind]` (`{pinned, side, rank}`
  or `{pinned, fx, fy}`; `pinned:false` is explicit so the calendar's default pin stays off once unpinned). `Dash.feed(msg)` injects
  a dashboard message for tests.
- Calendar: `native/AresCalendar.swift` → "ARES Calendar.app" (launched with `open -a … --args --serve <sock>`, like Vision, so the
  Calendars/Reminders prompt names it); `calendar.js` (EventKit client, `EKEventStoreChanged` → refresh, tiered add/move/delete as
  `control.routes['calendar/…']`), `dashboard.js`'s connector read is the fallback (`dashboard.external`). The helper's `keychain`
  subcommand is the only Keychain path (secret on stdin/stdout, never argv).
- Tasks: `tasks.js` — Google Tasks (OAuth "Desktop app" client JSON picked in a dialog, loopback + PKCE, refresh token in the
  Keychain under "ARES google-tasks-refresh") or Apple Reminders through the same helper. Custom panels: `custom-panels.js`, specs
  in `<support>/panels/<id>.json`; shell commands need a one-time yes (tier 3) and live in settings `panels.allowedCommands`;
  "ask Claude" sources are haiku one-shots ≥ 30 min apart that pause on the usage reserve. Brain tools: `tools/panel-tools.js`.
- Testing: `node scripts/test-panels.js` (solver invariants + fakes for EventKit, the Tasks API and every custom source; no helper,
  no Claude, no network). Visual: `node scripts/harness.mjs start|reload|eval|shot` drives a dev instance over CDP (start it
  yourself with `--disable-backgrounding-occluded-windows` etc. when it's covered, and `Surface.hold({paused:false})`).

## Reactor look (docs/reactor-prompt.md)

- `renderer/reactor.js` is the ONE drawing engine (pure canvas: `Reactor.Engine` = the arc reactor, `Reactor.Backdrop` = the dot-matrix
  schematic sheet + ripples); `renderer/scene.js` runs it on every page (window, wallpaper backdrop, saver, lock still): the
  look switch (`Scene.setLook`, settings `look`, ◉ menu "Look: Reactor / Brain", default reactor), job orbs in orbit (click,
  grab → throw, into the reactor = put away / cancel → `orb-absorbed`), the callout lines/labels, and the `window.JobOrbs` proxy
  (reactor orbs, or brain3d's `JobOrbs3D` in the brain look). `renderer/callouts.js` (window only) = the cards, live values and
  actions; `renderer/overlap.js` = the translucency rule (covered things fade to 20%); `readouts.js` (main) = HOST/CLAUDE/BATTERY
  values pushed to the window (`readouts` IPC) and the backdrop (`wp-scene {type:'readouts'}`), and the tier-2 actions.
- The brain look's scripts (stars.js, neural.js, brain3d.mjs) keep running but draw nothing while `window.SCENE_LOOK === 'reactor'`;
  neural.js's `HUD` is still the one state/level/pulse API every page talks to (`HUD.live()` carries pulse/attention/offline).
- Geometry: radius = min(26% of the stage height, 22% of its width), centre 3% below the middle; the flow obstacle is 1.5× that
  (dash.js `brain()`). Two backdrop canvases: `#sheet` (the dots and schematic, rendered once per colour/geometry) and `#matrix`
  (sweep + ripples, 1×, ≤ 30 fps). Never call `resize()` per frame: reallocating a display-sized canvas every frame cost 30% CPU.
- Under the live desktop the backdrop window draws only the sheet, centred on the window's reactor (the `spot` scene message
  carries `cx, cy, r` in screen px); the window draws the reactor, orbs and callouts (`#matrix`/`#sheet` hidden there).
- Testing: `node scripts/harness.mjs eval` (and `ARES_HARNESS_PAGE=wallpaper.html` for the backdrop page); `Surface.hold({paused:false})` /
  `ARESWall.hold({paused:false})` to draw while covered; `JobOrbs.sync([...fake jobs])`, `Callouts.open('claude')`,
  `Scene.orbs.throw(id, vx, vy)`, `Scene.orbs.fadeOf(id)`, `Overlap.tick()`. Measured 2026-10-05 (window + backdrop, held at full
  rate): reactor 8% CPU on power / 7% on battery vs the brain's 23% / 11%.

## Ignition, standby, power down (docs/ignition-prompt.md; part A = the Mac side)

- `renderer/ignite.js` is the ONE module for the visuals (title block with the "·" on the centre line, the power notch, the
  charge/wake/standby/spin-down `Controller`, the ghost log); `renderer/scene.js` runs it on every page as `Scene.power` and
  drives `Reactor.Engine`'s `cold` / `forceHue` / `pace` / `coilsLit` / `hum`. The cold still is the floor: nothing dims below it.
  The wallpaper/still/saver pages are replicas (`window.SCENE_REPLICA`, from `?mode=`); the window and the helper take the holds.
- Geometry: `?geo=cx,cy,r` (renderer/scene-boot.js → `window.SCENE_GEOMETRY`) places the reactor identically in the still, the
  helper and the live window; wallpaper.js remembers the window's `spot` per display (settings `wallpaper.spots`, `geometryFor`),
  and ignition.js writes `<support>/ignition/geometry.json` for the helper.
- Main: `ignition.js` (the helper's UNIX socket `<support>/ignition/ignition.sock`, start-up steps memory/voice/brain/ears/link/scene,
  `ares.pid`, the shutdown record `shutdown.json` → clean/crash/restart/update for the wake line, helper launch on quit, LaunchAgent
  `com.dhruv.ares.ignition`), `power.js` (standby: listener muted with the prior state kept, `desk.hold`, auto standby; power down:
  the real steps in reverse then quit), `wakeline.js` (template pools, never the last 20). The window side is `renderer/power.js`
  (+ `renderer/sounds.js`, WAVs from `node scripts/make-sounds.js` into renderer/sounds/). Settings live under `power`.
- The helper is `native/AresIgnition.swift` → "ARES Ignition.app" (a WKWebView loading native/ignition.html with copies of the
  renderer's scene files; build-app.sh copies them). It runs only while `ares.pid` is dead, is click-through outside the reactor's
  circle (pointer polled at 15 Hz), registers ⌥Space with Carbon only while ARES is off, and exits after the handover. Packaged
  builds launch it on quit; in development only with `ARES_IGNITION_HELPER=1` (it puts a window on the real desktop: ask first).
- POWER DOWN DOES NOT QUIT (decided 2026-10-06: a process launch can't be seamless, the theme restart blinks the screen). It plays the
  spin-down then goes DORMANT (`power.js`): every service stopped by `sleepServices()` in main.js (listener, camera, phone, Telegram,
  calls, voicemail, dashboard, calendar, tasks, panels, speech; routines held via `autonomy.dormant`), the window keeps drawing the cold
  gold reactor at 4 fps, the theme bar stays up with a gold ◉. Waking (`power.wake`: core hold, ⌥Space, menu) runs `wakeServices()`,
  which reports the steps through ignition.js so the window plays the same charge. The ONLY true quit is ◉ → "Quit ARES Completely"
  (`power.quitFully`; `before-quit` turns any other quit into a power down unless `powerMonitor` said the Mac is shutting down).
  The helper then matters only at login and after that quit. ⌥⇧Space toggles standby; "power down" by voice is caught before the brain.
- Transitions live in ignite.js's Controller: the amber tick sweep follows the charge (and the notch hold), a 0.55 s flare precedes a
  spin-down from standby, the callouts draw in after every wake (`calloutK` → `Ignite.calloutReveal`, used by scene.js). Mockups with
  the real code: `docs/mockups/ignition-opening.html` and `ignition-transitions.html` (serve the repo over HTTP and open them).
- The ears open AFTER the wake (2026-10-06): starting or stopping the listener's microphone engine (voice processing) reconfigures the
  output device and stutters whatever is playing. A cold start and a wake from dormancy set `earsPending` and `openEars()` runs on the
  window's 'online' (fallback 9 s); standby mutes the ears 1.6 s in and un-mutes 1.2 s after the chime (power.js `earsTimer`); a listener
  spawned muted gets `--muted` (engine off until unmute). A spin-down re-renders the OFFLINE still (a quit from standby left the standby
  still under the helper's cold reactor) and the full quit waits for that render.
- Lessons (2026-10-06): `open -j` keeps every window of ARES hidden (never use it); `loadFileURL` throws on a file URL with a query
  (the helper injects geometry as a user script); a `.prohibited` activation policy forbids windows; macOS can report a new desktop
  picture while still showing the old one (wallpaper.js reads it back and retries; keep the previous still file until then).

## Power from the phone and the relay (docs/ignition-prompt.md part B: 4d, 4e, 4f; built 2026-10-06)

- What the phone wakes through (decided with part A's dormancy): DORMANT = the phone server stays up COLD (`phone.setCold`: only
  `/api/power`, status, events, me, app answer; the rest say 503 "powered down"), so the orb hold wakes her over the normal paired
  channel. FULLY QUIT = the ignition helper polls the relay (`/helper/poll`, every 20 s, signed with the Mac's secret from
  `<support>/ignition/relay.json`, 0600) and ignites on a wake the phone posted (`/wake`, signed with that phone's own WAKE KEY, which
  the Mac registers with its push token: `phoneDevices[].wake`, id = hash[0:16]). MAC ASLEEP = nothing answers and the helper's
  heartbeat at the relay is stale (> 6 min; written at most every 4 min: KV's free tier allows 1000 writes a day) → "Mac asleep · can't
  wake". The relay is used for nothing else; ARES itself never talks to it for power.
- Mac: `phone.js` powerRoute → main.js `powerAct` (standby | wake | powerdown | toggle | skip) and `powerView` (mode, status, schedule,
  steps while charging); `hello` carries `power` and `relay {url,id,key}`; power changes broadcast as `{type:'power', …powerView}`,
  charge steps as `power-step`. `power.keepAwakeOff` ("Keep the Mac Awake on Power While ARES Is Off", default off) is what
  `applyReachable` honours while dormant and what the helper's IOPM assertion follows (config.json). Power routines: autonomy.js
  `schedule.kind === 'power'` with `action` standby|wake (tool `create_routine` with `action`; one per action, a new time replaces),
  ticked even while dormant, 5-minute notice (`standby-soon`, buttons `/api/power/skip` and `/api/power/standby`), `skipPower`,
  `powerSchedule()` for the phone chip. Tests: `node scripts/test-autonomy.js` (power routines), `node scripts/test-relay.mjs` (the
  Worker with a fake KV). Deploy the Worker with `cd relay && npx wrangler@4 deploy` (done 2026-10-06).
- Android: `PowerStore` (the Mac's mode, reach, helper-alive from the relay, schedule, relay info), `ReactorView.power` (STANDBY blue
  winding down, OFFLINE gold, ASLEEP grey and still, CHARGING siphon + segmented ring + bloom, SPINDOWN) and `holdK`, `HoldDetector`
  (~0.8 s, ticks each eighth, heavy at the commit; a tap = talk/hush), `RelayClient` (HMAC with the wake key), the header's power
  icon → `dialog_power.xml` + `SlideView`, `Haptics`, `Sounds` (the same WAVs copied into res/raw by Gradle, quieter, in front only),
  the schedule chip. Notification `api` buttons may call `/api/power/*`.
- Testing without the phone: the emulator `ares-test` (`~/Library/Android/sdk/emulator/emulator -avd ares-test -no-window`), a DEBUG
  build (`./gradlew assembleDebug`: plain HTTP to 10.0.2.2 allowed), pair with curl against the harness (`ARES_TEST_PAIR_CODE`) and
  write the token into `shared_prefs/ares.xml` with `adb shell run-as com.dhruv.ares`; `adb shell input swipe x y x y 1000` is a hold.
  Screens are 1344×2992: scale screenshot coordinates. Starting a swipe at the left edge is the system back gesture.
- Not yet tested on the real Mac: wake from a full quit through the relay (needs the installed ARES quit) and the notices on the phone.

- Testing: a cold start replays in the window on reload (`node scripts/harness.mjs reload`; start the dev instance with
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding` or the charge crawls when covered); `window.ares.power.act('standby'|'wake'|'powerdown')`
  from the harness; `ARES_TEST_STILL` renders the offline and standby stills; the helper's page can be opened over HTTP from
  `native/build/ARES Ignition.app/Contents/Resources/ignition.html?geo=…&mode=ignition&power=cold` and driven with `Ignition.rx({...})`.

## The corner orb (docs/orb-prompt.md)

- `orb.js` (main) + `renderer/orb.{html,js,css}` + `orb-preload.js`: a ≈30 pt mini `Reactor.Engine` in a corner (settings `theme.orb`
  {enabled, corner br|bl|tr|tl, hideFullscreen}; ◉ → Theme Options). Shown when ARES runs but her desktop reactor can't be seen
  (`brainVisible()` false, not summoned, power online; dim blue in standby; gone when dormant/charging). It replaced the orb in the
  dock's centre slot (the slot is a spacer now). One panel window above everything, on all Spaces, never focused, click-through
  except over its own circle, menu, cards and chips (the page posts `orb-hits`; the pointer is polled like the dock's).
- `ares-theme orb-watch` (long-running): drag-in-progress (mouse held + drag pasteboard changed) so the window takes the drop and the
  orb swells as the pointer nears; the focused field's caret rect (`caret on`) so the orb fades to 15% within 40 pt. Needs
  Accessibility: the dev binary isn't trusted, so the caret fade only works in the installed app. `ares-theme front` / `refocus <id>`.
- Click = the portal: `orb.portal(true)` tells the window where the circle grows from (`portal` IPC → renderer/surface.js clip-path
  reveal with a bright edge, 0.6 s) then `showWindow(null, { solid: true })` (a SOLID lift: glass kept and every click taken even with
  the theme on, `surface.solid`; the blended lift would show her see-through over the apps); closing runs it back, sinks after 560 ms and refocuses the previous app.
  `hideWindow()` and ⌥Space go through the orb while its portal is open; a sink from elsewhere (Esc, a click on another app) resets it.
- Hold = push-to-talk: `listener.listen(30000, false)` (Voice ID still applies), release sends the listener `finish` (new command in
  AresListener.swift). The orb's turn lasts until `reply-done`; a tool in SCREEN_TOOLS (main.js) or an answer > 320 chars opens the
  portal. Captions: renderer/comms.js `mirror()` sends each sentence's schedule (segments, word starts, the clock) on the `scene`
  channel as `{type:'caption'}`; main routes it to the orb only; the orb page keeps time itself (a covered window gets no frames; a
  250 ms timer in comms.js keeps the clock snapshots coming). "Mute for 1 hour" = `orb.speechMuted`, checked in `tts-stream`.
- Drops run through the existing pieces: jobs.start with `inputs` (summarise), `control.handle('phone/send')` / `control.pushFile`,
  `orb-ask` → the window's `handle()` (start project: the brain proposes the brief, tier 3 stays with the bridge gate; explain; what's
  on my screen), `memory.add`, `tasks.add`. Files: `control.classify` → blocked refused, outside asks first (ALLOW ONCE card).
- Signals come from `orb.refresh()` (jobs list, `claudeCtl.sessions.list` cached 20 s, `liveCall()`, usage snapshot), `callEvent`
  (calls 'inbound', voicemail), `usageWarn` (80/95, once per window), `jobFinished` (result cards for jobs the orb started).
- Tests: `npx electron scripts/test-orb.js` (fakes + the real control.js scope rules; the window is real; nothing sent, no Claude).
  Live: `window.ares.orb.test('state'|'act'|'card'|'call'|'usage'|'drag'|'caret'|'context'|'portal'|'reload'|'metrics', arg)` from the
  harness; `ARES_HARNESS_PAGE=orb.html node scripts/harness.mjs eval …` reads the orb's page; screenshot with
  `screencapture -l <id>` (id from `test('state').media`). Idle renderer CPU measured 0% (2026-10-06).

## The ARES launcher (docs/launcher-prompt.md; Android, built 2026-10-08)

- `HomeActivity` (HOME category, own task affinity) is the home screen only if chosen in the system's Home app picker
  (`HomeActivity.chooseHome`, also in MainActivity's menu and the home long-press menu). MainActivity and the app icon are unchanged.
- `HomePager` = the two pages (0 reactor, 1 cards) + the upward swipe to the drawer (the dock reuses it with `pages = false`).
  `Apps` (LauncherApps listing, dock slots in prefs `dock`), `Icons` (monochrome layer tinted cyan, else desaturated; prefs
  `homeOriginalIcons`), `AppDrawer` (rows of four, letter rail, search → "Ask ARES", long-press shortcuts/dock/info/uninstall).
- The reactor and schematic are the app's own views with `maxFps` (30/20 on home) and `still` (Power Saving). Hold-to-talk only inside
  the circle; the view's corners belong to the page's long-press menu. `Bubble.home(true)` hides the floating bubble while home is up.
- Cards: NEXT from the phone's calendar (READ_CALENDAR, asked when page 1 first opens), WORK from JobStore (OK = `/api/jobs/<id>/answer`,
  STOP ALL = `/api/autonomy/stop` after a confirm), SYSTEMS from `/api/status` (hidden while unreachable) + the phone's battery.
- Testing: emulator recipe as in "Power from the phone"; `adb shell cmd package set-home-activity com.dhruv.ares/.HomeActivity`, and back to
  `com.google.android.apps.nexuslauncher/.NexusLauncherActivity` after. For jobs/approvals without Claude, point the app's `url` pref at a
  small fake phone server (ndjson `/api/events` hello + `job` messages; track lines with `res.on('close')`, not `req`). The emulator's
  software GPU pins RenderThread for the reactor (home 27 fps vs the app's 21): measure battery on the real phone. Saver mode needs
  `dumpsys battery unplug` first on the emulator.
- Round 2 (docs/launcher-v2-prompt.md, built 2026-10-08): `Scheme` (colour schemes; the power states keep fixed blue/gold), Standby / Wake /
  Power down… and Colour scheme… in the home long-press menu (`PowerSheet` shared with the app), readouts NEXT + SERVER that open in place,
  `Reorder` (hold-drag for the dock and the cards; a drop must happen once: rebuilding the row CANCELs the touched view), the drawer's
  YOUR ORDER (`DragFrame`, prefs drawerOrder/drawerSort), `AresNotifs` + `NotifStore` (Notification access; orbs, spark, reply by voice through
  the notification's own action, SUMMARISE is the only path to the Mac, calls via CATEGORY_CALL) drawn by `HomeOverlay` (also the meeting
  ring, the Mac link, the Buds earpieces), modes (morning / meeting soon / night / at the Mac from /api/status idle+locked), Buds via
  AudioDeviceCallback, and assistant summons listen on the home screen (`HomeActivity.listenHere`). Captions are small and muted on purpose.
- Page 2 is the board (2026-10-09): `HomeGrid` (four columns, items packed in order, hold-drag; the intercepted UP/CANCEL is handled in
  onInterceptTouchEvent) + `HomeBoard` (prefs homeBoard: apps, widgets via AppWidgetHost HOST_ID 0x4A12, the ARES cards). Calls also come from
  the phone's ringing state (READ_PHONE_STATE + ANSWER_PHONE_CALLS, home menu "Calls on the home screen…"); emulator: `adb emu gsm call <n>`,
  `adb emu sms send <n> <text>` (Google Messages gives a real reply action).
- Debug-only hooks: `adb shell am broadcast -a com.dhruv.ares.TEST_CALL [--es name Mom]`, `…TEST_MODE --es mode night|morning|meeting|desk|none`,
  `"am broadcast -a com.dhruv.ares.TEST_BUDS --es name 'Galaxy Buds Pro 4'"` (quote names with spaces inside the adb shell string).
  Notification access on the emulator: `adb shell cmd notification allow_listener com.dhruv.ares/com.dhruv.ares.AresNotifs` (again after
  each reinstall); test notifications with `cmd notification post` (they come from "Shell").

## Phone UI v3: fluid motion, presence, cards, receipts (docs/phone-ui-prompt.md; built 2026-10-10)

- `Motion.kt` is the ONE motion kit: M3 Expressive spring tokens (FastSpatial 0.6/800 … SlowEffects 1/800, `TapSpatial`/`TapSlow`
  for taps at damping 1), `Motion.to(view, prop, target, spec, velocity)` retargets a running spring (never restarts), `Motion.Value`
  for sprung numbers, `band`/`rubber` for edges, `stagger` for rows. Everything honours "Remove animations" (`Motion.enabled`).
  No `animate()`/`ValueAnimator` durations are left on gesture paths; keep it that way.
- `HomePager` tracks 1:1, releases with the finger's velocity (`release` → `go(target, velocity)`), rubber-bands at both ends, and
  hands an upward drag to the drawer (`onSheetDrag`/`onSheetRelease` → `AppDrawer.track`/`release`); the drawer is a sheet on
  `Motion.Value` (SlowSpatial), rows stagger in, the list's bottom rides the IME frame by frame. `Reorder`/`HomeGrid` glide the
  others on retargeted springs and re-parent only when the drop's spring settles (no CANCEL under a finger). The bubble keeps the
  throw's velocity (`snap(vx, vy)`). Predictive back: HomeActivity's `backScrub` (registered only while there's something to go
  back from), AskActivity and ReceiptActivity scrub with `OnBackAnimationCallback`.
- `ReactorView` states are shapes (sprung `coilOpen`, `coreK`, `beat`, `ringK`): listening opens the coils, thinking contracts and beats
  ~1 Hz, speaking's ring follows the voice, idle after a turn settles with one overshoot, `interrupt()` collapses in < 100 ms.
  Frame pacing: `hot(key, on)` votes (`pace()`: `requestedFrameRate` where the panel has ARR, else the old throttle; the pager's
  `onMoving` marks it hot so a swipe never runs at 30/120 mixed). `Haptics` is the vocabulary (listen/tick/commit/land/approval/
  settle/error); `Sounds` = three WAVs copied from renderer/sounds (in front only, home menu "Sounds").
- THE PRESENCE (`AskActivity`): the reactor grows out of the bubble's rect (`from`, SlowSpatial) over whatever app is up, captions and
  cards under it, condenses back (`condense()`, then `Bubble.presence(false)`). The bubble hides while it's up. Listening starts a
  beat after the grow (`soon`), because opening the recogniser stalls the main thread and would swallow the spring. A card that opens
  an app leaves the bubble's "back to ARES" arc for 30 s (`Bubble.returnChip`); the next tap restores the card from `Cards.lastRect`.
- CARDS: Mac `cards.js` (catalogue + `validateCard`) ← tool `show_card` (tools/mac.js) → bridge `/card` → `onCard` → the ask stream's
  `{type:'card'}`; phone `Cards.kt` draws only known kinds (summary, list, event, place, file, image, progress, approval; else text),
  ≤ 3 actions {url | ask | share | api(jobs only)}. `Session.Ui.card`/`showJob`. PHONE_NOTE tells the brain when to use it.
- JOBS IN THE STRIP: `LiveUpdates.kt` = one silent ProgressStyle notification per active job (channel `work`, segments by phase/progress),
  `setRequestPromotedOngoing` called by reflection (it's API 36 QPR1, absent from the API 36 jar). Alerts still come only from the Mac's
  pushes. NEEDS YOU on the home page = `HomeOverlay.needs` (one amber "!" orb in the notification arc; into the core = not now).
  `JobStore.events` keeps the live `job-event`s. Off the live line, main.js pushes status changes over FCM at NORMAL priority
  (`relay.notify({type:'job'…}, {priority:'normal'})`; the Worker maps it; deployed 2026-10-10).
- THE RECEIPT (`ReceiptActivity`, a sheet): `GET /api/jobs/<id>/receipt` = job + events + files + checks + the audit lines whose `what`
  starts with the title. Approvals: `Approvals.kt` → APPROVE = `BiometricPrompt` (BIOMETRIC_STRONG | DEVICE_CREDENTIAL; a plain
  confirm when the phone has no lock) then `answer {yes, at, from:'phone'}`; EDIT = `answer {yes:false, edit}` (the worker is told the
  change and asks again); NOT NOW; UNDO = `POST /undo` inside the 10 s window (`jobs.answer(..., {from:'phone'})` holds the resolve,
  `job.undo.until`). Notification "Yes" buttons from the phone no longer answer directly (the receipt does, with the fingerprint).
- SENTINEL (`sentinel.js`): `isOutgoing(tool, input)` + `check()` = a haiku one-shot (ARES_SENTINEL_MODEL) that judges the exact payload
  against the request (recipients checked against contacts, secrets fail locally). Runs in `jobs.ask` (verdict on `request.check`,
  `job.checks`, the receipt, the audit) and in the bridge's `/approve` for the brain's own sends (a failure denies and tells the brain
  to show the user). It never replaces the owner's yes.
- IDEAS (`ideas.js`, `GET /api/ideas[?job=]`): ≤ 3 chips from the next event, the hour, waiting/unseen jobs and autonomy's seen table
  (a learned chip once a day, `state.offeredIdeas`). Phone: `Ideas.row` under the reactor (`HomeActivity.loadIdeas`, 10 min) and in receipts.
- Measuring: `Perf.kt` (JankStats, states "HomePager=Swiping", "Reactor=Summon"; tag ARES.jank), `scripts/phone-jank.sh`,
  `app/src/main/baseline-prof.txt` (hand-written; regenerate with the macrobenchmark module: `-PmacroBench=1`, see android/macrobenchmark/README.md).
- Tests: `node scripts/test-phone-ui.js` (cards, sentinel routing with a fake one-shot, ideas, edit/undo/receipt with a fake worker).
  Emulator: debug hook `am broadcast -a com.dhruv.ares.TEST_RECEIPT --es job <id>`; the presence over an app = tap the bubble
  (`appops set com.dhruv.ares SYSTEM_ALERT_WINDOW allow` first). Not verified on the emulator (no API 36 QPR1 image, no lock):
  the status-bar chip / Now Bar, BiometricPrompt, FCM normal-priority progress. Designs only, nothing created: docs/intake-email-design.md,
  reports/One-time payment cards.md.
