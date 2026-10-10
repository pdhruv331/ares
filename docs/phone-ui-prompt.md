PHONE UI v3: make the ARES launcher and app FLUID (motion that carries the finger's position and speed), give ARES one continuous presence (bubble ↔ reactor ↔ cards ↔ apps), show results as native cards, put Mac jobs in the system strip with a task receipt, and add the Meta-Muse-inspired trust features. Android only for the UI (android/), plus the small Mac-side pieces named below. Commit after each working step.

READ FIRST
1. reports/ARES phone UI and Meta Muse.md (sections "The phone becomes the brain's body", "Fluid motion carries position and speed…", "A HUD must earn every pixel…", "Meta Muse … copy its receipts"), and reports/ARES phone as Jarvis extension.md for background. The notes are in research_notes/ beside them.
2. CLAUDE.md, especially "The ARES launcher" (HomeActivity, HomePager, HomeGrid/HomeBoard, Reorder, AppDrawer, HomeOverlay, Bubble, Scheme, the emulator recipe and debug hooks) and "Power from the phone and the relay".
3. The code: HomePager.kt (fixed 280 ms DecelerateInterpolator snaps, velocity only as a switch, ±12% hard clamp), AppDrawer.kt (220 ms timed fade-slide), Reorder.kt / HomeGrid.kt / DragFrame.kt (fixed 120–180 ms animate(), removeView/addView on drop → CANCEL), Bubble.kt (ValueAnimator edge snap), ReactorView.kt (postInvalidateDelayed throttle, BlurMaskFilter glows), HomeOverlay.kt (notification orbs on the arc at 1.55 r, the meeting ring at 1.12 r, Buds at 1.18 r, the Mac link), Haptics.kt (error() is a full-amplitude six-step buzz), Jobs.kt, Push.kt, Apps.kt, HomeActivity.tapReactor.

WHAT THE OWNER AGREED (interactive renders in the planning session)
- Springs with velocity everywhere, rubber-band edges, a finger-tracked drawer with staggered rows.
- Reactor states told apart by SHAPE (not only colour).
- The reactor grows out of the floating bubble and condenses back; answers land as native cards; opening from a card launches the app from the card's bounds; a "back to ARES" chip on the bubble; the card settles back where it left.
- Mac jobs as an Android 16 Live Update chip → a TASK RECEIPT sheet; approvals with a fingerprint; Undo after sending.
- Context chips under the reactor.
- NOT WANTED: the WORK arc around the reactor (it would sit on the notification-orb arc). Jobs that need the owner appear as ONE amber orb in the EXISTING notification-orb arc instead (same slots, same hold/drag/absorb behaviour); running jobs live in the status-bar Live Update chip; the full list stays on the board's WORK card.
- NOT in this build (explicitly declined for now): new themes (Glass/Dusk/Night), the "fun" extras (tap ripples, spin-the-reactor, tilt parallax, bobbing orbs, easter eggs), optimistic replies and the shorter 0.35 s hold. Don't add them.
- Muse: copy the ideas below; do NOT integrate the Muse agent or the Muse models (no Muse Glimmer offline brain).

HARD RULES
- Stay on Android Views (no Compose rewrite). A ComposeView is acceptable only for a brand-new self-contained sheet if it clearly saves effort.
- Keep every existing behaviour working (hold-to-talk, captions, notification orbs incl. drag-into-core, meeting ring, Buds, the Mac link, modes, calls, board, drawer search, power sheets, schemes, the bubble, Files, Outbox). Respect the system "Remove animations" setting (ValueAnimator.areAnimatorsEnabled()).
- Match or slightly soften One UI's pace; never faster or bouncier than the system. Fades/colour never bounce.
- Never animate a state that isn't confirmed (a dropped link looks like a dropped link, not endless "thinking").
- Tier rules from control.js apply to any action started from a card or receipt; tier 3 needs BiometricPrompt on the phone itself.
- Don't touch the phone line (CLAUDE.md). Tests that need speech use Kokoro/mocks.

1. MOTION KIT (new Motion.kt)
- Spring tokens from Material 3 Expressive (damping / stiffness, verified in the Compose source): FastSpatial 0.6/800, DefaultSpatial 0.8/380, SlowSpatial 0.8/200; FastEffects 1.0/3800, DefaultEffects 1.0/1600, SlowEffects 1.0/800 (effects = alpha/colour/glow, never overshoot). Check by eye on the Galaxy that SpringForce stiffness units match.
- A gesture-to-spring helper: track 1:1 during the drag; on release read VelocityTracker.computeCurrentVelocity(1000), project the resting point from the velocity, pick the target (page/open/slot) from the projection, start a SpringAnimation from the current value with setStartVelocity; if the finger lands mid-flight, animateToFinalPosition() (retarget, never restart). Always set explicit damping (the library default is bouncy).
- Rubber-band helper (offset grows ever more slowly past an edge, springs back), and a stagger helper (rows/tiles 15–30 ms apart on the same spring).
- Taps open with damping 1.0; anything released from a fling uses 0.75–0.8.

2. PAGER AND DRAWER (HomePager.kt, AppDrawer.kt)
- Pages follow the finger, keep the flick's momentum (DefaultSpatial), rubber-band at both ends instead of the ±12% clamp.
- The drawer is a finger-tracked sheet (SlowSpatial), opened and closed by drag or fling from anywhere in its travel, rows entering with a stagger; its search field rides the keyboard frame by frame (WindowInsetsAnimationCompat).
- Returning home plays a short settle (content from ~0.94 scale and partial alpha to full) to cover the system's generic close animation.
- Predictive back for the drawer, sheets and cards (OnBackPressedCallback.handleOnBackProgressed / OnBackAnimationCallback on API 34+, TransitionManager.controlDelayedTransition to scrub), keeping the system back-to-home animation (Android 16 observer priority where it applies).

3. REORDER, BOARD AND BUBBLE (Reorder.kt, HomeGrid.kt, DragFrame.kt, Bubble.kt)
- Hovering a drag moves the other items with retargeted springs; re-parent only after the springs settle (this also removes the CANCEL-on-drop problem).
- The bubble keeps the throw's velocity and springs to the nearest edge (DefaultSpatial), rubber-banding at the top/bottom.

4. THE REACTOR'S STATES (ReactorView.kt, HomeActivity.kt)
- Sprung parameters read by the draw loop: LISTENING = coils open, the ring follows the mic level; THINKING = the core contracts and pulses about once a second (heartbeat); SPEAKING = the ring follows the TTS amplitude; DONE = one spatial settle with a single overshoot; INTERRUPTED = collapses in under 100 ms with a haptic tick (on a tap or a new hold), while the cancel travels to the Mac. Announce state changes to TalkBack.
- Frame pacing: drop the postInvalidateDelayed throttle; use postInvalidateOnAnimation with requestedFrameRate votes (≈30 when idle, high during holds, state bursts and pager drags) where the Galaxy supports adaptive refresh, falling back to the current throttle if not. No mixed 30/120 rhythm during a page swipe.
- Glows: keep BlurMaskFilter unless profiling shows it's expensive; then an AGSL RuntimeShader driven by the same springs. No live RenderEffect blur on the reactor.

5. ONE CONTINUOUS PRESENCE (Bubble.kt, HomeOverlay.kt, Apps.kt, Assistant/AskActivity as needed)
- Summoning from another app (bubble hold, side key/assistant, the tile) never opens a new screen: the reactor grows out of the bubble's position over the current app (SlowSpatial), listens/thinks/speaks there, and condenses back into the bubble when done or dismissed.
- When a card opens an app, launch it from the card's bounds (ActivityOptions.makeScaleUpAnimation / makeClipRevealAnimation with the card rect, as Apps.kt already does for icons). The bubble then carries a small "back to ARES" arc (with the card's icon) for ~30 s; tapping it returns and the card springs back into the spot it left from.

