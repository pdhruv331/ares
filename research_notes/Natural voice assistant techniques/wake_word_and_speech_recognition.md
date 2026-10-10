# Wake-word detection and on-device speech recognition for ARES (state as of October 2026)

Scope: (1) wake-word / keyword-spotting (KWS) engines and custom wake-word training for the rare name "ARES"; (2) on-device ASR on Apple Silicon (macOS 26) and cloud STT for comparison. ARES today: Apple `SFSpeechRecognizer` (en-GB, streaming, on-device when supported) and a regex over the live transcript. Research date: 2026-10-08. Vendor-reported numbers are flagged as such.

## Q1. Which wake-word / keyword-spotting engines are available in 2026, and how do they compare (false-reject/false-accept, CPU, latency, licence, macOS/Apple Silicon)?

### Takeaway
For a free, on-device, custom "Hey ARES" detector on a Mac, the practical 2026 choices are openWakeWord-style models: openWakeWord itself, or the newer **livekit-wakeword** (Apache-2.0, a Swift package for macOS 14+, and far fewer false positives than openWakeWord on its own benchmark). **sherpa-onnx open-vocabulary KWS** is a zero-training option that suits prototyping or a second-stage check. microWakeWord is built for microcontrollers. **Picovoice Porcupine is no longer free:** its free-tier keys stopped working on 30 June 2026. Snowboy, Mycroft Precise and Howl are legacy.

### Cited Findings

