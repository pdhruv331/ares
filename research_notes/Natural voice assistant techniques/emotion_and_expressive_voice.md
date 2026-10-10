# Emotion and tone recognition, and expressive speech, for ARES (as of 8 October 2026)

Scope note: researched 2026-10-08. The shared web-search budget ran out partway through, so later items rely on direct fetches of primary pages. Where a figure came only from a search-engine summary rather than a page I fetched, it is marked "(via search summary)". Vendor numbers are vendor claims unless stated otherwise.

## Q1. Speech emotion recognition (SER) options in 2024–2026: accuracy, real-time and on-device viability, licenses

### Takeaway
On natural, unscripted speech even the best 2025 systems are modest. The Interspeech 2025 naturalistic SER challenge was won at Macro-F1 0.4316 on 8 classes (baseline 0.3293), and the best arousal/valence/dominance average CCC was 0.6076 (baseline 0.5797). Open models that can run locally on a Mac are good enough for coarse, utterance-level cues, not fine-grained mind reading: emotion2vec+ (MIT), SpeechBrain wav2vec2 (Apache-2.0), audEERING A/V/D (CC-BY-NC-SA, research only), and the Whisper and WavLM encoders. Audio-native LLMs report strong results on their own benchmarks, but independent tests (LISTEN, AHELM) show they lean mostly on the words, and an ASR+LLM pipeline is competitive.

### Cited Findings

