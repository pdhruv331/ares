# Make the phone ARES's fluid, living body

A Jarvis-style assistant is truly useful on a phone when it finishes a handful of specific jobs from start to end and shows its work along the way. Five jobs stand out: fetch one personal thing at the right moment, report background work and ask for approvals, communicate hands-free, capture now and process later, and handle calls. Breadth and cleverness have failed again and again. For ARES, the Android app and launcher should therefore become the Mac brain's body. They should be a tiered tool server and a context sensor, and one visible "living object", the reactor, should carry every state. That object should float over whatever is on screen instead of taking it over, grow result cards out of itself, and park long-running Mac work in Android's own status strip. The "stiff, barebones" feel is a motion problem, not a toolkit problem. The launcher animates with fixed-length tweens (a 280 ms decelerate for page snaps, 220 ms for the drawer), uses the finger's speed only as a yes/no threshold, stops dead at the edges, and throttles the reactor with delayed redraws. Springs that pick up the finger's speed, per-View frame-rate requests and a crisp haptic vocabulary fix all of this inside the existing Kotlin Views code, so no Compose rewrite is needed. Meta Muse (launched 8 September 2026) is Meta's personal-agent app, built on its new Muse Spark models. It runs errands from a per-user cloud computer and can be reached in its own app or in WhatsApp. It is US-only, has no agent API and doesn't control the phone, so ARES shouldn't integrate it. It is, though, the best current example of a mass-market agent that shows its steps and returns only when something changes. Its open-weights sibling, Muse Glimmer 30B, deserves a small trial as an offline fallback brain on the Mac.

## Usefulness comes from five finished jobs, not from knowing more

