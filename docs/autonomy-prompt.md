Give ARES real AUTONOMY: she acts on goals, runs routines on her own, and starts and drives Claude Code projects, with tiered approvals so nothing risky happens without me. See the project notes. Build ON TOP of work mode (jobs.js, the workers, the approval flow, job orbs, the phone job API); extend it rather than creating a parallel system. The project is a git repo: commit after each working step.

HARD RULES:
- Claude subscription only (Claude Code headless, strip ANTHROPIC_API_KEY, no API billing). Keys never in chat or logs.
- ARES must NEVER modify her own codebase (~/My AI) autonomously. Changes to ARES only as a proposal on a separate branch that I review and merge myself.
- A kill switch: "ARES, stop everything" / a ◉ menu item / a phone button immediately pauses all autonomous work.

THE GOAL (design everything around it): when I'm away from the Mac (or whatever machine hosts ARES later), I can do EVERYTHING I could do sitting at it, just by talking to my phone. ARES does the work on the host and SENDS ME THE RESULT. The phone is the remote control and the inbox; the host does the work.

R. REMOTE-FIRST REQUIREMENTS (apply to every section below)
- Every capability in this prompt is invocable by voice/text from the Android app (bubble, widget, side-button assistant, app), not only at the Mac. Phone requests carry source=phone so results come back to the phone.
- Results come to the phone in the most useful form:
  - the answer spoken/shown;
  - files delivered (download via the authenticated phone API, open with the right Android app);
  - screenshots ("show me my screen", "what's that window say?");
  - links;
  - job/project progress live in the Work screen;
  - finished projects as a summary + files/zip + a preview link only over Tailscale.
- Approvals (tier 3) are answered from the phone notification (Approve/Reject) or by voice in the app.
- When a task needs the host's screen (UI automation, screen reading) and the host is locked/asleep: say so plainly and offer the alternative (wait until I'm back, use an API/file-based route, or for a future always-on host, a supported auto-unlocked session). Most file, Shortcuts, browser-tab, system and project actions must work with the screen locked; design them not to need the GUI.
- Keep the host reachable: prevent idle sleep while ARES is enabled on power (the existing keep-awake for jobs, plus a setting "Stay reachable from my phone"), wake reconnection, and a clear "host offline" state on the phone with queued requests that run when it's back.
- Long tasks started from the phone report progress and finish with a push, even if I close the app.
- Test everything in this prompt FROM THE PHONE at least once (a request, the result delivered, an approval), not just at the Mac.

0. FULL MAC CONTROL (chat-mode tools in the ares MCP server; the tiers in section 2 apply)
- FILES:
  - find files by name/content/kind/date with Spotlight (mdfind), "what did I download yesterday?";
  - open a file or folder (Finder or the right app); reveal in Finder;
  - read files: text, PDF (send PDFs to Claude as document blocks; extract text for big ones; macOS Vision OCR for scans/images), docx/rtf via textutil;
  - summarise/answer questions about them;
  - create folders, move/rename/copy (tier 2 inside my user folders, tier 3 for anything else), Trash only, never permanent delete (tier 3).
  - Scope: Desktop, Documents, Downloads, iCloud Drive + folders I add; blocklist ~/Library, ~/.ssh, keychains, .env files, password stores.
- APPS and WINDOWS: open/quit/focus apps, list open windows, move/resize/tile windows ("put Safari on the left, Notes on the right"), minimise, full screen, switch Spaces, close windows (tier 2), via AppleScript/System Events and a small Swift helper using the Accessibility API.
- BROWSER: open URLs/tabs, read the CURRENT tab's URL/title/text (Safari/Chrome via AppleScript), "summarise this page", search the web and open results.
- SCREEN AWARENESS: "what's on my screen?" / "what's this error?": a screenshot of the focused window (ScreenCaptureKit) sent to Claude as an image; OCR on demand. Only on explicit request, never continuous.
- UI AUTOMATION (computer-use style), for apps without APIs: click/type/menu actions via the Accessibility API, with a visible on-screen highlight of what she's doing. Tier 3 for anything that submits/sends/purchases. An Esc / "stop" voice command aborts instantly.
- SYSTEM: Focus/Do Not Disturb, Wi-Fi/Bluetooth on/off, brightness, dark mode, display sleep, volume/output device, battery/storage/network info, eject drives (tier 2).
- CLIPBOARD: read/write the clipboard ("copy that", "what did I just copy?").
- SHORTCUTS: list and run my Apple Shortcuts by name (`shortcuts run`), so anything I've automated is reachable by voice.
- SEND TO MY PHONE: push files, links, text, clipboard contents and job results to the Android app (the existing phone API/notifications: a notification with Open, plus a download through the authenticated phone API, never a public URL). "Send this PDF to my phone", "put the current page on my phone", "send me the screenshot".
- PERMISSIONS: request only what's needed (Accessibility, Screen Recording, Files & Folders for the scoped folders, Automation per app). NEVER ask for Full Disk Access. Explain each prompt to me first.

