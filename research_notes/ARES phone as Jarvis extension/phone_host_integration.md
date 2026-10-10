# Phone + Home-Brain Integration: Continuity, Remote Control, Sync, Delegation and Architecture (for ARES)

Scope note: research done 2026-10-10 with about 16 search/fetch calls. Most findings come from vendor docs (Apple, Microsoft, Samsung, Firebase, Cloudflare, Home Assistant) and well-known practitioners (Jeff Geerling, ServeTheHome). Several are from third-party guides and are flagged. Items with no source are listed under Gaps, not presented as fact.

## 1. Continuity features worth copying (Apple, Microsoft, Samsung, KDE Connect, Google, Pushbullet/Join)

### Takeaway
Every ecosystem ships the same core set: shared clipboard, file/link send, notification mirroring with replies, "resume this activity on the other device" (an alert, not a full state transfer), and remote phone or PC screens. These features do not depend on platform lock-in. The parts ARES lacks, mainly clipboard, resume alerts and a phone-to-Mac remote screen, can be built on its existing paired channel. I found no survey data on which features users value most.

### Cited Findings
- **Apple iPhone Mirroring:** needs macOS Sequoia 15+ on Apple silicon or a T2 Mac, and iOS 18+ with a passcode. Both devices use the same Apple Account with 2FA. Works with one Mac and one iPhone at a time, and is not available in the EU. — [Apple Support 120421](https://support.apple.com/120421)
- **Apple Handoff / Universal Clipboard:** needs Wi-Fi and Bluetooth on, the same iCloud account, Bluetooth range, and Handoff enabled. Nothing else to set up: copy on one device, paste on the other. Macworld says many users don't know Universal Clipboard exists (anecdotal). — [Macworld](https://www.macworld.com/article/834342/how-to-control-universal-clipboard.html)
- **Microsoft Cross-Device Resume** (shown at Build 2025; Insider test August 2025 with Spotify only): a single-click "resume" alert on the Windows taskbar carries the phone's app activity to the PC. It runs through Phone Link plus an Android system app called "Cross Device Services". Needs Android 10+ and Link to Windows. As of January 2026 it supports Spotify, WhatsApp and vivo Browser, and it is on by default. — [Microsoft Support](https://support.microsoft.com/en-us/windows/apps/phonelink/cross-device-resume-feature); [BetaNews, Aug 2025](https://betanews.com/2025/08/23/microsoft-adds-ability-to-resume-apps-from-android-phone-on-windows-11/); [Notebookcheck](https://www.notebookcheck.net/Microsoft-rolling-out-Spotify-cross-resume-between-Android-and-Windows-11-for-Insiders-more-apps-to-follow.1096079.0.html)
- **Samsung "Continue apps on other devices":** Galaxy-to-Galaxy only, in Samsung Internet and Samsung Notes (One UI 3.1+). Needs the same Samsung account, the same Wi-Fi and Bluetooth on. You resume from Recents on the other device. Phone Link / Link to Windows shows the phone's three most recent websites on the PC. — [Samsung US Support](https://www.samsung.com/us/support/answer/ANS00088542)
- **Samsung connected experience:** "Recent Apps / Recent Websites" on the PC. Link to Windows works without a Samsung account; the wider Galaxy ecosystem needs one. — [Samsung IE](https://www.samsung.com/ie/mobile/galaxy-ecosystem); [Samsung Africa](https://www.samsung.com/africa_en/mobile/connected-experience/)
- **Quick Share:** file transfer over Bluetooth and Wi-Fi. Works with non-Galaxy Android phones through Play Services and has a Windows client. Wikipedia's timeline lists AirDrop interoperability arriving on Pixel and Galaxy S26 in 2026 (single secondary source, not verified). — [Wikipedia: Quick Share](https://en.wikipedia.org/wiki/Quick_Share)
- **KDE Connect** (open source; Android plus Linux/Windows/macOS; TLS):
  - "Run Commands" are buttons on the phone that run user-defined shell commands on the computer, such as lock, sleep or screenshot. Since v1.19 they can sit in the Android power menu.
  - Shared clipboard is text only. Android 10+ blocks background clipboard reads, so the app offers a "Send clipboard" button in its persistent notification and a Quick Settings tile on Android 14+. Recent releases can skip syncing sensitive clipboard content.
  - Remote input turns the phone into a touchpad and keyboard, with "compose before send" for dictation. The Android side needs the Accessibility permission. — [KDE Userbase wiki](https://userbase.kde.org/KDEConnect); [KDE Connect GitHub](https://github.com/KDE/kdeconnect-kde/); [F-Droid](https://f-droid.org/wiki/page/org.kde.kdeconnect_tp)

### Inferences
- The Android 10+ clipboard restriction applies to ARES too. A phone-to-Mac clipboard needs an explicit user gesture: a QS tile, a notification action, or a share-sheet target. KDE Connect's tile-plus-notification pattern is the proven workaround. Mac-to-phone works freely, because ARES can put text on the phone's clipboard while its activity or a notification action is in the foreground.
- Microsoft's resume model is the right size for ARES: "you were doing X on the phone, resume on the Mac?" as a one-click card. It doesn't need full app-state serialisation. For ARES the "activity" is a conversation or job ID, a URL or a file, and those are trivially portable.
- Samsung's own continuity is Galaxy-only, and Phone Link is Windows-only. Neither helps a Mac host, which is why ARES has to provide the bridge itself.

### Gaps
- No survey or usage data on which continuity features users value most (searched; none found). Forum consensus (not sourced here) usually ranks clipboard, file send and notification mirroring highest.
- Not researched for lack of tool budget: current state of Pushbullet and Join by joaoapps (pricing, maintenance), Google Phone Hub on Chromebooks, Apple Continuity Camera specifics, and macOS 26 "Phone app on Mac" details.

## 2. Remote control of the computer from the phone (screens, single windows, files/clipboard, approvals, results)

### Takeaway
Full remote desktop from Android to a Mac realistically means Jump Desktop (paid, considered fast) or RustDesk (free and open source, self-hostable relay). Screens 5 is Apple-only. Anthropic's Claude Code Remote Control (February 2026; start-from-phone added August 2026) shows the agent-era pattern: work stays on the home machine and the phone is a thin, synced steering surface with approvals. That matches ARES's current design.

### Cited Findings
- **Screens 5 (Edovia)** is App Store-only (iPhone, iPad, Mac, Vision Pro), so no Android client. Pricing $24.99/yr, $3.99/mo, or a lifetime licence listed at $139.99 on one help page and $119 on another. — [Edovia pricing FAQ](https://help.edovia.com/en/screens-5/faq/s5-pricing); [App Store](https://apps.apple.com/app/id1663047912)
- **Jump Desktop:**
  - One review site lists the Mac licence at $34.99 and iOS at $14.99 (date unclear), and says licences aren't shared across platforms. — [AnyViewer](https://www.anyviewer.com/how-to/jump-desktop-vs-teamviewer-2578.html)
  - A MacRumors user calls Jump "almost as quick as sitting in front of the host" (anecdotal). — [MacRumors forum](https://spy.macrumors.com/threads/jump-desktop.2459214)
- **RustDesk** is described as a free alternative. — [AlternativeTo](https://alternativeto.net/software/jump-desktop)
- **Headless Apple silicon Mac minis** create a virtual display (default 1920×1080), which looks soft over VNC or Screen Sharing. A dummy plug gives better resolutions; Intel Macs needed one to start the GPU. — [Astropad blog](https://astropad.com/blog/dummy-plug-headless-mac-mini/)
- **Claude Code Remote Control (research preview, February 2026):**
  - Start it with `claude --remote-control` / `/rc`, then steer the same local session from the Claude mobile app or claude.ai/code: send messages, approve permissions, watch output.
  - Local files, MCP servers and config stay on the machine. The session reconnects after the laptop sleeps, but closing the terminal ends it.
  - Sources disagree on plan eligibility (Max only vs Pro+Max). — [TechRadar](https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move); [Gigazine](https://gigazine.net/gsc_news/en/20260225-claude-code-remote-control); [noqta.tn](https://noqta.tn/en/news/anthropic-claude-code-remote-control-mobile-2026)
  - Gigazine says sessions are "end-to-end encrypted, Anthropic never sees the code". Treat this as doubtful: the model necessarily processes the code. Verify against Anthropic docs. — [Gigazine](https://gigazine.net/gsc_news/en/20260225-claude-code-remote-control)
- **Start from the phone (21 August 2026):** every machine running `claude remote-control` appears as a device card in the Claude app's Code tab. Tap it, pick a folder, and the session starts on that computer. — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/12249/claude-code-start-session-from-phone)

### Inferences
- ARES already has the right pieces: paired channel, Work view with approvals, sendbox downloads, `claude --remote-control` from ARES.
- The missing tier is "show me the screen/window". A cheap version is a still: `screencapture -l <wid>` sent as an image card, refreshed on request. A live version streams one window (ScreenCaptureKit → WebRTC or MJPEG over the paired channel).
- A full remote desktop should be delegated to Jump or RustDesk rather than rebuilt; ARES can deep-link into it.
- Copy the "device card" model from Claude Code: the phone lists hosts (MacBook, Mac mini, VPS), each with a status and capabilities, and the user starts work "on" one of them.

### Gaps
- Current Android pricing for Jump Desktop, RustDesk Pro or self-hosted server requirements, and Apple Screen Sharing "High Performance" mode requirements were not confirmed.
- No sources on generated-UI result cards on mobile (for example A2UI / MCP-UI style specs); not researched.

## 3. The phone as sensor and actuator for a server-side agent

### Takeaway
The Home Assistant Companion app is the most mature pattern. The phone publishes sensors, the server sends "notification commands" (data-only pushes that the app turns into device actions), and actionable notifications send button presses back as events. Android allows 3 action buttons. MCP servers that expose Android capabilities now exist, both ADB-based and on-device, so a phone-as-tools approach is practical. All of them are young, third-party projects.

### Cited Findings
- **HA actionable notifications:** Android allows 3 notification actions; iOS about 10. Each action has a key (returned to the server as an event) and a title. — [HA Companion docs: actionable notifications](https://companion.home-assistant.io/docs/notifications/actionable-notifications/)
- **HA notification commands on Android** (full list on the source page):
  - App and intent control: `command_activity` (launch any intent URI/action/package), `command_broadcast_intent`, `command_launch_app`, `command_webview` (open a dashboard or entity panel).
  - Device settings: `command_dnd`, `command_ringer_mode`, `command_volume_level`, `command_media`, `command_flashlight`, `command_screen_on`, brightness and timeout, `command_bluetooth` (Android 12 or older only), BLE beacon transmit/monitor.
  - Sensors and connection: `command_high_accuracy_mode`, `command_update_sensors`, `request_location_update` (documented as unreliable), `command_persistent_connection` (always/home_wifi/screen_on/never).
  - Voice and housekeeping: `command_wake_word_detection`, `command_stop_tts`, `clear_notification`, `remove_channel`.
  - Requirements: activity, webview and launch need "display over other apps". DND, ringer and volume need Notification Policy access. On Android 15+ the app can only turn DND off if it turned it on. Malformed commands fall back to a normal notification. — [HA Companion docs: notification commands](https://companion.home-assistant.io/docs/notifications/notification-commands/)
- **HA sensors on Android** include battery level and state, Bluetooth, connection type, DND, Doze and Health Connect, plus a device_tracker for location. Since v2.5.0 some sensors have per-sensor settings, such as the Next Alarm allow-list. A third-party site claims 50+ Android sensors vs 30+ on iOS (unofficial count). — [HA Companion core docs](https://companion.home-assistant.io/docs/core/); [peyanski.com](https://peyanski.com/home-assistant-android-companion-app/)
- **HA Android Auto:** notifications with `car_ui: true` on a dedicated channel. — [HA Companion: Android Auto](https://companion.home-assistant.io/docs/android-auto/)
- **Android MCP servers:**
  - ADB-based: mobile-mcp (Mobile Next; iOS and Android), CursorTouch Android-MCP (click, swipe, type; about 2–4 s per action), uiautomator2 servers, and hao-cyber phone-mcp (last push May 2025).
  - On-device: danielealbano "Android Remote Control MCP" runs an HTTP(S) MCP server on the phone itself, MIT licence, about 57 tools (screen introspection, gestures, files, camera, intents, notifications, location). Its maintainers call it research/educational, "as-is". Tool counts and latency figures come from listings or rival comparison tables; unverified. — [Glama: Android-MCP](https://glama.ai/mcp/servers/bsa8gbusg8); [mdskills: android-remote-control-mcp](https://www.mdskills.ai/mcp-servers/android-remote-control-mcp); [agentpedia: mobile-mcp](https://agentpedia.codes/mcp/mobile-mcp); [gittrend: phone-mcp](https://gittrend.io/repo/hao-cyber/phone-mcp)

### Inferences
- **What ARES should do:**
  - Treat the phone as a tool provider. Its sensors (location, battery, Buds connected, ringer/DND, calendar, next alarm, screen on, current call) go to the brain as state. Its actions (open app/intent, set DND/volume, show a card, speak, take a photo with consent, share a file) become brain tools that are tiered like `control.js`.
  - ARES's notification `api` buttons and the outbox already follow HA's pattern. Generalise them into a typed command envelope with an allow-list and tiers, so the phone never runs arbitrary intents from the brain without a tier gate.
- Exposing the phone as an MCP server, the on-device design, would let any Claude session (including Claude Code jobs) call phone tools. It is safer for ARES to keep its own bridge and wrap phone tools in its existing tier and audit system, rather than run a third-party, accessibility-powered MCP app with a large attack surface.
- Android's 3-action limit means approvals should be "Approve / Deny / Open". Anything richer opens an in-app card.

### Gaps
- Not researched: Tasker's remote features (AutoRemote, Tasker "Remote Action Execution"), OpenAI Agents SDK and Anthropic remote-MCP patterns for remote tools, and the HA websocket "local push" mechanism (the commands page doesn't document it).

## 4. Always-on host: Mac mini vs VPS vs hybrid, headless macOS gotchas, recovery

### Takeaway
A Mac mini M4 idles at about 3–4 W (about 30–35 kWh a year), cheaper to run than most VPS bills. It is the only option for macOS-only capabilities (iMessage, Shortcuts, EventKit, Accessibility automation, the ARES helper apps). A VPS gives better uptime and isolation but cannot be "ARES's Mac". The pattern the 2026 personal-agent crowd (OpenClaw) settled on is hybrid: a small always-on control plane (relay or VPS) plus Mac worker nodes over Tailscale.

FileVault and unattended reboots were the classic conflict. macOS Tahoe 26 partly fixes it with SSH pre-boot unlock on Apple silicon, but a crash or power-loss reboot still waits for a human.

### Cited Findings
- **Mac mini M4 power:** Apple lists 4 W idle and 65 W max (16 GB / 256 GB, measured at the wall). — [Apple Support 103253](https://support.apple.com/103253)
- **Independent measurements:** NotebookCheck about 2.6 W (display off); ServeTheHome 4–6 W in light use; Jeff Geerling 3–4 W (10GbE, 32 GB). — [ServeTheHome](https://servethehome.com/the-apple-mac-mini-m4-sets-the-mini-computer-standard/3); [starryhope 2026 mini-PC power cost](https://www.starryhope.com/minipcs/mini-pc-power-cost-24-7-2026/)
- **Auto-login vs FileVault:** automatic login needs FileVault off. With FileVault on, a rebooted Mac waits at the pre-boot password prompt, offline, until someone unlocks it. Forum workaround: auto-login to a low-privilege account and keep sensitive data elsewhere (untested by the poster). — [MacPowerUsers: M4 mini headless](https://talk.macpowerusers.com/t/running-new-m4-mac-mini-headless/39519); [Medium: Mac mini home server](https://medium.com/@sandeshsachdev/turning-your-mac-mini-into-a-relentless-home-server-ee7f33e02a7b)
- **macOS Tahoe 26 remote FileVault unlock:** if Remote Login (SSH) was enabled before the reboot, you can SSH into the pre-boot environment, enter a local admin password, and the volume unlocks. This is an unlock channel, not a shell; SSH drops and comes back once the data volume mounts.
  - Apple silicon only.
  - Initially Ethernet-only (Wi-Fi credentials in the Keychain aren't available before unlock). Geerling reports Wi-Fi unlock worked as of macOS 26.5.
  - Expect a different host key.
  - Hosting providers call it experimental. Researchers flag new pre-authentication attack surface. Once unlocked, the disk stays unlocked until the next reboot. — [Jeff Geerling, 2025](https://www.jeffgeerling.com/blog/2025/you-can-finally-manage-macs-filevault-remotely-tahoe/); [Michael Tsai, Sept 2025](https://mjtsai.com/blog/2025/09/22/tahoe-filevault-icloud-keychain-and-ssh/); [greenmini.host](https://portal.greenmini.host/help/filevault-on-mac-servers-in-our-data-center); [deepakness](https://deepakness.com/raw/remote-filevault-unlock-macos-tahoe/)
- **Headless display:** Apple silicon makes a virtual 1080p display, so a dummy plug is optional (useful for resolution or for GUI automation that needs a "real" screen). — [Astropad](https://astropad.com/blog/dummy-plug-headless-mac-mini/)
- **Mac mini vs VPS for personal agents (OpenClaw guides, 2026):**
  - A VPS costs about $5–10 a month for API-only agents; the gateway is a light Node.js process.
  - A Mac mini is for iMessage, local models (Metal) or data-at-home.
  - Hybrid: the VPS runs the control plane and public bots, and the Mac is a node over Tailscale. iMessage needs a Mac, but not necessarily the gateway machine.
  - Risk: a compromised home Mac reaches the whole LAN (phones, NAS, IoT); a VPS is isolated. A home host is a single point of failure (power, router).
  - Cisco reportedly demonstrated data exfiltration through a third-party OpenClaw skill in March 2026 (secondary source).
  - Sources disagree on Mac mini pricing: $599 for the M4 vs an "$899 M6 base". Treat the M6 claim as unverified. — [Analytics Vidhya, Feb 2026](https://www.analyticsvidhya.com/blog/2026/02/openclaw-hosting-mac-mini-vs-cloud-vps/); [Gizmodo](https://gizmodo.com/best-web-hosting/openclaw/mac-mini-or-vps); [pcbuildadvisor](https://www.pcbuildadvisor.com/mac-mini-vs-vps-for-openclaw-formerly-clawdbot-moltbot-which-one-should-you-choose/); [lucaberton](https://lucaberton.com/blog/openclaw-hardware-guide-mac-mini-vs-pi-vs-vps/)
- **Privacy caveat:** "local-first" only holds with local models. Prompts sent to Claude or GPT leave the house wherever the gateway runs. — [pcbuildadvisor](https://www.pcbuildadvisor.com/mac-mini-vs-vps-for-openclaw-formerly-clawdbot-moltbot-which-one-should-you-choose/)

### Inferences
- **What ARES should do:**
  - Make the Mac mini the primary always-on brain, since ARES's power is macOS-native (EventKit helper, Accessibility, AresControl, ScreenCaptureKit, Shortcuts, iMessage).
  - Demote the MacBook to a node that registers its capabilities (screen, files, mic) when awake.
  - Keep the VPS or Cloudflare Worker strictly as a relay and watchdog (wake, heartbeat, "host down" alerts, a queue while the Mac is unreachable), not as a holder of files or credentials. That keeps the VPS blast radius small.
- **Recovery plan for the mini:**
  - Ethernet.
  - FileVault on, with Tahoe SSH unlock reachable over Tailscale. Tailscale's system extension or daemon has to be up pre-login; I could not verify this pre-boot, so a LAN jump host or the MacBook may be needed.
  - "Start up automatically after a power failure" (Energy settings).
  - A smart plug for hard power-cycling.
  - The relay's stale-heartbeat detection (ARES already has this) should push "the mini rebooted and needs an unlock" to the phone.
  - Note that ARES's GUI pieces (Electron window, Accessibility automation, ignition helper) need a logged-in GUI session, which is why the post-unlock auto-login step matters.
- **Files for the always-on host:**
  - Tailscale-only SMB or Syncthing between the MacBook and the mini for chosen folders.
  - Avoid mounting home files on a VPS; if needed, use read-only, per-folder, encrypted sync.
  - iCloud Drive "Optimize Mac Storage" makes files placeholders that headless agents can't read without downloading them first (general knowledge; not sourced here).

### Gaps
- Not sourced: iCloud Drive and Syncthing behaviour on headless Macs; whether Tailscale is reachable in Tahoe's pre-boot environment (very likely not, since it is a user-space or system-extension network; needs testing); macOS GUI automation in a logged-out or screen-locked state; current Mac mini M4/M5 prices; VPS options with macOS (MacStadium, Scaleway Apple silicon) and their costs.

## 5. Networking and reliability: Tailscale, Cloudflare, WebSocket vs push, offline queues, E2EE, pairing

### Takeaway
Keep everything private on the tailnet (Serve, ACL grants, tags) and expose only webhook-style endpoints publicly (Funnel or a Cloudflare Worker).

On Android, FCM high priority is reliable only if each message produces a visible notification. FCM watches a 7-day pattern per app instance and silently downgrades apps whose high-priority pushes are data-only.

Cloudflare Durable Objects with the WebSocket Hibernation API make a cheap always-connected relay: no duration charge while idle and hibernated, and 100 inbound messages are billed as 5 requests.

### Cited Findings
- **Tailscale Funnel** exposes a tailnet service to the public internet on the node's DNS name. It must be enabled in the tailnet policy (`nodeAttrs` with the `funnel` attribute) and only works on ports 443, 8443 or 10000. The app behind it needs its own auth. The recommended pattern is Serve (tailnet-only) for most services and Funnel only for things like webhooks. — [Tailscale blog (2023, older)](https://tailscale.com/blog/tailscale-funnel-beta/); [OneUptime, Jan 2026](https://oneuptime.com/blog/post/2026-01-28-tailscale-funnel-service-publishing/view)
- **Tailscale policy:** deny-by-default ACLs and grants; use tags for servers and grant only the needed ports. MagicDNS gives readable hostnames and underpins Funnel URLs. — [msfjarvis notes, June 2025](https://drafts.msfjarvis.dev/notes/tailscale-acl-grants/index.txt); [jisaku.com](https://jisaku.com/posts/security-zerotrust-tailscale-personal-pc)
- **FCM priority:**
  - High priority is for time-sensitive, user-visible content. If messages don't produce user-facing notifications, FCM may downgrade them to normal or hand them to Play services. It judges 7 days of behaviour per app instance, and showing visible notifications restores status.
  - High priority can wake a dozing device for limited processing and network access; normal priority waits for Doze to end.
  - Doze only happens with the screen off. Google advises testing by forcing Doze. — [Firebase docs: message priority](https://firebase.google.com/docs/cloud-messaging/android/message-priority); [Firebase blog, Apr 2025](https://firebase.blog/posts/2025/04/fcm-on-android)
- **Durable Objects (WebSocket Hibernation API):**
  - Billing: idle objects that are eligible to hibernate are not billed for duration. Using the standard `accept()` WebSocket bills for the whole connection. Duration is charged on 128 MB regardless of use. 100 inbound WebSocket messages count as 5 requests. `setWebSocketAutoResponse()` pings cost no duration.
  - When it hibernates: after about 10 s idle ("currently", so not a guarantee). It cannot hibernate with pending timers, an awaited fetch, the standard WebSocket API, or outbound sockets.
  - What survives: clients stay connected through hibernation, but in-memory state resets and the constructor re-runs. — [Cloudflare DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing); [Cloudflare DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- **KDE Connect** pairs devices explicitly and encrypts all traffic with TLS (a reference point for local pairing). — [KDE Userbase](https://userbase.kde.org/KDEConnect)

### Inferences
- **What ARES should do:**
  - **Transport:**
    - Keep the paired Tailscale/LAN channel primary while the app is foregrounded or the phone is at home.
    - Use FCM high priority only for pushes that display something (approvals, results, incoming call, "Mac rebooted").
    - Send silent state syncs (job progress, presence) as normal priority, or pull them on the next foreground/`hello`. Otherwise ARES risks the 7-day downgrade, which would break wake and approval latency.
  - **Relay:** if ARES wants a "both devices always reachable" channel without the KV write limits it already hit (1000 writes a day on the free tier), a Durable Object per user with hibernating WebSockets from both the Mac and the phone is a natural upgrade. Use auto-response pings for keep-alives, and persist per-connection metadata through attachments.
  - **E2EE:** the relay should carry opaque, signed or encrypted envelopes. ARES already HMAC-signs wake requests. Extend this to authenticated encryption keyed at pairing (for example X25519 exchanged over the QR/pair code), so a compromised Worker learns nothing.
  - **Offline:** an outbox with idempotency keys and per-item status (queued, delivered, done) on both sides, with the Mac as the source of truth and the phone as a cache. Reconcile on `hello` with a since-cursor. ARES's outbox already does part of this.

### Gaps
- Not sourced: Cloudflare Tunnel vs Tailscale Funnel comparison and Tunnel pricing; Tailscale free-plan device and user limits as of 2026; WebSocket keep-alive best practice on Android (foreground service rules in Android 14/15); E2EE library choices (libsodium, Noise) for Kotlin and Node.

## 6. Handing off conversations and tasks between devices; shared memory; presence-based notification routing

### Takeaway
Shipping products hand off activity pointers, not state: Microsoft's resume alert, Samsung's Recents card, Apple Handoff, and Claude Code's local session steered from the phone. The single source of truth stays on one host, and other devices render it.

For ARES this means one conversation/job store on the brain host, with each device showing a "continue here" card. The presence signal decides which device speaks or notifies.

### Cited Findings
- **Claude Code Remote Control:** one local session is the source of truth; the phone and web are views that send messages and approvals. The session survives host sleep but not the terminal closing. Since August 2026 the phone can start sessions on any registered machine (device cards). — [TechRadar](https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move); [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/12249/claude-code-start-session-from-phone)
- **Microsoft Resume:** an activity on the phone becomes a single-click taskbar alert on the PC; if the PC app is missing, it offers a Store install. — [Microsoft Support](https://support.microsoft.com/en-us/windows/apps/phonelink/cross-device-resume-feature); [BetaNews](https://betanews.com/2025/08/23/microsoft-adds-ability-to-resume-apps-from-android-phone-on-windows-11/)
- **Samsung continue apps:** the other device shows the app in Recents and the user taps Open; it relies on the same account plus proximity (Wi-Fi + Bluetooth). — [Samsung US Support](https://www.samsung.com/us/support/answer/ANS00088542)
- **Apple Handoff** is gated on proximity (Bluetooth range) and the same account. — [Macworld](https://www.macworld.com/article/834342/how-to-control-universal-clipboard.html)
- **HA presence-style controls:** the persistent connection can be set to always, home_wifi or screen_on. Sensors such as DND, Bluetooth and connection type give the server presence context. — [HA notification commands](https://companion.home-assistant.io/docs/notifications/notification-commands/); [HA core docs](https://companion.home-assistant.io/docs/core/)

### Inferences
- **What ARES should do:**
  - One conversation log and job store on the brain host (later the mini). Each device keeps a cursor.
  - "Continue on Mac / Continue on phone" is a card, as in Microsoft and Samsung, carrying the conversation ID and the last turn. The voice turn resumes with full memory because memory never moved.
- **Presence-based routing.** A device-scoring rule, for example:
  1. If the Mac is unlocked and not idle (ARES already reads idle+locked through `/api/status`), speak or show it on the Mac and mute the phone.
  2. If the phone's screen is on, or Buds are connected, deliver to the phone. Use voice if Buds are in.
  3. Otherwise send a visible FCM notification. This also keeps FCM priority healthy.
  4. Escalate to a call (Twilio) only for tier-3 approvals the user asked to be called for.
  5. Dedupe: when one device acknowledges, clear the copy on the other (HA's `clear_notification` pattern).
- Proximity checks like Apple's Bluetooth range could be approximated with the phone seeing the Mac's BLE advertisement or both on home Wi-Fi. That would gate "continue on Mac" offers so they only appear when the user is actually at the Mac.

### Gaps
- No sources found or fetched on engineering write-ups of multi-device conversation state for personal agents (2024–2026), or on how Google or Apple route assistant responses to the "nearest device" (for example Google Assistant's device arbitration). Both are worth a dedicated search.
