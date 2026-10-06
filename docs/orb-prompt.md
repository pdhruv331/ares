THE CORNER ORB: replace the ARES orb that sits in the ARES dock's centre slot (it floats over other apps' text fields) with a small mini-reactor orb in the BOTTOM-RIGHT CORNER that does real work: click for a portal into ARES, hold to talk, right-click for quick actions, drop files/text on it, and quiet signals for jobs, calls, usage and her speech. See CLAUDE.md (ARES OS theme, live desktop, reactor, ignition) and the project notes. Read theme-dock.js / renderer/theme-dock.* (the current orb: setOrb, orbSlot, the mini Reactor.Engine), theme.js (updateOrb / brainVisible), surface.js (lift/sink), renderer/reactor.js, the subtitle/caption code, jobs.js + autonomy.js (approvals, stopAll), control.js (files, send to phone), claude-usage.js, calls.js (READ ONLY for state), and the ignition/standby code first. Reuse them; no parallel systems. The design was agreed with me through interactive mockups in the planning session; match it. Mac only. Commit after each working step.

HARD RULES
- Never block my work: the orb is small (≈30 pt), sits in the bottom-right corner with a margin, is click-through everywhere except its own circle (and its open menus/cards), never takes focus from my app unless I act on it, and never covers a text cursor (if the focused text field's caret is within ~40 pt of it, it fades to ~15% until the caret moves away).
- Tiers still apply to everything triggered from the orb (control.js / autonomy tiers; tier 3 needs my yes).
- Don't touch the phone line's call paths (calls.js is read-only state here) or voice paths beyond what's listed.
- Performance: idle orb ≈0% CPU (static or a very slow breathe at low fps); animate only on events.

1. PLACEMENT AND VISIBILITY
- Bottom-right corner of the display with the pointer/active window (setting: which corner; default bottom-right). On all Spaces. Hidden in full-screen Spaces by default (setting).
- Shown when ARES is running but her live reactor isn't visible (the desktop is covered: theme.js's existing brainVisible logic); hidden when the desktop reactor is visible or ARES is lifted. Standby: shown dim blue (breathing core); offline: hidden (the ignition helper owns the desktop).
- Remove the old orb from the ARES dock's centre slot (keep the dock itself).
- ◉ → Theme Options: "Corner orb" on/off, corner choice, "hide in full screen".
- No hover card (deliberately). Hover only brightens the orb's glow slightly.

2. CLICK = THE PORTAL
- Click: ARES lifts above my apps with a PORTAL: a circle grows from the orb's centre to the whole screen, revealing the live ARES behind it (a thin bright edge on the growing circle), ~0.6 s ease-in-out. Click the orb again (or ⌥Space / "that's all" / Esc) → the circle closes back into the orb and ARES sinks.
- My app isn't hidden or closed: ARES is lifted over it (surface.js lift) and on return the previously frontmost app gets focus back, cursor and selection untouched.
- ⌥Space summons use the same portal from the orb's position when the orb is showing.

3. HOLD = PUSH-TO-TALK
- Press and hold the orb (>0.35 s): she listens regardless of desk mode/wake word (Voice ID still applies); the orb grows slightly and a waveform ring follows my voice; "listening… release to send" above it. Release → thinking (violet comet arc around the orb) → her answer.
- If the answer needs the screen (panels, files, a long result), the portal opens; otherwise she just speaks with a caption (4).

4. CAPTIONS ABOVE THE ORB
- While she speaks and the desktop is covered, her current line shows in a small caption bubble just above the orb (one line, typed in time with her voice using the existing caption sync; long sentences in clauses), fading out after. Click the orb while she's speaking = stop her (silent barge-in), "Stopped." flashes briefly.
- Respect the existing caption settings; overheard/desk-mode-rejected speech never shows (CLAUDE.md rule).

5. RIGHT-CLICK = QUICK MENU (ARES-styled, EDITH brackets)
- Open ARES · Hold to talk · Standby (the ignition standby) · Stop everything (the autonomy kill switch, red) · Open Work · Mute for 1 hour (no speech or sounds; pushes still reach the phone) · What's on my screen? (the existing screen-awareness tool on the frontmost window; answer as a caption/card).
- Each action confirms with a small card above the orb (e.g. "ALL WORK PAUSED · 2 jobs paused · RESUME").

6. DROP ON THE ORB
- Dragging files from Finder (or any app) toward the orb: it swells and glows as the drag gets close, "drop to hand it to ARES". On drop, four action chips fan out above-left of the orb: SUMMARISE · SEND TO PHONE · START PROJECT · ASK ABOUT IT… (hold-to-talk with the file as context). Clicking outside cancels.
- Dropped text or a URL gets: EXPLAIN · SAVE TO MEMORY · ADD TO TASKS · SEND TO PHONE.
- The work runs through the existing tools (control.js reads/summaries incl. PDFs + OCR, the sendbox to the phone, autonomy start_project with its tier-3 brief, memory, tasks); files stay within control.js's folder scope rules (out-of-scope paths ask first). While working: the violet comet; result: a small card above the orb (title + two lines + an action like OPEN ›), which also goes to COMMS.

7. SIGNALS (the orb tells me things without opening)
- Job progress: a thin violet ring around the orb fills with the main running job's progress (the most recent or a project).
- Needs me: amber outward pulse rings + a small amber badge with the count (approvals waiting, a Claude session waiting for my reply, a failed job). Click → a card with the request and APPROVE/REVIEW (approval through the existing flow).
- Incoming call / new voicemail (state from the call/voicemail modules, read-only): green pulse + a card "INCOMING CALL · <name>"; click → the existing phone-side handling (answer on the phone / play voicemail).
- Claude usage ≥ 80%: amber tint + a one-time card with the reset time; ≥ 95% stronger.
- Thinking: violet comet; speaking: white-hot core + voice waveform; standby: dim blue.
- Signals respect quiet hours / Focus (visual only, no sounds).

8. SOUNDS
- Reuse the ignition sound set where it fits: a soft tick on press, a short portal whoosh (open/close), the push-to-talk start/stop blips, a gentle chime for a result card, the needs-you two-note. Same volume rules (system volume, quiet hours / Focus → silent, ◉ Power sounds On/Off).

9. TESTS (harness first, CLAUDE.md rules)
- The orb shows only when the desktop reactor is hidden; hides on lift; dim in standby; gone when offline.
- Click-through outside its circle (clicks reach the app below), and the caret-proximity fade.
- Portal open/close, focus returns to the previous app; ⌥Space from the orb.
- Push-to-talk end to end (inject speech in the harness), captions above the orb, click-to-stop.
- Right-click actions, including Stop everything (fake runner) and Standby.
- Drop a scratch file (in ~/Downloads, as test-control does) → each chip; drop text and a URL; an out-of-scope file asks first.
- Signals: fake a needs-you approval, a call state, usage 85%/95%, job progress.
- CPU at idle with the orb showing. Build with npm run build, ask me before restarting ARES, and tell me what to try.