The baseline is sobering, and it should shape every UI decision that follows. In YouGov's 2025 US survey the top voice-assistant uses were still weather (59%), music (51%), quick answers (47%) and timers (40%), a pattern described as **"virtually unchanged" since 2018** ([Implicator.ai/YouGov](https://www.implicator.ai/weather-music-timers-americans-still-use-assistants-like-its-2018.md)). A December 2024 survey found **73% of iPhone and 87% of Galaxy owners saw little or no value in their phone's AI features**. The features they did value worked in context with one gesture: Circle to Search at 82%, writing tools at 72% ([9to5Mac](https://9to5mac.com/2024/12/16/most-iphone-owners-see-little-to-no-value-in-apple-intelligence-so-far/)). The famous failures failed on loop closure, not intelligence. The Humane pin could take about ten seconds to answer a weather question ([Gizmodo](https://gizmodo.com/review-roundup-humane-pin-1851403020)). Rabbit's integrations acknowledged requests and then didn't carry them out ([Gizmodo](https://gizmodo.com/rabbit-r1-review-ai-companion-performance-1851452097)). Google withdrew Pixel's Daily Hub weeks after launch because it rarely showed anything beyond weather and suggested videos ([Android Authority](https://www.androidauthority.com/pixel-10-daily-hub-pause-3595993)).

Five jobs survive this evidence, and each is one ARES can do better than a phone-only assistant because a real computer sits behind it:

| Job | What proves it | ARES version |
|---|---|---|
| Fetch one specific personal thing when it's needed | Magic Cue's flagship example: the airline confirmation number on the call screen ([Google Blog](https://blog.google/products-and-platforms/devices/pixel/google-pixel-magic-cue-ai-feature/)) | "Send me the deck I edited this afternoon", fetched from the Mac's files |
| Tell me when background work needs me or is done | Help right after an error was among the most accepted proactive suggestions ([arXiv 2410.04596](https://arxiv.org/html/2410.04596v2)) | Jobs, projects and approvals on the lock screen |
| Communicate hands-free | Writing help is the most valued AI feature (survey above) | Draft, read back, send only on a yes |
| Capture now, process later | Nothing's Essential Space was the part reviewers found most useful ([Android Authority](https://androidauthority.com/nothing-essential-space-button-3538866)) | A reactor hold or side-key press saves the screen plus a voice note to the Mac |
| Screen and handle calls | Google claimed about 37M screened calls a month in the Pixel 6 era ([PhoneArena](https://www.phonearena.com/news/google-call-screen-feature-coming-to-more-markets_id135998)) | The existing call surfaces on the home screen |

A job only counts when its whole loop is visible. That means an acknowledgement in under a second, since voice-agent builders target 600–1,200 ms against a human turn gap of about 200 ms ([Twig](https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms); [Frontiers](https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00731/pdf)). It also means visible progress, a result the owner can check, and a next-step chip. Meta's new agent, discussed below, gives the freshest proof. Its best-reviewed task was outbound and checkable: it contacted four movers and two called back within about two minutes. Its worst moment was a phone number it **made up and then admitted it had invented** ([Yahoo Finance](https://finance.yahoo.com/technology/article/metas-muse-is-an-impressively-capable-ai-agent-despite-some-hiccups-173310662.html)). Users forgive slowness they can watch and don't forgive confident claims they can't check. That is why the UI work in this report is about showing state, not decoration.

The owner's wish not to have to think about what ARES can do has a name in the research: the **gulf of envisioning**. Users don't know what to ask, how to ask it, or how to judge the result ([arXiv 2309.14459](https://arxiv.org/html/2309.14459v1)). Capability lists don't close the gap. Suggestions tied to what is on screen right now do ([Algolia](https://www.algolia.com/de/blog/ux/how-ui-choices-shape-engagement-with-agentic-features)). So do structured starting points: CNN found Muse "more guided" than ChatGPT or Gemini, which "can feel like a blank canvas" ([CNN](https://www.cnn.com/2026/09/23/tech/meta-muse-ai-agent)).

Frequency matters as much as content. In a CHI 2025 study, **90% preferred an assistant that suggested occasionally, but only 47% preferred one that suggested often** ([arXiv 2410.04596](https://arxiv.org/html/2410.04596v2)). The identical suggestion helped at a natural pause and disrupted mid-task ([arXiv 2502.18658](https://arxiv.org/pdf/2502.18658)). The launcher's two or three chips under the reactor should change with the moment, appear after a result rather than during one, and stay empty when there is nothing specific to offer.

## The phone becomes the brain's body: one object, one thread, many surfaces

### Assistants stopped taking over the screen in 2026

The design direction for ARES's presence is now clear, because all three major assistants converged on it in 2026. In February, Gemini Live on Android swapped its full-screen view for a **floating pill** ([9to5Google](https://9to5google.com/2026/02/28/gemini-live-floating-redesign/)). In April's redesign the waveform sits in the centre, and the overlay **"condense[s] into a smaller circle"** as you move around the phone. Even inside the Gemini app, Live now opens over the visible home screen rather than on a new page ([9to5Google](https://9to5google.com/2026/04/07/gemini-live-redesign-android/)). While Gemini processes a prompt its gradient pulses with a heartbeat-like rhythm, and Incognito keeps the same animation in grey, so colour alone signals the mode ([Android Headlines](https://www.androidheadlines.com/2026/05/google-gemini-new-ui-rollout-overlay-gradients-pulsing.html)).

Siri in iOS 27 dropped the screen-edge glow it had used since iOS 18. It now uses a dark Liquid Glass orb that descends from the Dynamic Island to listen, shrinks into a thinking state, and expands into a translucent results overlay. A multicoloured waveform is the only place the old Siri colours survive. MacStories rated the animations' fluidity "top notch" ([MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)). ChatGPT moved voice into the chat thread itself in November 2025, with a live transcript and maps or photos inline ([Thurrott](https://www.thurrott.com/a-i/330108/chatgpts-voice-mode-is-now-built-into-chat-conversations)).

The criticisms are as instructive as the praise. Reviewers marked Siri and Claude down because voice is still "ask, wait, listen", with no way to interrupt mid-answer ([MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/); [Kompozy](https://kompozy.io/reviews/claude-voice-mode)). They also found the top of the screen crowded, because pulling down from there already opens Control Center and notifications ([Engadget](https://www.engadget.com/2215572/apple-ios-27-preview/)).

The lesson for ARES is that **fluid in 2026 means the same object, continuously**. Nothing cuts or cross-fades between states; one shape travels, shrinks and grows. ARES already has the right object, the reactor with its colour schemes; what's missing is fluid transitions between states. Concretely:

- **The reactor is the only state carrier.** The floating bubble, the home reactor and the in-app view are three sizes of the same thing.
- **Summoning from another app never opens a new screen.** A hold on the bubble grows the reactor out of the bubble's position (Siri's descent from the Island).
- **Leaving home shrinks it back into the bubble** (Gemini's condense-to-circle).
- **Summon stays in the thumb zone:** a reactor hold, the bubble, or the side key, never the top edge.
- **Interruption must feel instant even when the Mac is slower.** A tap on the reactor, or the start of a new hold, collapses the speaking animation within about 100 ms with a haptic tick, while the cancel travels to the Mac.

### Results arrive as native cards from a fixed catalogue

Answers are turning into **native cards built from a trusted set of components**, not walls of text. Siri's iOS 27 results mix text with App Intents cards, such as a Reminders card or an inline Notes card, and a swipe down on a response opens a typed follow-up ([MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)). Google's A2UI, released in December 2025, formalises the pattern for agents. The agent streams JSON describing a tree of components plus their data. The client keeps a **catalogue of trusted components** and renders only those, ignoring anything else. Google's framing is "safe like data, but expressive like code" ([SD Times](https://sdtimes.com/ai/google-launches-a2ui-project-to-enable-agents-to-build-contextually-relevant-uis/)). Fully generated UI is the wrong path for a voice assistant: Google's own generative-UI responses can take a minute or more ([Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)).

ARES fits the A2UI model exactly. Claude on the Mac can't ship Kotlin views, but it can return a card spec in one of about eight kinds: summary, list, event, place, file, image, job progress and approval. The phone draws each kind with its own scheme-coloured views, and the same JSON renders in the Mac window. An unknown kind falls back to text.

Each card follows a **spoken-plus-glanceable split**, which is Claude mobile's "key points on screen" pattern ([TechRadar](https://www.techradar.com/computing/artificial-intelligence/claude-ai-adds-a-genuinely-useful-voice-mode-to-its-mobile-app-that-can-look-inside-your-inbox-and-calendar)). ARES speaks the full answer, while the card holds a headline of 12 words or fewer, two or three facts, and two or three follow-up verbs such as "Open", "Send to Mac" or "Remind me". The small, muted captions stay. The key-point lines, unlike captions, remain on screen after the speech ends, because that is what people scan back to.

### Long work lives in the system strip, not in a chat thread

Agent work that runs longer than a turn is moving into ambient indicators.

- **Android Halo**, previewed on 19 May 2026 for "later this year", is a status indicator at the top of any screen. It shows when an agent takes on a task, enters live mode or sends a message ([Google blog](https://blog.google/products-and-platforms/platforms/android/android-halo/)).
- **Gemini Spark** is a 24/7 cloud agent that works while the phone is locked and checks in before major actions ([The Next Web](https://thenextweb.com/news/google-gemini-spark-agentic-assistant-gmail-io-2026)).
- **GitHub Mobile** shows coding-agent sessions as live notifications with their current status ([GitHub changelog](https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions)).

Android 16's sanctioned surface for this is the **Live Update**: a progress notification, optionally split into segments, with a status-bar chip. Full support arrived in QPR1 ([Android Authority](https://www.androidauthority.com/android-16-qpr1-live-updates-3573399)). Google's guidance limits Live Updates to "finite or trackable experiences initiated by the user". They should alert only on critical status changes and never carry recommendations ([Android Developers](https://developer.android.com/design/ui/mobile/guides/home-screen/live-updates)).

That is a precise fit for ARES's Mac jobs, projects, Mac wake-ups and calls. Each becomes a segmented `ProgressStyle` notification (planning, running, tests, verifying, done) that alerts only on "needs you", "failed" or "done". Inside the launcher, the same jobs become a thin segmented arc at the top of the reactor page. It turns amber and pulses once when something needs the owner, and tapping it opens the WORK card. Routines and suggestions don't qualify for Live Updates and belong on board cards.

### Voice to card to app and back follows one path

Voice, card, app and back should form one continuous path. When a card opens an app, the launch should grow out of the card's bounds. Android's `ActivityOptions.makeScaleUpAnimation` and `makeClipRevealAnimation` let the system animate the new app from a source rectangle ([ActivityOptions reference](https://developer.android.com/reference/kotlin/android/app/ActivityOptions?hl=he)). ARES already passes `makeScaleUpAnimation` from icons (`Apps.kt`) and from the reactor (`HomeActivity.tapReactor`). Extending it to cards is cheap.

On return, the card should settle back where it left from. Content should leave and return along the same path, which is Apple's "spatial consistency" rule ([WWDC18 803](https://developer.apple.com/videos/play/wwdc2018/803/)). For about 30 seconds the bubble should carry a small "back to ARES" arc showing the card's icon. A third-party launcher cannot reproduce Pixel's "icon grows into the live app window" animation. That uses privileged remote-animation plumbing, and Lawnchair, the leading open Launcher3 derivative, needs root just for recents integration on Android 15–16 ([Lawnchair GitHub](https://github.com/LawnchairLauncher/lawnchair)). So ARES should own the motion on its side of the hand-off and accept the system's generic close animation.

### The plumbing behind the face

None of this works unless the phone is more than a display. Today the Mac brain has essentially one phone-directed tool, `phone/send`. The previous round's architecture still holds:

- **A typed command envelope.** Home Assistant's notification commands are the model ([HA notification commands](https://companion.home-assistant.io/docs/notifications/notification-commands/)). Tiers are enforced on the phone itself, and tier 3 requires a `BiometricPrompt`.
- **Context as derived labels**, such as driving, home, Buds in or in a meeting, rather than raw sensor data.
- **Presence routing.** If the Mac is active, the Mac speaks. If the phone's screen is on or the Buds are in, the phone speaks. Otherwise ARES sends a visible push.
- **Pointer hand-offs.** A "continue here" card carries a session ID; the session itself stays on the host.
- **Stop at the commit point.** Gemini's Galaxy S26 automation shows the shape: it fills the Uber Eats cart, stops before checkout, and hands control back with a notification and a strong vibration ([9to5Google](https://9to5google.com/2026/03/12/gemini-android-app-automation-galaxy-s26-rollout/)).

Two platform rules constrain the motion work directly. Samsung still scores 5, the worst, on background killing ([dontkillmyapp](https://dontkillmyapp.com/samsung)). FCM downgrades apps whose high-priority messages are data-only ([Firebase](https://firebase.google.com/docs/cloud-messaging/android/message-priority)). So the reactor must never animate a state it hasn't confirmed. A dropped link should look like a dropped link, not an endless "thinking" pulse.

A future always-on Mac mini, which Apple lists at **4 W idle** ([Apple Support](https://support.apple.com/103253)), removes "the Mac is asleep" as the most common failure. Every surface above should therefore be built against a host that is always reachable, with the MacBook as an occasional node.

## Fluid motion carries position and speed, and the launcher discards both today

Apple's canonical definition of a fluid interface still governs the field ([WWDC18 803](https://developer.apple.com/videos/play/wwdc2018/803/)):

- instant response;
- one-to-one tracking under the finger;
- redirectable at any moment, mid-gesture;
- momentum projected from release velocity to choose the destination;
- rubber-banding at boundaries;
- spatial consistency: things leave and return along the same path.

Its warnings are specific. With any lag, things "fall off a cliff". Duration is the wrong control for elastic motion; use damping and response instead. Start critically damped and add bounce only when a gesture carries momentum, because a flick that lands without overshoot "can often feel broken". Its tap-versus-swipe example is Apple Music: tapping opens Now Playing at 100% damping, and swiping to dismiss uses 80%. And "it's not just about framerate. It's what's in the frames."

Google's M3 Expressive systematised the same idea into six spring tokens, shipped in Compose Material 3's source ([AOSP ExpressiveMotionTokens.kt](https://android.googlesource.com/platform/frameworks/support/+/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ExpressiveMotionTokens.kt)). Its research base was 46 studies with more than 18,000 participants ([Dezeen](https://www.dezeen.com/2025/05/28/google-ushers-in-age-of-expressive-interfaces-with-material-design-update/amp/)). Spatial springs for position and size may overshoot. Effects springs for opacity and colour are always critically damped.

Restraint matters as much as technique. Galaxy owners called One UI 8's animations "too rough" and "too fast" compared with One UI 7 ([Samsung Community](https://r2.community.samsung.com/t5/Galaxy-S/Problem-on-one-ui8/m-p/21027200)). Apple toned Liquid Glass down twice and added "Reduce Bright Effects" in iOS 26.4 after users found it "overwhelming, distracting" ([Tom's Guide](https://www.tomsguide.com/phones/iphones/ios-26-4-finally-adds-the-hidden-controls-to-tone-down-liquid-glass-heres-how)). ARES will be judged next to Samsung's system motion on the owner's own Galaxy, so it should match or slightly soften One UI's pace, never exceed it.

### What the code does now

The current launcher code shows exactly where the stiffness comes from:

- **Page snaps ignore the finger's speed.** `HomePager.go()` snaps pages with a `ValueAnimator` fixed at **280 ms with a `DecelerateInterpolator`**. A release always takes the same time, however fast the flick.
- **Velocity is only a switch.** The `VelocityTracker` velocity only decides whether to change page. It is never handed to the animation.
- **The page edges stop dead.** Overscroll is a hard clamp at ±12% of a page.
- **The drawer is a timed cut.** The swipe up triggers once past 8% of the height or a fling, and `AppDrawer.open()` then plays a 220 ms fade-and-slide. The drawer never follows the finger.
- **Every other surface uses fixed durations.** `Reorder` and `HomeGrid` use 120–180 ms `animate()` calls, and the bubble's edge snap is a `ValueAnimator` on the window's x position that ignores the throw.
- **Reordering rebuilds the row.** `Reorder` calls `removeView`/`addView` on drop, which CLAUDE.md already notes CANCELs the touched view.

Each of these is a discontinuity of velocity. The object stops obeying the hand at the moment the hand lets go.

### The recipe in Views

The fix uses the same pattern everywhere, and `androidx.dynamicanimation` supplies all of it ([Android Developers: spring animation](https://developer.android.com/develop/ui/views/animations/spring-animation)):

1. During the drag, set the value directly from the finger, with no animation.
2. On `ACTION_UP`, read `VelocityTracker.computeCurrentVelocity(1000)`.
3. Project where the object would come to rest, and choose the page, the open or closed state, or the slot from that projected point rather than from a distance threshold.
4. Start a `SpringAnimation` from the current value with `setStartVelocity`.
5. If the finger lands again mid-flight, call `animateToFinalPosition()`. That retargets the running spring instead of restarting it.

Two cautions from the same docs. The library's default damping is `DAMPING_RATIO_MEDIUM_BOUNCY`, so ARES should always set explicit values. An `OnAnimationUpdateListener` can stop the animation running off the main thread, so register one only when the draw needs it.

Overscroll at the pager's and drawer's ends should rubber-band, with offset growing ever more slowly as the finger keeps pulling, and spring back on release. A dead stop leaves users unable to tell a frozen phone from one at the edge ([WWDC18 803](https://developer.apple.com/videos/play/wwdc2018/803/)). One UI 8.5's polish of search results, which now "appear gently instead of popping in", shows that a stagger is the cheapest signal of care ([Sammy Fans](https://www.sammyfans.com/2026/01/01/one-ui-8-5-gives-search-animations-a-smooth-upgrade-from-one-ui-8-0/)). Drawer rows and board tiles should enter 15–30 ms apart on the same spring. That figure is a design rule of thumb, not a sourced number.

| M3 Expressive token | Damping / stiffness | Where ARES uses it |
|---|---|---|
| FastSpatial | 0.6 / 800 | Icon press release, reactor touch response, chip pop-in |
| DefaultSpatial | 0.8 / 380 | Pager settle after a fling, card dock, drag-and-drop landing, bubble edge snap |
| SlowSpatial | 0.8 / 200 | Drawer and sheet release, the reactor growing out of the bubble |
| DefaultEffects | 1.0 / 1600 | Alpha, scheme colour, glow intensity, caption fades |
| FastEffects | 1.0 / 3800 | Press highlights, the interruption collapse |
| SlowEffects | 1.0 / 800 | Reactor state cross-fades (ring speed, hue, bloom) |

The notes infer, without verifying, that these values paste directly into `SpringForce` because Compose's `StiffnessMedium` (1500) equals `SpringForce.STIFFNESS_MEDIUM` (1500). This should be checked by eye on the device. Following Apple's rule, sheets opened by a tap (power, colour scheme) use damping 1.0, and anything released from a fling uses 0.75–0.8.

### Every other moving surface

**The drawer** should become a finger-tracked sheet driven by SlowSpatial, with its search field riding up with the keyboard frame by frame through `WindowInsetsAnimationCompat` instead of jumping.

**Reordering** should move existing views with `animateToFinalPosition` on each hover change and only re-parent after the spring settles. That removes the CANCEL problem as a side effect.

**Back** should be predictive. AndroidX Activity's `OnBackPressedCallback.handleOnBackProgressed` reports gesture progress in Views. `TransitionManager.controlDelayedTransition` can then scrub a closing drawer or card with the back swipe, so the owner sees where back leads before committing ([Android Developers: predictive back in Views](https://developer.android.com/guide/navigation/custom-back/support-animations-views)). On Android 16, an observer-priority callback can watch back without consuming it, which keeps the system's back-to-home animation ([Android Developers: predictive back](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture)).

**Returning home** should play a settle: content springs from roughly 0.94 scale and partial alpha back to full. This covers the system's generic close animation that ARES cannot replace.

## A HUD must earn every pixel, every vibration and every frame

### Translate Jarvis without the clutter

The designer of the Iron Man HUDs gives the clearest guardrail against sci-fi clutter. Jayse Hansen made sure "all the graphics had a purpose" on the Mark VII HUD. He held that complexity is acceptable only if what matters reads at a glance, through pattern-based status with zoom for detail. He was asked to leave plenty of black space, and he kept most graphics near the picture plane because fast motion that projects toward the viewer causes discomfort ([Pushing Pixels interview](https://www.pushing-pixels.org/?p=7447)). Shipping assistant home screens agree. Samsung's Now Brief went from "borderline useless" to daily use once it consolidated several summaries into one place ([SamMobile](https://www.sammobile.com/opinion/now-brief-borderline-useless-something-i-use-every-day/)).

These sources produce five working rules for ARES:

1. **Every ring segment is live data or a control.** Battery, job progress, next-event countdown and Mac link health qualify; decorative tick rings don't.
2. **Shapes on the home page, numbers on press-and-hold.** Pattern first, figures on demand.
3. **At least 40% of the reactor page stays empty, and cyan covers no more than about 10% of the pixels**, so amber (needs you) and red (urgent) stand out.
4. **Idle motion is slow and small**, at most about 0.3 Hz. Energetic motion is reserved for state changes.
5. **Body text is near-white, not cyan, at 14 sp or more, with glow only on shapes.** WCAG 2.2 requires 4.5:1 contrast for normal text ([W3C](https://www.w3.org/TR/WCAG22/)), and dim standby blues are the likeliest scheme to fail it.

The percentages in rules 3 and 4 are design judgement, not measured findings.

### Give each state a shape, not just a colour

The reactor's states should differ in shape as well as colour, with every parameter driven by sprung target values that the draw loop reads:

| State | Reactor behaviour | Reference |
|---|---|---|
| Listening | Coils open; the ring follows microphone level | Siri keeps colour only in the live waveform ([MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)) |
| Thinking | The core contracts and pulses in the scheme's hue about once a second | Gemini's heartbeat gradient ([Android Headlines](https://www.androidheadlines.com/2026/05/google-gemini-new-ui-rollout-overlay-gradients-pulsing.html)) |
| Speaking | The ring follows the TTS amplitude | |
| Done | One spatial settle with a single overshoot | |
| Interrupted | Collapses in under 100 ms | |

Because each state has its own shape, it is readable without colour. That matters for colour-blind viewers and for schemes where hue alone carries meaning. Each state change should also be announced to TalkBack.

Glow and glass need care. Google warns that `RenderEffect` is "more expensive than drawing a custom View" ([Android Developers: AGSL](https://developer.android.com/develop/ui/views/graphics/agsl/using-agsl)). Blur belongs on a snapshot behind sheets, never on the live reactor every frame. The reactor currently draws its bloom with `BlurMaskFilter` paints, and an AGSL `RuntimeShader` is the natural replacement if profiling shows those glows are expensive. Its uniforms (level, hue, time) can be driven straight from springs.

### Haptics: crisp clicks, never buzz

Android's own haptics guidance defines the target. Haptics should be **clear**: crisp, discrete, and tied to physical-feeling events. They can be **rich** where clear feels monotone. They should never be **buzzy** ([Android Developers: haptics principles](https://developer.android.com/develop/ui/views/haptics/haptics-principles)). For compositions, the guidance asks for at least 50 ms between primitives so they feel separate, intensity steps of at least 1.4× so a change is felt, and planned fallbacks for devices without primitive support ([Android Developers: custom haptics](https://developer.android.com/develop/ui/views/haptics/custom-haptic-effects)).

ARES's `Haptics.kt` is half-way there. Its tick, click and heavy effects are clear predefined ones, and `HoldDetector`'s tick on each eighth of the hold, with a heavy click at commit, is exactly right. But `Haptics.error()` is a six-step waveform at full amplitude, the buzzy pattern the guidance warns against.

| Event | Haptic | Timing |
|---|---|---|
| Listening starts | `PRIMITIVE_CLICK` | Same frame the coils open |
| Hold progress | `LOW_TICK` each eighth (existing) | Each eighth of the hold |
| Commit | `THUD` or heavy click | At commit |
| Answer arrives | One soft tick | As the card lands |
| Needs approval | Two ticks 80 ms apart | When the strip turns amber |
| Card docks or drop lands | Tick | When the spring settles, not when it starts |
| Error | A low two-primitive composition | Replaces the full-amplitude buzz |

This vocabulary is proposed for ARES, not taken from Google. ARES should check `arePrimitivesSupported()` and fall back to `HapticFeedbackConstants`. Each haptic should pair with a sound of 150 ms or less from the existing WAV set, played only while ARES is in front. Haptic, sound and shape change should land in the same frame so they read as one event.

### Fit the frame budget and measure on the real phone

At 120 Hz each frame has **8.3 ms**. Android 15's adaptive refresh rate lets each View vote on the rate it needs through `requestedFrameRate`. Only Views being redrawn vote, the highest vote wins, and touch automatically boosts to high rates ([Android Developers: ARR](https://developer.android.com/develop/ui/views/animations/adaptive-refresh-rate)).

The reactor currently limits itself to 20–30 fps with `postInvalidateDelayed`. That has two costs. The panel can't drop its refresh rate to save power. And during a page swipe the reactor slides at 120 Hz while its internals tick at 30, a mixed rhythm that reads as judder. The reactor should instead request `requestedFrameRate = 30f` while idle, request high rates only during holds, state bursts and pager drags, and use `postInvalidateOnAnimation`. Whether Galaxy panels report `hasArrSupport()` is unconfirmed. If they don't, the plain self-throttle remains the fallback.

Measurement belongs on the real phone. JankStats (`androidx.metrics:metrics-performance`) tags frames by state, for example "HomePager: Swiping" ([Android Developers: JankStats](https://developer.android.com/topic/performance/jankstats)). By default it flags only frames longer than twice the refresh period, so ARES should also log `frameOverrunNanos` to catch single missed frames, which are still visible at 120 Hz. A Baseline Profile speeds code execution by about 30% from first launch ([Android Developers](https://developer.android.com/develop/ui/compose/performance)). The emulator's software GPU (27 fps on home) says nothing about the Galaxy.

Reduced motion is already partly honoured. The pager and drawer check `ValueAnimator.areAnimatorsEnabled()`, and the reactor should follow: still when idle, instant shape swaps on state changes.

### Stay on Views

Google now says Compose 1.9 and later **match Views for scroll jank** ([Android Developers](https://developer.android.com/develop/ui/compose/performance)). Compose's shared-element and `MotionScheme` APIs would save effort for many card-to-detail transitions. Even so, nothing above needs Compose, and the hottest path, custom Canvas or AGSL drawing, is identical in both. Rewriting `HomePager`, `Reorder`, `HomeGrid` and `DragFrame`'s custom touch code would cost weeks for no visible gain, and adding Compose grew one sample app by **782 KB** ([Android Developers](https://developer.android.com/develop/ui/compose/migrate/compare-metrics)). The pragmatic route is a small in-house motion kit in Views, with a `ComposeView` reserved for any new self-contained sheet.

### Seven changes, in order

| Order | Change | Files touched | How to know it worked |
|---|---|---|---|
| 1 | Motion kit: spring tokens, a gesture-to-spring helper with projection and rubber-band, a stagger helper | new `Motion.kt` | Used by every step below |
| 2 | Finger-tracked pager and drawer, released with velocity; staggered rows; keyboard-synced search | `HomePager.kt`, `AppDrawer.kt` | JankStats "Swiping" state free of jank on the Galaxy; no fixed durations left |
| 3 | Reorder and board moves by retargeted springs; re-parent after settle; bubble throw with velocity | `Reorder.kt`, `HomeGrid.kt`, `Bubble.kt` | No CANCELs on drop |
| 4 | Reactor state machine with sprung parameters, interruption collapse, frame-rate votes, reduced-motion still | `ReactorView.kt`, `HomeActivity.kt` | Reactor idles at 30 Hz; state changes never pop |
| 5 | Presence continuity: reactor grows out of and condenses into the bubble; card bounds feed app launches; return chip | `Bubble.kt`, `HomeOverlay.kt`, `Apps.kt` | Voice → card → app → back with no hard cut |
| 6 | Card catalogue (about eight kinds, A2UI-style JSON) with follow-up chips; WORK arc plus `ProgressStyle` Live Updates | new card views, `Jobs.kt`, `Push.kt`, Mac side | Same spec renders on Mac and phone |
| 7 | Haptic and sound vocabulary; predictive back; Macrobenchmark plus Baseline Profile | `Haptics.kt`, activities | Error no longer buzzes; first-launch speed |

## Meta Muse is an errand agent in a cloud computer: copy its receipts, not its runtime

### What it is and where it came from

"Meta Muse" names two things. The first is **Muse Spark**, a family of closed models from Meta Superintelligence Labs. It first shipped on 8 April 2026 to power the Meta AI app, and Meta called it "small and fast by design" ([Meta newsroom](https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/)). The second is **Muse**, a consumer personal agent launched on **8 September 2026** in the US. Meta's pitch is that it "doesn't just answer questions, it actually does the work" ([Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)).

Muse breaks with the Llama era. Meta's frontier models are now closed and paid, and only a distilled model is open: **Muse Glimmer**, 30B parameters under Apache 2.0, released on 10 August for "always-on local agent workflows" ([Meta research blog](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)). Three unrelated products share the name: Microsoft's gameplay model, Interaxon's EEG headband and Google's 2023 image model. None of them is meant here.

### How it works

The agent sends email, books travel, fills in forms and negotiates on the user's behalf. It remembers details mentioned once and keeps working after the app closes, coming back "when something changes or needs approval". Its architecture is built for defence in depth:

- a dedicated per-user **Muse Secure VM** that holds both the agent and the user's data;
- a separate **Sentinel agent** that must approve anything Muse sends to the internet;
- credentials kept in a store the model can't read;
- confirmation before sending email or buying anything;
- an **audit trail of past and planned actions**;
- checkout through a **one-time Link-by-Stripe card**.

A Confidential VM encrypted with a key the user holds is promised "later this year" ([Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)). At Connect on 23 September, Meta announced more: Mac computer use, the agent's own email address to CC or forward mail to, a glasses wake word, Shopify, PayPal and retail partners, and a connector platform that drew more than 1,500 applications in under a week ([TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/)).

### How it is useful on phones now

On a phone, Muse is a standalone iOS and Android app, and also a WhatsApp contact you message "just like messaging another person" ([Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)). It overtook ChatGPT as the **#1 free app on the US App Store** ([Fortune](https://fortune.com/2026/09/22/metas-muse-ai-is-exploding-in-popularity-and-drawing-heated-backlash/)). There is a free tier, plus Power at $20 a month and Maximum at $100. Even the free tier needs a card on file, which reviewers flagged as friction ([Let's Data Science](https://letsdatascience.com/news/meta-launches-muse-personal-ai-agent-403f80e4)).

Hands-on reviews draw a consistent picture. **What worked:**

- movers' quotes, with two of four movers calling back within about two minutes ([Yahoo Finance](https://finance.yahoo.com/technology/article/metas-muse-is-an-impressively-capable-ai-agent-despite-some-hiccups-173310662.html));
- a date-night booking through OpenTable (same review);
- a fantasy-football waiver claim and lineup change (same review);
- a game purchase that showed the total before the user pressed buy (same review);
- a family morning-newsletter PDF built from calendar, email and school schedules, judged "more beautiful than anything I've ever made with Claude or Codex" ([Lenny's Newsletter](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent)).

**What failed:**

- a bar recommendation for a bar that had closed years ago;
- the invented phone number mentioned earlier ([Yahoo Finance](https://finance.yahoo.com/technology/article/metas-muse-is-an-impressively-capable-ai-agent-despite-some-hiccups-173310662.html));
- weak browser shopping on some retail sites ([Lenny's Newsletter](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent));
- Amazon, which blocked it outright as "an unauthorized AI agent" ([Fortune](https://fortune.com/2026/09/22/metas-muse-ai-is-exploding-in-popularity-and-drawing-heated-backlash/)).

Training on Muse conversations is on by default, with an opt-out. Hands-on testers were prompted to connect financial accounts and passport details ([Neoteo](https://www.neoteo.com/en/a-meta-muse-hands-on-review-found-task-help-and-data-prompts)). There is **no EU or UK date**, and Meta has been reported as "stumbling" on European law ([merca2.es](https://www.merca2.es/2026/10/07/meta-muse-europa-leyes-2468346/)).

So Muse is useful on a US phone today for outbound errands with structure and approvals. It is not a phone assistant. Nothing found shows it acting on Android apps, notifications or settings: it works on the web and connected accounts from Meta's cloud.

### What developers can use

The **Meta Model API** opened on 9 July as a US-only paid preview. Muse Spark costs $1.25 per million input tokens and $4.25 per million output tokens, with a 1M-token context ([Trending Topics](https://www.trendingtopics.eu/meta-opens-muse-spark-1-1-to-developers-and-bets-on-aggressive-pricing/)). One secondary source says it accepts Anthropic Messages-format requests, which is unverified ([developersdigest](https://www.developersdigest.tech/blog/meta-muse-spark-1-1-developer-guide-2026)). At maximum reasoning, Artificial Analysis measures a time to first token of about **57 seconds**, unusable for voice ([Artificial Analysis](https://artificialanalysis.ai/models/muse-spark-1-3)). Its intelligence-index figures conflict between 48 and 62 across index versions, so absolute rankings shouldn't be trusted. Glimmer 30B quantised to 4 bits fits a **24–32 GB** memory envelope and runs under MLX, Ollama and llama.cpp. Meta names no phone target for it ([Meta research blog](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)).

### What ARES should take from it

| Muse feature | ARES equivalent today | What to do |
|---|---|---|
| Activity feed showing every tool call as a step-by-step "task lineage" ([Lenny's](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent)) | `audit.jsonl`, job events, the Work panel's LOG tab | Show per-job step lineage in the phone's Work card and the WORK arc's expanded view |
| Keeps working when the app is closed; returns on change or approval | Jobs, routines, pushes | Push only on a state change; the Live Update carries the rest |
| "Ideas" library and guided structure instead of a blank chat | Reactor chips | Seed the chips from real data (today's calendar, running jobs), not generic prompts |
| Sentinel agent gating everything sent to the internet | `redact.js`, control tiers | Consider an independent egress check for anything ARES sends off the Mac |
| One-time cards; a credential store the model can't read | Payments are prohibited | If purchases ever become a tier, use virtual one-time cards only |
| Its own email address; WhatsApp access | Phone, Telegram | An ARES forward-to address as an intake channel |
| Polished one-shot artifacts from personal data | Jobs, the morning card | A morning brief rendered as a card or PDF from calendar, mail and jobs |
| Outbound real-world contact (quotes) | ARES Calls (cloud agent) | Possible later, kept strictly separate from the `calls.js` paths per CLAUDE.md |

The integration verdict is clear.

- **The Muse agent: no.** It has no API, is US-only, and duplicates what ARES does locally with less third-party custody.
- **The Muse Spark API: low priority.** It is at most a cheap model for batch, non-voice work, and only if the owner is US-eligible, which is unconfirmed. If he isn't, the app, WhatsApp Muse and the API are all unavailable to him.
- **Muse Glimmer: worth a small trial** as an offline or no-credit fallback brain on a Mac with 32 GB or more. That repeats the Kokoro fallback voice pattern. The Mac's RAM and Glimmer's real tool-use quality on ARES's tools are both untested.

## Conclusion

Fluidity and usefulness turn out to be the same property at different scales. A spring that inherits the finger's speed, a reactor that shrinks into the bubble instead of vanishing, a card that docks back where it came from, a session that continues on the phone from the Mac: each preserves continuity, so the owner never has to re-find where they are. The assistants that won reviews in 2026, Gemini's condensing pill, Siri's descending orb and Muse's task lineage, all sell continuity rather than intelligence. ARES's advantage is that it owns the whole chain, launcher, link and brain. No other product the owner could install can make one motion run from his thumb to a Mac job and back. The risk is the opposite of barebones. One UI 8 and Liquid Glass both drew backlash for motion that was too fast or too much, so the springs should be tuned softer than the system's, and every glyph should keep paying rent.

The biggest unknowns can only be settled on the owner's own Galaxy:

- whether its panel honours per-View frame-rate requests;
- whether ARES's Live Updates appear in the Now Bar;
- how the M3 spring values feel next to One UI's own motion;
- what the reactor's glows cost on its GPU.

The first two weeks of work should be the motion kit and a JankStats trace on that phone, before any new visuals.
