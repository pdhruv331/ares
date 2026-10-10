# Rebuild ARES's ears, trust and timing

ARES's naturalness problems come from one pattern. Its hardest decisions (was that my name, is this the owner, is he talking to me, has he finished) rest on a legacy transcript or a fixed threshold, and the October 2026 toolchain offers a dedicated, on-device, tunable component for each. The highest-value changes are these. Replace the regex over `SFSpeechRecognizer` output with a custom "Hey ARES" acoustic wake model in a Siri-style cascade; that recogniser's 9.0% word error rate on clean read speech is about four times that of Apple's newer SpeechTranscriber. Replace the 1.3 s silence timer with a 0.2 s VAD stop feeding the open Smart Turn v3.2 model. Demote the voiceprint, which accepts only 26.8% of checks today, from a hard gate to one calibrated vote in a fused trust score. And speed up the output path, with Claude Haiku 5.5 for quick turns and ElevenLabs' new `eleven_v4_turbo` streamed over a WebSocket instead of one `eleven_v3` request per sentence. Adding up published component figures, those changes plus preemptive generation would cut a typical brain turn from an estimated 3–4.5 s to roughly 0.9–1.7 s. Noise is the counter-intuitive area. Neural denoisers placed in front of a recogniser often raise word error rates, so the fix is echo cancellation with an explicit playback reference plus owner-gating, not a stronger suppressor. Emotion recognition on natural speech is still coarse (the best 2025 challenge entry scored 0.43 macro-F1 across eight classes). Tone should therefore reach Claude as a short, hedged note that adjusts style, and Katherine's delivery should come from v4 audio tags. Intent works best as a tiered router in which a deterministic fast path and Claude call one shared action registry. Almost every figure here is vendor-reported or was measured on someone else's hardware, so ARES's own per-stage latency log, labelled voice trials and owner recordings must come first and pick the winners.

## A regex over a 9%-WER transcript cannot be a wake word

