DEEP RESEARCH, NO IMPLEMENTATION: is webcam gaze good enough for ARES's "look at it, then tell her what to do" feature, and what's the best way to build it? Read docs/gaze-prompt.md (the planned feature), CLAUDE.md, and native/AresVision.swift + vision.js (the existing camera helper from the parked hand-gesture work) first. Do NOT change ARES's code, settings or the installed app in this session. Throwaway prototypes are fine in ~/ARES Projects/gaze-lab (its own git repo), never in ~/My AI. Write everything up in docs/gaze-research.md (the only file you add to ~/My AI) and commit it.

THE FEATURE (for context): I look at something on my Mac, a soft bracket settles on it, and I say "summarise this", "close that", "what's this error?", "send that to my phone". Gaze is only a pointer, never a trigger; voice acts. Targets snap to real things (ARES panels, windows, UI elements), so the question is whether gaze can reliably pick the right one of a handful of nearby targets.

WORK IN TWO STAGES. STAGE A is sections 1 and 1b: research only (no prototypes, no camera). Then STOP and REPORT TO ME in chat:
- what's possible today and how accurate it really is, in plain words;
- the BEST USE CASES FOR MY PRODUCTIVITY (section 1b), ranked;
- what you'd measure in stage B.
Wait for my go (and my picks of use cases) before STAGE B (sections 2–4), and focus the measurements on the use cases I pick.

1. STATE OF THE ART (search the web, papers, GitHub; cite sources with links and dates)
- Webcam gaze estimation methods today: geometric (iris + head pose), appearance-based deep models (e.g. ETH-XGaze, L2CS-Net, GazeNet/MPIIGaze, newer 2024–2026 models), WebGazer.js, MediaPipe Face Mesh / Face Landmarker iris, Apple Vision face landmarks, commercial SDKs (Tobii's webcam products, Eyeware Beam, GazeRecorder, etc.).
- For each: typical accuracy after calibration (degrees and cm at laptop distance), robustness to head movement/glasses/lighting, calibration needed, license, whether it runs on-device on Apple Silicon (Core ML / ANE / Metal), CPU/energy cost, latency.
- What macOS itself offers: Vision framework face landmarks and pupils, any gaze/attention APIs (e.g. ARKit face tracking needs TrueDepth, which Macs lack; check what's actually available on macOS 26), Accessibility's Eye Tracking (iOS/iPadOS feature; does macOS have it now? could ARES use it?), Continuity Camera (iPhone as webcam: better camera, maybe TrueDepth data?).
- How real products handle coarse gaze: target snapping/"gravity", dwell, the "Midas touch" problem, gaze + voice multimodal systems (research on "put-that-there" style interaction), Vision Pro's look + pinch design guidance.

1b. BEST USE CASES FOR MY PRODUCTIVITY (part of stage A)
- How I work: a MacBook, ARES as the live desktop with desk mode (talking to her without a wake word), full Mac control (files, windows, browser, UI automation, send to phone), Claude Code sessions, coding in VS Code/Terminal, Chrome. Read the project notes for more.
- Find what gaze can actually do for productivity: research (HCI papers, accessibility tools, Vision Pro, Tobii's productivity features, eye-tracking power users) and brainstorm for my setup. Examples to evaluate, not limit you: "summarise/explain/fix this" on what I'm looking at; "send that to my phone"; focus follows gaze (the window I look at gets keyboard focus, or scrolls); auto-scroll while reading; "where was I?" (remember what I last read when I come back); attention-aware notifications (hold them while I'm focused, show them where I'm looking); presence (pause/resume, dim when away, better desk mode); reading assist (define/translate the word I'm looking at); a focus/distraction report ("you spent 40 min on X").
- For each: the time it saves or friction it removes, how accurate gaze must be for it (does it work with coarse gaze?), the effort to build, privacy concerns, and whether a mouse/keyboard shortcut already does it just as well (be honest).
- Rank them: the top 3–5 worth building first, and the ones to skip.

2. MEASURE IT ON MY MAC (prototypes in ~/ARES Projects/gaze-lab; tell me before anything needs the camera so I can sit for it)
- Build the 2–3 most promising candidates as minimal prototypes (e.g. Apple Vision geometric, MediaPipe iris + head pose regression, one appearance-based model via Core ML/ONNX).
- One shared test: a 9-point calibration, then a 15–25 target accuracy test (dots across the screen), at my normal sitting distance, with and without glasses if relevant, in normal room light and in dim light, plus a "turn my head a bit" round.
- Report per candidate: mean and 95th-percentile error in cm and degrees, drift after 5 min, recalibration need, CPU % and energy at 10 fps, latency.
- Translate that into practice: on my screen size, how many targets can be told apart reliably (a 2×2, 3×3, 4×4 grid? ARES panels? individual windows? toolbar buttons?).
- The camera helper is a real .app because a bare binary is refused the camera (see CLAUDE.md); prototypes may need the same trick, or run as a small signed app.

3. PRESENCE AND ATTENTION (no calibration needed)
- How reliably can I tell "looking at the screen" vs "looking away / at my phone / at another person" from head pose + eyes? Measure it.
- Would it help desk mode's "is this speech for ARES" decision (addressed.js)? Estimate the gain.

4. DESIGN RECOMMENDATIONS for ARES
- The best method and why, with the trade-offs; fallbacks (mouse pointer target, head pose only).
- Snapping, dwell and freeze-at-speech-onset values backed by the measurements.
- Calibration UX (how short can it be, when to recalibrate, auto-correction from my confirmed choices).
- How to resolve "this/that" when two targets are close (ask, pick the most likely, show both).
- Privacy and energy rules (camera only while desk mode is on and unlocked; frames stay in the helper).
- A verdict per phase of docs/gaze-prompt.md: phase 1 (ARES panels), phase 2 (windows), phase 3 (elements inside windows): worth building / build with limits / not worth it.
- Concrete edits to docs/gaze-prompt.md (as a proposed diff in the research doc; don't edit the prompt itself).

DELIVERABLE: docs/gaze-research.md with a one-paragraph summary at the top (the verdict), then the ranked productivity use cases, sources, measurements (tables), recommendations and the proposed prompt changes. Write the stage A part of it before the stage A report, and add stage B after. Keep the prototypes in ~/ARES Projects/gaze-lab with a README on how to rerun the accuracy test. Tell me the verdict in plain words at the end.
