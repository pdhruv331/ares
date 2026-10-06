THE REACTOR LOOK FOR THE MAC: replace the 3D brain + starfield with the phone app's arc reactor on a dot-matrix schematic, with job orbs in orbit, short clickable readout callouts, and translucency wherever things overlap. See CLAUDE.md and the project notes. Read first: renderer/brain3d.mjs, brain.js, stars.js, scene-link.js, dash.js, flow.js, work.js (job orbs), surface.js, wallpaper.{html,js}, the screen saver (native/saver, scripts/build-saver.sh), the lock-screen still, theme-dock (orb), and the phone's android/.../ReactorView.kt + SchematicView.kt (the reference drawing). Commit after each working step.

The design was agreed with me through interactive mockups in the planning session; match it. Mac only: don't change android/ or the phone API.

HARD RULES
- One scene code path: the window, the live desktop, the lifted view and the wallpaper backdrop all draw the SAME reactor scene (scene-link mirrors it as it mirrors the brain today). The screen saver and lock-screen still use the same drawing code.
- The brain stays available as an option: ◉ menu "Look: Reactor / Brain" (default Reactor), like the phone's menu option. Switching is instant and persisted. Don't delete the brain code.
- Keep every existing behaviour wired to the scene: states (idle / listening / thinking / speaking / offline), wake-word pulse, voice levels, desk mode indicators, the brain's role as the throw-into-to-close target (now the reactor), panels avoiding it (flow.js obstacle), icon walls on the desktop.
- Performance: the point of this look is also a SMOOTHER, LIGHTER desktop than the WebGL brain. Full screen at Retina is millions of pixels, so draw it in layers:
  - STATIC layer (dot grid + schematic rings/labels): rendered once to a cached canvas; re-rendered only on resize, display change or a colour change (ease the colour on the cached layer with a cheap tint/composite, not a per-dot redraw).
  - REACTOR layer: redrawn each frame but only inside the reactor's bounding box (+ orbit); orbs, callouts and the radar sweep are small dirty regions.
  - RIPPLES: only while she speaks, as a few expanding rings composited over the cached dots (mask/composite), never a per-dot loop per frame.
  - No canvas filters/shadowBlur per frame; glows are pre-rendered sprites. Consider OffscreenCanvas in a worker if the main thread is busy.
  - Pacing: ~15 fps when idle (only slow rings/scanner move), 30 normally, 60 only while listening/speaking; keep the existing rules (pause when covered/locked/asleep, lower on battery, still frame in Low Power Mode). Only ONE live scene renderer per display (the backdrop and the desktop window must not both animate the same pixels).
  - TARGET: noticeably less CPU and GPU than the brain, idle and speaking, on power and battery (Activity Monitor / powermetrics, same conditions, before vs after), and no dropped frames while speaking. Report the numbers; if it isn't lighter, optimise before shipping.

1. THE REACTOR (port ReactorView.kt to the renderer, same proportions and behaviour)
- Outer tick ring (90 ticks, every 9th longer) with a scanner sweeping round lighting the ticks behind it + a soft trail.
- Four segmented rings turning against each other at different speeds.
- A waveform ring that ripples with HER voice while speaking and MY voice while listening (real levels).
- Ten coils around the core lit in a chase.
- The core: white-hot centre → state colour, breathing at rest, swelling with the voice, flickering while thinking; a soft glow.
- Sparks drifting out of the core: a trickle at rest, a stream while busy/speaking; a burst on entering thinking.
- Colours ease between states: cyan (#3EE6FF) at rest and listening, purple (#9D8CFF) and faster while thinking, white-hot (#F2FBFF) while speaking, amber when offline/no brain. Ring speeds follow energy as in the Kotlin.
- Size: noticeably larger than the brain was (radius ≈ 26% of the window height), centred slightly below the middle. It takes the brain's place in flow.js (a circle obstacle including its orbit and callouts' inner part).

