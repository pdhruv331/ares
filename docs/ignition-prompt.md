IGNITION, STANDBY AND POWER DOWN: wake ARES from the wallpaper, put her in standby or power her down, from the Mac or the phone's orb. While ARES is quit, the desktop shows the offline still; press and hold the cold reactor and ARES starts with a "charge-to-wake" animation that follows her real start-up, then greets me with a different, context-aware line every time. Also: a crisper offline still. See CLAUDE.md and the project notes; the reactor look (docs/reactor-prompt.md) is built: reuse its drawing code. Every visual here was agreed with me through interactive mockups in the planning session; match them. Mac only. Commit after each working step.

HARD RULES
- Nothing heavy runs while ARES is quit. The ignition helper is a small native Swift app (not Electron), ~0% CPU at rest, no microphone, no network, not in the Dock or Cmd-Tab, launched at login, and it exits (or sleeps) once ARES is up.
- Never block the desktop: the hotspot only covers the reactor; icons, Finder, right-click and drags work everywhere else (and on the reactor when not holding).
- Don't change my desktop picture without the existing ask-first rule; the restore item still restores my original.
- Don't touch the phone line or voice paths beyond the greeting (CLAUDE.md). Dev/test greetings use Kokoro.

1. THE OFFLINE STILL (re-render it; it currently looks dull and soft)
- It's already native resolution (3024×1964 here); the problem is contrast. New values (as in the mockup): reactor rings ~0.54 alpha, ticks ~0.36, coils ~0.33, core visible as a soft gold glow; schematic rings/crosshair/diagonals ~2× brighter than now; denser, slightly brighter dot grid; a very soft warm glow behind the reactor. Colour: warm gold (#FAC458), with a subtle glow on the reactor lines.
- Title block: SMALL (same size as now), sleek: letter-spaced monospace "ARES · OFFLINE" in soft glowing gold (not too bright), thin gold rules either side that fade out with tiny end caps, and a quieter subtitle "REACTOR COLD / SYSTEMS DOWN". Put it on a CLEARED band (rings, crosshair and dots fade out behind it) so nothing crosses the text; hide the 90° label while offline so nothing crowds it.
- Scale every size with the display's backing scale so text and lines are crisp on Retina and on external displays; one still per display at its native resolution.

2. THE IGNITION HELPER ("ARES Ignition", native/AresIgnition.swift, a real .app like ARES Vision/Calendar)
- Runs only while ARES isn't running (ARES's pid file / a lock; started at login and by ARES on quit; exits when ARES is up).
- A transparent desktop-level window per display, exactly over the still's reactor, drawing the SAME offline reactor so the handover is seamless; clicks pass through everywhere except the reactor's circle.
- Hover: the core warms slightly and "HOLD TO WAKE" fades in under it. Press and hold ~0.7 s: a charge ring fills around the core (release early = cancel). A plain click does nothing (I click the desktop all the time).
- Also ignite via ⌥Space while ARES is off (the helper registers the hotkey only while ARES is off) and when ARES is launched from the Dock/Spotlight/login (ARES plays the same sequence on any cold start).
- On ignite: launch ARES, then play the charge animation, driven by ARES's real start-up progress (below), and hand over.

