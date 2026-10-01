Build the ARES GUI update (Mac app, renderer/). This is the FINAL design, agreed with interactive mockups in chat. Keep everything that exists working (work panel, job orbs, chat log, input, voice). The C1 starfield is ALREADY DONE (renderer/stars.js, the grid was removed; Stars.setState is hooked in app.js); keep it.

1. HALO + PEDESTAL around the 3D brain (replace the old HUD rings in neural.js; keep a fallback for the 2D mode)
- R2 voice halo: 3 layered wavy rings at slightly different speeds, cyan (62,230,255), with a glow on the main ring.
  - IDLE: slow breathing (radius swells and relaxes), faint shimmer, layers drift apart and back.
  - LISTENING: ripples flow INWARD, driven by the REAL mic level; the halo brightens.
  - THINKING: colour eases to violet (#a78bfa) and a bright comet with a fading tail races around the ring.
  - SPEAKING: waves push OUTWARD, driven by the REAL level of her voice (analyser on the playback), with sparks flying off the loudest peaks.
  - Extras: a short bright pulse on wake word; an amber tint while a job or call needs my "yes".
  - Colours ease between states, never snap.
- R4 hologram pedestal: a glowing elliptical disc under the brain, with rings pulsing outward across it. It glows brighter while she speaks.

2. DASHBOARD (replace the System and Integrations side panels)
- TOP BAR:
  - "ARES" and a greeting line that changes through the day ("Evening, Dhruv").
  - Clock.
  - ONE-LINE weather only ("14° · RAIN"), from a free, no-key source (e.g. Open-Meteo) and the Mac's location or a set city.
  - A small status indicator ("● all systems ok"). It turns amber with a short reason when something breaks (Claude login expired, key revoked, integration down). Click it to expand the full integrations and system stats list (the old panels' data lives here now).
- LEFT, "your day": NEXT (the next calendar event, a countdown like "GYM · T-36"), TIMER(s), and a leave-by panel for events with a location (only when relevant).
- RIGHT, "what ARES is doing", each panel appearing only when relevant:
  - WORK (violet, the current job + step + %).
  - CALL (green, live while the phone agent is on a call, then a summary).
  - NOW PLAYING.
  - REMEMBERED (a memory flash that leaves after ~5 s).
  - INBOX (only when something important needs me; amber).
- BOTTOM: a thought ticker (one line of what she's doing: "checking your calendar…"), and a thin activity-pulse line that blips at each event.
- The dashboard stays calm when little is happening.

3. PANEL DESIGN: FRIDAY content + EDITH brackets
- NO box, outline, background or leader lines. The frame is ONLY four thin corner brackets (EDITH targeting style), ~1.2px, in the panel's colour at ~85% opacity.
- FRIDAY content, in a grid with a reserved right column for the mini gauge (text can never overlap the gauge; long text ellipsizes):
  - a tiny letter-spaced header row (label left, a number tag or value right, e.g. "NEXT · 01", "WORK · 57%");
  - one crisp value (~15px, e.g. "GYM · T-36", "06:12", "LUIGI'S");
  - a small detail line ("18:00 → 19:00", "READING SOURCES 4/7").
- Mini gauge column (~38px): a half-arc for time and progress (event countdown, timer remaining, job %), and live equaliser bars for a call.
- Colour by kind: cyan = my day, violet = work, green = calls, amber = needs me. Panel width ~214px, so nothing clips.

4. APPEAR / DISAPPEAR ANIMATIONS (exactly as approved)
- HOLOGRAM MATERIALIZE, for info about my day:
  - Enter: the corner brackets flicker on (0 → 1 → 0.25 → 1); a bright 1.5px scan line in the panel colour sweeps top to bottom with a glow and a few sparks at the leading edge, revealing the content behind it; the text "decodes" from scrambled glyphs into the real words (~0.5 s); a soft brightness flash.
  - Exit: squeeze into a bright horizontal line (brightness up) and blink out.
- LAUNCH FROM BRAIN, for things ARES creates (job results, call summaries, memory flashes):
  - Enter: a bright spark leaves the brain trailing a fading beam in the panel colour plus a particle stream to the panel's spot; a shockwave ring; the panel unfolds from a point to a thin horizontal line to full size with a slight overshoot; the text decodes; a brightness flash.
  - Exit: fold to a line, then a spark flies back into the brain.
- Draw beams, scans, sparks and rings on one overlay canvas.
- Respect Reduce Motion (simple fades).

5. THROWABLE PANELS (physics, exactly as approved)
- GRAB a panel → it immediately folds (line, then point) into a small glowing ORB (radius ~11px) with a ring burst. The orb shows a tiny label in its colour ("GYM", "WORK", "CALL") and follows the cursor while held. It is deliberately smaller, brighter and labelled, so it can't be confused with the job orbs.
- RELEASE → the orb is thrown with the release velocity (measured from recent pointer moves).
- Calm physics:
  - throw factor ~0.55 of hand speed, max speed ~9 px/frame;
  - friction ~0.965 per frame;
  - wall and panel bounce restitution ~0.6;
  - orbs bounce off other resting panels (circle vs rect), which flash briefly;
  - a short fading comet trail.
- When the orb slows below ~0.35 px/frame, it UNFOLDS back into the full panel where it stopped (unfold animation + ring burst + decode), clamped inside the window.
- THROW INTO THE BRAIN = CLOSE:
  - Carrying an orb near the brain brightens the brain and shows "RELEASE TO CLOSE" above it.
  - An orb that flies into the brain (within ~58px of centre), or is dragged deep into its centre, is sucked in on a short spiral; the brain pulses (halo energy spike) and a ring ripples out. That panel is dismissed (it can come back when relevant again).
- Resting panels that overlap push gently apart. Panels remember where I left them (persist positions per panel id in settings). A "tidy up" voice command, or a double-click on empty space, sends every panel gliding back home. Panels never settle on top of the brain (nudge them away).

5a. CLICK FOR DETAILS (vs grab to throw)
- Pointer down does NOT immediately become an orb. If the pointer moves more than ~5px (or is held ~250ms and moved), it becomes the orb (section 5). A click (press + release without moving) opens DETAILS instead.
- Details: the panel UNFOLDS IN PLACE into a larger detail card (the launch-unfold animation, the brackets widening); click outside or Esc folds it back. One open at a time.
- Per panel:
  - NEXT = time, location, attendees, notes + Directions / Join / Remind me later.
  - TIMER = remaining + started at + Pause / +5 min / Cancel.
  - LEAVE BY = travel time + route + Open in Maps / "text them I'm late".
  - WORK = current step, recent progress, sources + Open in Work panel / Cancel.
  - CALL = live transcript (summary after) + Call back / Text back / Open transcript.
  - NOW PLAYING = track, album, up next + Play/Pause / Skip / Open app.
  - REMEMBERED = the full memory entry + Edit / Forget.
  - INBOX = a short summary per important email + Open in Gmail / Draft a reply.
  - Status pill = every integration + system stat + fix links (e.g. "log in again").
- Sending/changing actions still go through the existing "yes" confirmation gate; "Draft a reply" only drafts.

5c. SUBTITLES + COMMS (replace the scrolling chat log at the bottom)
- CINEMATIC SUBTITLES:
  - While I speak, my words appear as one dim quoted line near the bottom centre, then fade.
  - Her reply appears as one centred subtitle line, with each word lighting up in sync with her actual voice playback (use the audio timing/alignment of the TTS clip; approximate by speech rate if alignment isn't available).
  - Long replies roll sentence by sentence; the line fades ~2 s after she finishes. No scrolling wall of text.
  - The typing box stays available but hidden until I start typing or click the input area.
- COMMS (the conversation history drawer):
  - Bottom centre, growing UP from the subtitle line (the current subtitle becomes the last line), limited to the centre column between the left and right panel columns so it never covers panels. The brain dims slightly and lifts up to make room, then settles back.
  - Open: ⌃C, clicking the subtitle, a small "COMMS ▴" tab under the subtitles (the only thing visible when closed), or saying "show comms" / "what did you just say?".
  - Close: Esc, clicking outside, or ~20 s idle.
  - Inside: my lines dim and small, hers bright, in FRIDAY text with EDITH corner brackets, timestamps on hover, scrolling back through today (the existing shared conversation history, including phone/Telegram turns, marked by source).
  - It opens with the launch-unfold animation.

5b. MAGNETIC SLOTS (invisible)
- ARES keeps a set of invisible home slots: neat columns down the left and right edges (plus corners), spaced so panels align and never overlap. Slots adapt to window size and full-screen mode.
- The slots are NEVER drawn: no outlines, highlights or guide lines, not even while an orb is held. Docking is felt, not shown.
- When a thrown orb slows down (speed below ~2.4 px/frame) within ~80px of a FREE slot, a spring pulls it in (it glides smoothly into place), then it unfolds exactly aligned to the slot. Stopping far from any slot = free placement where it lands. Occupied slots are never targeted. Panels landing next to each other also align edges.
- New panels (materialized or launched from the brain) go into the next free slot on their side (my day = left, ARES activity = right).
- ADAPTIVE DENSITY: when there are more panels than slots, the grid grows (more rows, then an extra column per side) and ALL panels smoothly resize to a smaller, less detailed tier to fit (animated, never a jump):
  - FULL (~214×62): header row + value + detail line + gauge column.
  - COMPACT (~170×44): header row + value; the gauge shrinks to a thin progress underline; no detail line.
  - MINI (~130×26): one line, "LABEL · value" (e.g. "GYM · T-36"), with a tiny coloured dot or progress underline.
  When panels close and space frees up, they grow back to the richer tier. Grabbing a mini panel still becomes the same orb; it unfolds at whatever tier the grid currently uses.
- Setting: magnetic slots on/off.

6. PERFORMANCE: pause all animation when the window is hidden, cap at 60 fps, lower on battery, and keep CPU/GPU light.

Build it, run npm run build, restart ARES and verify in the real app. Tell me what to look at, then offer tuning (colours, speeds, physics constants, which panels).

AFTER THIS (a separate step): ARES as a live desktop wallpaper (a desktop-level, click-through window on all Spaces, pausing when covered or on battery), an ARES screen saver (web-view screen saver), and a matching still image for the lock screen.
