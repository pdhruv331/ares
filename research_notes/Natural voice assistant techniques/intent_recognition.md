# Intent Recognition and Spoken Language Understanding for an LLM-Era Voice Assistant (ARES)

Research date: 2026-10-08. Scope: how a modern voice assistant should turn speech into intent (architectures, fast paths, ASR-error robustness, context/follow-ups, evaluation), with recommendations for ARES (Apple on-device ASR → local embedding intent layer + router → Claude via Claude Code headless with MCP tools).

Source-quality note: Apple/Amazon/Google publish little about production routing. Much of what follows on Siri and Alexa+ comes from press coverage and secondhand talk summaries, and is flagged as such. Vendor benchmarks (Picovoice, Google) have not been independently replicated.

---

## 1. Architectures in 2024–2026: pure LLM tool calling vs hybrid (fast local path + LLM fallback); how Siri, Alexa+ and Gemini do it

### Takeaway
Every shipping system with published detail is hybrid. A cheap, deterministic or near-deterministic layer handles a closed set of frequent commands, and an LLM (often chosen by a router among several models) handles the open-ended rest through typed tools/"experts"/App Intents. Pure LLM tool calling is the right fallback but a poor first hop for "set a timer" because of latency, cost and nondeterminism. Home Assistant's "Assist first, LLM fallback" is the closest public analogue to ARES.

