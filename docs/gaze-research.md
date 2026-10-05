# Gaze research for ARES: is webcam gaze good enough, and how to build it

Research for docs/gaze-prompt.md, done 2026-10-05 on the user's 14" MacBook Pro (M5, macOS 26.2, built-in camera).
Stage A (sections 1 and 1b) is research only. Stage B (sections 2–4, measurements on this Mac) is added below it
after the user's go. Nothing in ARES was changed for this document.

## Summary (the verdict so far, from stage A; to be confirmed by stage B)

Webcam gaze on this laptop will be a **region pointer, not a cursor**. Everything published for RGB webcams lands at
about **3–5° of visual angle in real use** (about 3–5 cm on this screen at a normal 55–65 cm sitting distance), with
the best academic pipelines reaching 1–3° only when the head is kept still for a seated 5–9 point calibration, and
everything getting worse with glasses, dim light, head turns, and time since calibration. The physics explains why:
at 60 cm the pupil moves only about **2 px across the whole screen width in a 640×480 frame** (about 4–5 px at 720p),
so the eye must be found to a fraction of a pixel and any head-pose error adds straight to the gaze error. On a
30×20 cm screen that is 28°×19° across, 3–5° means **a 3×3 grid of regions is reliable, a 4×4 is borderline, and
individual toolbar buttons, file icons or words are out of reach** (visionOS, with cameras inside the headset at
~1° accuracy, still demands 60 pt ≈ 2.5–3° targets). So: phase 1 (ARES panels) and phase 2 (app windows) of the
gaze prompt are worth building on top of snapping, dwell and a speech-onset freeze, phase 3 (elements inside windows)
is only worth it as "crop a 10 cm patch around the gaze and let the brain or OCR read it", and the cheapest win of all
needs no calibration: **presence and attention** (facing the screen vs turned away), which helps desk mode's
"is this for ARES" decision and ARES's own notifications. Recommended method to measure first: MediaPipe's Face
Landmarker (478 points with 10 iris points and a head-pose matrix, Apache-2.0, runs on Apple Silicon) feeding a small
per-user regression, with Apple's own Vision landmarks as the zero-dependency baseline and the tiny BlazeGaze
appearance model (MIT, 670 KB, 1 ms) as the third candidate. Stage B will put numbers on all three on this Mac.

---

# STAGE A

## 1. State of the art (what webcam gaze can do today)

### 1.1 Honest physics first: why "a few degrees" is the floor for a laptop webcam

- The eyeball turns about its centre; the pupil sits about 11 mm in front of that centre, so a gaze turn of θ moves the
  pupil sideways by about 11 mm × sin θ. Looking from the screen centre to its edge on this 14" screen is a turn of
  about 14°, which moves the pupil **2.7 mm**.
- The built-in camera sees roughly 70° across. At 60 cm one pixel of a 640×480 frame covers about 1.3 mm, one pixel of
  1280×720 about 0.66 mm, one of 1920×1080 about 0.44 mm. So the full centre-to-edge gaze swing is **~2 px at 640×480,
  ~4 px at 720p, ~6 px at 1080p**. Every method, geometric or learned, is doing sub-pixel iris localisation, and half
  a pixel of jitter at 720p is already ~2° of gaze.
- Head pose adds directly: 1° of yaw error ≈ 1° of gaze error, and a 1 cm sideways shift of the head without
  compensation is ≈ 1° at 60 cm. This is why the papers' "head still" numbers are 2–3× better than their "head moves"
  numbers, and why everything that works (iPhone Eye Tracking, Beam, the research pipelines) models head pose explicitly.
- Vertical is worse than horizontal: eyelids cover part of the iris, pitch is the least accurate head angle, and the
  screen is shorter than it is wide.
