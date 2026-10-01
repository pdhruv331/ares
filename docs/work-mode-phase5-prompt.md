Build WORK MODE phase 5 for ARES: the phone. The full spec is docs/work-mode-prompt.md (section 6, plus the phone parts of sections 2, 4 and 5), and the project notes in memory cover phases 1–4. Before changing anything, read phone.js, phone/ (index.html, phone.js, sw.js, manifest), the Work section of main.js (notifyJob, workControls, the job IPC), jobs.js, work-files.js, renderer/work.js, renderer/brain3d.mjs (the JobOrbs section), and the Android app in android/ (MainActivity, AskActivity, AresService, Updater, build.sh).

HARD RULES (unchanged): Claude subscription only (no API billing; strip ANTHROPIC_API_KEY). Free tools only. Keys go in the ARES support-folder .env and never appear in chat. Never send my email address or personal data to unrelated services. Chat mode must stay exactly as fast. Jobs still run on the Mac; the phone is only the remote control. The phone server stays reachable only over Tailscale (tailscale serve → 127.0.0.1:8765), and every new endpoint needs the paired-device auth that /api/ask already uses (cookie token for the web app, device key for the Android app).

WHERE PHASE 4 LEFT OFF
- Mac: queue, Opus workers, follow-ups with versions (.versions/N.md), gallery + full-text search (jobs.gallery / jobs.search), drag-drop inputs (jobs.attach → inputs/), voice control of the panel (Work.command), orbs + expand animation, DISMISS (sink) and DELETE (to the Trash), show_job brain tool.
- Phone today: the web app and the Android app can chat, get Web Push / native notifications with buttons, Share-to-ARES, and approve a job via a notification button that asks the brain "Yes, approve…". There is no job UI on the phone yet; "Send to phone" on the Mac is a disabled button, and "send this to my phone" by voice says it's coming.
- Not yet tested live: real mouse drag-drop from Finder, and voice commands spoken aloud (only typed).

1. PHONE JOB API (phone.js, authenticated, Mac stays the source of truth)
- GET /api/jobs (list + gallery cards), GET /api/jobs/:id (detail: job, result markdown, files, versions, sources, credits), GET /api/jobs/:id/file/<path> (the same realpath check as work-files.js resolveJobFile, never hidden files, office previews from .preview/), and a jobs stream on the existing /api/events (job change/event) so the phone updates live.
- POST start (text + optional attachments: shared links, PDFs, images, screenshots → jobs.attach), continue (follow-up), answer (yes/no for an approval), cancel, dismiss, seen. Delete stays Mac-only. Starting or continuing a job from a paired phone counts as the owner (it's a paired device), the same as the phone's chat does today; approvals still need an explicit yes.
- "Opening it on one device marks it seen on the other": seen syncs both ways, and a job opened on the phone clears the Mac's attention badge (and the reverse clears the phone's notification by its tag).

2. PRESENCE-AWARE NOTIFICATIONS, FINISHED
- Job done while I'm away: the push has Open (opens the result on the phone) and Send to Mac (opens the panel on the Mac next time I'm there, or right away if the window is up). Needs your OK: Yes / No buttons that answer the job directly through the API (not through a brain turn), with the Voice ID-free rule that the tap itself is the confirmation.
- "Send to phone" on the Mac (panel button + "send this to my phone" voice command + a send_job_to_phone brain tool): pushes the job to the phone with Open.

3. PHONE WEB APP (phone/)
- Work tab/sheet: list + search + gallery cards, a job detail view rendered for mobile (markdown, tables, images, charts, mermaid, source chips, file cards with previews/downloads, mini-apps in a sandboxed iframe with no network, as on the Mac). Bundle the same libraries locally (no CDN), and keep the CSP strict.
- Orbs on the phone's 3D brain, same colours and behaviour as the Mac (reuse the JobOrbs code; tap an orb → the detail view expands from it, reduce-motion = fade).
- Start a job by voice or text ("do this as a job"), follow-ups from the detail view (a Continue box and Make slides), Yes/No on approvals, Cancel, Dismiss.
- Share to ARES (the existing share_target): offer "Ask" (chat, as now) or "Make it a job" with the shared link/file/screenshot attached.

4. ANDROID APP (android/)
- A Work screen in MainActivity (list, progress, detail as a WebView of the same mobile renderer served by the Mac, locked to the Mac origin, with no JS bridge beyond what's needed), orb status in the widget/bubble/notification (e.g. "2 jobs working · 1 needs your OK"), native notification actions: Open / Send to Mac / Yes / No.
- Start jobs from the app, bubble, widget, side-button assistant and the Share sheet ("Make it a job"), including the screen context and shared files.
- Ship via build.sh (OTA update). Remember Samsung Auto Blocker is on: the user switches it off briefly per update.

5. TEST
- Phone harness first (dev PhoneServer on ARES_PHONE_PORT=8799 with ARES_TEST_PAIR_CODE, as in earlier phases), then the real app with npm run build: start a job from the web app and from the Android emulator; watch progress and orbs live; open the result on the phone and confirm the Mac marks it seen; a real approval answered from a notification button; Send to phone from the Mac; Send to Mac from the phone; Share-to-ARES of a PDF and a link as jobs.
- Security: an unpaired client gets nothing from every new endpoint; file paths can't escape the job folder (../, symlinks, hidden files); mini-apps on the phone can't reach the network or the page.
- Chat stays as fast: compare 'timing brain' in ares.log before and after.
- Also test the two phase-4 leftovers on the Mac if I'm around: a real Finder drag-drop, and voice commands spoken aloud.

Before starting, estimate the token cost of this phase and whether to split it (e.g. 5a API + web app, 5b Android). Update the project notes in memory when done.
