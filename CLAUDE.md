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
  config (`<support>/theme/sketchybar/sketchybarrc`); no launch agents, nothing in ~/.config. `sketchybar --query bar` exits 0
  even with no bar running: check with `pgrep -x sketchybar`. The bar hides itself in full-screen Spaces (by design).
- The pointer colour can't be written (com.apple.universalaccess is protected): the menu walks the user through it.
- Testing: `ARES_TEST_THEME=dock,notify,art,bar` in a harness brings up parts without touching settings; `apply` / `restore`
  change the REAL Mac (ask first). Running the standalone `Bar` against the live bar changes the real glow colour; reset it after.