- The camera's resolution matters: ARES's hand helper runs 640×480 while watching. **Gaze needs the 1280×720 preset**
  (or the camera's 1080p), which is more work per frame and more energy; stage B measures this.

### 1.2 Methods, with the numbers that were actually measured

| Method | Measured accuracy (after calibration unless noted) | Head movement / glasses / light | Calibration | Licence, on-device, cost | Source |
|---|---|---|---|---|---|
| **Geometric: MediaPipe Face Mesh/Face Landmarker iris + solvePnP head pose + per-user regression** | 1.13° head fixed, 1.37° head moving (22 people, 5-point cal, Logitech C270 720p, bright room, Dec 2025); EMC-Gaze: 2.92° head still, 5.79° with pose changes across 33 sessions (9-point), 8.8° person-independent (Mar 2026) | Degrades 20–100% with head motion; the Dec 2025 study needed "head stability" during calibration; glasses not separately reported | 5–9 points, ~2 s each | Apache-2.0 (MediaPipe); runs on Apple Silicon (Python wheel, native `libmediapipe.dylib` as used by MacGaze, or WASM/WebGL in a renderer); landmarks ~5–15 ms/frame on CPU/GPU | [S1], [S2], [S3] |
| **Geometric: Apple Vision face landmarks (76 points, pupils) + face-rectangle head pose (roll/yaw/pitch)** | No published gaze accuracy. Pupils are one 2D point per eye; a developer's gaze tracker built on it noted the landmarks request alone gives no head pose and "couldn't reach the screen edges" until pose was added | Same physics; the Vision models are robust to glasses/hats/masks for detection, pupil precision unpublished | Needs the same 5–9 point regression | Free, on-device (ANE), already running in ARES Vision.app (face rectangles) | [S4], [S5], [S6] |
| **Appearance-based CNN (L2CS-Net, ETH-XGaze baseline, MobileOne/ResNet "MobileGaze")** | Person-independent angular error: 3.92° L2CS on MPIIGaze, 4.7° ETH-XGaze baseline, 9–13° on Gaze360 (wild); in a screen study (80 cm): 6.95° uncalibrated → **3.3° / 53 mm** after a 4-point calibration, 5.1° / 80 mm with ±30° head rotation, 4° / 60 mm with ±10 cm lateral movement | Glasses raise appearance-model error from 2.8° to 4.5° (vs 1.0→1.4° for an IR Tobii); lighting reflections "distorted outputs" | 4–9 points | L2CS-Net and MobileGaze are MIT; ONNX → Core ML conversion is routine; MobileOne-S0 is 4.8 MB and a few ms on CPU | [S7], [S8], [S9], [S10], [S11] |
| **Tiny appearance model with few-shot personalisation: BlazeGaze / WebEyeTrack (Aug 2025)** | 2.32 cm on GazeCapture (phones), 4.56 cm MPIIFaceGaze (laptops), 7.5 cm EyeDiap; 20% drift over 20 min vs WebGazer's 49% | Head pose from MediaPipe landmarks is an input, so head motion is modelled | 9 samples (MAML few-shot) | MIT; 670 KB, 0.15 GFLOPs, 0.88 ms on a desktop CPU, 2.4 ms on an iPhone 14; TF.js and Python | [S12], [S13] |
| **MacGaze (Jun 2026): the above pipeline ported to Swift/Core ML for Apple Silicon** | "Mean gaze error with 4-point calibration" 8.1% of screen (≈ 2.4 cm horizontally here); centre 2.4%, edges 18–20% | Head pose via MediaPipe's transformation matrix | 4 points (author notes 9 would be better) | MIT; BlazeGaze as a 725 KB Core ML model, 17 ms inference; the unoptimised pipeline is ~170 ms/frame; macOS 15+, Apple Silicon only; "pipeline verified", crashes on some M1s | [S14] |
| **WebGazer.js (browser, ridge regression on eye pixels, self-calibrates from clicks)** | 4.17° in the original 2016 lab study; a 2025 systematic evaluation with 20 people found **10.3–13.6° mean angular error (1009–1383 px)**; cursor-click calibration best; glasses halve the usable accuracy (20% vs 54% "accurate" samples in another study) | No head-pose model: error doubles over 20 min of use | Implicit (clicks) or explicit dots | GPL-3.0 (commercial licence sold separately); JS, runs in Electron | [S15], [S16], [S17] |
| **Beam Eye Tracker (Eyeware, commercial, gaming)** | Claims **1.5° "in ideal conditions"**, worse at screen edges and on big screens; no independent laptop numbers found | Head tracked 6-DoF (its main product); 30–80 cm | Built in | $29.99 one-off; SDK royalty-free but needs the Beam app running; closed source; macOS 14+/Apple-Silicon-native beta (macOS 15) in 2026; Python/C/C++/C# bindings | [S18], [S19], [S20] |
| **GazeRecorder / GazeFlow / GazePointer** | Claims 1.05°; measured independently at **2.65° / 55 mm still, 4.1° / 80 mm with head rotation, 1.9° / 30 mm with lateral movement** (80 cm) | — | Built in | Closed, Windows-first; API products | [S21], [S7] |
| **Tobii** | No webcam gaze SDK. Tobii Aware = presence/attention on Windows laptops with Windows Hello cameras (dim when away, blur when someone peeks, stay awake). Eye Tracker 5 hardware (0.9° / 15 mm in the same 80 cm test) is Windows only | — | — | Not available on macOS | [S22], [S23], [S7] |
| **Reference points: Apple's own eye trackers** | iPhone/iPad Eye Tracking (iOS 18, TrueDepth): reviewers call it "close but overshoots", needs recalibration when light or position changes. Vision Pro: 0.45–1.1° measured; Apple still requires 60 pt ≈ 2.5–3° targets and never lets eyes trigger anything | — | 1 pass | Not on macOS (see 1.3) | [S24], [S25], [S26] |
| **Gaze-LLE (CVPR 2025)** | State of the art for a *third-person* "where in this photo is that person looking" (gaze-following), not screen gaze from a webcam. Not applicable | — | — | — | [S27] |

Reading the table: the only numbers below 2° on a webcam come from either (a) claims by vendors, or (b) studies where
the head was still for calibration and the room was bright. The repeatable, honest band for a seated laptop user who
moves normally is **3–5°**, exactly what docs/gaze-prompt.md §0 assumes. Few-shot personalisation (9 samples) and an
explicit head-pose model are the two things that separate the usable systems from WebGazer-class ones. The 2026
meta-calibration paper is the clearest single data point: 2.9° with the head held still, 5.8° once the head moves.

### 1.3 What macOS itself offers (checked against macOS 26)

- **Vision framework.** `VNDetectFaceRectanglesRequest` revision 3 reports roll, yaw **and pitch** in continuous
  radians (pitch since macOS 12). `VNDetectFaceLandmarksRequest` revision 3 gives a 76-point constellation with
  "accurate pupil detection": one 2D point per pupil, no iris contour, no 3D eye model, no gaze vector. WWDC25's Vision
  additions were document reading, lens-smudge detection and a hand-pose update; **there is no gaze request** in Vision
  on macOS 26. ARES Vision.app already runs the face-rectangle request on every frame, so adding landmarks is one more
  request on the same `VNImageRequestHandler`. [S4], [S5], [S28]
- **ARKit face tracking / Attention Aware** need the TrueDepth camera; Macs have none, and Apple's Attention Aware
  features are listed for Face ID iPhones and iPad Pros only. [S29]
- **Accessibility.** macOS has **Head Pointer** (move the pointer by turning the head, built-in camera, since Catalina)
  and Dwell Control; **Eye Tracking as an accessibility feature exists on iPhone and iPad (iOS 18) but not on
  macOS** as of Tahoe 26, whose accessibility additions were Magnifier for Mac, Accessibility Reader, Braille Access
  and Vehicle Motion Cues. Nothing in Head Pointer is exposed as an API, so ARES could not read it anyway. [S30], [S31], [S32]
- **Continuity Camera.** An iPhone as webcam gives up to 1080p (1920×1440 at 4:3), Center Stage, Desk View, and
  `AVCaptureMetadataOutput` face/body metadata objects (face bounds, roll, yaw). **No depth or TrueDepth data crosses
  over**; the WWDC22 session lists every output and depth is not among them. The gain would be a sharper eye image
  (more pixels per degree, see 1.1), at the cost of needing the phone propped on the lid. Worth a one-off test in
  stage B if the user wants it, not a basis for the design. [S33]
- **Camera permission** works as it already does for hands: a real app bundle launched through LaunchServices
  ("ARES Vision.app"). A Python/OpenCV lab script run from Terminal gets the camera as Terminal, which is fine for
  the prototypes.

### 1.4 How real products and research hide coarse gaze

- **Eyes never trigger** (visionOS, "Design for spatial input", WWDC23): targets ≥ 60 pt (≈ 2.5–3°), 16 pt margins,
  rounded shapes so the eye settles on the centre, a subtle hover highlight on everything interactive, and a second
  modality (pinch) to act. visionOS 26 added "Look to Scroll" as the one eyes-only behaviour. This is the model for
  ARES: gaze = pointer, voice = act. [S25], [S34]
- **Snapping / "gravity".** Zhai's MAGIC pointing (1999) warps the cursor to the gaze region and lets a precise device
  finish; Talon's "zoom mouse" (coarse gaze, then a zoomed patch to refine) is how eye-tracking power users actually
  point today. The lesson for ARES: snap the bracket to the nearest *real* target, and when two are within the error
  circle, offer the zoomed patch or ask. [S35], [S36]
- **Dwell and the Midas touch.** Dwell thresholds in the literature run 300–1000 ms; longer is safer but fatiguing;
  the review notes dwell causes both false positives (eyes linger) and false negatives (user is in a hurry). With
  voice as the trigger, dwell only stabilises the *highlight*, so ARES can use a short dwell (~300–400 ms) and a
  sticky release (~1–1.5 s). [S37], [S38]
- **Gaze + speech timing.** The CHI 2026 scoping review of 103 gaze+speech studies (1991–2025) finds "gaze to point,
  speech as command" the dominant pattern, warns that most systems bind the command to whatever is under fixation
  *at the moment of speech*, and that the fixation most associated with a referent happens about **630 ms before the
  word** (psycholinguistics: speakers fixate an object ~900 ms before naming it). Its recommendation is to treat timing
  as a design parameter. For ARES this means the frozen target should be **the dwelled target in the 0.5–1.5 s before
  speech onset**, not the gaze at the moment the deictic ("this") is recognised, and the user may well have looked away
  by then. [S38], [S39], [S40]
- **Pronoun disambiguation with an LLM.** GazePointAR (CHI 2024) and Walkie-Talkie (2024/25) feed the gazed object plus
  the sentence to a language model and resolve "this/that"; the second resolves referents from natural gaze better than
  a no-gaze baseline. ARES already has this shape: "the user is referring to: <target description>" in the brain's context. [S41], [S42]
- **Look-to-Talk (CHI 2002)** used head pose alone to decide whether an utterance was for the software agent, as an
  alternative to a wake word, and users found it natural. That is exactly desk mode's problem. [S43]
- **Presence products** (Tobii Aware): dim when the user looks away, blur when a second face appears, stay awake while
  present, lock when gone. All of it is head pose + face count, no calibration. [S22]

### 1.5 What 3–5° means on this screen

Screen: 3024×1964 at 14.2" → **30.2 × 19.6 cm**.

| Sitting distance | 1° on screen | Screen in degrees | 4×4 cell | 3×3 cell | ARES panel (~9 cm) | App window half-screen (15 cm) |
|---|---|---|---|---|---|---|
| 50 cm | 0.87 cm | 33.7° × 22.2° | 8.6° × 5.6° | 11.5° × 7.5° | ~10° | ~17° |
| 60 cm | 1.05 cm | 28.3° × 18.6° | 7.2° × 4.7° | 9.6° × 6.2° | ~8.5° | ~14° |
| 70 cm | 1.22 cm | 24.4° × 16.0° | 6.2° × 4.0° | 8.2° × 5.4° | ~7.3° | ~12° |

With a 3° error, 95th percentile around 5–6°: a 3×3 grid is reliable, a 4×4 grid is reliable horizontally and shaky
vertically, ARES's panels and orbs (several centimetres, well separated) are fine, side-by-side app windows are fine,
**overlapping windows are decided by what is on top at the gaze point** (fine), and anything under ~4 cm (toolbar
buttons, file icons in a grid, a line of text) is a guess. Stage B replaces these estimates with measurements.

## 1b. Best use cases for this user's productivity (ranked)

How the user works: a MacBook; ARES as the live desktop with desk mode (no wake word, voiceprint-gated); full Mac
control (files, windows, browser, UI automation, send to phone); Claude Code sessions; VS Code, Terminal and Chrome.

| # | Use case | What it saves / removes | Gaze accuracy needed | Works with coarse (3–5°) gaze? | Effort | Privacy | Does a mouse/keyboard do it as well? | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | **Presence and attention for desk mode**: facing the screen vs turned away vs nobody there; feed `addressed.js` ("speech while facing the screen leans for-ARES, turned away leans not"), pause/resume subtitles and TTS when the user looks away, "welcome back", hold ARES's own toasts while away, a second face = hold private things | Removes the main failure of wake-word-free desk mode: ARES answering speech that was for someone else, or missing a request that didn't match a keyword. Today `addressed.js` only sees words and timing | None: head yaw/pitch to ±10° and eye-region cues | **Yes**, no calibration | Low: the face-rectangle request is already running in ARES Vision.app; add landmarks for eye openness and a "facing" classifier | Camera on only in desk mode and unlocked, frames stay in the helper, output is a 3-state flag | No; there is no keyboard equivalent to "was that for me?" | **Build first** |
| 2 | **Look + voice on big targets**: "summarise this / close that / send that to my phone / what's this error?" on ARES panels (phase 1) and app windows (phase 2), with the mouse pointer as the fallback target | Saves moving a hand to the trackpad while talking or typing; makes "this/that" work from across the desk. Honest note: hovering the mouse and saying the same words works today and is exact | 3–5° (targets ≥ 8°) | **Yes** with snapping, dwell, speech-onset freeze, and "which one?" when two targets are within the error circle | Medium: calibration UX, regression, overlay bracket, target lists from the scene and CGWindowList | Screenshot only on a command that needs one | Partly (mouse hover) — gaze wins when hands are on the keyboard or away from the Mac | **Build (phases 1–2)** |
| 3 | **Attention-aware ARES notifications and subtitles**: hold toasts while the user is reading or typing steadily, show them in the screen half the user is *not* looking at, reveal them when gaze goes to the bar/pill; the "someone is looking at the screen with me" hold | Fewer interruptions; the large-scale deferral study saw 50% faster responses when notifications waited for a breakpoint; gaze-contingent placement reduced distraction in the CHI'17 study | Coarse (which half / which window) | **Yes** | Low–medium on top of #1 and #2 (theme-notify already draws ARES's toasts) | Same as #1 | No (macOS Focus modes are blunt and manual) | **Build after 1–2** |
| 4 | **"Where was I?"**: when the user looks away (phone, person, other screen) and comes back, highlight or re-lift the window/panel they were in; optionally the last-read region | Gazemarks cut re-orientation from ~2000 ms to ~700 ms per switch | Window-level: coarse. Paragraph-level: 1–2° vertical (not available) | **Window-level yes**, line-level no | Low on top of #1–2 | Same | Partly (the window is usually still in front) | **Build with limits** (window-level) |
| 5 | **Focus follows gaze**: the window the user looks at gets keyboard focus, or gaze-assisted Cmd-Tab ("the window I'm looking at" when a key is pressed) | EyeWindows (CHI 2005): eye + key ~30% faster than mouse for focus switching; *automatic* activation was worse than a key | 3–5° between windows; on a 14" screen windows overlap heavily | Marginal: overlapping windows and the Midas-touch risk of typing into the wrong window | Medium | Same | **Yes**: Cmd-Tab / Cmd-` are fast and never wrong | **Skip** (maybe later as "look + say 'focus that'", which is #2) |
| 6 | **Auto-scroll while reading** | Räihä et al. found gaze scrolling faster and liked — with a Tobii. It needs a stable vertical reading zone | 1–2° vertical, drift-free | **No** (vertical is the weakest axis; drift makes it jump) | Medium | Same | Yes (two fingers, space bar) | **Skip**; "scroll this down" by voice on the gazed window is #2 |
| 7 | **Reading assist**: define/translate the word being looked at (iDict) | Real in the literature, but iDict used a lab tracker and word-level fixations | ~0.5° (a word is ~0.5–1 cm) | **No**. Fallback: "define that" → OCR a ~10 cm patch around the gaze and let the brain pick the odd word | Low as a phase-3 crop | A crop is read only on command | Yes (double-click → Look Up) | **Skip** as gaze; keep the crop fallback |
| 8 | **Focus / distraction report** ("40 min on X, 12 min on the phone") | Mild self-knowledge | Coarse (screen vs not) | Yes | Low once #1 exists | **Highest**: a log of attention over the day; keep it to counts, never timestamps of looking away | Mostly: app-usage time exists without a camera | **Skip** for now; offer later as an opt-in "time away" count only |
| 9 | **Dim / lock / stay awake by presence** (Tobii Aware clone) | Small: macOS already does this on timers | None | Yes | Low once #1 exists | Same as #1 | Mostly | **Fold into #1** (stay awake while present, lock sooner when gone — opt-in) |
| 10 | **Gaze + pinch** | Depends on hand gestures, which are parked | — | — | — | — | — | **Not now** (as the prompt says) |
| 11 | **Elements inside windows** (phase 3: buttons, files, table rows by gaze) | The dream, but a 3–5 cm error circle covers 5–20 of them | ≤ 1° | **No** as a direct pick. Partially via accessibility: the gaze picks the *window*, the words pick the element ("the Save button", "that red error line"), the brain resolves | Medium–high | Screenshot/OCR crop only on command | Yes (click) | **Build only the fallback**: crop + OCR/brain, and name-based element resolution inside the gazed window |

