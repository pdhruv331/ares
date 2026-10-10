# Android phone control and autonomy for a personal (sideloaded) assistant: Android 16 / One UI 8+ (as of October 2026)

Scope note: research done 2026-10-10 with web search + fetches of primary pages where possible. Items marked "(unverified this session)" come from prior platform knowledge and were not re-checked against a live source here; treat them as leads to confirm, not facts.

## 1. Platform roles and permissions: what each unlocks

### Takeaway
A sideloaded app can still collect nearly every powerful grant (accessibility, notification listener, overlay, usage access, device admin, default assistant/launcher/dialer/SMS roles), but since Android 13 these sit behind "Restricted settings", which the Android 15 CDD widens and which Google's 2026 developer-verification regime now surrounds. Android 14-16 tightened foreground services (mandatory types, Android 15 boot and overlay limits, 6 h dataSync budget) and Android 16 put job quotas on apps even while they run a foreground service. Plan around `connectedDevice`, `microphone`, `phoneCall`, `specialUse` or `remoteMessaging` foreground services, not `dataSync`.

### Cited Findings
**Restricted settings and sideloading (gates for accessibility, notification listener, etc.)**
- Android 13+ blocks users from enabling Accessibility or Notification Listener access for apps installed outside an official store. The user unblocks it under Settings > Apps > [app] > three-dot menu > "Allow restricted settings" and confirms with PIN or biometric. — [CleanBrowsing](https://cleanbrowsing.org/support/mobile/disable-restricted-settings-android); [Android Authority](https://www.androidauthority.com/android-15-restricted-settings-sideloading-3481098/)
- Android 15's Compatibility Definition Document reportedly extends restricted settings to Accessibility, Notification listener, Device admin, Display over other apps and Usage access, plus the default dialer and SMS roles. OEMs are asked to use the `EnhancedConfirmationManager` API (Enhanced Confirmation Mode, ECM) to decide which other special permissions to restrict. — [Android Authority](https://www.androidauthority.com/android-15-restricted-settings-sideloading-3481098/); [Android Authority (ECM)](https://www.androidauthority.com/android-15-enhanced-confirmation-mode-3436697/)
- ECM targets a loophole: any app can use the session-based install APIs to sideload. ECM checks an allowlist of trusted installers. A blocked attempt shows "For your security, this setting is currently unavailable." — [Android Authority](https://www.androidauthority.com/android-15-enhanced-confirmation-mode-3436697/); [Android Police](https://www.androidpolice.com/android-15-enhanced-confirmation-mode-sideloading/)
- Developer verification (2026): enforcement started 30 Sep 2026 in Brazil, Indonesia, Singapore and Thailand and expands to all regions and installs in 2027. **ADB installs are exempt.** A non-ADB "advanced flow" for apps from unverified developers adds a restart, a 24-hour wait and extra warnings, and applies to updates too. It needs the "Android Developer Verifier" system service. A free hobbyist/student tier skips the fee and ID check but caps distribution at 20 devices (single source). — [Android Authority](https://www.androidauthority.com/how-to-bypass-android-developer-verification-sideloading-rules-3718002/); [9to5Google](https://9to5google.com/2026/08/18/google-gradually-rolling-out-androids-advanced-sideloading-ahead-of-developer-verification/); [Android Developers blog](https://developer.android.com/blog/posts/android-developer-verification-rolling-out-to-all-developers-on-play-console-and-android-developer-console); [Foresight Mobile](https://foresightmobile.com/blog/android-developer-verification-2026)

**Notification listener (already used by ARES)**
- Android 15 stops *untrusted* `NotificationListenerService` apps from reading unredacted content of notifications where the system detects a one-time passcode. Trusted apps, such as companion-device-manager associations, are exempt. — [Android 15 behaviour changes (all apps)](https://developer.android.google.cn/about/versions/15/behavior-changes-all?hl=fi) as summarised in search; [Android Authority](https://androidauthority.com/android-15-two-factor-authentication-codes-3492585)
- The gating permission was found in code as `RECEIVE_SENSITIVE_NOTIFICATIONS` with protection level `role|signature`. It is not in public docs. — [Android Authority](https://www.androidauthority.com/android-15-sensitive-notifications-3416414)
- The same Android 15 page covers screen-share protection: notification content is hidden during screen sharing. — [Android 15 behaviour changes (all apps)](https://developer.android.google.cn/about/versions/15/behavior-changes-all?hl=fi)

**Foreground service (FGS) types (Android 14+, API 34)**
- Every FGS must declare `android:foregroundServiceType` and hold `FOREGROUND_SERVICE` plus the type permission. Relevant types:
  - `connectedDevice` (`FOREGROUND_SERVICE_CONNECTED_DEVICE`) needs one manifest permission (CHANGE_NETWORK_STATE / CHANGE_WIFI_STATE / NFC …) and one runtime grant (BLUETOOTH_CONNECT/SCAN/ADVERTISE, UWB_RANGING) or USB permission.
  - `dataSync`, `mediaPlayback` and `remoteMessaging` have no runtime prerequisite.
  - `microphone` needs RECORD_AUDIO and is while-in-use restricted (no background start).
  - `mediaProjection` needs consent through `createScreenCaptureIntent()` first.
  - `phoneCall` needs `MANAGE_OWN_CALLS` or `ROLE_DIALER`.
  - `shortService` runs about 3 minutes.
  - `specialUse` needs a `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` manifest property (Play reviewers read it).
  - `systemExempted` needs Device Owner/Profile Owner/Device Admin, `ROLE_EMERGENCY`, `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`, or a configured VPN.

  — [FGS types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- Android 15 (targetSdk 35):
  - `dataSync` and `mediaProcessing` FGS each get 6 hours per 24 h (shared across the app's services of that type). Then `Service.onTimeout(int,int)` fires; failing to stop throws `RemoteServiceException`. Bringing the app to the foreground resets the timer.
  - `BOOT_COMPLETED` receivers may not start `dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection` or `microphone` FGS.
  - The `SYSTEM_ALERT_WINDOW` background-start exemption now also requires a *visible* `TYPE_APPLICATION_OVERLAY` window.
  - Background activity launches from PendingIntents are blocked by default.
  - `requestAudioFocus()` fails unless the app is on top or runs an FGS.

  — [Android 15 behaviour changes (targetSdk 35)](https://developer.android.com/about/versions/15/behavior-changes-15)
- Do Not Disturb (targetSdk 35): apps can no longer change global DND state or policy. `setInterruptionFilter()`/`setNotificationPolicy()` now create or update an implicit `AutomaticZenRule` (most-restrictive-wins). — [Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15)
- Android 16 (all apps):
  - JobScheduler/WorkManager runtime quotas are now enforced even in the active standby bucket.
  - Jobs started while visible, and jobs running concurrently with an FGS, are subject to the quota. Google suggests user-initiated data transfer jobs instead.
  - `setImportantWhileForeground` is ignored.
  - Intent-redirection hardening blocks launching sub-intents taken from extras unless the app calls `removeLaunchSecurityProtection()`.
  - Ordered-broadcast priorities only apply within a process.
  - Test with `adb shell am set-standby-bucket <pkg> active|working_set|frequent|rare|restricted`.

  — [Android 16 behaviour changes (all apps)](https://developer.android.com/about/versions/16/behavior-changes-all)

**Advanced Protection (Android 16 feature, accessibility block in 17)**
- Android 17 Beta 2 (first seen in Canary 2602) revokes, and blocks granting, AccessibilityService access for any app that is not `isAccessibilityTool="true"` while Advanced Protection Mode is on. Assistants, automation tools and launchers do not qualify. On stable Android 16 QPR3 (Pixel 10 Pro) such apps still worked with Advanced Protection on. Apps can detect the mode through `AdvancedProtectionManager`. — [Android Authority teardown](https://www.androidauthority.com/android-advanced-protection-mode-accessibility-apk-teardown-3640742/); [The Hacker News](https://thehackernews.com/2026/03/android-17-blocks-non-accessibility.html); [Malaysian Wireless](https://www.malaysianwireless.com/2026/03/android-17-beta2-advanced-protection-mode/)

### Inferences
- ARES needs to switch on "Allow restricted settings" once on the Galaxy for accessibility (and possibly overlay/usage access on One UI 8 if Samsung adopted the Android 15 CDD list). Installing over ADB (`adb install`, wireless debugging) sidesteps developer verification entirely, which matters once enforcement reaches the owner's region in 2027.
- Never enable Advanced Protection on the owner's phone if ARES relies on accessibility (Android 17+).
- Long-lived link FGS: use `connectedDevice` (justified by Buds/Bluetooth and Wi-Fi), `microphone` (wake word, started from the foreground) or `specialUse`. Do not use `dataSync`, because of its 6 h/24 h cap and no boot start. Starting from boot: `connectedDevice`/`specialUse` are not on the Android 15 boot-blocked list.
- (Unverified this session) What the roles grant:
  - `RoleManager.ROLE_ASSISTANT` + `VoiceInteractionService`/`VoiceInteractionSession`: on invocation the assistant can receive the foreground app's `AssistStructure` (view tree text) via `onHandleAssist()` and a screenshot via `onHandleScreenshot()`. Both are subject to the user's "Use text from screen" / "Use screenshot" toggles. It can also discover/perform app-declared Direct Actions (`requestDirectActions`/`performDirectAction`, API 29+). A WebFetch of the reference page could not reach these sections, so confirm the signatures.
  - `ROLE_HOME`: the launcher. Already held.
  - `ROLE_DIALER`: InCallService UI, `phoneCall` FGS.
  - `ROLE_SMS`: write to the SMS provider, send SMS without UI.
  - `ROLE_CALL_SCREENING`: `CallScreeningService` to reject/silence/screen calls.
  - Taking the dialer/SMS roles from Samsung Phone/Messages is high-friction and risky for a personal build. Call screening is the lightweight one.
- (Unverified this session) Other special access:
  - `PACKAGE_USAGE_STATS` (usage access via `UsageStatsManager`): foreground-app history, a context feed for ARES.
  - `SYSTEM_ALERT_WINDOW`: the bubble.
  - `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM`: the latter is only for alarm/calendar apps on Play, and either one qualifies for `systemExempted` per the cited page.
  - `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` → `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
  - Device admin (`DevicePolicyManager`): mostly lock/wipe now.
  - Device owner: needs a factory-reset or ADB `dpm set-device-owner` on a device with no accounts, so it is impractical on the owner's daily phone.

### Gaps
- Whether One UI 8 / 8.5 actually ships ECM restrictions on overlay/usage access/dialer/SMS for sideloaded apps. I found only Android 15 CDD reporting, no Samsung confirmation.
- `RECEIVE_SENSITIVE_NOTIFICATIONS`: no official doc. I could not confirm whether holding `ROLE_ASSISTANT` or a CompanionDeviceManager association (e.g. associating the phone with the Mac/Buds) lets ARES see OTPs.
- The exact VoiceInteractionSession assist/screenshot API details and the Android 16 changes to them were not verified (fetch truncated).

## 2. Acting inside other apps: accessibility automation, screen understanding, AppFunctions, LLM phone agents

### Takeaway
For a personal app the practical stack has three layers: (1) deterministic intents/shortcuts/notification actions, (2) AccessibilityService for the view tree, gestures and global actions, and (3) screenshots for a vision LLM on the Mac. AppFunctions (Android 16, API 36) is the future structured path. Today, though, the caller side is effectively Gemini/system-only (private preview; protection level disputed). Google's own Gemini "UI automation" is a beta limited to a handful of delivery/ride apps on the Galaxy S26 and Pixel 10. LLM agents now score 73-97% on AndroidWorld, but that benchmark is saturated and the numbers are self-reported.

### Cited Findings
**AppFunctions (Android 16+)**
- What it is: Android's platform API + Jetpack library for exposing app features to AI agents, described as the on-device equivalent of MCP tools.
- Requirements and API:
  - Android 16 (API 36)+.
  - Functions are declared with `@AppFunction`, types with `@AppFunctionSerializable`, and the service with `@AppFunctionServiceEntryPoint`. The annotation processor generates an XML schema the OS indexes.
  - Callers need `android.permission.EXECUTE_APP_FUNCTIONS` to discover/execute and use `AppFunctionManager` (e.g. `isAppFunctionEnabled(pkg, functionId)`).
  - Debug with `adb shell cmd app_function list-app-functions`.
- Status: "experimental preview". Gemini integration is in private preview with trusted testers as of May 2026, and an Early Access Program onboards select apps. "Only a limited number of apps and system agents can access the full pipeline."

  — [Overview of AppFunctions](https://developer.android.com/ai/appfunctions)
- Protection level of `EXECUTE_APP_FUNCTIONS` conflicts: the public `Manifest.permission` reference reportedly says "normal", with allowlist checks enforced at runtime. A community sample says it is granted only to privileged system apps on Android 16 (≤ android-16.0.0_r4). Check on-device with `adb shell pm list permissions -f | grep -A5 EXECUTE_APP_FUNCTIONS`. The reference also lists a separate `EXECUTE_APP_ACTION` "for an assistive application to perform actions on behalf of users inside of applications". — [Manifest.permission](https://developer.android.com/reference/android/Manifest.permission) (via search summary); [AppFunctionsPilot sample](https://github.com/FilipFan/AppFunctionsPilot)
- Google (Feb 2026):
  - AppFunctions plus a separate "UI automation framework" that lets agents do "generic tasks in installed apps" with "zero code" from developers.
  - UI automation is an early preview on the Galaxy S26 series and select Pixel 10 devices. It is invoked by long-pressing the power button and is a beta in the Gemini app for curated food delivery, grocery and rideshare apps in the US and Korea. Progress shows via notification or "live view", the user can take over at any point, and Gemini alerts before sensitive actions such as purchases.
  - The Samsung Gallery AppFunctions integration with Gemini is on the S26, with One UI 8.5+ Samsung devices "soon". Gemini already automates Calendar, Notes and Tasks across OEMs.
  - Android 17 is the target for broadening.

  — [Android Developers Blog, "The Intelligent OS"](https://android-developers.googleblog.com/2026/02/the-intelligent-os-making-ai-agents.html)
- Gemini task automation went live on the Galaxy S26 in March 2026.
  - Launch apps: Lyft, Uber, Grubhub, DoorDash, Uber Eats, Starbucks.
  - The target app runs in "a secure virtual window" in the background, and the user's final confirmation is required.
  - In a 9to5Google test Gemini filled an Uber Eats cart but stopped before checkout. One run locked the phone in a full-screen preview that needed a forced reboot.

  — [9to5Google](https://9to5google.com/2026/03/12/gemini-android-app-automation-galaxy-s26-rollout/); [The Deep View](https://thedeepview.com/articles/agentic-gemini-feature-debuts-on-samsung-phone); [heise](https://heise.de/-11191564)
- Critics note Gemini's scope is still limited to taxis, takeout and groceries, comparable to Chinese OEM assistants. — [ifanr](https://www.ifanr.com/1655996)

**Open-source / research LLM phone agents and benchmark numbers**
- Mobile-Agent-v3 (GUI-Owl framework, Aug 2025): 73.3 on AndroidWorld and 37.7 on OSWorld. GUI-Owl-7B alone scored 66.4. Agent S2 (Claude-3.7-Sonnet + UI-TARS-72B) scored 54.3. — [arXiv 2508.15144](https://arxiv.org/abs/2508.15144); [MobileUse arXiv 2507.16853](https://arxiv.org/pdf/2507.16853)
- MobileWorld (Dec 2025): state-of-the-art frameworks now exceed 90% on AndroidWorld, which is why the authors built a harder benchmark with agent-user interaction and MCP-augmented tasks. — [arXiv 2512.19432](https://arxiv.org/pdf/2512.19432)
- 2026 aggregator snapshots (self-reported, mixed variants):
  - 97.4% pass@1 (Gemini 3 Flash + Flash Lite; A0 AGI-0), i.e. 113/116 tasks per FinalRun.
  - 94.8% for an AskUI entry with Claude 4.5 Sonnet.
  - Human baseline listed as 80.0%.
  - Claude Opus 4.6 at 62.0% and Qwen3.8-27B at 81.9% (model cards).

  — [benchmarklist.com](https://benchmarklist.com/benchmarks/androidworld/); [AskUI benchmarks](https://www.askui.com/benchmarks); [FinalRun](https://www.finalrun.app/benchmark); [llm-stats](https://llm-stats.com/benchmarks/androidworld)
- AndroidWorld itself: ICLR 2025, a dynamic benchmark of 116 tasks across real apps in an emulator. — [ICLR 2025 proceedings](https://proceedings.iclr.cc/paper_files/paper/2025/hash/01a83bc2f2732a58e6aa731e659e7101-Abstract-Conference.html)
- DroidRun:
  - MIT-licensed and LLM-agnostic (OpenAI, Anthropic, Gemini, Ollama, DeepSeek). It uses screenshots plus the accessibility tree.
  - `droidrun setup` installs the "DroidRun Portal" APK, which provides an accessibility service for UI-tree extraction, a numbered element overlay and an input method (IME) for text entry. The host needs ADB.
  - A community MCP server wraps it for Claude Code using a text-only accessibility tree with numbered elements (tap, type, swipe, launch apps).

  — [DroidRun MCP Server (Glama)](https://glama.ai/mcp/servers/chukfinley/droidrun-mcp-server); [AlternativeTo](https://alternativeto.net/software/droidrun/about)

### Inferences
- For ARES the best design copies DroidRun's Portal idea *inside the ARES app itself*: the AccessibilityService serialises the active window tree (`getRootInActiveWindow()`, `getWindows()`) into compact numbered JSON and executes actions (`performAction(ACTION_CLICK/SET_TEXT/SCROLL_FORWARD)`, `dispatchGesture`, `performGlobalAction(GLOBAL_ACTION_BACK/HOME/RECENTS/NOTIFICATIONS/TAKE_SCREENSHOT)`). Accessibility `takeScreenshot()` (API 30+) gives pixels without a MediaProjection prompt (unverified this session). Claude on the Mac plans over the existing WebSocket. This avoids ADB for normal use. The API names are from prior platform knowledge; confirm them in the AccessibilityService reference.
- Accessibility text is cheaper and faster than screenshots. Use a screenshot only when the tree is empty (Flutter/games/WebView canvases, FLAG_SECURE screens are black).
- AppFunctions: worth exposing ARES's *own* functions now (cheap, future-proof for Gemini). Do not plan on ARES *calling* other apps' AppFunctions on a Samsung retail build until the permission is shown grantable. Test with the pm command above on the owner's phone.
- AndroidWorld's 90%+ does not transfer to a real Galaxy with Samsung apps, logins, pop-ups and banking/secure screens. MobileWorld exists because of that gap. Expect a much lower first-try success rate and design for verify-after-act plus human fallback.

### Gaps
- No measured per-step latency numbers for accessibility-tree vs screenshot agents on real devices were found.
- No AppAgent AndroidWorld score found.
- No official statement on whether third-party `ROLE_ASSISTANT` holders can call AppFunctions, or what the "secure virtual window" API behind Gemini UI automation is (possibly a virtual display, not public).

## 3. Power tools: Shizuku, wireless ADB, Tasker/AutoInput, Home Assistant, programmatic settings

### Takeaway
Shizuku (ADB-shell-level privileges, started via Wireless debugging, re-start needed after each reboot) is the main way to get "root-like" control without root. With it an app can grant itself `WRITE_SECURE_SETTINGS`, toggle radios, freeze apps and run `cmd`/`settings`/`input` commands. Tasker 6.6 now integrates Shizuku natively. Plain-app APIs for Wi-Fi/Bluetooth/DND have been progressively closed since Android 10/13/15, so a settings panel or Shizuku is required.

### Cited Findings
- Shizuku:
  - Runs system API calls with the ADB shell's privileges.
  - Wireless-debugging start works on Android 11+ without a computer: pair once with the code, then start. The start must be repeated after each reboot.
  - Uses: silent install, freeze apps, AppOps permission management, change system settings, remove system apps.
  - Limits: many OEM modifications can break it, it is less than root, and `rish` gives a shell for terminal apps.
  - Some banking apps refuse to run while debugging is on.

  — [Shizuku user manual](https://shizuku.rikka.app/guide/setup/); [potatoenergy Shizuku guide](https://potatoenergy.ru/en/blog/android/shizuku-guide/)
- A third-party fork's release notes mention fixing a `rish` timeout and working around "background broadcast delivery blocks introduced in Android 16". This is not from the Shizuku maintainers. — [shevery release notes](https://newreleases.io/project/github/HmnDev-Tech/shevery/release/v13.8.0-r27-hotfix)
- Tasker 6.6:
  - "Full Shizuku integration" for "root-level actions without root", with a "Shizuku Available" state and a "Check Shizuku" function (%is_shizuku_running etc.).
  - Existing actions (Airplane Mode, Wi-Fi, Mobile Data …) automatically use Shizuku, and Wi-Fi Tether works on Android 16+.
  - The Java Code action can reach `tasker.getAccessibilityService`.
  - 6.6.18 is dated 5 Feb 2026.

  — [Tasker 6.6 changelog](https://tasker.joaoapps.com/changes/changes6.6.html)
- AutoInput (Tasker plugin, accessibility-based UI automation) 3.0.11/3.0.12 target API 36. — [APKMirror AutoInput 3.0.12](https://www.apkmirror.com/apk/joaomgcd/autoinput/autoinput-3-0-12-release/autoinput-3-0-12-android-apk-download/)
- DND: since targetSdk 35, apps contribute `AutomaticZenRule`s rather than flipping global DND. — [Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15)
- Home Assistant Companion (an existing "server tells phone what to do" design):
  - Special notification messages act as commands: `command_activity` (launch any activity; needs the overlay permission on first use), `command_dnd` (priority_only/alarms_only/total_silence/off; needs notification-policy access), `command_broadcast_intent`, Bluetooth, flashlight, volume, webview and more.
  - Some commands (clear_notification, remove_channel) always work even when others are disabled.

  — [HA Notification Commands](https://companion.home-assistant.io/docs/notifications/notification-commands); [SmartHomeScene](https://smarthomescene.com/guides/how-to-control-your-phone-with-home-assistant/)

### Inferences
- (Unverified this session) Programmatic settings on Android 15/16 for a normal app:
  - Wi-Fi: `WifiManager.setWifiEnabled` is a no-op for targetSdk ≥ 29. Use `Settings.Panel.ACTION_WIFI` / `ACTION_INTERNET_CONNECTIVITY`, `ACTION_NFC`, `ACTION_VOLUME`.
  - Bluetooth: `BluetoothAdapter.enable()` is deprecated/blocked for targetSdk ≥ 33. Use a system dialog.
  - Volume: `AudioManager` works, but DND state limits stream changes.
  - Brightness: `Settings.System.SCREEN_BRIGHTNESS` with `WRITE_SETTINGS` (user-granted special access).
  - Location mode: secure setting, needs `WRITE_SECURE_SETTINGS`.
  - DND: notification policy access + `AutomaticZenRule`.
  - Flashlight: `CameraManager.setTorchMode` works.
  - With Shizuku/ADB: `pm grant <pkg> android.permission.WRITE_SECURE_SETTINGS` (persists across reboots), `svc wifi|bluetooth|data enable|disable`, `cmd`, `settings put`, `input`, `am`, `appops`. Confirm each on One UI 8.
- ARES can embed the Shizuku API (`dev.rikka.shizuku:api`) directly. It need not depend on Tasker. Tasker is only worth bridging (via its intents/`tasker:` URI or the plugin framework) if the owner already has Tasker flows.
- Samsung Modes and Routines: no public third-party API was found. ARES could only trigger it indirectly (accessibility or Samsung's own Routines actions).

### Gaps
- Tasker's third-party intent/plugin API for an external app to run tasks (e.g. the `net.dinglisch.android.tasker.ACTION_TASK` intent) was not confirmed in this session.
- Samsung Modes and Routines programmatic access: no source found.
- Whether Shizuku's wireless start survives One UI 8's "Auto Blocker" (which by default blocks USB/ADB commands and sideloads) was not checked. Unverified: Samsung's Auto Blocker / Maximum restrictions may block wireless debugging and ADB installs.

## 4. Background reliability on Samsung

### Takeaway
Samsung is still rated 5 (worst) on dontkillmyapp. "Sleeping / Deep sleeping apps", adaptive battery and auto-optimise can kill or restrict an assistant, and there is "no known solution on dev end" beyond user settings and a properly typed FGS (Samsung promised standard FGS behaviour from One UI 6 for Android 14 apps). FCM high-priority messages wake the app but are deprioritised to normal priority if they don't produce visible notifications.

### Cited Findings
- Samsung's background killing:
  - Score 5 (worst).
  - Mechanisms: Sleeping, Deep Sleeping and Never Sleeping lists, and "Put unused apps to sleep" (default 3 days), which stops alarms and background tasks. Samsung may re-add apps after firmware updates.
  - Adaptive battery is more aggressive than AOSP.
  - User steps: Battery "Unrestricted" / don't optimise, add the app to "Never sleeping apps", disable "Put unused apps to sleep" and "Auto-optimise daily", lock the app in Recents, and turn off Game Booster restrictions.
  - "No known solution on dev end."
  - Samsung stated in July 2024 that from One UI 6.0, FGS of apps targeting Android 14 "should work as intended" if built to policy.

  — [dontkillmyapp: Samsung](https://dontkillmyapp.com/samsung)
- FCM: high-priority messages that don't result in user-visible notifications can be deprioritised to normal priority or proxied by Play services, judged per app instance over 7 days. `RemoteMessage.getPriority()` vs `getOriginalPriority()` reveals it. Firebase recommends starting an expedited WorkManager job from `onMessageReceived` (a brief exemption applies) rather than relying on FGS start, and handling `ForegroundServiceStartNotAllowedException`. — [Firebase message priority](https://firebase.google.com/docs/cloud-messaging/android/message-priority?authuser=6); [Firebase blog 2025](https://firebase.blog/posts/2025/04/fcm-on-android)
- Android 16 quotas apply to jobs even in the active bucket and while an FGS runs. — [Android 16 behaviour changes](https://developer.android.com/about/versions/16/behavior-changes-all)

### Inferences
- Reliability recipe:
  1. A typed persistent FGS (`connectedDevice`/`specialUse`) holding the WebSocket to the Mac, with an ongoing notification.
  2. The user exempts ARES from optimisation and adds it to Never Sleeping apps.
  3. Being `ROLE_HOME` + `ROLE_ASSISTANT` keeps ARES's process frequently in the foreground, which helps standby buckets (unverified).
  4. FCM high-priority as the wake path when the socket is dead, always ending in a visible notification or an expedited job so priority isn't downgraded. Silent "ping only" FCM messages will be deprioritised.
  5. Re-check the settings after One UI updates, since Samsung may re-sleep apps.

### Gaps
- No One UI 7/8-specific dontkillmyapp data. The page's latest Samsung note is from 2024.
- No measured data on WebSocket survival on One UI 8 with the FGS approach.

## 5. Security and policy

### Takeaway
Accessibility is the biggest risk surface (it is how banking malware works). Google now blocks it under Advanced Protection on Android 17 and bans *autonomous* accessibility use in Play apps. For a sideloaded personal app the policy doesn't bind ARES, but the threat model does: a compromised Mac/relay or prompt-injected screen content could drive the phone. ARES needs its own approval tiers, as Gemini does (confirm before purchases, live view, user can take over).

### Cited Findings
- Google Play AccessibilityService policy:
  - "Any use of the Accessibility API that enables an app to autonomously initiate, plan, and execute actions or decisions is strictly prohibited". Deterministic, human-defined scripts are allowed.
  - `isAccessibilityTool="true"` apps (disability tools only; assistants, automation tools and launchers excluded) are exempt.
  - Others need prominent in-app disclosure and consent plus a declaration form with a demo video.

  — [Play Console Help: Use of the AccessibilityService API](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)
- Under Advanced Protection on Android 17, non-tool accessibility services are revoked and cannot be re-granted. — [Android Authority](https://www.androidauthority.com/android-advanced-protection-mode-accessibility-apk-teardown-3640742/)
- Android 15 protections:
  - OTP redaction for untrusted notification listeners.
  - Notification content hidden during screen share.
  - PendingIntent background-activity-launch blocks.

  — [Android 15 behaviour changes (all)](https://developer.android.google.cn/about/versions/15/behavior-changes-all?hl=fi); [Android 15 behaviour changes (35)](https://developer.android.com/about/versions/15/behavior-changes-15)
- Gemini's safeguards: the app runs in a sandboxed virtual window limited to specific apps, a confirmation is required before final actions, and the user can watch, pause, stop or take over. — [The Deep View](https://thedeepview.com/articles/agentic-gemini-feature-debuts-on-samsung-phone); [heise](https://heise.de/-11191564); [Android Developers Blog](https://android-developers.googleblog.com/2026/02/the-intelligent-os-making-ai-agents.html)
- Wireless debugging should be off on public networks and Shizuku stopped when unused. — [potatoenergy Shizuku guide](https://potatoenergy.ru/en/blog/android/shizuku-guide/)

### Inferences
- Mirror the Mac's `control.js` tier model on the phone:
  - Tier 1: read-only. Tree, screenshot, notifications, usage.
  - Tier 2: logged reversible actions. Open app, toggle settings, scroll.
  - Tier 3: on-phone confirmation (biometric `BiometricPrompt`) for send/pay/delete/permission dialogs/settings that reduce security.
- Enforce the tiers on the phone side, not only on the Mac, so a compromised Mac can't bypass them.
- Package blocklist: banking, password managers, Settings > Security, the Accessibility settings themselves, the Shizuku app, and Samsung Pass/Wallet.
- Treat all screen text as untrusted data in the Claude prompt (prompt injection via messages/web pages).
- Show a visible "ARES is driving" overlay with a STOP control, like Gemini's live view.
- (Unverified this session) Android 15 detects screen recording (`WindowManager.addScreenRecordingCallback`). FLAG_SECURE windows render black to screenshots. Private Space (Android 15) apps are hidden from launchers/accessibility when locked. Expect the agent to fail on those by design.

### Gaps
- Whether accessibility services can see/act inside Private Space or Samsung Secure Folder on One UI 8 was not verified.
- Android 16 "sensitive content" / screen-share protections beyond Android 15 were not found on the fetched page.

## 6. How existing projects let a remote (server-side) LLM control an Android phone

### Takeaway
There are three patterns:
- (a) ADB from the host. Android MCP servers and DroidRun with USB/wireless ADB. Powerful, but tied to debugging being on and the host being near.
- (b) An on-device helper app with an accessibility service + IME, exposing the UI tree to a remote agent. DroidRun Portal; android-remote-control-mcp.
- (c) Push-command channels. Home Assistant's notification commands over FCM/WebSocket.

ARES already has (c)'s transport. Adding (b) inside the ARES app gives remote control without ADB.

### Cited Findings
- DroidRun MCP server: a text-only accessibility-tree MCP for Claude Code via DroidRun + ADB (USB debugging, Python 3.10+). — [Glama](https://glama.ai/mcp/servers/chukfinley/droidrun-mcp-server)
- Other Android MCP servers exist: "android-remote-control-mcp" (danielealbano) and "android-mcp-server" (minhalvp, ADB-based). — [mdskills](https://www.mdskills.ai/mcp-servers/android-remote-control-mcp); [SourcePulse](https://www.sourcepulse.org/projects/2338726); [Glama Android MCP list](https://glama.ai/mcp/servers/integrations/android)
- Home Assistant: server-sent notification commands (`command_activity`, `command_dnd`, `command_broadcast_intent`, volume, Bluetooth …), each needing a one-time special-access grant on the phone. — [HA Notification Commands](https://companion.home-assistant.io/docs/notifications/notification-commands)
- MobileWorld benchmarks agents in "MCP-augmented" environments, reflecting the trend of mixing tool calls with GUI actions. — [arXiv 2512.19432](https://arxiv.org/pdf/2512.19432)
- Gemini's hybrid approach: structured APIs (AppFunctions) where integrated, screen automation otherwise. — [heyupnow (secondary)](https://heyupnow.com/blogs/news/googles-masterstroke-how-the-new-gemini-agent-redefines-the-future-of-android-neu-definiert); [Android Developers Blog](https://android-developers.googleblog.com/2026/02/the-intelligent-os-making-ai-agents.html)

### Inferences: recommendations for ARES (ranked)
1. **Phone tool server inside the ARES app** over the existing paired link (`hello`-authenticated WebSocket, FCM wake). Expose the tools to Claude on the Mac exactly like `tools/control-tools.js`:
   - `phone_open_app`, `phone_intent` (deep links, share, ACTION_SEND, calendar insert)
   - `phone_ui_tree`, `phone_ui_act`, `phone_screenshot`
   - `phone_notifications`, `phone_reply`
   - `phone_settings` (panels or Shizuku)
   - `phone_context` (usage stats, foreground app, battery, Buds, location)
2. **Prefer structured paths first**: intents, deep links and notification actions (already built), then shortcuts (`LauncherApps.getShortcuts`, available to ARES as `ROLE_HOME`; unverified), and AppFunctions later. Fall back to accessibility UI automation, and to screenshot + vision only last.
3. **Accessibility service inside ARES** (Restricted settings → allow, once). Keep it off any Play build. Never enable Advanced Protection.
4. **Optional Shizuku tier** for radios, secure settings, silent installs and `input` commands, with the reboot re-start cost noted. One-time `pm grant … WRITE_SECURE_SETTINGS` via ADB from the Mac covers many toggles without Shizuku running.
5. **Approvals enforced on the phone** with BiometricPrompt for tier 3, a visible driving overlay plus STOP, and a per-package blocklist and audit log (synced to the Mac's `audit.jsonl`).
6. **Background**: a typed FGS (`connectedDevice`/`specialUse`), the user's Samsung battery exemptions, and FCM high-priority messages that always surface a notification or expedited job.

### Gaps
- No public measurements of end-to-end latency for remote-LLM phone control over a socket (tree → plan → act) were found.
- Droidrun Cloud's pricing/architecture was not researched in this session.