**What "good" looks like on natural speech (Interspeech 2025 challenge, MSP-Podcast)**
- The tasks were: Task 1, 8 classes (anger, happiness, sadness, fear, surprise, contempt, disgust, neutral), scored by Macro-F1; Task 2, arousal/valence/dominance on a 1–7 scale, scored by average CCC. Task 1 baseline: Macro-F1 0.3293, accuracy 0.3556. Task 1 top scores: NTUA 0.4316, SAIL 0.4281, ABHINAYA 0.4181. Task 2 baseline: average CCC 0.5797 (valence 0.6385, arousal 0.6232, dominance 0.4775). Task 2 top scores: SAIL 0.6076, SRPOL (Samsung Poland) 0.6003, SEU_AIPLab 0.5955 — [MSP-Podcast challenge site](https://lab-msp.com/MSP-Podcast_Competition/IS2025/)
- The challenge overview (Naini et al., Interspeech 2025, pp. 4668–4672) reports a "record number of participants" and concludes that combining audio and text foundation models is effective for robust SER — [ISCA archive](https://www.isca-archive.org/interspeech_2025/naini25_interspeech.html). One search summary claimed "93 research teams", which I could not verify. The public Task 1 leaderboard lists about 46 entries — [challenge site](https://lab-msp.com/MSP-Podcast_Competition/IS2025/)
- USC SAIL's SAILER: a single model with no ensembling scored above 0.4 Macro-F1 and beat more than 95% of submissions; a 3-system ensemble placed in the top 3 — [arXiv 2505.22133](https://arxiv.org/abs/2505.22133)
- MEDUSA (multimodal deep fusion, multi-stage training) reports first place with a held-out test Macro-F1 of 0.4316, the same as NTUA's leaderboard score — [arXiv 2506.09556](https://arxiv.org/pdf/2506.09556) (via search summary)
- Samsung R&D Poland announced a second place in the challenge — [Samsung Research](https://research.samsung.com/news/Samsung-R-D-Institute-Poland-Engineers-Shine-at-INTERSPEECH-2025-Challenges-and-Conference)

**Acted-speech numbers are much higher (the lab-vs-real gap)**
- SpeechBrain `emotion-recognition-wav2vec2-IEMOCAP` (wav2vec2-base fine-tuned on IEMOCAP): 78.7% test accuracy (average 75.3%); Apache-2.0; 16 kHz mono; "does not provide any warranty on the performance achieved by this model when used on other datasets" — [HF model card](https://huggingface.co/speechbrain/emotion-recognition-wav2vec2-IEMOCAP)
- EmoBox (Interspeech 2024) tested 10 pre-trained models on 32 emotion datasets in 14 languages. The Whisper-large-v3 encoder was strongest: top-1 on 23 of 32 datasets, IEMOCAP UA/WA/F1 ≈ 73.5/72.9/73.1, against WavLM-large ≈ 69.5/69.1/69.3. On MSP-Podcast (multi-class) Whisper scored only ≈ 22.2 UA / 22.1 F1, against WavLM-large ≈ 18.6/18.0 — [EmoBox](https://arxiv.org/html/2406.07162v1). These values were read from a flattened table, so check them against the PDF.

**emotion2vec / emotion2vec+ (SJTU/Alibaba, runs via FunASR)**
- emotion2vec is a self-supervised emotion representation. With only linear layers on top it beats universal SSL models on IEMOCAP, and it improves consistently across SER datasets in 10 languages. It also handles song emotion, emotion in conversation, and sentiment — [arXiv 2312.15185](https://arxiv.org/abs/2312.15185). Published at ACL 2024 Findings — [GitHub](https://github.com/ddlBoJack/emotion2vec)
- emotion2vec+ (released May 2024) comes in three sizes:
  - seed: 201 h of fine-tuning data
  - base: about 90M parameters, 4,788 h
  - large: about 300M parameters, 42,526 h (40k of 160k hours, pseudo-labelled)

  It recognises 9 classes: angry, disgusted, fearful, happy, neutral, other, sad, surprised, unknown. The repo carries an MIT license badge. Install with `pip install -U funasr` and load through `AutoModel` from ModelScope or Hugging Face. The repo mentions no ONNX, MLX or CoreML port and no real-time use — [GitHub](https://github.com/ddlBoJack/emotion2vec)
- The HF model card claims emotion2vec+ beats other widely downloaded open SER models but gives no figures. One README revision lists only 5 labels, so the label set conflicts between versions — [HF card revision](https://huggingface.co/emotion2vec/emotion2vec_plus_large/blob/7714a5c669f5711ac128c78f35732e7f9cc976ad/README.md) (via search summary)
- EmoBox used emotion2vec to pseudo-label its cross-corpus test sets and did not benchmark it — [EmoBox](https://arxiv.org/html/2406.07162v1)

**audEERING dimensional model and openSMILE**
- `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` outputs arousal, dominance and valence (about 0–1) plus embeddings. It is wav2vec2-large-robust pruned from 24 to 12 layers and fine-tuned on MSP-Podcast v1.7, with 0.2B parameters. License: CC-BY-NC-SA-4.0, "for research purpose only". An ONNX export is on Zenodo (doi 10.5281/zenodo.6221127) — [HF card](https://huggingface.co/audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim)
- The paper behind it is Wagner et al., "Dawn of the transformer era in SER: closing the valence gap" (2022). It reports valence CCC .638 on MSP-Podcast "without use of explicit linguistic information" and credits the valence gain to linguistic information the transformer learns implicitly. The models were fair across biological sex but not across individual speakers — [arXiv 2203.07378](https://arxiv.org/abs/2203.07378)
- audEERING also publishes a small MobileNetV4 arousal/dominance/valence model, also research-only, with commercial use through audEERING — [HF](https://huggingface.co/audeering/mobilenetv4-emotion)
- openSMILE is the legacy toolkit of hand-crafted acoustic features (eGeMAPS and similar). It is dual-licensed: free for private, research and educational use, but "It is not allowed to use the open-source version of openSMILE for any sort of commercial product." Prebuilt x64 binaries exist for Windows, Linux and macOS, and there is a Python wrapper (opensmile-python). Apple Silicon is not mentioned — [GitHub](https://github.com/audeering/opensmile)

**Hume AI (cloud)**
- The current Expression Measurement docs say audio returns two scored lists per speech window: `expressions` (414 names, e.g. amusement) and `voice_attributes` (190 names, e.g. monotone). Every score is a 0–1 probability. Both batch upload and a realtime WebSocket are available. The API is in "limited release"; you contact Hume for access — [Hume docs](https://dev.hume.ai/docs/expression-measurement/overview). EVI's docs instead describe 48 voice expressions — [EVI prompting guide](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting). The counts differ by product and version.
- Pricing:
  - 2025 third-party listings: audio-only $0.0213/min, audio+video $0.0276/min — [eesel.ai](https://www.eesel.ai/blog/hume-ai-pricing)
  - A July 2026 snapshot says the per-modality rates were removed from Hume's page and are now quoted by sales — [usagepricing.com](https://usagepricing.com/blueprint/hume-ai)
  - EVI and Octave plans run from Free (10k characters, 5 EVI min) up through tiers with conflicting prices (Creator $10 vs $14, Pro $50 vs $70). EVI overage is about $0.07/min on lower tiers and $0.04 on Business — [CostBench](https://www.costbench.com/software/voice-apis/hume-ai/) (via search summary)
- EVI 3 (29 May 2025) is one speech-language model doing transcription, language and speech. In Hume's own blind tests, EVI 3 beat GPT-4o on all 7 rated dimensions (including empathy, expressiveness and naturalness) and identified 8 of 9 emotions better than GPT-4o. Hume measured average latency at about 1.2 s for EVI 3, against Gemini Live ~1.5 s, GPT-4o Realtime ~2.6 s and Sesame ~1 s — [Hume blog](https://www.hume.ai/blog/introducing-evi-3). This is a vendor evaluation.

**Audio-native LLMs that "hear" tone**
- OpenAI gpt-realtime (28 Aug 2025):
  - Reported to detect non-verbal signals such as laughter, switch language mid-sentence, and follow style instructions like "fast and professional"
  - Big Bench Audio 82.8% (up from 65.6%)
  - Pricing: $32/M audio input tokens, $64/M output, $0.40/M cached

  — [The Decoder](https://the-decoder.com/openais-real-time-api-picks-up-laughter-accents-and-switches-languages-in-real-time/). OpenAI's docs now point to gpt-realtime-2 (7 May 2026) for reasoning-heavy work and gpt-realtime-1.5 for fast use — [OpenAI docs](https://developers.openai.com/docs/guides/realtime-models-prompting) (via search summary)
- Gemini Live API "affective dialog": "This feature lets Gemini adapt its response style to the input expression and tone." It is enabled with `enable_affective_dialog: true` (API v1beta) and is not supported in Gemini 3.1 Flash Live. The default model is `gemini-3.8-live`, and native-audio models output only AUDIO — [Gemini API docs](https://ai.google.dev/gemini-api/docs/live-guide). Vertex lists affective dialog for the GA model `gemini-live-2.5-flash-native-audio` — [Vertex docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api)
- Qwen3-Omni (22 Sep 2025) is a 30B-A3B MoE in three variants:
  - Instruct: audio and text out
  - Thinking
  - Captioner: audio in, text out; "a general-purpose, highly detailed, low-hallucination audio captioning model"

  License: Apache-2.0. Minimum BF16 GPU memory is 78.85 GB for 15 s of video input on Instruct. The docs cover Transformers, vLLM and NVIDIA Docker, with no MLX or llama.cpp mention — [GitHub](https://github.com/QwenLM/Qwen3-Omni). The developers claim open-source SOTA on 32 of 36 audio and audio-visual benchmarks — [tech report](https://arxiv.org/pdf/2509.17765) (via search summary)
- Step-Audio 2 (StepFun) on its own StepEval-Audio-Paralinguistic benchmark (550 clips, 11 aspects; built and scored by StepFun). Emotion scores:

  | Model | Emotion score |
  |---|---|
  | Step-Audio 2 | 86 |
  | Step-Audio 2 mini | 82 |
  | GPT-4o Audio | 82 |
  | Qwen-Omni | 76 |
  | Kimi-Audio | 66 |

  The mini, mini Base and mini Think variants are Apache-2.0 (open-sourced 29 Aug and 15 Sep 2025). Tooling is CUDA/vLLM — [GitHub](https://github.com/stepfun-ai/Step-Audio2), [report](https://arxiv.org/pdf/2507.16632)
- Kimi-Audio (Moonshot) reports MELD 59.13 against Qwen2.5-Omni 49.83. These are self-reported; I found no independent test using the same protocol — [README copy](https://cnb.cool/collinniu/kimi) (via search summary)
- AHELM (independent; 14 audio LLMs plus 3 ASR+LM baselines): the ASR+LM baselines "perform reasonably well", and one ranked 6th overall "despite having only speech-to-text capabilities". Gemini 2.5 Pro was top in 5 of 10 aspects — [arXiv 2508.21376](https://arxiv.org/abs/2508.21376). On its MELD emotion column, GPT-4o-Transcribe + GPT-4o scored 0.541, ahead of Qwen2.5-Omni 0.491 and Gemini 2.5 Pro 0.473 — [AHELM PDF](https://arxiv.org/pdf/2508.21376) (via search summary)
- LISTEN (independent; Gemini 2.5 Pro/Flash, Qwen2.5-Omni-7B, Qwen3-Omni-30B, Baichuan-Omni-1.5):
  - With neutral wording, audio-only accuracy is only 16.5–34.9%, against 81–97% for text-only
  - Accuracy on nonverbal vocalisations is 15.7–22.7%, against 12.5% chance
  - Models default to "neutral"; the authors conclude they "transcribe" rather than "listen"

  — [arXiv 2510.10444v2](https://arxiv.org/html/2510.10444v2). It was listed as an EACL 2026 paper in a search result; the arXiv page names no venue.

**Apple on-device building blocks**
- `SFSpeechRecognitionMetadata` (macOS 11.3+) exposes `speakingRate` (words per minute), `averagePauseDuration`, `speechDuration`, `speechStartTimestamp` and `voiceAnalytics` — [Apple docs](https://developer.apple.com/documentation/speech/sfspeechrecognitionmetadata.md)
- `SFVoiceAnalytics` (macOS 10.15+) gives per-frame jitter, shimmer, pitch (log F0) and voicing, delivered with final results — [Apple docs](https://developer.apple.com/documentation/speech/sfvoiceanalytics.md) (via search summary)
- I found no sign that macOS 26 `SpeechTranscriber`/`SpeechAnalyzer` exposes these voice metrics — [Apple docs](https://developer.apple.com/documentation/speech/speechtranscriber.md). Their absence is not confirmed.
- The SoundAnalysis built-in classifier (`SNClassifierIdentifier.version1`, macOS 12+) covers "over 300 categories", including "respiratory sounds, vocalizations". It runs entirely on-device ("audio is never sent to the Cloud"), with an analysis window of 0.5–15 s — [WWDC21 session](https://developer.apple.com/videos/play/wwdc2021/10036/), [Apple docs](https://developer.apple.com/documentation/soundanalysis/snclassifieridentifier/version1.md)
- ARES's listener already uses `SFSpeechRecognizer` (locale en-GB) with `requiresOnDeviceRecognition` when supported, and turns on `setVoiceProcessingEnabled(true)` on the input node — [native/AresListener.swift](file:///Users/dhruv/My%20AI/native/AresListener.swift) (lines 47, 148, 345, 600)

**On-device runtimes**
- mlx-audio (Apple Silicon) lists Qwen2-Audio 7B 4-bit for "ASR, captioning, emotion, translation", plus MiMo-Audio 7B for audio understanding. It provides an OpenAI-compatible server and a Swift package for macOS/iOS. It publishes no real-time factors or emotion benchmarks — [GitHub](https://github.com/Blaizzy/mlx-audio)

### Inferences
- **Cheapest step for ARES (no model, no network):** read `speakingRate`, `averagePauseDuration` and `voiceAnalytics` (pitch, jitter, shimmer) from the SFSpeechRecognizer results the listener already receives. Compare each addressed utterance with the owner's own running baseline. One caveat: voice processing is on (echo cancellation, gain control, noise suppression), which may distort loudness and pitch features. Measure the distortion before trusting them. Also, if the listener ever moves to `SpeechTranscriber`, these metrics probably go away, and speaking rate and pauses would have to be computed from word timestamps plus a pitch tracker.
- **Second step:** an utterance-level SER sidecar, run on each finished command (these are not streaming models):
  - emotion2vec+ base (~90M, MIT) for categories
  - and/or the audEERING A/V/D model (ONNX available) for arousal/valence

  CC-BY-NC-SA fits a purely personal, non-commercial tool, but not a distributed or commercial ARES (not legal advice). Both should run far faster than real time on an M-series chip through PyTorch (MPS/CPU) or ONNX Runtime, but no Mac numbers are published, so measure.
- **Expect about 0.4 Macro-F1 on fine categories for natural speech.** Use coarse, high-confidence signals only: energy up or down, valence clearly negative or positive, laughing, sighing.
- **Heavy audio LLMs don't fit.** Qwen3-Omni (~70–80 GB in BF16; 4-bit MLX feasibility unverified) and Step-Audio 2 mini (CUDA tooling) are a poor fit for a laptop helper today. Independent tests also show weak tone perception when the words are neutral, so moving the Claude brain to an audio LLM would not reliably buy tone sensitivity.
- **Hume is the most detailed commercial reader** (hundreds of expression labels, streaming), but it sends raw audio to the cloud and its 2026 pricing is opaque. It is a reasonable benchmark to compare against, not a default.

### Gaps
- emotion2vec+ has no published IEMOCAP or MSP-Podcast numbers (the model card claims superiority without figures), and I found no independent test on natural speech.
- No real-time factor is published for any SER model on Apple Silicon, and I found no CoreML or MLX port of emotion2vec or the audEERING model (the audEERING model has ONNX).
- I did not retrieve Qwen3-Omni or Kimi-Audio numbers on IEMOCAP or MSP-Podcast. It is unconfirmed whether Qwen3-Omni-Captioner describes speech emotion or tone explicitly (the repo does not say).
- It is unconfirmed whether macOS 26 SpeechAnalyzer exposes any voice analytics, and I did not retrieve the SoundAnalysis label list (does it contain laughter, sigh, crying by name?). `request.knownClassifications` returns that list at runtime — [WWDC21](https://developer.apple.com/videos/play/wwdc2021/10036/)
- The search budget ran out before I could check SpeechBrain's newer emotion recipes, any Interspeech 2026 SER results, and gpt-realtime-2's paralinguistic claims.

## Q2. Beyond basic categories: arousal/valence/dominance, stress, urgency, fatigue, sarcasm, laughter, sighs. Reliability for one user, limitations, biases, ethics

### Takeaway
Dimensions are more usable than categories: arousal (energy) is the most reliable, valence is weaker from audio alone, and dominance is weakest. Discrete events like laughter and sighs suit sound-event classifiers, but audio LLMs are near chance on them. I found no reliable off-the-shelf detector for stress or sarcasm from voice alone. Unfairness across individual speakers is a known open problem. For a single-user system that argues for per-owner baselines. Regulators treat inferring emotion from voice as sensitive: the EU AI Act bans it in workplaces and education.

### Cited Findings
- In the 2025 challenge, baseline CCC was valence 0.6385, arousal 0.6232 and dominance 0.4775, so dominance is clearly the hardest dimension. Even the winning average CCC was 0.6076 — [challenge site](https://lab-msp.com/MSP-Podcast_Competition/IS2025/)
- Valence from audio reached CCC .638 only because the transformer implicitly picked up linguistic information. The models were fair across sex but not across individual speakers ("an open problem") — [arXiv 2203.07378](https://arxiv.org/abs/2203.07378)
- Nonverbal sounds: on LISTEN, audio LLMs scored 15.7–22.7% on nonverbal vocalisations against 12.5% chance. They predict "neutral" for most nonverbal clips except surprise, which the authors put down to limited sensitivity to sounds like laughter and sighs — [arXiv 2510.10444v2](https://arxiv.org/html/2510.10444v2)
- EmotionThinker (2026) notes that current speech LLMs perceive prosody weakly, even though emotion understanding depends heavily on it — [arXiv 2601.15668](https://arxiv.org/html/2601.15668) (via search summary)
- Step-Audio 2's own benchmark scores 11 paralinguistic aspects (e.g. gender 100, age 96, timbre 82, scenario 78, event 60), but the developer made it and scored its own model — [Step-Audio 2 report](https://arxiv.org/pdf/2507.16632) (via search summary)
- Hume's audio outputs include voice attributes such as "monotone" (190 attributes) — [Hume docs](https://dev.hume.ai/docs/expression-measurement/overview). Hume's science page cautions that its labels stand in for common ways of describing behaviour and are not literal readings of feelings — [Hume science](https://dev.hume.ai/docs/resources/science) (via search summary)
- Gender fairness in SER is rarely examined across corpora. Upadhyay, Chien & Lee (Jan 2025) study it in cross-corpus transfer and propose an adaptation method — [arXiv 2501.00995](https://arxiv.org/pdf/2501.00995). See also the 2025 "gender-bias-resistant super corpus" baseline — [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11991078/)
- Word–tone mismatch is the usable sarcasm/irony cue. Hume tells its LLM: "Stay alert for disparities between the user's words and expressions" — [Hume prompting](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting)
- **EU AI Act, per FPF:**
  - Art. 5(1)(f) prohibits AI systems that infer the emotions of natural persons from biometric data in the workplace and in education institutions, except strictly for medical or safety reasons.
  - Art. 3(39) defines emotion recognition as covering "emotions or intentions". Physical states such as pain or fatigue are excluded (pilot and driver fatigue detection is the example).
  - Inferring emotion from written text falls outside the prohibition.
  - General wellbeing, stress or burnout monitoring is not covered by the medical exception.
  - Outside work and education, these systems are high-risk under Annex III 1(c).

  — [FPF](https://fpf.org/blog/red-lines-under-eu-ai-act-unpacking-the-prohibition-of-emotion-recognition-in-the-workplace-and-education-institutions/)
- The ban has applied since 2 Feb 2025, with fines up to €35M, and "workplace" is read broadly, including home offices — [Freshfields](https://technologyquotient.freshfields.com/post/102kfql/eu-ai-act-unpacked-25-european-commission-releases-critical-ai-act-implementati) (via search summary)
- ARES already has a rule that overheard speech (desk mode, not addressed to ARES) is never logged as text, sent to the brain or shown — [CLAUDE.md](file:///Users/dhruv/My%20AI/CLAUDE.md)

### Inferences
- **Two design choices give the biggest gains for a single owner at home or in an office:**
  - Per-speaker normalisation: compare speaking rate, pitch range, loudness and pause length with the owner's own baseline. This sidesteps the "not fair across individual speakers" problem by design.
  - A small, coarse vocabulary: energy up (faster, louder, higher pitch), energy down (slower, long pauses, low or flat pitch), negative or positive valence only when confident, and discrete events (laugh, sigh) from a sound-event classifier.
- **Treat stress, fatigue, urgency and sarcasm as hypotheses for Claude to weigh with context** (time of day, calendar load, the words), not as detector outputs. Sarcasm is best caught as positive words delivered with flat or negative prosody, which Claude can only reason about if it sees both the words and the tone note.
- **Privacy.** Tone analysis should run only on speech addressed to ARES (never on overheard desk-mode speech, in line with the existing rule), stay in memory, and not build a long-term emotional profile.
- **Legal.** For one person's self-built tool, the workplace ban looks aimed at employers deploying systems on workers. It could become relevant if ARES analysed other people (callers, colleagues) or was used in an EU workplace setting (unverified; not legal advice).
- **Design so a misread costs little.** Error rates of 40–60% on fine categories are normal. A wrong read should cause only a subtle style shift, never a statement like "You sound angry".

### Gaps
- Within budget I found no reliable accuracy figures for voice-only sarcasm, stress, urgency or laughter detection with open models.
- I retrieved no source on accent or dialect bias in SER, which matters for the owner's accent.
- I did not verify whether the AI Act's Art. 2(10) exclusion for "purely personal non-professional activity" covers a self-built assistant.
- I retrieved no study measuring accuracy gains from personalising or speaker-adapting SER for a single user.

## Q3. Using tone with a text-only LLM brain (Claude): annotations, prosodic summaries, or an audio LLM; how products do it; prompt design

### Takeaway
The proven, cheap pattern is to append a short natural-language tone summary to the transcript. Hume EVI does exactly this with its top three expressions when it runs Claude or GPT as the LLM, and SpeechCueLLM showed that describing vocal cues in the prompt improves LLM emotion recognition. Pair it with clear rules: infer the tone, respond appropriately, don't name it, watch for word–tone mismatch, default to neutral. Claude can stay the brain. Switching to an audio-native LLM isn't needed, and the evidence says those models mostly use the words anyway.

### Cited Findings
- **Hume EVI with a supplemental LLM** (it names GPT-4o and Claude Sonnet) appends the top three expressions to every user message, for example `{very happy, quite anxious, moderately amused}`. Its example system prompt says:
  - "Use expressions to infer the user's tone of voice and respond appropriately."
  - "Avoid repeating these expressions or mentioning them directly."
  - "Stay alert for disparities between the user's words and expressions."

  The example maps "quite sad" to sympathy and "very happy" to shared joy — [Hume prompting guide](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting). Developers can also tell the LLM to ignore expression cues unless, say, anger appears — [older Hume prompting page](https://dev.hume.ai/docs/empathic-voice-interface-evi/prompting) (via search summary)
- EVI 4-mini requires an external LLM; for EVI 3 one is optional — [Hume EVI overview](https://dev.hume.ai/docs/speech-to-speech-evi/overview) (via search summary)
- **SpeechCueLLM** (Wu, ..., Hirschberg; Columbia) turns speech characteristics into natural-language descriptions in the prompt, which lets an LLM do multimodal emotion analysis with no change to its architecture. Version 3 reports IEMOCAP weighted F1 rising from 70.111% to 72.596% (LoRA); version 4 reports about a 10-point zero-shot gain. The gains were largest on high-quality audio — [arXiv 2407.21315](https://arxiv.org/abs/2407.21315) (via search summary; numbers differ by version)
- The 2025 SER challenge concluded that combining audio and text foundation models works best — [ISCA](https://www.isca-archive.org/interspeech_2025/naini25_interspeech.html). On AHELM, ASR+LLM baselines are competitive with audio LLMs — [arXiv 2508.21376](https://arxiv.org/abs/2508.21376). On LISTEN, audio LLMs show "lexical dominance" — [arXiv 2510.10444v2](https://arxiv.org/html/2510.10444v2)
- **How products adapt:**
  - Gemini Live's affective dialog adapts "response style to the input expression and tone" — [Gemini docs](https://ai.google.dev/gemini-api/docs/live-guide)
  - gpt-realtime reportedly detects laughter and follows tone instructions — [The Decoder](https://the-decoder.com/openais-real-time-api-picks-up-laughter-accents-and-switches-languages-in-real-time/)
  - Hume EVI 3 claims stronger emotion understanding than GPT-4o (vendor test) — [Hume blog](https://www.hume.ai/blog/introducing-evi-3)
- **OpenAI's realtime prompting guidance:**
  - Include a "Personality & Tone" section, add a "Variety" rule to reduce robotic repetition, and know that the model follows sample phrases closely.
  - Ambiguous or conflicting instructions hurt; capitalising key rules helps; write non-text rules in plain language.

  — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/realtime_prompting_guide). Its sample persona is warm, brief and confident, avoids flattery, and keeps each turn to two or three sentences — [OpenAI voice prompting](https://developers.openai.com/api/docs/guides/voice-prompting) (via search summary)
- Sesame: "there are countless valid ways to speak a sentence, but only some fit a given setting", and models "lack the information to choose the best option". Conversation history is what lets CSM pick the right delivery — [Sesame research](https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice)
- **Hume's voice-output rules:**
  - Avoid "any text-specific formatting or anything that is not normally spoken"; "Prefer easily pronounced words."
  - Use inflections like "oh wow" and discourse markers like "I mean".
  - Keep turns short (its example: "less than three sentences of under twenty words each").
  - "Backchannels must always be 1-2 words" (e.g. "mmhm")

  — [Hume prompting guide](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting)
- **ARES's current output side:**
  - The brain prompt already allows "an occasional delivery cue in square brackets... such as [dryly], [amused], [warmly], [sighs] or [laughs softly]. At most one or two per reply" — [claude.js line 37](file:///Users/dhruv/My%20AI/claude.js)
  - voice.js sends the cues to ElevenLabs only when the model is `eleven_v3` and strips them otherwise, Kokoro included (`stripCues = t.replace(/\[[a-z ]+\]\s*/gi, '')`) — [voice.js lines 37, 320, 361](file:///Users/dhruv/My%20AI/voice.js)

### Inferences (ARES recommendations)
- **Format.** The listener pipeline adds one compact, hedged line to the user turn, using words rather than raw scores:

  `[voice: faster and louder than usual, pitch up, laughed once; sounds excited or amused (medium confidence)]`

  Leave the note out entirely when nothing deviates from the owner's baseline, which should be most turns, so Claude isn't primed to look for emotion.
- **System-prompt rules** (adapted from Hume and OpenAI):
  - Use the note only to adjust style, length and pacing.
  - Never name the emotion unless the user brings it up or the signal is strong and relevant; an occasional "Long day?" is fine, "I detect stress" is not.
  - When words and tone disagree, read it as humour or sarcasm, or check gently.
  - When unsure, behave neutrally.
  - Match positive energy, but calm stress and anger: shorter, steadier, solution first.
  - Never perform big emotions, and vary phrasing.
- **History.** Include a one-line tone trend for the last two or three turns (e.g. "user has sounded increasingly rushed"). Sesame's results say context drives a fitting delivery.
- **Output.** Keep Claude's existing cue convention but restrict it to a whitelist the TTS model actually supports (see Q4), so the reply's delivery actually follows the tone read.
- **Don't swap the brain.** Optionally, later, evaluate a small local audio LLM as a "tone captioner" that writes the note (e.g. Qwen2-Audio 7B 4-bit through mlx-audio). Compare it against the simple feature approach before adopting it, since LISTEN suggests weak prosody use.

### Gaps
- I found no controlled study comparing tone-annotated text LLMs with audio-native LLMs on user satisfaction in a live assistant.
- I did not retrieve SpeechCueLLM's exact prompt template (Figure 1 of the paper, or the repo zehuiwu/SpeechCueLLM).
- How ChatGPT voice mode and Sesame Maya adapt to user emotion internally isn't publicly documented beyond the one-line descriptions above.
- I retrieved no research on emotion cues pushing an LLM into over-empathy or sycophancy.

## Q4. Expressive TTS for replies: ElevenLabs v3/v4 tags and Flash v2.5 limits; Hume Octave; Sesame CSM; gpt-4o-mini-tts; Cartesia Sonic; open models; rankings, latency, Apple Silicon, cost

### Takeaway
ElevenLabs shipped Eleven v4 and v4 Turbo on 28 Sep 2026, and v4 is now #1 on the Artificial Analysis Speech Arena (Elo 1319, $80 per 1M characters). Audio tags work in v4, v4 Turbo (real-time, ~100 ms median inference by vendor claim) and v3. Flash v2.5 (~75 ms) has no documented tag support. For ARES, the natural move is to keep Katherine on ElevenLabs and go from `eleven_v3` to `eleven_v4_turbo` for live replies. That gives tags and low latency, but needs the code change below and a check that the Katherine voice works on v4. The expressive open options are Chatterbox (MIT; Turbo has [laugh]/[chuckle]/[cough] tags and an exaggeration control), Orpheus and Dia (Apache-2.0, with nonverbal tags) and Sesame CSM-1B. Kokoro stays fast but has no expressive controls.

### Cited Findings

**ElevenLabs**
- **Eleven v4 and v4 Turbo launched 28 Sep 2026.**
  - Turbo: median inference ~100 ms and time to first speech ~150 ms (vendor figures from WebSocket tests with network latency subtracted); bidirectional streaming, so an LLM can feed text while audio comes back.
  - Both: 90+ languages and 10,000 characters per request.
  - Per the coverage, clones built on older Instant or Professional models must be retrained.

  — [TestingCatalog](https://testingcatalog.com/elevenlabs-launches-eleven-v4-and-v4-turbo-voice-models), [VKTR](https://www.vktr.com/ai-platforms/elevenlabs-launches-eleven-v4-and-v4-turbo/) (via search summary)
- **The ElevenLabs models page:**

  | Model id | Latency | Request limit | Languages | Audio tags | Notes |
  |---|---|---|---|---|---|
  | `eleven_v4` | not stated | 10,000 chars | 90+ | listed on the tags page | for emotional dialogue |
  | `eleven_v4_turbo` | ~100 ms median inference, excl. network | — | 90+ | yes | real-time over the Text to Dialogue WebSocket; for "AI assistants" |
  | `eleven_v3` | not stated | 5,000 chars | 70+ | listed on the tags page | "previous generation" |
  | `eleven_v3_conversational` | ~280 ms | — | 70+ | yes | real-time |
  | `eleven_flash_v2_5` | ~75 ms | 40,000 chars | 32 | none listed | about half the price per character |
  | `eleven_turbo_v2_5` | — | — | — | — | deprecated, use Flash instead |

  — [ElevenLabs models](https://elevenlabs.io/docs/models)
- **Tags documented for v3/v4:** `[laughs]`, `[laughs harder]`, `[starts laughing]`, `[wheezing]`, `[whispers]`, `[sighs]`, `[exhales]`, `[sarcastic]`, `[curious]`, `[excited]`, `[crying]`, `[snorts]`, `[mischievously]`.
  - Ellipses add pauses and weight; capitals add emphasis.
  - v4 is recommended over v3, and neither supports SSML break tags.
  - "PVCs are not fully optimized for Eleven v3"; v4 is recommended for professional clones and Voice Library voices.

  — [ElevenLabs prompting guide](https://elevenlabs.io/docs/best-practices/prompting)
- An earlier version of that page also said that the voice matters most (a naturally loud voice resists [whispers]), that the Creative and Natural stability modes let tags land while Robust mutes them, and that prompts over 250 characters are more consistent. These points were not in the version I fetched on 2026-10-08 — [ElevenLabs prompting guide](https://elevenlabs.io/docs/best-practices/prompting) (via search summary)
- **ElevenLabs tag catalogue:**
  - Emotion families: excited, playful, amazed; mad, bitter; anxious, stressed, confused; tired, bored; peaceful, content, curious, thoughtful
  - Delivery: whispers, softly, quietly
  - Pacing: slowly, rushed, pause, long pause
  - Reactions: laughs, sighs, gasps, clears throat, crying

  A tag's effect "carries forward" until a new tag. Several tags can be combined in one bracket separated by commas, and one tag per clause is advised. v4 "adds small human touches when the emotion calls for them" (stammers, groans). Supported on `eleven_v4`, `eleven_v4_turbo` and `eleven_v3` — [ElevenLabs audio tags list](https://elevenlabs.io/blog/elevenlabs-audio-tags-list)
- **Speech Arena** (Artificial Analysis, read 25–28 Sep 2026): Eleven v4 #1, Elo 1319, $80/M characters; ElevenLabs v3 Conversational #12, 1196, $50/M; ElevenLabs v3 #17, 1169, $100/M, with 588 ms P50 time to first audio on Voice Arena — [Digital Applied](https://www.digitalapplied.com/blog/best-text-to-speech-models-september-2026-ranked-priced). The live board is at [Artificial Analysis](https://artificialanalysis.ai/text-to-speech/leaderboard). The top spot changed hands several times in 2026; earlier leaders were Inworld TTS 1.5 Max, Alibaba Fun-Realtime-TTS (1,219 on 3 Jun) and Speechify Simba 3.2 — [AA article](https://artificialanalysis.ai/articles/fun-realtime-tts-new-text-to-speech-model-topping-artificial-analysis-leaderboard), [OfflineTTS](https://offlinetts.com/blog/tts-model-ranking-2026/) (via search summary)

**Other commercial options**
- **Cartesia Sonic 3.6:** Elo 1279 (#1 before v4), $49/M characters. Voice Arena measured 341 ms P50 to first audio, against the vendor's sub-90 ms claim — [Digital Applied](https://www.digitalapplied.com/blog/best-text-to-speech-models-september-2026-ranked-priced). Emotion is set with SSML-style self-closing tags (e.g. an `emotion` element with `value="angry"`); Cartesia calls them beta and "highly experimental", especially for mid-utterance changes, and recommends Emotive voices — [Cartesia docs](https://docs.cartesia.ai/build-with-cartesia/sonic-3/ssml-tags). A `[laughter]` token is described by third parties — [LyricWinter](https://lyricwinter.com/blog/cartesia-emotion-controls)
- **Others on the same board:** Gemini 3.8 Flash TTS, Elo 1265, $16.49/M; Qwen-Audio-3.0-TTS-Plus, 1259; Inworld Realtime TTS-2, 1246, $20.83/M, 169 ms; MiniMax Speech 2.8 HD, 1170, $100/M; Fish Audio S2.1 Pro, 1140 — [Digital Applied](https://www.digitalapplied.com/blog/best-text-to-speech-models-september-2026-ranked-priced)
- **OpenAI gpt-4o-mini-tts:** tone, emotion and pacing are steered with a separate `instructions` field. Price: $0.60/M text input tokens and $12/M audio output tokens (about $0.015/min, an estimate), with a 2,000-token input limit — [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts), [TTS guide](https://developers.openai.com/api/docs/guides/text-to-speech) (via search summary). On Voice Arena it has Elo 929 and 812 ms to first audio — [Digital Applied](https://www.digitalapplied.com/blog/best-text-to-speech-models-september-2026-ranked-priced)
- **Hume Octave 2** (Oct 2025): billed per character; overage has been $0.075 down to $0.025 per 1k characters since June 2026; not on the Artificial Analysis board — [usagepricing.com](https://usagepricing.com/blueprint/hume-ai), [CostBench](https://www.costbench.com/software/voice-apis/hume-ai/) (via search summary)

**Open models**
- **Sesame CSM** comes in Tiny (1B backbone / 100M decoder), Small (3B/250M) and Medium (8B/300M). It was trained on about 1M hours of mostly English audio with the Mimi codec at 12.5 Hz, and conversation history informs the delivery — [Sesame](https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice). CSM-1B was open-sourced under Apache-2.0 in March 2025. It is a general base model, weak outside English, with honour-system safeguards; about a minute of audio is enough to clone a voice — [TechCrunch](https://techcrunch.com/2025/03/13/sesame-the-startup-behind-the-viral-virtual-assistant-maya-releases-its-base-ai-model), [The Decoder](https://the-decoder.com/sesame-releases-csm-1b-ai-voice-generator-as-open-source/) (via search summary). mlx-audio supports csm-1b — [mlx-audio](https://github.com/Blaizzy/mlx-audio)
- **Chatterbox** (Resemble AI, MIT):
  - Turbo: 350M, English, native `[laugh]`, `[chuckle]`, `[cough]` "and more", with a one-step decoder
  - Nano: 110M, "3x faster than realtime on 8 CPU cores"
  - Original: 500M
  - Multilingual V3: 500M, 23+ languages

  Settings: `exaggeration` defaults to 0.5 (≥0.7 for dramatic delivery, which also speeds speech up) and `cfg_weight` defaults to 0.5 (around 0.3 slows pacing). Every output carries the PerTh watermark. The example code uses an `mps` device on Mac — [GitHub](https://github.com/resemble-ai/chatterbox). On Speech Arena it has Elo 1023 (#70) — [Digital Applied](https://www.digitalapplied.com/blog/best-text-to-speech-models-september-2026-ranked-priced). MLX ports exist and mlx-audio lists Chatterbox — [mlx-audio](https://github.com/Blaizzy/mlx-audio). One blogger found Chatterbox Turbo on MLX quicker and easier to use than Qwen3-TTS or Kokoro, best with a reference voice — [mybyways](https://mail.mybyways.com/blog/chatterbox-turbo-tts-with-mlx-audio/) (via search summary). One third-party page says Turbo ignores `exaggeration`/`cfg_weight` (unconfirmed) — [Mintlify mirror](https://www.mintlify.com/yocxy2/chatterboxyocxy/models/chatterbox-turbo) (via search summary)
- **Orpheus** (Canopy Labs): Llama-3B backbone. Tags: `<laugh>`, `<chuckle>`, `<sigh>`, `<cough>`, `<sniffle>`, `<groan>`, `<yawn>`, `<gasp>`. About 200 ms streaming latency, about 100 ms with input streaming. There is a llama.cpp path, and smaller sizes are still unreleased roadmap items. The repo's license is Apache-2.0 — [GitHub](https://github.com/canopyai/Orpheus-TTS). There is a license conflict: tts.ai says Llama 3.2 Community terms apply — [tts.ai](https://tts.ai/voices/orpheus/) (via search summary). Orpheus is in mlx-audio-swift but not the Python mlx-audio tables — [mlx-audio-swift](https://github.com/Blaizzy/mlx-audio-swift) (via search summary)
- **Dia** (Nari Labs): 1.6B, Apache-2.0, English only. Tags include (laughs), (sighs), (gasps), (clears throat), (coughs), (inhales), (exhales), (chuckle), and the README says to use them sparingly because unlisted tags cause artifacts. It was tested on GPUs only (4.4 GB VRAM in bf16; real-time factor ×2.1 on an RTX 4090 with compile); Mac/MPS is not mentioned. Dia2 has been released — [GitHub](https://github.com/nari-labs/dia). mlx-audio lists Dia 1.6B — [mlx-audio](https://github.com/Blaizzy/mlx-audio)
- **IndexTTS2** (bilibili, AAAI): separates emotion from timbre. Emotion can come from a separate reference clip or a plain-language description (a Qwen3-based module), and it has duration control — [arXiv 2506.21619](https://arxiv.org/html/2506.21619v2), [AAAI](https://ojs.aaai.org/index.php/AAAI/article/view/40820). License: the bilibili Model Use License Agreement, filed as proprietary-but-free rather than open source; the commercial terms are unclear — [ScanCode LicenseDB](https://scancode-licensedb.aboutcode.org/bilibili-model-ula-2025-09-09.html) (via search summary)
- **Higgs Audio** (Boson AI): mlx-audio lists v2 (3B) and v3 (4B) — [mlx-audio](https://github.com/Blaizzy/mlx-audio). Licensing is murky: the v2 tokenizer has a commercial clause at 100,000 annual active users — [HF discussion](https://huggingface.co/bosonai/higgs-audio-v2-tokenizer/discussions/8), and v3 is under a research/non-commercial license — [README](https://raw.githubusercontent.com/boson-ai/higgs-audio/HEAD/README.md) (via search summary)
- **EmergentTTS-Eval** (NeurIPS 2025 Datasets & Benchmarks; authors at Boson AI): 1,645 cases across emotions, paralinguistics, foreign words, syntactic complexity, pronunciation and questions, judged by an audio LLM — [arXiv 2505.23009](https://arxiv.org/abs/2505.23009v1) (via search summary). Higgs v2's win rates over gpt-4o-mini-tts (e.g. 75.7% on emotions) appear only in secondary write-ups — [hyper.ai](https://hyper.ai/de/news/42816) (unverified)
- **Kyutai TTS 1.6B** (English/French): streams text in and audio out, about 220 ms to first audio. The weights are CC-BY 4.0, but the voice embeddings are mixed (Expresso-derived voices are CC BY-NC) — [HF](https://huggingface.co/kyutai/tts-1.6b-en_fr), [Kyutai](https://kyutai.org/next/tts) (via search summary)
- **Kokoro-82M v1.0** (27 Jan 2025): Apache-2.0, StyleTTS 2 + ISTFTNet, trained on a few hundred hours, 8 languages, 54 voices — [HF](https://huggingface.co/hexgrad/Kokoro-82M). Speech Arena Elo 1063 (#49), in the cluster of commercially usable open models around rank 48 alongside NVIDIA's Magpie; the stronger open-weight models above it (Breeze TTS 2, Voxtral TTS) are research-only or CC BY-NC — [Digital Applied](https://www.digitalapplied.com/blog/best-text-to-speech-models-september-2026-ranked-priced). ARES's Kokoro worker passes only text, speaker id and `speed` — [kokoro-worker.js](file:///Users/dhruv/My%20AI/kokoro-worker.js)
- **Qwen3-TTS** 0.6B/1.7B (voice design, CustomVoice, cloning, streaming) runs in mlx-audio — [mlx-audio](https://github.com/Blaizzy/mlx-audio). The 1.7B CustomVoice model is listed as Apache-2.0 — [Digital Applied](https://www.digitalapplied.com/blog/best-text-to-speech-models-september-2026-ranked-priced)
- **Tag reliability:** Inworld treats a tag that gets read aloud as a failure and advises adding one cue at a time — [Inworld](https://inworld.ai/resources/non-verbal-cues-in-tts) (via search summary). OpenRouter has a nonverbal-cue benchmark that scores whether a model makes the sound, ignores the tag, or reads the word aloud — [OpenRouter](https://openrouter.ai/benchmarks/media/speech/nonverbal-cue)

### Inferences (ARES recommendations)
- **Model choice.** Use `eleven_v4_turbo` for live conversational replies: it has tags and low latency, and its bidirectional streaming fits Claude's streamed output. Keep `eleven_v4` for long-form output such as briefings. Per Artificial Analysis, v4 costs less per character than v3 ($80 vs $100 per M); confirm the credit multipliers on the owner's plan.
- **Required code change before switching.** `voice.js` only passes tags through when `model === 'eleven_v3'`, so on v4 every tag would be silently stripped. The tag-stripping regex `\[[a-z ]+\]` also misses combined tags like `[whispering, playful]` and hyphenated ones. Both need updating.
- **Check the Katherine voice on v4 before switching.** Coverage says older clones must be retrained, and PVCs underperform on v3. Do a short listening test only with the owner's go-ahead, because CLAUDE.md forbids spending credits on testing. Use mocks or Kokoro for pipeline tests.
- **Tag whitelist.** Map Claude's cues onto documented tags (for example softly, excited, curious, thoughtful, sighs, laughs, whispers, pause, slowly), allow at most one per sentence, and strip anything not on the list. Claude's current examples `[dryly]`, `[amused]` and `[warmly]` are not in ElevenLabs' documented lists, though tags are open-ended and may still work. The OpenRouter-style test (sound / ignore / read aloud) is the right check.
- **Local fallback stays tagless.** Keep Kokoro (it has no tag interface; ARES strips cues already) and at most map a tone to `speed`. If an expressive local fallback is wanted, Chatterbox Turbo (MIT, tags, MLX ports) is the leading candidate. It is English-only and every output is watermarked, and cloning Katherine (an ElevenLabs voice) locally may conflict with ElevenLabs' terms, so check before doing it.
- **Leave the phone line alone.** Do not touch the ElevenLabs phone agent ("ARES Calls", Hope) as part of this work, per CLAUDE.md.

### Gaps
- No information yet (10 days after launch) on Eleven v4 / v4 Turbo credit pricing, whether v4 Turbo covers the full tag set, or independent latency measurements.
- I did not retrieve Hume Octave 2's emotion controls or quality ranking, or the current Hugging Face TTS Arena standings (only Artificial Analysis, through a secondary write-up).
- No published Apple Silicon real-time factors for Chatterbox, Orpheus, Dia, CSM or IndexTTS2 under MLX.
- The Orpheus, Higgs Audio and IndexTTS2 commercial license questions are unresolved.
- I could not verify whether ElevenLabs Agents has an "expressive mode" that reacts to user emotion (the search budget ran out).

## Q5. Making speech sound human: prosody matching, pacing, fillers, breaths, laughter, avoiding the "AI voice"

### Takeaway
The remaining gap is context and timing, not audio quality. Sesame found listeners couldn't tell CSM from human speech without context, but consistently preferred the real recordings once they heard 90 s of conversation. Practitioners converge on:
- short, spoken-style turns
- discourse markers, with occasional fillers and backchannels
- sparing nonverbal tags
- varied phrasing
- following the user's mood without mirroring it exactly (calm a stressed user; brighten for a joking one)
- fast turn-taking, with a deliberate short pause before complex answers

### Cited Findings
- **Sesame CSM human ratings** (CMOS, Expresso, 80 raters): with no context there was no clear preference between generated and human speech. With 90 s of prior audio and text, listeners "consistently favored the original human recordings", and "a noticeable gap remains between generated and human prosody in conversational speech generation". Turn-taking, pauses and pacing are out of scope, and Sesame expects fully duplex models to handle them — [Sesame research](https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice)
- **Sesame's "voice presence"** has four parts: emotional intelligence, conversational dynamics (timing, pauses, interruptions, emphasis), contextual awareness and a consistent personality — [Sesame](https://sesame.com/research) (via search summary). Reviewers singled out its brief pauses, shifting stress, laughter, mid-sentence corrections and filler words — [The Decoder](https://the-decoder.com/sesame-releases-csm-1b-ai-voice-generator-as-open-source/) (via search summary)
- **Google Duplex** (May 2018, legacy):
  - Disfluencies ("hmm"s and "uh"s) made "conversations... sound more familiar and natural" in user studies, signalling that the system is still thinking.
  - After something simple like "hello?" people expect an instant reply; fast paths reached under 100 ms.
  - A short delay before answering a complex sentence felt more natural.

  — [Google Research blog](https://research.google/blog/google-duplex-an-ai-system-for-accomplishing-real-world-tasks-over-the-phone/)
- **Hume:** use natural inflections ("oh wow") and discourse markers ("I mean"), keep turns short, use 1–2-word backchannels, and no markdown — [Hume prompting guide](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting)
- **OpenAI:** a Variety rule reduces robotic repetition, and sample phrases are followed closely, so give several varied examples rather than one — [OpenAI cookbook](https://developers.openai.com/cookbook/examples/realtime_prompting_guide). The realtime speed control changes playback only, not how the model generates speech — [OpenAI docs](https://developers.openai.com/api/docs/guides/realtime-models-prompting) (via search summary)
- **ElevenLabs v4** adds stammers and groans "when the emotion calls for them". Use one tag per clause, and use ellipses for pauses and capitals for emphasis — [ElevenLabs tags list](https://elevenlabs.io/blog/elevenlabs-audio-tags-list), [ElevenLabs prompting](https://elevenlabs.io/docs/best-practices/prompting)
- **Dia:** use nonverbal tags sparingly — [Dia GitHub](https://github.com/nari-labs/dia)
- **Chatterbox:** higher exaggeration speeds speech up, and a lower cfg_weight slows it — [Chatterbox GitHub](https://github.com/resemble-ai/chatterbox)
- **Acoustic-prosodic entrainment** (Levitan, Hirschberg et al., Interspeech 2016): an avatar architecture that makes its prosody converge with the user's, as people do with each other. It was evaluated by whether subjects were more likely to take the avatar's advice (English, Spanish, Slovak); the abstract doesn't state the outcome — [ISCA](https://www.isca-archive.org/interspeech_2016/levitan16_interspeech.html)
- **Hume's EVI 3 comparison** rated "interruption handling" and "response speed" alongside naturalness, and average latency ranged from about 1 s (Sesame) to 2.6 s (GPT-4o Realtime) — [Hume blog](https://www.hume.ai/blog/introducing-evi-3)

### Inferences (ARES recommendations)
- **How Katherine responds to each mood:**

  | User sounds | Katherine's response | Tags |
  |---|---|---|
  | Stressed or urgent | Slower, steadier, shorter, solution first, no jokes | no [laughs] |
  | Tired or flat | Shorter answers | `[softly]` |
  | Joking or laughing | Playful wording | an occasional `[laughs]` or `[chuckles]` |
  | Excited | Brighter, without outshouting them | `[excited]` |
  | Annoyed at ARES | Brief acknowledgement, fix it, no over-apologising | — |

- **Personality first.** Katherine's personality stays constant; emotion modulates it, it doesn't replace it.
- **Fillers sparingly.** Use them mainly where they hide real latency: a "Hmm, let me check" before a tool call or a longer think, which is the Duplex rationale. Never in every turn.
- **Let v4 do the small touches.** Rely on v4's built-in "human touches" and punctuation (ellipses, dashes) rather than hand-inserting many tags; one tag per clause at most.
- **Timing beats tags.** Fast turn-taking and barge-in handling probably matter more than any tag. ARES's voice v2 prompt already targets turn-taking and speed ([docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md), commit ca0697b); this work should complement it, not compete with it.

### Gaps
- The search budget ran out before I could retrieve 2024–2026 peer-reviewed studies on fillers and disfluencies in LLM-driven TTS, or on whether users prefer mood mirroring or a calibrated contrast. The Duplex evidence is from 2018 and used concatenative TTS.
- I did not retrieve the outcome numbers from the entrainment study.
- I found no quantitative data on how often ElevenLabs v4 or v3 reads a tag aloud or drops it; test with a fixed tag set.
