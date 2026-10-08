THE ARES LAUNCHER: make the ARES Android app able to be the phone's home screen. Home = option 1 from docs/mockups/launcher-options.html ("Reactor Home"), with option 3's cards ("HUD Stack") one swipe to the right, and option 5's app drawer on swipe up. See CLAUDE.md (power from the phone, the relay) and the project notes. Read android/…/MainActivity.kt, ReactorView.kt (power states, jobs, holdK), HoldDetector, Session.kt + Assistant.kt (listening, the assistant role), Jobs.kt (JobStore), PowerStore.kt, WorkActivity.kt (approvals), AresWidget.kt, Haptics/Sounds, and phone.js's routes first. Reuse them; no second reactor, session or job store. Android only (plus small phone.js additions if a card needs data the Mac doesn't send yet). Commit after each working step.

HARD RULES
- It must be a good launcher first: an app opens in one tap from the dock or two from the drawer, Home always comes back to the reactor page, nothing on the home screen waits for the Mac. With the Mac asleep, quit or out of reach, the clock, dock, drawer and the calendar card all still work; only the ARES parts show their state (PowerStore: STANDBY, OFFLINE, ASLEEP, UNREACHABLE).
- Opt-in and reversible: it's only the home screen if I pick it (Settings → Default apps → Home app). The ARES app icon and MainActivity keep working exactly as now. Never stop me switching back to One UI Home.
- Battery: the reactor animates only while the home screen is in front and the screen is on; the reactor runs at a reduced frame rate on home (it's ambient) and goes static under Power Saving. Measure idle drain before/after (adb dumpsys batterystats) and tell me the number.
- Don't touch the calls code paths (CallsActivity, CallStore) beyond opening them.
- Tiers stay as they are: approvals from a card go through the same calls WorkActivity makes.

1. THE HOME ACTIVITY
- New `HomeActivity` with MAIN + HOME + DEFAULT categories, singleTask, excluded from recents, transparent system bars, portrait. Declare the `<queries>` for launcher intents (no QUERY_ALL_PACKAGES); list apps with LauncherApps (handles work profile/Secure Folder apps too).
- Horizontal pager with two pages: REACTOR (page 0, default) and CARDS (page 1). A small two-dot indicator above the dock. Pressing Home on page 1, or with the drawer open, glides back to page 0.
- The dock (5 apps, edited by long-press → drag, or "Edit dock" in the long-press menu) and the "︿ APPS" handle stay put across both pages.

2. PAGE 0 · REACTOR
- As the mockup: big thin clock + date (and the weather temp only if it's free to get; skip otherwise), the ReactorView centred with the job orbs in orbit (amber = needs me), and two callouts at the bottom: NEXT (the next calendar event) and CLAUDE (5-hour usage). Callouts hide when they have nothing to say.
- Reactor: tap = open ARES (MainActivity, talk-ready); hold = push-to-talk in place (HoldDetector + Session, the caption under the reactor, the answer spoken); tap an orb = that job's card (WorkActivity); long-press empty space = wallpaper/launcher settings.
- Power: the reactor shows PowerStore's mode exactly as MainActivity does; the existing power control (hold to wake/standby) is reachable from the reactor's long-press menu, not by default hold (hold is talk here).

3. PAGE 1 · CARDS
- NEXT: today's and tomorrow's events read on the phone (CalendarContract, READ_CALENDAR asked the first time this page opens). Phone-local so it works with the Mac off. Tap an event = open it in the calendar app.
- WORK: running jobs with progress bars (JobStore), approvals in amber with OK / REVIEW (the existing approval calls), STOP ALL at the bottom (the existing /api/autonomy stop, with the same confirm as the Work view).
- SYSTEMS: Mac state (PowerStore, the host's battery if the Mac sends it; add it to status/hello in phone.js if not), Claude usage 5H / WEEK (what the app already gets), the phone's own battery.
- Cards appear only when they have content; an empty page says "All quiet." Same styling as the mockup's cards (dark glass, cyan headers, amber for needs-me).

4. THE APP DRAWER
- Swipe up anywhere on page 0 or 1 (or tap the handle). Search field at the top, PINNED row, then all apps A–Z in a 4-column grid with letter headers and a fast-scroll letter rail on the right.
- Search matches app names as you type; when nothing matches, the top result is "Ask ARES: <text>" (sends through Session like the ask box).
- Long-press an app: App info, Uninstall, Add to dock, and the app's shortcuts (LauncherApps.getShortcuts, available because we're the default launcher).
- Opening animation: the drawer rises with the scan line from the mockup (≤ 250 ms). Respect "Remove animations".

5. ICONS
- Themed icons: use the adaptive icon's monochrome layer (Android 13+) tinted reactor cyan on a dark circle; apps without one get their normal icon, desaturated and tinted, on the same circle. Setting: "Original icons" turns the tint off.
- Cache rendered icons; refresh on package add/remove/update (LauncherApps callback).

6. ENTRY POINTS
- Keep ARES as the default digital assistant (unchanged). The side button and the Buds' "voice command" (if Samsung routes it to the default assistant) still open AskActivity.
- The home screen's own hold-to-talk uses the same session, so a conversation started on home continues in MainActivity if I tap the reactor.

7. SETTINGS (a small "Launcher" section in the app's existing settings)
- Original icons on/off, show/hide each callout, show/hide each card, clock 12/24 h (follow the system by default), "Make ARES my home screen" (opens the system Home app picker), "Switch back to One UI Home" (same picker, with a line saying how).

8. TESTS
- Emulator `ares-test` (CLAUDE.md recipe): `adb shell cmd package set-home-activity com.dhruv.ares/.HomeActivity`, then Home, the pager, the drawer, search → ask fallback, long-press menus, dock editing, app launch, Home returning to page 0, and `adb shell cmd package set-home-activity` back to the default launcher at the end.
- Mac states: the harness online, then stopped (UNREACHABLE), standby and dormant through the harness's power actions; the home screen stays usable in every state.
- Cards: fake calendar events on the emulator, fake jobs and an approval from the harness; OK/REVIEW/STOP ALL hit the harness, not the real Mac.
- Rotation and process death: home recreates on the right page with no flash; no ANRs with 200+ apps installed (generate fakes if needed).
- Battery and frame time: reactor fps on home, CPU with the screen on and idle, static under Power Saving.
- Build the DEBUG APK for the emulator; for my phone, build the release APK the usual way and ask me before installing. Tell me what to try first.
