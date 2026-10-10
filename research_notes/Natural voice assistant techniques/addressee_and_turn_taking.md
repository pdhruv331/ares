# Addressee detection and natural turn-taking for a desk voice assistant (ARES)

Researched 2026-10-08. Numbers are vendor-reported unless marked independent. "Relative" EER reductions are relative to the stated baseline. EER = equal error rate (false accepts = false rejects). Where sources conflict, both are given.

## Q1. Device-directed (addressee) speech detection: approaches, features, accuracy, open resources, how to build one

### Takeaway
Every serious system (Amazon 2018–2021, Apple 2022–2025, Google 2022, attention labs 2026) fuses several weak cues instead of trusting one: acoustics/prosody, ASR decoder confidence, the words, dialogue context, and vision when there is a camera. Fusion roughly halves the error of the best single cue (Amazon: 5.2% EER fused vs 9.3% for the best single feature set). Interaction history is the biggest single context feature (removing it dropped one 2026 system from F1 0.95 to 0.57). Vision adds a lot too (F1 0.86 audio-only vs 0.95 with video). There is no good open-source model or public dataset for device-directed speech detection (DDSD), so a personal assistant has to build a small staged classifier calibrated on its owner's speech. An LLM judgement of the transcript should be one input among several: text-only judging is clearly worse than fusing in the acoustics, and general LLMs are weak at working out who is being addressed when several people talk.

### Cited Findings

