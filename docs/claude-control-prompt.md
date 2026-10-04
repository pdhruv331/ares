Make ARES my remote control for Claude Code: from my phone (or by voice at the Mac) I can check on my Claude sessions and coding jobs, get told when they finish or need me, reply to them, start new ones, and check my usage, all through ARES. See the project notes. Keep it small and safe; commit after each working step.

FIRST, RESEARCH (report to me before building):
- What Claude Code currently offers for this: hooks (Stop, Notification/permission prompts, SubagentStop, SessionStart/End), headless resume (`claude -p --resume <session-id>`), session transcripts under ~/.claude/projects/*/<session>.jsonl, any official Remote Control / mobile continuation feature, and how the Claude desktop app's Code sessions are stored or exposed.
- What's safe: don't inject messages into a session that is open and active in another client (risk of conflicts). Prefer official mechanisms where they exist.

1. SESSION AWARENESS ("what are my Claude sessions doing?")
- List my recent Claude Code sessions (project/folder, title or first prompt, last activity, status: working / waiting for my input / needs permission / finished / errored), from the local transcripts and hook events.
- Summarise a session on request ("how's the ARES wallpaper session going?"): what it did, its current step, anything it's waiting on. Summaries use a tool-less Claude one-shot on my subscription; send only what's needed to the phone.
- Includes ARES's own project jobs (docs/autonomy-prompt.md), clearly labelled.

2. PUSH ME WHEN SOMETHING HAPPENS (Claude Code hooks → ARES)
- Install GLOBAL Claude Code hooks (in my user settings; show me the exact diff and ask before writing) for Stop (a turn finished), Notification (needs input/permission) and errors. The hook posts a small JSON (session id, project, event, last message excerpt) to the ARES localhost bridge with its token. Nothing leaves the Mac except the summary push to my phone.
- ARES pushes to the Android app: "Wallpaper session finished: added desk mode, build passed" / "GUI session needs permission to run npm install", with actions: Open summary · Reply · (where supported) Approve/Deny.
- ARES's own brain/workers run with --setting-sources '' so these hooks never fire for ARES itself (no loops). Verify that.
- Presence-aware: if I'm at the Mac, a quiet on-screen panel instead of a phone push. Quiet hours respected.

3. REPLY / CONTINUE FROM MY PHONE
- For sessions that are NOT open elsewhere (finished/idle CLI or headless sessions, and ARES's own projects): send my message with `claude -p --resume <id>` in the right folder, on my subscription (strip ANTHROPIC_API_KEY), stream the reply back to the phone, and record it in the session.
- Permission prompts in sessions ARES launches go through the ARES approval flow (tiers from docs/autonomy-prompt.md), so I can approve from the phone.
- For sessions open in the Claude desktop app or another live client: don't inject. Tell me, and use the official remote/continue mechanism if one exists (found in the research), or offer to queue my message until the session is idle.
- Voice examples: "tell the GUI session to also fix the subtitle bug", "approve it", "pause the wallpaper job", "start a new session in my portfolio folder to update the projects page".

4. START NEW SESSIONS
- "Start a Claude session in <folder> to <task>": a headless session in that folder (tier rules: folders I've allowed; never ~/My AI unless I explicitly say so, and then on a new git branch), with progress and a finish push. Hand over with "open it in Claude Code" (a resume command / the desktop app).

5. USAGE
- A claude_usage tool: how much of my 5-hour and weekly limits is used and when they reset (exact if Claude Code exposes it, otherwise a labelled estimate). Warn at 80%/95%, and keep a reserve so ARES can always answer me.

SECURITY:
- Transcripts stay local; only short summaries go to my phone (over the existing authenticated channels).
- The hook endpoint is localhost-only with a token.
- Never print keys/secrets from transcripts (redact).
- Tier-3 actions still need my yes.

TEST FROM THE PHONE: list sessions; get a finish push from a real session; reply to an idle session and get the answer; approve a permission prompt for an ARES-launched session; check usage. Build with npm run build, restart, tell me what to try.
