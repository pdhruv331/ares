Build WORK MODE phase 2 for ARES: rich results, worker tools, real files. The full spec is docs/work-mode-prompt.md (sections 2–4), and the project notes in memory cover phase 1's state. Read jobs.js, tools/work.js, renderer/work.js, renderer/markdown.js and the work section of main.js before changing anything.

HARD RULES (unchanged): Claude subscription only (no API billing, strip ANTHROPIC_API_KEY). Free tools only; check each one's current free tier before relying on it. Keys go in the ARES support-folder .env and never appear in chat. Never send my email address or personal data to unrelated services. Chat mode must stay exactly as fast: new tools load ONLY in workers (per-job MCP config and flags in jobs.js), never in claude.js.

WHERE PHASE 1 LEFT OFF
- Working: queue, Opus workers with --resume follow-ups, folder-confined gate (realpath + case-insensitive), approvals with long-polling, presence-aware notify, basic WORK panel, and a hand-written safe markdown renderer.
- Never tested live: a real worker (not a simulation) waiting on my approval, and Voice ID refusing a job by voice. Test both early in this phase.

1. WORKER TOOLS (jobs.js per-job MCP config / flags)
- Playwright MCP (Microsoft, @playwright/mcp): real browsing, screenshots saved into the job folder (use its output-dir option, so the files land inside the gate's allowed folder). Check that it can't be used to read local files (file:// URLs) or reach localhost/the ARES bridge; block those.
- Jina Reader (https://r.jina.ai/<url>, no key) for clean page text, via WebFetch or a tiny tool in tools/work.js. Firecrawl as an optional upgrade only when FIRECRAWL_API_KEY is in the support .env.
- Unsplash: search_images/download_image tool in tools/work.js using UNSPLASH_ACCESS_KEY. Save images into the job folder, trigger the download endpoint as the API guidelines require, and record the photographer name + profile link for attribution. Walk me through getting a free access key step by step. The tool is simply absent without a key.
- Document skills (docx, pdf, pptx, xlsx) and the dataviz skill, so workers produce real files and polished charts. Workers run with --setting-sources '', so skills don't load by default. Work out the cleanest way to give workers just these skills (e.g. a bundled skills folder / plugin dir passed only to workers), and what they need (python libs, LibreOffice?). If that means allowing Bash: keep Bash gated. A short allowlist of known-safe commands (python3 on scripts inside the job folder, the converters the skills use) runs inside the job folder; anything else goes to me for a "yes" through the existing approval flow, and nothing can touch files outside the folder. Install only free/open-source dependencies and tell me what you installed.
- Mermaid: workers write ```mermaid blocks in result.md (rendered by the panel).
- Charts: workers write a ```chart block containing a Chart.js JSON config (document the exact format in WORKER_PROMPT), following the dataviz skill's palette and rules.
- Keep the tool registry in one place so Notion MCP and Exa can be added later with a config line and a key.
- Update WORKER_PROMPT: which tools exist, when to use Jina vs Playwright, where to save files, how to embed images/charts/diagrams/mini-apps in result.md, and Unsplash attribution.

2. RICH RESULTS PANEL (Electron renderer)
- Bundle every library locally from node_modules (no CDN): Chart.js, Mermaid, a syntax highlighter, and consider replacing markdown.js with marked + DOMPurify if it's safer and more complete. Keep the renderer CSP strict; widen it only as far as needed.
- Render: markdown (headings, tables, quotes, task lists), images from the job folder (screenshots, Unsplash with attribution captions, shared photos), interactive Chart.js charts, Mermaid diagrams, highlighted code, and clickable source chips (favicon/title where cheap).
- Serve job-folder files to the renderer safely: a custom protocol (e.g. ares-job://<id>/<file>) that only serves files inside that job's folder (same realpath check as the gate), never arbitrary paths.
- File previews: PDF inline; docx/pptx/xlsx as a preview (e.g. a PDF or image converted in the worker or main process, or a light HTML render), plus Open in app.
- Worker-built mini-apps (an html file the worker writes, marked in result.md): render live in a sandboxed iframe with NO network (CSP connect-src 'none', no same-origin, no access to window.ares or the app), with a fullscreen toggle.
- Actions bar: Save as PDF (printToPDF of the rendered result into the job folder, then reveal it), Open in app, Make slides (continue_job with a slides instruction), Continue job (a text box that sends a follow-up; this needs the owner, which it is since the panel is a click at the Mac). Send to phone is phase 5: show it disabled or leave it out.
- Keep the look consistent with the current HUD panel, and check it's readable at the default window size and in fullscreen.

3. TEST (in the real app: npm run build, then drive it over CDP with --remote-debugging-port as in phase 1)
- A research job that uses Jina + Playwright screenshots + an Unsplash image (if I've added a key) + a chart + a Mermaid diagram, all rendering correctly in the panel.
- A job that produces a .docx, a .pptx and an .xlsx, with previews, Open in app, and Save as PDF working.
- A mini-app job whose iframe demonstrably can't fetch the network or reach window.ares.
- A real approval hold (e.g. a Gmail send to my own address as a draft→send, or a gated Bash command), answered from the panel.
- The gate still blocks reads/writes outside the job folder, including via Playwright and Bash.
- Chat stays as fast as before: compare 'timing brain' in ares.log before and after.

Before starting, estimate the token cost of this phase and whether to split it (e.g. 2a tools, 2b rendering). Update the project notes in memory when done.