**Amazon (Alexa)**
- Mallidi et al., "Device-directed Utterance Detection" (Interspeech 2018). Architecture: one LSTM over acoustic features, one LSTM over the ASR 1-best text, and a feed-forward DNN that fuses both embeddings with ASR decoder features. Purpose: reject false wakes and allow follow-up queries without the wake word. EER by feature set: ASR decoder features 9.3%, acoustic embedding 10.9%, 1-best text embedding 20.1%, all combined 5.2% (44% relative improvement). — [arXiv 1808.02504](https://arxiv.org/abs/1808.02504)
- Gillespie et al. (ICASSP 2020; Amazon Science blog, 6 May 2020). Semantic/lexical features (word vectors, an LSTM with attention over the words), ASR confidence ("low confidence suggests input unlike the training data, more likely non-device-directed") and dialogue context (the current turn plus the preceding turn, joined with separator tokens). Pre-trained on single-turn data, fine-tuned on multi-turn data. EER 9.1%, vs 10.6% for the acoustic-only baseline (about 14% relative); a DNN variant scored 19.2%. Used for Follow-Up Mode, to tell device-directed speech from background speech such as children or the TV. — [Amazon Science](https://www.amazon.science/blog/how-alexa-knows-when-youre-talking-to-her)
- Amazon "natural turn-taking" (blog, 24 Sep 2020). Adds on-device vision that infers from body position whether a person is addressing Alexa, fused with the existing acoustic DDSD in an on-device fusion model. Claimed to work while several people talk to each other and to Alexa. Also covers "contextual barge-in" and pacing cues (fillers such as "um", vowel lengthening, incomplete utterances). No accuracy numbers published. — [Amazon Science](https://amazon.science/blog/change-to-alexa-wake-word-process-adds-natural-turn-taking)
- Shipped as "Conversation Mode" on the Echo Show 10 in November 2021. — [TechCrunch](https://techcrunch.com/2021/11/18/amazon-officially-launches-its-more-natural-conversation-mode-option-for-echo-show-10)

**Apple (Siri), research line 2022–2025** (none of the papers says whether the methods ship in Siri)
- Garg et al., Interspeech 2022: DDSD for audio invoked without a wake word (touch/button-triggered). Distilling knowledge from an ASR-based model gave a 66% EER improvement over an acoustics-only baseline. — [arXiv 2203.15975](https://arxiv.org/abs/2203.15975)
- Wagner et al., NeurIPS 2023 workshop: audio-encoder outputs and ASR decoder signals become learnable fixed-length prefix vectors placed ahead of the text tokens of an LLM, trained with LoRA. The multimodal model beat unimodal baselines while using a fraction of the training data. — [Apple ML Research](https://machinelearning.apple.com/research/data-resource-efficient)
- Wagner et al., ICASSP 2024 ("A Multimodal Approach to DDSD with LLMs"), explicitly about dropping the trigger phrase. Compared audio-only classifiers, an LLM over ASR 1-best/decoder outputs, and a multimodal LLM. Fusion cut EER by up to 39% relative vs text-only and up to 61% vs audio-only; a larger LLM with LoRA gave up to 18% more. Apple's own listing of a related "multi-signal LLM" paper (DDSD cast as text generation, audio embeddings prepended; NeurIPS 2024 workshop) reports 38.9% vs text-only and 20.5% vs audio-only. The audio-only figure conflicts with the 61% above; it may be a different paper or version. — [arXiv 2403.14438](https://arxiv.org/abs/2403.14438); [Apple ML Research](https://machinelearning.apple.com/research/llm-device-directed-speech-detection)
- FLoRA (2024): adds audio to a text-only LLM through low-rank adapters. 22% relative EER reduction vs text-only, matching full fine-tuning. Adapter dropout made it robust to a missing modality: 20% lower EER and 56% fewer false accepts than full fine-tuning. — [arXiv 2406.09617](https://arxiv.org/abs/2406.09617)
- SELMA (ICASSP 2025): one audio+text LLM handles voice-trigger detection, DDSD and ASR together (three main tasks plus two auxiliary ones), with LoRA on both the audio encoder and the LLM. EER fell 64% relative for voice-trigger detection and 22% for DDSD, with word error rate about unchanged. — [arXiv 2501.19377](https://arxiv.org/abs/2501.19377); [Apple ML Research](https://machinelearning.apple.com/research/selma-speech-enabled-language)
- Rudovic et al., "Device-Directed Speech Detection for Follow-up Conversations Using LLMs" (Oct 2024). Models the initial query together with the follow-up, using ASR text, and puts ASR uncertainty into the prompt. Compared prompting a pretrained LLM with training a binary classifier on top of an LLM. Result: 20–40% fewer false alarms at a fixed 10% false-reject rate; the authors credit modelling the prior context together with ASR uncertainty. — [arXiv 2411.00023](https://arxiv.org/abs/2411.00023)
- Chi et al., "Adaptive Knowledge Distillation for DDSD" (Interspeech 2025; co-authors overlap with the Apple papers). Distils from a frozen large pre-trained ASR acoustic encoder with task adapters into a small transformer/conformer student. EER improved 26% for keyword invocations and 19% for keyword-free (follow-up) invocations over the student without distillation. — [arXiv 2508.02801](https://arxiv.org/abs/2508.02801)

**Google ("Look and Talk", Nest Hub Max, 2022; all processing on-device)**
- Phase 1, engagement detection: face detection, with face-box size as the proximity estimate (works within about 5 ft); Face Match for enrolled users; a custom multi-tower gaze CNN (whole-face tower plus eye-patch tower) giving a gaze angle and a gaze-on-camera confidence; temporal smoothing to ignore blinks, saccades and glances. The attention requirement is strict before the device signals readiness and relaxes once the user starts speaking. An audio-visual active-speaker model (five video frames plus 0.5 s of audio, quantized TFLite). — [Google Research blog](https://research.google/blog/look-and-talk-natural-conversations-with-google-assistant/)
- Phase 2, intent validation: Voice Match must agree with Face Match; on-device ASR; a non-lexical audio model (pitch, speed, hesitation sounds) plus a text model that judges whether the transcript is an Assistant request, plus visual context. Intent models run on partial utterances to keep latency down. End-to-end latency is described as "comparable" to hotword use (no figures). Fairness was tested on a video dataset of over 3,000 participants; augmentation improved active-speaker detection by over 10%. — [Google Research blog](https://research.google/blog/look-and-talk-natural-conversations-with-google-assistant/)
- Model count conflicts: the research blog says "eight machine learning models"; Google's I/O 2022 post says six models processing more than 100 signals (proximity, head orientation, gaze direction, lip movement, context awareness, intent classification). — [Google blog (I/O 2022)](https://blog.google/products/assistant/assistant-io-2022/); [Google Research blog](https://research.google/blog/look-and-talk-natural-conversations-with-google-assistant/)

**Recent work and products from others (2025–2026)**
- Selective Attention System (SAS; Kim et al., Apr 2026). Treats addressee detection before ASR as sequential routing over recent interaction history ("SDAR"), not as per-utterance classification. Runs on-device (under 20 MB, under 150 ms on ARM Cortex-A). Audio-only: F1 0.86 (P 0.89 / R 0.83). Audio+video: F1 0.95 (P 0.97 / R 0.93). Removing the interaction-history stage dropped audio+video F1 to about 0.57. Caveat: tested on a proprietary 60-hour English multi-speaker set; only a 5-hour subset may be shared. — [arXiv 2604.08412](https://arxiv.org/abs/2604.08412)
- The same group's SDK (attention labs "saa-sdk"): the client SDKs are Apache-2.0 and have LiveKit, Pipecat, ElevenLabs and Twilio examples, but the model is hosted (cloud WebSocket). On-device use needs a separate enterprise licence. 127 stars at the time of reading. — [GitHub attenlabs/saa-sdk](https://github.com/attenlabs/saa-sdk)
- Gaze as the wake signal on AR glasses (University of Tokyo / Sony CSL, 2025): sustained eye contact with a virtual avatar starts the interaction. — [arXiv 2504.09296](https://arxiv.org/html/2504.09296v1)
- Meta smart glasses: I found no Meta paper on DDSD. Product claims about dropping the repeated "Hey Meta" came only from secondary sites (see Gaps).

**Academic and open resources; LLMs as judges**
- Siegert et al. (2022) review 23 addressee-detection studies, 12 of them deep learning, many on in-house data. — [Frontiers in Computer Science](https://frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2022.831784/text)
- Akhtiamov, Siegert, Karpov & Minker (SIGdial 2019), Voice Assistant Conversation Corpus (German): acoustic addressee detection at about 0.89 unweighted average recall; about 2 s of speech can be enough. Abstract-level detail only. — [ACL Anthology author listing](https://preview.aclanthology.org/update-css-js/people/i/ingo-siegert)
- Shriberg et al. (Interspeech 2012), legacy: a corpus with two people and a computer in the dialogue, studying how computer-directed speech differs from human-directed speech. — [ISCA Archive](https://www.isca-archive.org/interspeech_2012/shriberg12_interspeech.html)
- Inoue et al. (IWSDS 2025), multi-party addressee recognition benchmark (three-person discussions): about a fifth of turns have an explicit addressee, and GPT-4o is barely above chance, mostly predicting "no addressee" when there was one. — [arXiv 2501.16643](https://arxiv.org/abs/2501.16643)
- MSI-Bench (Sep 2026; Xiong, …, Mu Li, Alex Smola): 1,152 multi-speaker audio scenes (English and Mandarin). Models "often respond when no one addressed them"; the paper names "conversational restraint" as a target. Best configuration passed 66.8% (EN) / 54.5% (ZH) of cases; best open-weight 34.0% / 19.3%. Frontier systems fail speaker-scoped decisions even on clean transcripts. — [arXiv 2609.24812](https://arxiv.org/abs/2609.24812)

### Inferences
- **Which cues matter, by the evidence:** (1) Dialogue context and history: the largest single effect in SAS, 20–40% fewer false alarms for Apple's follow-ups, and part of Amazon's 2020 gains. (2) Vision (gaze, face orientation, proximity): it lets Google drop the hotword and adds 9 F1 points in SAS. (3) ASR decoder confidence: the best single feature in Amazon 2018 (9.3% EER). (4) Words: weak alone (20.1% EER in 2018), strong with context. (5) Prosody (pitch, rate, hesitations, loudness): a standard non-lexical channel in Google's and Amazon's systems. Speaker identity (Voice Match / Face Match) is a gate, not a directedness cue.
- **Absolute error rates stay high even in industry.** About 5% EER (Amazon, fused) means that for hundreds of overheard utterances a day, an assistant tuned at its EER point would answer some of them wrongly. A desk assistant should run at a high-precision point ("when unsure, stay quiet"), raise its threshold in multi-party situations (calls, other voices) and lower it with strong evidence (name, gaze at the screen, a follow-up to its own question).
- **How to build one for a single-owner Mac assistant (no public data, so learn from the owner):**
  - Stage 0: the existing gates (VAD, owner voiceprint/trust, AEC so the Mac's own audio is ignored).
  - Stage 1: high-precision rules (name, wake word, stop words) and hard context vetoes (on a call: wake word only).
  - Stage 2: a tiny calibrated model (logistic regression or gradient-boosted trees). Features: rule hits; sentence form (imperative, question, second person "you"); ASR confidence; prosody relative to the owner's own directed-speech baseline; near-field level; seconds since ARES spoke and whether it asked a question; topical overlap with ARES's last answer; face present and facing the screen (from ARES Vision); recent keyboard/mouse activity; other voices present.
  - Stage 3: only for the ambiguous middle band, an on-device LLM judge with the previous exchange, the utterance and ASR alternatives in the prompt (the Apple follow-up recipe), returning a structured yes/no and confidence. Apple's on-device Foundation Models framework (about 3B parameters, guided generation into Swift types, about 4K token context per third-party write-ups, M1 or newer, free and offline) fits this. — [Create with Swift](https://createwithswift.com/exploring-the-foundation-models-framework/); [blakecrosley.com](https://blakecrosley.com/blog/foundation-models-on-device-llm)
- **Labels without logging overheard text:** use implicit feedback ("ARES, I was talking to you" = a false reject; "not you" or an immediate "stop" = a false accept), store feature vectors and scores only, and keep consented test recordings in the local voice lab. Report false accepts per hour of non-directed speech (TV, calls, self-talk) and false rejects at a fixed operating point, like Apple's "false alarms at 10% false rejects".
- **Don't put the LLM judge in charge.** Text-only LLM judging trails fusion by up to 39% relative EER (Apple), and LLMs barely beat chance at multi-party addressee recognition (IWSDS 2025, MSI-Bench). Use it as a feature or tie-breaker.

### Gaps
- No absolute EERs from Apple (relative numbers only), and no published false-accept or false-reject rates for any shipped wake-word-free product (Look and Talk, Conversation Mode, Alexa+, Gemini).
- No openly licensed DDSD audio dataset or model was found. The Voice Assistant Conversation Corpus licence and availability were not confirmed; SAS's data is proprietary.
- Meta: no primary source found for smart-glasses DDSD or for "Hey Meta"-free follow-ups (secondary reports only, e.g. [Engadget](https://engadget.com/wearables/metas-smart-glasses-have-a-new-shortcut-to-call-and-text-without-saying-hey-meta-213303178.html) describes a different shortcut feature).
- No source measured the latency of Apple's on-device Foundation Model on a short classification prompt on M-series Macs; this needs measuring.
- macOS Vision head-pose outputs (yaw/pitch) were not verified here. ARES Vision currently emits only a face box (CLAUDE.md), which gives presence and a rough proximity, not gaze.

## Q2. Conversation and follow-up windows: how commercial assistants decide a follow-up is meant for them, and how long they listen

### Takeaway
Commercial follow-up windows are short: 5 s for Alexa Follow-Up Mode (2018), up to 8 s for Google Continued Conversation (2018), and "a few seconds" for Siri back-to-back requests (iOS 17) and Gemini for Home (2026). They are opt-in, show a visible listening cue, and still pass every utterance through a device-directedness classifier; camera devices use face orientation to accept speech without the wake word. ARES's 20 s window is 2.5–4× longer than any of these, so it needs a decaying prior and more evidence the longer it stays open.

### Cited Findings
- Alexa Follow-Up Mode (March 2018 launch) kept the mic open about five seconds after Alexa finished responding. — [TechCrunch 2018](https://techcrunch.com/2018/03/10/now-you-can-have-a-conversation-with-alexa-without-screaming-hey-alexa-for-every-request/)
- Google Continued Conversation (2018) kept listening up to about eight seconds without new speech, and stayed open while the user kept issuing commands. — [Search Engine Land](https://searchengineland.com/google-turns-on-continued-conversation-in-the-google-assistant-300741)
- Inside the window, Alexa's directedness classifier separates device-directed speech from background speech (children, TV), using words, ASR confidence and the preceding turn. — [Amazon Science](https://www.amazon.science/blog/how-alexa-knows-when-youre-talking-to-her)
- Amazon's 2020 natural turn-taking also decides when the user has finished and whether a reply is expected. — [Amazon Science](https://amazon.science/blog/change-to-alexa-wake-word-process-adds-natural-turn-taking)
- Alexa+ Follow Up Mode: no wake word needed on follow-ups, with a visual cue for when you can speak. Compatible Echo Show devices also accept interruptions without the wake word when the camera sees you facing the screen. No window length is stated. (Amazon help page, served from an amazon.com subdomain.) — [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/TtQI6drnxX9fpAYrc1)
- Gemini for Home Continued Conversation returned from 21 April 2026: the mic stays open "for a few seconds", earlier exchanges are kept as context, all supported languages, opt-in in the Google Home app. — [Google blog](https://blog.google/products-and-platforms/devices/how-to-use-gemini-continued-conversation/); [MobileSyrup](https://mobilesyrup.com/2026/04/22/continued-conversations-back-google-home/)
- Siri (iOS 17, 2023): "Siri" alone works as the trigger; back-to-back requests need no re-trigger; Siri listens for a follow-up for only a few seconds after replying; commands can't be stacked in one request. — [9to5Mac](https://9to5mac.com/2023/06/05/siri-no-longer-requires-hey-command/); [iMore](https://imore.com/ios/ios-17/how-to-use-ios-17s-new-siri-features-and-upgrades); [AppleInsider](https://appleinsider.com/inside/ios-17/tips/how-to-use-back-to-back-commands-with-siri-in-ios-17)
- Apple's research treats keyword-free follow-ups as a separate, harder DDSD problem: modelling the first query plus ASR uncertainty gave 20–40% fewer false alarms, and distillation gave 19% EER improvement on keyword-free invocations. — [arXiv 2411.00023](https://arxiv.org/abs/2411.00023); [arXiv 2508.02801](https://arxiv.org/abs/2508.02801)
- Look and Talk applies hysteresis: strict attention before signalling readiness, relaxed once speech starts. — [Google Research blog](https://research.google/blog/look-and-talk-natural-conversations-with-google-assistant/)
- ARES today: a 20-second follow-up window after its reply, decided by regex rules (task brief). The voice v2 plan keeps "follow-ups without the wake word for ~20 s after her reply". — [docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md)

### Inferences
- A flat 20 s window exposes ARES to 2.5–4× more overheard speech per reply than the commercial designs. A better design is a graded prior:
  - 0–6 s after ARES finishes (the commercial window): accept with the normal stage-2 threshold.
  - 6–20 s: require more evidence (facing the screen, direct second-person or imperative form, topical continuity with the last answer).
  - Extend when ARES's reply ended with a question to the owner (a reply is expected, as in Amazon 2020).
  - Close early when other voices, a call, or media playback appear.
- Keep a visible "still listening" cue on the reactor or orb. Every commercial follow-up mode signals the open mic, and that also tells the owner when ARES expects a follow-up.

### Gaps
- No published false-accept or false-reject rates for any commercial follow-up window. The current Alexa+ and Gemini window lengths are given only qualitatively.
- No evidence was found on the user-preferred window length; the 5–8 s figures are product choices, not study results.

## Q3. End-of-turn detection (endpointing): semantic turn models, how they combine with VAD, latency, measured gains, licences, on-device feasibility

### Takeaway
Semantic and acoustic end-of-turn (EOT) models clearly beat silence timers, but none reach human timing. On LiveKit's open eot-bench (English), a silence-only rule needs 1.6 s of silence to keep false cut-offs at or below 5% (1.0 s for 10%). The best locally runnable open models (Smart Turn v3.2, LiveKit v1-mini) need about 1.05 s (about 0.7 s for 10%); the best hosted models about 0.54 s (about 0.3 s). For an on-device Mac assistant, the practical core is a short VAD stop (about 0.2 s) feeding Smart Turn v3.2 (BSD-2, 8 MB, about 3.5 ms on CoreML per a third party), plus a max timeout of about 2.5–3 s, transcript cues and per-user adaptation. Parakeet-EOU and Kyutai STT-1B instead fold EOT into the speech recogniser.

### Cited Findings

**Head-to-head benchmark: LiveKit eot-bench (released June 2026; code and data Apache-2.0)**
- Data: real human-to-agent user turns from task-oriented conversations, in 14 languages. Every silence of 100 ms or more is a decision point: the last one is the true end of turn, earlier ones are mid-turn "hold" pauses. Scoring is causal (0.1 s inference interval, 0.5 s transcript lag). Each model's scores go through a policy sweep (threshold, minimum action delay, timeout). "Latency" means the dead air after the true end of turn, not inference time. — [GitHub livekit/eot-bench](https://github.com/livekit/eot-bench)
- English validation results. False cut-off = the system ends the turn during a mid-turn pause. "–" = no setting reached that budget. — [GitHub livekit/eot-bench](https://github.com/livekit/eot-bench)

  | Model | False cut-offs @300 ms | @600 ms | Latency @5% cut-offs | @10% cut-offs |
  |---|---|---|---|---|
  | LiveKit Turn Detector v1 | 9.9% | 4.5% | 543 ms | 295 ms |
  | JoinIn AI Baton | 12.3% | 4.8% | 577 ms | 350 ms |
  | Deepgram Flux | 12.9% | 9.9% | 1151 ms | 548 ms |
  | ultraVAD | 27.7% | 11.9% | 899 ms | 663 ms |
  | LiveKit v1-mini | 27.8% | 12.1% | 1070 ms | 698 ms |
  | Smart Turn v3.2 | 35.2% | 14.8% | 1051 ms | 739 ms |
  | VAP (silent agent) | 46.9% | 14.6% | 1131 ms | 749 ms |
  | AssemblyAI | 49.4% | 14.6% | 1049 ms | 713 ms |
  | Gradium | 55.6% | 12.6% | 913 ms | 656 ms |
  | Soniox | – | 5.5% | 647 ms | 512 ms |
  | Cartesia Ink 2 | – | – | 1056 ms | 911 ms |
  | OpenAI GPT Realtime 2 | – | – | 1143 ms | 824 ms |
  | VAD (silence-only) baseline | 55.6% | 21.7% | 1600 ms | 1000 ms |

- Caveat: LiveKit built the benchmark around its own model, so it is vendor-run; outside teams can rerun the open suite. — [GitHub livekit/eot-bench](https://github.com/livekit/eot-bench)

**LiveKit turn detector**
- v1 and v1-mini (17 June 2026): audio-based with no transcription step. A semantic branch (audio encoder, adapter into the LLM embedding space, fine-tuned LLM) and an acoustic branch (encoder plus recurrent layer for timing and prosody) are fused. Looks at the current user turn only. 14 languages. v1 is served through LiveKit Inference (free on LiveKit Cloud; 7,500 free requests a month for local development). v1-mini has quantized weights and a pruned backbone for CPU and ships in livekit-agents (Python 1.6.1 / TS 1.4.7). Code Apache-2.0; weights under the custom "LiveKit Model License". — [LiveKit blog](https://livekit.com/blog/solving-end-of-turn-detection)
- Earlier text-based versions: v0.4.1-intl cut false-positive interruptions 39.23% relative vs v0.3.0-intl at the same true-positive rate (99.3%), with no added delay (about 22% gain in English to about 54% in Dutch). — [LiveKit blog](https://livekit.com/blog/improved-end-of-turn-model-cuts-voice-ai-interruptions-39)
- The December 2024 first model claimed an 85% reduction in unintended interruptions with 3% false positives (user done, model waits). This measures a different error from eot-bench's false cut-off. — [LiveKit on X](https://x.com/livekit/status/1870194692912214167)
- Policy defaults in LiveKit Agents:
  - Endpointing min_delay 0.5 s (0.3 s with the audio turn detector) and max_delay 3.0 s (2.5 s with the audio turn detector).
  - A "dynamic" endpointing mode adapts the delay within that range from the session's pause statistics (EMA alpha 0.9).
  - Preemptive generation is on by default: the LLM only, not TTS; skipped when user speech is over 10 s; at most 3 retries per turn.
  — [LiveKit docs](https://docs.livekit.io/reference/agents/turn-handling-options/)
- LiveKit's tuning guide gives switching to the turn detector model as the first fix when an agent cuts users off mid-thought. — [LiveKit docs](https://docs.livekit.io/agents/logic/turns/tuning/)

**Pipecat Smart Turn (fully open: BSD 2-clause)**
- v3.2: Whisper Tiny encoder plus a linear classifier, about 8M parameters. CPU build int8 about 8 MB; GPU build fp32 about 32 MB. Audio only (16 kHz mono, up to 8 s, left-padded), no transcript. 23 languages. Designed to run only when a lightweight VAD (for example Silero) detects silence, re-running on the whole turn if speech resumes. Not designed for very short segments. Training data and scripts are open (HF datasets `pipecat-ai/smart-turn-data-v3.2-train` and `-test`). Planned: text conditioning for things like phone-number entry. — [GitHub pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
- v3 (2025) inference: about 12.6 ms on an AWS c7a.2xlarge CPU and about 3.3 ms on an L40S GPU, vs about 450 ms for v2 on the same CPU. — [Daily blog](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/)
- v3.1 accuracy on Daily's test set: English / Spanish 88.3% / 86.7% (v3.0) → 94.7% / 90.1% (v3.1 CPU) and 95.6% / 91.0% (GPU). Gains came from more human (non-TTS) speech and better quantization. — [Daily blog](https://www.daily.co/blog/improved-accuracy-in-smart-turn-v3-1/)
- Apple Silicon (third party): a v3.2 CoreML build at about 3.5 ms per 8 s window; int8 ONNX about 20 ms on 4 threads; 92.9% (CoreML) / 93.0% (int8 ONNX) on 1,000 upstream test clips. — [soniqo.audio guide](https://soniqo.audio/guides/turn)
- Pipecat recommends a short VAD stop_secs of 0.2 s with Smart Turn, so the classifier's few milliseconds come after that silence wait. — [Pipecat docs](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview)
- Independent results (lower):
  - eot-bench: 35.2% false cut-offs at 300 ms (table above).
  - Bangla: about 69% accuracy vs 84% for a dedicated model. — [arXiv 2609.29371](https://arxiv.org/pdf/2609.29371)
  - Helwani et al. (Mar 2026): end-to-end recall 58.9% and 800–1300 ms detection latency for Smart Turn v3, vs 87.7% recall and 36 ms median for their 1.14M-parameter MFCC student. That model was distilled from a wav2vec 2.0 teacher, uses primary-speaker segmentation to ignore background talkers, and scores frame F1 82% and backchannel F1 70.6%. — [arXiv 2603.13379](https://arxiv.org/abs/2603.13379)

**Commercial APIs (cloud; for comparison only)**
- Deepgram Flux: EOT is built into the recogniser.
  - Parameters: eot_threshold 0.5–1.0 (default 0.7); eager_eot_threshold 0.3–0.9 (off by default; enables EagerEndOfTurn and TurnResumed events); eot_timeout_ms 500–60000 (default 5000; forces end of turn after that much silence). Setting the threshold to 1.0 plus ForceEndTurn lets the app own turn-taking. — [Deepgram docs](https://developers.deepgram.com/docs/flux/configuration)
  - About 260 ms EOT detection quoted. — [Deepgram quickstart](https://developers.deepgram.com/docs/flux/quickstart.mdx)
  - Eager mode raises LLM calls by 50–70%. — [Deepgram eager EOT guide](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot)
  - Telnyx reports a median gain of about 150 ms on turns where eager fires, up to about 350 ms at the tail (Jan 2026). — [Telnyx release notes](https://telnyx.com/release-notes/automatic-eager-end-of-turn-deepgram-flux)
- OpenAI Realtime `semantic_vad`: a semantic classifier estimates from the words whether the user is done. Low probability → wait for a timeout; high → no wait; trailing-off speech gets a longer timeout. `eagerness` low / medium / high / auto (auto = medium) tunes the maximum wait (no seconds published). `server_vad` example values: threshold 0.5, prefix_padding_ms 300, silence_duration_ms 500. — [OpenAI docs](https://developers.openai.com/api/docs/guides/realtime-vad)
- AssemblyAI, Soniox, Cartesia, Gradium, ultraVAD and Baton appear in the eot-bench table above; Soniox is strongest at the 600 ms budget (5.5% false cut-offs). — [GitHub livekit/eot-bench](https://github.com/livekit/eot-bench)
- Krisp VIVA 2.0 (6 May 2026): "Turn Prediction v3" (audio-only, multilingual) and "Interrupt Prediction v1". Krisp says the turn model is light enough for local hardware. Its 3.5× turn-taking accuracy gain from cleaning audio ahead of VAD is vendor-only; there is no independent benchmark. Pipecat integrates it as a Smart Turn alternative. — [01net](https://www.01net.it/krisp-launches-viva-2-0-introducing-voice-infrastructure-for-voice-ai-agents/); [Pipecat docs](https://docs.pipecat.ai/pipecat/features/krisp-viva.md)

**On-device, ASR-integrated options**
- NVIDIA parakeet_realtime_eou_120m-v1: 120M-parameter streaming FastConformer-RNNT (English, no punctuation) that emits an `<EOU>` token. 80–160 ms latency. NVIDIA Open Model License (commercial use allowed). — [Hugging Face model card](https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1)
  - Swift/CoreML wrapper (FluidInference): 160/320/1600 ms chunks and an EOU silence debounce (1280 ms in its examples). — [FluidInference docs](https://docs.fluidinference.com/asr/streaming)
  - A third-party CoreML guide measures about 340 ms partial latency, about 200 MB peak memory, and about 1 s from speech end to commit. Keyboard clicks, mouse noise and room tone can emit stray tokens that reset the EOU timer, so production setups add a VAD backstop. — [soniqo.audio dictation guide](https://soniqo.audio/guides/dictate)
- Kyutai STT:
  - `stt-1b-en_fr`: about 1B parameters, 0.5 s delay, includes a semantic VAD. `stt-2.6b-en`: 2.5 s delay. Runs on MLX on Apple Silicon (`moshi-mlx` ≥ 0.2.6); the 1B model reportedly runs on an iPhone 16 Pro. Weights CC-BY 4.0; code MIT / Apache. The semantic VAD is documented only in the Rust standalone example (`--vad`). — [GitHub kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling)
  - Kyutai argues fixed timers fail because no single delay fits all situations; its model adapts the wait to the wording and intonation. It powers Unmute (May 2025). — [Kyutai STT page](https://kyutai.org/next/stt); [Kyutai Unmute](https://kyutai.org/2025/05/22/unmute.html)
  - TurnBench notes the semantic VAD has no native interruption output. — [arXiv 2608.25218](https://arxiv.org/abs/2608.25218)
- Apple SpeechDetector (macOS 26): a voice-activity module paired with SpeechTranscriber/DictationTranscriber in SpeechAnalyzer, with sensitivity levels (medium recommended). Developers hit a SpeechModule conformance compile error (a fix was promised in a point update), and its results stream reportedly carries only VAD errors, not speech start/stop events. — [Apple docs](https://developer.apple.com/documentation/speech/speechdetector); [Apple Developer Forums](https://developer.apple.com/forums/thread/797544)

**Research models and benchmarks**
- Voice Activity Projection (VAP; Ekstedt & Skantze 2022; real-time version by Inoue et al. 2024):
  - Architecture: CPC encoder, per-speaker self-attention plus cross-attention, predicting both speakers' voice activity over a 2 s horizon (4 bins, 256 joint states). Runs live on CPU with little loss. — [arXiv 2401.04868](https://arxiv.org/abs/2401.04868)
  - Code: [ErikEkstedt/VoiceActivityProjection](https://github.com/ErikEkstedt/VoiceActivityProjection), [inokoj/VAP-Realtime](https://github.com/inokoj/VAP-Realtime).
  - Single-language models transfer poorly; joint training on three languages matches per-language models. — [arXiv 2403.06487](https://arxiv.org/abs/2403.06487)
  - VAP needs both channels (user and agent) and was not built for human-to-agent endpointing; it scores mid-pack on eot-bench (46.9% false cut-offs at 300 ms).
- TurnBench (IEEE SLT 2026): 30 h of hand-labelled dyadic conversation in six interaction styles, triple-annotated, plus a 104 h training set and a leaderboard; 14 systems benchmarked. EOT recall is stable across conversation types; interruption false positives depend strongly on conversation type and cluster in backchannel-dense styles. — [arXiv 2608.25218](https://arxiv.org/abs/2608.25218)
- Amazon's pacing cues for "has the user finished?": filler words, vowel lengthening, incomplete utterances. — [Amazon Science](https://amazon.science/blog/change-to-alexa-wake-word-process-adds-natural-turn-taking)

### Inferences
- **The size of the win for ARES.** Replacing a fixed silence timeout with Smart Turn v3.2 cut the silence needed for ≤5% false cut-offs from about 1.6 s to about 1.05 s (≈34%), and for ≤10% from 1.0 s to about 0.74 s, on eot-bench English. LiveKit v1-mini, the only other local option there, is about the same (1.07 s / 0.70 s) and has a less clear licence. The hosted leaders (LiveKit v1, Baton, Soniox) are 0.3–0.6 s, but the voice v2 hard rule forbids cloud audio for turn-taking, so they are reference points only.
- **The endpoint decision alone eats most of the v2 budget.** Even with Smart Turn, about 0.7–1.05 s goes to deciding the turn ended, against a target of first audio under 1 s. Hitting the target therefore needs:
  - preemptive LLM generation on an "eager" score (LiveKit's default: LLM only, not TTS, which also protects ElevenLabs credits);
  - per-owner adaptation: dynamic endpointing from the owner's own pause statistics, and possibly fine-tuning Smart Turn on consented recordings with the open training scripts;
  - transcript cues from the SFSpeech partials: extend when the words end on a conjunction, preposition or filler ("and", "so", "um"); shorten after a complete question or command.
- **For stage A5, copy eot-bench's protocol on the owner's recordings.** Label every silence of 100 ms or more as hold or end-of-turn; sweep threshold, minimum delay and timeout; report false cut-offs at 300 / 600 ms and latency at 5% / 10% cut-offs. Candidates:
  - (a) the current fixed timeout;
  - (b) VAD (0.2 s stop) + Smart Turn v3.2 CoreML;
  - (c) (b) plus transcript cues;
  - (d) Parakeet-EOU (English; watch keyboard-click false continuations at a desk);
  - (e) Kyutai STT-1B semantic VAD via MLX (en/fr; would replace SFSpeech);
  - (f) LiveKit v1-mini, if its licence permits use outside LiveKit Agents.
- **A suggested starting policy to tune (not from any single source):** VAD stop about 200 ms → Smart Turn. If P(complete) ≥ T, end the turn. Otherwise re-score every 100–200 ms as silence grows, with a hard cap of 2.5 s (LiveKit's default with an audio detector) or longer when the transcript ends mid-clause. Start the Claude request at a lower "eager" threshold and cancel it if the owner resumes.

### Gaps
- No independent head-to-head of EOT models on Apple Silicon, on en-GB or Indian-English accents, or on desk audio with typing.
- The terms of the LiveKit Model License (whether v1-mini may be used outside LiveKit Agents) were not checked.
- TurnBench's per-system numbers could not be read (PDF extraction failed); only the abstract-level conclusions are used.
- Latency of SFSpeech final results (the current ASR) is unknown and needs the stage A1 instrumentation.
- OpenAI's semantic_vad timeout values per eagerness level are not published.

## Q4. Interruptions and barge-in: real interruption vs cough or "mm-hm", stopping fast, resuming, false barge-ins

### Takeaway
Current best practice has four parts:
1. Echo cancellation, so the assistant never hears itself.
2. An onset classifier, or duration and word thresholds, to separate real barge-ins from backchannels, coughs and noise.
3. Pause, then resume if no real words follow (a "false interruption").
4. Trim the assistant's own context to what the user actually heard.

The best measured classifier, LiveKit's adaptive interruption model (March 2026), rejects 51% of VAD barge-ins at 86% precision and 100% recall and triggers on a median 216 ms of speech, but it is cloud-hosted. An on-device assistant must approximate it with rules and resume logic. Research (TurnBench) finds no system detects interruptions without too many false positives in backchannel-heavy talk.

### Cited Findings
- **LiveKit Adaptive Interruption Handling (GA 19 March 2026).**
  - Method: classifies speech during the agent's turn from the first few hundred ms of audio (waveform shape, onset strength, duration, pitch and rhythm) with an audio encoder plus a CNN, trained on real interruptions, backchannels and other sounds from one-on-one conversations, multilingual. Inference ≤ 30 ms.
  - Results: 86% precision and 100% recall at 500 ms of overlapping speech; rejects 51% of VAD-based barge-ins; detects true barge-ins faster than VAD in 64% of cases; median 216 ms of audio to trigger.
  — [LiveKit blog](https://livekit.com/blog/adaptive-interruption-handling)
- It needs LiveKit Cloud (or dev mode) and is hosted because of its size and GPU needs; self-hosted agents fall back to VAD. Errors cluster at turn boundaries, hence a `backchannel_boundary` hold-off. — [LiveKit docs](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/)
- A self-hosted telephony team reported that "hmm"/"yeah" trigger unwanted cut-offs under VAD and asked for a self-hostable model. — [GitHub livekit/agents#6033](https://github.com/livekit/agents/issues/6033)
- **LiveKit's rule-based defaults (the self-hosted path):**
  - min_duration 0.5 s of speech to count as an interruption; min_words 0 (applies only with STT);
  - false_interruption_timeout 2.0 s (the silence after an interruption before it is declared false); resume_false_interruption = true (resume the agent's speech);
  - backchannel_boundary (1.0 s, 1.0 s) cooldown around each agent turn so real corrections aren't discarded as backchannels;
  - discard_audio_if_uninterruptible = true.
  — [LiveKit docs](https://docs.livekit.io/reference/agents/turn-handling-options/)
- LiveKit's guidance: for short acknowledgements that keep interrupting, use adaptive mode or raise the word or duration minimums, and leave the false-interruption timeout and resume at their defaults. A false interruption is described as VAD stopping playback on (say) a cough, no transcript arriving, and the agent continuing where it left off after a silence window. — [LiveKit tuning docs](https://docs.livekit.io/agents/logic/turns/tuning/); [LiveKit blog](https://livekit.com/blog/turn-detection-and-interruption-handling)
- Krisp "Interrupt Prediction v1" (May 2026) is an audio-only interruption classifier. Pipecat's Krisp interruption strategy scores audio after VAD fires and opens a user turn only above a probability threshold (default 0.5), so "uh-huh" doesn't cut the bot off. — [01net](https://www.01net.it/krisp-launches-viva-2-0-introducing-voice-infrastructure-for-voice-ai-agents/); [Pipecat docs](https://docs.pipecat.ai/pipecat/features/krisp-viva.md)
- OpenAI Realtime has `interrupt_response` (VAD barge-in cancels the response) and `conversation.item.truncate` with `audio_end_ms`, which syncs the server-side conversation to the audio the user actually heard. — [OpenAI docs](https://developers.openai.com/api/docs/guides/realtime-vad); [OpenAI API reference](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/truncate)
  - Developers report the stored transcript can still contain unheard text and playback estimates can overshoot, so apps should track played audio themselves. — [OpenAI community](https://community.openai.com/t/realtime-api-interruptions-dont-properly-trim-the-transcript/1000703)
- Alexa "contextual barge-in": the offset between the start of Alexa's output and the interruption estimates how far Alexa got, and that is passed to the dialogue manager to resolve references such as "that one". — [Amazon Science](https://amazon.science/blog/change-to-alexa-wake-word-process-adds-natural-turn-taking)
- Full-Duplex-Bench "user interruption" task. Moshi always yields (takeover 1.000) but its replies after the interruption are poor (GPT-4o score 0.765/5). Freeze-Omni 3.615/5 at 1.41 s; Gemini Live 3.376/5 at 1.18 s. — [arXiv 2503.04721](https://arxiv.org/html/2503.04721)
- TurnBench: interruption detection is the weak spot; no current system performs well "without incurring excessive false positives", especially in backchannel-dense conversation. — [arXiv 2608.25218](https://arxiv.org/abs/2608.25218)
- Backchannel recognition is feasible with small models: 70.6% backchannel-detection F1 for a 1.14M-parameter causal model. — [arXiv 2603.13379](https://arxiv.org/abs/2603.13379)
- Without echo cancellation, full-duplex demos break: Moshi's command-line clients do no echo cancellation, so its web UI is recommended. — [GitHub kyutai-labs/moshi](https://github.com/kyutai-labs/moshi)
- ARES v2 target: barge-in stops her within about 200 ms (trust-checked), and "wait / hold on / stop" always works. Current barge-in uses VPIO echo cancellation. — [docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md)
- ARES's captions already carry word timing: comms.js `mirror()` sends each sentence's schedule (segments, word starts, the clock). — [CLAUDE.md](file:///Users/dhruv/My%20AI/CLAUDE.md)

### Inferences
- **An on-device barge-in policy for ARES:**
  - On trusted (owner) VAD onset during TTS, duck the TTS volume within about 50–100 ms rather than stopping it.
  - Confirm a real interruption if any of these holds:
    - (a) a stop word (stop / wait / hold on / "Hey ARES") → hard stop immediately;
    - (b) at least 300–500 ms of owner speech whose partial transcript is not a backchannel ("mm-hm", "yeah", "right", "okay", "uh-huh");
    - (c) the onset falls inside a ±1 s boundary around ARES's own turn edges, where corrections are likely (LiveKit's backchannel_boundary idea).
  - If nothing confirms within about 1.5–2 s (LiveKit uses 2.0 s), restore the volume and continue: the false-interruption resume.
  - This meets the 200 ms "she reacts" target with the duck while keeping hard stops for real interruptions. The duck-first design is my inference, not a sourced practice.
- **Truncate the brain's history to what was actually heard.** Use the comms.js word schedule to work out which words were played before the cut, and tell Claude, e.g. "[interrupted after: '…']". This is the Alexa contextual barge-in and OpenAI truncate pattern, and it avoids Claude "remembering" sentences the owner never heard.
- **Upgrade path:** if the owner's recordings show many false barge-ins from "mm-hm" or coughs, train a small onset classifier on them. LiveKit's design (audio encoder plus CNN on about 200–500 ms of overlap) is small enough in principle; Krisp may license an on-device one.

### Gaps
- No open-source, on-device backchannel-vs-interruption classifier with published accuracy was found. LiveKit's is cloud-only; Krisp's on-device availability is unclear.
- No data on how well macOS VPIO echo cancellation suppresses ElevenLabs playback at desk volumes (residual echo causing self-barge-in), or on duck-versus-stop user preference.

## Q5. Backchannels, overlap and full-duplex spoken dialogue models: what's practical vs research

### Takeaway
Full-duplex speech-to-speech models (Kyutai Moshi, NVIDIA PersonaPlex, Meta/UW SyncLLM, Tencent's Freeze-Omni) are research-grade for turn-taking:
- On Full-Duplex-Bench, Moshi takes the floor at about 98% of user pauses, essentially never produces backchannels (takeover 1.0 on backchannel cues), and answers poorly after interruptions.
- Even Gemini Live misses a third of turn opportunities and averages about 1.3 s; benchmark v2 finds systems fast but weak at multi-turn context and interruptions.

Moshi does run locally on Apple Silicon (MLX, int4/int8, CC-BY weights), but a 7B Helium model can't replace Claude. What's practical in 2026 is a cascaded pipeline with semantic EOT, interruption filtering and preemptive generation. Assistant-produced backchannels remain largely research (VAP-based prediction exists).

### Cited Findings
- **Full-Duplex-Bench v1 (Lin et al., Mar 2025; open code)** tested dGSLM, Moshi, Freeze-Omni and Gemini Live (gemini-2.0-flash-live-001); GPT-4o was used only as a judge. Takeover rate (TOR) = how often the model takes the floor. — [arXiv 2503.04721](https://arxiv.org/html/2503.04721); [GitHub](https://github.com/DanielLin94144/Full-Duplex-Bench)
  - Pause handling (TOR, lower is better), synthetic / Candor: dGSLM 0.934 / 0.935; Moshi 0.985 / 0.980; Freeze-Omni 0.642 / 0.481; Gemini Live 0.255 / 0.310.
  - Backchanneling (TOR lower is better / frequency per s / timing divergence JSD lower is better): dGSLM 0.691 / 0.015 / 0.934; Moshi 1.000 / 0.001 / 0.957; Freeze-Omni 0.636 / 0.001 / 0.997; Gemini Live 0.091 / 0.012 / 0.896.
  - Smooth turn-taking (TOR higher is better / latency): dGSLM 0.975 / 0.352 s; Moshi 0.941 / 0.265 s; Freeze-Omni 0.336 / 0.953 s; Gemini Live 0.655 / 1.301 s.
  - Conclusions: all models often take the turn during natural pauses, the end-to-end ones most; Freeze-Omni's explicit speak/listen state prediction interrupts far less; backchanneling is weak everywhere (Gemini Live best); end-to-end models lose coherence after interruptions; English only; metrics descriptive, not tied to human preference.
  - A third-party summary gives different backchannel numbers (for example dGSLM TOR 0.782) than the paper; the paper's table above should be preferred. — [Emergent Mind](https://www.emergentmind.com/topics/full-duplex-bench)
- Full-Duplex-Bench v1.5 adds overlap scenarios (listener backchannels, side talk, background speech). v2 is multi-turn with an automated examiner and finds systems respond with low delay but falter at tracking context and interruptions across turns. v3 adds real disfluencies and multi-step tool use. — [arXiv 2510.07838](https://arxiv.org/html/2510.07838v2); [GitHub](https://github.com/DanielLin94144/Full-Duplex-Bench)
- **Kyutai Moshi:** a 7B temporal transformer plus a depth transformer that models the user and Moshi audio streams with an "inner monologue" of its own text tokens. Mimi codec: 24 kHz → 12.5 Hz at 1.1 kbps, 80 ms frames. Latency 160 ms theoretical, about 200 ms on an L4 GPU. Code MIT/Apache, weights CC-BY 4.0. MLX builds (int4/int8/bf16) were tested on a MacBook Pro M3 (`python -m moshi_mlx.local -q 4`); the command-line clients have no echo cancellation. — [GitHub kyutai-labs/moshi](https://github.com/kyutai-labs/moshi)
- **NVIDIA PersonaPlex** (paper submitted 14 Jan 2026; 7B release reported 20 Jan 2026): built on Moshi's architecture and weights (Helium LLM), adding text role prompts and voice cloning from an audio sample, trained on synthetic plus real conversations. The paper extends Full-Duplex-Bench to customer-service roles and claims gains in role adherence, speaker similarity, latency and naturalness. Weights are gated on Hugging Face. — [arXiv 2602.06053](https://arxiv.org/abs/2602.06053); [NVIDIA Research](https://research.nvidia.com/labs/adlr/personaplex); [Hugging Face](https://huggingface.co/nvidia/personaplex-7b-v1); [ComfyUI wiki](https://comfyui-wiki.com/en/news/2026-01-20-nvidia-personaplex-7b-v1-release)
  - Third-party benchmark tables conflict (one shows PersonaPlex 94.1 vs Moshi 78.5 on "conversation dynamics", another Moshi 95.06 vs PersonaPlex 90.8), and one describes it as research-stage with occasional audio instability. — [Nurix](https://www.nurix.ai/resources/nvidia-personaplex-conversational-ai-voice-control); [DEV Community](https://dev.to/behruamm/nvidia-personaplex-the-full-duplex-revolution-42jp)
- **SyncLLM** (Veluri et al., EMNLP 2024; UW/Meta authors): synchronises Llama3-8B with the real-world clock for full duplex. Trained on about 212k hours of synthetic plus about 2k hours of real spoken dialogue; tested at network latencies up to 240 ms. — [arXiv 2409.15594](https://arxiv.org/abs/2409.15594)
- **Freeze-Omni** (Nov 2024): speech in and out attached to a frozen text LLM, trained in three stages; duplex comes from multi-task training. — [arXiv 2411.00774](https://arxiv.org/abs/2411.00774)
- **Sesame CSM-1B** (13 Mar 2025, Apache-2.0): a Llama backbone plus an audio decoder producing Mimi codes. It is a context-conditioned speech generator only, not a multimodal LLM and not full duplex; it needs a CUDA GPU per its README, and a fine-tuned variant powers Sesame's demo. — [GitHub SesameAILabs/csm](https://github.com/SesameAILabs/csm)
- **Kyutai Unmute:** a cascaded (STT → any text LLM → TTS) system that uses the STT's semantic VAD for turn-taking. It's Kyutai's own route to natural turn-taking with a swappable LLM brain. — [GitHub delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling); [Kyutai Unmute](https://kyutai.org/2025/05/22/unmute.html)
- Microsoft "MAI Realtime", a full-duplex voice model in 17 languages, is reported in limited partner preview (secondary sources only). — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/9446/mai-realtime-microsoft-full-duplex-voice); [TestingCatalog](https://www.testingcatalog.com/exclusive-microsoft-tests-new-mai-realtime-voice-model/)
- **Backchannel prediction:** fine-tuning VAP to predict the timing and type of backchannels frame by frame ("Yeah, Un, Oh", NAACL 2025) beat baselines in real time. — [arXiv 2410.15929](https://arxiv.org/abs/2410.15929)
- In smooth human floor transfers, the next speaker starts a median 151 ms before the current turn ends, i.e. in slight overlap (TurnBench, 2026). — [arXiv 2608.25218](https://arxiv.org/abs/2608.25218)
- Krisp's turn model and LiveKit's adaptive interruption treat recognising the user's backchannels as an input-filtering problem rather than one of generating them. — [LiveKit blog](https://livekit.com/blog/adaptive-interruption-handling)

### Inferences
- For ARES, full duplex buys little now and costs a lot: weaker reasoning than Claude, interruptions at pauses (Moshi), and the voice and character would no longer be Katherine/ElevenLabs. The practical wins (fast, non-interrupting turns and graceful barge-in) come from the cascaded techniques in Q3 and Q4.
- Running Moshi or PersonaPlex locally through MLX is an optional experiment only, e.g. for a "chat mode" demo, not the main loop.
- Backchannels:
  - ARES should accept the owner's backchannels without stopping (Q4).
  - ARES's own backchannels should be limited to latency cover (a short "One sec." when a tool call will take more than about 1.5 s, as the v2 plan already says), not "mm-hm" while the owner talks. No benchmark shows systems timing those well, and mistimed ones would read as interruptions.

### Gaps
- PersonaPlex's licence (code and weights) and its own benchmark numbers were not verified (the abstract page had no figures).
- No measured Moshi or PersonaPlex latency or real-time factor on M-series MacBook Pros beyond Kyutai's "tested on M3".
- Sesame's production (demo) architecture and turn-taking method are not public.
- No user study compares cascaded-with-semantic-EOT against full-duplex systems on perceived naturalness.

## Q6. Human conversation timing targets and what users perceive as natural

### Takeaway
Human turn transitions centre on about 200 ms:
- The mode is 100–200 ms; reported English means run 236–480 ms depending on the study; Japanese is about 7 ms and Danish about 470 ms.
- About 40% of transitions involve brief overlap.
- Listeners plan their reply around 1.2 s before the turn ends, because producing even one word takes about 600 ms.
- Gaps of 600–700 ms or more start to signal a dispreferred answer or trouble.

For machines, the only controlled human-robot study found about 1 s preferred, with conversational fillers making longer delays tolerable. The popular "800 ms" voice-AI rules are vendor syntheses. Practical targets: under about 700 ms feels human-like, about 1 s is acceptable, and past about 1.5 s a filler or visual "thinking" cue is needed.

### Cited Findings
- Stivers et al. 2009 (PNAS; 10 languages, responses to yes/no questions): all languages avoid overlap and minimise silence, and each language's mean gap falls within about 250 ms of the cross-language mean. — [MPI record](https://forms.mpi.nl/node/50939); [PNAS DOI](https://doi.org/10.1073/pnas.0903616106)
  - Japanese is fastest (about 7 ms) and Danish slowest (about half a second). — [National Geographic](https://www.nationalgeographic.com/science/article/pregnant-pauses-and-rapid-fire-how-do-different-cultures-take-turns-to-talk)
  - The overall mean is just above 0.2 s. — [Gardner & Mushin, Frontiers 2015](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.00251/full)
- Levinson & Torreira 2015, "Timing in turn-taking and its implications for processing models of language". — [Frontiers in Psychology](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.00731/full)
  - Gap size: average around 200 ms; modal gap 100–200 ms; Heldner & Edlund's mode about 200 ms, with about 60% of transitions being gaps and about 40% overlaps.
  - Overlap: overlapping speech is under 5% of the signal (3.8% in Switchboard); between-speaker overlaps have a mode of 96 ms, median 205 ms and mean 275 ms.
  - Other measurements: older US phone data show mean gaps of 345–456 ms (medians 264–347 ms); English averages in the paper's table are 410, 480, 460 ms and 236 ms (the last from Stivers et al.).
  - Production latency: picture naming about 600 ms to articulation; two nouns 740–800 ms; three words about 900 ms; a simple sentence about 1500 ms. So listeners must predict the turn's end and plan early; EEG shows preparation about 1200 ms before the end of predictable turns.
  - What gaps signal: gaps of 700 ms or more go with dispreferred responses; gaps over 300 ms reduce the chance of an unqualified acceptance; gaps of 600 ms or more create dispreferred-type inferences (Roberts et al. 2011).
- TurnBench (2026): in smooth floor transfers the next speaker starts a median 151 ms before the current turn ends. — [arXiv 2608.25218](https://arxiv.org/abs/2608.25218)
- Shiwa et al. 2009 (Int. J. Social Robotics; HRI 2008 version): people liked a 1 s robot response delay best, and a conversational filler is proposed to cover longer delays. — [DOI 10.1007/s12369-009-0012-8](https://doi.org/10.1007/s12369-009-0012-8)
  - Press coverage of the same group gives about 2 s as the tolerance ceiling for spoken commands. — [TechRadar](https://www.techradar.com/news/world-of-tech/future-tech/mumbling-robots-more-pleasing-than-the-silent-type-321540)
- Vendor rules of thumb (unsourced syntheses, conflicting):
  - Twig: 500–800 ms "thoughtful", 800–1500 ms awkward, over 1500 ms broken; it recommends median first audio under 800 ms and p95 under 1500 ms. — [Twig](https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms)
  - Deepgram cites a 2023 study (Hoogland et al.) for about 199 ms (Dutch) and 242 ms (English) gaps. — [Deepgram](https://deepgram.com/learn/voice-ai-latency-why-pauses-read-as-hesitation)
- ARES v2 speed targets: first audio under 1 s after the owner stops for simple questions, under 1.5 s for ones needing the brain. — [docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md)

### Inferences
- ARES's v2 targets match the robot-preference evidence (about 1 s) but sit above the 600–700 ms point where a pause starts to "mean something". So under 1 s should be the ceiling, not the goal, for short exchanges.
- The endpoint decision (Q3) is the biggest single lever. With Smart Turn at the 10% cut-off point (about 0.74 s), ARES would still need under about 300 ms for brain, first sentence and TTS first byte to come in under 1 s. That implies preemptive generation, a warm session, streaming the first sentence, the phrase cache, and local intents for simple asks.
- Humans start replies in slight overlap (median −151 ms) because they predict. A cascaded assistant can only approach this by predicting the end of turn and starting work early (eager EOT with preemptive generation); it should not speak in overlap.

### Gaps
- No controlled study was found on perceived naturalness or latency tolerance for LLM voice assistants specifically; the evidence is robot HRI from 2008–2009 plus vendor blogs.
- Stivers et al.'s exact per-language means were not read from the PNAS full text (secondary sources only).

## Q7 (objective). Concrete recommendations for ARES

### Takeaway
Build on-device, staged and conservative:
- Addressee: rules → a calibrated feature model (prosody, ASR confidence, dialogue context, face presence and orientation, call/media state) → an on-device LLM tie-breaker, at a high-precision point, with a follow-up prior that decays over the 20 s window.
- End of turn: Silero-class VAD (0.2 s) → Smart Turn v3.2 on CoreML, plus transcript cues, per-owner adaptation and preemptive Claude generation.
- Barge-in: AEC → duck on onset → confirm with stop words, duration or non-backchannel words → resume after about 2 s if false → truncate the brain's history to the words actually played.
- Leave full-duplex models and agent backchannels out of the main loop.

### Cited Findings
- Hard rules for voice v2: listening, wake, trust and turn-taking audio never leaves the Mac; overheard speech is never logged as text, sent to the brain or shown; Claude subscription only. — [docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md)
- Current stack and plan:
  - Current stack: AresListener.swift (SFSpeech en-GB, wake regex over transcripts, silence timers, VPIO), addressed.js regex rules, voiceid.js (TitaNet small via sherpa-onnx), ElevenLabs eleven_v3 voice with Kokoro fallback.
  - Stage A5: compare the fixed timeout with Smart Turn or the LiveKit detector run locally.
  - Stage B5: a semantic EOT model, barge-in within about 200 ms, follow-ups for about 20 s.
  - Stage B7: rules + trust signals + a small local classifier + context; stay quiet when unsure.
  — [docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md)
- ARES Vision emits only joints, a face box and key-idle seconds; face and gaze are planned additions. Desk mode never logs, sends or captions overheard speech. — [CLAUDE.md](file:///Users/dhruv/My%20AI/CLAUDE.md)
- Supporting evidence (see Q1–Q6):
  - Fusion beats single cues: [arXiv 1808.02504](https://arxiv.org/abs/1808.02504), [arXiv 2403.14438](https://arxiv.org/abs/2403.14438).
  - History and vision matter most: [arXiv 2604.08412](https://arxiv.org/abs/2604.08412).
  - Context plus ASR uncertainty for follow-ups: [arXiv 2411.00023](https://arxiv.org/abs/2411.00023).
  - Smart Turn ≈ LiveKit v1-mini among local EOT models: [eot-bench](https://github.com/livekit/eot-bench).
  - Barge-in classifier figures and the rule defaults: [LiveKit blog](https://livekit.com/blog/adaptive-interruption-handling), [LiveKit docs](https://docs.livekit.io/reference/agents/turn-handling-options/).

### Inferences
**1. Addressee check (B7), all on-device**
- Keep addressed.js rules as high-precision triggers (name, "Hey ARES", stop words) and as vetoes: on a call or in a meeting, wake word only.
- Add a calibrated scorer over cheap features:
  - rule hits;
  - question/imperative/second-person form;
  - SFSpeech confidence;
  - level, pitch and rate relative to the owner's directed baseline;
  - near-field trust score;
  - seconds since ARES spoke and whether she asked a question;
  - word overlap with her last answer;
  - face present and facing the screen (when Vision is on; use temporal smoothing and Look and Talk's relax-once-speaking hysteresis);
  - other voices or media playing.
- Only in the ambiguous band, ask Apple's on-device Foundation Model (guided generation → `{directed: Bool, confidence}`) with the last exchange plus the utterance and its ASR alternatives. Never ask Claude about undecided speech.
- Tune on consented voice-lab recordings plus implicit feedback. Report false accepts per hour (TV, YouTube, calls, self-talk) and false rejects at a chosen operating point.

**2. Follow-up window**
- Replace the flat 20 s with a decaying prior: normal threshold for 0–6 s after her reply; then progressively more evidence until 20 s.
- Extend when she asked a question; close on other voices, calls or media.
- Keep the visible listening cue.

**3. End of turn (A5 → B5)**
- Evaluate with eot-bench's protocol on the owner's recordings (hold vs end-of-turn at every silence of 100 ms or more; false cut-offs at 300 / 600 ms; latency at 5% / 10%).
- Likely winner: Silero-class VAD (stop 0.2 s) → Smart Turn v3.2 CoreML (BSD-2), plus transcript cues (dangling conjunction or filler → wait; complete question → go), with a cap of about 2.5 s, extended mid-clause.
- Add dynamic per-owner pause adaptation; fine-tune Smart Turn on owner data later if needed.
- Start Claude at an "eager" score and cancel on resume. This preempts the LLM only, never ElevenLabs TTS, to protect credits; watch subscription usage, since speculative calls ran 50–70% more LLM calls at Deepgram.
- Alternatives worth one A/B: Parakeet-EOU via FluidInference CoreML (English; guard against keyboard clicks with VAD) and Kyutai STT-1B semantic VAD via MLX (would also replace SFSpeech).

**4. Barge-in**
- AEC (VPIO) stays.
- On owner speech onset: duck within about 100 ms.
- Hard stop on stop words, on ≥ 0.3–0.5 s of owner speech whose words aren't a backchannel, or on any speech near her turn edges (±1 s).
- Otherwise resume after about 1.5–2.0 s of nothing.
- On a real stop, record the last played word from the comms.js schedule and pass "[interrupted after: …]" to Claude (contextual barge-in).

**5. Leave out for now:** full-duplex models (Moshi/PersonaPlex) and agent "mm-hm" backchannels. Use only latency-cover acknowledgements when a tool call will take more than about 1.5 s.

**6. Measure against human timing:** report the endpoint decision delay and time to first audio (median and p90) against 200 ms (human), 700 ms (where pauses start to signal trouble), 1 s (preferred for robots) and 1.5 s (needs a filler).

### Gaps
- Whether LiveKit v1-mini's licence allows standalone local use, and how Smart Turn handles the owner's en-GB / Indian English, are unverified; both need the A5 test.
- The latency of Apple's on-device Foundation Model as a per-utterance judge, and whether macOS Vision can supply head pose cheaply inside ARES Vision, need measuring.
- No published numbers show how often a desk owner's self-talk or speech to others matches "directed" patterns; the false-accept rate per hour for ARES must come from the owner's own recordings.