**Top picks, in order:** 1 presence/attention → 2 look + voice on panels and windows → 3 attention-aware ARES
notifications → 4 "where was I" at window level. **Skip:** auto-scroll, word-level reading assist, automatic focus
follows gaze, the distraction report, and direct element picking (keep the crop-and-ask fallback).

## What stage B would measure (focused on the user's picks)

For each candidate (Apple Vision geometric; MediaPipe iris + head pose + regression; BlazeGaze appearance model with
few-shot calibration; optionally Beam as a paid closed-source ceiling if the user wants to buy it):

1. **Accuracy test** (one shared harness): 9-point calibration, then 20 targets across the screen; mean and 95th
   percentile error in cm and degrees, horizontal and vertical separately; repeated with glasses on/off if the user
   wears any, in room light and dim light, and a "turn the head 10–15°" round and a "lean 10 cm" round.
2. **Drift**: the same 20 targets again after 5 minutes of normal work without recalibration; what a 3-point refresh
   recovers.
3. **Target discrimination in practice**: how often the snapped target is right for a 3×3 grid, a 4×4 grid, ARES's
   real panel layout, and two side-by-side windows (the number that decides phases 1 and 2).
4. **Speech-onset freeze**: with the user saying short commands at marked targets, the hit rate of "the dwelled target
   0.5–1.5 s before speech onset" vs "the gaze at the word" (to set the window size).
