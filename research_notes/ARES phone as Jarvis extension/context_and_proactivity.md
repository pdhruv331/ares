# Context sensing and proactive assistance on an Android phone (for ARES, Oct 2026)

Scope: what a Samsung Galaxy running the ARES Kotlin launcher can sense, what can run on the phone, how shipping products (Magic Cue, Now Brief, Now Nudge, Android 16 notification summaries) do proactivity, what research says about timing and learned routines, and battery/privacy rules. Research done 2026-10-10 with ~20 searches/fetches; where a fact comes from my prior knowledge rather than a source fetched in this session, it is put under Inferences or Gaps and marked "(unverified this session)".

## 1. Context signals on Android: APIs and costs

### Takeaway
The cheap, event-driven signals (Activity Recognition transitions, geofences with loose responsiveness, connectivity/Bluetooth/charging/screen broadcasts, notifications, calendar) are enough to drive most "leave now / you're home / you're driving" triggers. Continuous GPS and polling are the expensive path and are throttled in the background anyway. Health Connect background reads need an extra permission and sync is not real-time. Samsung's own triggers (Modes and Routines, Buds head gestures) are not exposed to third-party apps.

### Cited Findings
**Activity Recognition Transition API**
- Detects ENTER/EXIT transitions for `IN_VEHICLE`, `ON_BICYCLE`, `RUNNING`, `STILL`, `WALKING`; registered with `ActivityRecognition.getClient(ctx).requestActivityTransitionUpdates(request, pendingIntent)`, results delivered as an Intent to a BroadcastReceiver (`ActivityTransitionResult.extractResult`). Needs Google Play services and the `ACTIVITY_RECOGNITION` permission. Docs say latency "might vary by device" and make no battery claims (page updated 2026-02-26) — [Android Developers: Activity transitions](https://developer.android.com/develop/sensors-and-location/location/transitions)
- Google introduced it (2018, older source) because apps polling activity themselves hurt battery; Life360 had combined geofences + Fused Location + Activity Recognition to detect drive starts and reported "significant improvements in activity detection latency and battery consumption" after switching; Intuit said it reduced battery use for mileage tracking. Partner testimonials, not independent measurements — [Android Developers Blog, 2018](https://android-developers.googleblog.com/2018/03/activity-recognitions-new-transition.html)

**Fused location and geofencing**
- Priorities: `PRIORITY_HIGH_ACCURACY` (GPS+Wi-Fi+cell, "may cause significant battery drain"), `PRIORITY_BALANCED_POWER_ACCURACY` ("very rarely uses GPS", Wi-Fi+cell), `PRIORITY_LOW_POWER` (mostly cell, "city-level"), `PRIORITY_NO_POWER` (passively receives locations other apps computed, essentially no cost). Guidance: use the largest possible `setIntervalMillis()`, and a `setMaxUpdateDelayMillis()` several times larger so updates batch — [Android Developers: Location and battery](https://developer.android.com/develop/sensors-and-location/location/battery)
- Since Android 8.0 background location is throttled to "a few times an hour"; location isn't recomputed while the device stays connected to the same static Wi-Fi AP — same source
- Geofencing: setting `setNotificationResponsiveness()` to "five minutes or larger" preserves power; responsiveness improved from "tens of seconds" to "approximately two minutes" on some devices. No meter-level accuracy or dwell numbers given — same source

**Health Connect (steps, sleep)**
- Background reads need the extra `android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND` permission on top of data-type permissions (`READ_STEPS`, `READ_SLEEP`); availability depends on the installed Health Connect version (check the feature status first); a WorkManager worker does the read — [Android Developers: Read raw data](https://developer.android.com/health-and-fitness/health-connect/read-data)
- On Android 14+, Health Connect captures steps from the device itself once any app holds `READ_STEPS` — same source
- Samsung Health data (Galaxy Watch/Ring/Fit) reaches Health Connect by sync; developers reported inconsistent step sync (Oct 2024 forum thread, may be stale) — [Samsung Developer Forum](https://forum.developer.samsung.com/t/samsung-health-not-writing-steps-to-health-connect/23284?page=3); sync timing varies "hourly, once per day, or during specific system-defined events" per a third-party SDK — [Spike API docs](https://docs.spikeapi.com/sdk-docs/android/background-delivery)

**Samsung-specific signals**
- Modes and Routines (One UI 5.0+): triggers include app opened, location, manual start; Discover tab offers suggested routines/modes (sleep, theater, driving, work) — [Samsung US support](https://www.samsung.com/us/support/answer/ANS00083201/); [Tom's Guide](https://www.tomsguide.com/how-to/5-ways-to-automate-your-samsung-galaxy-phone-and-save-time); [BGR](https://www.bgr.com/2211013/samsung-galaxy-devices-uses-morning-routine/). No source found for a public API that lets a third-party app read the active Samsung mode or register a routine trigger.
- Galaxy Buds4 head gestures (nod/shake to accept/reject calls) require One UI 8.5+ on the phone — [Samsung support: Buds4 head gestures](https://www.samsung.com/za/support/mobile-devices/how-to-use-head-gestures-on-the-samsung-galaxy-buds4-series/). A Samsung developer forum answer says there is no third-party API for Galaxy Buds sensors (undated) — [Samsung Developer Forum](https://forum.developer.samsung.com/t/motion-sensor-api-for-galaxy-buds/15253)

### Inferences
- (unverified this session, standard Android knowledge) Other cheap event signals ARES can use: `ConnectivityManager.NetworkCallback` + `WifiInfo.getSSID()` (needs location permission) for "home Wi-Fi"; `BluetoothDevice.ACTION_ACL_CONNECTED/DISCONNECTED` or `BluetoothProfile`/`AudioDeviceCallback` for car head unit and Buds (ARES already uses `AudioDeviceCallback`); `ACTION_SCREEN_ON/OFF`, `ACTION_USER_PRESENT` (unlock) and `ACTION_POWER_CONNECTED` via a runtime-registered receiver (these are not delivered to manifest receivers since Android 8); `UsageStatsManager.queryEvents()` (needs the special `PACKAGE_USAGE_STATS` grant) for foreground-app history; `TelephonyCallback` for call state (ARES has it). As the default launcher with a NotificationListenerService, ARES gets most of these cheaply because the process is usually alive.
- "Leave now" needs travel time, which requires a routing call. Cheapest pattern: a geofence/last-known location (`PRIORITY_NO_POWER` or balanced) a fixed lead time before a calendar event with a location, then one Directions request on the Mac, not continuous tracking.
- Home detection is best done as a fusion (home Wi-Fi SSID OR home geofence ENTER) to survive either one being flaky; arrival = Wi-Fi connect, which costs nothing.
- Because Samsung's mode and Buds gesture state are closed, ARES should reproduce the few modes it needs itself (it already does: morning/meeting/night/at the Mac) and treat Samsung Routines only as an actuator the user may wire by hand (e.g. a routine that triggers on "ARES app opened" is not useful; a notification-based trigger is not available either).

### Gaps
- No current (2024–2026) measured battery figures (mAh or %/day) for Activity Recognition, geofencing or balanced location; Google's docs give only qualitative guidance.
- Ambient-sound / Now Playing-style detection: no third-party API was found in this session; Pixel's Now Playing is a system feature. A custom always-on audio classifier would need a foreground service with the microphone type and a persistent notification (unverified this session).
- Whether Samsung exposes Modes and Routines state or Good Lock (Routines+) hooks to other apps: not found.

## 2. On-device intelligence (Gemini Nano / AICore / ML Kit GenAI) on Samsung

### Takeaway
ML Kit GenAI (Summarization, Proofreading, Rewriting, Image Description; Prompt API; Speech Recognition) runs Gemini Nano through AICore on Galaxy S25/S26 and recent Folds/Flips, but inference is allowed ONLY when the calling app is the top foreground app, with per-app and daily battery quotas. For ARES that means on-device summarising is possible while the ARES launcher/home screen is in front, not from a background service; anything background goes to the Mac.

### Cited Findings
- APIs: Summarization, Proofreading, Rewriting, Image Description (beta), Prompt API (beta, text or multimodal), Speech Recognition (alpha). Built on AICore; ML Kit downloads Gemini Nano and feature models as needed — [ML Kit GenAI overview](https://developers.google.com/ml-kit/genai)
- Samsung devices supported for the feature APIs: Galaxy S25, S25+, S25 Ultra, S26, S26+, S26 Ultra, Z Flip8, Z Fold8, Z Fold8 Ultra, Z Fold7, Z TriFold — same source
- Prompt API by Nano version: nano-v2 includes Galaxy Z Fold7 and Z TriFold; nano-v3 includes Galaxy S26/S26+/S26 Ultra; nano-v4 includes Z Flip8, Z Fold8, Z Fold8 Ultra. The Galaxy S25 series is NOT on the Prompt API list (feature APIs only) — same source
- Speech Recognition "Basic Mode" works on most devices with API 31+; "Advanced Mode" (GenAI model) only on Pixel 10/11 so far — same source
- Restrictions: "GenAI API inference is permitted only when the app is the top foreground application"; background use, including from a foreground service, returns `ErrorCode.BACKGROUND_USE_BLOCKED`. Per-app inference quota returns `ErrorCode.BUSY` (back off exponentially); a long-duration (e.g. daily) quota returns `ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED`. Different Nano versions can give different output for the same prompt; `getBaseModelName()` reports the version — same source
- Samsung's own on-device layer: the Personal Data Engine (PDE, from Galaxy S25) learns habits on-device for Now Brief and other personal features; data is encrypted with keys in Knox Vault and protected by KEEP (Knox Enhanced Encrypted Protection). Footnotes: needs the Personal Data Intelligence toggle (data deleted when turned off), a Samsung Account, consent for photos/audio/calendar access, and "some features may require a network connection" — [Samsung Newsroom: Your Privacy, Secured](https://news.samsung.com/uk/your-privacy-secured-inside-the-tech-powering-more-secure-personalised-galaxy-ai-experiences); [Samsung Newsroom: Knox Vault](https://news.samsung.com/au/your-privacy-secured-how-knox-vault-protects-you-in-the-era-of-ai)

### Inferences
- ARES's launcher is the foreground app whenever the home screen is showing, so it can call ML Kit Summarization on the home page (e.g. condense a burst of group-chat notifications into the orb's caption) without sending text to the Mac. Work queued while another app is in front must wait for the home screen or go to the Mac.
- For notification *importance* classification, a small rule set plus a tiny on-device classifier (TFLite/LiteRT, not subject to AICore's foreground rule) is the practical background path; the LLM is better kept for summarising and for the Mac-side "what should I tell him" decision. (TFLite/LiteRT background behaviour is general knowledge, unverified this session.)
- Which Galaxy the owner has matters: S25 = summarise/rewrite only; S26 or Fold8 = Prompt API too.

### Gaps
- No published accuracy or latency numbers for ML Kit Summarization on Samsung hardware were found.
- Exact daily quota sizes for AICore are not documented on the overview page.
- No source found for a Samsung-provided on-device notification-importance API for third parties.

## 3. Proactive assistance designs in products and research

### Takeaway
Shipping products converge on the same shape: an on-device personal data store, suggestions surfaced *inside the moment where they're used* (call screen, keyboard, a briefing card) rather than as new interruptions, and a user-visible kill switch. Research (2025–2026 LLM agents) shows sensor context + persona improves proactive prediction, but numbers are self-reported benchmarks.

### Cited Findings
**Products**
- Google Magic Cue (Pixel 10, Tensor G5 + latest Gemini Nano): runs in the background without wake words, surfaces suggestions as an overlay in the current app (e.g. flight time offered when a text asks "when do you land"; flight info on the call screen when calling the airline). User picks source apps (Gmail, Messages, Calendar); uses app usage, "recent screen activity", Google app data. Takes a day or two to learn habits. Reports differ on whether all processing is on-device — [Android Central](https://www.androidcentral.com/apps-software/how-to-use-magic-cue-on-the-pixel-10); [9to5Google](https://9to5google.com/2025/06/12/pixel-10-magic-cue); [DeepLearning.AI summary](https://charonhub.deeplearning.ai/inside-magic-cue-googles-new-ai-assistant-for-pixel-10/)
- Samsung Now Brief (One UI 7, Galaxy S25; S24 via One UI 8): time-of-day summaries from Samsung, select Google and third-party apps (weather, calendar, flights, reminders, playlists, health). One UI 8 betas added parking-spot reminders, smart-home alerts, wearable (Watch/Buds) low-battery alerts, birthday reminders. Card list is from beta reporting — [Android Authority](https://www.androidauthority.com/samsung-now-brief-one-ui-8-3571648)
- Samsung Now Nudge (Galaxy S26, One UI 8.5): proactive suggestions in the Samsung Keyboard toolbar: flags calendar conflicts when a message mentions a meeting, suggests photos to share, autofills form fields from Personal Data Intelligence; can be disabled under Settings > Security and privacy > More privacy settings > Personal data intelligence — [SamMobile, Feb 2026](https://www.sammobile.com/news/galaxy-s26-now-nudge-explained-what-can-this-new-ai-tool-do). A user-posted (not official) note says One UI 8.5 stable began rolling out 6 May 2026 starting with the S25 — [Samsung Community](https://us.community.samsung.com/t5/Questions/Upcoming-AI-Features/m-p/3556985)
- Android Auto: Gemini summarises texts and unread emails and replies by voice (rolling out globally Nov 2025) — [TechCrunch](https://techcrunch.com/2025/11/20/gemini-starts-rolling-out-to-android-auto-globally/); strings for "Proactive Assistance" (reported as Magic Cue's new name) were found in Android Auto 17.8/17.9 beta, not launched as of that report — [tink.de blog](https://www.tink.de/blog/?p=53088); [Auto123](https://www.auto123.com/en/news/android-auto-updated-2026/73903/)
- Microsoft Recall (memory-style precedent): after the 2024 backlash it became opt-in, snapshots encrypted with TPM-protected keys reachable only inside a VBS Enclave gated by Windows Hello, sensitive-content filters on by default, private browsing not captured, can be removed entirely. Security claims are Microsoft's own — [PCWorld](https://www.pcworld.com/article/2470708/microsoft-now-confirms-you-can-opt-out-of-and-remove-windows-recall.html); [CyberInsider](https://cyberinsider.com/microsoft-provides-assurances-on-the-security-of-new-recall-feature/)

**Research**
- ContextAgent (NeurIPS 2025): pulls multi-dimensional context from wearable sensors plus the user's persona history to decide whether a proactive service is needed; reports up to 8.5% higher proactive-prediction accuracy and 6.0% better tool calling vs baselines — [arXiv 2505.14668](https://arxiv.org/html/2505.14668v2)
- ProAgent (Dec 2025): AR glasses + smartphone + edge server; "on-demand tiered perception" (cheap sensors always, expensive ones only when needed) and a proactive reasoner mapping context to needs/tool calls; up to 33.4% higher proactive prediction accuracy and 16.8% higher tool-call F1 — [arXiv 2512.06721](https://arxiv.org/abs/2512.06721)
- Google Research "Toward Sensor-in-the-Loop LLM Agent" (SenSys 2025): wearable sensor hints improved responses to users' needs across five scenarios — [Google Research](https://research.google/pubs/toward-sensor-in-the-loop-llm-agent-benchmarks-and-implications/)
- ProactiveMobile benchmark (Feb 2026) notes current mobile agents are "predominantly confined to a reactive paradigm" — [arXiv 2602.21858](https://arxiv.org/html/2602.21858v3)
- Next-app prediction (older, flagged): context-aware neural models report accuracy@1 around 68% on the LSapp dataset and 46% on Tsinghua (dataset-dependent) — [Aliannejadi et al., arXiv 2101.03394](https://arxiv.org/pdf/2101.03394); Bayesian launcher (time, day, location, last app), 5 of 7 users satisfied, 2013 — [Nihao, EUDL](https://eudl.eu/doi/10.1007/978-3-642-36632-1_17); on-device online learner over time/location/device state, ~1,000 devices, 2016 — [Keshet et al.](https://ar5iv.arxiv.org/html/1512.07851)

**Timing interventions (interruptibility)**
- Yahoo! JAPAN deployment (>680,000 users, 2017, older): deferring notifications to breakpoints cut user response time significantly at the cost of ~4 min average delivery delay — [LY Corp research](https://research.lycorp.co.jp/jp/publications/239)
- Turner, Allen & Whitaker (2017, older): 6-month in-the-wild study of 11,346 notifications; an information-gain model captured up to 125% more interruptibility cases — [Cardiff ORCA](https://orca.cardiff.ac.uk/id/eprint/97910/)
- Deferring until task breakpoints / end of a phone-use episode gives favourable results (Fischer et al., MobileHCI 2011; Bailey, MSR; older) — [Fischer MobileHCI 2011](https://interruptions.net/literature/Fischer-MobileHCI11.pdf); [Microsoft Research](https://www.microsoft.com/en-us/research/?p=183260)

### Inferences
- The pattern ARES should copy: "proactive but in-place". Most of ARES's anticipations should land in an existing surface the owner is already looking at (home screen orb/caption, the meeting ring, the morning card, the Buds when audio is already playing, the call screen) rather than as a new push notification. Only time-critical ones ("leave now") should interrupt.
- ProAgent's tiered perception maps directly onto ARES: phone runs cheap always-on triggers (transitions, Wi-Fi/BT, calendar, notifications); the Mac (Claude) is invoked only on a trigger, with a compact context snapshot, to decide whether and what to say.
- The breakpoint findings suggest batching non-urgent items to natural breakpoints ARES can already detect: unlock (`USER_PRESENT`), arriving home (Wi-Fi), leaving the car (BT disconnect + walking), end of a meeting (calendar end), Buds connected.

### Gaps
- No 2024–2026 IMWUT/CHI interruptibility paper specifically on LLM assistants was found in this session.
- No acceptance-rate data published for Magic Cue, Now Brief or Now Nudge.

## 4. Triggering automations without manual setup (learning and suggesting routines)

### Takeaway
Industry practice (Samsung Discover suggestions, patents on routine assistants, Magic Cue's "learning period") is: mine repeated behaviour, then OFFER the automation once, and only automate after an explicit yes. CHI work finds wrong automatic acts are tolerated when they look reasonable and the system communicates its confidence.

### Cited Findings
- Samsung Modes and Routines' Discover tab offers suggested routines and "Adaptive routines" — [BGR](https://www.bgr.com/2211013/samsung-galaxy-devices-uses-morning-routine/)
- Chiang et al., CHI 2020 (older): in a user-enactment study of smart-home routine assistants, participants' wish for how the system communicates depended on its confidence and their mental models; automated acts from false predictions "were not generally considered improper" if perceived as reasonable or potentially useful — [Chiang et al. 2020 PDF](https://people.cs.nycu.edu.tw/~armuro/pubs/chiang-et-al-2020-chi.pdf)
- Patents describe the same loop: prompt "Would you like me to turn off the lights after everyone goes to bed?", add the rule only on acceptance, re-prompt when mined patterns change — [USPTO 11972327](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11972327); [USPTO 12069144](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12069144); a 2024 disclosure describes an assistant asking whether to perform and automate an action when the context matches past behaviour — [TD Commons 6578](https://www.tdcommons.org/dpubs_series/6578)
- Magic Cue needs "a day or two" to learn habits before suggesting — [Android Central](https://www.androidcentral.com/apps-software/how-to-use-magic-cue-on-the-pixel-10)

### Inferences
- ARES already has the right rule on the Mac (autonomy.js `observe`/`suggestion`: offer a routine once, never create one). Extend it to phone context: log (locally, on the phone or Mac) tuples of {trigger signal, time, place-label, action the owner took within N minutes}, and when a pair repeats (e.g. 3+ times in 2 weeks), have the brain offer "want me to do this automatically?". Show confidence ("you've done this 4 of the last 5 weekdays").
- Distinguish "notify" automations (safe to suggest freely) from "act" automations (silencing, messaging) which keep ARES's tier rules.

### Gaps
- No quantitative acceptance-rate study of mined routine suggestions (Samsung, Google Home, Apple Shortcuts) found. Google Home automation suggestions and Apple Shortcuts/Siri Suggestions were not researched in this session.

## 5. Notification triage and summarisation

### Takeaway
Android 16 QPR2 (Dec 2025, Pixel only) shipped an on-device Notification Organizer (silently groups Promotions/News by default, Social/Suggested opt-in) and Gemini Nano summaries with tight scope limits (25–200 words, 50/day). Apple's 2025 news-summary errors show the trust risk: summaries of news must be marked, and per-app opt-outs are essential. Rule-based cooldown (Android 15/16) is a cheap complement.

### Cited Findings
- Android 16 QPR2 stable (Dec 2025 Pixel update): Notification Organizer automatically groups and silences lower-priority notifications (Promotions and News on by default; Social and Suggested opt-in) using on-device AI; AI summaries condense long messages and group chats; only notifications of 25–200 words, max 50 summaries/day; per-app off at Settings > Notifications > Notification summaries > Manage apps; English, limited regions — [Android Authority](https://www.androidauthority.com/android-notification-summaries-leak-3574675); [Droid Life](https://www.dev.droid-life.com/2025/12/02/google-added-9-sweet-new-features-to-your-pixel-in-big-update); [Tech Advisor](https://www.techadvisor.com/article/3006632/google-pixel-phones-get-notification-organiser-in-android-16.html). Device scope reported as Pixel 9/10 with Gemini Nano (sources differ on Pixel 9a)
- Notification cooldown (Android 15/16): when an app sends many notifications quickly, alerts are toned down for up to two minutes; never silences high-priority alerts, calls or alarms; rule-based — [Android Authority](https://androidauthority.com/android-16-notification-cooldown-3501276); [9to5Google](https://9to5google.com/2024/11/19/notification-cooldown-android-16-dp1/)
- Apple Intelligence summaries misreported BBC alerts (e.g. a false claim a suspect had shot himself) and other outlets; Apple paused News & Entertainment summaries in iOS 18.3 betas (Jan 2025), added italics to mark summaries, a warning that they may contain errors, and per-app disabling from the Lock Screen; Reporters Without Borders asked for removal — [The Decoder](https://the-decoder.com/apple-pauses-ai-generated-news-summaries-after-serious-accuracy-issues-surface/); [MobileSyrup](https://mobilesyrup.com/2025/01/16/apple-temporarily-walks-back-notification-summaries/); [Silicon Republic](https://www.siliconrepublic.com/business/apple-halt-ai-notification-summaries-backlash-features)

### Inferences
- ARES should copy Google's scoping: summarise only conversational notifications above a length/size threshold, never summarise news headlines (show the original), and visually mark every summary as ARES's paraphrase with one tap to the original (ARES's NotifStore already keeps originals).
- Triage pipeline: (1) rules first (calls, OTP/2FA, alarms, known VIPs, calendar alerts pass straight through; promotions/news batch); (2) cooldown-style rate limit per app; (3) LLM only for the ambiguous middle, on the phone when the home screen is foreground, otherwise on the Mac with redacted text (ARES already has `redact.js` on the Mac side).
- Digest timing: batch the non-urgent bucket to breakpoints (see section 3) and to the existing modes (morning card, end of meeting, arriving home).

### Gaps
- No published accuracy evaluation of Android 16 summaries or Samsung Galaxy AI notification summaries found.
- Whether Samsung ships the Android 16 Notification Organizer / summaries in One UI 8.x was not confirmed.

## 6. Wearables, audio and driving as channels for proactive "whispers"

### Takeaway
Earbuds are the lowest-friction channel for a short spoken nudge, but Samsung's Buds features (head gestures, Bixby voice-free control) are closed; ARES can only use the standard audio route (detect Buds via audio-device callbacks, play TTS over media/communication audio) and its own voice/tap input. Android Auto is the sanctioned driving surface; Gemini already summarises messages there, and proactive cards are only in test builds.

### Cited Findings
- Buds4 head gestures accept/reject calls by nodding/shaking, need One UI 8.5+; Bixby can be used without speaking — [Samsung support](https://www.samsung.com/za/support/mobile-devices/how-to-use-head-gestures-on-the-samsung-galaxy-buds4-series/)
- No third-party API for Galaxy Buds sensors per a Samsung developer forum answer (undated) — [Samsung Developer Forum](https://forum.developer.samsung.com/t/motion-sensor-api-for-galaxy-buds/15253)
- Now Brief One UI 8 betas added wearable low-battery alerts for Watch/Buds (beta reporting) — [Android Authority](https://www.androidauthority.com/samsung-now-brief-one-ui-8-3571648)
- Gemini on Android Auto: message and email summaries, voice replies, global rollout from Nov 2025 — [TechCrunch](https://techcrunch.com/2025/11/20/gemini-starts-rolling-out-to-android-auto-globally/); "Proactive Assistance" seen only in Android Auto 17.8/17.9 beta strings — [tink.de](https://www.tink.de/blog/?p=53088)

### Inferences
- Whisper rules for ARES: speak into the Buds only when they are connected AND (no call active) AND (media is playing or the owner is walking/driving), keep it to one sentence with an earcon first, and duck media (audio focus `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`, general knowledge, unverified this session). Never speak while in a calendar meeting or when the screen is on in another app.
- For driving, detect via Activity Recognition `IN_VEHICLE` ENTER or the car's Bluetooth connection, and route ARES messages through Android Auto's messaging-notification path (MessagingStyle + reply/mark-read actions) rather than custom audio, so they are allowed while driving (unverified this session).
- A Galaxy Watch later: Wear OS notifications with actions bridged from the phone are the cheapest path; a watch tile/complication for "next thing" fits the Now Brief pattern.

### Gaps
- Galaxy Buds "conversation mode"/voice-detect behaviour and its interaction with third-party TTS was not researched; no source for whether Buds' "read notifications aloud" (Galaxy Wearable) can be fed by a third-party app.
- Android Auto app-category rules for an assistant app were not checked.

## 7. Battery and privacy guidelines; what stays on the phone vs the home server

### Takeaway
Use event-driven, OS-batched signals and hand decisions to the Mac only on triggers; keep raw context (locations, notification text, app usage) on the phone or encrypted at rest, send compact labelled events ("arrived home", "meeting ends in 5") to the Mac, and give the owner a visible, single kill switch, as Samsung (Personal Data Intelligence toggle), Google (per-app source selection) and Microsoft (opt-in, enclave, filters) all do.

### Cited Findings
- Location: prefer balanced/low power, largest intervals, batching via max delay; background location is throttled to a few times an hour anyway; geofence responsiveness ≥5 min — [Android Developers: Location and battery](https://developer.android.com/develop/sensors-and-location/location/battery)
- Polling activity yourself drains battery; the Transition API exists to centralise it — [Android Developers Blog, 2018](https://android-developers.googleblog.com/2018/03/activity-recognitions-new-transition.html)
- On-device GenAI has per-app and daily battery quotas and is foreground-only — [ML Kit GenAI overview](https://developers.google.com/ml-kit/genai)
- Samsung's PDE: on-device learning, encrypted with Knox Vault keys, deleted when Personal Data Intelligence is turned off — [Samsung Newsroom](https://news.samsung.com/uk/your-privacy-secured-inside-the-tech-powering-more-secure-personalised-galaxy-ai-experiences)
- Recall precedent: opt-in by default, encrypted store, biometric-gated access, sensitive-content filters, pause/delete — [PCWorld](https://www.pcworld.com/article/2470708/microsoft-now-confirms-you-can-opt-out-of-and-remove-windows-recall.html); [CyberInsider](https://cyberinsider.com/microsoft-provides-assurances-on-the-security-of-new-recall-feature/)
- Proactive-agent research splits work into cheap always-on perception and expensive on-demand perception/reasoning on an edge server — [ProAgent arXiv 2512.06721](https://arxiv.org/abs/2512.06721)

### Inferences
- Phone keeps: raw location fixes, Wi-Fi/BT device names, full notification text, usage events, health samples. It derives labels (place = home/work/other; state = driving/walking/still; in-meeting; Buds on; screen/unlock) and sends only label changes plus the minimum needed text to the Mac over the paired channel. The Mac keeps: the learned-routine table, the decision of what to say, and the history used for suggestions (fits ARES's existing audit log and redaction).
- Battery budget heuristic for ARES: zero continuous GPS; Transition API + 2–3 geofences (home, work, gym) with 5-min responsiveness; Wi-Fi/BT/screen/charging receivers; one WorkManager job per 15+ min for Health Connect; ML Kit only while home is foreground. Measure on the real Galaxy with `adb shell dumpsys batterystats` (general knowledge, unverified this session), since the emulator is unrepresentative (already noted in CLAUDE.md for the reactor).
- Samsung's battery management (Sleeping/Deep sleeping apps) can kill background components; being the default launcher plus a NotificationListenerService helps, but ARES should be added to "Never sleeping apps" (unverified this session).

### Gaps
- No 2024–2026 measured %-per-day battery costs for any of these APIs on Galaxy hardware were found; ARES will need its own measurement.
- Android 15/16 changes to background starts and foreground-service types that affect an assistant were not checked in this session.
