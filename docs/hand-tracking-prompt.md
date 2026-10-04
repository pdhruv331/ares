Give ARES HAND GESTURES through the Mac's built-in camera: grab, throw, zoom and swipe her panels in the air, like the trackpad but without touching anything. See the project notes and CLAUDE.md. Read the current panel/orb code first (grab-to-orb, throw physics, magnetic slots, throw-into-brain, click for details, COMMS, surface.js lift) and drive THAT code: gestures are just another input, with no forked copy of the interactions. Commit after each working step.

HARD RULES:
- Opt-in: a ◉ menu toggle "Hand gestures", default OFF. Runs only while desk mode is active and the screen is unlocked.
- Camera frames never leave the native helper: no video or images stored, logged, sent to the brain or off the Mac. Only joint coordinates go to ARES.
- The camera is fully OFF when: gestures are off, the screen is locked, I'm idle (desk mode's idle rule), the lid is closed, Low Power Mode is on, or a call/meeting is active (reuse desk mode's call detection).
- No new permissions beyond Camera (add NSCameraUsageDescription to the app's Info.plist through the build config; explain the prompt to me first).
- Don't touch the phone line or voice paths (CLAUDE.md).

1. NATIVE HELPER: native/AresVision.swift → `ares-vision` (like AresListener / AresDesktop)
- AVCaptureSession on the built-in camera: 640×480 while watching, 1280×720 while engaged (two-finger poses need the detail). Frame rate 10 fps while watching for the wake gesture, 30 fps while engaged.
- Apple Vision VNDetectHumanHandPoseRequest, maximumHandCount = 2, on-device. Per hand: the 21 joints with confidences, chirality, a timestamp.
- Smooth with a One Euro filter (tunable). Drop low-confidence joints.
- Output newline-delimited JSON on stdout to main (same pattern as the other helpers). Commands on stdin: start/stop/rate/resolution.
- Design it as the ONE camera owner for future face/gaze tracking (docs/gaze-prompt.md): a request list, hands now, face later.
- Mirror the x axis so moving my hand right moves the cursor right.

2. GESTURE ENGINE: hands.js (main), pure functions where possible so it's testable
- Pose classification from the joints: open palm, pinch (thumb tip–index tip distance relative to hand size, with hysteresis for press/release), two-finger (index + middle straight, ring + little curled), thumbs up.
- Mapping: a comfortable "interaction box" in the camera frame (chest height, not the edges) maps to the display ARES is on. Relative to hand size, so it works near or far.
- False-trigger guards:
  - Ignore hands in the bottom ~20% of the frame (resting/typing).
  - Ignore everything for 1 s after any keypress.
  - Require the wake gesture before anything else counts.
  - Require motion, not just a pose, for swipes (a held peace sign does nothing).
  - Ignore hands near my face (scratching, chin on hand) unless pinching on a target.
- States: off → watching → engaged → (a 3 s grace after hands leave the frame) → watching.

3. GESTURES (v1 controls ARES's own scene only)
| Gesture | Action |
| Open palm held ~0.3 s | Engage hand mode (cursor appears) |
| Open palm held ~0.5 s while engaged | Summon/lift ARES; while she's speaking, a silent "stop" (barge-in) |
| Pinch on a panel | Grab it → it becomes an orb (the existing grab) |
| Pinch, move, release with a flick | Throw with the existing physics; into the brain closes it |
| Pinch and release quickly on a panel | Click (open details), like a mouse click |
| Two-finger swipe left/right | Previous/next panel focus, or tabs inside a details view |
| Two-finger swipe up | Lift ARES / expand the focused panel |
| Two-finger swipe down | Dismiss the focused panel / sink back to the wallpaper |
| Two fingers, slow vertical drift | Scroll (details views, COMMS, long lists) |
| Two-hand pinch, spread/squeeze | Continuous: spread on a panel expands it toward its details view, squeeze collapses it (and on into an orb); on an image/PDF/map, real zoom; on the brain, scene zoom (clamped). Lock into "zoom" mode once both pinches are seen so it can't flip into a one-hand grab mid-gesture. Damped. |
| Thumbs up | LATER, not v1: answer "yes" to an approval, still with the on-screen confirm |
- Thresholds (dwell times, pinch distance, swipe velocity) live in settings so they can be tuned without code changes.

4. FEEDBACK (required; there's no touch feedback in the air)
- A hand cursor: a small glowing ring in the ARES palette that shrinks/fills on pinch, two dots for two-finger mode, and a line between both hands while zooming.
- Hovered panels get their EDITH brackets (as with the mouse).
- A soft tick sound on grab and release (local, quiet, follows the system volume).
- Status in the ◉ menu and the status indicator: "Hands: watching / engaged / off". The camera light is the honest indicator; never try to hide it.

5. PERFORMANCE
- Measure CPU/GPU/energy for watching and engaged and report it to me. Targets: watching barely noticeable; engaged reasonable. If Vision is too heavy at 30 fps, lower the rate and interpolate the cursor.
- On battery: watching at 5 fps.

6. TESTING WITHOUT A CAMERA
- A record mode (dev only) that saves the joint stream to JSON, and a replay hook in the harness (like testHear) that feeds recorded streams into hands.js.
- Record clips with me: engage, pinch-grab, throw into the brain, quick-pinch click, two-finger swipes in 4 directions, scroll, two-hand zoom in/out, palm stop. Plus NEGATIVES: typing, resting hands, scratching my face, chin on hand, waving at someone, a held peace sign, stretching.
- Automated tests: every positive clip triggers the right action; NO negative clip triggers anything. Report the false-trigger rate.

7. LATER (not this session, just leave room in the design)
- Mac-wide gestures through the Mac-control tools (docs/autonomy-prompt.md section 0), tier 2: two-finger swipe → switch Spaces, scroll in the front app, ⌘+/⌘− zoom.
- Two-hand twist to rotate the brain.
- Gaze + pinch (docs/gaze-prompt.md).

TEST on my real Mac: the camera prompt explained; engage; grab, throw and close a panel in the air; open details with a quick pinch; swipe through panels; scroll COMMS; two-hand zoom on a panel and an image; stop her mid-sentence with a palm; type for a minute and confirm nothing fires; confirm the camera turns off when locked/idle/on a call. Build with npm run build, ask me before restarting ARES, and tell me what to try.
