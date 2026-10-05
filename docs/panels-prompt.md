PANELS v2: pinned panels, an expandable calendar, a Google Tasks panel, and a way to add ANY panel. See the project notes and CLAUDE.md. Read renderer/dash.js first (show/reconcile, kinds and colours, magnetic slots, adaptive density FULL/COMPACT/MINI, click for details, grab-to-orb/throw, prefs.panels, icon walls on the live desktop) and dashboard.js (how the calendar is fetched today). Extend that code; no parallel panel system. Panels must work the same in the app window, on the live desktop and when lifted. Commit after each working step.

HARD RULES:
- Claude subscription only; no new paid services. Keys/tokens never in chat, logs or git.
- Calendar and task CHANGES (add/move/delete) still need my "yes" as today (tier 3 for deletes, tier 2 for adds/moves, per control.js).
- Keep the design quiet: FRIDAY content, EDITH brackets, the existing palette (cyan = day, violet = work/focus, amber = needs me). No new loud styles.
- Don't touch the phone line or voice paths (CLAUDE.md).

SCOPE: the Mac only (app window, live desktop, lifted). NOT the phone app; don't change android/ or the phone API in this build.

0. EVERYTHING IS DYNAMIC (applies to every panel, built-in, pinned or custom)
- Any panel can change size at any time: the calendar switching views or a busy day picked in Month, a details view opening/closing, a tasks list growing or shrinking, a custom panel's content changing, a panel appearing or disappearing, density changing.
- When a panel grows, its neighbours (in its column, and beside it if it widens) MOVE smoothly to make room; when it shrinks or closes, they move back. Animated (~0.45 s ease-out), no jumps, no flicker.
- If space runs out: the least important panels (contextual before pinned, oldest first) step down a density (full → compact → mini) or move to the nearest free magnetic slot; they step back up when space returns.
- Never overlap, never go off-screen, never cover desktop icons (the icon walls still apply); the brain shifts aside if needed, as panels already make it.
- A panel I'm holding/dragging or have just placed keeps its place; the others flow around it.
- Build this as ONE layout pass in dash.js (measure → solve slots → animate), driven by a ResizeObserver on every panel, so new panel types get it for free.

