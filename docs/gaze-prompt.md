Give ARES GAZE: I look at something, a soft EDITH bracket settles on it, and I can say "summarise this", "send that to my phone", "close that", "what's this error?" and she acts on the highlighted thing. See the project notes and CLAUDE.md. This comes AFTER hand tracking (docs/hand-tracking-prompt.md): reuse its camera helper (native/AresVision.swift) and its feedback style. Phases 2 and 3 need the full Mac control tools from docs/autonomy-prompt.md section 0; if they aren't built yet, build phase 1 only and tell me. Commit after each working step.

HARD RULES:
- Opt-in: a ◉ menu toggle "Gaze highlight", default OFF. Same camera rules as hand tracking: frames stay in the helper, nothing stored or sent, camera off when locked/idle/on a call/Low Power Mode/lid closed.
- Screenshots of the gazed area are taken ONLY when I give a command that needs one, never continuously, and they stay local unless the command sends them to Claude (the brain) to answer me.
- Tier-3 actions (send, delete, purchase, post) still need my "yes", whatever is highlighted.
- Gaze is a POINTER, never a trigger: looking at something never does anything by itself.

0. HONEST ACCURACY: webcam gaze is coarse (about 3–5°, a few centimetres on screen), so the design hides that:
- SNAP TO TARGETS: the bracket jumps to the nearest real target (panel, orb, window, file icon, button, text block), never a jittery dot.
- DWELL: highlight only after ~0.4 s of steady gaze; sticky for ~1.5 s after I look away.
- FREEZE AT SPEECH ONSET: the target is what was highlighted when I STARTED talking (people glance away while speaking). The brain receives it as context: "the user is referring to: <target description>".
- CORRECTION: "no, the one on the left / the window behind it / the other one", or look again and repeat. With the camera off or uncalibrated, fall back to the mouse pointer's target.

1. TRACKING (extend AresVision; hands and face share one camera session)
- Apple Vision face landmarks (pupils) + head pose (VNDetectFaceLandmarksRequest / face rectangles with yaw/pitch/roll). Research whether MediaPipe Face Mesh's iris landmarks are clearly more accurate; only add it if so, and tell me the trade-off.
- Calibration: "ARES, calibrate my eyes" → 9 dots on screen (ARES-styled), about 15 s. A quick 3-dot refresh when drift is detected or when I ask. Stored locally per display.
- A regression from (eye landmarks + head pose) to screen coordinates, with smoothing. Measure the accuracy in centimetres/degrees after calibration and report it.
- PRESENCE (free with face tracking, works WITHOUT calibration): looking at the screen / looking away / no one there. Feed it to desk mode's addressed check (speech while facing the screen leans "for ARES", turned away leans "not for ARES") and to presence (welcome back, pause subtitles when I look away). Report how much it improves the addressed check.

2. PHASE 1: ARES's OWN SCENE (reliable from day one)
- Targets: panels, orbs, the brain, COMMS, details views. ARES already knows their rectangles.
- The highlight: brighter EDITH brackets on the target (the same as mouse hover, slightly warmer).
- Voice: "close that", "expand this", "send this to my phone", "what's that about?", "move that to the left" → resolved to the frozen target.
- With hand tracking: GAZE + PINCH, i.e. look at a panel and pinch anywhere in the air to grab it (Vision Pro style). Gaze picks the target, the pinch acts.

3. PHASE 2: WINDOWS
- A click-through overlay window above all apps that draws the bracket (never takes focus or clicks; hidden from screenshots of the window ARES sends to Claude).
- Target = the app window under the gaze point (CGWindowList / the Accessibility API).
- Voice: "summarise this page", "what's in this window?", "move this to the left half", "close that", "send this to my phone" (a screenshot of THAT window, or its URL/file if it has one).

4. PHASE 3: THINGS INSIDE WINDOWS
- Accessibility API element at the gaze point (AXUIElementCopyElementAtPosition), snapped to the nearest meaningful element (a Finder file, a button, a link, a text block, a table row).
- For anything without good accessibility data: crop a screenshot around the gaze area, OCR it (macOS Vision) or send the crop to Claude as an image.
- Voice: "what's this error?", "translate that", "open that file", "send that file to my phone", "copy that", "click that" (tier 2; tier 3 if it submits/sends/buys).

5. PERFORMANCE: gaze runs at about 10 fps, only while desk mode is active, unlocked, and the toggle is on. Measure CPU/energy with hands + gaze together and report it.

6. TESTING: reuse the record/replay approach from hand tracking (record face/landmark streams, replay in the harness). Test that speech onset freezes the right target, that correction works, that the fallback to the mouse target works with the camera off, and that looking at something without speaking never acts.

TEST on my real Mac: calibrate; read the measured accuracy; close/expand panels by look + voice; gaze + pinch grab; "summarise this" on a Safari window; "what's this error?" on a terminal; "send that file to my phone" on a Finder icon (it arrives on the phone); presence improves desk mode. Build with npm run build, ask me before restarting ARES, and tell me what to try.