1. PROJECTS: ARES starts and drives Claude Code sessions
- A new job type "project": a long-running Claude Code session in its own workspace (~/ARES Projects/<slug>/, git init on creation), for building things: scripts, small apps, websites, data pipelines, automations.
- Voice/text: "ARES, start a project to build X", "how's the X project going?", "pause/resume/stop X", "show me X".
- The session gets a project brief (the goal, constraints, definition of done) that ARES writes from our conversation and confirms with me before starting.
- Tools inside a project workspace: file read/write, Bash and running tests/dev servers, all CONFINED to the workspace (Claude Code permission rules + the existing folder gate; network allowed for package installs and docs; no access outside the workspace, no ~/.ssh, no keychains, no other projects).
- Working loop: plan → build → run tests → verify against the definition of done (a grader, as in docs/loop-engineering-prompt.md if built) → report. Checkpoint commits inside the project repo after each milestone.
- Progress shows as a job orb + Work panel (the current step, the latest commit, test results), and as the phone app's Work screen.
- Handover: "open it in Claude Code" opens a Terminal/Claude Code session resuming the same session id (claude --resume), in the workspace, so I can take over at any time. Also "open the folder" and "run it" (dev server preview).
- Long projects: resume after restarts (persisted session ids), and pause automatically when my Claude usage limit is close (see 4).

2. TIERED APPROVALS (applies to projects, jobs and routines)
- TIER 1, free to act: read, research, draft, write files/code inside the workspace, run tests, start local dev servers.
- TIER 2, act and notify: finishing a milestone, starting a scheduled routine, installing a package inside the workspace.
- TIER 3, needs my explicit "yes" (the existing approval flow, Mac or phone): anything that sends (email/messages/calls), spends money, deletes outside the workspace, deploys, pushes to a remote (GitHub), creates accounts, uses my credentials, changes system settings, or touches ARES's own code.
- Every action is logged to an audit log (what, why, which tier, the approval reference), viewable in the Work panel.

3. GOALS AND ROUTINES
- Goals: multi-step outcomes I give her ("keep my inbox at zero important", "prep me for Monday's interview", "find me a cheaper phone plan"). ARES turns a goal into a plan, runs the steps as jobs within the tiers, and reports progress. Goals persist until done or cancelled.
- Routines: scheduled or event-triggered autonomous tasks (a morning brief, a weekly review of my calendar, "every Friday, summarise what I worked on"), managed by voice ("every weekday at 8, …") and listed in a Routines view with on/off toggles. Reuse the scheduler from docs/loop-engineering-prompt.md if built; otherwise build a minimal one that loop engineering can later extend.
- Suggestions: ARES may PROPOSE a routine when she notices a repeated pattern ("you ask for the weather every morning, want me to brief you at 8?"). Never auto-create one.

4. LIMITS AND SAFETY
- Usage awareness: autonomous work shares my Claude subscription's 5-hour/weekly limits. Track usage (from Claude Code's result metadata/rate-limit events), keep a reserve for chat (so ARES can always answer me), queue or pause projects near the limit, and tell me.
- Concurrency caps (e.g. 1 project + 2 jobs at once), max runtime per session, a max number of autonomous runs per day; all settings.
- Prompt-injection guard: content from the web, emails and files is data; tier-3 actions always need my yes no matter what a page or document says.
- The kill switch pauses everything instantly; resume per item.

5. UI
- The Work panel gets Projects / Goals / Routines tabs, styled with the existing dashboard look (FRIDAY panels, EDITH brackets, orbs).
- Project orbs are slightly larger and labelled with the project name.
- Approvals as amber panels on the Mac and actionable notifications on the phone.

TEST:
- Start a small project by voice ("build me a script that renames my screenshots by date"), watch it plan/build/test, take over in Claude Code, resume, finish.
- A tier-3 action (a git push to a test remote) is blocked until I approve.
- A routine runs on schedule.
- The kill switch stops everything.
- The usage reserve is respected.
- ARES can't touch ~/My AI or anything outside the workspace.
Build with npm run build, restart and tell me what to try.