1. PINNED PANELS
- Any panel kind can be pinned ("pin my calendar", or a pin in the panel's details view). Pinned panels always show and keep their slot; contextual panels (NEXT, TIMER, WORK, CALL, …) keep coming and going around them.
- Up to 3 pinned panels (a setting). In MINI density pinned panels shrink to their compact form; they never disappear.
- Pins and positions persist (prefs.panels), separately for the app window and the desktop, as positions already are.
- Throwing a pinned panel into the brain unpins and closes it (say so in a one-line subtitle: "Calendar unpinned").

2. THE EXPANDABLE CALENDAR (pinned by default once built)
- Mockup agreed with me (in the planning session): one panel with three views, switched by small TEXT TABS in the header (DAY · WEEK · MONTH: plain text, the active one cyan with a thin underline, the others dim, brighter on hover; NOT boxed buttons). The tabs must fit inside the header in the smallest (Day) view.
  - DAY (default, ~250 px wide): today's events (time, a colour bar by kind, title; important ones amber), a red NOW line between past and upcoming, then "REST OF THE WEEK": a strip of the remaining days with an event count each (amber if a day has something important).
  - WEEK (~372 px): Mon–Sun columns, 8:00–20:00 (extend the range automatically if an event falls outside), today's column highlighted, the NOW line, event blocks coloured by kind. Scroll for next/previous week; it snaps back to this week after a minute.
  - MONTH (~300 px): a compact grid (small day squares with the date and up to 3 tiny coloured dots), today highlighted, click a day → that day's agenda appears below the grid.
  - The panel sizes itself to its content in every view (nothing cut off, including a busy day picked in Month). The change of size animates smoothly (~0.45 s ease-out) with the content cross-fading.
- Layout reflow applies here as everywhere (see section 0): growing into Week/Month pushes its neighbours away, and they come back when it collapses.
- Collapse back to DAY after ~60 s without interaction (a setting), or when I say "collapse it" / throw it into the brain.
- Click an event → the existing details view: time, place, notes, the meeting link, actions JOIN (opens the link), PREP ME (a short brief from my notes/email), MOVE (asks me when).
- Voice: "show me my week", "show the month", "what's on the 20th?" (opens Month with the 20th selected), "what about next week?", "move the dentist to Friday at 4", "block 2 hours of deep work tomorrow afternoon".

3. CALENDAR DATA: LOCAL, LIVE, FREE
- Read events through EventKit (a small Swift helper or an extension of an existing one, e.g. native/AresControl.swift), not through a Claude call on a timer. My Google Calendar is (or will be) added to macOS Calendar; check that first and walk me through adding it if it isn't (System Settings → Internet Accounts → Google → Calendars).
- LIVE UPDATES: subscribe to EKEventStoreChanged and refresh the panel immediately whenever events change, whether I change them in ARES, in Calendar.app, on my phone or on the web. Changes made elsewhere arrive when macOS syncs with Google (usually within a few minutes; ask Calendar to refresh when I open the panel or say "refresh my calendar"). Changes made THROUGH ARES must show instantly.
- WRITES: add/move/delete through EventKit too (instant, local, free), with the approval tiers. Keep the Google Calendar connector as the fallback for anything EventKit can't do, and for when the calendar isn't in macOS Calendar.
- NEXT and LEAVE BY switch to the same EventKit data (faster, no Claude usage). Remove the timed Claude calendar refresh once EventKit works; keep the connector code path as the fallback.
- Permission: Calendars (full access) for ARES; explain the prompt to me first.

4. GOOGLE TASKS PANEL
- Open tasks from my default list (a setting for which lists), with checkboxes. Click a checkbox → completes it (with a small strike-through animation; undo for 5 s). Overdue tasks amber, due-today first. Compact form: the count + the top task.
- Voice: "add buy milk to my tasks", "what's on my list?", "tick off book flights", "move X to tomorrow".
- Data: the Google Tasks API directly (no Claude connector exists). Walk me through the one-time setup: a Google Cloud project, the Tasks API enabled, an OAuth client of type "Desktop app", sign-in in my browser (loopback redirect, PKCE). Store the refresh token in the macOS Keychain (not in files, not in .env, never logged). Poll every ~2 min while the panel shows, and refresh right after any change ARES makes.
- If I'd rather not do the Google setup, offer Apple Reminders (EventKit, local, no setup) as the alternative source for the same panel.

5. CUSTOM PANELS ("add any panel")
- A panel is a declarative SPEC (JSON in <support>/panels/<id>.json), not code: { id, title, kind (colour), template, source, refresh, pinned, size }.
- TEMPLATES: value (+ optional gauge), list, checklist, text/markdown, image, mini chart (sparkline/bars), countdown. All drawn by ARES's own renderer in the existing style. No arbitrary HTML/JS from a spec.
- SOURCES:
  - built-in providers (calendar, tasks, weather, jobs, projects, Claude usage, now playing);
  - an Apple Shortcut (`shortcuts run`, output parsed as text/JSON);
  - a shell command from an allowlist I approve per command (tier 3 the first time);
  - a JSON or RSS URL (GET only, no credentials; through egress.js if it applies);
  - a local file (within the control.js folder scope);
  - "ask Claude" (a tool-less one-shot on my subscription): refresh no faster than every 30 min, respects the usage reserve, and pauses near my limits.
- CREATING: by voice or text ("add a panel showing my open GitHub PRs", "a countdown to my flight on the 30th", "show the BTC price every 10 minutes"). ARES writes the spec, shows a PREVIEW panel (dashed brackets) with real data, and saves it when I say yes. "Edit the X panel …", "remove the X panel". A details view lists the custom panels with on/off and pin.
- Safety: specs are data; a source can't run anything I haven't approved; failures show a quiet "—" with the reason in the details view, never a crash.

6. LOOKS (agreed with me from mockups in the planning session)
- Tasks, full: "TASKS · <list>" header with the open count; rows with a small square checkbox, the title, the due label on the right (LATE in amber, TODAY, a weekday or date); late tasks first in amber, then today, then dated, then the rest; ticking strikes the row through and shows "✓ <task> · UNDO" for 5 s; a dashed last line hinting the voice command. Compact: the open count, "N LATE" in amber, the most urgent task.
- Custom panels use the same EDITH brackets, coloured by kind (cyan day, violet work, amber time-critical). Templates as in the mockups: countdown (big numbers + a thin progress bar), list (rows with a status word/colour), chart (value + change + sparkline), gauge (a ring + value + one line).
- Creating: a PREVIEW panel with DASHED brackets and real data, with KEEP / KEEP + PIN / EDIT / DISCARD (and the same by voice). Nothing is saved until I choose.

7. TESTING
- Harness only (CLAUDE.md), with a fake EventKit source and a fake Tasks API for automated tests; the real ones only on my Mac with my go.
- Test: tabs fit in the Day header; each view sizes to content; reflow with every kind of size change (calendar views, details open/close, tasks added/ticked, a custom panel's content growing, panels appearing/closing): neighbours move smoothly and never overlap or go off-screen (also with the desktop's icon walls), and come back when space returns; MINI density; collapse after a minute; an event added in Calendar.app appears in the panel within seconds; an event added by voice appears instantly; tasks tick/undo/add; a custom panel from each source type; the preview → yes → saved flow; the usage limits on "ask Claude" panels; nothing changed in android/ or the phone API.
- Build with npm run build, ask me before restarting ARES, and tell me what to try.