### Cited Findings
**Home Assistant Assist (open source, closest analogue to ARES)**
- Assist, HA's "home-grown (non-AI) voice assistant agent", handles a predetermined list of mostly home-control commands first by default; "only questions or commands it can't understand will be sent to the AI you've set up". Example: "Turn on the kitchen light" stays local, "It's dark in the kitchen, can you help?" goes to the LLM. HA says this "speeds up response times for simple commands" but publishes no intent-matching timings — [HA blog, Sept 2025](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)
- The behaviour is a per-assistant toggle, "Prefer handling commands locally"; locally matched replies skip the LLM (fast, but without the LLM's personality); turning it off sends every request to the chosen agent — [HA docs: Create a personality with AI](https://home-assistant.io/voice_control/assist_create_open_ai_personality)
- The debug view shows a "Processed locally: true" field; one user wrongly believed their Qwen model answered everything — [HA community forum](https://community.home-assistant.io/t/prefer-handling-commands-locally-does-not-seem-to-work/1016858)
- Reported bug (core-2026.2.1): after a locally handled command, a corrected follow-up gets stuck in LLM follow-up mode and stops re-checking local intents — [GitHub issue #162768](https://github.com/home-assistant/core/issues/162768)
- HA shares recent commands with the LLM agent so "Add milk to my shopping list" → "Add rice" works; if the LLM asks a question the device keeps listening; HA can start conversations (e.g. asking whether to close an open garage door) — [HA blog](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)
- Streaming TTS of LLM replies started speaking in 0.56 s vs 5.31 s non-streaming (Ollama gemma3:4b on an RTX 3090, Piper on an i5). HA's Home LLM Leaderboard reports local models using ≥8 GB VRAM "are nearly keeping up" with big cloud models, and includes an "assist-mini" test for small local LLMs — [HA blog](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)
- A community HACS add-on, "Assist Canonicalizer", normalizes natural-language commands into canonical forms before the built-in matcher, with a fallback LLM agent (unverified community claims) — [HA community](https://community.home-assistant.io/t/assist-canonicalizer-improve-voice-assistant-accuracy-for-natural-device-control-with-instant-local-feedback/1014170)

**Amazon Alexa+ (launched Feb 2025)**
- Alexa+ runs on Amazon Bedrock, using Amazon Nova models and models from Anthropic; Amazon calls it "model agnostic" with a routing system that matches each request to the best model while keeping the conversation natural — [TechCrunch](https://techcrunch.com/2025/02/26/amazon-says-that-alexa-is-model-agnostic)
- Alexa+ uses "experts" (bundles of systems, capabilities, APIs and instructions for a task domain) that orchestrate Amazon and third-party services; "tens of thousands" of devices and services at launch — [TechCrunch](https://techcrunch.com/2025/02/26/amazon-says-that-alexa-is-model-agnostic); [Constellation Research](https://www.constellationr.com/insights/news/amazons-alexa-gets-brain-transplant-showcases-amazon-bedrock-nova)
- CNBC (unnamed sources) reported Claude powers most complex tasks; Amazon replied that Nova handled over 70% of conversations in the prior four weeks and "Alexa+ is always using the best model for each task" — [NBC/CNBC](https://www.nbcconnecticut.com/news/business/money-report/amazons-most-powerful-new-alexa-features-being-powered-by-anthropics-ai-sources-say/3509896/)
- A secondhand summary of an Alexa team talk lists four core challenges: accuracy, latency, determinism and model flexibility; routing among tools, experts and agents (e.g. notification vs reminder vs calendar expert) was the first accuracy problem — [ZenML LLMOps database summary](https://www.zenml.io/llmops-database/transforming-a-voice-assistant-from-scripted-commands-to-generative-ai-conversation-at-scale) (secondhand; original talk not identified)

**Apple Siri / Apple Intelligence**
- WWDC 2024 promised three Siri upgrades: personal context, on-screen awareness and in-app actions. Personal context reportedly uses an on-device knowledge graph about the user; third-party apps must adopt App Intents to be controllable — [Cult of Mac](https://www.cultofmac.com/news/7-exciting-features-to-expect-from-siris-2026-ai-upgrade); [Macworld](https://www.macworld.com/article/2958711/apple-confirms-its-next-gen-siri-is-on-track-to-launch-in-2026.html)
- The iOS 18 launch was delayed because "the underlying architecture wasn't good enough" — [Thurrott](https://www.thurrott.com/a-i/334152/apple-to-unveil-the-new-siri-at-wwdc-2026-in-june); features then slipped past iOS 26.4 toward iOS 26.5 / iOS 27 — [9to5Mac](https://9to5mac.com/2026/01/10/heres-what-to-expect-with-siri-and-apple-intelligence-in-the-coming-months/); [Heise](https://heise.de/-11154521)
- Apple and Google announced on 2026-01-12 a collaboration to upgrade Siri/Apple Intelligence with Gemini; Heise reported Google would not receive user data because it runs on Apple's own cloud — [Heise](https://heise.de/-11154521)
- At WWDC (2026-06-08) Apple unveiled "Siri AI", a rebuilt assistant built in partnership with Google's Gemini: standalone app on iPhone/iPad/Mac/Watch/Vision Pro, on-screen awareness, personal-context search across messages and photos, iCloud-synced conversation history; dev beta immediately, public beta July, GA in the fall with iOS 27; not initially in the EU (iPhone/iPad) or China — [LetsDataScience](https://letsdatascience.com/news/apple-unveils-gemini-powered-siri-and-ios-27-at-wwdc-2026-b757953c); [Snappr news](https://www.snappr.com/news/story/apple-opens-wwdc-2026-with-the-release-of-siri-ai). Sources conflict on how much is Gemini: "powered in part by Gemini" vs a blog claim that it runs entirely on a licensed 1.2-trillion-parameter Gemini model — [Pasquale Pillitteri live blog](https://pasqualepillitteri.it/en/news/4513/apple-wwdc-2026-siri-gemini-ios-27-live) (treat the 1.2T figure as unverified)
- iOS 27: App Intents let users act in third-party apps through Siri or Spotlight without opening them — [Braze](https://www.braze.com/resources/articles/2026-wwdc-ios-27-updates); a developer blog claims SiriKit is deprecated and App Intents is the only route for Siri into third-party apps (not confirmed against Apple docs) — [theswiftk.it](https://theswiftk.it.com/blog/ios-27-siri-extensions-developers-wwdc-2026); pre-WWDC reports of a "Siri Extensions" feature for outside models on iOS/macOS 27 — [MacRumors](https://www.macrumors.com/2026/05/26/ios-27-siri-app-rumor/) (not confirmed post-keynote)

**On-device LLM layer (Apple Foundation Models framework, iOS/macOS 26)**
- Gives apps the ~3B on-device model; Apple says it suits summarization and entity extraction and "is not designed to be a chatbot for general world knowledge" — [Apple Intelligence Foundation Language Models Tech Report 2025](https://arxiv.org/pdf/2507.13575); [Apple ML Research 2025 update](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)
- Details in Q2 below.

### Inferences
- Consensus pattern (HA, Alexa+, Siri/App Intents): **closed-set fast path → typed action vocabulary → LLM orchestrator**, with the LLM calling the same typed actions the fast path calls. ARES already has this shape (intent layer → router → Claude with MCP tools). The win is making the fast path and the LLM share **one action registry** (same function names, slot schemas, tiers), so a fast-path hit and an LLM tool call execute identical code and log identically.
- Alexa's four named challenges (accuracy, latency, determinism, model flexibility) map directly onto why a fast path exists: determinism and latency for frequent commands, LLM for flexibility.
- HA's bug (follow-ups stuck in LLM mode) is a design lesson: the router must re-evaluate every turn, and a pending LLM follow-up state should not disable the fast path for unrelated commands.

#### Recommended design for ARES (synthesis of all sections)
1. **Tier 0, deterministic grammar** for the very hot set (timers, volume, brightness, media, "stop", power words). Template/regex parsing with real slot parsers (numbers, durations, relative times). Microseconds, fully deterministic, testable. This is what HA Assist's sentence templates do (template mechanics not covered in the fetched HA blog).
2. **Tier 1, embedding kNN / semantic router** (current ARES layer) for paraphrase coverage of the same closed set: per-route example phrases, **per-route thresholds plus a top-1/top-2 margin**, and explicit **negative examples** (near-miss phrasings that must go to the LLM). Fires only for low-risk, reversible actions whose slots it can fill deterministically; otherwise falls through. A false fast-path fire is worse than a miss, since a miss only costs latency.
3. **Tier 2, optional on-device structured extraction** with Apple's Foundation Models (`@Generable` enum of ARES fast intents + slot struct) for mid-confidence cases or slot extraction the grammar can't do ("remind me after my 3 o'clock to call mum"). Only if measured latency, prewarmed, fits the budget (see Q2: schema compilation can dominate). It must be able to output `none`/`needs_llm`.
4. **Tier 3, Claude** for everything else, given the resolved context (see Q5) and the same action registry as MCP tools.
5. **Route by risk as well as confidence.** Map ARES's existing tiers: the fast path may only *execute* tier-1 actions; tier-2/3 actions always go through the LLM + bridge confirmation path even when the classifier is certain.
6. **Speculative start (optional):** when tier 1 is uncertain, begin warming the Claude path (connection/process prewarm, not a billed request) in parallel so the fallback costs less wall-clock.

### Gaps
- No primary Apple, Amazon or Google engineering description of production intent routing (thresholds, share of traffic on fast paths, latency budgets) was found. Alexa+ details come from press and a secondhand talk summary.
- Google Gemini (as the Android assistant replacing Google Assistant) architecture: no published detail on how it routes device commands vs LLM was found in this research.
- Whether iOS 27 / macOS 27 has shipped GA as of 2026-10-08, and whether "Siri Extensions" shipped, was not confirmed.
- HA's hassil/sentence-template matcher internals and any stats on the share of commands handled locally were not found in the sources fetched.

---

## 2. Fast-path options: semantic routers, sentence embeddings, small classifiers / small LMs, Picovoice Rhino, Apple Foundation Models; latency and accuracy

### Takeaway
For ARES's closed command set, a local embedding router (single-digit-ms embeddings with a small model such as EmbeddingGemma, kNN over example phrases, calibrated thresholds) is the best latency/accuracy trade-off. Apple's ~3B Foundation Models with guided generation is a strong, free, private slot extractor but costs roughly hundreds of ms to seconds, so it suits a second-stage role, not the first hop. Tiny function-calling LMs (FunctionGemma 270M) need fine-tuning to be reliable. Rhino is excellent for fixed grammars in noise but is proprietary and redundant given ARES already has ASR.

### Cited Findings
**Aurelio semantic-router (Python, open source)**
- Routes are lists of example utterances; utterances and incoming queries are embedded and the closest route wins; a router = encoder + index + routes — [Aurelio docs: intro](https://docs.aurelio.ai/semantic-router/get-started/introduction.md); [architecture](https://docs.aurelio.ai/semantic-router/user-guide/concepts/architecture)
- Advertised "routing decisions in milliseconds rather than seconds"; a third-party listing claims ~4 ms vs seconds for an LLM round trip but also "sub-millisecond", so the figures conflict; no official benchmark found — [Aurelio docs](https://docs.aurelio.ai/semantic-router/get-started/introduction.md); [dev.co listing](https://dev.co/ai/frameworks/aurelio-labs-semantic-router)
- Dynamic routes generate parameters and trigger function calls but require an LLM in the route layer — [sourcepulse summary](https://www.sourcepulse.org/projects/1660168); [everydev llms.txt](https://www.everydev.ai/tools/semantic-router/llms.txt)
- Encoders: cloud (OpenAI, Cohere, Jina, Voyage, Mistral, NVIDIA, Bedrock, Aurelio) and local (sentence-transformers, Ollama, Hugging Face, FastEmbed); indexes: Pinecone, Qdrant, pgvector, local in-memory; `HybridRouter` combines dense and sparse vectors — [everydev llms.txt](https://www.everydev.ai/tools/semantic-router/llms.txt)
- Main class renamed from `RouteLayer` to `SemanticRouter`; versions reported as v0.1.15 (2026-05-23) or 0.1.16, ~3.7k stars (snapshots vary) — [Aurelio docs guide](https://docs.aurelio.ai/semantic-router/user-guide/guides/semantic-router); [sourcepulse](https://www.sourcepulse.org/projects/1660168)

**Small embedding models**
- EmbeddingGemma (Google, 308M = ~100M model + ~200M embedding parameters) is the top open multilingual embedding model under 500M parameters on MTEB, comparable to models nearly twice its size; runs in <200 MB RAM quantized; Matryoshka output truncatable from 768 to 512/256/128 dims — [Google Developers Blog](https://developers.googleblog.com/introducing-embeddinggemma/); [DeepMind model page](https://deepmind.google/models/gemma/embeddinggemma/)
- A secondary summary reports it ranks 8th overall on MTEB (Multilingual, v2), 17 places above the next sub-500M model — [Liner review](https://liner.com/review/embeddinggemma-powerful-and-lightweight-text-representations); a blog lists 64.12 vs E5-small-v2 62.53 and BGE-small 61.22 (MTEB variant unspecified) — [dritestudio](https://dritestudio.co.th/en/article/embeddinggemma)
- LiteRT benchmark (Samsung S25 Ultra, mirrored model card): NPU mixed precision ~7.8 ms at 256 tokens, 18 ms at 512; GPU ~64 ms at 256 tokens; NPU init 200–470 ms — [HF mirror of model card](https://huggingface.co/bmabir17/embeddinggemma-300m) (third-party mirror; no Apple Silicon numbers)
- No intent-classification benchmark for EmbeddingGemma was found; Google claims general strength in classification/clustering — [Google Developers Blog](https://developers.googleblog.com/introducing-embeddinggemma/)

**Small function-calling LMs**
- FunctionGemma (270M, Google): base model 58% accuracy on Google's "Mobile Actions" eval, 85% after fine-tuning — [DeepMind FunctionGemma page](https://deepmind.google/models/gemma/functiongemma/); [InfoQ, Jan 2026](https://infoq.com/news/2026/01/functiongemma-edge-function-call)
- Model card: "not intended for use as a direct dialogue model" and should be fine-tuned on task-specific single/multi-turn data — [HF ONNX card](https://huggingface.co/onnx-community/functiongemma-270m-it-ONNX); Google provides a Mobile Actions fine-tuning Colab and dataset — [Google blog](https://blog.google/technology/developers/functiongemma/); on-device demo in AI Edge Gallery — [Google Developers Blog](https://developers.googleblog.com/on-device-function-calling-in-google-ai-edge-gallery/)
- Reported footprint ~288 MB, 551 MB RAM (unverified) — [Medium GDE post](https://medium.com/google-developer-experts/on-device-function-calling-with-functiongemma-39f7407e5d83); a Sept 2026 paper adapts the 270M model to practical mobile control with a small schema-grounded dataset — [arXiv 2609.25373](https://arxiv.org/pdf/2609.25373) (accuracy numbers not retrieved)

**Apple Foundation Models framework (on-device ~3B, iOS/macOS 26)**
- ~3B parameters; decoder weights 2-bit via quantization-aware training, 4-bit embeddings, 8-bit KV cache; KV-cache sharing cuts KV memory 37.5% and improves time-to-first-token; speculative decoding; 15 languages — [Apple ML Research 2025 update](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)
- Guided generation: `@Generable` macro on Swift structs/enums → compiler produces a format spec injected into the prompt; model post-trained on that format; an OS daemon applies constrained + speculative decoding; framework returns typed Swift values — [Apple ML Research](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates); [Tech Report 2025](https://arxiv.org/pdf/2507.13575)
- Tool calling: implement the `Tool` protocol; the framework handles parallel and serial tool calls; model post-trained on tool-use data — [Apple ML Research](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)
- Rank-32 LoRA adapters via a Python toolkit; adapters must be retrained for each new base-model version (Apple advises exploring the base model first) — [Apple ML Research](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)
- Human-grader comparisons: on-device model favorable vs Qwen-2.5-3B, competitive in English with Qwen-3-4B and Gemma-3-4B — [Apple ML Research](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)
- Availability depends on whether the device and region support Apple Intelligence (check at runtime); Apple updates the model in OS updates — [Apple docs: SystemLanguageModel](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel.md)
- Latency: a developer saw 20+ s for a structured recipe result (vs 4 s cloud); the delay was **schema compilation**, not token generation. Apple DevRel: expect roughly 20–30 tokens/s or file feedback; use `prewarm` and `includesSchemaInInstructions` where appropriate; profile with the Foundation Models instrument in Instruments — [Apple Developer Forums thread 791993](https://developer.apple.com/forums/thread/791993)
- Third-party estimate 70–86 tokens/s on iPhone 17 Pro (derived indirectly from text length) — [iThinkDiff / DeviceMark](https://www.ithinkdiff.com/apple-foundation-model-iphone-llm-benchmark/); Apple's earlier figure of 30 tokens/s with further speedups from token speculation (hardware not stated) — [TechRadar](https://www.techradar.com/pro/our-models-are-preferred-by-human-graders-how-apples-foundation-models-are-coming-on-top-of-established-rivals-on-device-or-server-based-responses-indicate-apple-is-already-competitive)
- No published Mac (M-series) TTFT/tokens-per-second benchmark of `SystemLanguageModel` was found; open-model Apple Silicon benchmarks (llama.cpp/MLX, Q4_K_M) exist but aren't comparable — [llmcheck.net benchmarks](https://llmcheck.net/benchmarks)

**Picovoice Rhino (speech-to-intent)**
- Vendor benchmark (coffee-maker VUI, 600+ commands, 50+ speakers, 6–24 dB SNR): average command acceptance Rhino 97.3%, Amazon Lex 84.3%, Google Dialogflow 77.3%; at 6 dB SNR 94% / 76% / 67% — [Picovoice NLU benchmark](https://picovoice.ai/docs/benchmark/nlu); "5.5x fewer errors than Dialogflow" in high noise — [Picovoice voice-dialing cookbook](https://picovoice.ai/cookbook/voice-dialing/)
- Benchmark audio, code and models published under Apache 2.0 (repo speech-to-intent-benchmark); running Rhino needs a Picovoice AccessKey — [Picovoice benchmark page](https://picovoice.ai/docs/benchmark/nlu-picovoice-rhino/)
- FAQ claims >99% in clean conditions and 97% at 9 dB SNR — [Picovoice Rhino FAQ](https://picovoice.ai/docs/faq/rhino/)
- Picovoice attributes the gain to jointly optimized end-to-end intent inference vs the two-stage ASR→NLU design of Lex/Dialogflow/Watson/LUIS — [Picovoice blog](https://picovoice.ai/blog/end-to-end-intent-inference-from-speech/); the dates of the Lex/Dialogflow runs are not given, so the cloud comparison may be stale (legacy Dialogflow-era baselines).

### Inferences
- **Embedding router for ARES:** semantic-router is Python-only. ARES is Electron/Node plus Swift helpers, so the practical route is to reimplement the same idea (it is ~100 lines: embed examples once, cosine kNN, per-route threshold) in Swift with Core ML/MLX or in Node with ONNX Runtime/transformers.js, using a small local encoder (EmbeddingGemma at 256 dims, or a MiniLM/BGE/E5-small class model). At ARES's scale (hundreds of example phrases), a brute-force in-memory index is enough; no vector DB needed.
- Use **kNN over individual examples, not route centroids**, and require both an absolute similarity threshold and a margin over the runner-up route. Calibrate the thresholds on a personal test set (Q6). Add a `none` route populated with near-miss phrases.
- **Apple Foundation Models as tier 2:** a short `@Generable` output (intent enum + 2–4 slots ≈ 20–40 tokens) at the 20–30 tok/s DevRel floor is ~1–2 s plus TTFT; at the faster third-party estimates it is a few hundred ms. Prewarm the session at ARES start and keep it alive; measure on the user's Mac. Avoid LoRA adapters (retraining per OS model update is a maintenance trap for a personal project); prompting with few-shot examples and a closed enum is enough. Constrained decoding means the output is always a valid ARES intent struct.
- FunctionGemma-class models are only worth it if fine-tuned on ARES's own action registry. Apple's FM gives similar capability with no download, no fine-tuning and OS-managed memory, so on macOS 26 it dominates for this role (when Apple Intelligence is enabled).
- Rhino: not recommended for ARES. It duplicates the ASR it already has, requires a proprietary AccessKey, and needs a hand-authored grammar per context. Its niche (very noisy, fixed grammars, tiny devices) isn't ARES's.

### Gaps
- No apples-to-apples benchmark of semantic-router vs a fine-tuned small classifier vs a 3B LLM on the same intent set was found.
- No Apple Silicon latency figures for EmbeddingGemma or other small embedders, and no Mac-specific Foundation Models TTFT/throughput numbers. These must be measured locally.
- semantic-router's license and Picovoice Rhino's current pricing/free-tier terms and macOS arm64 support were not confirmed in this research.
- Legacy note: Snips NLU and Dialogflow/LUIS-style intent+slot NLU are pre-LLM designs. No 2024–2026 sources recommending them were found.

---

## 3. End-to-end SLU (speech-to-intent from audio) vs ASR-then-NLU; when each wins

### Takeaway
On published benchmarks, end-to-end SLU only matches or beats cascades with heavy speech pretraining and in closed domains. The ASR→text→NLU/LLM cascade stays the practical default, especially when a strong LLM sits downstream and personal entities matter. E2E wins for fixed grammars in noise on tiny devices (Rhino) and when prosody carries meaning.

### Cited Findings
- STOP dataset paper (Meta, 2022): E2E SLU can exploit acoustic cues (prosody, rhythm) lost in cascades and avoids error cascades, but initial E2E models performed slightly worse than cascaded counterparts; audio and ASR pretraining were important for competitiveness — [STOP, arXiv 2207.10643](https://arxiv.org/pdf/2207.10643)
- WhiSLU (Whisper-based E2E, Interspeech 2023) reports gains on STOP of 10% over E2E baselines and 5% over cascades (absolute vs relative not stated); the authors note the pretraining and SLU solution spaces differ, which makes it hard for E2E to beat cascades — [ISCA Interspeech 2023](https://www.isca-archive.org/interspeech_2023/wang23ga_interspeech.html)
- A STOP-challenge entry combining E2E and pipeline systems (Whisper + BART) reached 80.8 exact-match accuracy — [arXiv 2305.01620](https://arxiv.org/abs/2305.01620v2)
- SLURP intent accuracy (E2E): wav2vec2 with ASR pretraining 87.38%, with speech-translation pretraining + joint training up to 89.59%; Whisper fine-tuned E2E only 80.39% (attributed to its training tasks and 30-s chunks vs SLURP's short utterances); published baselines range 86.3% (ESPnet-SLU) to 91.43% (CIF-PT) — [arXiv 2305.09652](https://arxiv.org/pdf/2305.09652)
- "Cascade Equivalence Hypothesis" (2026 study, via a third-party overview): for text-sufficient tasks an E2E speech LLM behaves like an ASR→LLM cascade with the same LLM backbone (e.g. Ultravox vs a Whisper-large→Llama-3.1-8B cascade); equivalence is "a spectrum, not binary" — [alphaXiv overview of 2602.17598](https://www.alphaxiv.org/overview/2602.17598) (secondary summary; original not read)
- Rhino (E2E, closed grammar) vs cascaded cloud NLU in noise: 94% vs 76%/67% at 6 dB SNR (vendor data) — [Picovoice NLU benchmark](https://picovoice.ai/docs/benchmark/nlu)
- τ³-bench extends τ²-bench with voice/audio-native evaluation — [EvalScope τ³-bench docs](https://evalscope.readthedocs.io/en/latest/benchmarks/tau3_bench.html)

### Inferences
- For ARES, intent is almost always "text-sufficient" (commands, questions), so per the cascade-equivalence finding there is little to gain from audio-native understanding for intent. The cascade also gives a transcript for logs, subtitles, n-best rescoring and entity correction, all of which ARES needs.
- Where audio carries meaning ARES can't get from text (question vs statement intonation, hesitation, end-of-turn detection, addressee detection in desk mode), use acoustic side-channels (prosody, end-pointing, voiceprint) next to the cascade rather than replacing it with E2E SLU.
- Revisit if a local, Apple Silicon-friendly speech-LLM with tool calling becomes good enough. Out of scope here; it would mostly help latency (skipping the final-transcript wait), not accuracy.

### Gaps
- No head-to-head SLURP/STOP comparison of a modern cascade (Whisper/Apple SpeechAnalyzer → LLM) against E2E speech LLMs was found.
- Most E2E-vs-cascade numbers are 2022–2023 (pre-speech-LLM) and should be treated as older evidence.

---

## 4. Robustness to ASR errors: n-best/confidence, fuzzy and phonetic entity matching (contacts, apps), confirmation/clarification that doesn't annoy

### Takeaway
The highest-leverage fixes are: (1) resolve named entities (contacts, apps, files, playlists) against the user's own lists with phonetic + character fuzzy matching and pass the LLM only a short candidate list; (2) feed n-best hypotheses or low-confidence spans to the LLM rather than a single transcript; (3) confirm only when risk × uncertainty is high. LLM generative error correction over n-best lists is well established (2023–2025), and personal-name retrieval gives very large entity-error reductions.

### Cited Findings
**LLM error correction over n-best**
- HyPoradise (NeurIPS 2023 D&B): first open benchmark for LLM-based ASR error correction using n-best lists (>316k pairs per abstract, >334k in a later version); LLMs can recover tokens missing from the whole n-best list, going beyond rescoring — [arXiv 2309.15701](https://arxiv.org/abs/2309.15701v2)
- Amazon (Yang et al., 2023): frozen LLM with in-context learning for rescoring rivaled domain-tuned LMs on out-of-domain ATIS/WSJ; adding fine-tuning pushed WER below the n-best oracle — [arXiv 2309.15649](https://arxiv.org/pdf/2309.15649)
- Cambridge (Ma et al., 2023): ChatGPT correction (unconstrained and constrained-to-n-best, zero/1-shot) improved two ASR architectures across test sets — [arXiv 2307.04172](https://arxiv.org/abs/2307.04172)
- ClozeGER (2024): a multimodal LLM gets the audio plus the n-best list and fills in the "cloze" segments where hypotheses disagree — [arXiv 2405.10025](https://arxiv.org/html/2405.10025v1)
- Interspeech 2025 (Yamashita et al.): generative correction struggles with rare/domain words and over-corrects when it ignores phonetics; combining n-best with phonetic context plus synthetic rare-word data reduced WER/CER in English and Japanese — [arXiv 2505.17410](https://arxiv.org/abs/2505.17410v1)

**Personal entity matching**
- Apple (2024): personal names (e.g. contacts) remain hard for LLM-based recognition; the method has the LLM spot names without context, uses them as keys for **phonetic retrieval** from the personal database, then decodes again with retrieved candidates. Up to 30.2% relative WER reduction and **73.6% relative named-entity error reduction** in a voice-assistant task, without putting the whole name list in the prompt — [arXiv 2409.15353](https://arxiv.org/html/2409.15353v1)
- Raghuvanshi et al. (EMNLP 2019 demo, older): character- and phoneme-based IR plus context to fix mistranscribed colleague names in a voice-calling assistant; +40.8% accuracy on their production system — [ACL Anthology D19-3011](https://preview.aclanthology.org/setup/D19-3011)
- Apple STEER+ (via author page snippet): uses a semantic parse tree to give context for out-of-vocabulary words such as named entities at sentence boundaries, most helpful in entity-heavy domains like messaging — [ACL Anthology author page](https://preview.aclanthology.org/alta-23-ingestion/people/j/jiarui-lu/)

**Confirmation/abstention**
- BFCL includes an irrelevance/hallucination category testing whether a model correctly declines to call any function when no tool fits — [EvalScope BFCL v4](https://evalscope.readthedocs.io/en/latest/third_party/bfcl_v4.html); [Spheron overview](https://www.spheron.network/blog/tool-calling-benchmarks-bfcl-tau-bench-latency-optimization/)

### Inferences
- **Entity resolver as a shared local service** (Swift or Node), used by both the fast path and Claude's MCP tools: index contacts, app names (from /Applications + display names), recent files, calendars and playlists with (a) a phonetic key (Double Metaphone or similar), (b) normalized character n-grams / edit distance, (c) recency/frequency priors. Return top-k with scores. Claude's `send_message`-type tools should take a fuzzy name and return candidates rather than failing on exact match. This applies Apple's 2409.15353 result (retrieve candidates, give the model a short list) without needing an audio-LLM.
- **Feed uncertainty forward:** if the recognizer offers alternatives or per-segment confidence, pass the top 2–3 hypotheses (or mark low-confidence words) to Claude in a compact form ("heard: 'text Shreya' (alt: 'text Shria')"). For the fast path, run the router over each n-best hypothesis and accept only if they agree.
- **Bias the recognizer itself** with the user's vocabulary (contact names, app names, "ARES") wherever the Apple speech APIs allow contextual phrases/custom language models. Fixing at the source beats post-correction.
- **Confirmation policy** (aligned with ARES tiers): reversible, low-risk actions → act and state the result ("Timer, 10 minutes"), which doubles as implicit confirmation and lets the user say "no, 15". Ambiguous entity with two close candidates → one short disambiguation question naming both ("Shreya Patel or Shreya Rao?"). Irreversible/tier-3 → explicit read-back confirm (already ARES's bridge `confirm`). Never confirm high-confidence, low-risk commands; that is what makes assistants annoying.
- **Learn from corrections:** when the user corrects ("no, Shria"), store the alias mapping (heard form → entity) locally. A small personal alias table often beats any model.

### Gaps
- No 2024–2026 user-study evidence on explicit vs implicit confirmation rates/annoyance for LLM voice assistants was found. The confirmation policy above is design inference, not sourced.
- Whether Apple's macOS 26 speech APIs (SFSpeechRecognizer / SpeechAnalyzer) expose n-best alternatives, per-word confidence and contextual-phrase biasing in the mode ARES uses was not verified here (likely covered by the ASR researcher).
- No benchmark numbers for phonetic algorithms (Metaphone vs learned phoneme embeddings) on contact names in English/Indian-name mixes were found.

---

## 5. Context and dialogue: follow-ups, pronouns and ellipsis ("do that again", "send it to her"), dialogue state, short-term memory, personal knowledge; efficient context in LLM assistants

### Takeaway
Two complementary techniques dominate. (1) **Rewrite the follow-up into a self-contained request** (joint coreference + query rewriting, CREAD) so any downstream component, including the fast path, can handle it. (2) **Serialize the relevant non-conversational context** (recent actions, on-screen entities, background tasks) into compact text for the model (Apple ReALM: a small fine-tuned model matches GPT-4 at reference resolution). Production assistants add a persistent personal knowledge graph (Siri's on-device graph) and share recent turns across the local/LLM boundary (HA).

### Cited Findings
- CREAD (Apple, NAACL 2021): anaphora is traditionally handled by coreference resolution and ellipsis by query rewriting; CREAD jointly predicts coreference links between the query and dialogue context and then generates a self-contained rewritten query (GPT-2 based). Coreference modeling improved rewrite F1 by +2.3 on MuDoCo (annotated with rewrites), and the joint model beat a SOTA coreference model by +2 F1; an LSTM baseline failed to restore an implicit location that GPT-2 models recovered — [arXiv 2105.09914](https://arxiv.org/pdf/2105.09914); [Apple ML Research](https://machinelearning.apple.com/research/combined-resolution-of-ellipses) (older, pre-LLM-era but the rewrite pattern carries over)
- ReALM (Apple, 2024): LLMs adapted to resolve references to conversational entities, **on-screen entities** and **background entities**; the screen is encoded as text preserving relative spatial positions; the smallest model performs comparably to GPT-4 and larger ones substantially outperform it, with >5% absolute gains on on-screen references over an existing system; positioned as practical **on-device**. Limits: nuanced positional queries, non-textual on-screen items; focuses on anaphoric/deictic references (bridging left for future work) — [arXiv 2403.20329](https://arxiv.org/html/2403.20329v2); [Apple ML Research](https://machinelearning.apple.com/research/realm-reference)
- Siri's personal context: an on-device knowledge graph about the user used to personalize answers and actions; drawing on mail, messages and web history — [Cult of Mac](https://www.cultofmac.com/news/7-exciting-features-to-expect-from-siris-2026-ai-upgrade); [Macworld](https://www.macworld.com/article/2958711/apple-confirms-its-next-gen-siri-is-on-track-to-launch-in-2026.html); Siri AI (WWDC 2026) adds personal-context search across messages and photos and iCloud-synced conversation history — [LetsDataScience](https://letsdatascience.com/news/apple-unveils-gemini-powered-siri-and-ios-27-at-wwdc-2026-b757953c)
- HA Assist passes recent (locally handled) commands to the LLM agent so elliptical follow-ups ("Add rice") work across the local/LLM boundary; the LLM knows the room and nearby devices of the speaking satellite — [HA blog](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)
- Failure mode: HA follow-up corrections after a local command got stuck in LLM mode — [GitHub #162768](https://github.com/home-assistant/core/issues/162768)
- BFCL v4 added memory and web-search agentic categories — [EvalScope BFCL v4](https://evalscope.readthedocs.io/en/latest/third_party/bfcl_v4.html); Epoch found the memory items had ~70% possible scoring defects — [Epoch AI review](https://epoch.ai/benchmarks/berkeley-function-calling-leaderboard/review)

### Inferences
- **Keep a structured short-term dialogue state in main.js, owned by ARES, not by the LLM transcript:**
  - `lastActions[]`: each executed action (from the fast path *or* an LLM tool call) as `{intent, slots, resolvedEntities, result, ts, undo?}`. This answers "do that again", "undo that", "make it 15 instead", "same for the bedroom".
  - `salience`: the most recent entity per type (person, file, app, event, job, message), updated from both user turns and ARES's replies/tool results ("send it to her" → last file + last female/named person; "open it" → last file/URL shown).
  - `onScreen`: a ReALM-style text serialization of what ARES is currently showing (panel cards, callouts, job orbs) and optionally the front app's Accessibility tree (ARES already reads this via `ares-control`), so deictic references ("that one", "the second email") resolve.
- **Rewrite-then-route:** for short or pronoun-bearing utterances in an active conversation window, first resolve against `lastActions`/`salience` deterministically (cheap rules for "again/undo/louder/another N minutes"), and if needed run a fast rewrite (Apple FM on-device, `@Generable` → `{rewritten: String, needsLLM: Bool}`) before the router. The fast path then handles "and the kitchen too" as "turn on the kitchen light".
- **Give Claude a compact context header** on each turn (last 2–3 actions, salient entities, on-screen summary, time/location) rather than relying only on the growing Claude Code session transcript. That keeps prompts small and makes context survive across fast-path turns Claude never saw (HA's lesson).
- **Re-evaluate routing every turn**: a pending LLM question ("which Shreya?") should capture only replies that look like answers (short, entity-like, within a time window), and anything that matches a fast intent with high confidence should still go to the fast path (avoids HA's stuck-follow-up bug).
- **Personal knowledge**: ARES's existing `memory.add` store plays the role of Siri's knowledge graph. Expose it to the entity resolver (aliases: "mum" → contact, "my project" → path) as well as to Claude.
- ARES privacy rule applies: overheard (non-addressed) speech must never enter dialogue state, salience or rewrite inputs.

### Gaps
- No published numbers on how Alexa+/Gemini/Siri manage conversation-context windows (summarization, eviction, token budgets) were found.
- No 2024–2026 benchmark specifically for LLM-based contextual query rewriting in voice assistants was found (CREAD/MuDoCo is 2021).

---

## 6. Evaluating intent understanding: SLURP, MASSIVE, STOP, BFCL, τ-bench; building a personal test set

### Takeaway
Public SLU datasets (SLURP/MASSIVE/STOP) are useful for seeding paraphrases and sanity checks but don't measure what matters for ARES: precision of the fast path on the owner's own phrasings, entity resolution against personal data, routing correctness, latency, and consistency of LLM tool calls across repeated runs. Tool-use benchmarks contribute two key ideas: irrelevance/abstention tests (BFCL) and pass^k consistency (τ-bench). BFCL's scoring has been audited as flawed.

### Cited Findings
- MASSIVE (Amazon, ACL 2023): ~1M parallel labeled virtual-assistant utterances, 51 languages, 18 domains, 60 intents, 55 slot types, localized from the English SLURP corpus by professional linguists; baselines with XLM-R and mT5 on exact-match, intent accuracy and slot F1; data, code and models openly released — [arXiv 2204.08582](https://arxiv.org/pdf/2204.08582); [ACL 2023](https://preview.aclanthology.org/setup/2023.acl-long.235)
- SLURP E2E intent accuracy results range ~80–91.4% depending on model (see Q3) — [arXiv 2305.09652](https://arxiv.org/pdf/2305.09652)
- STOP: spoken task-oriented semantic parsing (hierarchical parses), exact-match metric; E2E slightly behind cascades in initial baselines — [arXiv 2207.10643](https://arxiv.org/pdf/2207.10643)
- BFCL v4 tests tool selection and argument filling across single-call, multi-turn and agentic tasks, adding web-search and memory tasks over v3; score weights: 10% non-live single-turn, 10% live single-turn, 10% irrelevance, 30% multi-turn, 40% agentic — [Epoch AI review](https://epoch.ai/benchmarks/berkeley-function-calling-leaderboard/review); [EvalScope](https://evalscope.readthedocs.io/en/latest/third_party/bfcl_v4.html) (240 irrelevance, 884 live-irrelevance, 200 multi-turn-base items)
- Epoch rated BFCL "Flawed": 24 of 50 sampled tasks (48%) had defects that could affect accuracy, ranging from 20% (non-live AST) to 70% (memory) — [Epoch AI review](https://epoch.ai/benchmarks/berkeley-function-calling-leaderboard/review)
- Aggregator snapshots (~May 2026): top BFCL v4 overall ~77.47% with ~68.38% multi-turn (garbled table extraction) — [benchmarklist BFCL](https://benchmarklist.com/benchmarks/bfcl/); Amazon Nova 2 Lite 27.1% overall, 2.1% multi-turn — [benchmarklist Nova 2 Lite](https://benchmarklist.com/models/amazon-nova-2-lite-v1-0/)
- τ-bench (Sierra, 2024): an LLM simulates the user in multi-turn conversations with domain API tools and policies; success = final database state matches the goal; **pass^k** = probability of succeeding on all k independent trials. gpt-4o-class agents succeeded on <50% of tasks with pass^8 <25% in retail — [arXiv 2406.12045](https://arxiv.org/pdf/2406.12045)
- τ²-bench reports `mean_and_pass_hat_k`; τ³-bench adds a knowledge-retrieval domain, voice/audio-native evaluation and 75+ task fixes, and conflicts with τ² v0.2.0 on PyPI name — [EvalScope τ²](https://evalscope.readthedocs.io/zh-cn/latest/benchmarks/tau2_bench.html); [EvalScope τ³](https://evalscope.readthedocs.io/en/latest/benchmarks/tau3_bench.html)
- HA maintains a Home LLM Leaderboard with an "assist-mini" test for small local LLMs controlling a home — [HA blog](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)

### Inferences
**Personal test set for ARES (design):**
- **Source utterances** from (a) the owner's real *addressed* commands logged locally with consent (never overheard speech), (b) paraphrases generated per action (Claude or Apple FM) and then curated, (c) MASSIVE/SLURP English utterances for overlapping domains (alarm, timer, volume, music, calendar, email, IoT) as out-of-style stress tests.
- **Label each item** with: expected route (`grammar` / `router` / `llm`), expected action + slots, expected entity IDs, risk tier, and whether it is a follow-up (with the preceding context).
- **Include negatives deliberately** (BFCL irrelevance idea): near-miss phrasings that must not fire a fast intent ("what's a good volume for a podcast?" must not set volume), questions about an action vs requests for it, desk-mode chatter.
- **Include noisy-ASR variants**: replay audio through the recognizer, and/or perturb transcripts with real error patterns (name confusions, homophones), keeping the clean label.
- **Metrics**: fast-path precision (target ≈ 99%+, since a wrong action is costly) and coverage; routing accuracy; slot exact match; entity-resolution top-1/top-3; end-to-end latency p50/p95 per route (speech end → action start / first audio); LLM **pass^k** on a subset (run each LLM-routed item k=3–5 times and require consistent tool calls, per τ-bench); confirmation rate (how often ARES asks; lower is better at equal error).
- **Regression harness**: run it in a dev instance with the ElevenLabs mock/Kokoro (per CLAUDE.md), recording routes and tool calls without executing real side effects. Re-run whenever example phrases, thresholds, the embedding model, or the macOS/Apple FM model version change (Apple updates the model in OS updates).
- Treat public leaderboards (BFCL, τ-bench) only as coarse model-selection signals: BFCL has a 48% possible-defect rate per Epoch, and neither measures personal entities or voice latency.

### Gaps
- SLURP's own size and recording-hours figures were not retrieved (MASSIVE is derived from it, which implies the same 18-domain / 60-intent label space; that is inference).
- No current (Oct 2026) official BFCL or τ²/τ³ leaderboard numbers for Claude models were retrieved. Snapshots above are third-party and dated ~May 2026.
- No published methodology from Apple/Amazon/Google for personal or per-user intent test sets was found.
