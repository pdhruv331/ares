# Turn the phone into ARES's hands

A Jarvis-style assistant earns its place on a phone by finishing a few jobs completely and reliably. Breadth doesn't do it. The 2023–2026 evidence is blunt. People still use phone assistants for the same short, hands-busy commands they used in 2018. Most of them rate on-phone "AI features" as worth little. They drop proactive products that are generic, wrong or slow. The features people do value are in context, one tap and specific: Circle to Search, writing help, call screening, the right confirmation number at the right moment. For ARES this means the Android app should stop being mainly a display and remote for the Mac and become the brain's body. It should be a tiered tool server that reports labelled context (place, motion, Buds, meeting, screen) and carries out phone actions under approvals the phone enforces itself. The Mac, and later an always-on Mac mini, stays the single source of truth for memory, jobs and decisions.

Today the brain on the Mac has essentially one phone tool (`phone/send`), while the phone already holds the assistant role, notification access, a `specialUse` foreground service, FCM and the home screen. So the most valuable next work is plumbing, not more AI. The order is:

1. A reliability floor.
2. Glanceable work and approvals on the lock screen.
3. A structured phone tool server with presence routing and hand-off cards.
4. A context engine that speaks at natural breakpoints and offers automations it has noticed.
5. Accessibility-driven control of other apps.
6. Finally, the Mac-mini host with an encrypted relay.

Safety comes from tiers enforced on the phone, undo in place of confirmation for reversible acts, a stop at every commit point, screen text treated as untrusted, and a STOP that works from the lock screen. The owner's wish never to wire up features is met with in-context chips and one-time offers drawn from repeated behaviour. A settings catalogue would not meet it.

## The useful phone assistant finishes five jobs from start to end