2. THE BACKDROP: DOT MATRIX (replaces the starfield on every surface)
- Near-black (#03070D) with a regular dot grid (~14 px pitch, 1.5 px dots) in the reactor's current colour, brightest near the reactor and fading with distance.
- While she SPEAKS, ripples roll outward across the dots from the reactor (driven by her voice level; a new ripple on stronger syllables). Subtle at rest; no motion when idle except the colour.
- Draw it cheaply (pre-rendered static layer + only ripple rings recomputed, or a shader); it covers the whole display on the desktop.

3. THE SCHEMATIC (from SchematicView.kt, toned to the mockup)
- Faint construction rings around the reactor running off toward the screen edges (dashed/solid mix), a crosshair, angle marks with 0°/90°/180°/270° labels on the first ring, and a slow radar sweep between the first two rings. All low-contrast; it frames the reactor, never competes with panels.

4. JOB ORBS IN ORBIT (replace the brain's job orbs; same data and interactions)
- Each running job/project is an orb on a faint dotted orbit just outside the reactor (≈1.2× its radius, slightly elliptical), moving slowly (faster while she's busy), labelled with the job name (caps) and its % (or NEEDS YOU), label on the outward side.
- A thin progress ring around each orb fills with the job's progress. Waiting-on-me jobs are amber and pulse.
- All existing orb interactions keep working: click for details, grab → throw (the existing physics), throw into the reactor to close/cancel per today's rules, project orbs slightly larger.

5. READOUT CALLOUTS (from the phone's corner readouts, but SHORT, close to the reactor)
- Four callouts: JOBS (count · how many need me), HOST (mac · online/offline), CLAUDE (5-hour usage %), BATTERY (%).
- Shape: an anchor dot on the reactor's first schematic ring → a short diagonal line outward → a short horizontal tick → the label (small caps) with the value under it. They extend a bit beyond the reactor (elbow ≈ 1.8–1.95× its radius, tick ≈ 40 px), NOT to the screen edges. JOBS and HOST as a pair above the reactor (either side of the top), CLAUDE and BATTERY at the lower diagonals. Place them so they don't sit on panels (use flow.js's knowledge of the columns; if they must, the translucency rule applies).
- Live values: jobs.js, claude-usage.js, the battery/power source, phone connection + Tailscale + stayReachable. A readout turns amber on its own when it matters: CLAUDE ≥ 80%, BATTERY low, JOBS when something needs me, HOST when the phone is disconnected.
- Hover: the line and text brighten, a "›" appears. CLICK opens a CARD next to the label (EDITH brackets, unfolding ~0.15 s, slightly see-through background):
  - JOBS: each job with a progress bar; actions APPROVE (the waiting one, through the existing approval flow), OPEN WORK, STOP ALL (the kill switch).
  - HOST: Mac uptime, phone connected, Tailscale, Stay reachable, theme; actions LOCK, SLEEP (tier 2).
  - CLAUDE: 5-hour and weekly bars with reset times, the chat reserve, the busiest job; actions PAUSE PROJECTS, DETAILS.
  - BATTERY: charge + time left, power source, Low Power Mode, what's keeping the Mac awake; action LOW POWER ON (tier 2).
  The open callout's anchor pulses. Click elsewhere or the label again closes it. Voice opens them too ("how's my Claude usage?").
- While she speaks, the bottom pair fades so the caption has room (unless a card is open).

6. TRANSLUCENCY WHEN THINGS OVERLAP (one general rule)
- Whatever is on top stays solid; anything it covers fades to ~20% opacity, smoothly (~0.15 s each way), and comes back when it's clear. Applies to: callout cards over panels/orbs/other callouts, panel details views and the expanded calendar over anything, dragged/flying orbs, job orbs (and their labels) passing under callout labels or panels.
- This complements flow.js (reflow moves panels out of the way where it can); translucency handles what reflow can't (moving orbs, floating cards, cards over the reactor area).
- Fading items stay clickable only when they're on top (hit-testing follows the stacking order).

7. CAPTION
- The subtitles while she speaks: one line (two max for long sentences, as today), 12 px, theme cyan, centred under the reactor. Same timing/sync code as now.

8. EVERYWHERE ELSE
- Wallpaper backdrop windows (other displays / while ARES is a separate window): the reactor scene, not the brain.
- Screen saver (ARES.saver): the reactor + dot matrix + schematic, idle animation, simpler on battery; rebuild via scripts/build-saver.sh.
- Lock-screen still: re-render with the reactor (same rules as before: ask before changing my desktop picture the first time it changes; the restore item still works).
- The ARES dock orb (theme-dock, shown when the scene is hidden) and any other small brain icon: a mini reactor (the Kotlin's "small" mode: no sparks, orbs or scanner).
- The SketchyBar ◉ / status visuals don't need to change unless they draw the brain.

9. TEST (harness only for automated checks; CLAUDE.md rules)
- Every state on every surface (window, desktop, lifted, wallpaper backdrop); the Look switch both ways; job orbs with real jobs (progress, NEEDS YOU, click, throw into the reactor); each callout's hover/click/card/actions; translucency cases (card over a panel, orb under a label, expanded calendar over the scene); flow.js still keeps panels off the reactor + orbit; dot ripples while speaking; caption size; screen saver; lock still (to files with ARES_TEST_STILL); the dock orb; CPU/GPU numbers vs the brain on power and battery.
- Build with npm run build, ask me before restarting ARES, and tell me what to try.
