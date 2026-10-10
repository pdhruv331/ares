# Latency and architecture: making ARES answer fast and feel conversational

Scope: where the delay in a cascaded voice agent comes from, best-in-class numbers, the techniques and tools that cut it (streaming, preemptive generation, caching, routing, fillers, tracing), low-latency TTS, speech-to-speech and hybrid designs, frameworks, and Claude-specific latency. It ends with concrete recommendations for ARES. Researched 2026-10-08.

Related sibling notes cover adjacent detail, so this file only touches it where it feeds the latency budget:
- end-of-turn models, barge-in and human timing research: `addressee_and_turn_taking.md`
- ASR choice: `wake_word_and_speech_recognition.md`
- expressive TTS and audio tags: `emotion_and_expressive_voice.md`

Vendor figures are marked "vendor". Third-party figures are dated where possible. Several sources are search-engine summaries of pages that weren't fetched in full; these are marked "(search summary)".

**ARES as it is today**, read from the repo on 2026-10-08 (these are facts about the code, not research):
- End of speech is a fixed silence timer: `endSilence = 1.3` s, plus 0.25 s re-arms while sound continues — [native/AresListener.swift](file:///Users/dhruv/My%20AI/native/AresListener.swift) (line ~99, `armSilence`).
- The brain is a long-running `claude` CLI process. Flags:
  - `--input-format stream-json` and `--output-format stream-json --verbose --include-partial-messages`
  - `--effort low` (overridable by `ARES_CLAUDE_EFFORT`)
  - `--setting-sources ''`, ARES's own `--mcp-config`
  - default model `sonnet`, with `router.js` choosing Haiku, Sonnet or Opus per request

  — [claude.js](file:///Users/dhruv/My%20AI/claude.js) (lines ~10–99)
- TTS is one HTTPS request per sentence to `/v1/text-to-speech/{voice}/stream?output_format=pcm_24000`, model `eleven_v3`. It is hedged with a second request if slow, has a 6 s first-audio deadline (`FIRST_AUDIO_MS`), and falls back to Kokoro — [voice.js](file:///Users/dhruv/My%20AI/voice.js) (lines ~26, 300–420)
- Sentences are split on `. ! ?` followed by a space — [main.js](file:///Users/dhruv/My%20AI/main.js) (line ~1733)
- Stated v2 targets: first audio under 1 s for simple questions and under 1.5 s for brain questions — [docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md) (B6)

---

## Q1. The latency budget of a voice agent: where the time goes, typical vs best-in-class, and what feels natural

### Takeaway
Voice-to-voice latency is measured from the user's last word to the agent's first audible audio. It is the sum of endpointing, final transcript, LLM time-to-first-token (TTFT), sentence aggregation, TTS time-to-first-audio (TTFA), and audio I/O and buffering.
- Daily/Pipecat's June 2026 reference budget is about 1.2–1.3 s for a well-built cloud cascade. Endpointing is ~300 ms of that and LLM TTFT ~650 ms.
- Best-in-class co-located or speech-to-speech systems reach ~500–800 ms.
- Humans leave ~200 ms gaps, so ~800 ms is a vendor compromise, not a law. Under ~700 ms feels human; ~1–1.5 s is tolerated.
- In a cascade the LLM's TTFT and the endpointing silence are the two biggest slices. TTS is now a small slice if a real-time model is used.

### Cited Findings
**Reference budget (Daily / Pipecat "Voice AI & Voice Agents" guide, updated June 2026):**

| Stage | ms |
|---|---|
| macOS mic input | 40 |
| Opus encoding | 21 |
| network stacks and transit | 10 |
| packet handling | 2 |
| jitter buffer | 40 |
| Opus decoding | 1 |
| transcription and endpointing | 300 |
| LLM TTFB | 650 |
| sentence aggregation | 20 |
| TTS TTFB | 120 |
| Opus encoding | 21 |
| packet handling | 2 |
| network | 10 |
| jitter buffer | 40 |
| Opus decoding | 1 |
| macOS speaker output | 15 |
| **Total** | **1293** (the text says "about 1,200 ms") |

— [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)

**Other figures from the same guide:**
- Targets:
  - "A response time of 500ms is typical" in human conversation.
  - "1,500 ms voice-to-voice latency is an important target to aim for."
  - Demo agents reached "as low as 500 ms" by co-locating models on one GPU cluster.
- LLM rule of thumb: "LLM time-to-first-token of 600 ms or less is fast enough for most voice AI use cases."
- Turn detection: VAD triggers at about 200 ms, the Smart Turn model classifies in about 30 ms, so a decision lands ~250 ms after the pause. Pipecat's default `VAD_STOP_SECS = 0.8`.
- Bluetooth devices can add "several hundred milliseconds of latency to voice input".

— [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)

**Other vendors' budgets and rules (vendor syntheses):**
- Soniox:
  - The silence timer used to confirm the speaker has finished adds straight to response time.
  - An illustrative sequential (non-overlapped) run totals 1,180 ms, so overlapping stages is what makes ~800 ms reachable.
  - Track time-to-first-audio rather than total turnaround.

  — [Soniox wiki](https://soniox.com/wiki/voice-agent-latency-budget) (search summary)
- Twig:
  - Human median gap ~200 ms; gaps over 800 ms feel awkward.
  - Hitting the target requires "streaming everywhere, parallel tool calls, speculative endpointing".
  - Median first audio under 800 ms, p95 under 1,500 ms.

  — [Twig](https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms)
- SimbaVoice: sub-500 ms median and sub-800 ms p95 round trip as a stricter bar. — [SimbaVoice](https://simbavoice.ai/resources/latency-engineering-for-real-time-voice-agents) (search summary)
- Cerebrium (vendor, sells GPU hosting):
  - Co-locating STT, LLM and TTS saves 150 ms or more, because each Pipecat frame otherwise crosses the public internet twice.
  - It measured OpenAI 4o-mini TTFT ranging 700 ms–1.5 s vs ~300 ms for a self-hosted llama-3-8b.
  - It reached 600 ms end to end with Ultravox + Cartesia.

  — [Cerebrium](https://cerebrium.ai/resources/pipecat-voice-agent-gpu-deployment) (search summary)
- Morph: the LLM is the largest and most variable slice (350–1000 ms). — [Morph](https://www.morphllm.com/voice-agent-api) (search summary)

**Measured speech-to-speech reference point:**
- OpenAI's GPT-Live-1 in ChatGPT, measured by Agora (July 2026, iPhone 13, artificial mouth, n=30, waveform-timed):
  - Median response latency 205 ms better than Advanced Voice Mode.
  - Its P90 is only 104 ms above its median (σ 104 ms). Advanced Voice Mode's P90 was 2,318 ms (σ 489 ms).
  - Standard (cascaded) Voice Mode took about 5 s per turn.

  — [Agora](https://prod.agora.io/en/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it)
- API coverage reports GPT-Live turn-taking latency of 0.798 s vs 1.41 s for gpt-realtime-2.1 on Full Duplex Bench. Not confirmed against OpenAI's own post. — [AI Weekly](https://aiweekly.co/alerts/openai-launches-gpt-live-1-in-the-api-at-005minute-cuts-turn-taking-latency-to) (search summary)

**Human timing (summarised in the sibling note `addressee_and_turn_taking.md`, Q6):**
- Modal gap 100–200 ms; gaps of 600–700 ms or more start to signal trouble or a dispreferred answer.
- An HRI study found ~1 s robot delay preferred, with fillers making longer delays tolerable. — [Levinson & Torreira 2015](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.00731/full); [Shiwa et al. 2009](https://doi.org/10.1007/s12369-009-0012-8)

### Inferences
- ARES's current turn is probably about 3–4.5 s from the owner's last word to Katherine's first sound, before any tool call. This is a rough estimate from cited component numbers, not a measurement:
  - 1.3 s fixed silence
  - ~0.1–0.3 s for the final transcript
  - Claude Code TTFT, likely ~1–2.5 s for Sonnet with a large prompt (see Q6)
  - waiting for a whole first sentence
  - ~0.76 s eleven_v3 TTFA (Q3)
  - a few tens of ms of playback
- The planned A1 instrumentation is the right first step.
- In ARES's budget the "network/Opus/jitter" rows of the Daily table mostly vanish, because audio stays local (mic → Swift helper; PCM → speaker). The remaining slices are endpointing, STT final, brain TTFT, aggregation, TTS TTFA and output.

### Gaps
- No published study measures perceived naturalness specifically for LLM voice assistants on a desktop (as opposed to phone agents or robots).
- No measured breakdown for Apple's on-device recogniser's final-result delay after the speech ends was found in this pass (see the ASR sibling note).

---

## Q2. Techniques that cut latency: streaming everywhere, first-clause TTS, input-streaming WebSockets, preemptive generation, caching and warm sessions, routing, fillers, phrase caches, parallel tools, tracing

### Takeaway
The big wins in order of usual size:
1. A smarter, shorter endpoint: VAD of ~200 ms plus a semantic turn model instead of a 0.8–1.3 s silence timer.
2. Preemptive LLM generation that starts on the final or partial transcript before the turn is confirmed.
3. A fast, warm, cache-friendly LLM call.
4. Streaming LLM text into a real-time TTS over a persistent WebSocket, so audio starts after the first clause rather than the first sentence or the whole reply.
5. Never leaving silence during tools: speak a preamble, play a cached acknowledgment, or delegate slow work to the background.

Measure every stage with timestamps and look at p50 and p95.

### Cited Findings
**Streaming between stages and sentence aggregation:**
- Daily's budget allows 20 ms for "sentence aggregation" between LLM tokens and TTS. — [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)
- Pipecat reports "TextAggregationMetricsData" separately: the time from the first LLM token to the first complete sentence. — [Pipecat UserBotLatencyObserver docs](https://docs.pipecat.ai/server/utilities/observers/user-bot-latency-observer) (search summary)
- ElevenLabs: use streaming endpoints when all text is known up front, and "websockets for real-time text input, such as LLM output". — [ElevenLabs latency optimization](https://elevenlabs.io/docs/developers/best-practices/latency-optimization)
- Kyutai TTS is described by Kyutai as the first TTS "streaming in text". It starts processing as an LLM produces text, so Unmute "start[s] speaking even before the full text response is generated." — [Kyutai TTS](https://kyutai.org/next/tts) (search summary); [Kyutai TTS/Unmute open-source post](https://kyutai.org/2025/07/03/tts-unmute-open-source.html) (search summary)

**ElevenLabs input-streaming WebSocket (classic TTS, `/v1/text-to-speech/{voice_id}/stream-input`):**
- Protocol:
  - The first message is `text: " "` (it may carry `voice_settings`, `generation_config`).
  - Then text chunks, each ending with a space.
  - `flush: true` forces generation of what's buffered; `try_trigger_generation` forces generation above a threshold.
  - `""` closes the stream.
- Parameters:
  - `chunk_length_schedule` defaults to `[120, 160, 250, 290]`: the first audio waits for ≥120 buffered characters. Each value can be 50–500.
  - `inactivity_timeout` is 20 s by default, max 180.
  - `auto_mode` (default false) lets the server choose generation triggers.
  - Regional hosts: `api.us.elevenlabs.io`, EU, India and Singapore residency.

  — [ElevenLabs stream-input API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
- With `auto_mode` off, the model waits until the chunk schedule fills. The docs' example: a 125-character schedule with only 50 characters received stalls and adds latency. — [ElevenLabs latency optimization](https://elevenlabs.io/docs/developers/best-practices/latency-optimization)
- This socket does **not** support `eleven_v3`. A LiveKit user reproduced a 403 for `eleven_v3` while `eleven_flash_v2_5` and `eleven_turbo_v2_5` connected. — [ElevenLabs realtime TTS guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts.md) (search summary); [LiveKit community](https://community.livekit.io/t/elevenlabs-eleven-v3-with-livekit-agents-js-plugin-fails-with-websocket-403/1007) (search summary)

**ElevenLabs Text to Dialogue WebSocket (`wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`):**
- Models:
  - Only models whose `model_id` starts with `eleven_v3` or `eleven_v4`.
  - `eleven_v4_turbo` allows exactly one registered voice per connection; `eleven_v4` allows up to 10.
- Messages:
  - The first message lists `voices`.
  - Text goes in `inputs: [{text, voice_id, new_turn?}]`.
  - Controls: `{"flush": true}`, `{"keep_alive": true}`, `{"close_socket": true}`.
- Behaviour:
  - A fixed first-audio threshold of about 40 characters and 8 words; `chunk_length_schedule` is not available.
  - Closes after 20 s with no client message.
  - Sessions come from a dedicated pool outside the plan's normal concurrency limit.

  — [ElevenLabs realtime Text to Dialogue guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd)
- The changelog of 28 Sep 2026 says to use `eleven_v4_turbo` "through the Text to Dialogue WebSocket for agents and interactive applications". — [ElevenLabs changelog 2026-09-28](https://elevenlabs.io/docs/changelog/2026/9/28)
- A localized guide (search summary) says the dialogue socket is in beta, rolling out gradually, and needs workspace-level access. — [ElevenLabs TTD guide (es)](https://elevenlabs.io/docs/es/eleven-api/guides/how-to/websockets/realtime-tdd) (search summary)

**Preemptive / speculative generation:**
- LiveKit Agents settings and defaults:
  - `preemptive_generation.enabled` (default `True`) starts LLM generation "as soon as a final transcript arrives, before the turn is confirmed."
  - `preemptive_tts` (default `False`) also starts TTS: lower latency, but compute is wasted on cancellations.
  - `max_speech_duration` 10 s: longer utterances skip it.
  - `max_retries` 3 per turn.
  - The speculative response is cancelled when the final transcript changes.
  - The docs warn it "doesn't always reduce latency"; check metrics.

  — [LiveKit turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning/)
- LiveKit endpointing defaults:
  - `min_delay` 0.5 s; in VAD mode the effective delay is `max(VAD silence, min_delay)`.
  - `max_delay` 3.0 s.
  - `mode` `"fixed"`, or `"dynamic"`, which adapts to the session's pause statistics.

  — [LiveKit turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning/)
- Community reports of preemptive generation bugs:
  - Python Agents 1.6.4: turns that failed to commit for 10–86 s, with `preemptive_generation=True` and `inference.TurnDetector()`.
  - GitHub #6112: disabling settings being ignored.

  Treat both as anecdotal. — [LiveKit community](https://community.livekit.io/t/possible-audio-turndetector-cancellation-stall-in-python-agents-1-6-4/1597) (search summary)
- Deepgram Flux "eager end of turn" (the same idea at the STT layer) raises LLM calls by 50–70%. Telnyx reports ~150 ms median gain where eager fires. Detail is in the sibling note. — [Deepgram eager EOT guide](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot); [Telnyx release notes](https://telnyx.com/release-notes/automatic-eager-end-of-turn-deepgram-flux) (both via sibling note, not re-verified here)

**Semantic endpointing (the biggest lever; full detail in the sibling note):**
- Smart Turn v3:
  - ~12 ms inference on modern CPUs, ~60 ms on a low-cost AWS instance.
  - 8 MB int8 ONNX: the Whisper-Tiny encoder plus a classifier, ~8M parameters, 23 languages.
  - Fully open: weights, data and training script.

  — [Daily: Smart Turn v3](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/) (search summary); [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn) (search summary)
- In Pipecat, `LocalSmartTurnAnalyzerV3` is the default user-turn stop strategy as of v0.0.102. Pipecat recommends a VAD stop of 0.2 s with it. — [Pipecat Smart Turn docs](https://docs.pipecat.ai/server/utilities/smart-turn) (search summary)

**Prompt caching and warm sessions (Anthropic):**
- Order and invalidation:
  - The cache prefix order is `tools` → `system` → `messages`.
  - "Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache."
  - Switching `speed: "fast"` invalidates system and message caches; thinking or effort changes always invalidate message blocks.
- Lifetime:
  - The default TTL is 5 min, refreshed free on each use; a 1 h TTL costs 2× base input for writes.
  - Lifetime is measured from the start of the request, so a long streaming response eats into it.
- Pre-warming:
  - Send a request with `max_tokens: 0` to write the cache without generating; re-send at least every 5 min to keep it warm.
  - The docs say pre-warming reduces TTFT "for latency-sensitive applications", with "improved time-to-first-token for long documents". No ms figures are given.
- Prices and minimums:
  - Cache reads are 0.1× base input (0.05× on Opus 5.5 and Sonnet 5.5).
  - Minimum cacheable prompt: 4,096 tokens on Haiku 4.5; 512 on Haiku 5.5, Sonnet 5.5 and Opus 5.5.

  — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Anthropic's latency guide:
  - Choose a faster model (Claude Haiku 5.5 at `effort: low` is the example).
  - Minimise input and output tokens.
  - Ask for sentence or paragraph counts rather than word counts.
  - Stream.

  — [Anthropic: Reducing latency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency)

**Routing to a faster model, and fast/slow splits:**
- LiveKit's "subagent delegation" pattern:
  - A latency-optimized primary model takes every turn (the example uses `google/gemma-4-31b-it`).
  - It calls an async `@function_tool` that runs a slower reasoning model (the example uses `google/gemini-3.1-pro`) in its own `ChatContext`, without the full history.
  - `ctx.update()` makes the tool non-blocking, so the agent acknowledges and keeps talking. The result is spoken as a follow-up when idle; `reply_maybe_covered_template` handles the case where newer turns came first.
  - `ToolFlag.CANCELLABLE` and `on_duplicate="reject"` avoid wasted or duplicate work.
  - The docs warn that "several seconds" of silence can feel like a dropped connection.

  — [LiveKit subagent delegation](https://docs.livekit.io/agents/logic/patterns/subagent-delegation/)
- OpenAI GPT-Live:
  - Separates a full-duplex live voice model from backend reasoning and tools, connected by delegation.
  - "Client delegation" lets you connect "any model, agent harness, or service your application runs".
  - Interrupting speech does not automatically cancel backend work.
  - Audio runs on a dedicated fast path; delegation sits behind an asynchronous RPC boundary, so a slow tool delays only its own result.

  — [OpenAI voice agents guide](https://developers.openai.com/api/docs/guides/voice-agents); [OpenAI live delegation guide](https://developers.openai.com/fr-FR/api/docs/guides/live-delegation) (search summary)

**Fillers and acknowledgments:**
- Daily's guide:
  - Speak a message before a function call ("Please wait while I do X for you …").
  - Use a watchdog timer for slow calls ("Still working on this …").
  - Consider background music for long calls.

  — [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)
- LiveKit:
  - `ctx.with_filler()` plays filler during silent gaps; the examples use a 5 s delay, 10 s interval, up to 3 steps.
  - The primary agent is told not to answer the delegated question itself, so it doesn't contradict the later result.
  - Filler on *blocking* tools can make the model treat its own filler as a user turn; test first.

  — [LiveKit subagent delegation](https://docs.livekit.io/agents/logic/patterns/subagent-delegation/)
- OpenAI recommends measuring acknowledgments ("I'm checking") separately from the substantive answer, and checking that faster responses don't hurt task success. — [OpenAI voice agents guide](https://developers.openai.com/api/docs/guides/voice-agents)

**Parallel tool calls:**
- Claude may call several tools in one response by default. `disable_parallel_tool_use` in `tool_choice` turns this off. Results must be returned together in one user message. — [Anthropic parallel tool use (fr)](https://platform.claude.com/docs/fr/agents-and-tools/tool-use/parallel-tool-use) (search summary)

**Measuring and tracing:**
- Pipecat's `UserBotLatencyObserver`:
  - Measures from `VADUserStoppedSpeakingFrame` to `BotStartedSpeakingFrame`.
  - `on_latency_breakdown` gives a per-service TTFB list (processor, model, start, duration), text-aggregation time, user-turn timing and function-call metrics.
  - It writes OpenTelemetry span attributes when tracing is on; needs `enable_metrics=True`.

  — [Pipecat UserBotLatencyObserver](https://docs.pipecat.ai/api-reference/server/utilities/observers/user-bot-latency-observer) (search summary)
- OpenAI's per-stage logging list for delegated voice: delegation receipt, backend request start, first useful result, tool start and end, result submission, audio arrival, client playback. Compare medians and p95s, and change one factor at a time. — [OpenAI voice agents guide](https://developers.openai.com/api/docs/guides/voice-agents)
- Inworld's benchmarking guidance: record first playable audio and end-to-end turn latency at P50/P95/P99, warm and cold, under load. — [Inworld vs Azure page](https://inworld.ai/vs/azure-vs-inworld) (search summary, vendor)

### Inferences
- **Stream LLM deltas into the WebSocket instead of whole sentences.** With a WebSocket TTS the speech starts after ~40 characters (TTD) or the first chunk-schedule threshold. ARES's per-sentence HTTPS calls wait for a full sentence, then pay HTTP request setup for each one. The WebSocket also keeps prosody continuous across sentences within a turn (`new_turn` resets it).
- **Prefer preemptive LLM over preemptive TTS.** For a credit-metered TTS like ElevenLabs, preemptive LLM generation without preemptive TTS is the sensible default. It matches LiveKit's default and CLAUDE.md's rule about not wasting credits.
- **Speculation is harder through Claude Code.** A speculative turn sent into a long-running Claude Code session can't simply be discarded: it becomes part of the transcript unless interrupted. Cheaper to speculate on a separate one-shot fast path (see Q7), or only when the transcript is stable.
- **Use Claude's preamble as the filler.** The most natural "filler" for a tool-using Claude brain is its own preamble. If the prompt makes it say one short spoken line before calling tools ("Let me check your calendar."), that text streams before the `tool_use` block and gives first audio within normal TTFT. A cached "One sec" is then only needed when no text arrives before a tool call.

### Gaps
- No independent measurement was found of how much Anthropic prompt caching cuts TTFT in ms (the docs are qualitative).
- No published A/B on whether acknowledgments or fillers raise or lower user satisfaction for a personal desktop assistant. The evidence is vendor guidance plus 2009 HRI work (see sibling notes).

---

## Q3. Low-latency TTS options in 2026: ElevenLabs (v4 Turbo, Flash v2.5, v3), Cartesia, Deepgram, Rime, Inworld, OpenAI, Hume, and local options on Apple Silicon

### Takeaway
`eleven_v3`, which ARES uses for live replies, is ElevenLabs' non-real-time model:
- ~758 ms median first audio (Vapi, June 2026)
- not supported on the input-streaming TTS WebSocket
- $0.08 per 1K characters, the most expensive tier

The new **`eleven_v4_turbo`** (28 Sep 2026) is a real-time model:
- vendor ~100 ms inference, ~150 ms first speech
- #1 on Artificial Analysis' Speech Arena in October 2026 (Elo 1332)
- $0.04 per 1K characters list, half of v3, on a 72% promotion until 12 Oct
- streams text in over the Text to Dialogue WebSocket

That makes it the obvious replacement if Katherine works on v4. Flash v2.5 (~75 ms) is the cheaper, lower-quality fallback. Cartesia Sonic 3.5/3.6 and Inworld TTS-2 are the strongest non-ElevenLabs real-time options. Locally, Kokoro (already in ARES) and Kyutai's Pocket TTS (~200 ms first audio on CPU, secondhand) are the practical Apple Silicon choices.

### Cited Findings
**ElevenLabs models page (October 2026):**

| Model ID | Stated latency | Use |
|---|---|---|
| `eleven_v4` | not stated | non-real-time (narration, dialogue) |
| `eleven_v4_turbo` | ~100 ms median (excluding app and network) | real-time ("support agents, AI assistants") |
| `eleven_v3` | not stated | non-real-time ("dramatic delivery") |
| `eleven_v3_conversational` | ~280 ms | real-time; called a "previous-generation real-time model" |
| `eleven_flash_v2_5` | ~75 ms (excluding app and network) | real-time; 32 languages |
| `eleven_turbo_v2_5` | — | deprecated; replace with Flash v2.5 |

— [ElevenLabs models](https://elevenlabs.io/docs/models)

**ElevenLabs API prices, per 1K characters (pay as you go, billed in USD):**

| Model | Price |
|---|---|
| v4 | $0.022 (normally $0.08; 72% off until Oct 12) |
| v4 Turbo | $0.011 (normally $0.04; same promotion) |
| v3 | $0.08 |
| v3 Conversational | $0.04 |
| Multilingual v2 | $0.08 |
| Flash / Turbo | $0.04 |

Scribe v2 Realtime STT costs $0.39/h. — [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)

**Other ElevenLabs figures:**
- Launch coverage:
  - v4 Turbo "~150ms median time to first speech (company-reported)", with bidirectional streaming.
  - ElevenLabs claims Eleven v4 was preferred by ~75% of listeners in blind tests.

  — [VKTR](https://www.vktr.com/ai-platforms/elevenlabs-launches-eleven-v4-and-v4-turbo/)
- Expected WebSocket TTFB for Flash models: 100–150 ms in North America, Europe and South-East Asia; 150–200 ms in South Asia and North-East Asia.
  - Serving regions: USA, Netherlands, Singapore; the `x-region` header shows which served a request.
  - Default and synthetic voices and Instant Voice Clones are faster than Professional Voice Clones; PVC optimisation for Flash v2.5 is "in progress".

  — [ElevenLabs latency optimization](https://elevenlabs.io/docs/developers/best-practices/latency-optimization)
- Deepgram (a competitor) notes the ~75 ms Flash figure is model inference only, and cites independent median TTFB near 255 ms with network. — [Deepgram](https://deepgram.com/learn/is-elevenlabs-real-time-what-developers-need-to-know) (search summary)

**Independent latency and humanness benchmark (Vapi Humanness Index):**
- Same cloned voice on every model; blind A/B votes; latency is the median of 50 sequential live streaming trials including network RTT, checked June 2026; standings as of 8 Oct 2026.

| Model | Humanness | Median latency |
|---|---|---|
| Eleven v3 | 97 | 758 ms |
| Speechify Simba 3.2 | 96 | 428 ms |
| xAI Grok TTS | 93 | 460 ms |
| xAI Grok TTS (streaming) | 87 | 285 ms |
| MiniMax Speech 2.8 | 93 | 325 ms |
| MiniMax Speech 2 HD | 88 | 357 ms |
| Fish Audio S2.1-Pro | 83 | 141 ms |
| Inworld TTS-1.5-max | 79 | 337 ms |
| ElevenLabs Turbo v2 | 76 | 302 ms |
| ElevenLabs Flash v2.5 | 68 | — |
| ElevenLabs Turbo v2.5 | — | 265 ms |
| ElevenLabs Multilingual v2 | — | 1006 ms |

— [Vapi Humanness Index](https://humannessindex.vapi.ai/); [Vapi: Eleven v3](https://humannessindex.vapi.ai/models/elevenlabs-eleven-v3)

- Cartesia on the same index: Sonic 3 median 166 ms; Sonic 3.5 (GA May 2026) 128 ms. — [Vapi: Sonic 3](https://humannessindex.vapi.ai/models/cartesia-sonic-3), [Vapi: Sonic 3.5](https://humannessindex.vapi.ai/models/cartesia-sonic-3-5) (search summary)
- v4 and v4 Turbo were not yet on the Vapi latency list.

**Daily's TTS table** (captioned "June 2025" inside a guide updated June 2026, so the dating is inconsistent):

| Service | Median TTFA | P95 TTFA | Approx. cost per minute |
|---|---|---|---|
| Cartesia Sonic 3.5 | 195 ms | 240 ms | $0.028 |
| Gradium | 235 ms | 320 ms | $0.032 |
| Deepgram Aura-2 | 310 ms | 600 ms | $0.024 |
| ElevenLabs Turbo v2.5 | 330 ms | 670 ms | $0.050 |
| Inworld TTS 1.5 Max | 337 ms | 560 ms | $0.009 |

— [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)

**Quality ranking: Artificial Analysis Speech Arena (blind-vote Elo; price per 1M characters; fetched 8 Oct 2026):**

| # | Model | Elo | Price |
|---|---|---|---|
| 1 | ElevenLabs Eleven v4 Turbo | 1332 | $40 |
| 2 | Eleven v4 | 1324 | $80 |
| 3 | Alibaba Qwen-Audio-3.1-TTS-Plus | 1295 | $19.3 |
| 4 | Cartesia Sonic 3.6 | 1279 | $49 |
| 5 | Google Gemini 3.8 Flash TTS | 1276 | $16.5 |
| 7 | Inworld Realtime TTS-2 | 1252 | $20.8 |
| 9 | Speechify Simba 3.2 | 1241 | $6.6 |
| 12 | Inworld TTS-2 Flash | 1215 | $10.4 |
| 15 | ElevenLabs v3 Conversational | 1205 | $50 |
| 16 | Cartesia Sonic 3.5 | 1190 | — |
| 18 | ElevenLabs Eleven v3 | 1174 | $100 |
| 23 | Gradium | 1152 | $47.2 |
| 24 | Fish Audio S2.1 Pro | 1140 | $15 |

Lower down:

| Model | Elo | Price | Notes |
|---|---|---|---|
| Fish Audio S2 Pro | 1117 | — | open weights |
| OpenAI TTS-1 HD | 1103 | $30 | |
| ElevenLabs Flash v2.5 | 1079 | $50 | |
| Kokoro 82M v1.0 | 1064 | $0.7 | open weights |
| Rime Coda | 1059 | $50 | |
| Deepgram Flux TTS | 1055 | $45 | |
| Hume Octave 2 | 1051 | $87.5 | |

gpt-4o-mini-tts, Kyutai and Deepgram Aura did not appear. — [Artificial Analysis TTS leaderboard](https://artificialanalysis.ai/text-to-speech/leaderboard)
- Two price conflicts: AA lists Eleven v3 at $100/1M, but ElevenLabs' API page says $0.08/1K ($80/1M); AA lists Flash v2.5 at $50/1M vs $40/1M on ElevenLabs. Prefer the vendor's own price page.
- AA rankings move fast. In June 2026 Alibaba Fun-Realtime-TTS led at 1219 with Gemini 3.1 Flash TTS at 1214. — [Artificial Analysis, June 3 2026](https://artificialanalysis.ai/articles/fun-realtime-tts-new-text-to-speech-model-topping-artificial-analysis-leaderboard) (search summary)

**Other cloud vendors:**
- Cartesia (vendor): Sonic 3 and Sonic 2 ~90 ms TTFA; Sonic Turbo 40 ms. Billed at 1 credit per character (1.5 for Pro voice clones). — [eesel.ai](https://www.eesel.ai/blog/cartesia-sonic-3-pricing) (search summary)
- Inworld:
  - Docs list P50 latency of 200 ms for TTS-2 and ~120 ms for TTS 1.5 Mini.
  - $25/1M characters on demand, dropping to $12.50 on higher plans; Flash $15 down to $7.
  - A reseller measured ~0.7 s end to end for a short line on Flash vs ~1.7 s on TTS-2.

  — [Inworld TTS docs](https://docs.inworld.ai/docs/tts) (search summary); [GMI Cloud](https://docs.gmicloud.ai/model-quickstarts/audio/inworld-tts-2-flash) (search summary)
- Hume Octave 2: "under 200 ms" (secondary sources, method unspecified; Octave 1 ~330 ms). Overage rates about $0.025–$0.075 per 1K characters by tier. — [aiwiki](https://aiwiki.ai/wiki/hume_octave_2) (search summary); [usagepricing](https://usagepricing.com/blueprint/activity/hume-ai-2026-06-30-packaging) (search summary)
- OpenAI:
  - `gpt-4o-mini-tts`: $12/1M audio output tokens, $0.60/1M text input.
  - `tts-1`: $15/1M characters; `tts-1-hd`: $30/1M.
  - No successor TTS model is listed.

  — [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- No first-party latency figure was found for gpt-4o-mini-tts.

**Local / on-device on Apple Silicon:**
- Kyutai TTS ("delayed streams modeling"):
  - 220 ms from the first text token to the first audio chunk; 350 ms with 32 batched requests on an L40S GPU.
  - Streams text in.
  - Has an MLX implementation; no MLX latency was published.

  — [Kyutai TTS](https://kyutai.org/next/tts) (search summary); [Kyutai TTS/Unmute post](https://kyutai.org/2025/07/03/tts-unmute-open-source.html) (search summary)
- Kyutai Pocket TTS (released 13 Jan 2026; 100M parameters, CPU):
  - ~200 ms to first audio.
  - ~6× real time on 2 CPU cores of a MacBook Air M4.
  - A community ONNX INT8 export generates 80 ms frames.
  - All of these figures are secondhand.

  — [dev.to review](https://dev.to/andrew-ooo/pocket-tts-review-kyutais-100m-cpu-voice-cloner-2026-40lb) (search summary); [HF ONNX export](https://huggingface.co/soniqo/Pocket-TTS-100M-ONNX-INT8) (search summary)
- Kokoro 82M:
  - mlx-audio 0.4.3, full 30 s clip: 763 ms on an M2 Studio (~40× real time), 2.6 s on an M2 Air, 3.1 s on an M1 Mini. This is a third-party benchmark from a competing Core ML port, June 2026.
  - One M3 Max user saw mlx-audio 0.4.4 output NaN/zeros, while PyTorch on CPU ran ~11× real time.

  — [kokoro-coreml](https://huggingface.co/mattmireles/kokoro-coreml) (search summary); [HF discussion](https://huggingface.co/mlx-community/Kokoro-82M-bf16/discussions/5) (search summary)
- Piper: 150.6 ms average for a 15-word sentence on an M3 Max. Single third-party page. — [RCLI performance](https://www.mintlify.com/yocxy2/RCLI/advanced/performance) (search summary)
- Sesame CSM-1B is a speech generator that needs a separate LLM. A community MLX port reports ~120 ms first audio streaming. — [HF CSM-1B-MLX](https://huggingface.co/aufklarer/CSM-1B-MLX-8bit) (search summary)

### Inferences
- **Switch live replies to v4 Turbo.** Moving them from `eleven_v3` to `eleven_v4_turbo` is likely to save roughly 0.5–0.6 s per turn (758 ms measured for v3 vs vendor ~150 ms first speech plus network for v4 Turbo). It also halves the list price per character and *raises* the arena rank (1174 → 1332). This needs:
  - the Text to Dialogue WebSocket (beta/workspace access)
  - a check that the Katherine voice works on v4; the sibling note says some older clones need retraining
  - a listening test with the owner's go
- **Flash v2.5 is the safe fallback.** It is half the cost of v3, ~75 ms inference, and on the classic stream-input socket. But its quality scores are clearly lower (Elo 1079; Vapi humanness 68 vs 97 for v3).
- **Kokoro stays the local fallback.** It is already integrated and has the best price (free) but low quality (Elo 1064). Pocket TTS and Kyutai TTS-MLX are worth a local timing test as a faster, streaming-in-text fallback.

### Gaps
- No independent TTFA measurement of `eleven_v4_turbo` yet (released 11 days ago).
- No confirmed PCM output formats on the Text to Dialogue socket: the guide shows `mp3_44100_128` only.
- No first-party Apple Silicon TTFA numbers for Kokoro, Pocket TTS or Kyutai TTS-MLX on M3/M4/M5.
- Rime's latency and Deepgram Aura-2's current list price were not verified in this pass.

---

## Q4. Speech-to-speech and native-audio models, and hybrids that keep a separate text brain

### Takeaway
Native-audio models are the latency leaders: Moshi ~200 ms in practice; GPT-Live's median beats OpenAI's previous voice mode with a tight spread.

But with a single model they give up control of the brain, tools, voice and transcripts. The 2026 industry answer is the hybrid: a fast full-duplex voice front-end that delegates real work to a separate backend. Examples: OpenAI GPT-Live "client delegation", LiveKit subagent delegation, and "half-cascade" (audio in, text out, separate TTS).

ARES must keep Claude as the brain and wants Katherine's voice. So a cloud S2S front-end only makes sense as a delegating shell. A local S2S model (Moshi) is too weak to be the brain. The ARES-shaped version of the hybrid is a fast Claude path in front with slow Claude work in the background.

### Cited Findings
**OpenAI:**
- Three architectures:
  - Realtime: one model hears, reasons and speaks.
  - Chained: STT → agent → TTS; choose it to inspect or transform text at each stage.
  - GPT-Live: full duplex with a separate backend; choose it to keep an existing text workflow behind a voice interface.

  — [OpenAI voice agents guide](https://developers.openai.com/api/docs/guides/voice-agents)
- Prices:
  - `gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-2.1`: $32/1M audio input tokens, $0.40 cached input, $64 output.
  - `gpt-realtime-mini` and `gpt-realtime-2.1-mini`: $10 / $0.30 / $20.
  - **GPT-Live (`gpt-live-1`): $0.05 per session minute, billed per second; backend model and tool usage billed separately.**

  — [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- GPT-Live measurements (Agora, ChatGPT app, July 2026):
  - Median response latency 205 ms faster than Advanced Voice; P90 only 104 ms above the median.
  - Interruptions: ~1.4 s to fall silent, 498 ms *slower* than Advanced.
  - Background speech: it rejected all 30 background-speech probes, but answered background voices on its own in 4 of 30 ten-second windows.

  — [Agora](https://prod.agora.io/en/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it)
- Older planning figures for gpt-realtime:
  - ~500 ms API TTFB in US regions, 800 ms voice-to-voice achievable.
  - $0.06–$0.11/min with caching (flagship).

  — [Forasoft](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026) (search summary); [Forasoft pricing](https://www.forasoft.com/blog/article/openai-realtime-api-pricing) (search summary)

**Google:**
- `gemini-live-2.5-flash-native-audio` is GA (released 12 Dec 2025, discontinued 13 Dec 2026). — [Vertex AI docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-live-api) (search summary)
- `gemini-3.8-live` (stable, Sept 2026) is Google's default for "low-latency voice agent experiences":
  - 131,072 input tokens; caching and Batch API not supported.

  — [Gemini 3.8 Live](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live) (search summary)
- Gemini Live pricing seen only in third-party blogs: about $3/1M audio input and $12/1M audio output tokens.
- One blog claims 377 ms average latency on Vertex vs ~500 ms for OpenAI Realtime (method unknown). — [tokenkarma](https://tokenkarma.app/blog/gemini-live-api-pricing-voice-agents-2026/) (search summary); [edesy](https://edesy.in/ai-voice-assistant/blog/gemini-live-vs-openai-realtime) (search summary)

**Open models:**
- Kyutai Moshi: full duplex; 160 ms theoretical, ~200 ms in practice (vs a 230 ms average human gap across 10 languages). — [Moshi paper](https://arxiv.org/html/2410.00037v1) (search summary)
- Moshi runs on Apple Silicon via MLX (int4/int8). Its 7B Helium backbone can't replace Claude (sibling note). — `addressee_and_turn_taking.md` Q5
- Kyutai Unmute wraps any text LLM with Kyutai STT and streaming-in-text TTS; ~450 ms response in production per a third-party mirror. It is a reference design for "keep your own LLM, make the voice layer fast". — [Unmute overview mirror](https://www.mintlify.com/kyutai-labs/unmute/architecture/overview) (search summary); [Kyutai Unmute post](https://kyutai.org/2025/05/22/unmute.html)
- Qwen3-Omni: theoretical cold-start first-packet latency of 234 ms. The Qwen3.5-Omni report lists 435 ms (one variant) and 235 ms (Flash). — [Qwen3-Omni report](https://arxiv.org/pdf/2509.17765) (search summary); [Qwen3.5-Omni report](https://arxiv.org/pdf/2604.15804) (search summary)
- Ultravox:
  - Audio in, text out (a half-cascade): ~150 ms TTFT and 50–100 tok/s on an A100 with a Llama 3.1 8B backbone.
  - ~600 ms first audio end to end with Cartesia on Cerebrium.

  — [Ultravox model card](https://huggingface.co/fixie-ai/ultravox-v0_4_1-llama-3_1-8b/blob/80e788d2a063ec4d631493db6614b482ddbde7e7/README.md) (search summary); [Cerebrium](https://cerebrium.ai/blog/deploying-ultravox-on-cerebrium) (search summary)
- Sesame CSM-1B: a speech generator only, which needs a separate LLM. — [Spheron](https://www.spheron.network/blog/speech-to-speech-gpu-cloud-moshi-sesame-csm-hertz-dev/) (search summary)

**Trade-offs and hybrids:**
- LiveKit (17 Apr 2026):
  - "Most unoptimized pipeline deployments will be slower than a realtime model."
  - Pipelines win on transparency, swappable parts, more accurate text tool-calling, tunable turn detection, per-layer cost control and text-layer redaction.
  - Realtime wins on hearing tone.
  - Hybrids: realtime + separate STT (for transcripts); "half-cascade" realtime that outputs text into a dedicated TTS (for brand or cloned voices).

  — [LiveKit: pipeline vs realtime](https://livekit.com/blog/realtime-vs-cascade)
- Fast-responder plus background-reasoner splits are reported in production at xAI ("Grok Voice Think Fast"), Thinking Machines Lab and Pine AI, per a 2026 preprint. — [The Latent Bridge (arXiv 2606.24470)](https://arxiv.org/pdf/2606.24470) (search summary)
- VoiceAgentRAG: a background agent pre-fetches likely follow-up context into a cache for the foreground responder. — [arXiv 2603.02206](https://arxiv.org/html/2603.02206v1) (search summary)

### Inferences
- **GPT-Live client delegation is technically a fit but conflicts with ARES's rules.** A GPT-Live front end with Claude as the delegated backend would give ARES full duplex and very low turn latency for $0.05/min plus Claude. But:
  - small talk would be answered by OpenAI's model, not Claude, which stretches "the brain must stay Claude";
  - audio leaves the Mac to OpenAI;
  - it gives up Katherine's voice for OpenAI's voices.

  So it's a comparison point, not a recommendation.
- **The half-cascade pattern (audio-understanding model → text → Katherine) isn't worth adopting now.** It would only help if ARES wanted tone-aware input (see the emotion sibling note). It doesn't solve the Claude constraint.
- **What ARES can copy without S2S:** Unmute's design. It keeps a text LLM but makes the voice layer fully streaming: streaming STT, semantic end of turn, streaming-in-text TTS.

### Gaps
- No published latency for GPT-Live client delegation round trips.
- No independent like-for-like benchmark across Moshi, Qwen-Omni, gpt-realtime and Gemini Live.
- No official Google price sheet for Gemini 3.8 Live was retrieved.

---

## Q5. Frameworks and reference architectures (Pipecat, LiveKit Agents, TEN, Vocode, OpenAI Agents SDK) and what ARES can borrow

### Takeaway
Pipecat (Daily) and LiveKit Agents are the two mature open-source real-time frameworks:
- Pipecat reached a stable v1.0 in April 2026; it is Python and frame-pipeline based.
- LiveKit Agents is Python/Node and WebRTC-native.

TEN (Agora) is a graph-based alternative; Vocode's open-source core is effectively legacy (no commits since Nov 2024). OpenAI's Agents SDK offers chained, Realtime and GPT-Live patterns.

ARES doesn't need to switch platforms: its audio is local and its brain is a CLI process. What it should borrow are components and policies:
- Smart Turn v3 (open ONNX)
- LiveKit's preemptive-generation, endpointing and false-interruption semantics
- Pipecat's per-stage latency breakdown schema
- LiveKit's subagent-delegation and filler policy
- Unmute's streaming-text TTS design

### Cited Findings
- **Pipecat:**
  - Primary framework in Daily's guide, with Pipecat Flows (state machines), Pipecat Cloud and evaluation integrations (Cekura, Coval, Bluejay). — [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)
  - Smart Turn v3 is built in (`LocalSmartTurnAnalyzerV3`, default as of v0.0.102), with VAD stop 0.2 s recommended. — [Pipecat Smart Turn docs](https://docs.pipecat.ai/server/utilities/smart-turn) (search summary)
  - `UserBotLatencyObserver` gives per-service TTFB and OpenTelemetry. — [Pipecat observer docs](https://docs.pipecat.ai/server/utilities/observers/user-bot-latency-observer) (search summary)
  - A July 2026 comparison names Pipecat the strongest open-source framework (v1.0 stable April 2026, the largest integration library). — [techsy.io](https://techsy.io/en/blog/best-open-source-voice-agent-frameworks) (search summary, single source)
- **LiveKit Agents:**
  - Turn detector model: the default; uses semantics plus acoustics; <500 MB RAM on CPU in a shared process; needs STT; pair with Silero VAD.
  - `turn_detection="stt"` hands the end-of-turn decision to providers such as Deepgram Flux or AssemblyAI Universal-3 Pro.

  — [LiveKit turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector) (search summary)
  - Interruption defaults:
    - `mode="adaptive"` (an audio model separates real interruptions from backchannels)
    - `min_duration` 0.5 s
    - `false_interruption_timeout` 2.0 s, with `resume_false_interruption=True` to resume speaking

  — [LiveKit turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning/)
  - Subagent delegation, async tools, fillers: see Q2. — [LiveKit subagent delegation](https://docs.livekit.io/agents/logic/patterns/subagent-delegation/)
  - The LiveKit JS plugin also supports GPT-Live (`GPTLiveModelOptions`). — [LiveKit agents-js reference](https://docs.livekit.io/reference/agents-js/interfaces/plugins_agents_plugin_openai.realtime.GPTLiveModelOptions.html) (search result title)
- **TEN Framework:** Agora-backed, ~10.9k stars, Apache-2.0 ("hybrid"), C/C++ core with Go/Python/JS, graph of nodes composed in a flow builder; aimed at multimodal and edge. — [techsy.io](https://techsy.io/en/blog/best-open-source-voice-agent-frameworks) (search summary)
- **Vocode:** MIT; the latest vocode-core commit dates to Nov 2024; the comparison ranks it last ("reference with caveats"). Treat it as legacy. — [techsy.io](https://techsy.io/en/blog/best-open-source-voice-agent-frameworks) (search summary)
- **FastRTC** (Hugging Face/Gradio): a WebRTC/WebSocket audio library, not a full agent framework. — [techsy.io](https://techsy.io/en/blog/best-open-source-voice-agent-frameworks) (search summary)
- **OpenAI Agents SDK:**
  - `RealtimeAgent` / `RealtimeSession` for speech-to-speech.
  - A chained pipeline with `@function_tool` tools on an `Agent`.
  - GPT-Live delegation (client or Responses).

  — [OpenAI voice agents guide](https://developers.openai.com/api/docs/guides/voice-agents)
- **Kyutai Unmute:** an open-source wrapper (Kyutai STT + TTS around any text LLM) with streaming text into TTS. — [Kyutai Unmute post](https://kyutai.org/2025/05/22/unmute.html)
- **Pipeline cost reference:** a self-hosted Deepgram + GPT-4o + Cartesia pipeline costs about $0.025/min (TTS about half of it); S2S APIs cost $0.20/min or more. — [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)

### Inferences
- **Don't adopt a framework.** ARES's pipeline is already "local mic → Swift → Node → CLI brain → TTS → local speaker". Pipecat and LiveKit mainly add value around WebRTC transport and telephony, which ARES doesn't need for desk audio. The phone line already runs in ElevenLabs' cloud and must not be touched (CLAUDE.md). Their *policies and models* port directly:
  - Smart Turn ONNX runs in onnxruntime-node or Core ML.
  - Preemptive-generation rules: cancel on transcript change; skip utterances over 10 s; at most 3 retries.
  - Endpointing `min_delay` / `max_delay` and a "dynamic" mode.
  - False-interruption resume after 2 s.
  - Async delegation with spoken follow-ups.
- **Copy Pipecat's breakdown as ARES's log schema** (user stopped → per-stage TTFB → text aggregation → bot started). It matches the stages in docs/voice-prompt.md A1.

### Gaps
- Star counts and activity come from one July 2026 comparison and weren't checked against GitHub.
- The Smart Turn v3 licence wasn't re-checked here (see the sibling note).

---

## Q6. LLM latency specifics: Claude TTFT by model, API vs Claude Code headless, big system prompts and tool lists, prompt caching, and routing

### Takeaway
Claude Haiku is the fast tier:
- Haiku 4.5 non-reasoning TTFT is ~0.6–0.8 s on Anthropic's API at a 10k-token prompt (Artificial Analysis); Daily measured 637 ms median and 1,615 ms P95.
- Claude Haiku 5.5, released 7 Oct 2026, is now Anthropic's "fastest" model at $0.10/$0.50 per MTok (≤100k-token prompts).
- Sonnet- and Opus-class models with adaptive thinking take seconds to the first answer token unless effort is low.

Claude Code headless adds a large fixed prompt: ~33k tokens measured, mostly tool definitions, and 75k+ with MCP servers. Its cache prefix may shift mid-session, and tool calls produce multi-second silences. `--bare` speeds start-up but doesn't use the subscription login, so ARES can't use it.

Levers that fit ARES's constraints:
- low effort
- route quick conversational turns to Haiku 5.5
- keep the tools/system prefix byte-stable so caching works
- trim or defer MCP tools
- stream partial messages
- make the model speak before tools

### Cited Findings
**Model lineup (Anthropic, October 2026):**

| Model | Comparative latency | Price per MTok (in / out) | Default effort |
|---|---|---|---|
| Haiku 5.5 | Fastest | from $0.10 / $0.50 | `medium` |
| Sonnet 5.5 | Fast | $2 / $10 | `high` |
| Opus 5.5 | Moderate | $4 / $20 | `medium` |
| Fable 5.1 | Slower | $10 / $50 | `high` |

All have adaptive thinking (always on for Opus 5.5 and Fable 5.1) and 1M context. — [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview)

**Claude Haiku 5.5:**
- Released 7 Oct 2026; "for high-volume, latency-sensitive tasks such as classification, extraction, and routing".
- Prices:
  - $0.10/$0.50 per MTok for prompts up to 100k tokens; $0.50/$2.50 above.
  - Cache read $0.01/MTok (≤100k).
- Behaviour:
  - Adaptive thinking is on by default and controlled by effort.
  - Non-default `temperature`/`top_p`/`top_k` return a 400.
  - Its tokenizer counts ~30% more tokens than Haiku 4.5's for the same text.

— [Claude Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)

**Measured TTFT:**
- Artificial Analysis, Claude 4.5 Haiku non-reasoning (10k input tokens, P50): Google Vertex 0.58 s, Anthropic 0.83 s, Amazon 0.96 s, Azure 1.19 s.
- The reasoning variant is ~10–19 s, because thinking time counts.

— [Artificial Analysis: Claude 4.5 Haiku providers](https://artificialanalysis.ai/models/claude-4-5-haiku/providers) (search summary)

- Daily's LLM TTFT table (median / P95):

| Model | Median | P95 |
|---|---|---|
| GPT-4.1 | 536 ms | 1771 ms |
| Gemini 2.5 Flash | 597 ms | 1137 ms |
| Claude 4.5 Haiku | 637 ms | 1615 ms |
| GPT-5.1 | 739 ms | 1492 ms |
| Nemotron 3 Ultra (self-hosted) | 541 ms | 712 ms |

The guide's realtime benchmark requires a first non-thinking token under 700 ms. — [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/)

- Artificial Analysis snapshots for Sonnet 5 on Anthropic (search summary):
  - medium effort: ~2.55 s to first answer token, ~57 tok/s
  - high effort: ~9.5 s
  - Sonnet 5.5 at max effort: ~139 tok/s output

  — [Artificial Analysis: Sonnet 5 medium](https://artificialanalysis.ai/models/claude-sonnet-5-medium/providers); [AA: Sonnet 5 high](https://artificialanalysis.ai/models/claude-sonnet-5-high/providers) (search summaries)
- A single-author 2026 test reports Haiku 4.5 at 597 ms TTFT on a medium prompt. — [Kunal Ganglani](https://www.kunalganglani.com/blog/llm-api-latency-benchmarks-2026.md) (search summary)

**Fast mode:**
- `speed: "fast"` with beta header `fast-mode-2026-02-01`.
- Up to 2.5× output tokens per second on Opus 5.5, Opus 5 and Opus 4.8.
- It speeds output, **not TTFT**.
- Premium pricing; access through the waitlist or an account manager.
- Switching speed invalidates system and message caches.

— [Anthropic fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md) (search summary); [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

**Claude Code headless:**
- `--output-format stream-json --verbose --include-partial-messages` streams token deltas (`stream_event` / `text_delta`).
- `-p` accepts `/model`, `/effort` and `/fast` with an argument (v2.1.205+).
- With `--mcp-config`, the first turn waits for pending MCP servers up to `MCP_TIMEOUT` (30 s default).

— [Claude Code headless docs](https://code.claude.com/docs/en/headless)

- **`--bare` reduces start-up time** by skipping hooks, skills, plugins, MCP discovery, memory and CLAUDE.md. But "bare mode doesn't use your subscription login": it needs `ANTHROPIC_API_KEY` or an `apiKeyHelper`. — [Claude Code headless docs](https://code.claude.com/docs/en/headless)
- Systima measurement (July 2026, CLI 2.1.207):
  - Claude Code sends ~33,000 tokens before any user input, ~24,000 of them tool definitions (vs ~7,000 for OpenCode).
  - Production setups with CLAUDE.md and MCP servers reach 75k–85k tokens.
  - A summary says Claude Code's cache prefix changes mid-session while OpenCode's stays byte-identical.

  — [Kunal Ganglani on Systima](https://www.kunalganglani.com/blog/opencode-vs-claude-code-token-overhead) (search summary); [explainx summary](https://www.explainx.ai/blog/claude-code-vs-opencode-token-overhead-systima-study-july-2026) (search summary)
- One instrumented `-p` stream-json run (CLI 2.1.278):
  - first message start ~2.7 s after launch
  - ~3.4 s of silence around a tool call
  - a further 1.2 s before the final reply

  Single run. — [mer.vin](https://mer.vin/news/why-claudes-token-stream-goes-quiet-the-moment-it-calls-a-tool/) (search summary)
- MCP tool search defers tool definitions behind a search tool (`ENABLE_TOOL_SEARCH`: unset/true = defer, `auto` = defer above 10% of context, `auto:N`, `false` = load all). One measured setup (5 servers, 65 tools) cut the first request from 27,184 to 9,722 tokens (−64%). Third-party; official docs not retrieved. — [azukiazusa](https://azukiazusa.dev/en/blog/enable-claude-code-tool-search-to-reduce-mcp-token-usage) (search summary); [Towards AI](https://pub.towardsai.net/claude-code-tool-search-nearly-halves-your-context-bill-a14defdf42f3) (search summary)
- Prompt caching rules (Q2): tool changes invalidate everything; the order is tools → system → messages; 5-minute TTL refreshed on use. — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Routing: Anthropic positions Haiku for "classification, extraction, and routing" and as the speed pick with `effort: low`. — [Anthropic: Reducing latency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency)
- In a voice agent, a cheaper LLM for simple queries is a standard pipeline lever. — [LiveKit: pipeline vs realtime](https://livekit.com/blog/realtime-vs-cascade)

### Inferences
- **Sonnet is the wrong default for voice.** ARES's default brain model is `sonnet`, so every unrouted turn probably pays seconds of TTFT, plus a large Claude Code and MCP prompt. Two changes would likely cut ~0.5–2 s from typical conversational turns: route chat, short Q&A and simple tool asks to Haiku 5.5 at low effort, and keep Sonnet 5.5 / Opus 5.5 for real reasoning. Verify with A1 numbers.
- **Prefix stability is the cheapest win.** Since tool-definition changes invalidate the whole cache, ARES must keep its MCP tool list and system prompt byte-stable for the session's life: no per-turn edits to tools or `--append-system-prompt`. Context belongs in user messages.
- **A cold cache after idle is likely.** A voice assistant is used in bursts. After more than 5 idle minutes the next turn probably pays a cache write on 30–80k tokens. Whether a keep-warm ping is possible through Claude Code is uncertain: there's no `max_tokens: 0` in the CLI, and a ping turn would pollute the session. Measure cold vs warm TTFT before engineering this.
- **Effort and router changes are config-level.** ARES runs `--effort low` already. The model/effort mix per route is the remaining config-level lever. `/model` and `/effort` can be switched inside a live `-p` session (v2.1.205+), but switching effort mid-session invalidates message caches, so per-turn switching may cost more than it saves.

### Gaps
- No controlled measurement of Claude Code headless TTFT (warm, cached) vs a direct Messages API call with the same prompt.
- No published TTFT numbers yet for Haiku 5.5 or Sonnet 5.5 at low effort.
- Whether Claude Code's cache prefix stays stable across turns in a long-running `--input-format stream-json` session wasn't verified (the Systima claim is a summary).

---

## Q7 (objective). Concrete recommendations for ARES

### Takeaway
The likely 3–4.5 s turn can probably drop to about 1.0–1.5 s for brain turns and about 0.5–0.8 s for local intents without changing platforms. Most of the gain comes from three changes:
1. Endpointing: 1.3 s fixed silence → VAD ~0.2 s + Smart Turn, saving ~0.8–1.0 s.
2. TTS: per-sentence HTTPS `eleven_v3` → `eleven_v4_turbo` over a persistent dialogue WebSocket fed with streamed LLM deltas, saving ~0.5–0.8 s.
3. Brain: routing quick turns to Haiku 5.5 at low effort with a byte-stable, slimmer prompt prefix, saving ~0.5–2 s.

Preemptive generation, a spoken preamble before tools, and background delegation for slow work handle the rest. Every number above is an estimate to confirm with the A1 per-stage log.

### Cited Findings
Each step below is tied to its supporting evidence; the sources are in Q1–Q6.

1. **Instrument first** (docs/voice-prompt.md A1).
   - Log `speech_end(VAD)`, `endpoint`, `final_transcript`, `router_decision`, `brain_spawned/turn_sent`, `first_text_delta`, `first_clause_ready`, `tts_ws_first_audio`, `first_sample_played`, plus `tool_use_start/end`.
   - Report p50 and p90/p95, cold and warm. Keep logging per stage and change one factor at a time.
   - Supported by: the Pipecat breakdown schema; OpenAI's stage list and guidance.
2. **Endpointing.**
   - Replace `endSilence = 1.3 s` with VAD stop ~0.2 s → Smart Turn v3 (~12 ms CPU, 8 MB ONNX) → end of turn.
   - Keep a hard cap of ~2.5–3 s (LiveKit `max_delay` 3.0 s) and the current rule as fallback.
   - Supported by: Daily's ~250 ms decision; Pipecat VAD 0.2 s + Smart Turn; LiveKit defaults. Details and tuning are in the sibling note.
3. **Preemptive brain generation, LLM only.**
   - Start the Haiku fast-path call when the transcript is final or Smart Turn is confident.
   - Cancel if the transcript changes; skip utterances over 10 s; at most 3 retries per turn.
   - Never start ElevenLabs before the turn is confirmed.
   - Supported by: LiveKit preemptive generation defaults (`preemptive_tts` False); Deepgram eager EOT (+50–70% LLM calls).
4. **TTS.**
   - Move conversational replies to `eleven_v4_turbo` on `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`.
   - Open the socket as soon as a turn starts (or keep it alive with `keep_alive` during a conversation), and stream each `text_delta` as it arrives.
   - `flush` at the end of the reply. Use `new_turn` only between replies, not between sentences.
   - Check that Katherine works on v4 and which PCM formats the socket offers.
   - Confirm the serving region via `x-region`, or pin the nearest regional host.
   - Fallback 1: `eleven_flash_v2_5` on the classic stream-input socket with a smaller first `chunk_length_schedule` value (≥50) or `auto_mode`.
   - Fallback 2: Kokoro (local, existing).
   - Keep the existing hedging and first-audio deadline.
   - Test with Kokoro or a mock, and only a handful of real lines with the owner's go (CLAUDE.md credit rule).
   - Supported by: ElevenLabs models page, changelog, TTD guide, pricing; Vapi v3 758 ms; AA Elo 1332 vs 1174.
5. **Brain routing and prompt hygiene.**
   - Routing:
     - intent.js/router.js answers local commands (no brain).
     - Quick chat and simple asks go to Haiku 5.5, `--effort low`.
     - Normal questions go to Sonnet 5.5 at low effort; Opus 5.5 is reserved for hard or long work.
   - Prompt prefix:
     - Keep tools and system prompt byte-identical for the life of each session process.
     - Trim ARES's MCP tool list for the voice session, or enable tool search, to shrink the 30–80k-token prefix.
   - Spoken length: ask for "answer first, one or two short sentences" by sentence count.
   - Supported by: Anthropic models overview, Haiku 5.5 page, reduce-latency guide, prompt caching invalidation rules, Systima overhead, tool-search measurement.
6. **No dead air around tools.**
   - Prompt the brain to say one short spoken line *before* any tool call.
   - If a `tool_use` block starts with no text spoken yet, play a cached acknowledgment ("One sec.") once.
   - If a tool runs past ~5 s, one "still on it" line; never repeat fillers on quick answers (v2 B6).
   - Supported by: Daily's pre-function message and watchdog; LiveKit filler (5 s delay, 10 s interval, ≤3); the mer.vin tool-call silence measurement.
7. **Slow work goes to the background.**
   - Use ARES's existing jobs as LiveKit-style async delegation. The voice turn acknowledges at once ("I'll look into it and tell you"); the job's result is spoken later as a follow-up.
   - Interrupting her speech shouldn't silently cancel the job (GPT-Live's rule).
   - Supported by: LiveKit subagent delegation; OpenAI GPT-Live client delegation.
8. **Small wins.**
   - Prefer the built-in mic and speakers over Bluetooth for latency tests.
   - Reuse connections.
   - Pre-render the phrase cache for acknowledgments in the same voice and model as live replies, so the timbre matches.
   - Supported by: Daily's Bluetooth note; ElevenLabs latency guide.

### Inferences
**Projected warm budget after the changes** (estimate to verify):

| Stage | Estimate |
|---|---|
| VAD + Smart Turn | ~0.25–0.45 s |
| Apple STT final | ~0.05–0.2 s |
| Haiku 5.5 TTFT via a warm Claude Code session | ~0.6–1.0 s |
| first ~40 chars | ~0.05–0.15 s |
| v4 Turbo first audio | ~0.15–0.3 s |
| output | ~0.02 s |
| **Total** | **≈1.1–2.0 s** |

- Hitting under 1 s on brain turns needs preemptive generation to overlap the endpoint window.
- Local intents with a cached phrase can land at ~0.4–0.7 s.

**Options considered and not recommended now:**
- A cloud S2S front-end (GPT-Live delegation, Gemini Live): it conflicts with "brain must stay Claude", sends audio off the Mac, and loses Katherine.
- A local S2S model (Moshi): too weak as a brain.
- Switching to Pipecat or LiveKit wholesale: transport ARES doesn't need.
- `--bare`: it can't use the subscription login.

**Risks:**
- The ElevenLabs TTD WebSocket is beta and limited to one voice per v4 Turbo connection.
- v4 needs re-checking for Katherine and her audio-tag handling.
- Preemptive turns in a stateful Claude Code session can pollute history. Keep speculation on a stateless fast path, or only send when the end of turn is confident.

### Gaps
- Real ARES per-stage numbers don't exist yet (A1). Every saving above is an estimate from vendor and third-party figures.
- Whether a second, stateless Claude Code process (Haiku, same tools) for preemptive or fast-path turns stays within subscription usage limits and keeps memory consistent with the main session needs a design decision and a test.
