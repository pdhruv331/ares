# AI-native phone UI (2025 to Oct 2026): how assistants look, move and flow, and what that means for ARES's Android launcher

Scope note: researched 2026-10-10. "Evidence" = reported by a named source; "Opinion" = a reviewer's judgement; "Inference" = mine. Material from before mid-2025 is flagged HISTORICAL. Recommendations for ARES sit under each section's Inferences.

## 1. How leading assistants present themselves (idle / listening / thinking / speaking, captions, interruption)

### Takeaway
In 2026 the big three moved away from full-screen takeovers and screen-edge glows. Assistants are now a small floating object (Gemini Live's floating pill that shrinks into a circle, Siri's Liquid Glass orb that drops from the Dynamic Island) or they live inside the conversation (ChatGPT voice in-chat with a live transcript). State shows through one central animated element (waveform or orb) plus a slow colour or gradient "heartbeat" while thinking. Real-time interruption (full duplex) is the quality bar reviewers measure against, and turn-based voice (Siri, Claude) gets marked down for it.

### Cited Findings
**Gemini (Android)**
- Feb 28 2026: Gemini Live began rolling out a floating pill on Android, replacing the full-screen experience it had used since launch — [9to5Google](https://9to5google.com/2026/02/28/gemini-live-floating-redesign/)
- April 2026 redesign (Google app beta 17.3): Live is a "floating interface" with the waveform in the centre, flanked by screen-share and a keyboard control (which exits Live); captions button top-right; the overlay "will condense into a smaller circle" as you navigate the phone; launching Live inside the Gemini app shows the overlay with the home screen visible underneath, instead of a full-screen page — [9to5Google](https://9to5google.com/2026/04/07/gemini-live-redesign-android/)
- Gemini overlay (text/ask): the pill got slightly narrower with a larger "Ask Gemini" field and an outline mic. A single "+" opens a bottom sheet with a carousel of large rounded squares (Photos, Camera, Files, Drive, Notebooks) above the create/Canvas/Deep research tools and a Personal Intelligence toggle — [9to5Google](https://9to5google.com/2026/04/07/gemini-live-redesign-android/); [Android Headlines](https://www.androidheadlines.com/2026/05/google-gemini-new-ui-rollout-overlay-gradients-pulsing.html)
- May 2026 full-screen look: the static backdrop became "a smooth, shifting gradient"; while a prompt is processed the colours pulse with a gentle heartbeat-like rhythm; Incognito keeps the same animation in grey so the mode is identifiable by colour alone; the default font was refreshed for legibility of long summaries — [Android Headlines](https://www.androidheadlines.com/2026/05/google-gemini-new-ui-rollout-overlay-gradients-pulsing.html)
- The overlay's voice-input mode has a waveform-like animation in the centre. Later builds look "gauzy, ethereal" with edges that blur while talking. The sparkle/tiny-dots animation was also spreading to Circle to Search. A summer 2026 tweak made the Live overlay animation "sharper and clearer, especially around the edges, with more visible dots" (some of this from APK teardowns, not confirmed rollouts) — [Android Authority](https://www.androidauthority.com/gemini-live-circle-search-new-animations-3692272/); [Android Authority teardown](https://www.androidauthority.com/gemini-overlay-live-neural-design-apk-teardown-3690991/) (403 when fetched; summary via search)
- Gemini Live already used Android's status-bar chip (the same chip used for calls and screen recording) while a session runs — [Android Central](https://www.androidcentral.com/apps-software/android-16-live-updates-chip-notification-panel-demo)

**Siri (iOS 27, shipped Sept 2026)**
- The iOS 18–26 screen-edge glow is gone (HISTORICAL now). It was replaced by a floating dark orb made of Liquid Glass that smoothly descends from the Dynamic Island to listen and pulses while listening. On iPad it emerges from the bezel "like a drop of liquid" and refracts what's beneath it — [MacStories iOS 27 review](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)
- A multicolour waveform (the only place the old Siri colours survive) reacts in real time to speech. The orb shrinks into a thinking state with a loading indicator, then expands into a dark translucent results overlay. MacStories (Opinion): the fluidity and responsiveness of the animations are "top notch" — [MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)
- Pre-launch leaks (Gurman) described a glow tied to the WWDC26 poster and a dark-only interface with a "Search or Ask" field and a glowing cursor in the expanded Dynamic Island — [9to5Mac](https://9to5mac.com/2026/05/26/ios-27s-new-siri-design-will-look-like-this-per-report/); [9to5Mac](https://9to5mac.com/2026/04/19/apple-has-already-teased-siris-new-design-coming-in-ios-27/)
- Criticisms (Opinion): Engadget calls it "practical but plain", a tidy piece of UI design that felt cramped because swiping down from the top already means Control Center and notifications. BGR likes it living in the Dynamic Island but says the top of the screen is crowded. MacStories: voice is still ask, wait, listen, with no extended back-and-forth or interruption like ChatGPT's — [Engadget](https://www.engadget.com/2215572/apple-ios-27-preview/); [BGR](https://www.bgr.com/2256430/ios-27-review/); [MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)

**ChatGPT**
- Since Nov 25 2025 voice is built into the chat by default (no separate orb screen). It shows a live transcript, and maps, photos and links appear alongside the transcript. Voice starts from the waveform icon at the right of the composer. "Separate mode" in Settings brings back the old full-screen orb. The old orb screen had only mute, end and interrupt, and no transcript — [Thurrott](https://www.thurrott.com/a-i/330108/chatgpts-voice-mode-is-now-built-into-chat-conversations); [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpts-new-voice-integration-feels-like-the-missing-piece-in-ai-chat-ive-tried-it-and-its-almost-perfect); [PhoneArena](https://www.phonearena.com/news/chatgpt-voice-mode-is-accessible-in-chat_id176082)
- TechRadar (Opinion): in-chat voice "feels like the missing piece", "almost perfect" — [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpts-new-voice-integration-feels-like-the-missing-piece-in-ai-chat-ive-tried-it-and-its-almost-perfect)

**Claude mobile**
- Voice mode launched in beta in May 2025 (HISTORICAL baseline). While it speaks it shows its key points on screen, and context carries between voice and text in the same conversation — [TechRadar](https://www.techradar.com/computing/artificial-intelligence/claude-ai-adds-a-genuinely-useful-voice-mode-to-its-mobile-app-that-can-look-inside-your-inbox-and-calendar); [Xataka On](https://www.xatakaon.com/robotics-and-ai/anthropic-adds-a-voice-mode-to-claude-directly-competing-with-chatgpt-and-gemini-in-engaging-conversations)
- 2026 reviews (lower-quality sources): turn-based, so it can't listen while speaking; turn-taking and interruption trail OpenAI's; one site says voice moved to Opus/Sonnet with connected-app actions in July 2026 (unverified against Anthropic) — [Kompozy](https://kompozy.io/reviews/claude-voice-mode); [WWWhatsnew](https://wwwhatsnew.com/2026/08/12/como-usar-modo-voz-claude-tutorial-guia-2026/)

**Meta AI app**
- 2025 launch: full-duplex voice demo (talks without waiting for pauses), a "Ready to Talk" setting so voice is the default, and a visible mic-in-use icon for awareness. A June 2026 iOS update (v277) says "new look" but no details were found — [Business Standard](https://www.business-standard.com/technology/tech-news/meta-ai-app-arrives-on-android-and-ios-to-compete-with-gemini-and-chatgpt-125043000498_1.html); [ODSC](https://opendatascience.com/meta-launches-standalone-meta-ai-app-to-deliver-personalized-voice-assistant-experience/); [Tech Dev Notes](https://techdevnotes.com/apps/ios/meta-ai/1558240027/diff)

**Rabbit R1 / Humane Ai Pin (HISTORICAL lessons, 2024–25)**
- Voice-only lacked precision and privacy and had no visible feedback. Humane's palm projector was an "ergonomic nightmare". R1's familiar touchscreen, scroll wheel and push-to-talk anchored the novelty. One reviewer couldn't stop a song after the R1 hung (no "way out"). Rabbit later shipped a card-based UI after criticism. Humane was discontinued and absorbed by HP — [Medium analysis (opinion)](https://medium.com/@bossaresearch/anatomy-of-a-failure-the-humane-ai-pin-and-the-misfit-future-of-wearable-ai-04feedd82903); [Tom's Guide](https://www.tomsguide.com/ai/humane-ai-pin-ipple-rabbit-ceo-just-uncovered-the-weirdest-problem-with-the-wearable); [Creative Bloq](https://www.creativebloq.com/news/ai-gadget-problems)

### Inferences
- Convergent pattern (all three majors): **one living object** carries state (waveform/orb), **colour reserved for the voice signal** (Siri keeps colour only in the waveform; Gemini pulses its gradient while thinking), and a **dark translucent sheet** for results. Mode identity can be colour-only (Gemini incognito = grey). This matches ARES's reactor plus scheme approach, so ARES is already on-trend. The gap is fluid *state transitions*, not a new idea.
- "Fluid" in 2026 means **continuity of the object**: Siri's orb physically descends from the Island, shrinks to think, expands into the result; Gemini's pill condenses into a circle when you leave. Nothing cuts or fades between states; one shape morphs.
- **ARES recommendations (Inference/opinion):**
  1. Make the reactor the single state object and give each state a *shape* change, not just a colour: listening = coils open + ring reacts to mic RMS (like Siri's live waveform); thinking = core contracts and a slow 1 Hz "heartbeat" pulse of the scheme's hue (Gemini's rhythm); speaking = ring modulated by TTS amplitude; done = settle with a single overshoot spring. Interrupted = an instant collapse (≤100 ms) so barge-in *feels* heard even when the Mac is still cancelling.
  2. When a hold-to-talk starts from another app (bubble), animate the reactor *out of* the bubble's position (the Siri "drop from the Island" move) rather than opening a new screen; when leaving home, condense it back into the bubble (Gemini's "condense into a circle").
  3. Captions: ChatGPT and Claude show a live transcript or key points; Gemini puts captions behind a toggle. Keep ARES's small muted captions as the default but add **key-point lines** (2 to 3 short bullets that persist after speech) rather than a word-for-word subtitle. That is what users scan back to.
  4. Interruption: reviewers penalise ask-wait-listen (Siri, Claude). If full duplex isn't feasible, at least let a *tap on the reactor or the start of a new hold* cut speech instantly with a visible collapse plus a haptic tick.

### Gaps
- No primary-source specs (durations, easing curves, colours) for Gemini's or Siri's animations; descriptions are reviewers'.
- No reliable 2026 design review of Claude mobile voice or of the Meta AI app's June 2026 redesign was found.
- Samsung's own Bixby UI changes in One UI 8.5 were not covered by the sources found (Gemini remains the side-button default on recent Galaxies; I didn't confirm the 2026 state).

## 2. Result presentation: answer cards, rich inline results, agent progress, generative UI, follow-ups

### Takeaway
Answers are becoming **native cards** built from a trusted component catalogue rather than text walls: Siri's App Intents snippets, ChatGPT's inline maps and photos next to the voice transcript, Gemini's "visual layout" and "dynamic view", and Google's A2UI protocol, where agents send declarative JSON and the client renders only components it already has. Long-running agent work is moving to **ambient status indicators** (Android Halo, Live Updates chips, Live Activities) instead of a chat thread you must watch.

### Cited Findings
- Siri iOS 27 results combine text, images and app cards built with App Intents (examples: a Reminders snippet, a photo grid for past locations, an inline Notes card after saving a note). Swipe down on a response to type a follow-up. The UI hides whether a local or cloud model answered — [MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)
- ChatGPT voice: multimedia (maps, photos, links) appears alongside the live transcript, in the same thread as text chat — [Thurrott](https://www.thurrott.com/a-i/330108/chatgpts-voice-mode-is-now-built-into-chat-conversations)
- Gemini generative UI (Nov 2025): "dynamic view" means Gemini designs and codes a fully custom interactive response per prompt. "Visual layout" is a magazine-style view with photos and interactive modules. Users may initially see only one of them; the same work went into AI Mode in Search — [Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/); [Flutter blog](https://flutter.dev/blog/rich-and-dynamic-user-interfaces-with-flutter-and-generative-ui)
- A2UI (Google, Dec 2025): the agent emits streamed JSONL describing a component tree plus a data model. The client keeps a **catalogue of trusted components** and renders only those, ignoring anything else. Components reference each other by ID for progressive rendering. One payload renders in React, Flutter, Angular or SwiftUI clients. Google's framing: "safe like data, but expressive like code" — [SD Times](https://sdtimes.com/ai/google-launches-a2ui-project-to-enable-agents-to-build-contextually-relevant-uis/); [Analytics Vidhya](https://www.analyticsvidhya.com/blog/2025/12/google-a2ui-explained/); [CopilotKit docs](https://docs.copilotkit.ai/strands/generative-ui/a2ui)
- Android Halo (previewed May 19 2026, "later this year"): a status indicator at the **top of the screen, on any screen**, that signals when the agent takes on a task, enters live mode or sends a message, and shows progress "subtly", for Gemini Spark and other supported agents. Visual specifics were not published — [Google blog](https://blog.google/products-and-platforms/platforms/android/android-halo/)
- Gemini Spark (I/O 2026): a 24/7 cloud agent that works in the background while the phone is locked and checks with you before major actions — [The Next Web](https://thenextweb.com/news/google-gemini-spark-agentic-assistant-gmail-io-2026)
- Agent progress elsewhere: GitHub Mobile shows Live Activities/Live Notifications for coding-agent sessions (PR title plus current status), Feb and Jul 2026. Third-party Claude Code monitors show working/waiting on the lock screen and allow answering permission prompts from it — [GitHub changelog](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications); [GitHub changelog](https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions); [AgentsRoom docs](https://agentsroom.dev/docs/live-activities)
- Opinion piece arguing "chat is a terrible interface for agents" (the case for structured status and UI over chat) — [HackerNoon](https://hackernoon.com/chat-is-a-terrible-interface-for-agentsand-2026-will-prove-it)

### Inferences
- The A2UI model (agent sends *data*, client renders *its own native components*) suits ARES exactly: the Mac brain (Claude) can't ship Kotlin views, but it can send `{type:"card", kind:"map"|"file"|"event"|"approval"|"progress"|"list", …}` that the phone renders with ARES-styled native views. Safe (whitelist), themeable by Scheme, and streamable.
- **ARES recommendations:**
  1. Define a small **ARES card catalogue** (≈8 kinds: answer-summary, list, event, place/map, file, image, job-progress, approval) rendered natively in HUD style. The brain chooses a kind; unknown kinds fall back to text. Same JSON on the Mac window and the phone.
  2. **Spoken + glanceable split**: speak the full answer, but the card shows a ≤12-word headline plus 2 to 3 facts (Claude's "key points on screen" pattern). Long text goes into an expandable card, never a subtitle wall.
  3. **Follow-up chips** under a card (2 to 3 verbs: "Open", "Send to Mac", "Remind me"); swipe down on a card to type (Siri's gesture).
  4. **Agent progress = Halo-style ambient strip**, not a screen: one thin segmented arc or line at the top of the reactor page (and a Live Update / ongoing notification with `ProgressStyle` segments outside the launcher) showing WORK jobs. Tapping it expands to the WORK card; needs-input turns it amber and pulses once.

### Gaps
- No primary description of ChatGPT agent's or Gemini agent mode's *mobile* "working" views; I found no source confirming ChatGPT uses Live Updates on Android.
- Halo's visual design is unpublished as of Oct 2026.

## 3. Flow between surfaces: voice → card → app → back; persistent mini-states

### Takeaway
The 2026 consensus is that the assistant **never takes the whole screen by default**. It floats over the current app (Gemini Live overlay, which condenses to a circle while you navigate), lives in the system's persistent strip (Dynamic Island for Siri; Android status-bar chips and Live Updates; Samsung's Now Bar), and long tasks report through ambient indicators (Halo). Context survives because voice and text share one thread (ChatGPT, Claude).

### Cited Findings
- Gemini Live condenses into a smaller circle as you move around the phone. In-app Live is an overlay over the visible home screen, not a separate page — [9to5Google](https://9to5google.com/2026/04/07/gemini-live-redesign-android/)
- Android 16 Live Updates are built on "progress-centric" notifications (a progress bar optionally split into segments). They have a tray notification plus a **status-bar chip**; tapping the chip opens a larger notification separate from the tray. Full support landed in Android 16 QPR1 (the initial Android 16 release only added the style) — [Android Central](https://www.androidcentral.com/apps-software/android-16-live-updates-chip-notification-panel-demo); [Android Authority](https://www.androidauthority.com/android-16-qpr1-live-updates-3573399)
- Siri lives in the Dynamic Island; a swipe down on the Island opens a unified "Search or Ask" field that detects questions and labels them "Ask Siri" — [MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/5/)
- Samsung One UI 8.5 Now Bar (lock-screen strip of live activities) added a torch-on card, missed-call cards and (leaked) audio broadcast and commute activities. Now Brief's YouTube list became an edge-to-edge horizontal carousel of up to 10 items — [Android Authority](https://www.androidauthority.com/samsung-one-ui-8-5-now-bar-now-brief-updates-3624287/); [SamMobile](https://www.sammobile.com/news/one-ui-8-5-new-now-brief-youtube-card/); [Digital Trends](https://www.digitaltrends.com/phones/one-ui-8-5-makes-your-galaxy-now-bar-worth-checking-again/)
- SamMobile (Opinion, Galaxy S26 Ultra): Now Brief went from "borderline useless" to used every day, because activity, workout and screen-time summaries in one place mean fewer apps opened — [SamMobile](https://www.sammobile.com/opinion/now-brief-borderline-useless-something-i-use-every-day/)
- ChatGPT: voice and text in one thread with a transcript, so moving between modes keeps context; Claude keeps context across voice and text — [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpts-new-voice-integration-feels-like-the-missing-piece-in-ai-chat-ive-tried-it-and-its-almost-perfect); [TechRadar Claude](https://www.techradar.com/computing/artificial-intelligence/claude-ai-adds-a-genuinely-useful-voice-mode-to-its-mobile-app-that-can-look-inside-your-inbox-and-calendar)
- Criticism: the top edge is overloaded (Siri versus Control Center versus notifications) — [Engadget](https://www.engadget.com/2215572/apple-ios-27-preview/); [BGR](https://www.bgr.com/2256430/ios-27-review/)

### Inferences
- **ARES recommendations:**
  1. **One continuous conversation object** across surfaces: the bubble, home reactor and in-app sheet all show the same last turn. Opening an app from a card should leave a *return chip* (the bubble shows a small "back to ARES" arc with the card's icon for ~30 s), mirroring how Gemini's circle persists.
  2. **Shared-element transitions**: card → app should zoom from the card's bounds (Android `ActivityOptions.makeScaleUpAnimation` / `makeClipRevealAnimation`); returning to home should reverse it so the card re-docks where it came from. This is the single biggest "extension of the hand" cue.
  3. Use the **system strip** for ARES's ongoing states outside the launcher: a Live Update (`Notification.ProgressStyle`, promoted ongoing) for running Mac jobs and calls, so it gets the status-bar chip. On Samsung, Live Updates/ongoing activities feed the Now Bar (confirm on device). Don't invent a second persistent overlay when the OS strip already exists.
  4. Avoid the Siri crowding problem: don't bind ARES gestures to the top edge (shade). Keep summon on the bottom/thumb zone (hold on reactor, bubble, side key).

### Gaps
- Whether third-party Live Updates appear in Samsung's Now Bar on One UI 8.5 wasn't confirmed by a source.
- No source measured context-loss or task-completion between overlay and full-screen assistant designs.

## 4. Assistant-first home screen and translating sci-fi HUDs into usable UI

### Takeaway
Shipping assistant-first surfaces favour **few, glanceable modules** that summarise (Now Brief, Nothing's Essential Space plus Glyph Matrix), not dense dashboards. The best film-HUD designers say every element must have a function, that complexity is fine only if the gist reads at a glance (pattern-based status, zoom for detail), and that empty dark space is deliberate. That is the guardrail against "gimmicky sci-fi clutter".

### Cited Findings
- Nothing Phone (3) (July 2025, still current reference): the Glyph Matrix is a small round dot-matrix of white LEDs on the back that shows clock, battery, stopwatch, caller-ID previews, a selfie mirror and "Glyph Toys", cycled by a physical Glyph Button. Reviewers call it fun but divisive. Essential Space (AI hub fed by the physical Essential Key: screenshots and voice memos, plus natural-language Essential Search) gets more consistent praise as "genuinely useful". Some praise came from pieces sponsored by Nothing — [Expert Reviews](https://www.expertreviews.co.uk/?p=1505410); [ChannelNews](https://www.channelnews.com.au/review-nothing-phone-3-flashy-and-fun-but-is-it-enough/); [Yanko Design](https://www.yankodesign.com/?p=564162); [Smartprix](https://www.smartprix.com/bytes/nothing-phone-3-review-pros-con/)
- Samsung Now Brief: value came from consolidation (several summaries in one place), and it was redesigned toward edge-to-edge carousels with larger images — [SamMobile](https://www.sammobile.com/opinion/now-brief-borderline-useless-something-i-use-every-day/); [SamMobile](https://www.sammobile.com/news/one-ui-8-5-new-now-brief-youtube-card/)
- Jayse Hansen (Iron Man/Avengers HUDs), in his own words via interview: on the Mark VII HUD he made sure "all the graphics had a purpose"; form and function are inseparable; the goal is balancing too much and too little data, and complexity is fine if what matters reads at a glance; pattern-based displays give overall status without parsing items, with zoom for detail; a pilot he consulted teaches focusing on what you need and filtering the rest; he was asked to leave lots of black space on glass screens; fast motion and elements projecting toward the viewer cause discomfort, so most graphics stayed near the picture plane; designs should look advanced but not implausible, and should age well — [Pushing Pixels interview](https://www.pushing-pixels.org/?p=7447)
- Hansen's research: A-10 pilot consultation, flight simulators, medical imaging; layered reticles that animate in from different depths (fan breakdown, not Hansen) — [HUDs+GUIs](https://www.hudsandguis.com/2013/05/15/the-avengers/); [Creators Project](https://thecreatorsproject.vice.com/blog/meet-the-man-behind-the-fantastical-technology-in-ithe-avengersi-irise-of-the-planet-of-the-apesi-i2012i-and-more-qa)
- Google's Material 3 Expressive research (May 2025): 46 studies with 18,000+ participants. Expressive designs outperformed on playfulness, energy and friendliness, and participants favoured the "outer limits" designs. Motion is built on **springs** — [Dezeen](https://www.dezeen.com/2025/05/28/google-ushers-in-age-of-expressive-interfaces-with-material-design-update/amp/); [Android Authority](https://www.androidauthority.com/google-material-3-expressive-features-changes-availability-supported-devices-3556392/)
- M3 spring tokens (third-party transcription, not Google primary): the expressive spatial spring has damping ≈0.6 (bouncy) and the fast variant stiffness ≈800; standard is ≈0.9 (near critical). The "4× faster element identification" claim is unverified — [pub.dev material_expressive](https://pub.dev/packages/material_expressive)

### Inferences
- **Practical HUD translation rules for ARES (Inference, derived from Hansen and shipping products):**
  1. **Every glyph is live data or a control.** Decorative tick rings and fake readouts are what makes HUDs read as gimmicks; tie each ring segment to something real (battery, job progress, next-event countdown, Mac link health).
  2. **Pattern first, numbers on demand.** The home page shows *shapes* (arc fill, orb count, segment colour); numbers appear only on press-and-hold or zoom (Hansen's zoom-for-detail).
  3. **Black space is a feature.** Keep ≥40% of the reactor page empty; restrict the cyan accent to ≤10% of pixels so state colours (amber = needs you, red = urgent) pop.
  4. **Keep motion near the picture plane:** no fast parallax or depth "fly-ins" on a handheld; idle animation slow (≤0.3 Hz) and low-amplitude, with energetic motion reserved for state changes.
  5. **Springs, not tweens:** use `SpringAnimation` (androidx.dynamicanimation) for card docks, orb moves and the bubble. Something like damping 0.6–0.75 for "expressive" moments (reactor responding to touch) and ~0.9 for layout moves. This is the cheapest route to "fluid".
- **Home screen layout (Inference):** page 0 = reactor plus *one* contextual line (Now Brief-style: the single most relevant thing for the current mode) plus notification orbs; page 1 = the board. Resist adding more readouts to page 0; Essential Space and Now Brief succeed by consolidating into one summary, not many tiles.
- Readability on dark HUD: thin cyan line art on black fails at small sizes. Use body text in near-white (not cyan), cyan for accents and large numerals only, minimum ~14 sp for captions, and avoid glow blur on text (glow belongs on shapes).

### Gaps
- No current (2025–26) Dribbble/Behance HUD-launcher concepts were reviewed in depth this round (search budget); no sources found on Territory Studio's guidance for real-product HUDs.
- No empirical study found on HUD-style versus conventional home-screen usability.

## 5. Sound and haptics as part of the assistant UI

### Takeaway
Android's official haptic language is "clear" (crisp, discrete, like a mechanical click) by default, "rich" (textured, sequenced primitives) when clear feels monotone, and never "buzzy". There are concrete composition numbers (≥50 ms gaps, ≥1.4× intensity steps) and a three-tier device fallback. Nothing's Glyph Matrix shows light as a secondary output channel. I found no 2026 primary source on Gemini or Siri earcon design.

### Cited Findings
- Android haptics principles: **clear** haptics are crisp, clean and tied to discrete events, imitating a real mechanical action; prefer `HapticFeedbackConstants` (action-oriented, with system fallbacks). **Rich** haptics need wide-band actuators or sequenced primitives (flutter, texture under a swiping finger, wobble, heaviness). Avoid **buzzy** vibration. Sliding textures should be crisp and subtle — [Android Developers: Haptics principles](https://developer.android.com/develop/ui/views/haptics/haptics-principles)
- Composition: plan for three tiers (primitives supported / amplitude control only / on-off only); keep ≥50 ms gaps between primitives so they feel separate; use intensity ratios ≥1.4 so a change is noticeable; Android does not provide fallbacks for compositions with unsupported primitives — [Android Developers: Custom haptic effects](https://developer.android.com/develop/ui/views/haptics/custom-haptic-effects)
- Nothing Glyph Matrix: an LED dot-matrix showing caller ID, timers and battery, with a physical button, so state is shown without the screen — [Expert Reviews](https://www.expertreviews.co.uk/?p=1505410); [ChannelNews](https://www.channelnews.com.au/review-nothing-phone-3-flashy-and-fun-but-is-it-enough/)
- Meta AI: a visible mic-in-use icon "for full awareness" of when voice is active (a feedback and privacy cue) — [ODSC](https://opendatascience.com/meta-launches-standalone-meta-ai-app-to-deliver-personalized-voice-assistant-experience/)

### Inferences
- **ARES haptic vocabulary (proposal):** listening start = `PRIMITIVE_CLICK` (clear); hold-to-talk progress = `LOW_TICK` every eighth (ARES's HoldDetector already does this, which is good); commit = `THUD` or `HEAVY_CLICK`; thinking = nothing (silence is fine); answer arrives = one soft `TICK`; needs approval = two ticks 80 ms apart (≥50 ms rule); error = `PRIMITIVE_SPIN` or a low double; card dock = `TICK` at the spring's settle point. Check `Vibrator.arePrimitivesSupported()` and fall back to `HapticFeedbackConstants` on older Galaxies.
- **Earcons:** pair each haptic with a ≤150 ms earcon from the existing WAV set, only in front and at low volume (already ARES policy). Sound plus haptic plus the reactor shape change should start *within the same frame* to feel like one event.
- Glyph-style idea for Galaxy: Samsung has no rear matrix, but the **Always-On Display / Now Bar** is the equivalent ambient channel. A tiny reactor state on AOD (if feasible via a Live Update) would be ARES's "Glyph".

### Gaps
- No primary sources on 2026 Gemini or Siri earcon or haptic design; no Samsung One UI haptics design guide found (Galaxy actuator capabilities vary; test on device).

## 6. Accessibility and one-handed use

### Takeaway
The products moving the assistant into a small floating object near content (Gemini Live's circle) and avoiding top-edge collisions point to thumb-zone summoning. Colour-only state cues (Gemini incognito, ARES schemes) need redundant shape or text cues. Sources found this round were thin; the rules below come mostly from platform standards.

### Cited Findings
- Engadget criticises top-of-screen crowding for the new Siri (one-handed reach and gesture conflict) — [Engadget](https://www.engadget.com/2215572/apple-ios-27-preview/)
- Gemini signals incognito by colour palette alone (grey versus gradient) — [Android Headlines](https://www.androidheadlines.com/2026/05/google-gemini-new-ui-rollout-overlay-gradients-pulsing.html)
- Android Headlines (and the fetch's own observation) note that the article doesn't address reduced-motion options for the pulsing animations — [Android Headlines](https://www.androidheadlines.com/2026/05/google-gemini-new-ui-rollout-overlay-gradients-pulsing.html)
- Platform standards: Material recommends touch targets of at least 48×48 dp — [Material 3 accessibility](https://m3.material.io/foundations/designing/structure); WCAG 2.2 requires 4.5:1 contrast for normal text and 3:1 for large text and UI components — [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)

### Inferences
- **ARES recommendations:** honour the system "Remove animations" setting (`ValueAnimator.areAnimatorsEnabled()`): drop idle reactor motion to a still and keep state changes as instant shape swaps. Give every state a non-colour cue (shape, icon, or caption word) so schemes and colour-blind users don't lose meaning. Keep summon, cards' primary chips and the WORK strip's expand within the bottom ~60% of the screen. Make the reactor's hold target at least 96 dp (it already is large; keep the hit area even when the visual shrinks). Expose states to TalkBack via `contentDescription` and `announceForAccessibility` ("Listening", "Working on 2 jobs"). Check cyan-on-black text contrast per scheme (most cyans pass 4.5:1 on #000, but desaturated or dim "standby" blues may not).

### Gaps
- No 2025–26 source evaluating one-handed use or accessibility of Gemini Live, Siri iOS 27 or Now Bar specifically; no NN/g article on voice-assistant visual states was retrieved this round.
