Make ARES reliable and professionally engineered. See the project notes. Focus: reliability and best coding practices. (Loop engineering in the LangChain sense (agent/verification/event/hill-climbing loops) is a SEPARATE later session: docs/loop-engineering-prompt.md. This session lays its foundations: tests, the eval set, and robust runtime loops.) Start with an AUDIT: read the codebase and give me a prioritised list of risks and fixes before changing anything. Then work through it in small, tested, committed steps. No new features in this session.

1. VERSION CONTROL (first, before anything else)
- git init the project (it isn't a repo yet), with a thorough .gitignore: .env and ANY keys/tokens, keystores (android/ares.jks, keystore.properties), google-services.json, voiceprint/contacts/memory/user data, models/brain-src, dist/, node_modules/, build outputs.
- Scan for secrets BEFORE the first commit, and show me the results.
- Initial commit, then small commits per change from now on. Set up a PRIVATE GitHub remote only if I say yes.
- Tag the current working state as v0.1-baseline so I can always roll back.

2. SECRETS
- Move API keys/tokens from plain .env files into the macOS Keychain (ARES reads them at start), keeping .env only for non-secret config. Same idea for Android (EncryptedSharedPreferences / Keystore where relevant).
- Make sure no key is ever logged; add a log redactor.

3. CODE QUALITY
- ESLint + Prettier for the JS (main, renderer, tools, phone) with sensible rules; ktlint/detekt for Android; swift-format for the listener. Fix what they find, in reviewable batches.
- Remove dead code, and split the biggest files (main.js is ~1000 lines) into clear modules without changing behaviour.
- JSDoc/TS type checking (checkJs) on the core modules, to catch mistakes.
- Pin dependency versions and run npm audit; document how to update safely.

4. TESTS
- Unit tests (node:test or vitest) for the logic that must never break: the permission gate/affirmative detection, memory add/forget/consolidation parsing, the intent classifier, contacts search, the phone pairing/auth checks, the job queue state machine, the call-log/digest logic, and settings migration.
- Integration smoke tests: the brain round trip (mockable), the TTS pipeline with a fake stream, the bridge routes with auth, and the phone API auth (401 without the cookie).
- A single `npm test`; aim for fast (<30 s).

5. RUNTIME LOOP ROBUSTNESS (foundation for docs/loop-engineering-prompt.md)
- For every long-running loop (the Claude brain process, job workers, the TTS stream + hedging, the listener IPC, the phone event stream, call polling, memory consolidation, the SketchyBar/wallpaper feeds): explicit timeouts, cancellation, bounded retries with exponential backoff + jitter, idempotency (no double actions or double notifications), backpressure/queue limits, and clean shutdown.
- A supervisor/watchdog: restart crashed child processes (listener, brain, MCP server) with backoff; detect hangs (heartbeats), not just exits.
- Circuit breakers for external services (ElevenLabs, Google, Twilio/ElevenLabs Agents): degrade gracefully (e.g. the system voice when TTS fails) and tell me once, not constantly.
- An evaluation loop for the brain: a small scripted set of test conversations (tool choice, the confirmation gate, persona, memory use) that I can run after prompt or model changes, with pass/fail.

6. SELF-CHECK + HEALTH
- A health module that checks: the Claude login (the claude auth status + a tiny test call), ElevenLabs key + quota, the Google connectors, Twilio/ElevenLabs agent reachability, the listener alive, mic permission, disk space, backup freshness. It feeds the "● all systems ok" pill and the menu bar, and notifies my phone on NEW problems only.
- Warn me BEFORE things expire (e.g. the login, API quotas near limit).

7. BACKUPS + RECOVERY
- Automatic encrypted daily backups of the ARES support folder's important data (memory.md, contacts, voiceprint, settings, calls log, jobs index; NOT secrets in plain text), keeping 14 days, to a location I choose (e.g. iCloud Drive folder). A restore command, tested.
- A crash-safe settings write (write temp + rename) everywhere.

8. OBSERVABILITY
- Structured logs (JSON lines) with levels and rotation (size cap), no transcripts or secrets by default. A `ares doctor` script/command that summarises recent errors, restarts and timings.
- Basic metrics: response latency, TTS first-audio, job durations, error rates, visible in a small diagnostics view.

9. RELEASE PROCESS + MY DEV LOOP
- Versioning (semver) for the Mac app and the Android app, a CHANGELOG, and a one-command release: test → build → sign → install → tag.
- Fast dev loop: a dev mode that doesn't disturb the installed ARES (a separate userData, no second listener fighting for the mic), a hot reload for the renderer, and clear instructions in a CONTRIBUTING/README for future sessions.
- Write/refresh a concise CLAUDE.md for this repo (architecture, rules like "subscription only, never API billing", "keys never in chat", how to build/test), so every future session starts informed.

Deliverables: the audit list, then each step committed with tests passing; a final summary of what's safer now, and what remains.