The baseline is sobering. In YouGov's 2025 US survey the top voice-assistant uses were weather (59%), music (51%), quick answers (47%), timers (40%) and hands-free calls (39%). The pattern was described as **"virtually unchanged" since 2018**, despite every vendor's upgrades ([Implicator.ai/YouGov](https://www.implicator.ai/weather-music-timers-americans-still-use-assistants-like-its-2018.md)). A December 2024 SellCell survey found **73% of iPhone and 87% of Galaxy users saw little or no value in their phone's AI features**. The ones they did value were in context: Circle to Search (82.1%), Writing Tools (72%) and notification summaries (54%) ([9to5Mac](https://9to5mac.com/2024/12/16/most-iphone-owners-see-little-to-no-value-in-apple-intelligence-so-far/)). Smart-speaker studies show the same decay. In one, 9 of 15 users felt stuck on basic functions while knowing more existed ([arXiv 2306.05741](https://arxiv.org/pdf/2306.05741)). Older adults abandoned Echo mainly because they could not find valuable uses ([IU ScholarWorks](https://scholarworks.indianapolis.iu.edu/items/10aaf444-3a20-4708-9e07-08064c84b137)).

The failures teach more than the successes, and they share a pattern.

- **Humane AI Pin.** It often gave no answer at all, and a weather question could take about 10 seconds ([Gizmodo](https://gizmodo.com/review-roundup-humane-pin-1851403020)).
- **Rabbit R1.** Integrations acknowledged requests and then didn't carry them out ([Gizmodo](https://gizmodo.com/rabbit-r1-review-ai-companion-performance-1851452097)).
- **Gemini for Home.** It handled multi-part commands correctly only about half the time, and it broke routines that used to work ([Android Authority](https://www.androidauthority.com/gemini-for-google-home-impressions-3633043)).
- **Pixel Daily Hub.** Google pulled it weeks after launch because it rarely showed anything beyond weather and suggested videos ([Android Authority](https://www.androidauthority.com/pixel-10-daily-hub-pause-3595993)).
- **Apple notification summaries.** Apple suspended them for news after one falsely reported that a murder suspect had shot himself ([MobileSyrup](https://mobilesyrup.com/2025/01/16/apple-temporarily-walks-back-notification-summaries/)).
- **Pixel Magic Cue.** It took the opposite rule, "say nothing unless sure", and paid a different price. For months reviewers concluded it didn't work, until it finally surfaced something useful ([Android Authority](https://www.androidauthority.com/two-months-later-pixel-10-magic-cue-delivered-3610389/), [MobileSyrup](https://mobilesyrup.com/2026/01/07/whoa-my-pixels-magic-cue-finally-did-something-useful/)).

The three lessons:

- **Basic, deterministic behaviour is a floor that a "smart" path must never break.**
- **Specific beats generic.**
- **Silence must still be visible somewhere, or the owner assumes the feature is dead.**

Five jobs come out of this evidence as the ones worth doing. Each maps onto something ARES can do better than a phone-only assistant, because a real computer sits behind it.

1. **Fetch one specific personal thing at the moment it's needed.** This is Magic Cue's flagship case, for example the airline confirmation number on the call screen ([Google Blog](https://blog.google/products-and-platforms/devices/pixel/google-pixel-magic-cue-ai-feature/)). For ARES it becomes "send me the deck I edited this afternoon", with the Mac's file system as the source.
2. **Tell me when background work needs me or has finished.** Proactive help right after an error was among the most accepted suggestion types in a CHI 2025 study ([arXiv 2410.04596](https://arxiv.org/html/2410.04596v2)). ChatGPT Pulse turned overnight research into morning cards ([TechCrunch](https://techcrunch.com/2025/09/25/openai-launches-chatgpt-pulse-to-proactively-write-you-morning-briefs)).
3. **Communicate hands-free.** The car has always been the main place for voice: 62% of Siri use in 2016 ([9to5Mac](https://9to5mac.com/2016/06/06/siri-embarrassment-poll/)). Writing help is the most valued AI feature. ARES should draft, read back, and send only on a yes.
4. **Capture now, process later.** Reviewers found this the most useful part of Nothing's Essential Space: press to save the screen or a voice note, and AI turns it into reminders ([Android Authority](https://androidauthority.com/nothing-essential-space-button-3538866)).
5. **Screen and handle calls.** This is among the longest-lived successful assistant features. Google claimed about 37M screened calls a month in the Pixel 6 era ([PhoneArena](https://www.phonearena.com/news/google-call-screen-feature-coming-to-more-markets_id135998)).

A job only counts when all four parts of its loop exist:

- **An acknowledgement in under a second.** Human turn gaps are about 200 ms ([Frontiers](https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00731/pdf)). Voice-agent builders target 600–1,200 ms ([Twig](https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms)).
- **Visible progress.**
- **A result that can be checked**, such as a file, a diff or a screenshot, not just a spoken claim.
- **A next-step chip.**

The Verge preferred the R1 to the Pin for one reason: you can see it working, so the delays feel shorter ([Creative Bloq](https://www.creativebloq.com/news/ai-gadget-problems)).

The owner's "I don't want to think about what it can do" has a name in the research: the **gulf of envisioning**. Users don't know whether the system can do a task, how to ask, or how to judge the result ([arXiv 2309.14459](https://arxiv.org/html/2309.14459v1)). Help menus and skill lists don't close it. Suggestions tied to what is in view do, because they teach a capability while being useful ([Algolia](https://www.algolia.com/de/blog/ux/how-ui-choices-shape-engagement-with-agentic-features)). For ARES that means two or three chips under the reactor that change with the moment:

- a notification in front: "summarise", "reply by voice";
- the Mac's state: "build failed: show error";
- the clipboard: "address copied: navigate".

It also means a next-step offer after every result: "send it to me", "do this every morning". The cheapest teaching moment is right after ARES has just helped.

## One brain, many bodies: the phone acts, the host remembers

The repository shows where ARES stands. The Android app is already the default digital assistant: `AresAssistService` is a `VoiceInteractionService`, and on a summon it sends the screen's text and a screenshot to the Mac. It is also the home screen, a notification listener, a Quick Settings tile, a `specialUse` foreground service and an FCM receiver. The flow, though, runs one way. The phone asks and the Mac answers, and the brain's only phone-directed tool is `phone/send`.

Home Assistant's Companion app shows the mature version of the reverse. The phone publishes sensors, the server sends "notification commands" that the app turns into device actions (launch an intent, set DND, volume, flashlight, TTS), and action buttons report back as events ([HA notification commands](https://companion.home-assistant.io/docs/notifications/notification-commands/)). ARES should turn its notification `api` buttons and outbox into exactly this: a **typed command envelope with an allow-list, tiers and audit**. The brain then calls phone tools the same way it calls `tools/control-tools.js` on the Mac. On-device Android MCP servers exist, one of them about 57 tools wide ([mdskills](https://www.mdskills.ai/mcp-servers/android-remote-control-mcp)). They are young, "as-is" research projects with a large attack surface, though. ARES should borrow the design and keep its own bridge.

Phone actions should go through three layers, cheapest and most reliable first.

**Layer 1: structured paths.** This means intents, deep links, notification reply actions (already built), launcher shortcuts, and the calendar and contacts providers. Android's AppFunctions is the future structured route: Android's "MCP for apps". But the ability to call it is in private preview, limited in practice to Gemini and system agents ([Android Developers](https://developer.android.com/ai/appfunctions)). Google's own Gemini UI automation is still a beta limited to food-delivery and rideshare apps on the Galaxy S26 and Pixel 10 ([Android Developers Blog](https://android-developers.googleblog.com/2026/02/the-intelligent-os-making-ai-agents.html)). ARES should expose its own AppFunctions now, because that is cheap, but not plan on calling other apps' functions until the permission is shown to be grantable on the owner's Galaxy.

**Layer 2: an AccessibilityService inside ARES.** It would copy DroidRun's Portal design: serialise the active window into a compact, numbered element tree, run clicks, typing, scrolls and global actions, and let Claude on the Mac plan over the existing link ([Glama: DroidRun MCP](https://glama.ai/mcp/servers/chukfinley/droidrun-mcp-server)).

**Layer 3: screenshots for a vision model.** These are only for screens whose tree comes back empty.

Benchmarks flatter this stack. Agents now report **over 90% on AndroidWorld**, which is why researchers built the harder MobileWorld ([arXiv 2512.19432](https://arxiv.org/pdf/2512.19432)). The leaderboard numbers are self-reported ([benchmarklist](https://benchmarklist.com/benchmarks/androidworld/)). Samsung apps, logins and pop-ups will do worse, so every action needs a check afterwards and a hand-back to a person.

Phone settings are a special case. Wi-Fi and Bluetooth toggles have been closed to ordinary apps, and since targetSdk 35 DND changes become `AutomaticZenRule`s rather than a global switch ([Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15)). Shizuku gives ADB-shell privileges without root, but it must be restarted after every reboot ([Shizuku manual](https://shizuku.rikka.app/guide/setup/)). So it is an optional power tier, not a foundation.

Context should flow as labels, not raw data. The ProAgent research system splits perception into cheap sensors that are always on and expensive reasoning on an edge server only when needed. It reports up to 33.4% better proactive prediction ([arXiv 2512.06721](https://arxiv.org/abs/2512.06721)). That is ARES's natural shape: the phone senses cheaply and the Mac thinks on a trigger. The cheap signals are:

- Activity Recognition transitions (into or out of a vehicle, walking, still) ([Android Developers](https://developer.android.com/develop/sensors-and-location/location/transitions));
- two or three geofences with responsiveness of five minutes or more;
- home-Wi-Fi and car-Bluetooth connections;
- unlock and screen events;
- calendar, notifications and call state.

Background location is throttled to "a few times an hour" anyway, so continuous GPS buys nothing ([Android Developers: location and battery](https://developer.android.com/develop/sensors-and-location/location/battery)). Samsung's Modes and Routines and the Buds head gestures have no third-party API ([Samsung Developer Forum](https://forum.developer.samsung.com/t/motion-sensor-api-for-galaxy-buds/15253)), so ARES keeps its own modes.

On-device Gemini Nano through ML Kit runs **only while the calling app is the top foreground app**. Calls from a background service return `BACKGROUND_USE_BLOCKED`. The Galaxy S25 has the summarise and rewrite APIs but not the Prompt API ([ML Kit GenAI](https://developers.google.com/ml-kit/genai)). Because ARES is the launcher, it is in front whenever the home screen shows. It can condense notifications there on the phone, and send everything else to the Mac.

| Lives on the phone | Lives on the brain host | Lives on the relay |
|---|---|---|
| Raw location fixes, Wi-Fi and Bluetooth names, full notification text, usage events, health samples | Conversation log, job store, memory, learned-routine table, the "what to say" decision, `audit.jsonl` | Wake requests, heartbeat, an offline queue of encrypted envelopes |
| Derived labels (home, driving, in a meeting, Buds in, screen on) sent as changes | Claude, the tier policy for Mac actions, redaction | Nothing readable: no files, no credentials |
| Tier enforcement and biometrics for phone actions, a per-app blocklist | Presence scoring that picks which device speaks | Push fan-out only |

Hand-off between devices should move pointers, not state. That is how every shipping product does it. Microsoft's Cross-Device Resume is a single-click taskbar alert carrying the phone's activity to the PC ([Microsoft Support](https://support.microsoft.com/en-us/windows/apps/phonelink/cross-device-resume-feature)). Claude Code Remote Control keeps one local session as the truth and makes the phone a steering view ([TechRadar](https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move)). Since August 2026 it also shows each host as a device card on which a session can be started ([pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/12249/claude-code-start-session-from-phone)).

ARES should keep one conversation and job store on the host and show "continue here" cards that carry an ID. Presence decides where output goes:

- Mac unlocked and active: the Mac speaks and the phone stays quiet.
- Phone screen on, or Buds in: the phone.
- Otherwise: a visible push.
- Once one device acknowledges, the other clears its copy.

Clipboard sync from phone to Mac needs an explicit gesture, because Android 10+ blocks background clipboard reads. KDE Connect's answer, a tile plus a notification button, is the one that has worked in practice ([KDE Userbase](https://userbase.kde.org/KDEConnect)). A full remote desktop should be a deep link into Jump Desktop or RustDesk, not something ARES rebuilds. One-window stills via `screencapture -l` cover most "show me" requests.

The future Mac mini changes the phone's job. Today it is the remote of a laptop that is sometimes awake. With the mini it becomes the thin client of a brain that is always on. The mini is cheap to keep running: **Apple lists 4 W at idle** ([Apple Support](https://support.apple.com/103253)), and Jeff Geerling measured 3–4 W ([starryhope](https://www.starryhope.com/minipcs/mini-pc-power-cost-24-7-2026/)). It is also the only host for ARES's macOS-native pieces. FileVault is the catch. macOS Tahoe allows unlocking over SSH before boot on Apple silicon, at first only over Ethernet ([Jeff Geerling](https://www.jeffgeerling.com/blog/2025/you-can-finally-manage-macs-filevault-remotely-tahoe/)), but a reboot after a power cut still waits for a person. The relay's existing stale-heartbeat check should push "the mini restarted and needs an unlock" to the phone.

On transport, two rules matter:

- **FCM high priority only for pushes that show something.** FCM watches seven days of each app instance's behaviour and quietly downgrades apps whose high-priority messages are data-only ([Firebase](https://firebase.google.com/docs/cloud-messaging/android/message-priority)). Progress and presence syncs go at normal priority, or get pulled on `hello`.
- **A Durable Object relay instead of KV.** ARES already hit KV's limit of 1,000 writes a day. A Cloudflare Durable Object with hibernating WebSockets costs no duration while idle and bills 100 inbound messages as 5 requests ([Cloudflare](https://developers.cloudflare.com/durable-objects/platform/pricing)). Its envelopes should be encrypted with keys exchanged at pairing, so a compromised Worker learns nothing.

## Proactivity earns its place only at breakpoints, in place, and rarely

The best controlled evidence comes from the CHI 2025 study of proactive assistants. Proactive variants raised productivity by 12–18% over a plain chat assistant. **90% preferred the version that suggested occasionally, but only 47% preferred the version that suggested more often**, which they called distracting ([arXiv 2410.04596](https://arxiv.org/html/2410.04596v2)). Frequency mattered more than content.

Timing matters as much. In a related study the identical suggestion helped at a natural pause and disrupted mid-task ([arXiv 2502.18658](https://arxiv.org/pdf/2502.18658)). A Yahoo! JAPAN deployment to more than 680,000 users deferred notifications to breakpoints and **significantly cut response time at a cost of about four minutes' delay** ([LY Corp research](https://research.lycorp.co.jp/jp/publications/239)). Interruptibility predictors only reach about 70–80% accuracy ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC11053777)). So when unsure, ARES should wait rather than interrupt, which is Horvitz's old rule: act only when the expected value beats doing nothing ([Horvitz](https://erichorvitz.com/uiact.htm)).

That gives ARES three delivery levels.

**Interrupt** (sound, strong vibration or voice) is only for things that are time-critical or that the owner asked about: leave now, an approval is blocking work, a call, a job that failed on something urgent.

**In place** means landing on a surface the owner is already looking at:

- the home-screen orb caption;
- the meeting ring;
- the call screen;
- one sentence in the Buds while media is already playing.

**Periphery** is the board cards and the morning card, which should hold only the owner's own items and be fine when empty: overnight results, waiting approvals, today's meetings with prep, messages needing a reply. Daily Hub died of generic filler.

ARES's existing modes (morning, meeting soon, night, at the Mac) are exactly the context signals the research says matter. They should set the level of proactivity as well as the visuals. A quiet "what ARES noticed" list on page 2 answers Magic Cue's problem: silence that reads as broken.

Android 16 gives ARES a sanctioned lock-screen surface. Live Updates are for "finite or trackable experiences initiated by the user". They should "alert only for critical status changes", and should not be used for recommendations ([Android Developers: Live updates](https://developer.android.com/design/ui/mobile/guides/home-screen/live-updates)). One UI 8 opened Samsung's Now Bar to third-party apps, and Live Updates feed into it ([Android Authority](https://www.androidauthority.com/samsung-one-ui-8-5-now-bar-now-brief-updates-3624287/)). ARES's projects, jobs, Mac charge or wake and calls fit that definition well. Each would be a `ProgressStyle` notification with named phases (planning, running, tests, verifying, done), alerting only on needs-approval, failed or done. Routines and suggestions don't qualify and belong on cards.

Notification triage should be rules first and the model last. Calls, one-time codes, alarms, known VIPs and calendar alerts pass straight through. Promotions and news are batched to breakpoints. A per-app rate limit copies Android's cooldown. The LLM handles only the ambiguous middle. Google's own Android 16 summaries are tightly scoped: only notifications of 25–200 words, at most 50 a day ([Android Authority](https://www.androidauthority.com/android-notification-summaries-leak-3574675)). Apple's misreported BBC headline shows why ARES should never summarise news, should mark every paraphrase as its own, and should quote names, numbers and times exactly, with the original one tap away ([Silicon Republic](https://www.siliconrepublic.com/business/apple-halt-ai-notification-summaries-backlash-features)).

Voice needs its own etiquette. People hold back from speaking private information aloud, especially in public ([Springer](https://www.springerprofessional.de/doi/10.1007/978-3-319-07863-2_32)). Push-to-talk stays the phone default. Hands-free listening belongs to the Buds and the home. Sensitive replies go to captions unless Buds are in. Every spoken answer also leaves a caption and a card. A whisper in the Buds should be one sentence after an earcon. It should only happen with no call active, never during a calendar meeting, and with the media ducked.

The "never wire it up" goal is reached by noticing, not configuring. ARES should log what triggered something and what the owner did shortly after. When a pairing repeats (say, three times in two weeks), the brain offers the automation once, with its evidence: "you've done this 4 of the last 5 weekdays". This extends `autonomy.js`'s existing offer-once rule to the phone. Smart-home research found that wrong automatic acts were tolerated when they looked reasonable and the system communicated its confidence ([Chiang et al., CHI 2020](https://people.cs.nycu.edu.tw/~armuro/pubs/chiang-et-al-2020-chi.pdf)). Offers that only notify can be made freely. Offers that act (silencing the phone, sending a message) keep their tier.

## Safe autonomy means the phone enforces its own tiers

The risk is concrete. Accessibility is how banking malware works. Google Play forbids any accessibility use that lets an app "autonomously initiate, plan, and execute actions" ([Play Console Help](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)). Being sideloaded, ARES isn't bound by Play policy, but the threat model still applies: a compromised Mac or relay, or text on screen planted to inject instructions, could drive the phone. Injection is not a solved problem. Anthropic's own browser agent launched with injection success cut from 23.6% to 11.2%, not to zero ([Anthropic](https://www.anthropic.com/news/claude-for-chrome)).

So the tiers must be enforced on the phone, not only on the Mac:

- **Tier 1** reads: tree, screenshot, notifications, context.
- **Tier 2** acts reversibly and is logged: open an app, change volume, add a calendar entry.
- **Tier 3** needs a `BiometricPrompt` on the phone: send, pay, delete, permission dialogs, anything that lowers security.

On top of that, a package blocklist ARES will never drive: banking, password managers, Samsung Pass and Wallet, security settings, the accessibility settings themselves. All screen text goes into Claude's prompt marked as untrusted data.

How approvals look matters as much as whether they exist. Gemini's S26 automation fills an Uber Eats cart, stops before checkout, and hands control back with a notification and a strong vibration ([9to5Google](https://9to5google.com/2026/03/12/gemini-android-app-automation-galaxy-s26-rollout/)). Microsoft's Magentic-UI users valued editing the plan before execution, and asked for a third choice at approval points beyond yes and no ([Microsoft Research](https://www.microsoft.com/en-us/research/blog/magentic-ui-an-experimental-human-centered-web-agent)). UX research on confirmations warns that people asked "are you sure?" for everything stop reading ([UX Planet](https://uxplanet.org/confirmation-dialogs-how-to-design-dialogues-without-irritation-7b4cf2599956)).

ARES's phone should therefore:

- act at once on reversible tier-2 steps, with a ten-second Undo;
- show multi-step plans as editable steps in the Work card;
- send tier-3 requests as a plain-language, one-line notification ("Send 'Running 10 min late' to Mom on WhatsApp") with Approve, Deny and Open, which fits Android's three-action limit ([HA actionable notifications](https://companion.home-assistant.io/docs/notifications/actionable-notifications/)).

After repeated approvals, a time-limited grant ("this kind of action, this contact, 24 hours") cuts fatigue. Money, credentials and deletion always stay one-time. While ARES drives another app, a visible overlay shows what it is doing and offers STOP and Take over. Back and Home must always work, given Gemini's test run that froze the phone until a forced reboot. STOP ALL should work from the lock screen without authentication, because stopping is always safe.

Platform constraints set the setup steps:

- **Restricted settings.** The owner must turn on "Allow restricted settings" once before a sideloaded app can get accessibility or notification access ([Android Authority](https://www.androidauthority.com/android-15-restricted-settings-sideloading-3481098/)).
- **Advanced Protection.** On Android 17 it **revokes accessibility from every non-disability app**, so it must stay off on this phone ([Android Authority](https://www.androidauthority.com/android-advanced-protection-mode-accessibility-apk-teardown-3640742/)).
- **Developer verification.** Google's verification regime reaches all regions in 2027 but **exempts ADB installs** ([Android Authority](https://www.androidauthority.com/how-to-bypass-android-developer-verification-sideloading-rules-3718002/)). ARES updates should keep going out over wireless ADB from the Mac.
- **The assistant role.** One developer reports it is cleared on every `adb install -r` ([GitHub issue 41696](https://github.com/anthropics/claude-code/issues/41696)). ARES should check whether it holds the role at launch and show a one-tap fix chip if not.
- **Background survival.** Samsung still scores **5, the worst, on dontkillmyapp**, with no fix on the developer's side beyond user exemptions and a correctly typed foreground service ([dontkillmyapp](https://dontkillmyapp.com/samsung)). ARES's `specialUse` service is the right type, since Android 15 caps `dataSync` at six hours a day ([Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15)). The "Never sleeping apps" exemption needs re-checking after each One UI update.

## Build order: six stages, each one a finished loop

Each stage ships a loop the owner can feel, and each depends on the one before. The order follows the evidence: reliability first, then the surfaces where people actually look, then real control.

| Stage | What to build | Why this comes here |
|---|---|---|
| 0. Reliability floor | Self-checks for battery exemption, assistant role and notification access, with one-tap fixes. High-priority FCM only for visible pushes. Every request visibly moves through heard → working → done or failed. A watchdog that reconnects the link. | The failed gadgets broke on latency and silent non-execution. Samsung kills background apps. FCM downgrades data-only senders. |
| 1. Work on the lock screen | Live Updates and Now Bar for jobs, projects, Mac wake and calls. Tier-3 approvals as biometric notifications. A "what ARES did today" card from `audit.jsonl` with Undo. STOP ALL from the lock screen. | The Work view and approvals already exist; this puts them on the surface Samsung promotes, with no new intelligence needed. |
| 2. Phone tool server v1 | A typed command envelope with phone-side tiers, blocklist and audit. Structured tools: open app or intent, reply to a notification, DND rule, volume, calendar and contacts, speak, show card, share file. Context labels sent to the Mac. Presence routing. "Continue here" cards. A clipboard tile. | Turns the phone from a client into the brain's body using only reliable, deterministic paths. |
| 3. Context and proactivity | Activity transitions, geofences, Wi-Fi and car Bluetooth. Delivery at breakpoints. Mode-gated proactivity levels. In-context chips under the reactor. A remappable capture gesture (side-key double press, or a reactor hold) that saves screen plus voice note. An owner-only morning card. Automation offers from repeated behaviour. | Proactivity needs both the context feed and the trust built in stages 1–2. |
| 4. Driving other apps | An ARES AccessibilityService (numbered tree, actions, check after each act). Screenshot fallback. The "ARES is driving" overlay with STOP and Take over. Time-limited grants. Optionally `ROLE_CALL_SCREENING` for unknown callers. | The most powerful and riskiest layer, built only once tiers, audit and undo are proven. |
| 5. Always-on host | Mac mini as primary brain, MacBook as a node that adds its abilities when awake. Durable Object relay with encryption keyed at pairing. FileVault unlock flow, auto-restart after power loss, a smart plug. Device cards on the phone. Optional Shizuku tier. | Removes "the Mac is asleep" as the main failure. Everything above already speaks the right protocol. |

Several tempting projects should be deliberately left alone. Taking the dialer or SMS role from Samsung's apps carries high friction and risk for a personal build; call screening is the light role. ARES shouldn't render model-generated HTML, which can take "a minute or more" ([Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)). The better approach is Google's A2UI: the brain returns specs from a fixed component catalogue and the phone draws them natively ([Google Developers Blog](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/)). For ARES that catalogue is headers, fact rows, phases, chips and an amber confirm block. A feature catalogue, deep Samsung Routines integration and Buds gesture hooks are all out too: catalogues don't get used, and Samsung offers no API for the other two.

Several questions can only be settled on the owner's own Galaxy:

- whether ARES's Live Updates actually appear in the Now Bar;
- whether One UI 8 adds restrictions on overlay or usage access for sideloaded apps;
- whether Samsung's Auto Blocker interferes with wireless debugging;
- whether accessibility can see into Secure Folder;
- which model it is, since an S25 lacks the Prompt API;
- what each context signal costs in battery, for which no 2024–2026 measurements exist;
- end-to-end latency of the tree → plan → act loop over the link, which nobody has published.

## Conclusion

The research shifts what "Jarvis on the phone" means for ARES. The phone is not a second, smaller brain. It is the brain's senses, hands and approval desk, and its value grows with how much the host can safely do through it. The hard part is not intelligence: Claude on the Mac already plans well. The hard part is that Samsung kills background apps, FCM penalises silent pushes, Android keeps closing settings APIs, and approvals become rubber stamps when overused. That makes the reliability floor and phone-side enforcement the critical path, ahead of any new AI feature.

The owner's wish never to wire anything up looks like a request for more autonomy. It is better read as a request for better timing and better offers. The systems that won trust did fewer things, at the right moment, in the place the user was already looking, and asked once before making a habit permanent. The Mac mini makes that achievable, because a brain that is always reachable can afford to wait for the breakpoint.
