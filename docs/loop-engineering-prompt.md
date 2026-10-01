Apply LOOP ENGINEERING to ARES, in the sense of LangChain's "The Art of Loop Engineering" (https://www.langchain.com/blog/the-art-of-loop-engineering): stack feedback loops around the agent so it both does the work and keeps improving, with a human (me) at the key checkpoints. Do this AFTER the reliability session (docs/reliability-prompt.md: git, tests and the eval set must exist first). See the project notes.

HARD RULES:
- Claude subscription only (Claude Code headless, strip ANTHROPIC_API_KEY, no API billing, no paid tracing SaaS). Traces stay LOCAL in the ARES support folder, with no secrets and sensitive text redacted where not needed, and rotation.
- ARES NEVER changes her own prompts/tools/graders without my explicit approval.

LOOP 1: AGENT LOOP (exists: the chat brain in claude.js, and the work-mode workers in jobs.js)
- Keep it. Add structured TRACES for every turn and job: input (redacted as needed), tools called + results summary, timings, errors, retries, the final output, and user reactions (a barge-in, "no I meant…", a thumbs up/down in the UI, "that's wrong"). JSONL, local, rotated. This powers loops 2 and 4.

LOOP 2: VERIFICATION LOOP (grade outputs before they reach me; retry with feedback)
- A grader module: deterministic checks first, then an LLM judge (a tool-less Claude one-shot on the subscription) with a clear RUBRIC per output type:
  - JOB RESULTS: the request actually answered, claims sourced, requested files exist and open, no hallucinated data, and the format is as asked.
  - CALL OUTCOMES: did the transcript actually confirm the goal (booking, time, name)? If not, say so clearly ("they didn't confirm, want me to call back?").
  - MEMORY CONSOLIDATION: no sensitive data (passwords, codes, card numbers), no dropped still-true facts, no duplicates, third person.
  - SPOKEN REPLIES (cheap, deterministic only): no markdown/URLs/lists, length suited to the question, and the persona respected.
- On failure: retry up to 2 times with the grader's feedback appended; then deliver with an honest note of what couldn't be verified. Log the grades to the traces.
- Keep the latency budget: never grade simple chat with an LLM; grading applies to jobs, calls and memory.

LOOP 3: EVENT-DRIVEN LOOP (proactive ARES)
- A small scheduler + event bus in main, with triggers:
  - SCHEDULED: a morning brief at a time I set (calendar, weather, important emails, overnight calls, jobs finished), and an optional evening wrap-up.
  - EVENTS: a new important email (Gmail check on an interval, only flagged/important ones), "leave now" before calendar events with a location (with travel time), a call ended (the existing summaries), a job done, a timer, a health problem.
- Each trigger runs an agent turn with its own small prompt and delivers presence-aware (spoken on the Mac if I'm there, otherwise the phone), respecting quiet hours and Focus/DND.
- A settings list of triggers I can turn on/off. Start conservative: no spam, and each notification must be worth my attention (grade it with loop 2: "is this worth interrupting Dhruv for?").

LOOP 4: HILL-CLIMBING LOOP (self-improvement, with my approval)
- A weekly (and on-demand, "ARES, review yourself") analysis job that reads the week's traces and finds SYSTEMATIC failures: repeated corrections, frequent barge-ins on long answers, tools that often fail, misheard/misclassified intents, graders that fail often, slow paths.
- It PROPOSES concrete changes, each with evidence (counts + examples): a persona/prompt edit, a new intent example, a tool description fix, a grader rubric tweak, a timeout change.
- Each proposal is run against the EVAL SET (from the reliability session) before and after; show me the pass-rate delta.
- It presents a short review in the ARES window (and a phone notification): "I noticed X (evidence), I suggest Y, eval 42→46/50. Approve / Reject / Edit". Only approved changes are applied, committed to git with a clear message, and reversible.
- Keep a changelog of self-improvements.

HUMAN IN THE LOOP (explicitly keep):
- Sensitive tool actions still need my "yes" (the existing gate).
- Loop-2 failures are reported honestly, never silently "fixed" by making things up.
- Loop-4 changes only with my approval.

DELIVERABLES: the trace schema + viewer (a simple diagnostics page), the grader module with rubrics + tests, the scheduler/triggers with settings, the weekly review flow with an approval UI, and an eval run showing each loop working. Build with npm run build, restart ARES and verify end to end.