6. RESULT CARDS (new card views on the phone + a small Mac-side card spec)
- A fixed catalogue of about eight kinds: summary, list, event, place, file, image, job progress, approval. The Mac brain returns a card spec (A2UI-style JSON: kind + data + up to three follow-up actions); the phone draws ONLY known kinds with its own scheme-coloured views; unknown kinds fall back to text. Use the same spec in the Mac window if cheap (renderer side), otherwise phone first.
- Each card: a headline of ≤ 12 words, two or three facts, two or three verbs (e.g. Open / Send to Mac / Share / Remind me). She speaks the full answer; the card's key lines stay after the speech ends. Small muted captions stay as they are.
- Mac side: a tool or reply convention for the brain to attach a card spec to an answer (e.g. a `card` field in the reply stream / a `show_card` tool), validated against the catalogue before it's sent.

7. JOBS IN THE SYSTEM STRIP + THE TASK RECEIPT (Jobs.kt, Push.kt, a new receipt sheet; Mac: jobs.js/autonomy.js/audit.jsonl)
- Each running Mac job/project, a Mac wake-up and a call becomes an Android 16 Live Update (Notification.ProgressStyle, segmented: planning, running, tests, verifying, done) with a status-bar chip. It alerts only on NEEDS YOU, FAILED or DONE; silent progress updates go at normal FCM priority (high priority only when something visible changes, so FCM doesn't downgrade ARES). Check on the real Galaxy whether third-party Live Updates show in Samsung's Now Bar and report it.
- NEEDS YOU on the home page = one amber orb in the existing notification-orb arc (HomeOverlay slots), not a new ring. Opening it shows the approval.
- Tapping the chip, the amber orb or a job on the WORK card opens the TASK RECEIPT (Muse's "task lineage"): every step with its time and outcome (from the job's events + audit.jsonl), the files touched, the independent outgoing check (below), and Stop / Open on Mac. Pings only when something changes or needs the owner, never "still working".
- Approvals in the receipt (and in their notification): the exact action in one line, APPROVE with BiometricPrompt for tier 3, EDIT (change the plan/message before it runs) and NOT NOW as the third choices; after a send, an UNDO window (~10 s) where the action allows it.

8. MUSE-INSPIRED TRUST AND INTAKE (Mac side mostly)
- INDEPENDENT OUTGOING CHECK ("Sentinel"): before anything leaves on the owner's behalf (email, message, upload, form, post, payment), a separate tool-less check (a cheap one-shot, not the acting session) reviews the exact payload against the request: right recipient (in contacts?), only the intended attachments, no secrets/keys/ID numbers, no prompt-injected instructions from web/email content. Its verdict is shown in the receipt; a failed check blocks and asks the owner. It never replaces tier 3.
- "IDEAS" STARTERS: two or three context chips under the reactor (and "Ideas · try next" in receipts), chosen from what's relevant now (time, calendar, recent jobs, notifications) and from things the owner repeats; tapping one sends it as a request. Few, accurate, never a catalogue; offer a learned shortcut once, like the Mac's routine suggestions.
- ARES INTAKE EMAIL (design + ask me before creating anything): an address I can forward things to ("deal with this") that becomes a job with a receipt. Propose the cheapest private way (e.g. a Cloudflare Email Worker on the existing relay account → the Mac's job queue, sender allow-list = my addresses only), and wait for my go before setting it up.
- ONE-TIME PAYMENT CARDS: research only for now (which services issue single-use virtual cards to a personal account, e.g. Privacy.com or a bank's virtual cards, how ARES would request one per purchase with my fingerprint). No purchases, no accounts; report options.

9. HAPTICS (Haptics.kt)
- Replace the buzzy error() with a low two-primitive composition. Vocabulary: listening starts = PRIMITIVE_CLICK (same frame the coils open); hold progress = the existing LOW_TICK each eighth; commit = THUD/heavy click; answer arrives = one soft tick as the card lands; needs approval = two ticks 80 ms apart; card docks / drop lands = a tick when the spring SETTLES. ≥ 50 ms between primitives, intensity steps ≥ 1.4×, arePrimitivesSupported() with HapticFeedbackConstants fallbacks. Haptic, sound (existing WAVs, in front only) and shape change land in the same frame.

10. MEASURE AND POLISH
- JankStats (androidx.metrics:metrics-performance) with states ("HomePager: Swiping", "Drawer: Dragging", "Reactor: Summon"), logging frameOverrunNanos too; Macrobenchmark + a Baseline Profile; numbers from the REAL Galaxy (not the emulator) before/after.
- Emulator first (CLAUDE.md recipe), then install on the phone the usual way and give me a short checklist to try (flick pages fast/slow, pull past the edges, drag the drawer halfway and let go, reorder on the board, throw the bubble, summon from Chrome, open a file card and come back, a job's Live Update → receipt → approve with fingerprint → undo, the amber orb, an error haptic).

LATER (separate prompt, not this build): the phone tool server (the brain acting ON the phone through intents, accessibility and approvals) from reports/ARES phone as Jarvis extension.md.
