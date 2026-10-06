IGNITION: wake ARES from the wallpaper. While ARES is quit, the desktop shows the offline still; press and hold the cold reactor and ARES starts with a "charge-to-wake" animation that follows her real start-up, then greets me with a different, context-aware line every time. Also: a crisper offline still. See CLAUDE.md and the project notes; the reactor look (docs/reactor-prompt.md) is built: reuse its drawing code. Every visual here was agreed with me through interactive mockups in the planning session; match them. Mac only. Commit after each working step.

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

5. PERFORMANCE
- The helper idles at ~0% CPU (static window; animate only on hover/hold/charge). The charge animation runs at 60 fps for its few seconds only. Measure and report idle CPU/memory of the helper.

6. TEST
- Harness for ARES's side; the helper on my real Mac only with my go (it puts a window on the real desktop).
- Test: hover/hold/cancel; clicks and drags on icons elsewhere still work; ⌥Space ignition; Dock launch plays the same sequence; the bar follows real steps (simulate a slow and a failed step); no dimming at the start; seamless handover on every display; ghost log timing; wake lines vary across 10 wakes in different situations (fake the context: crash, long absence, missed call, finished job, late night) and never repeat; quiet hours → text only; the new still at native resolution (render to files with ARES_TEST_STILL first; ask before setting the desktop picture).
- Build with npm run build, ask me before restarting ARES, and tell me what to try.
