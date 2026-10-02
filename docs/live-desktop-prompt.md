Make my Mac's desktop the FULL LIVE ARES, and let me talk to it freely like a true AI. The brain-only wallpaper is already built (see docs/wallpaper-prompt.md and the project notes). The earlier "no panels on the wallpaper" rule was wrong. Read the current wallpaper and renderer code first, and reuse the real dashboard code (one code path, no forked copy). Commit after each working step.

1. FULL LIVE DASHBOARD AS THE DESKTOP
- The wallpaper shows the whole live UI: brain/halo/stars/orbs + the dashboard panels (Next, Timer, Leave by, Work, Call, Now playing, Remembered, Inbox), the cinematic subtitles, the thought ticker and the status indicator. All live and in sync with the main ARES (one ARES, shared state). No typing box; COMMS only when I open it.
- Layering: the window sits just above the desktop icons and below ALL app windows, on all Spaces, never in the Dock/Cmd-Tab/Mission Control.

2. PANELS WORK EXACTLY LIKE IN THE APP (same code path)
- Click to expand details; grab to orb; throw with the same physics; magnetic slots; throw into the brain to close; materialize/launch animations; adaptive density.
- Click-through everywhere EXCEPT over panels and orbs: setIgnoreMouseEvents(true, {forward:true}), toggled per hover/hit-test. While an orb is held or flying, stay interactive only where needed. Never block clicks, drags or right-clicks on my icons or Finder outside panels/orbs.
- Desktop icons: read their positions from Finder (as in section 3b of docs/wallpaper-prompt.md) and re-check when ~/Desktop changes.
  - Panels and the brain avoid icon areas.
  - Orbs bounce off the screen edges AND icon clusters (treat them as walls) and never land on icons.
  - Magnetic slots adapt to the free space.
- Panel positions are remembered separately for the wallpaper and the app window.
- With multiple displays, panels stay on their display (throwing across displays can come later).

3. SUMMONING
- "Hey ARES" / ⌥Space, with two modes in the ◉ menu:
  - "Lift the wallpaper" (default): the wallpaper rises above my apps with a short transition, fully interactive, and sinks back when dismissed.
  - "Open ARES window": the current separate window.

4. TALK TO MY MAC FREELY: DESK MODE (default ON)
- While I'm actively at the Mac (keyboard/mouse input in the last ~5 min, screen unlocked), ARES is always listening, with no wake word needed. Reuse the existing awake mode, Voice ID and the listener's "addressed" detection, and make them good enough to be the default:
  - Only respond to MY voice (Voice ID). Ignore the TV, other people, and my own phone/video calls: pause desk mode while a call app is using the mic or a FaceTime/Zoom/Meet/Teams call is active.
  - Only respond when I'm talking TO her, not just talking or thinking aloud. Improve the addressed check: her name, a direct question/command, the ongoing conversation context, follow-ups within ~20 s of her last reply. When unsure, stay quiet and never interrupt me.
  - A natural follow-up window after each reply, and barge-in as now.
- Auto-off: back to wake-word-only when I'm idle more than ~5 min, the screen locks, a call/meeting starts, or I say "go quiet"/"stop listening". Resume when I'm back. Show the listening state in the status indicator (and the menu bar later).
- ◉ menu: a "Desk mode (no wake word while I'm at the Mac)" toggle + the idle timeout setting.
- Privacy: speech recognition stays on-device; only addressed speech goes to the brain; no audio stored; the transcript debug logging stays off.

5. PERFORMANCE: keep all the battery rules (pause when covered/full screen/locked/display asleep, 30 fps, 60 only while listening/speaking, lower on battery, still frame in Low Power Mode), the multi-display options and the tray toggle. Report the CPU/GPU impact compared with the brain-only wallpaper.

6. TEST on my real Mac:
- Icons still clickable/draggable/right-clickable.
- Panels clickable, expandable and throwable on the desktop.
- Orbs bounce off icons.
- Throwing into the brain closes.
- Apps always above.
- Summon both ways.
- A normal conversation without the wake word.
- Ignoring other voices/TV and thinking aloud.
- Pausing during a call.
- Auto-off when idle.
- Voice ID still refusing strangers.
Then update docs/wallpaper-prompt.md to match, build with npm run build, restart ARES, and tell me what to try.