5. **Presence**: facing the screen vs looking at a phone on the desk vs turning to a person vs gone, from head pose
   and eye cues; confusion matrix over a few minutes of acted switches; then replayed against desk-mode style
   utterances to estimate the gain for `addressed.js`.
6. **Cost**: CPU % of one core, GPU, and energy impact at 10 fps for landmarks at 720p (hands alone measured ~16% of a
   core at 10 fps and 640×480 on 2026-10-04); latency camera→target.
7. **Camera resolution**: 640×480 vs 1280×720 vs the camera's 1080p, since 1.1 says the eye signal is a handful of
   pixels; and, if the user wants, one round with the iPhone as Continuity Camera.

All of stage B needs the user at the Mac (the camera is on); the prototypes live in `~/ARES Projects/gaze-lab`.

## Sources (stage A)

- [S1] Robust camera-based eye-tracking method allowing head movements (MediaPipe + solvePnP, 22 participants), Dec 2025. https://pmc.ncbi.nlm.nih.gov/articles/PMC12734114/
- [S2] EMC-Gaze: deployment-oriented session-wise meta-calibration for landmark-based webcam gaze tracking, 12 Mar 2026. https://arxiv.org/html/2603.12388
- [S3] MediaPipe Face Landmarker (478 landmarks, iris, facial transformation matrix; Apache-2.0). https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker and web guide https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js
- [S4] WWDC21 "Detect people, faces, and poses using Vision": landmarks revision 3 (76 points, accurate pupils), face rectangles revision 3 (pitch, continuous angles). https://developer.apple.com/videos/play/wwdc2021/10040/
- [S5] VNFaceObservation (roll, yaw, pitch in radians; landmarks; faceCaptureQuality). https://developer.apple.com/documentation/vision/vnfaceobservation
- [S6] A developer's Vision-based focus tracker noting pupils alone give no head pose and cannot reach screen edges. https://github.com/MahmoudEzzatAbdul-Rahman/focus-tracker/pull/1
- [S7] Webcam-based gaze estimation for computer screen interaction (OpenVINO/ETH-XGaze models vs GazeRecorder vs Tobii 5, 80 cm, head rotation and lateral movement), Frontiers in Robotics and AI, 2 Apr 2024. https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2024.1369566/full
- [S8] L2CS-Net: fine-grained gaze estimation in unconstrained environments (3.92° MPIIGaze), 2022; MIT. https://arxiv.org/pdf/2203.03339 and https://github.com/Ahmednull/L2CS-Net
- [S9] ETH-XGaze dataset and baseline (4.7°), 2020. https://arxiv.org/pdf/2007.15837
- [S10] MobileGaze / gaze-estimation (ResNet, MobileNet, MobileOne; ONNX; MIT; Gaze360 numbers). https://github.com/yakhyo/gaze-estimation
- [S11] Glasses raise appearance-based error 2.8°→4.5° vs Tobii EyeX 1.0°→1.4° (Person-specific gaze estimation from low-quality webcam images, 2023). https://pmc.ncbi.nlm.nih.gov/articles/PMC10147084/
- [S12] WebEyeTrack: scalable eye-tracking for the browser via on-device few-shot personalization (BlazeGaze), 27 Aug 2025. https://arxiv.org/html/2508.19544v1
- [S13] WebEyeTrack code (MIT, TF.js + Python). https://github.com/RedForestAI/WebEyeTrack
- [S14] MacGaze: software eye tracking for macOS on Apple Silicon (MediaPipe + BlazeGaze Core ML + RBF; MIT; Jun 2026). https://github.com/AACTools/MacGaze
- [S15] WebGazer: scalable webcam eye tracking using user interactions, IJCAI 2016 (4.17° in lab). https://jeffhuang.com/papers/WebGazer_IJCAI16.pdf
- [S16] Systematic performance evaluation of WebGazer with spatial and angular error analysis (10.3–13.6°, 1009–1383 px), MDPI 2025. https://www.mdpi.com/1995-8692/19/5/99
- [S17] WebGazer accuracy with/without glasses (20% vs 54%) and 11–70% variation under fixed lighting (Evaluating webcam-based gaze data, 2024). https://arxiv.org/pdf/2402.19133
- [S18] Beam Eye Tracker (1.5° in ideal conditions; worse at edges). https://beam.eyeware.tech/ and SDK https://beam.eyeware.tech/developers/
- [S19] Beam 2.6.3 Linux and macOS public beta (23 Jul 2026); Apple-Silicon-native 2.6.9 beta needs macOS 15. https://beam.eyeware.tech/beam-eye-tracker-2-6-3-linux-macos-public-beta/ and https://beam.eyeware.tech/support/
- [S20] Beam SDK licence (BET-SDK-License-1.0, royalty-free, needs the Beam app) and pricing ($29.99). https://docs.beam.eyeware.tech/info/license.html and https://beam.eyeware.tech/pricing/
- [S21] GazeRecorder accuracy page (claims 1.05° vs an SMI RED 250). https://gazerecorder.com/webcam-eye-tracking-accuracy/
- [S22] Tobii Aware features (dim, privacy blur, stay awake; Windows Hello cameras). https://help.tobii.com/hc/en-us/articles/360019447498-Tobii-Aware-features
- [S23] Tobii: no macOS support for its trackers. https://help.tobii.com/hc/en-us/articles/360008759714-MacOS-compatibility
- [S24] iOS 18 Eye Tracking (front camera, Face ID devices; "close but overshoots"; recalibrate on light/position change). https://appleinsider.com/articles/24/06/13/eye-tracking-lets-you-navigate-ios-18-without-touching-your-iphone and https://www.digitalcitizen.life/how-to-use-eye-tracking-on-iphone/
- [S25] WWDC23 "Design for spatial input" (60 pt targets, hover, eyes never trigger). https://developer.apple.com/videos/play/wwdc2023/10073/
- [S26] Vision Pro eye-tracking accuracy 0.45–1.1° (Virtual Reality, 2026; earlier 2024 study 0.93–1.11°). https://link.springer.com/article/10.1007/s10055-026-01442-y
- [S27] Gaze-LLE: gaze target estimation via large-scale learned encoders, CVPR 2025 (third-person gaze following, not screen gaze). https://arxiv.org/pdf/2412.09586
- [S28] WWDC25 Vision additions: document reading, smudge detection, hand pose update (no gaze). https://developer.apple.com/videos/play/wwdc2025/272/
- [S29] Attention Aware features need TrueDepth (iPhone/iPad Pro only). https://support.apple.com/en-us/102216
- [S30] macOS Head Pointer (camera-driven pointer, Accessibility). https://support.apple.com/guide/mac-help/use-head-pointer-mchlb2d4782b/mac
- [S31] Apple accessibility press release 13 May 2025 (Eye Tracking updates are for iPhone/iPad; Mac gets Magnifier, Accessibility Reader, Braille Access). https://www.apple.com/newsroom/2025/05/apple-unveils-powerful-accessibility-features-coming-later-this-year/
- [S32] macOS Tahoe 26 announcement (no Mac eye tracking). https://www.apple.com/newsroom/2025/06/macos-tahoe-26-makes-the-mac-more-capable-productive-and-intelligent-than-ever/
- [S33] WWDC22 "Bring Continuity Camera to your macOS app" (formats, Center Stage, Desk View, face/body metadata; no depth). https://developer.apple.com/videos/play/wwdc2022/10018/
- [S34] visionOS 26 "Look to Scroll" (WWDC25 What's new in visionOS 26). https://developer.apple.com/videos/play/wwdc2025/317/
- [S35] MAGIC pointing (Zhai, Morimoto, Ihde, CHI 1999) and its large-display follow-up. https://dl.acm.org/doi/10.1145/2851581.2892479
- [S36] Talon zoom mouse (coarse gaze, then zoom to refine). https://talon.wiki/Resource%20Hub/Hardware/tobii_4c/ and https://handsfreecoding.org/2021/12/12/talon-in-depth-review/
- [S37] Interaction design of dwell selection toward gaze-based AR/VR interaction (dwell thresholds, false positives/negatives), 2022. https://arxiv.org/pdf/2204.08156
- [S38] Gaze and speech in multimodal HCI: a scoping review (103 studies, 1991–2025; temporal alignment, 630 ms lead), CHI 2026. https://dl.acm.org/doi/10.1145/3772318.3791662 (PDF: https://make.kaist.ac.kr/files/2026/KhanA_GazeSpeach_CHI26.pdf)
- [S39] Speakers fixate objects ~900 ms before naming them (Griffin & Bock 2000; gaze durations during speech). https://pmc.ncbi.nlm.nih.gov/articles/PMC5130081/
- [S40] Prasov & Chai: eye gaze for reference resolution in multimodal conversational interfaces (fixation ~630 ms before the referent). https://cse.msu.edu/~jchai/Thesis/zahar-prasov-dissertation-2011.pdf
- [S41] GazePointAR: a context-aware multimodal voice assistant for pronoun disambiguation in wearable AR, CHI 2024. https://arxiv.org/pdf/2404.08213
- [S42] Walkie-Talkie: longitudinal natural gaze, LLMs and VLMs for query disambiguation in XR, CHI EA 2025. https://dl.acm.org/doi/10.1145/3706599.3720236
- [S43] Evaluating Look-to-Talk: a gaze-aware interface in a collaborative environment, CHI 2002. https://kgajos.seas.harvard.edu/papers/ltt-chi2002.pdf
- [S44] EyeWindows: evaluation of eye-controlled zooming windows for focus selection, CHI 2005 (eye + key beats mouse; automatic activation worse). https://www.dgp.toronto.edu/papers/dfono_CHI2005.pdf
- [S45] Gazemarks: gaze-based visual placeholders to ease attention switching, CHI 2010 (2000 ms → 700 ms). https://research-information.bris.ac.uk/en/publications/gazemarks-gaze-based-visual-placeholders-to-ease-attention-switch/
- [S46] Gaze-contingent scrolling and reading patterns (Räihä et al., NordiCHI 2014) and Kumar & Winograd, gaze-enhanced scrolling techniques (2007). https://dl.acm.org/doi/pdf/10.1145/2639189.2639242 and https://hci.stanford.edu/cstr/reports/2007-11.pdf
- [S47] iDict: a gaze-aware reading aid (Hyrskykari, 2006). https://trepo.tuni.fi/bitstream/handle/10024/67601/951-44-6643-8.pdf?sequence=1
- [S48] Noticeable or distractive? A design space for gaze-contingent UI notifications, CHI EA 2017. https://dl.acm.org/doi/10.1145/3027063.3053085
- [S49] Attention and engagement-awareness in the wild: a large-scale study with adaptive notifications (680k users; 49.7% faster response when deferred to a breakpoint), 2017. https://www.researchgate.net/publication/316463499_Attention_and_Engagement-Awareness_in_the_Wild_A_Large-Scale_Study_with_Adaptive_Notifications
- [S50] Everyday eye contact detection using unsupervised gaze target discovery, UIST 2017; and Accurate and robust eye contact detection during everyday mobile device interactions, 2019. https://dl.acm.org/doi/10.1145/3126594.3126614 and https://arxiv.org/pdf/1907.11115
- [S51] Webcam eye tracking to detect mind wandering: glasses were the only factor that hurt accuracy (Behavior Research Methods, 2022). https://link.springer.com/article/10.3758/s13428-022-02040-x
- [S52] iTracker / GazeCapture: 1.7 cm on phones, 2.8 cm on tablets without calibration (2016). https://ar5iv.labs.arxiv.org/html/1606.05814

---

# STAGE B (to be added after the user's go)

Prototypes: `~/ARES Projects/gaze-lab`. Sections 2 (measurements), 3 (presence) and 4 (design recommendations and the
proposed diff to docs/gaze-prompt.md) follow here.