3. CHARGE-TO-WAKE (the "siphon" style; the mockup's exact behaviour)
- The floor is the offline still: nothing ever dims below it. Every element starts at its offline brightness and only brightens; the offline title fades out over ~0.5 s; the charge ring and % fade in over ~0.4 s.
- While charging: streaks of energy are pulled from the dot matrix and spiral into the core (denser as the charge builds; the dots near the reactor dim a little as they're "drained", the scene overall gets brighter); a segmented charge ring fills with a % under the reactor; coils light one per 10%; rings brighten and spin up; the tick ring hums (slight vibration rising with the charge); the core swells and flickers faster; colour gold → white-hot.
- The charge is REAL: ARES reports its start-up steps (memory, voice, ears/listener, brain/Claude, link/phone+relay; add any that matter) to the helper over a local socket/file; the bar moves with them and holds at the current step if one is slow. A failed step shows in amber in the log and the wake still happens (degraded), never a fake 100%.
- At capacity: a ~0.35 s "held breath" (the core pulls in), then WAKE: a bloom and spark burst, the rings spring open with a slight overshoot, a shockwave rolls across the dots relighting them in cyan, the schematic draws itself out, the radar sweep starts, the 90° label fades back, then the handover.
- HANDOVER: when ARES's live scene is ready on that display, crossfade from the helper's window to the live ARES desktop with no visible jump (same geometry), then the helper hides/exits.
- GHOST LOG (bottom-left of the screen): faint small monospace lines "› memory ... 98 facts ✓" etc.; at most 3 visible; each finished line fades after ~1.5 s; the current step pulses; ends with "› all systems nominal" fading out after ~2 s.

4. THE WAKE LINE: DIFFERENT EVERY TIME
- Shown typed under the reactor ("ARES · AWAKE" + one line, two at most) and SPOKEN in her normal voice (Katherine; Kokoro in dev/budget mode). Quiet hours / Focus on → text only.
- Context she uses: time of day and weekday; how long she was off (minutes / overnight / days); why (I quit her, crash, Mac restart, after an update); what happened while she was off (jobs finished/failed, missed calls/voicemails, important mail, Claude sessions waiting on me); what's next (calendar event, notable weather, low battery, Claude usage near the limit).
- Priority: something that needs me comes first (failed job, missed call, approval waiting); otherwise a short greeting + at most one useful fact. Never a list.
- Generation: INSTANT and FREE by default: a local pool of templates per situation (lots of them, in her persona: conversational, dry, "sir" only sometimes) filled with real facts; never repeat any of the last ~20 lines. Optional variety: while idle, pre-write a few fresh lines with a cheap tool-less one-shot (haiku) for likely situations and cache them; never called at wake time; respects the usage reserve.
- Examples of the tone: "Morning, sir. Clear skies, and your interview's at four." / "Back already? Picking up where we left off." / "Sorry about that, sir. I'm back, and nothing was lost." / "Evening. Two jobs finished while I was out. The gaze notes are on your desktop." / "It's been a while, sir. Three days. Shall I catch you up?" / "All systems up. Quiet day so far."
- A ◉ setting: Wake line: Spoken + shown / Shown only / Off.

4b. STANDBY (ARES keeps running, the desktop goes quiet)
- Hold the live reactor's CORE (the centre, ~0.35 of its radius) for ~1.2 s → STANDBY; hold again (or ⌥Space, or "wake up") → online, instantly (no cold start). A counter-clockwise ring drains while holding; "HOLD FOR STANDBY" under the core on hover. Never triggered by a click or by orbs thrown into the reactor.
- Standby = listening off (wake word + desk mode paused), the scene dims to a cool blue (#6096FF-ish): rings/coils dark, almost no motion, the core breathing slowly; job orbs keep circling dimmed; callouts and panels hidden; rendering at a very low rate (or a still with only the core breathing). The ghost log notes the change.
- Standby text block (on a cleared band, with real spacing, as in the mockup): "ARES · STANDBY" (small, letter-spaced, soft glow), a short thin divider under it, then a clear gap, then "LISTENING OFF / PHONE LINK ACTIVE / N JOBS RUNNING" with a small green "link alive" dot; nothing crowded.
- The standby text block is centred as ONE group (title, divider, status line incl. its green dot measured together), on the reactor's vertical axis.
- STANDBY → POWER DOWN on the Mac (she isn't listening in standby, so voice won't do): the POWER NOTCH (agreed): a small ⏻ socket on the reactor's vertical axis, BELOW the tick ring and ABOVE the standby text (with a short hairline linking it to the ring), only shown in standby. Hover: it glows amber + "HOLD TO POWER DOWN" beside it. Hold ~1.5 s: a ring fills around the notch and the reactor's ticks light amber outward from the bottom until they meet at the top → the spin-down from blue to the cold gold still. Release early = cancel. Holding the core in standby still WAKES her. ◉ → Quit also works.
- Everything else keeps running: the phone link, jobs, projects, routines, Claude hooks → pushes, call/voicemail pushes. The transition uses the spin-down (below) but stops at standby's levels.

4c. POWER DOWN (a real quit): the SPIN-DOWN animation (agreed)
- Triggered by "ARES, power down", ◉ → Quit, or the phone (below); NOT by the core hold (that's standby, so I never cut off my phone by accident). If jobs are running, say so first ("2 jobs running, they'll pause") and continue.
- Spin-down: everything winds down like a turbine: the rings, scanner and coil chase decelerate on their own curves (not in lockstep), the coils go out one by one, the colour drains cyan → white → gold, orbs and callouts fade, the core flickers once and settles into the cold still; the offline title fades in. Spoken + typed: "Powering down. Goodnight, sir." (or the jobs variant).
- Ghost log in reverse with REAL steps: jobs paused, memory saved (the existing consolidation at quit; the animation waits for it within its time cap), phone notified, ears closed, voice off, "reactor cold". Then ARES quits and the ignition helper takes over the reactor.

4d. POWER FROM THE PHONE (Android app; extend the existing reactor screen, don't redesign it)
- Tap the orb = talk (unchanged). HOLD the orb ~0.8 s (a ring fills around it in the target colour) toggles: online → STANDBY, standby/offline → WAKE. The hint under the orb says which ("tap to talk · hold for standby" / "hold to wake").
- ANIMATIONS ON THE PHONE too (the phone's reactor mirrors the Mac's state): going to standby = the orb spins down to blue (rings decelerate, coils go out, core breathing slowly); waking = a mini siphon (energy streams pulled into the orb), then a white bloom and the orb lights cyan; power down = the spin-down to gold. While the Mac transitions the hint reads "charging…" / "spinning down…".
- POWER DOWN on the phone is deliberately separate: a small ⏻ icon in the top corner (hidden while she's off) opens a bottom sheet "POWER DOWN MAC ARES · Jobs pause · phone access stops" with a SLIDE-TO-POWER-DOWN slider (gold knob with a ⏻ glyph; let go early and it springs back) and Cancel. Completing the slide plays the spin-down on both the phone and the Mac.
- The phone's orb colour and header follow the Mac's state: cyan ONLINE, blue STANDBY ("N jobs running · reachable"), gold OFFLINE, and "Mac asleep · can't wake" when the Mac can't be reached. A toast confirms each change ("Mac ARES → standby").
- Online ⇄ standby and power down go over the existing authenticated phone channel. WAKE FROM OFF: the ignition helper keeps ONE small OUTBOUND authenticated connection to the existing ARES relay (no open ports, no other commands accepted, signed by the paired phone) and launches ARES on a valid wake; then the normal charge-to-wake plays on the Mac and the phone shows progress. This replaces the "no network" rule in section 2 for this one purpose only.
- The Mac must be awake for a wake-from-off: add a setting "Keep the Mac awake on power while ARES is off" (default off; same power assertion as Stay Reachable, power adapter only). If the Mac is asleep/lid closed, the phone says so plainly.

4e. SOUND (Mac) AND HAPTICS (phone) FOR EVERY STAGE
- Sounds are short, subtle, local files (no network), designed to fit the reactor (synthesised or licensed-free; no copyrighted samples), at a gentle level that follows the system volume; quiet hours / Focus → silent (visuals only). A ◉ setting: Power sounds On/Off.
  - Notch/core hover: a soft tick. Hold begins: a rising tone that tracks the hold. Commit: a muted clunk.
  - Charge-to-wake: a hum rising with the real charge %, a tiny "inhale" (near-silence) at the held breath, a bright bloom chime on wake, then her spoken line.
  - Standby: two soft falling notes + a gentle whir down. Wake from standby: a short rising chime.
  - Power down (spin-down): a clunk, a long turbine wind-down matching the rings' deceleration, a soft cold thud at the end.
  - Error (a step failed): a low two-note "nope".
- Phone haptics (Android VibrationEffect / predefined effects; respect the system haptics setting):
  - Holding the orb: light ticks at each 1/8 of the ring, getting firmer near the end; commit = a heavy thunk.
  - Wake completes (the Mac's bloom): a double tap. Standby committed: a soft single thunk.
  - Slide to power down: a detent tick at each step of the track, a heavy thunk at the end; letting go = a light tick as it springs back.
  - Can't reach the Mac / error: an error buzz.
- The phone also plays quieter versions of the sounds while the app is in front (respecting silent mode).

4f. PHONE STATES AND EXTRAS (as rendered)
- "Mac asleep": the orb goes grey and still, the header says MAC · ASLEEP; holding the orb gives the error buzz and "Mac asleep · can't wake / Open the lid or plug it in".
- Scheduled standby / wake (by voice: "stand by at midnight, wake me at 7:30"; stored as a routine): a chip under the header ("☾ standby 00:00 · wake 07:30"); 5 minutes before, a notification "Standing by in 5 min · N jobs keep running" with SKIP TONIGHT / STANDBY NOW.
- Auto standby on the Mac (settings, each with a toggle): when the screen locks, after N idle minutes, at a night hour, or on low battery; wake when I'm back (unlock/desk-mode presence). Always noted in the ghost log; never auto power down.
- The ◉ in the ARES menu bar shows the state colour (cyan / blue / gold) with Wake · Standby · Power down in its drop-down; ⌥⇧Space toggles standby. The lock-screen still matches the state (blue standby still vs the gold offline still).

5. PERFORMANCE
- The helper idles at ~0% CPU (static window; animate only on hover/hold/charge). The charge animation runs at 60 fps for its few seconds only. Measure and report idle CPU/memory of the helper.

6. TEST
- Harness for ARES's side; the helper on my real Mac only with my go (it puts a window on the real desktop).
- Test: hover/hold/cancel; core hold → standby → wake; standby keeps jobs, routines and phone requests working; spin-down with and without running jobs (memory saved before quit); the phone orb menu (all three, confirm on power down, wake from off via the relay, "Mac asleep" when unreachable); clicks and drags on icons elsewhere still work; ⌥Space ignition; Dock launch plays the same sequence; the bar follows real steps (simulate a slow and a failed step); no dimming at the start; seamless handover on every display; ghost log timing; wake lines vary across 10 wakes in different situations (fake the context: crash, long absence, missed call, finished job, late night) and never repeat; quiet hours → text only; the new still at native resolution (render to files with ARES_TEST_STILL first; ask before setting the desktop picture).
- Build with npm run build, ask me before restarting ARES, and tell me what to try.