#### openWakeWord (dscripka)
- Latest listed release is v0.6.0 (2024-02-11). The code is Apache-2.0. The **pre-trained models are CC BY-NC-SA 4.0**, because some training datasets have unknown or restrictive licences. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- Architecture: a fixed ONNX melspectrogram, a frozen shared feature backbone (Google's speech-embedding model), and a small classifier (a fully connected network or a 2-layer RNN). — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- Stated target: "<5% false-reject rates and <0.5/hour false-accept rates" with threshold tuning (default threshold 0.5). The project calls these targets subjective. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- CPU: "a single core of a Raspberry Pi 3 can run 15-20 openWakeWord models simultaneously in real-time". Audio is processed in 80 ms frames of 16-bit, 16 kHz PCM; longer frames are more efficient but add latency. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- Platforms: installs with `pip install openwakeword`; the README covers Linux and Windows, and macOS is not mentioned. Speex noise suppression is Linux-only. An optional Silero VAD gate (`vad_threshold`) requires both the wake score and the VAD score to pass. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- **Custom verifier models** are speaker-specific second-stage filters that accept activations only from known voices. The README says they "greatly reduce false activations" but make the system less likely to respond to new voices. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- A worked 2026 example on macOS, "hey-claude": a 32-unit DNN head on openWakeWord's frozen embedding, about 200 KB, runs on CPU. The whole run took about 1 hour on a MacBook Air M2 (about 8 min of CPU training). It was tested on 5 macOS voices not used in training, with 0 false wakes in a 3-minute empty-room test (the author notes this is a weak test). — [hey-claude model card](https://huggingface.co/gdiamos/hey-claude)

#### livekit-wakeword (LiveKit, 2026)
- Licence Apache-2.0, README badge v0.2. Same front-end as openWakeWord: mel spectrogram, then the frozen Google speech-embedding and openWakeWord embedding models, giving a (16, 96) feature matrix. The default `conv_attention` head is Conv1D blocks, multi-head attention, mean-pool, linear and sigmoid. `dnn`/`rnn` heads are also available, in sizes tiny/small/medium/large. — [livekit-wakeword GitHub](https://github.com/livekit/livekit-wakeword)
- Runtimes: Python 3.11+, a Rust crate (0.1), and **a Swift package for iOS 16+ / macOS 14+ using ONNX Runtime with the CoreML execution provider (ANE/GPU/CPU)**. macOS setup uses Homebrew (espeak-ng, ffmpeg, portaudio). Models are ONNX (optional TFLite for the DNN head only). — [livekit-wakeword GitHub](https://github.com/livekit/livekit-wakeword)
- Its own benchmark is on a "hey livekit" validation set: 15,000 positives, 45,084 negatives, about 25 h of audio. **openWakeWord (DNN): AUT 0.0720, 8.50 false positives per hour (FPPH), recall 68.6%. livekit DNN: 0.0423, 3.07 FPPH, 85.3%. livekit conv-attention: 0.0012, 0.08 FPPH, 86.1%.** The default FPPH target is 0.1. — [livekit-wakeword GitHub](https://github.com/livekit/livekit-wakeword); [LiveKit blog](https://livekit.com/blog/livekit-wakeword) (markets this as "100× fewer" false positives; the blog's date reads "04.06.2026", which is ambiguous)

#### microWakeWord (Open Home Foundation / ESPHome)
- Apache-2.0, described as "an early release". It produces TensorFlow Lite for Microcontrollers models. The streaming MixConv model is adapted from Google Research's kws_streaming code: trained non-streaming, then converted to streaming and quantized. — [microWakeWord GitHub](https://github.com/OHF-Voice/micro-wake-word)
- Features: 40 spectrogram features every 10 ms from the TFLite-Micro micro_speech front-end, which includes noise suppression and AGC (16 kHz, 30 ms window). The streaming model runs inference every 30 ms. — [microWakeWord GitHub](https://github.com/OHF-Voice/micro-wake-word)
- Training picks the best weights by first minimizing false accepts per hour on ambient audio, then maximizing accuracy. FAH is estimated from long ambient clips at a 100 ms stride, which the project calls "not a perfect estimate". The training notebook "will most likely not be usable" except by advanced users. — [microWakeWord GitHub](https://github.com/OHF-Voice/micro-wake-word)
- ESPHome runtime knobs: `probability_cutoff` (higher means fewer false accepts and more misses), `sliding_window_size` (smaller is faster but lets more false triggers through), and an optional VAD model. — [ESPHome micro_wake_word](https://esphome.io/components/micro_wake_word.html)
- openWakeWord's README recommends microWakeWord for ESP32-class microcontrollers, where openWakeWord can take seconds per frame. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)

#### sherpa-onnx open-vocabulary KWS (k2-fsa)
- It works like a small ASR model that "can only decode words/phrases in the given keywords". Keywords can be changed without retraining. Each keyword has a boosting score (helps it survive beam search) and a trigger threshold (0–1). The keywords-file line format is `▁HE LL O ▁WORLD :1.5 #0.35`, generated with `sherpa-onnx-cli text2token`. — [sherpa-onnx KWS docs](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)
- Pre-trained models: `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (English, fp32/int8), `...wenetspeech-3.3M-2024-01-01` (Chinese) and `...zh-en-3M-2025-12-20`. **The docs publish no accuracy or false-alarm figures.** — [sherpa-onnx KWS docs](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)
- sherpa-onnx targets Android, iOS, WebAssembly and Raspberry Pi among other platforms. — [sherpa-onnx package page](https://pkg.go.dev/github.com/k2-fsa/sherpa-onnx)
- Tokenization pitfall: automatic BPE splitting can differ from what the model emits, so a guide recommends supplying pre-tokenized keywords when a phrase is skipped. The soniqo Swift toolkit runs a modified beam search (beam 4) over a keyword context graph with a GigaSpeech KWS fine-tune. — [soniqo wake-word guide](https://soniqo.audio/guides/wake-word)

#### Picovoice Porcupine (commercial)
- **Free tier ended 30 June 2026.** In an email quoted on the Home Assistant forum (4 June 2026), Picovoice said: "After Free Tier AccessKeys are disabled on June 30, 2026, features using those keys will stop working"; "The SDK does not run without a valid key" (it is checked at engine start-up, even offline); "There is no non-commercial tier planned"; and it is focusing on "enterprise deployments". This is one user's secondhand report. — [HA forum: Picovoice free tier](https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744)
- Picovoice's own January 2025 blog had described a free tier for personal, non-commercial projects that included Porcupine. — [Picovoice blog](https://picovoice.ai/blog/introducing-picovoices-free-tier)
- In the same forum thread, the original poster found Porcupine "much more reliable than openWakeWord" for custom Japanese wake words. — [HA forum](https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744)
- Picovoice's open benchmark methodology: miss rate at 1 false alarm per 10 hours. Background speech is LibriSpeech test-clean; there are more than 300 recordings of 6 keywords from more than 50 speakers, with DEMAND noise at 10 dB SNR. CPU is measured on a Raspberry Pi 5. It compares Porcupine, PocketSphinx and Snowboy only, and the numbers appear only in images. — [Picovoice wake-word-benchmark](https://github.com/Picovoice/wake-word-benchmark); [Picovoice benchmark docs](https://picovoice.ai/docs/benchmark/wake-word/)
- Older Rhasspy docs warn that generated Porcupine keyword files lapse after 30 days. — [Rhasspy wake-word docs](https://rhasspy.readthedocs.io/en/v2.4.20/wake-word/)

#### Legacy engines (do not build on)
- **Snowboy (KITT.AI):** all KITT.AI products shut down on 31 Dec 2020. The repos stayed public, but custom-model training was server-side, so it went away. — [Snowboy README mirror](https://portrait.gitee.com/Gavin-J/snowboy/blob/master/README.md); [Node-RED forum](https://discourse.nodered.org/t/ways-to-control-node-red-with-speech-commands/5530?page=5); [Picovoice: open-source KWS data](https://picovoice.ai/blog/open-source-keyword-spotting-data/)
- **Mycroft Precise:** Mycroft's ML wake-word engine. Mycroft AI ended development in early 2023, and OpenVoiceOS is the community successor. Some sources date the dissolution to early 2024. — [Wikipedia: Mycroft](https://en.wikipedia.org/wiki/Mycroft_(software)); [Mycroft Precise docs](https://mycroft-ai.gitbook.io/docs/mycroft-technologies/precise.md)
- **Howl (Castorini/Mozilla, 2020):** an open-source wake-word toolkit used in Firefox Voice, which Mozilla shut down in February 2021. — [Howl paper (ACL Anthology)](https://preview.aclanthology.org/setup/2020.nlposs-1.9); [Voicebot: Firefox Voice shut down](https://voicebot.ai/2021/02/01/mozilla-officially-shuts-down-firefox-voice-browser-extension/)

#### Commercial personalised alternatives (for comparison)
- Sensory's docs describe enrolment where a user says the phrase about 4 times, with on-device training and fewer false triggers from other speakers. — [Sensory TNL docs](https://doc.sensory.com/tnl/7.8/getting-started/); [Sensory](https://sensory.com/domain-specific-voice-assistants/)

### Inferences
- On an M-series Mac, CPU cost is a non-issue for any openWakeWord-family model. One Raspberry Pi 3 core runs 15–20 of them, so an always-on detector should cost well under 1% of one core. The real trade-off is accuracy and false accepts.
- **Recommended primary detector for ARES: a custom "hey ARES" model trained with livekit-wakeword.** It uses the same proven openWakeWord front-end, has a better classifier head and a native Swift/ONNX-Runtime path for macOS 14+ that fits ARES's Swift listener, and is Apache-2.0. Treat its 0.08 FPPH as a best case: it is the vendor's own test on its own phrase.
- openWakeWord's pre-trained backbone weights are non-commercial (CC BY-NC-SA). That is fine for a personal assistant but matters if ARES is ever distributed commercially.
- sherpa-onnx KWS needs no training. A "HEY ARES" keyword with tuned `:boost` and `#threshold` is a cheap first prototype and a good **second-stage verifier**, because its decoder can only output the given keywords and is never drawn toward "Aries"/"Harris". Its accuracy must be measured, since none is published.
- Porcupine is out for ARES. There is no free tier, the key is checked even offline, and Picovoice says no non-commercial tier is planned.

### Gaps
- No independent (non-vendor) head-to-head FRR/FAR benchmark covering openWakeWord, livekit-wakeword, microWakeWord, sherpa-onnx KWS and Porcupine on the same data was found. Picovoice's numbers are only in images, and LiveKit's are self-reported.
- Porcupine's paid pricing is unverified: third-party directories conflict (an "$899/month" listing versus "from $30,000/year" enterprise), and no official price page was retrieved.
- Whether openWakeWord's Python package runs natively on macOS arm64 is not documented in the README. It is evidenced only by the hey-claude example.

## Q2. How do you train a reliable custom wake word for a rare name like "ARES" (synthetic TTS data, augmentation, negatives, real recordings, target metrics)?

### Takeaway
The proven recipe has five parts:
- thousands of TTS-generated positives from many voices, filtered for intelligibility;
- heavy augmentation with noise, reverb/RIRs and pitch;
- tens of thousands of hours of generic negatives plus *adversarial* near-miss phrases;
- threshold tuning on held-out audio, targeting at most about 0.1–0.5 false accepts per hour at a 2–5% false-reject rate;
- for a non-standard accent, mixing in a handful of the owner's own recordings, which several 2026 tools now support directly.

### Cited Findings
- openWakeWord: train on "several thousand" synthetic examples at minimum, and performance rises with dataset size. Negative data (speech, noise, music without the wake word) is also required, and the bundled models used about 30,000 hours. A basic model trains in under 1 hour in Colab. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- Community recipe (HA forum, 28 June 2026): generate a few thousand Piper clips with varied voices and augmentation, download openWakeWord's roughly 4 GB background/negative feature set, train a small classifier, then tune the threshold to balance missed wakes against false triggers. The poster estimates 1–2 hours. — [HA forum thread](https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744)
- hey-claude worked example: thousands of renditions across many voices as positives, confusable phrases as **hard negatives**, plus precomputed features, room impulse responses and background noise. **Whisper was used to discard synthetic positives that weren't clearly intelligible.** — [hey-claude model card](https://huggingface.co/gdiamos/hey-claude)
- livekit-wakeword pipeline:
  1. `setup`
  2. `generate`: Piper TTS for English or **VoxCPM2 for 30 languages plus Chinese dialects**, plus adversarial negatives
  3. `augment`: noise, reverb, pitch shift
  4. `train`: 3-phase training with focal loss, embedding mixup and checkpoint averaging
  5. `export`: ONNX
  6. `eval`: DET curve, AUT, FPPH, recall

  A YAML config sets `target_phrases` and `n_samples`, and `livekit-wakeword run config.yaml` produces an ONNX file. — [livekit-wakeword GitHub](https://github.com/livekit/livekit-wakeword); [LiveKit blog](https://livekit.com/blog/livekit-wakeword)
- Design rules from the 2026 openWakeWord Colab rework:
  - Use one ONNX model per wake phrase, because every variant in one model shares its output.
  - Uncommon phrases generalise better than everyday words.
  - Piper's output is English-accented.
  - **A separate pronunciation hint can be given to the TTS step only**, leaving the model name and canonical phrase unchanged.
  
  — [openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026)
- 2026 tooling problems:
  - The stock openWakeWord Colab fails in 8+ ways on a default runtime.
  - Python 3.12 has no prebuilt piper-phonemize wheels, so use Python 3.11.
  - Some pipelines pin PyTorch 1.13.1 / TF 2.8.1, and need an NVIDIA GPU, Docker and about 45 GB of disk (atlas route) or about 10 GB (hawake).
  
  GUI and wrapper tools exist: Wake Lab, and hawake-wakeword (a Streamlit UI that exports ONNX opset 11). — [openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026); [hawake-wakeword](https://github.com/IT-BAER/hawake-wakeword); [atlas-voice-training](https://github.com/briankelley/atlas-voice-training); [Wake Lab](https://gitblind.noratr.app/avalon60/WakeLab)
- The piper-sample-generator exists to produce wake-word clips for openWakeWord/microWakeWord training, and a GPU speeds synthesis considerably. — [piper-sample-generator](https://github.com/fherreror/piper-sample-generator); [microWakeWord GitHub](https://github.com/OHF-Voice/micro-wake-word)
- microWakeWord: Piper positives, pre-generated negative feature sets on Hugging Face, SpecAugment, and checkpoints chosen by lowest ambient FAH first. — [microWakeWord GitHub](https://github.com/OHF-Voice/micro-wake-word)
- A third-party Docker microWakeWord trainer keeps reviewed false wakes and hard negatives as its negative class, with an opt-in retraining loop aimed at false positives. — [microwakeword-trainer (Unraid)](https://ca.unraid.net/apps/microwakeword-trainer-nvidia-1ofnkd60c5avkm)
- **SEED (HA forum, 25 July 2026), the few-real-recordings route:**
  - Record **5–9 acted takes** of the wake word in your own voice.
  - The WORLD vocoder turns each into about 20 timbres (child, woman, man, older, at different speeds), giving about 180 samples.
  - The microWakeWord trainer augments these to 50,000.
  - Reported on the author's voice: **FRR 0.0155 (about 98.5% detection) and 0.187 false positives per hour**, matching or beating the author's earlier 314-recording model.
  - It is a beta with no third-party results yet.
  
  — [HA forum: SEED](https://community.home-assistant.io/t/seed-train-a-custom-wake-word-from-just-a-handful-of-recordings-not-hundreds/1018736)
- Target metrics and how to measure them:
  - openWakeWord targets <5% FRR and <0.5 FA/h. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
  - livekit-wakeword's default target is 0.1 FPPH. — [livekit-wakeword GitHub](https://github.com/livekit/livekit-wakeword)
  - Picovoice (vendor) recommends reporting FRR at 1 false activation per hour, measuring FAR on **at least 10 h** of audio, and treating SNR below 20 dB as noisy (25–30 dB is good). — [Picovoice blog (Oct 2025, upd. Jan 2026)](https://picovoice.ai/blog/wake-word-benchmarks/)
  - Apple described Hey Siri false-alarm targets as low as "one per week". — [Apple ML Research 2017](https://machinelearning.apple.com/research/hey-siri)
- microWakeWord's FAH estimate is generated with the same augmentation as training, so it is "not a perfect estimate" of real-room performance. — [microWakeWord GitHub](https://github.com/OHF-Voice/micro-wake-word)

### Inferences
- **Concrete recipe for "Hey ARES":**
  1. Positives: 5–20k TTS clips of "hey ARES" and the bare word "ARES". Use Piper English voices plus VoxCPM2 voices from many languages to add accent variety, and phonetic spellings such as "hey air-eez" or "hey ah-rays" through the TTS-only pronunciation hint. Filter positives with an ASR intelligibility check as hey-claude did. Add **20–50 of the owner's real takes**, which SEED-style vocoder expansion can multiply.
  2. Adversarial negatives: phrases ARES's transcripts already confuse ("Aries", "Harris", "Paris", "heiress", "a res", "erase", "Eris", "arrows", "hey there", "here's", "ears"), plus ARES's own TTS voices saying sentences that contain "Ares".
  3. Generic negatives: openWakeWord's roughly 4 GB feature set, plus several hours of the owner's real room audio (TV, music, calls, typing).
  4. Validate on at least 10 h of real room audio and the owner's held-out takes. Aim for at most 0.1–0.2 FA/h at 2–5% FRR, then set the threshold from the DET curve.
- Building on the livekit-wakeword pipeline, or openWakeWord's Colab under Python 3.11, should take about 1–2 hours on the owner's Mac or a cloud GPU. The hey-claude run shows an M2 MacBook Air is enough.
- Because generic TTS voices are mostly native-accented, the owner's own recordings are the main lever for accent robustness. They should be in both the training positives and the validation set; the validation set matters most.
- A model trained with the owner's samples plus a speaker-verification gate (ARES already has a voiceprint) turns the problem into a personalised, text-dependent detector. This is the same structure Apple uses.

### Gaps
- No published study quantifies how much adding N real owner recordings improves FRR for an accented speaker over a synthetic-only model. SEED's single-user result is the only data point found.
- No benchmark was found of VoxCPM2-generated non-native English (as opposed to native-language speech) for wake-word training.
- openWakeWord's README documents negative data volume but not a recommended RIR set. Specific RIR/noise corpora (e.g. MIT RIR, MUSAN, FSD50K) were not confirmed from primary docs in this pass.

## Q3. Why does transcript-based wake detection fail, and what are best-practice architectures (multi-stage, personalised wake words, Hey Siri, Alexa, wake words while the assistant speaks)?

### Takeaway
A general ASR is optimised to output the *most likely word sequence*, not to detect one phrase. Its language model prior pulls a rare name toward common words, and it gives no calibrated false-accept/false-reject knob. Production assistants (Siri, Alexa) instead use a tiny always-on acoustic detector tuned for high recall, then one or more heavier verifiers on the candidate window, then a speaker check, then false-trigger mitigation on the whole utterance. Self-triggering during playback is handled with echo cancellation plus gating and threshold changes while the assistant is talking.

### Cited Findings

#### Evidence that general ASR struggles with rare names
- OpenAI's own prompting guide warns that Whisper can garble unusual brand, company and personal names. — [OpenAI Whisper prompting guide](https://developers.openai.com/cookbook/examples/whisper_prompting_guide)
- FluidAudio needed a *separate* CTC keyword spotter alongside Parakeet TDT to recover domain terms (reported 99.3% precision / 85.2% recall with the spotter, vendor figures). — [FluidAudio custom vocabulary](https://docs.fluidinference.com/asr/custom-vocabulary); [FluidAudio benchmarks](https://docs.fluidinference.com/reference/benchmarks)
- The legacy `SFSpeechRecognizer` scored **9.02% WER on LibriSpeech test-clean versus 2.12% for SpeechAnalyzer** on an M2 Pro with forced on-device recognition. ARES's current recogniser is the weakest engine in that test. — [Lyonesse/Inscribe benchmark, July 2026](https://lyonesse.app/blog/apple-speech-api-benchmark.html)
- sherpa-onnx's KWS avoids the LM-prior problem by design: the model "can only decode words/phrases in the given keywords". — [sherpa-onnx KWS docs](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)

#### Apple "Hey Siri" (2017 design)
- Two passes:
  - A small DNN (5 hidden layers × 32 units) on the always-on coprocessor.
  - Above a threshold, the main processor runs a larger DNN (5 × 192).
  
  Input is 16 kHz, with about 100 frames/s; about 20 frames (0.2 s) go into the DNN at a time, and the output has about 20 sound classes. — [Apple ML Research, Oct 2017](https://machinelearning.apple.com/research/hey-siri)
- **Two thresholds:** a score between the primary and lower threshold opens a few-second "more sensitive state", so a *repeated* attempt triggers. The server-side recogniser can cancel a false start (e.g. "Hey Seriously"). Speaker personalisation uses 5 enrolment phrases mapped into a "speaker space". — [Apple ML Research, Oct 2017](https://machinelearning.apple.com/research/hey-siri)

#### Apple voice trigger system (2023 design)
- Stages:
  - **Stage 1:** a low-power, high-recall DNN-HMM keyword spotter on the always-on processor (23 output states, 4-bit weights).
  - **Stage 2:** a high-precision Conformer re-scores candidates, trained with CTC loss plus a phrase-specific discriminative output.
  - **Speaker ID:** runs on the trigger phrase alone, and again on the full utterance.
  - **False-trigger mitigation:** an ASR-lattice RNN, an acoustic streaming transformer, and a BERT-like text classifier that detects out-of-domain speech and **non-vocative uses of "Siri"**.
  
  Enrolment is 5 phrases. Speaker embeddings are trained with a SphereFace2-style loss. The shorter "Siri" (without "Hey") is described as harder to support. — [Apple ML Research, Aug 2023](https://machinelearning.apple.com/research/voice-trigger)

#### Amazon Alexa
- The device detects "Alexa" locally, then the audio is **re-verified in the cloud**. A failed check sends a stop-capture directive. Typical false wakes come from "Alex", "election", "Alexis" and TV mentions. — [Amazon AVS: cloud wake word verification](https://developer.amazon.com/docs/alexa-voice-service/enable-cloud-based-wake-word-verification.html)
- At launch, critics noted Amazon published no proof that the cloud check improved precision. — [VentureBeat](https://venturebeat.com/ai/following-snl-parody-amazon-adds-cloud-verification-of-alexa-wake-word)
- On-device two-stage research (2018): a second-stage classifier cut the false-alarm rate by about two-thirds relative to the first stage. A new background model gave about 37% relative false-alarm reduction at the same miss rate. — [Amazon Science: two-stage on-device wake word](https://www.amazon.science/publications/monophone-based-background-modeling-for-two-stage-on-device-wake-word-detection)
- Cloud-side word-level wake-word verification (the CRA model, Interspeech) beat earlier two-stage DNN-HMM verifiers. — [Amazon Science: wakeword verification network](https://www.amazon.science/publications/building-a-robust-word-level-wakeword-verification-network); [Amazon Science blog](https://www.amazon.science/blog/amazon-alexas-new-wake-word-research-at-interspeech)

#### Personalised / user-defined KWS research
- A 2026 paper notes that text-driven user-defined KWS handles new keywords without retraining. But training for text invariance erodes speaker information, so such systems cannot reject bystanders or playback that repeats the phrase. It adds text-independent speaker verification. — [arXiv 2606.20106](https://arxiv.org/pdf/2606.20106)
- Earlier work compares speaker-embedding types and enrolment simulation for personalised KWS, and finds pre-enrolled utterances the better production fit. — [arXiv 2311.03419](https://arxiv.org/pdf/2311.03419)
- Samsung's Interspeech 2025 open-vocabulary KWS uses adversarial deep metric learning to align audio and text. — [Samsung Research](https://research.samsung.com/blog/-INTERSPEECH-2025-Adversarial-Deep-Metric-Learning-for-Cross-Modal-Audio-Text-Alignment-in-Open-Vocabulary-Keyword-Spotting)
- openWakeWord's custom verifier models are a lightweight version of the same personalised second stage. — [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)

#### Wake words while the assistant is speaking (self-trigger, barge-in)
- Self-triggering happens when echo that survives cancellation still sounds like the wake word. At barge-in the user's voice can be more than 10 dB below the echo, so an echo canceller is essentially required before the KWS. Because KWS models dislike nonlinear distortion, implementations lean on the linear adaptive filter and need a deliberate double-talk policy. — [VOCAL: AEC for barge-in](https://vocal.com/echo-cancellation/aec-barge-in/)
- Patented mitigations:
  - Gating wake hits on double-talk detection.
  - Running a second recogniser on the *outgoing* audio and discarding a simultaneous mic-side match when the playback contains the wake word (Sensory, US 11,004,453, May 2021).
  - Direction cues (self-generated wake words arrive from many directions).
  - Raising the KWS threshold while the loudspeaker signal is above a level.
  
  — [US 11,004,453 (Sensory)](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11004453); [US 9,747,899 (Amazon)](https://patents.google.com/patent/US9747899); [US 9,026,438 barge-in](https://patents.google.com/patent/US9026438B2)
- Pitfalls: undersized, slow or reset echo models leave wake-like residue; over-suppression erases the user, and under-suppression lets self-speech through; moving the device undoes convergence. — [Zimaspace blog](https://shop.zimaspace.com/blogs/tech-ai-hub/local-voice-assistant-interrupts-itself-reverberant-room)

### Inferences
- **Why ARES's current approach fails, specifically.** The listener matches `(?:ares|aries|arras|arris|aris|arez|eris)` in an en-GB `SFSpeechRecognizer` transcript, with `contextualStrings = ["Ares","Hey Ares"]` ([AresListener.swift](file:///Users/dhruv/My%20AI/native/AresListener.swift), lines 148–164 and 600–602). The recogniser must first commit to *some* word. Its language model prefers frequent words ("Harris", "a res"), contextual strings are only a soft bias, and the model is the weakest of the tested engines (9% WER on clean read speech, likely worse for an accented speaker). Widening the regex raises false accepts from ordinary speech and TV, and there is no threshold to tune. Shouting raises SNR enough to push the ASR toward the right word, which matches the owner's experience.
- **Recommended ARES architecture, a four-stage cascade modelled on Siri:**
  1. **Stage 1, always on:** livekit-/openWakeWord ONNX "hey ARES" model on 80 ms frames, threshold set for high recall (FRR ≤ 2%). Add Apple's two-threshold "more sensitive state": a near-miss lowers the threshold for about 3 s, so a normal-volume repeat works without shouting.
  2. **Stage 2, on the about 1.5 s candidate window:** sherpa-onnx KWS restricted to "HEY ARES" with tuned boost/threshold, and/or a fast ASR pass (Parakeet/SpeechTranscriber) with fuzzy phonetic matching. Reject if both disagree.
  3. **Stage 3, speaker:** ARES's existing voiceprint, or an openWakeWord custom verifier, on the trigger audio.
  4. **Stage 4, utterance-level false-trigger mitigation:** a cheap text check (local classifier or the brain) for non-vocative mentions ("I was reading about Ares…"), like Apple's BERT-style filter.
- **Self-trigger while ARES talks.** ARES already enables voice processing on its input node ([AresListener.swift](file:///Users/dhruv/My%20AI/native/AresListener.swift), line 345). In addition:
  - Raise the stage-1 threshold while TTS is playing.
  - Discard detections that line up in time with ARES's *own* scheduled utterance of "Ares". ARES knows its TTS text and word timings: comms.js already sends per-word caption schedules. This is a much simpler version of the "second recogniser on outgoing audio" patent.
  - Require the speaker check for barge-in.
- Keep "Hey ARES" (two words) as the main trigger. Accept bare "ARES" only at a stricter threshold or as a follow-up within a conversation, because Apple reports the bare one-word trigger is harder.

### Gaps
- No public Siri or Alexa FAR/FRR numbers were found. The Apple posts give designs, not rates.
- No source was retrieved that quantifies how much residual echo Apple's macOS voice-processing input leaves for a downstream KWS model during loud TTS. This needs measuring in ARES.
- No peer-reviewed study directly measures "ASR-transcript regex" wake detection against a dedicated KWS on rare names. The failure explanation above is inferred from component evidence.

## Q4. Which on-device ASR options give the best accuracy and speed on Apple Silicon (SpeechAnalyzer/SpeechTranscriber vs SFSpeechRecognizer, Whisper variants, Parakeet/Canary, Moonshine, Kyutai, Voxtral, others)?

### Takeaway
On macOS 26 the two strongest free on-device choices are:
- **Apple SpeechTranscriber (SpeechAnalyzer)**: about 2.1% / 4.6% WER on LibriSpeech clean/other, much better than legacy `SFSpeechRecognizer` at about 9% / 16%. It runs out-of-process on the ANE with zero app memory, but has no custom vocabulary and covers few locales.
- **NVIDIA Parakeet TDT 0.6B v2 (English) / v3 (25 European languages) via FluidAudio (Core ML)**: about 2.1–2.5% on LibriSpeech clean at roughly 145–210× real time on an M4 Pro, plus custom-vocabulary boosting in batch mode.

Whisper (large-v3-turbo through WhisperKit/whisper.cpp) is now slower and less accurate than Parakeet for English but covers about 100 languages. Moonshine v2, Kyutai STT, Voxtral Realtime and Nemotron streaming are the newer *streaming* contenders. Leaderboard leaders (Cohere Transcribe, Granite Speech, Canary-Qwen) are larger LLM-decoder models aimed at GPUs.

### Cited Findings

#### Apple SpeechAnalyzer / SpeechTranscriber (WWDC 2025; macOS 26+)
- The new model targets long-form, conversational and distant-mic audio and low-latency live transcription. It runs on device, and "operates outside of your application's memory space" with no increase in app size or run-time memory. Models are installed and updated through `AssetInventory`, and apps are limited in how many languages they hold at once. — [WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/)
- Results are final-only by default. Opt-in `.volatileResults` give fast provisional text that is later replaced, and `finalizeAndFinishThroughEndOfInput()` flushes at the end. — [WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/)
- `SpeechTranscriber` is available on macOS 26.0+. Check `isAvailable`/`supportedLocales` and fall back to `DictationTranscriber` if unsupported. — [Apple docs: SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber)
- `DictationTranscriber` uses the same models as on-device `SFSpeechRecognizer`/system dictation, and does not support network-only locales. — [Apple docs: DictationTranscriber](https://developer.apple.com/documentation/speech/dictationtranscriber)
- **Lyonesse/Inscribe benchmark (13 July 2026):** LibriSpeech, 5,559 utterances; M2 Pro 32 GB; macOS 26.5.1; forced on-device; WhisperKit Core ML quantized builds. Throughput was 12–40× real time across engines, with SpeechAnalyzer about 3× faster than Whisper Small. Timing was noisy because the machine was shared, and the test was English read speech only, with accents and far-field untested.

  | Engine | test-clean WER | test-other WER | Model size |
  |---|---|---|---|
  | SpeechAnalyzer | 2.12% | 4.56% | system |
  | Whisper Small | 3.74% | 7.95% | ~460 MB |
  | Whisper Base | 5.42% | 12.51% | ~140 MB |
  | Whisper Tiny | 7.88% | 17.04% | ~40 MB |
  | SFSpeechRecognizer (legacy) | 9.02% | 16.25% | system |

  As of version 1.8.9 the app retired Whisper and made Parakeet its fallback. — [Lyonesse benchmark](https://lyonesse.app/blog/apple-speech-api-benchmark.html)
- **Argmax (20 June 2025, macOS 26 beta 1, Mac mini M4, earnings-call audio, about 12 h):** Argmax concluded Apple is "on par with mid-tier Whisper". Listed limitations: no custom vocabulary (legacy SFSpeechRecognizer has it and beat the new API on keyword accuracy), 10 languages versus about 100, a model download is required, ANE+CPU compute is hardcoded, and there is no diarization.

  | System | WER | Speed |
  |---|---|---|
  | WhisperKit base.en | 15.2% | 111× |
  | SpeechTranscriber | 14.0% | 70× |
  | WhisperKit small.en | 12.8% | 35× |
  | Parakeet v2 (Argmax Pro) | 11.7% | 359× |

  — [Argmax: Apple and Argmax](https://www.argmaxinc.com/blog/apple-and-argmax)
- MacStories (June 2025): the SpeechAnalyzer-based Yap CLI transcribed a 34-min video in 45 s, versus 1 min 41 s for Whisper large-v3 (speed only). — [GIGAZINE summary](https://www.gigazine.net/gsc_news/en/20250619-apple-speech-analyzer)

#### Hugging Face Open ASR Leaderboard
- Source: the leaderboard paper, arXiv 2510.06961 v4, 30 March 2026, with leaderboard counts as of 27 March 2026. Figures are short-form English average WER and RTFx (higher is faster):
  - Cohere Transcribe 5.42% (RTFx 525)
  - Granite Speech 4.0 1B 5.52% (280)
  - Canary-Qwen 2.5B 5.63% (418)
  - Qwen3-ASR 1.7B 5.76% (148)
  - Granite 3.3 8B 5.76% (145)
  - Granite 3.3 2B 6.00% (271)
  - **Parakeet TDT 0.6B v2 6.05% (3390)**
  - **Parakeet TDT 0.6B v3 6.32% (3330)**
  - Canary 1B 6.50% (235)
  - Voxtral Small 24B 6.62% (54)
  - Distil-Whisper large-v3.5 7.21% (202)
  - Whisper large-v3 7.44% (146)
  - **Whisper large-v3-turbo 7.83% (200)**
  - Proprietary: ElevenLabs Scribe v2 5.83%, Zoom Scribe v1 5.47%, AssemblyAI Universal 3 Pro 6.21%, Speechmatics Enhanced 6.91%
  - Long-form: Scribe v2 7.32%, AssemblyAI 8.34%, Speechmatics 8.80%, Cohere 9.73%, Parakeet v3 10.7%, Whisper turbo 11.0%
  
  The paper says CTC/TDT decoders give much better RTFx at a modest accuracy cost. — [Open ASR Leaderboard paper](https://arxiv.org/html/2510.06961v4)
- Later snapshots conflict: a May 2026 listing put IBM Granite Speech 4.1 2B first at 5.33%, while an aggregate with data to 3 September 2026 lists Cohere Transcribe first at 5.42%. — [benchmarklist](https://benchmarklist.com/benchmarks/open_asr_leaderboard/); [keenable aggregate](https://select.keenable.ai/r/speech-recognition-accuracy-leaders-2022-2026/JbURQjlVooLQ6J10NkbRVw)

#### NVIDIA Parakeet TDT and FluidAudio (Core ML)
- Parakeet TDT 0.6B v3 model card:
  - Licence CC BY 4.0 (commercial use OK); 600M parameters.
  - 25 European languages with automatic language detection.
  - LibriSpeech 1.93% / 3.59%; leaderboard average 6.34% (metadata says 6.32); FLEURS average 11.97%.
  - Word/segment/char timestamps; up to 24 min with full attention, or 3 h with local attention.
  - Released 14 August 2025.
  
  — [HF: nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- **FluidAudio benchmarks** (2024 MacBook Pro M4 Pro, 48 GB, macOS 26.0):
  - TDT v3 LibriSpeech test-clean: **2.5% WER at 155.6× RTFx**
  - TDT v2: **2.1% at 145.8×** ("v2 has lower English WER — use it if you only need English")
  - TDT v3 FLEURS 25 languages: 14.7% average at 209.8×; English (US) FLEURS 5.4% at 207.4×
  - **Streaming Parakeet EOU** (on an M2): 320 ms chunks give 4.87% WER at 12.48× (the recommended default); 160 ms chunks give 8.29% at 4.78×
  - Custom vocabulary on Earnings22: 15.0% WER, 99.3% vocabulary precision, 85.2% recall, 63.4×
  - Encoder load on iPhone 16 Pro Max: 3,361 ms cold, 162 ms warm
  - Silero VAD v6 is bundled
  
  — [FluidAudio benchmarks](https://docs.fluidinference.com/reference/benchmarks)
- The FluidAudio model card cites about 110× real time on an M4 Pro for batch, and the CocoaPods page says streaming is "pending" and recommends batch for production. Both conflict with the newer docs' EOU streaming and 210× figures, so they are probably stale. — [HF: FluidInference parakeet-tdt-0.6b-v3-coreml](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml); [CocoaPods FluidAudio](https://cocoapods.org/pods/FluidAudio)
- Independent and vendor-adjacent Mac comparisons:
  - A vendor app measured a 35-min file at about 3 min for Whisper large-v3-turbo versus 18 s for Parakeet v3. — [WhisperNotes blog](https://whispernotes.app/blog/parakeet-v3-default-mac-model)
  - A one-clip GitHub test gave parakeet-mlx about 0.50 versus mlx-whisper turbo about 1.02 (units unclear). — [mac-whisper-speedtest](https://github.com/anvanvan/mac-whisper-speedtest)
  - Superwhisper (an Argmax customer) reports Parakeet v3 through Argmax ParakeetKit with a 0.07 s wait-for-text on M4 (10.7% WER, 8-dataset average). — [Superwhisper benchmark](https://superwhisper.com/benchmarks/parakeet-v3)
  - soniqo reports a Core ML INT8 Parakeet at about 32× real time on the ANE. — [soniqo Parakeet guide](https://soniqo.audio/guides/parakeet)

#### Whisper family (WhisperKit / Argmax, whisper.cpp, MLX)
- Argmax's open-source SDK reached **v1.0.0 on 1 May 2026, renamed `argmax-oss-swift`** (WhisperKit, SpeakerKit, TTSKit); Parakeet support is in the commercial Pro SDK. — [Swift Package Registry: argmax-oss-swift](https://swiftpackageregistry.com/argmaxinc/argmax-oss-swift); [Argmax: NVIDIA models on Argmax SDK](https://www.argmaxinc.com/blog/nvidia-frontier-speech-models-on-argmax-sdk)
- WhisperKit paper (ICML 2025): about 0.46 s latency and 2.2% WER for on-device streaming, among the lowest-latency systems tested. — [arXiv 2507.10860](https://arxiv.org/abs/2507.10860)
- Argmax Pro SDK claims 160 ms "lips-to-screen" real-time latency (July 2025, vendor). — [Argmax Pro SDK GA](https://www.argmaxinc.com/blog/pro-sdk-ga)
- Argmax's benchmark space (October 2024) logged large-v3-turbo at a 3.77× speed factor on M2 Pro and 4.41× on M3 Max, end to end. A third-party run reports about 12× real time for WhisperKit turbo. — [WhisperKit benchmarks space](https://huggingface.co/spaces/argmaxinc/whisperkit-benchmarks); [soniqo: Qwen3-ASR vs Whisper](https://soniqo.audio/de/benchmarks/qwen3-asr-vs-whisper)
- On short-form English the leaderboard has Whisper large-v3-turbo (7.83%) behind Parakeet v2 (6.05%), and Distil-Whisper large-v3.5 at 7.21%. — [Open ASR Leaderboard paper](https://arxiv.org/html/2510.06961v4)

#### Moonshine v2 (streaming, English)
- arXiv 2602.12241 (12 February 2026): an "ergodic" streaming encoder with sliding-window attention, so first-token latency doesn't grow with utterance length. Model sizes are tiny 34M, small 123M and medium 245M. Average Open-ASR WER is 12.01%, 7.84% and 6.65% respectively, with medium at 10.68% on AMI and 11.90% on Earnings-22. — [arXiv 2602.12241](https://arxiv.org/pdf/2602.12241); [HF: moonshine-streaming-tiny](https://huggingface.co/moonshine-ai/moonshine-streaming-tiny)
- Vendor latency on a MacBook Pro: medium 107 ms, small 73 ms, tiny 34 ms, versus about 11.3 s for Whisper large-v3. On a Raspberry Pi 5: 802 / 527 / 237 ms. — [Moonshine docs (Mintlify)](https://www.mintlify.com/moonshine-ai/moonshine)
- The GGUF conversions are English-only. Known failure modes are invented words and repeated phrases on short or noisy input. — [moonshine-streaming-medium GGUF](https://huggingface.co/handy-computer/moonshine-streaming-medium-gguf)

#### Kyutai STT (delayed-streams modelling)
- `stt-1b-en_fr` (English/French) has a 500 ms delay and a built-in semantic VAD. `stt-2.6b-en` (English) has a 2.5 s delay and is tuned for accuracy. The "flush trick" cuts the wait after end of speech to about 125 ms. On a Mac or iPhone, "choose the MLX implementation" (moshi-mlx). The semantic VAD is only in the Rust server. — [Kyutai STT](https://kyutai.org/stt); [delayed-streams-modeling GitHub](https://github.com/kyutai-labs/delayed-streams-modeling)

#### Mistral Voxtral Realtime (open weights)
- Voxtral Mini 4B Realtime 2602 (February 2026): Apache-2.0 weights, 13 languages. The delay is configurable from 80 to 1,200 ms in 80 ms steps, or 2,400 ms. FLEURS average WER is 12.6% at 160 ms, 8.7% at 480 ms, 7.7% at 960 ms and 6.7% at 2,400 ms; English is 4.9% at 480 ms. The API costs $0.006/min. Serving is through vLLM ≥ 0.20.0. — [Mistral: Voxtral Transcribe 2](https://mistral.ai/news/voxtral-transcribe-2); [vLLM recipe](https://recipes.vllm.ai/mistralai/Voxtral-Mini-4B-Realtime-2602); [arXiv 2602.11298](https://arxiv.org/html/2602.11298v2)

#### NVIDIA Nemotron streaming ASR
- `nemotron-speech-streaming-en-0.6b` is a cache-aware streaming model whose chunk can be chosen at inference time: 80, 160, 560 or 1,120 ms. The multilingual Nemotron 3.5 ASR streaming 0.6B covers 40 locales, adds a 320 ms option, and has a 06/04/2026 release date on its card. — [HF: nemotron-speech-streaming-en-0.6b](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b); [HF: nemotron-3.5-asr-streaming-0.6b](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)
- Latency and throughput claims are all GPU-based. NVIDIA's FAQ gives 0.04 s single-stream ASR latency in a blueprint. Daily calls it the lowest-latency STT it has tested. Community ONNX INT4 ports exist. — [NVIDIA FAQ](https://perspectives.nvidia.com/nemotron-speech/task/faq/asr-models-streaming-transcription-real-time-agent-response/); [Daily blog](https://www.daily.co/blog/open-source-multilingual-transcription-from-nvidia-nemotron-3-5-asr/); [ONNX INT4 port](https://huggingface.co/Garnet-Owl/nemo-voice-typing-asr)

### Inferences
- **Biggest single ASR win for ARES:** move command transcription off legacy `SFSpeechRecognizer`. The same Mac class shows roughly 4× fewer errors with SpeechTranscriber (9.02% → 2.12% on clean read speech), and the model runs out-of-process on the ANE, so it adds no memory to ARES's Electron or Swift processes.
- **Suggested ASR stack.** Once the wake word gates listening, there is no need to transcribe the whole room continuously, which also suits desk mode's rule that overheard speech is never logged.
  - **(a) Live captions and partials:** SpeechTranscriber with `.volatileResults`, or FluidAudio's Parakeet EOU at 320 ms (4.87% WER).
  - **(b) Final command text:** after endpointing, re-transcribe the utterance in batch with Parakeet TDT v2 (English) through FluidAudio, with custom-vocabulary boosting for "ARES", contact names and app names. At about 146× RTFx, a 5 s command takes about 35 ms of compute (arithmetic from the M4 Pro figure; older chips are slower).
  - **(c) Fallback:** DictationTranscriber with a custom language model (see Q5).
- Whisper should no longer be ARES's default English engine. It is slower and less accurate than Parakeet on the leaderboard, and dictation apps (Lyonesse, WhisperNotes) have dropped it. Keep it only as a multilingual fallback.
- Moonshine v2 small/medium (73–107 ms on a MacBook Pro, vendor figures) and Kyutai's MLX build are worth a spike if ARES needs faster streaming partials than SpeechTranscriber. Voxtral Realtime (4B) and the leaderboard leaders (1–8B LLM decoders) are probably too heavy to run all the time next to ARES's other models.
- All leaderboard RTFx figures are server-GPU throughput numbers and are not Mac numbers. Mac-specific RTFx comes only from FluidAudio, Argmax and app vendors.

### Gaps
- No primary source gives numeric streaming latency (time to first and final word) for SpeechTranscriber volatile results on a Mac. WWDC is qualitative only.
- The Round 2 Lyonesse benchmark (Parakeet v2/v3 versus SpeechAnalyzer on the same 5,559 utterances) exists, but its numbers were not retrievable from the page fetched.
- No on-Mac numbers were found for whisper.cpp Core ML/Metal, Kyutai MLX latency, Cohere Transcribe, Granite Speech, Canary-Qwen or Nemotron streaming. Licences were also not confirmed for Moonshine v2 and Kyutai STT, and FluidAudio's own licence was not checked.
- No measured RAM figures were found for Parakeet/FluidAudio ASR on macOS.

## Q5. How can accuracy be improved for a non-standard accent and for names (locale, contextual biasing / custom vocabulary, hotwords, Whisper prompts, fine-tuning on the owner's voice)?

### Takeaway
Apple's best accuracy model (SpeechTranscriber) currently gives **no** vocabulary control. Biasing (`contextualStrings`) and true custom language models with **X-SAMPA custom pronunciations** exist only on the older-model path (`SFSpeechRecognizer` iOS 17+ / `DictationTranscriber`). Open-source paths offer stronger levers: FluidAudio's CTC keyword boosting for Parakeet, sherpa-onnx hotwords for transducers, and Whisper prompts (fragile) or LoRA fine-tuning on accented speech (effective). For the owner's accent, the reliable approach is to measure each engine on a personal test set and then personalise: real recordings in the wake-word model, and possibly a LoRA fine-tune.

### Cited Findings
- **Apple, biasing and custom vocabulary in the new framework:**
  - `DictationTranscriber` supports `AnalysisContext.contextualStrings` biasing.
  - It supports **custom vocabulary** via an `SFSpeechLanguageModel` passed with the `customizedLanguage(modelConfiguration:)` content hint.
  - It has algorithm hints such as `farField` for distant speech.
  
  — [Apple docs: DictationTranscriber](https://developer.apple.com/documentation/speech/dictationtranscriber)
- `SpeechTranscriber`'s reference lists only presets and transcription/reporting/attribute options, with no context or custom-model options. — [Apple docs: SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber)
- Developers on Apple's forums report that contextual strings affect only DictationTranscriber, and that SpeechTranscriber ignores them. — [Apple Developer Forums 811083](https://developer.apple.com/forums/thread/811083); [Apple Developer Forums 801877](https://developer.apple.com/forums/thread/801877)
- Argmax likewise says SpeechAnalyzer offers no custom vocabulary, and that legacy SFSpeechRecognizer beat it on keyword accuracy. — [Argmax](https://www.argmaxinc.com/blog/apple-and-argmax)
- **Custom language models (iOS 17+ / macOS equivalent):**
  - Training data is a container built with a result-builder DSL. `PhraseCount` weights phrases, and templates generate many variants.
  - **Custom pronunciations use X-SAMPA** (each locale supports a subset).
  - Data is bound to one locale, and only a limited amount of data is accepted.
  - `prepareCustomLanguageModel` compiles the model, slowly, so run it off the main thread.
  - **Recognition must be on-device or the customisation is ignored.** The data never leaves the device.
  
  — [WWDC23 session 10101](https://developer.apple.com/videos/play/wwdc2023/10101/)
- Locale: SpeechTranscriber launched with about 10 languages. One write-up says English was a single entry with no regional variants, so en-IN is unconfirmed. The full list must be checked at runtime (`supportedLocales`, compared as BCP-47; en_GB vs en-GB mismatches have bitten developers). Listed locales can still fail to download. — [Argmax](https://www.argmaxinc.com/blog/apple-and-argmax); [addpipe blog](https://blog.addpipe.com/apple-speechanalyzer-api/); [Apple Developer Forums 797835](https://developer.apple.com/forums/thread/797835)
- **FluidAudio custom vocabulary:**
  - Parakeet 0.6B TDT transcribes, while a 110M CTC encoder scores keywords frame by frame (both at about 40 ms frames), based on NVIDIA NeMo's CTC word spotter, arXiv 2406.07096.
  - Each term can have **aliases** for misspellings or phonetic variants; output shows the primary spelling.
  - Defaults: minimum spotter score −15.0, minimum vocabulary CTC score −12.0, similarity 0.52, boost weight 3.0.
  - 1–50 terms is rated "excellent".
  - **Batch only:** the streaming EOU path doesn't support it.
  
  — [FluidAudio custom vocabulary](https://docs.fluidinference.com/asr/custom-vocabulary)
- **sherpa-onnx hotwords:** transducer models only, and only with `modified_beam_search` (not greedy). Each line can carry a ` :score` boost, the modelling unit must match the model (bpe/cjkchar), and no retraining is needed. No WER figures are published, only examples. — [sherpa-onnx hotwords docs](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html)
- **Whisper prompts:**
  - A spelling list in the prompt fixed mangled product names in OpenAI's example, but the technique "is not especially dependable". The prompt limit is 244 tokens (cookbook) or about 224 (Spokenly). A GPT post-correction pass with the same list was more reliable. — [OpenAI cookbook: misspellings](https://developers.openai.com/cookbook/examples/whisper_correct_misspelling); [Spokenly docs](https://spokenly.app/docs/whisper-prompting)
  - One developer saw about 4 in 5 runs hallucinate, looping on a competitor name, with a two-sentence prompt. — [OpenAI community](https://community.openai.com/t/whisper-prompt-leads-to-hallucinations/174896)
  - By default the initial prompt only conditions the first 30 s window (`carry_initial_prompt`). — [instagit walkthrough](https://instagit.com/openai/whisper/how-to-use-initial-prompt-condition-on-previous-text)
  - Whisper maintainers suggest fine-tuning when prompts are unreliable for invented names. — [openai/whisper discussion 963](https://github.com/openai/whisper/discussions/963)
- **Fine-tuning for rare words:** training Whisper to follow contextual-biasing instructions on 670 h of Common Voice improved rare words by 45.6% and unseen words by 60.8% relative to baseline. — [arXiv 2502.11572](https://arxiv.org/html/2502.11572v2)
- CB-Whisper runs KWS on the encoder states and feeds detected entities to the decoder as prompts. This raised entity recall, and running KWS as a separate module avoided catastrophic forgetting. — [arXiv 2309.09552](https://arxiv.org/html/2309.09552v3)
- **Accents:** Whisper's accuracy weakens for non-native speakers. MAS-LoRA (Interspeech 2025) uses mixed accent-specific LoRA experts on Whisper-small (rank 16, α=1, LR 5e-5) and beat plain LoRA and full fine-tuning on L2-ARCTIC with less forgetting. — [arXiv 2505.20006](https://arxiv.org/abs/2505.20006v1)
- LoRA keeps L2 adaptation affordable and limits drift from the pretrained weights. — [arXiv 2510.10738](https://arxiv.org/pdf/2510.10738)
- **Wake-word accent coverage:** Piper TTS output is English-accented. VoxCPM2 in livekit-wakeword covers 30 languages. SEED builds a model from 5–9 of the user's own takes. — [openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026); [livekit-wakeword GitHub](https://github.com/livekit/livekit-wakeword); [HA forum: SEED](https://community.home-assistant.io/t/seed-train-a-custom-wake-word-from-just-a-handful-of-recordings-not-hundreds/1018736)

### Inferences
- **Quick win for ARES's current code:** add an `SFSpeechLanguageModel` custom model to the existing `SFSpeechRecognizer` request, or to a `DictationTranscriber` fallback. It would contain `PhraseCount`-weighted "Hey Ares …" command templates and an **X-SAMPA pronunciation of "Ares" as the owner actually says it**. Recognition already uses `requiresOnDeviceRecognition` when supported, which customisation requires. This is far stronger than the two `contextualStrings` ARES uses today.
- For the main engine, don't rely on the ASR to spell "ARES". Let the dedicated wake-word model decide "was I addressed", then normalise names in the text afterwards: fuzzy-match against a small lexicon (ARES, Katherine, contacts, app names), use FluidAudio vocabulary aliases (e.g. "Aries", "Harris" → "ARES"), or let the brain correct it.
- **Locale test plan for the owner's accent:**
  1. Record 50–100 real commands at normal volume, at desk and across the room.
  2. Compute WER and name-accuracy for SpeechTranscriber in each available English locale (en-GB, en-US, and en-IN if listed), DictationTranscriber with a custom LM, Parakeet v2 and v3, and Whisper large-v3-turbo.
  3. Pick per-locale defaults from the data, not by assumption.
- If accuracy is still poor after that, a LoRA fine-tune on 30–60 minutes of the owner's speech is the documented path. That could be Whisper-small/turbo with MAS-LoRA-style settings, or a NeMo fine-tune of Parakeet. Track general WER for forgetting.

### Gaps
- No primary Apple source was found stating whether SpeechTranscriber will gain contextual strings or custom models, or listing its exact English regional locales on macOS 26.
- No benchmark was found comparing SpeechTranscriber, Parakeet and Whisper specifically on Indian, African or other non-US/UK English accents.
- No documented procedure was found for fine-tuning Parakeet TDT on a few hours of one speaker's data, or the gains to expect. NeMo supports fine-tuning generally, but this was not sourced here.
- How much an `SFSpeechLanguageModel` with an X-SAMPA pronunciation improves recognition of a single rare name is unquantified; WWDC gives no numbers.

## Q6. How do cloud STT services compare (Deepgram, AssemblyAI, ElevenLabs Scribe v2 Realtime, OpenAI, Google Chirp, Speechmatics) on latency, accuracy and price?

### Takeaway
Cloud streaming STT now costs about **$0.15–$1.02 per audio hour**, with typical first-word or end-of-turn latencies of about 150–300 ms (vendor claims). On published accuracy, ElevenLabs Scribe v2 and AssemblyAI Universal-3 Pro lead the proprietary field, especially on long-form audio. For ARES, cloud STT makes sense only as an opt-in, post-wake-word fallback, because streaming an always-on mic to the cloud conflicts with privacy goals and costs more than on-device processing.

### Cited Findings

#### Deepgram (Nova-3, Flux)
- Pricing (third-party trackers, pricing dates late May to early September 2026):

  | Model | Pay-as-you-go | Growth plan | Regular / list |
  |---|---|---|---|
  | Nova-3 monolingual, streaming | $0.0048/min (promo) | $0.0042/min | $0.0077/min |
  | Nova-3 multilingual | $0.0058/min | – | $0.0092/min |
  | Flux English | $0.0065/min | $0.0057/min | $0.0077/min |
  | Flux multilingual | $0.0078/min | $0.0068/min | – |

  Billing is per second, per channel. The Growth plan needs about a $4,000 prepaid commitment. — [HappyRobot](https://www.happyrobot.ai/hub/deepgram-pricing); [Flexprice](https://flexprice.io/pricing-index/deepgram); [UsagePricing](https://usagepricing.com/blueprint/deepgram)
- Costbench instead lists $0.0077 PAYG for both Flux and Nova-3, so sources conflict. — [Costbench](https://www.costbench.com/software/ai-transcription-apis/deepgram/)
- **Flux** is speech recognition with built-in turn detection, launched October 2025. End-of-turn detection is about 260 ms per Deepgram. — [BusinessWire launch](https://www.businesswire.com/news/home/20251002758871/en/Deepgram-Launches-Flux---The-Worlds-First-Conversational-Speech-Recognition-Model); [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart)
- Together AI reports a median below 300 ms but **p95 of 1.5 s**. — [Together AI: Flux](https://together.ai/models/flux)
- Eager end-of-turn adds 50–70% more LLM calls. Telnyx saw about 150 ms median and about 350 ms tail savings. — [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart); [Telnyx release note](https://telnyx.com/release-notes/automatic-eager-end-of-turn-deepgram-flux)

#### AssemblyAI
- Universal-Streaming Multilingual costs $0.15/h and Universal-3.5 Pro Realtime $0.45/h (July–August 2026). There are 333 free streaming hours. No published streaming-latency figure was found. — [UsagePricing (July 2026)](https://usagepricing.com/blueprint/activity/assemblyai-2026-07-23-launch); [AssemblyAI blog](https://assemblyai.com/blog/speech-to-text-api-pricing); [DailyAIFixs](https://dailyaifixs.com/blog/assemblyai-pricing-2026-the-per-hour-truth)
- Universal 3 Pro scores 6.21% short-form and 8.34% long-form on the Open ASR Leaderboard. — [Open ASR Leaderboard paper](https://arxiv.org/html/2510.06961v4)

#### ElevenLabs Scribe v2 / Scribe v2 Realtime
- Realtime costs **$0.39/h**, batch Scribe v1/v2 $0.22/h, and annual Business plans from $0.28/h. Latency is about 150 ms on several ElevenLabs pages, though the product page claims sub-100 ms. — [ElevenLabs API pricing](https://elevenlabs.io/pricing/api); [ElevenLabs Realtime STT](https://elevenlabs.io/realtime-speech-to-text)
- Scribe v2 scores 5.83% short-form and **7.32% long-form, the best long-form result in the leaderboard paper**. — [Open ASR Leaderboard paper](https://arxiv.org/html/2510.06961v4)

#### OpenAI
- `gpt-realtime-whisper` costs **$0.017/min** (about $1.02/h), billed by audio length, with streaming transcription sessions. — [OpenAI model docs](https://developers.openai.com/api/docs/models/gpt-realtime-whisper)
- `gpt-4o-transcribe` is about $0.006/min and `gpt-4o-mini-transcribe` about $0.003/min. These are token-billing estimates from aggregators. — [CostGoat](https://costgoat.com/pricing/openai-transcription); [Perkstack tracker](https://perkstack.co/blog/cheapest-gpt-4o-transcribe-api)

#### Google Chirp 3
- Third-party trackers list about **$0.016/min** for standard (real-time) recognition. Google's V2 table shows Chirp dynamic batch at $0.003/min. A Chirp 3 docs snapshot lists StreamingRecognize as supported on the V2 API. — [CostBench](https://costbench.com/software/ai-transcription-apis/google-speech-to-text); [Google STT pricing](https://cloud.google.com/speech-to-text/pricing/); [Chirp 3 docs](https://cloud.google.com/speech-to-text/v2/docs/chirp_3-model)

#### Speechmatics
- Pro real-time costs $0.24/h standard and **$0.43/h enhanced** (cut from $0.56 in July 2026). The free allowance is about 50 h/month including 20 h real-time, though sources conflict. — [UsagePricing (July 2026)](https://usagepricing.com/blueprint/activity/speechmatics-2026-07-06-realtime-stt-price-cut); [Speechmatics pricing](https://www.speechmatics.com/our-technology/pricing); [Costbench](https://costbench.com/software/ai-transcription-apis/speechmatics/)
- Enhanced scores 6.91% short-form and 8.80% long-form on the leaderboard. — [Open ASR Leaderboard paper](https://arxiv.org/html/2510.06961v4)

#### Others
- Mistral Voxtral Realtime API costs $0.006/min. — [Mistral](https://mistral.ai/news/voxtral-transcribe-2)
- Together AI hosts Nemotron streaming with claimed sub-100 ms time-to-final. — [Together AI: Nemotron](https://www.together.ai/models/nemotron-3-asr-streaming-0-6b)

### Inferences
- **Cost at ARES scale.** Assume about 1 h/day of *post-wake* speech, so about 30 h/month (arithmetic from the rates above):

  | Service | Approx. monthly cost |
  |---|---|
  | AssemblyAI Universal-Streaming | ~$4.50 |
  | Speechmatics standard | ~$7.20 |
  | Deepgram Nova-3 (promo) | ~$8.64 (about $13.86 at list) |
  | ElevenLabs Scribe v2 Realtime | ~$11.70 |
  | Google Chirp 3 | ~$28.80 |
  | OpenAI gpt-realtime-whisper | ~$30.60 |

  Streaming an always-on mic 24/7 (about 720 h/month) would multiply these by about 24 and send overheard speech off the Mac. That contradicts ARES's rule that overheard speech is never logged or sent anywhere.
- **Accuracy vs on-device.** Cloud leaders are roughly 0.5–1 WER points better than Parakeet on short-form English, and clearly better on long-form. For short commands, on-device Parakeet or SpeechTranscriber should be close enough. A cloud fallback is most useful for long dictation, noisy or far-field audio, or when the on-device confidence is low.
- **If a cloud fallback is wanted:**
  - ElevenLabs Scribe v2 Realtime is the natural candidate, since ARES already has an ElevenLabs account for the Katherine voice. Per ARES's project rules, it must never be exercised in loops during testing; use a mock or an invalid key.
  - Deepgram Flux is the candidate if built-in end-of-turn detection is wanted, but its p95 of 1.5 s should be checked.
  - Keep the wake-word decision on-device in all cases.

### Gaps
- All cloud latency numbers are vendor-reported or from hosting partners, and no independent 2026 streaming-latency benchmark covering these services was retrieved. (Daily's Pipecat STT benchmark exists, but its chart was not readable as text.)
- Pricing pages are volatile: several Deepgram, AssemblyAI and Speechmatics rates come from third-party trackers and conflict with each other, and official Deepgram/OpenAI pricing pages were not fetched directly.
- No source compared cloud services on accented English for proper names (e.g. keyterm prompting in Deepgram Nova-3 or AssemblyAI). Vocabulary-boosting features of the cloud APIs were not researched in depth.