ARES wakes when a regular expression (`ares|aries|arras|arris|aris|arez|eris`) matches the live en-GB `SFSpeechRecognizer` transcript, nudged by two contextual strings ([AresListener.swift](file:///Users/dhruv/My%20AI/native/AresListener.swift)). That asks a recogniser built to output the most probable word sequence to commit to a rare name, one its language model would rather hear as "Harris" or "a res". OpenAI's own guidance says even Whisper garbles unusual names ([OpenAI](https://developers.openai.com/cookbook/examples/whisper_prompting_guide)).

The design has three further problems:
- There is no threshold to tune.
- Every widening of the regex buys recall by also accepting more TV and conversation.
- The engine underneath is Apple's weakest. On an M2 Pro running macOS 26.5.1, **legacy `SFSpeechRecognizer` scored 9.02% WER on LibriSpeech test-clean against 2.12% for the new SpeechAnalyzer**, and 16.25% against 4.56% on test-other ([Lyonesse](https://lyonesse.app/blog/apple-speech-api-benchmark.html)).

Shouting works because a louder signal relative to the background is the only lever this design leaves.

No production assistant works this way. Apple's 2023 voice trigger runs in four steps ([Apple ML Research](https://machinelearning.apple.com/research/voice-trigger)):
1. A tiny high-recall detector on the always-on processor.
2. A larger Conformer that re-scores the candidates.
3. A speaker check on the trigger, and again on the whole request.
4. A text classifier that discards non-vocative mentions of "Siri".

Its 2017 design added a second, lower threshold. A near-miss opens a few-second, more sensitive state, so a normal-volume repeat triggers ([Apple ML Research](https://machinelearning.apple.com/research/hey-siri)). Amazon re-verifies every on-device "Alexa" in the cloud ([Amazon AVS](https://developer.amazon.com/docs/alexa-voice-service/enable-cloud-based-wake-word-verification.html)). In its research, a second on-device stage alone cut false alarms by about two-thirds ([Amazon Science](https://www.amazon.science/publications/monophone-based-background-modeling-for-two-stage-on-device-wake-word-detection)).

### livekit-wakeword plus the owner's own takes gives a tunable detector

The free engine landscape shifted in 2026. **Picovoice's free-tier Porcupine keys stopped working on 30 June 2026.** The SDK will not start without a valid key, even offline, and per an email quoted by a user, the company says no non-commercial tier is planned ([Home Assistant forum](https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744)). Snowboy, Mycroft Precise and Howl are abandoned.

What remains is the openWakeWord family ([openWakeWord](https://github.com/dscripka/openWakeWord)):
- **Design:** a fixed mel front end, Google's frozen speech-embedding backbone and a small classifier head.
- **Cost:** cheap enough that one Raspberry Pi 3 core runs 15–20 models at once.
- **Targets:** under 5% false rejects and under 0.5 false accepts per hour.
- **Licence:** the pretrained weights are non-commercial (CC BY-NC-SA).

The 2026 **livekit-wakeword** (Apache-2.0) keeps that front end and adds a convolution-plus-attention head. It ships a **Swift package for macOS 14+ that runs ONNX Runtime with the Core ML execution provider**, which fits ARES's Swift listener directly. On its own 25-hour test set it reports **0.08 false positives per hour at 86.1% recall, against 8.50 per hour at 68.6% recall for openWakeWord** ([livekit-wakeword](https://github.com/livekit/livekit-wakeword)). That is a vendor best case on the vendor's own phrase.

sherpa-onnx's open-vocabulary keyword spotter needs no training, because its decoder can only emit the listed keywords. That makes it a natural second-stage verifier, though it publishes no accuracy figures ([sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)).

Training a rare name now takes one to two hours on a laptop. A worked "hey-claude" model, about 200 KB, took roughly an hour end to end on a MacBook Air M2, using Whisper to discard synthetic positives that weren't clearly intelligible ([hey-claude](https://huggingface.co/gdiamos/hey-claude)). livekit-wakeword's pipeline ([livekit-wakeword](https://github.com/livekit/livekit-wakeword)):
1. Generates positives with Piper (English) or VoxCPM2 (30 languages).
2. Adds adversarial negatives.
3. Augments with noise, reverb and pitch shifts.
4. Evaluates on a DET curve.

For ARES:
- **Positives:** thousands of clips of "hey ARES" and bare "ARES" from many voices, with phonetic respellings fed only to the TTS step, plus the owner's real takes, because stock TTS voices are native-accented.
- **Adversarial negatives:** the words ARES's transcripts already confuse with its name ("Aries", "Harris", "Paris", "heiress", "erase", "ears"), plus Katherine and Kokoro saying sentences that contain "Ares".

The SEED method shows how far a few real takes go. It vocoded **5–9 recordings of the user's own voice** into about 180 timbres and augmented them to 50,000 samples. Its author reports **98.5% detection at 0.187 false positives per hour**, though that is one user on a beta tool ([Home Assistant forum](https://community.home-assistant.io/t/seed-train-a-custom-wake-word-from-just-a-handful-of-recordings-not-hundreds/1018736)). Validation needs at least 10 hours of real room audio ([Picovoice](https://picovoice.ai/blog/wake-word-benchmarks/)). The target is at most 0.1–0.2 false accepts per hour at a 2–5% false-reject rate, with the threshold read off the DET curve.

The architecture to build is a four-stage cascade on Siri's pattern:
1. livekit-wakeword on 80 ms frames, tuned for high recall and with Apple's near-miss window.
2. sherpa-onnx, restricted to "HEY ARES", on the roughly 1.5 s candidate window.
3. The speaker check on the wake phrase.
4. A cheap text check that drops non-vocative mentions ("I was reading about Ares…").

Self-triggering needs its own guard: during barge-in the user's voice can sit more than 10 dB below the loudspeaker echo ([VOCAL](https://vocal.com/echo-cancellation/aec-barge-in/)). ARES can raise the stage-1 threshold while Katherine speaks. It can also discard any detection that lines up with her own scheduled "Ares", using the per-word timing comms.js already produces for captions. A 2021 patent describes the heavier version of this, a second recogniser running on the outgoing audio ([US 11,004,453](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11004453)). "Hey ARES" should stay the primary trigger. Accept bare "ARES" only at a stricter threshold or inside an open conversation, since Apple reports the one-word trigger is harder.

### Moving off SFSpeechRecognizer is the largest recognition win

| On-device engine | LibriSpeech test-clean WER | Speed on a Mac | Vocabulary control | Source |
|---|---|---|---|---|
| `SFSpeechRecognizer` (ARES today) | 9.02% | system model, M2 Pro | contextual strings; custom language model with X-SAMPA pronunciations | [Lyonesse](https://lyonesse.app/blog/apple-speech-api-benchmark.html), [WWDC23](https://developer.apple.com/videos/play/wwdc2023/10101/) |
| Apple SpeechTranscriber (macOS 26) | 2.12% | ~3× Whisper Small; runs outside the app's memory | none (contextual strings ignored) | [Lyonesse](https://lyonesse.app/blog/apple-speech-api-benchmark.html), [Apple forums](https://developer.apple.com/forums/thread/811083) |
| Whisper Small (WhisperKit) | 3.74% | — | prompts (unreliable) | [Lyonesse](https://lyonesse.app/blog/apple-speech-api-benchmark.html) |
| Parakeet TDT 0.6B v2 via FluidAudio (Core ML) | 2.1% | 145.8× real time, M4 Pro | CTC keyword boosting with aliases, batch only | [FluidAudio](https://docs.fluidinference.com/reference/benchmarks) |
| Parakeet TDT 0.6B v3 (25 languages) | 2.5% | 155.6× real time, M4 Pro | same | [FluidAudio](https://docs.fluidinference.com/reference/benchmarks) |

On harder earnings-call audio, Argmax measured these WERs ([Argmax](https://www.argmaxinc.com/blog/apple-and-argmax)):
- SpeechTranscriber: 14.0%
- WhisperKit small.en: 12.8%
- Parakeet v2: 11.7%

Argmax called Apple's model on par with mid-tier Whisper. It also listed the gaps: no custom vocabulary, about ten languages, and a required model download.

The stack ARES should test has two engines:
- **Live captions and partial results:** SpeechTranscriber with volatile results. It runs out of process with no added app memory ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/277/)).
- **The final text of each finished command:** a batch re-transcription with Parakeet TDT v2 through FluidAudio. Its custom-vocabulary aliases can map "Aries" or "Harris" to ARES and boost contact and app names. The vendor reports 99.3% vocabulary precision at 85.2% recall ([FluidAudio](https://docs.fluidinference.com/asr/custom-vocabulary)). At the M4 Pro rate, a 5 s command costs about 35 ms of compute.

Until then, there is a quick win in the current code: give the existing recogniser an on-device custom language model. It would hold phrase-weighted "Hey Ares …" templates and an **X-SAMPA pronunciation of "Ares" as the owner actually says it**. Apple ignores customisation unless recognition runs on device, which ARES already requires ([WWDC23](https://developer.apple.com/videos/play/wwdc2023/10101/)). Apple publishes no figures for how much this helps a single name.

Accent is the largest unknown. No benchmark compares these engines on non-US/UK English, and SpeechTranscriber's regional English locales must be checked at runtime. ARES should:
1. Record 50–100 real commands at the desk and across the room.
2. Compare every engine and available locale on that set.
3. Only if accuracy stays poor, LoRA-fine-tune on 30–60 minutes of the owner's speech. Mixed accent-specific LoRA beat full fine-tuning on non-native English with less forgetting ([arXiv 2505.20006](https://arxiv.org/abs/2505.20006v1)).

Cloud STT is better than on-device but not by much for short commands. ElevenLabs Scribe v2 posts the best long-form leaderboard score (7.32% WER) ([Open ASR Leaderboard](https://arxiv.org/html/2510.06961v4)), and its Realtime version costs $0.39 per hour ([ElevenLabs](https://elevenlabs.io/pricing/api)). Thirty hours a month of speech after the wake word would cost roughly $4.50 to $30 across vendors. Cloud leaders beat Parakeet by only about 0.5–1 WER point on short English clips. Cloud fits only as an opt-in, post-wake fallback for long dictation. An always-on cloud mic would send overheard speech off the Mac, against ARES's rules.

## Echo references beat denoisers, which often raise word errors

The instinctive fix for a noisy room, a strong neural denoiser in front of the recogniser, is usually the wrong one:
- **Meta's SAM-Audio** separation (March 2026 study) raised Whisper-base English WER **from 10.53% to 21.66%** despite cleaner-sounding output, and worsened every model–dataset pair tested ([arXiv 2603.04710](https://arxiv.org/abs/2603.04710)).
- **MetricGAN+** denoising worsened all 40 model-and-condition combinations in a December 2025 report ([arXiv 2512.17562](https://arxiv.org/pdf/2512.17562)).
- **The ICASSP 2023 noise-suppression challenge** shows the same split. Winning personalised systems more than doubled perceived quality on headset audio, while word accuracy fell from 0.843 unprocessed to 0.758 ([arXiv 2303.11510](https://arxiv.org/pdf/2303.11510)).
- **Google** built VoiceFilter-Lite with a loss that penalises over-suppression more than leftover noise, precisely so it would not hurt recognition ([Google Research](https://research.google/blog/improving-on-device-speech-recognition-with-voicefilter-lite/)).

ARES should judge any suppressor by the owner's WER and wake-word accuracy, not by how it sounds.

Suppressors still earn a place:
- on the detection paths (VAD, wake word, barge-in);
- before the voiceprint;
- for recognition only behind an attenuation limit or a wet/dry blend.

The best free options run comfortably on Apple Silicon:
- **DeepFilterNet3** (MIT/Apache-2.0, 48 kHz): a Core ML streaming port measured **0.264 ms of compute per 10 ms hop**, with 30 ms latency ([Hugging Face](https://huggingface.co/iky1e/DeepFilterNet3-Streaming-CoreML)).
- **DPDFNet** (Ceva, Apache-2.0, December 2025): 8, 16 and 48 kHz causal models. They run through sherpa-onnx's C API, which exposes an attenuation limit ([Hugging Face](https://huggingface.co/Ceva-IP/DPDFNet), [sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/speech-enhancement/index.html)).
- **GTCRN** (MIT): competitive quality with 48K parameters ([GitHub](https://github.com/Xiaobin-Rong/gtcrn)).

The commercial options fit worse:
- **Picovoice Koala** validates its key online ([GitHub](https://github.com/Picovoice/koala)).
- **NVIDIA Maxine** has no macOS build ([NVIDIA](https://developer.nvidia.com/audio-effects-sdk)).
- **Krisp** is the strongest at removing other *voices* (Background Voice Cancellation), but sells SDK access by application only ([Krisp](https://krisp.launchnotes.io/announcements/ann_FOdwanTsBSQRv), [usagepricing](https://usagepricing.com/blueprint/krisp)).

Echo matters more than noise, and ARES's handling of it rests on an undocumented assumption. ARES enables Apple's voice processing (VPIO) on its input node, with ducking at the minimum and advanced ducking off. VPIO supplies echo cancellation, noise suppression and AGC tuned per Mac ([WWDC23](https://developer.apple.com/videos/play/wwdc2023/10235/)).

Apple says other apps' audio is mixed in and ducked. It never says that audio played by another process joins the echo reference: Katherine from the Electron renderer, or YouTube in a browser. One developer found VPIO cancels echo only when it also owns the playback path ([voice-cat](https://code.iamtalon.me/Talon/voice-cat/commit/6c17881cc03ae83a0d23a543c3ff73407a7a7e79)), and no macOS measurement of cross-process cancellation turned up. That gap fits ARES hearing YouTube, and sometimes itself.

Playing TTS through the VPIO engine is the textbook fix. But ARES has already found that starting or stopping the voice-processing engine reconfigures the output device and makes playback stutter ([CLAUDE.md](file:///Users/dhruv/My%20AI/CLAUDE.md)).

The robust design hands the canceller its reference explicitly:
- **Reference source:** a **Core Audio process tap** (macOS 14.2+) gives an exact copy of one app's output or of the whole system mix ([Apple](https://developer.apple.com/documentation/coreaudio/audiohardwarecreateprocesstap(_:_:))).
- **Canceller:** that copy feeds the far-end input of **WebRTC AEC3**, available as the BSD-3 `webrtc-audio-processing` 2.x library with a Rust wrapper ([tonarino](https://github.com/tonarino/webrtc-audio-processing)).
- **Precedent:** the commercial RecordKit SDK ships this design on macOS, with an aggressive 16 kHz preset and a residual-echo gate for speech-to-text ([RecordKit](https://nonstrict.eu/recordkit/guides/echo-cancellation.html)).

The costs are real:
- It needs the System Audio Recording permission, with no public API to check it.
- It loses VPIO's tuned suppression and the user's Mic Mode menu.
- An unresolved macOS 26.5 beta report says taps can deliver silent buffers for minutes ([Apple forums](https://developer.apple.com/forums/thread/825780)).

A cheaper variant pipes the exact PCM the renderer plays to the Swift helper as the reference, though that cancels only Katherine. The right order is to measure first. With VPIO on, measure echo-return-loss enhancement for three sources: renderer TTS, browser audio and engine-owned playback. Move to AEC3 with a global tap only if VPIO fails the first two. The same tap then does two more jobs. It flags when the Mac is playing speech, and it lets ARES drop any mic transcript or wake that matches what the Mac played a second or two earlier.

For voice activity:
- **Silero VAD v6.2** (MIT) is the default. On Silero's own benchmark it reached 0.97 ROC-AUC and correctly rejected **87% of ESC-50 noise clips, against 42% for TEN VAD and none for WebRTC VAD** ([Silero wiki](https://github.com/snakers4/silero-vad/wiki/Quality-Metrics)).
- **TEN VAD** runs at 1.6% of real time on an M1. It claims Silero lags several hundred milliseconds at speech-to-silence transitions, which matters for endpointing ([TEN VAD](https://github.com/TEN-framework/ten-vad)). Each benchmark favours its author, so test both on ARES audio.
- **Apple's Core Audio voice-activity flag**, computed on echo-cancelled input since macOS 14 ([Apple](https://developer.apple.com/documentation/coreaudio/kaudiodevicepropertyvoiceactivitydetectionenable)), is useful for cheap standby gating.
- **macOS 26's `SpeechDetector`** only gates SpeechAnalyzer and emits no speech start or end events ([Apple](https://developer.apple.com/documentation/speech/speechdetector)).

Isolating the owner's voice is mature in research but has no drop-in implementation. VoiceFilter-Lite cut WER by 25.1% on overlapped speech in a 2.2 MB model ([Google Research](https://research.google/blog/improving-on-device-speech-recognition-with-voicefilter-lite/)). Personalised DeepFilterNet2 and the 2025 edge model TargetVoice apply the same idea to the waveform ([arXiv 2404.08022](https://arxiv.org/abs/2404.08022), [Interspeech 2025](https://www.isca-archive.org/interspeech_2025/pallala25_interspeech.html)). But no open, pretrained, real-time personalised enhancer packaged for Core ML or ONNX turned up. Google's speaker-conditioned Personal VAD exists only in papers ([arXiv 1908.04284](https://arxiv.org/pdf/1908.04284)).

The practical 2026 route is **owner-gating**:
1. VAD segments go to the speaker embedding.
2. Only matching segments proceed.
3. The check repeats as the utterance grows.

That handles a TV or other people talking. It doesn't handle the owner talking over the TV; only target-speaker extraction or Krisp-style voice cancellation fixes overlap.

Distance is partly a hardware limit. The MacBook Pro's three-mic array is beamformed in software for someone at the keyboard ([Apple](https://www.apple.com/macbook-pro/specs/), [MacGeneration](https://www.macg.co/logiciels/2025/03/asahi-linux-prend-en-charge-le-microphone-des-mac-portable-et-ca-ete-complique-300545)), and apps get one processed stream. Apps also cannot switch on Voice Isolation. `preferredMicrophoneMode` is read-only, so ARES can only observe the mode and open the system picker ([Apple](https://developer.apple.com/documentation/avfoundation/avcapturedevice/preferredmicrophonemode)). Voice Isolation is designed for the person in front of the screen, so test it on across-the-room speech before recommending it.

The software fix is gain staging. Add a WebRTC AGC2 stage after echo cancellation and before VAD and ASR, aiming speech at roughly −26 to −20 dBFS. Then revisit ARES's fixed 0.015 RMS speech threshold. For true across-the-room use, the hardware fix is an XMOS XVF3800-class array with on-board echo cancellation, beamforming and direction finding ([XMOS](https://www.xmos.com/xvf3800/)). Its echo cancellation works only if Katherine plays through it.

Telling a live person from a TV across the room is largely unsolved on a single beamformed stream. The best single-channel distance estimator errs by about 0.5 m on real recordings ([arXiv 2403.17514](https://arxiv.org/html/2403.17514v1)). Amazon's answers rely on scale ARES lacks ([EE Journal](https://www.eejournal.com/article/teaching-alexa-to-ignore-your-tv-2/)):
- matching fingerprints of broadcast clips that arrive from many homes at once, which keeps 80–90% of devices quiet;
- a seven-mic ring that spots triggers coming from a fixed, constantly noisy direction.

For ARES, the strongest practical signal is owner verification, helped by level and reverberation cues.

## Voice ID accepts 27% of checks and should vote, not veto

ARES's own log makes the problem concrete. Across 220 checks between 2 and 8 October 2026, the voiceprint **accepted 26.8%**. Live scores clustered around 0.29–0.43, against a 0.48 cosine threshold ([voiceid-log.jsonl](file:///Users/dhruv/Library/Application%20Support/ARES/voiceid-log.jsonl)).

| Voiced clip length | Checks | Median score | Accept rate |
|---|---|---|---|
| 0–1 s | 21 | 0.358 | 19% |
| 1–2 s | 63 | 0.399 | 32% |
| 2–3 s | 37 | 0.331 | 32% |
| 3–5 s | 56 | 0.303 | 27% |
| ≥5 s | 43 | 0.147 | 19% |

There are three causes:
- **The threshold comes from the wrong data.** It reflects how alike six careful enrollment clips are to each other (leave-one-out consistency 0.768, capped at 0.48) ([voiceid.js](file:///Users/dhruv/My%20AI/voiceid.js), [voiceprint.json](file:///Users/dhruv/Library/Application%20Support/ARES/voiceprint.json)), not where the owner's live scores actually land. So it sits above where he usually scores.
- **Learning is biased.** New samples are accepted only when they already score near the threshold, so the profile never learns the conditions where he scores low.
- **The model is the weakest available.** NeMo TitaNet-small has 1.15% EER on VoxCeleb1 ([TitaNet](https://ar5iv.labs.arxiv.org/html/2110.04410)).

The ≥5 s bucket scores lowest. A likely reason is that long captures are dominated by TV, podcasts or residual echo rather than the owner. But the log is unlabelled, so his true false-reject rate is unknown.

The literature shows each of ARES's conditions eroding accuracy:
- **Short clips:** ERes2NetV2's EER grows from 0.61% on full-length trials to 0.98% at 3 s and 1.48% at 2 s ([arXiv 2406.02167](https://arxiv.org/html/2406.02167v1)).
- **Distance:** enrolling close and testing far-field put the FFSVC 2020 baselines at 6.27–7.18% EER ([arXiv 2005.08046](https://arxiv.org/pdf/2005.08046)).
- **Front-end processing:** enhancing only the test audio lowered mean EER from 9.90 to 8.68, but enhancing the training data as well raised it to 11.49 ([arXiv 2002.00139](https://arxiv.org/abs/2002.00139v1)).

ARES enrolled in a quiet room, then verifies while VPIO, AGC and music are active, at varying distance.

The literature's fixes map one-to-one onto ARES:
1. **Score the whole utterance**, wake phrase plus command, as Siri does twice ([Apple ML Research](https://machinelearning.apple.com/research/voice-trigger)). Treat under about 1 s of voiced speech as no evidence rather than a rejection.
2. **Re-enroll 15–30 natural utterances** over three or more sessions, through the live audio path: at the keyboard, leaning back a metre, with music low, and while ARES is talking.
3. **Keep every enrollment vector and score against the set.** Apple's Personalized Hey Siri averages the cosine against up to 40 profile vectors and adds accepted utterances over time ([Apple ML Research](https://machinelearning.apple.com/research/personalized-hey-siri)). Google reports multi-enrollment EER below half that of single enrollment (search summary) ([arXiv 2203.05642](https://arxiv.org/pdf/2203.05642)).
4. **Normalise and calibrate.** AS-norm against a fixed impostor cohort cut WeSpeaker ResNet293-LM's VoxCeleb1-O EER from 0.532% to 0.447%, and quality-aware calibration took it to 0.425% ([WeSpeaker](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md), [IDLab](https://arxiv.org/abs/2010.11255)). Then fit a small logistic calibration on the normalised score, log duration and input level, using the owner's labelled trials. Each check becomes a log-likelihood ratio, so a 1 s clip reads "unsure" instead of "not him".
5. **Accumulate evidence.** A decaying session sum of per-turn likelihood ratios lets one confident turn carry the next weak one.

Skip PLDA, the classic back end: it scored worse than plain cosine on modern embeddings (1.207% vs 0.797%) ([WeSpeaker](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)).

| sherpa-onnx model (ARES's existing runtime) | VoxCeleb1-O EER | File size |
|---|---|---|
| `nemo_en_titanet_small` (current) | 1.15% | 40.3 MB |
| `wespeaker_en_voxceleb_CAM++_LM` | 0.707% | 29.3 MB |
| `nemo_en_titanet_large` | 0.66–0.68% | 101.4 MB |
| `wespeaker_en_voxceleb_resnet221_LM` | 0.580% | 95.0 MB |
| `wespeaker_en_voxceleb_resnet293_LM` | 0.532% (0.425% with AS-norm and calibration) | 114.3 MB |

Sources: [TitaNet](https://ar5iv.labs.arxiv.org/html/2110.04410), [WeSpeaker](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md), [sherpa-onnx release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models).

These models ship in the release ARES already loads. Upgrading means changing the model path and re-enrolling, since embedding sizes differ. Benchmarks predict a 40–55% cut in EER, but VoxCeleb trials are long. WeSpeaker says its large-margin variants help mainly above about 3 s ([WeSpeaker](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)), and ARES's commands are often 1–2 s, so choose by measurement on ARES's own labelled clips. The 2024–2026 frontier needs conversion and suits only a second-stage check on risky requests. It includes ReDimNet2, ECAPA2 and w2v-BERT 2.0, which reaches 0.12% EER on about 600M parameters ([arXiv 2510.04213](https://arxiv.org/html/2510.04213v1)).

Every major assistant treats voice ID as personalisation, not security:
- Apple's Personalized Hey Siri reported 5.2% false rejects and 3.2% impostor accepts ([Apple ML Research](https://machinelearning.apple.com/research/personalized-hey-siri)).
- HomePod's secure requests need a tap on the iPhone ([Apple Support](https://support.apple.com/HT204753)).
- NIST's SP 800-63-4 is blunt: "Biometric comparison based on voice SHALL NOT be used." ([NIST](https://pages.nist.gov/800-63-4/sp800-63b.html))

Shipping products fuse several signals instead. Google's Look and Talk combines Face Match, Voice Match, proximity from face size, gaze and lip movement, over 100 signals in all, processed on device ([Google Research](https://research.google/blog/look-and-talk-natural-conversations-with-google-assistant/)). Apple Watch unlocks a Mac only after a Wi-Fi time-of-flight check confirms it is within about 3 m ([Apple Support](https://support.apple.com/en-ca/guide/macbook-pro/unlock-with-apple-watch-apda4d638ecf/2019/mac/10.14.5)).

For ARES, the best evidence that the owner is at the Mac and speaking is cheap and deterministic. In rough order of strength:
1. Keyboard or mouse input in the last few seconds, with the screen unlocked.
2. An optional face from ARES Vision.
3. Near-field level and low reverberation.
4. Proof that the sound didn't come from the Mac's own playback.
5. The paired phone nearby.
6. A session trust window.
7. The calibrated voice likelihood ratio, as one soft factor.

Voice v2's step B3 already plans this kind of trust score ([voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md)), gated by tier:

| Tier | What passes |
|---|---|
| Low-risk asks | presence or voice |
| Tier 2 | a combined trust score |
| Tier 3 | the existing explicit on-screen or phone yes |

Three tempting additions don't earn their keep:
- **Deepfake and replay detectors** generalise poorly. The best ASVspoof 2021 replay system had 24.25% EER under real-room conditions ([arXiv 2210.02437](https://arxiv.org/pdf/2210.02437)). The best ASVspoof 5 closed-condition entry managed 8.61%, with badly calibrated thresholds ([arXiv 2408.08739](https://arxiv.org/pdf/2408.08739)).
- **Full diarization** adds latency and keeps no lasting identities. Streaming Sortformer is built for four speakers and trades accuracy against chunk delays of 8 s or more ([NVIDIA NeMo](https://docs.nvidia.com/nemo/curator/curate-audio/process-data/quality-filtering/speaker-separation)).
- **Voice-only adaptation** should stop. Learn only from utterances other signals confirm (push-to-talk, at the keyboard, near-field), keep the original enrollment as the anchor, and cap and age the recent set.

One addition does help. Enroll Katherine and Kokoro as explicit impostor voiceprints and require the owner to beat them by a margin. That suppresses self-triggers that leak past echo cancellation.

## Addressing and turn-taking run on fused evidence, not timers

### Fusing weak cues roughly halves addressee errors

Every published system that decides whether speech is meant for the assistant fuses several weak cues:
- **Amazon (2018):** its detector reached **5.2% EER by combining acoustics, recogniser decoder confidence and text, against 9.3% for the best single cue and 20.1% for text alone** ([arXiv 1808.02504](https://arxiv.org/abs/1808.02504)).
- **Apple:** a multimodal LLM approach cut EER by up to 39% relative to text-only and 61% relative to audio-only ([arXiv 2403.14438](https://arxiv.org/abs/2403.14438)). For follow-ups, modelling the previous query plus recogniser uncertainty gave 20–40% fewer false alarms at a fixed 10% false-reject rate ([arXiv 2411.00023](https://arxiv.org/abs/2411.00023)).
- **Context matters most.** In an April 2026 on-device system, audio-only F1 was 0.86 and audio plus video 0.95; removing interaction history dropped the latter to about 0.57 ([arXiv 2604.08412](https://arxiv.org/abs/2604.08412)).

Large language models alone are poor judges. GPT-4o was barely above chance at multi-party addressee recognition ([arXiv 2501.16643](https://arxiv.org/abs/2501.16643)). A September 2026 benchmark found models often respond when nobody addressed them; the best configuration passed only 66.8% of English scenes ([arXiv 2609.24812](https://arxiv.org/abs/2609.24812)). There is no open dataset or model to adopt, so ARES has to build a small staged classifier and calibrate it on the owner:
1. **Rules.** Keep addressed.js's rules as high-precision triggers and vetoes: name, wake word and stop words, and the wake word only during calls.
2. **A small calibrated scorer.** Logistic regression or boosted trees over cheap features:
   - sentence form (imperative, question, second person);
   - recogniser confidence;
   - prosody relative to the owner's own baseline for speech aimed at ARES;
   - near-field level;
   - seconds since ARES spoke, and whether she asked a question;
   - word overlap with her last answer;
   - recent keyboard activity;
   - other voices or media playing;
   - with ARES Vision on, a face turned to the screen, using Look and Talk's hysteresis: strict before signalling readiness, relaxed once speech starts ([Google Research](https://research.google/blog/look-and-talk-natural-conversations-with-google-assistant/)).
3. **A tie-breaker for the ambiguous middle band only.** Apple's on-device ~3B Foundation Model, with guided generation into a typed yes/no ([Apple ML Research](https://machinelearning.apple.com/research/apple-foundation-models-2025-updates)). Never Claude, so undecided overheard speech never leaves the listener.

Labels come from implicit feedback, stored as feature vectors only:
- "ARES, I was talking to you" marks a false reject.
- An immediate "not you" or "stop" marks a false accept.

ARES's 20 s follow-up window is 2.5–4 times longer than any commercial design:
- Alexa's Follow-Up Mode listened for about 5 s ([TechCrunch](https://techcrunch.com/2018/03/10/now-you-can-have-a-conversation-with-alexa-without-screaming-hey-alexa-for-every-request/)).
- Google's Continued Conversation listened for up to about 8 s ([Search Engine Land](https://searchengineland.com/google-turns-on-continued-conversation-in-the-google-assistant-300741)).
- Siri and Gemini for Home listen for a few seconds ([9to5Mac](https://9to5mac.com/2023/06/05/siri-no-longer-requires-hey-command/), [Google](https://blog.google/products-and-platforms/devices/how-to-use-gemini-continued-conversation/)).

Each still runs every utterance through a directedness classifier and shows an open-mic cue. ARES should replace the flat window with one that demands more evidence as time passes:

| Situation | What ARES requires |
|---|---|
| First ~6 s after her reply | the normal threshold |
| From ~6 s up to 20 s | steadily more evidence |
| Her reply ended with a question | the window extends |
| Other voices, a call or media playing | the window closes early |

### A semantic turn model replaces the 1.3 s silence timer

LiveKit's open eot-bench (June 2026) is the first head-to-head of end-of-turn models on real user turns. It measures how much dead air each model needs to keep false cut-offs within a budget ([eot-bench](https://github.com/livekit/eot-bench)):

| Model (English) | Runs locally | False cut-offs at 300 ms | Silence needed for ≤5% cut-offs | Silence needed for ≤10% |
|---|---|---|---|---|
| Silence-only VAD baseline | yes | 55.6% | 1,600 ms | 1,000 ms |
| Pipecat Smart Turn v3.2 | yes | 35.2% | 1,051 ms | 739 ms |
| LiveKit v1-mini | yes (custom licence) | 27.8% | 1,070 ms | 698 ms |
| Deepgram Flux | no | 12.9% | 1,151 ms | 548 ms |
| Soniox | no | — | 647 ms | 512 ms |
| LiveKit Turn Detector v1 | no (hosted) | 9.9% | 543 ms | 295 ms |

ARES's 1.3 s timer sits on the silence-only curve. **Smart Turn v3.2** cuts the silence needed for ≤5% cut-offs by about a third:
- BSD-2 licence, 8 MB as int8, a Whisper-Tiny encoder, 23 languages ([Smart Turn](https://github.com/pipecat-ai/smart-turn)).
- A third party measured about 3.5 ms per 8 s window on Core ML ([soniqo](https://soniqo.audio/guides/turn)).
- Independent results are less flattering. One 2026 paper measured 58.9% recall for v3, against 87.7% for its own 1.14M-parameter student model ([arXiv 2603.13379](https://arxiv.org/abs/2603.13379)).

The hosted leaders are off-limits, because voice v2 forbids sending turn-taking audio to the cloud. The workable policy:
1. Run a VAD stop of about 0.2 s ([Pipecat](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview)), then Smart Turn.
2. End the turn when its completion score clears the threshold; otherwise re-score every 100–200 ms.
3. Cap the wait at 2.5–3 s, LiveKit's defaults ([LiveKit](https://docs.livekit.io/reference/agents/turn-handling-options/)).
4. Wait longer when the partial transcript ends on "and", "so" or "um"; wait less after a complete question.
5. Adapt the wait to the owner's own pause statistics.

Two alternatives deserve one A/B test each:
- **NVIDIA's 120M-parameter Parakeet EOU model** folds end-of-turn into recognition, but keyboard clicks can reset its timer at a desk ([soniqo](https://soniqo.audio/guides/dictate)).
- **Kyutai's 1B STT** has a semantic VAD and runs under MLX ([Kyutai](https://github.com/kyutai-labs/delayed-streams-modeling)).

### Duck first, confirm, then stop or resume

The best measured interruption classifier is cloud-only. LiveKit's adaptive model (March 2026) rejects 51% of VAD-triggered barge-ins at 86% precision and 100% recall, triggering on a median 216 ms of speech, but it runs only in LiveKit Cloud ([LiveKit](https://livekit.com/blog/adaptive-interruption-handling)). TurnBench (2026) found no system that detects interruptions without excessive false positives in backchannel-heavy talk ([arXiv 2608.25218](https://arxiv.org/abs/2608.25218)).

ARES can approximate the good behaviour on device:
1. When the owner starts speaking during TTS, duck Katherine within about 100 ms.
2. Stop hard on any of these:
   - a stop word ("stop", "wait", "hold on", "Hey ARES");
   - 0.3–0.5 s of owner speech whose words aren't a backchannel ("mm-hm", "yeah", "right");
   - speech within a second of her turn's edges.
3. Otherwise, restore the volume after about 2 s. This matches LiveKit's self-hosted defaults: 0.5 s minimum speech, and a 2.0 s false-interruption timeout followed by resuming ([LiveKit](https://docs.livekit.io/reference/agents/turn-handling-options/)).

On a real stop, ARES should use comms.js's word schedule to tell Claude exactly where she was cut off ("[interrupted after: …]"). That is the pattern behind Alexa's contextual barge-in and OpenAI's truncate call ([Amazon Science](https://amazon.science/blog/change-to-alexa-wake-word-process-adds-natural-turn-taking), [OpenAI](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/truncate)).

Full-duplex speech-to-speech is not the shortcut it looks like. On Full-Duplex-Bench, Moshi takes the floor at 98.5% of user pauses and never backchannels, and even Gemini Live averages 1.3 s on smooth turn changes ([arXiv 2503.04721](https://arxiv.org/html/2503.04721)). None of these models could replace Claude or speak as Katherine.

Human timing sets the targets:
- Turn changes cluster around 200 ms.
- Gaps of 700 ms or more start to signal a reluctant or negative answer ([Levinson & Torreira](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.00731/full)).
- People in a robot study preferred about a 1 s delay, and fillers made longer waits tolerable ([Shiwa et al.](https://doi.org/10.1007/s12369-009-0012-8)).

ARES should therefore treat 1 s as a ceiling, not a goal. It should use backchannels only to cover latency ("One sec."), never "mm-hm" while the owner is talking.

## Three slices hold most of an estimated 3–4.5 s turn

Voice-to-voice latency runs from the user's last word to the assistant's first audible sound. Daily's June 2026 reference budget for a well-built cloud pipeline totals about 1.3 s. Transcription and endpointing take 300 ms of that, and the LLM's time to first token 650 ms ([Daily](https://voiceaiandvoiceagents.com/)). ARES's audio never crosses a network, so most of that budget's transport rows vanish. But three slices are far larger than they need to be:
- the fixed silence timer ([AresListener.swift](file:///Users/dhruv/My%20AI/native/AresListener.swift));
- a Claude Code brain that defaults to Sonnet ([claude.js](file:///Users/dhruv/My%20AI/claude.js));
- `eleven_v3` speech fetched per sentence over HTTPS ([voice.js](file:///Users/dhruv/My%20AI/voice.js)).

| Stage | Today (estimated) | After the changes (estimated) | Main lever |
|---|---|---|---|
| End of turn | 1.3 s silence (plus 0.25 s re-arms) | ~0.3–1.0 s | VAD stop 0.2 s, then Smart Turn v3.2 |
| Final transcript | ~0.1–0.3 s | ~0.05–0.2 s | — |
| Brain to first text | ~1–2.5 s (Sonnet, large prompt prefix) | ~0.6–1.0 s | Haiku 5.5 at low effort, stable cached prefix |
| Text gathered before TTS starts | one full sentence | ~40 characters | stream text deltas into a WebSocket |
| TTS first audio | ~0.76 s (`eleven_v3`) | ~0.15–0.3 s | `eleven_v4_turbo` |
| **Total** | **≈3–4.5 s** | **≈1.2–2.7 s in sequence; ≈0.9–1.7 s with preemptive generation** | |

Every cell above is arithmetic from cited component figures. None has been measured on ARES; that is voice v2's step A1.

**TTS.** `eleven_v3` is ElevenLabs' non-real-time model:
- Vapi measured a **758 ms median to first audio** ([Vapi](https://humannessindex.vapi.ai/models/elevenlabs-eleven-v3)).
- It isn't supported on the classic input-streaming WebSocket; one LiveKit user reproduced a 403 error ([LiveKit community](https://community.livekit.io/t/elevenlabs-eleven-v3-with-livekit-agents-js-plugin-fails-with-websocket-403/1007)).
- At $0.08 per 1,000 characters it costs twice as much as `eleven_v4_turbo` ([ElevenLabs](https://elevenlabs.io/pricing/api)).

**`eleven_v4_turbo`**, launched 28 September 2026, is built for real-time assistants:
- Vendor-stated median inference of about 100 ms ([ElevenLabs](https://elevenlabs.io/docs/models)).
- First on Artificial Analysis's Speech Arena at **Elo 1332, against 1174 for v3** ([Artificial Analysis](https://artificialanalysis.ai/text-to-speech/leaderboard)).
- ElevenLabs directs it through the Text to Dialogue WebSocket ([changelog](https://elevenlabs.io/docs/changelog/2026/9/28)). That socket starts audio after about 40 characters and 8 words, allows one voice per v4 Turbo connection, accepts keep-alives, and closes after 20 s without a message ([ElevenLabs](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd)).

ARES should open that socket when a turn starts and stream Claude's text deltas into it, rather than waiting for sentences split on punctuation. Three things need checking first, all with the owner's go-ahead, since ARES's rules forbid spending credits on testing:
- Does the Katherine voice work on v4? Launch coverage says clones built on older models must be retrained ([VKTR](https://www.vktr.com/ai-platforms/elevenlabs-launches-eleven-v4-and-v4-turbo/)).
- Does the beta socket offer PCM? The guide shows only MP3.
- How does it sound?

Flash v2.5 (~75 ms, Elo 1079) is the cheaper real-time fallback, and Kokoro stays the local one.

**The brain.** Anthropic's new **Claude Haiku 5.5**, released 7 October 2026 at $0.10/$0.50 per million tokens, is pitched as its fastest model for latency-sensitive classification and routing ([Anthropic](https://platform.claude.com/docs/en/models/haiku-5-5/overview)). Its time to first token isn't published yet. Its predecessor Haiku 4.5 measured a 637 ms median and 1,615 ms P95 ([Daily](https://voiceaiandvoiceagents.com/)). Sonnet 5 at medium effort took about 2.55 s to its first answer token (search summary) ([Artificial Analysis](https://artificialanalysis.ai/models/claude-sonnet-5-medium/providers)).

Claude Code adds a heavy fixed prefix: about 33,000 tokens before any user input, 24,000 of them tool definitions, rising to 75–85k with MCP servers, per a third-party measurement ([Systima via Ganglani](https://www.kunalganglani.com/blog/opencode-vs-claude-code-token-overhead)). Any change to tool definitions invalidates the whole prompt cache, and the cache lives for 5 minutes ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). So:
- Keep the tool list and system prompt byte-identical for the life of the session.
- Put per-turn context in the user message.
- Consider deferring MCP tools behind tool search, which cut one setup's first request by 64% ([azukiazusa](https://azukiazusa.dev/en/blog/enable-claude-code-tool-search-to-reduce-mcp-token-usage)).
- Don't use `--bare`. It would speed start-up but bypasses the subscription login ARES depends on ([Claude Code](https://code.claude.com/docs/en/headless)).

Route quick chat and simple asks to Haiku 5.5 at low effort, and keep Sonnet 5.5 and Opus 5.5 for real reasoning. That is the configuration change most likely to save 0.5–2 s per turn.

**Overlap and silence.** The remaining gains come from overlapping stages and never leaving dead air:
- **Preemptive generation.** LiveKit starts the LLM on the final transcript before the turn is confirmed, but leaves speculative TTS off by default. It cancels when the transcript changes and skips utterances over 10 s ([LiveKit](https://docs.livekit.io/agents/logic/turns/tuning/)). Deepgram's equivalent adds 50–70% more LLM calls ([Deepgram](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot)). In ARES, speculative turns sent into the long-running Claude Code session would pollute its history. Preemptive calls belong on a separate, stateless fast path, or should fire only when the end of turn is confident.
- **Tool calls.** These create the worst silences: about 3.4 s in one instrumented Claude Code run ([mer.vin](https://mer.vin/news/why-claudes-token-stream-goes-quiet-the-moment-it-calls-a-tool/)). The prompt should make Claude say one short spoken line before any tool. Play a cached "One sec." only when no text comes before a tool call.
- **Slow work** belongs in ARES's existing jobs: acknowledged at once and reported later, as LiveKit's subagent delegation and OpenAI's GPT-Live delegation do ([LiveKit](https://docs.livekit.io/agents/logic/patterns/subagent-delegation/), [OpenAI](https://developers.openai.com/api/docs/guides/voice-agents)).

The strongest alternative is handing the voice layer to a cloud speech-to-speech model. OpenAI's GPT-Live costs $0.05 per session minute ([OpenAI](https://developers.openai.com/api/docs/pricing)). Agora measured its median response 205 ms faster than Advanced Voice Mode, with a P90 only 104 ms above the median ([Agora](https://prod.agora.io/en/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it)). Its client delegation can call any backend, Claude included. But it would break three of ARES's rules: it answers small talk with OpenAI's own model, sends audio off the Mac, and replaces Katherine.

Kyutai's Unmute is the better template: keep the text LLM and make every voice stage stream ([Kyutai](https://kyutai.org/2025/05/22/unmute.html)). Pipecat and LiveKit Agents are worth borrowing from (Smart Turn, the endpointing and interruption defaults, Pipecat's per-stage latency schema) but not adopting. Their main value is WebRTC transport, which ARES doesn't need.

## Intent belongs in a tiered router sharing one action registry

Every shipping assistant that has published details is hybrid:
- **Home Assistant** handles a closed list of commands with its own non-AI matcher and sends only what it can't parse to the LLM ([Home Assistant](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant)).
- **Alexa+** routes each request among Amazon Nova and Anthropic models and task "experts" ([TechCrunch](https://techcrunch.com/2025/02/26/amazon-says-that-alexa-is-model-agnostic)). Amazon said Nova handled over 70% of conversations in one four-week period ([CNBC](https://www.nbcconnecticut.com/news/business/money-report/amazons-most-powerful-new-alexa-features-being-powered-by-anthropics-ai-sources-say/3509896/)).

ARES already has this shape: an embedding intent layer, router.js, then Claude with MCP tools. The improvement is to make the fast path and Claude call **one shared action registry**, with identical names, slot schemas, risk tiers and logs. The tiers:

| Tier | What | Notes |
|---|---|---|
| 0 | Deterministic grammar for timers, volume, media, stop and power words | real slot parsers for numbers and times |
| 1 | Embedding nearest-neighbour matching over individual example phrases (not route averages) | per-route thresholds, a top-1/top-2 margin, and a `none` route full of near-misses. "What's a good volume for a podcast?" must not set the volume. A small local encoder such as EmbeddingGemma runs in under 200 MB quantised ([Google](https://developers.googleblog.com/introducing-embeddinggemma/)) |
| 2 | Apple's on-device Foundation Model with a typed intent enum, for slot extraction the grammar can't do | prewarm first: one developer's 20+ s structured call was dominated by schema compilation, and Apple's developer relations quotes roughly 20–30 tokens/s ([Apple forums](https://developer.apple.com/forums/thread/791993)) |
| 3 | Claude | everything else |

The fast path may only execute tier-1 actions (reversible, low-risk). A wrong fast-path action costs more than a miss, which costs only latency.

Several alternatives fall short:
- **Tiny function-calling models** aren't worth it without fine-tuning. FunctionGemma 270M scores 58% on Google's mobile-actions evaluation, and 85% after fine-tuning ([Google DeepMind](https://deepmind.google/models/gemma/functiongemma/)).
- **Picovoice Rhino** beats ASR-then-NLU pipelines in noise on its vendor benchmark (94% vs 76% at 6 dB signal-to-noise) ([Picovoice](https://picovoice.ai/docs/benchmark/nlu)). But it needs a proprietary key and hand-written grammars, and duplicates ARES's recogniser.
- **End-to-end spoken language understanding** matched ASR-then-NLU pipelines only with heavy pretraining ([STOP](https://arxiv.org/pdf/2207.10643)), and ARES needs the transcript anyway.

Named entities are where speech errors hurt most. Apple's 2024 method has the model spot names, retrieves phonetically similar candidates from the personal database, and decodes again. It cut named-entity errors by **73.6% relative** ([arXiv 2409.15353](https://arxiv.org/html/2409.15353v1)). ARES should:
- Run one shared entity resolver over contacts, apps, recent files, calendars and memory aliases, using phonetic keys, character n-grams and recency.
- Let Claude's tools accept fuzzy names and return candidates.
- Learn a personal alias table from corrections ("no, Shria").
- Where the recogniser offers alternatives, pass Claude the top two or three. LLM correction over a list of alternative transcripts is well established ([HyPoradise](https://arxiv.org/abs/2309.15701v2)), though it over-corrects rare words without phonetic context ([arXiv 2505.17410](https://arxiv.org/abs/2505.17410v1)).

Confirmation should scale with risk times uncertainty:

| Situation | ARES's response |
|---|---|
| Reversible command | act and state the result |
| Two close entity candidates | one short question naming both |
| Tier-3 action | read back and confirm |

Follow-ups such as "do that again", "send it to her" and "and the kitchen too" need dialogue state that ARES owns, not the Claude transcript:
- recent executed actions, with their slots and an undo;
- the most salient entity of each type;
- a text description of what ARES is showing, the approach Apple's ReALM uses to resolve on-screen references with a small model ([arXiv 2403.20329](https://arxiv.org/html/2403.20329v2)).

Short, pronoun-bearing utterances should be rewritten into self-contained requests before routing (Apple's CREAD pattern), so the fast path can handle them ([arXiv 2105.09914](https://arxiv.org/pdf/2105.09914)). The router must re-evaluate every turn. Home Assistant shipped a bug in which a follow-up after a local command got stuck in LLM mode ([GitHub](https://github.com/home-assistant/core/issues/162768)).

Public datasets such as MASSIVE (1M utterances over 60 intents) are good for seeding paraphrases but don't measure what matters ([arXiv 2204.08582](https://arxiv.org/pdf/2204.08582)). ARES needs a personal test set of three parts:
- the owner's commands addressed to ARES, with consent, never overheard speech;
- curated paraphrases;
- deliberate negatives.

Score it on:
- fast-path precision (target about 99%);
- routing accuracy;
- exact slot matches;
- entity top-1 and top-3;
- latency per route;
- LLM consistency as pass^k. That is the τ-bench metric that showed agents succeeding on under half of retail tasks, with under 25% succeeding on all of 8 tries ([arXiv 2406.12045](https://arxiv.org/pdf/2406.12045)).

BFCL is a coarse signal at best: an audit found possible defects in 48% of sampled tasks ([Epoch AI](https://epoch.ai/benchmarks/berkeley-function-calling-leaderboard/review)).

## Natural speech defeats fine emotion labels, so tone should steer style

Speech emotion recognition looks solved on acted data and modest on real speech. A wav2vec2 model reaches 78.7% on the acted IEMOCAP corpus ([SpeechBrain](https://huggingface.co/speechbrain/emotion-recognition-wav2vec2-IEMOCAP)). But the Interspeech 2025 challenge on natural podcast speech was won at **0.4316 macro-F1 across eight classes**, against a 0.3293 baseline. The best combined score for arousal, valence and dominance was 0.6076, with dominance the hardest dimension ([MSP-Podcast challenge](https://lab-msp.com/MSP-Podcast_Competition/IS2025/)).

Audio-native LLMs mostly read the words:
- The independent LISTEN benchmark found audio-only emotion accuracy of 16.5–34.9% when the wording is neutral, against 81–97% from text, and near-chance recognition of laughs and sighs ([arXiv 2510.10444](https://arxiv.org/html/2510.10444v2)).
- AHELM found plain ASR-plus-LLM pipelines competitive with audio LLMs ([arXiv 2508.21376](https://arxiv.org/abs/2508.21376)).

Moving the brain to an audio model would not reliably buy tone sensitivity, and it would mean leaving Claude.

The cheapest signal is already in ARES's recogniser. `SFSpeechRecognitionMetadata` exposes speaking rate, average pause length, and per-frame pitch, jitter and shimmer ([Apple](https://developer.apple.com/documentation/speech/sfspeechrecognitionmetadata.md)). Two caveats: voice processing can distort these by an amount nobody has measured, and SpeechTranscriber doesn't appear to expose them. Compare each utterance addressed to ARES with the owner's own running baseline. That sidesteps a known weakness: SER models are not equally accurate across individual speakers ([arXiv 2203.07378](https://arxiv.org/abs/2203.07378)).

For a second step, three models fit:
- **emotion2vec+ base** (~90M parameters, MIT) gives emotion categories ([emotion2vec](https://github.com/ddlBoJack/emotion2vec)).
- **audEERING's dimensional model** gives arousal and valence. It has an ONNX export but a research-only CC BY-NC-SA licence ([audEERING](https://huggingface.co/audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim)).
- **Apple's SoundAnalysis classifier** covers 300+ sound categories on device, for discrete events like laughs ([WWDC21](https://developer.apple.com/videos/play/wwdc2021/10036/)).

Neither SER model has published Apple Silicon timings. ARES should use a small, coarse vocabulary: energy up, energy down, clearly positive or negative, a laugh or a sigh. Stress, fatigue, urgency and sarcasm should be hypotheses for Claude to weigh with context, not detector outputs.

The proven way to hand tone to a text brain is a short natural-language note on the user's turn. Hume's EVI, when Claude or GPT is its language model, appends the top three detected expressions to each user message. It tells the model to adapt its tone without naming them, and to watch for mismatches between words and tone ([Hume](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting)). SpeechCueLLM showed that describing vocal cues in the prompt improves an LLM's emotion recognition. One version reports about 2.5 points of weighted F1 on IEMOCAP with LoRA (search summary) ([arXiv 2407.21315](https://arxiv.org/abs/2407.21315)).

ARES's note could read `[voice: faster and louder than usual, laughed once; sounds amused (medium confidence)]`. It should appear only when the owner deviates from his baseline, with these rules for Claude:
- Adjust style, length and pacing.
- Never name the emotion unless he raises it.
- Read positive words in a flat delivery as humour or sarcasm.
- Answer stress with shorter, steadier, solution-first replies.
- Default to neutral.

A misread should cost a subtle style shift, never "you sound angry". Tone analysis should run only on speech addressed to ARES, stay in memory, and build no long-term emotional profile. The EU AI Act has banned inferring emotion from biometric data in workplaces and education since 2 February 2025 ([FPF](https://fpf.org/blog/red-lines-under-eu-ai-act-unpacking-the-prohibition-of-emotion-recognition-in-the-workplace-and-education-institutions/)). A personal tool looks outside that ban's aim, but analysing callers or colleagues would change the picture (not legal advice).

| Owner sounds | Katherine's response | Tag use |
|---|---|---|
| Stressed or rushed | slower, shorter, solution first | no laughter |
| Tired or flat | brief and gentle | `[softly]` |
| Joking or laughing | playful wording | an occasional `[laughs]` |
| Excited | brighter, not louder | `[excited]` |
| Annoyed at ARES | brief acknowledgement, then the fix | none |

On the output side, ElevenLabs v3 and v4 support bracketed audio tags ([ElevenLabs](https://elevenlabs.io/docs/best-practices/prompting), [ElevenLabs](https://elevenlabs.io/blog/elevenlabs-audio-tags-list)):
- Tags cover laughs, sighs, whispers, excitement, curiosity and pacing, and each one's effect carries forward until the next tag.
- Ellipses add pauses and capitals add emphasis.
- SSML breaks aren't supported, and ElevenLabs recommends v4 over v3.

ARES's brain already adds occasional cues ([claude.js](file:///Users/dhruv/My%20AI/claude.js)), but three problems need fixing before a switch to v4:
- voice.js passes cues through only when the model is exactly `eleven_v3` ([voice.js](file:///Users/dhruv/My%20AI/voice.js)), so on v4 every tag would be silently stripped.
- The stripping regex misses combined tags such as `[whispering, playful]`.
- Claude's examples `[dryly]`, `[amused]` and `[warmly]` aren't in ElevenLabs' documented lists. A whitelist of documented tags, at most one per sentence, is safer.

Kokoro has no tag interface, so the local fallback stays tagless, mapping tone to speed at most. Chatterbox Turbo is the leading expressive local candidate: MIT licence, native laugh and chuckle tags, MLX ports, and watermarked output ([Chatterbox](https://github.com/resemble-ai/chatterbox)).

Timing beats tags. In Sesame's listening tests, listeners couldn't tell its model from human speech in isolation, but consistently preferred the real recordings once they heard 90 s of conversation around them ([Sesame](https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice)). Google's Duplex found that a brief filler before a complex answer, and an instant reply to a simple one, both read as natural ([Google Research](https://research.google/blog/google-duplex-an-ai-system-for-accomplishing-real-world-tasks-over-the-phone/)).

## Measure first, then ship in three waves

Every saving and threshold above comes from vendors, benchmarks or other people's hardware, and the decisive unknowns are local:
- whether VPIO cancels audio from other processes;
- how each recogniser handles the owner's accent;
- the owner's real voiceprint false-reject rate;
- how Smart Turn handles his pauses;
- whether Katherine survives the move to v4.

Voice v2's measurement steps should therefore run first: A1 (per-stage latency log), A3 (labelled voice trials) and A5 (end-of-turn comparison). Alongside them, collect a 50–100-command WER set recorded near and far, ten hours of room audio for wake-word false accepts, and an intent test set with negatives. The waves below order the work by cost and strength of evidence.

| Wave | Change | Replaces | Expected effect (evidence above) | Watch-outs |
|---|---|---|---|---|
| 0 | Per-stage latency log, labelled voice trials, owner WER set, 10 h room audio, end-of-turn and intent test sets | estimates | Turns this report's numbers into ARES's own | Store features and scores, never other people's audio |
| 1 | VAD stop 0.2 s, then Smart Turn v3.2, a 2.5–3 s cap and transcript cues | 1.3 s silence timer | ≤5% cut-offs at ~1.05 s instead of 1.6 s | Untested on the owner's accent |
| 1 | Haiku 5.5 at low effort for quick turns; byte-stable tools and system prompt; tool search; one spoken line before tools | Sonnet by default | ~0.5–2 s per turn (estimate) | Haiku 5.5 latency unpublished |
| 1 | Whole-utterance voice scoring, sub-1 s clips as no evidence, re-enrollment in several conditions, scoring against all enrollment vectors | centroid with a 0.48 cap set from enrollment | Removes the threshold mismatch behind the 26.8% accept rate | Needs labelled trials to set the operating point |
| 1 | Follow-up window that demands more evidence as it ages, with a visible cue | flat 20 s window | Matches commercial 5–8 s windows | — |
| 1 | Barge-in: duck, confirm, then stop or resume after ~2 s; tell Claude where she stopped | stop on any VAD trigger | Fewer false stops on "mm-hm" | Depends on good echo cancellation |
| 1 | Custom language model with an X-SAMPA "Ares"; v4 tag pass-through and whitelist in voice.js; tone note from recogniser metadata | two contextual strings; tags for v3 only | Interim recognition gain; tags survive the model switch | Recognition gain unquantified |
| 2 | "Hey ARES" livekit-wakeword model in a four-stage cascade, with self-trigger suppression | transcript regex | 0.08 false accepts/h at 86% recall (vendor) | Validate on 10 h of room audio |
| 2 | SpeechTranscriber for live text; Parakeet TDT v2 batch pass with vocabulary aliases for the final text | `SFSpeechRecognizer` | 9.02% to ~2.1% WER on clean speech | No accent benchmarks; locale coverage |
| 2 | `eleven_v4_turbo` on the Text to Dialogue WebSocket with streamed text; Flash v2.5 and Kokoro as fallbacks | per-sentence `eleven_v3` over HTTPS | ~0.5 s sooner first audio, half the price, higher arena rank | Katherine on v4, beta socket, PCM; owner's go for credits |
| 2 | Stronger sherpa-onnx speaker model, AS-norm, logistic calibration, fused trust score gated by tier | TitaNet-small hard gate | 40–55% lower benchmark EER; calibrated likelihood ratios | Choose on 1–2 s clips |
| 2 | Calibrated addressee classifier with Apple Foundation Model tie-breaker | regex rules | Fusion roughly halved EER in Amazon's data | Apple model latency on a Mac unmeasured |
| 2 | Shared action registry, nearest-neighbour router with margins and negatives, entity resolver, dialogue state, stateless preemptive path | embedding layer then Claude | Fewer wrong fast-path actions; 73.6% fewer entity errors in Apple's method | Fast path executes tier 1 only |
| 3 | WebRTC AEC3 fed by a global Core Audio tap | VPIO's undocumented reference | Explicitly cancels YouTube and Katherine | Permission, lost Mic Modes, tap bugs; only if VPIO fails the echo test |
| 3 | XVF3800-class array; emotion2vec+ sidecar; owner LoRA ASR or Smart Turn fine-tune; personalised enhancement | built-in mic; prosody-only tone | Across-the-room pickup, richer tone, better accent fit | Cost and upkeep |

The project's standing rules shape how each wave is tested ([CLAUDE.md](file:///Users/dhruv/My%20AI/CLAUDE.md)):
- Pipeline tests run on Kokoro, a mocked ElevenLabs or an invalid key.
- The ElevenLabs phone agent and Twilio number stay untouched.
- Overheard speech is never logged, sent to the brain or captioned.

That last rule now has a technical twin: owner-gating before any text leaves the listener.

## Conclusion

The research changes the shape of the problem more than the parts list. ARES's failures look like seven separate weaknesses but are one: binary decisions made on a single noisy signal with a hand-set threshold. Every mature system that works does something else. Siri's trigger, Alexa's follow-up mode, Look and Talk and LiveKit's turn handling all feed a cheap, high-recall detector into a calibrated blend of several weak cues, and run at a deliberately chosen point on a measured error curve. ARES has an advantage those products lack: it serves one person. It can calibrate on his voice, his pauses and his accent, harvest labels from his corrections, and use presence signals a smart speaker never sees: the keyboard, the unlocked screen, the paired phone. In this single-user setting, per-owner baselines stop being a fairness patch and become the core method.

Two further implications stand out. First, the cheapest gains are policies, not models. The end-of-turn rule, the model router, how the voice threshold is derived and the length of the follow-up window are all configuration, and together they likely recover more naturalness than any new neural network. Second, ARES's privacy rules and its quality goals point the same way. Gating on the owner before text leaves the listener, keeping wake and turn-taking on device, and never sending undecided speech to Claude are the private choices and, on the evidence, also the accurate ones. The open risk is the newest layer: Haiku 5.5 is a day old, Eleven v4 Turbo is ten days old, and its dialogue socket is in beta. The output path deserves the most careful measurement before ARES commits to it.
