THE ARES LAUNCHER, ROUND 2: what was picked from the interactive mockups on 2026-10-08 (docs/launcher-prompt.md is round 1, built
and installed). Same rules as round 1: a launcher first, nothing waits for the Mac, reuse ReactorView / SchematicView / Session /
JobStore / PowerStore, battery measured, emulator tests with a fake phone server, commit after each working step.

1. CAPTIONS: the home screen's caption under the reactor becomes very subtle: smaller (12sp), muted colour, lower opacity, no glow.

2. COLOUR SCHEMES: Arc reactor (cyan, default), Mark III (gold), Hulkbuster (red), Stealth (pale steel), War Machine (gunmetal),
   and "Follow the time of day" (night blue → dawn amber → day cyan → evening orange → violet). One `Scheme` colour used by the reactor,
   the schematic, the themed icons, the hint, the readouts and the cards. Chosen from the home long-press menu. The power states keep
   their FIXED colours: standby blue, powered down gold, asleep grey (decided: fixed, not derived from the scheme).

3. POWER FROM HOME: the long-press menu has Standby, Wake and Power down (Power down through the same slide-to-confirm sheet as the
   app). The transitions are ReactorView's existing ones (wind-down, spin-down to the cold still, the charge on wake).

4. READOUTS OPEN IN PLACE: two callouts under the reactor, NEXT (left) and SERVER (right; replaces CLAUDE). SERVER's value is the
   Mac's state and jobs ("ONLINE · 2 JOBS"). Tapping a readout grows a card out of it, in place: NEXT = the next three events;
   SERVER = status (state, battery, power), jobs (running, needing OK) and Claude (5H, week). Tap elsewhere to fold it back.

5. NOTIFICATIONS (needs Notification access, asked once with an explanation; nothing leaves the phone except "Summarise"):
   - A new notification arrives as a spark from the top of the screen into the core (core flashes), with a one-line note.
   - Notifications gather as orbs on an arc above the reactor (app icon, themed; amber when a person is waiting: messages).
     Tap = a card (app, title, text) with REPLY BY VOICE (if the notification has a reply action; the words are shown before sending),
     OPEN and DISMISS. DRAG AN ORB INTO THE CORE to dismiss it (the core ring lights up as it gets close); let go elsewhere = it floats back.
     SUMMARISE (when there are 2+) asks ARES to sum them up (the only path that sends them to the Mac).
   - An incoming call (a CATEGORY_CALL notification): the rings turn green and pulse outward, "INCOMING · <name>", ANSWER / DECLINE
     fire the call notification's own actions.

6. MODES: morning (first look after 5 am: a GOOD MORNING card with today's events and jobs finished overnight, until tapped or noon),
   meeting soon (an event within 15 min: an amber countdown ring, "STANDUP · IN 9 MIN", JOIN if the event has a meeting link, else OPEN),
   night (22:30–06:00: dim blue, big dim clock, the next alarm and hours of sleep, the reactor almost still, the dock dimmed),
   at the Mac (the Mac reports you active in the last 2 minutes and unlocked: a dashed link from the reactor to the Mac,
   "LINKED TO THE MAC"). The Mac adds `idle` (seconds) and `locked` to /api/status.

7. BUDS: when Bluetooth earbuds connect (AudioDeviceCallback, no permission), an earpiece ring appears around the reactor with
   "BUDS · CONNECTED" and the hint "HOLD A BUD · TALK". An assistant summon (Bud hold, side key) while the home screen is in front
   listens on the home screen's own session instead of opening the floating panel.

8. REARRANGE EVERYTHING: the dock (hold, drag sideways, the others slide; hold without moving = the menu), the app drawer (hold and drag
   in a grid; switches the drawer from A–Z to YOUR ORDER, with an A–Z chip to go back; new apps join at the end), and the home cards
   (hold a card's header, drag up or down). All orders are saved.
