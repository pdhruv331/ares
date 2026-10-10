# Speaker verification ("voice ID") for a personal voice assistant (ARES)

Notes compiled 2026-10-08. "(search summary)" marks facts taken from a search-engine summary of the linked page rather than from a page I opened myself; the session's shared web-search budget ran out before every such item could be opened. "Local" sources are ARES's own code and logs on this Mac (scores only, never audio).

## 1. Which speaker-embedding models are state of the art (2023–2026), how accurate and big are they, and which run on-device on Apple Silicon?

### Takeaway
ARES's current model, NeMo TitaNet-small (6.4M params, 1.15% EER on VoxCeleb1-O), is the weakest of the modern options. Drop-in replacements already in the sherpa-onnx model release (WeSpeaker ResNet293-LM 0.53%, ResNet221-LM 0.58%, CAM++-LM 0.71%, TitaNet-L 0.66–0.68%) cut benchmark EER by about 40–55% with no new runtime. The 2024–2026 frontier is ReDimNet/ReDimNet2, ECAPA2, SimAM-ResNet on VoxBlink2, and WavLM / w2v-BERT 2.0 self-supervised verifiers, at 0.12–0.4% EER. Those models mostly ship as PyTorch checkpoints that need ONNX or Core ML conversion, and the SSL ones are around 600M parameters. VoxCeleb EER is measured on long trials, so it understates how hard 1–2 s echo-cancelled desk clips are.

### Cited Findings

**Benchmarks (VoxCeleb1 EER %, cosine scoring unless noted)**
- TitaNet paper, Table 2 (VoxCeleb1 cleaned trial list, cosine scoring):

  | Model | Params | EER | minDCF |
  |---|---|---|---|
  | x-vector (PLDA) | 9M | 2.97% | 0.323 |
  | ECAPA | 22.3M | 0.69% | 0.082 |
  | TitaNet-S | 6.4M | 1.15% | 0.131 |
  | TitaNet-M | 13.4M | 0.81% | 0.106 |
  | TitaNet-L | 25.3M | 0.68% | 0.087 |

  Training data was VoxCeleb1, VoxCeleb2 dev, NIST SRE 2004–08, Fisher, Switchboard and LibriSpeech (≈4.8M utterances, 16.6K speakers), augmented with RIR impulse responses, speed perturbation and SpecAugment. — [TitaNet paper (ar5iv)](https://ar5iv.labs.arxiv.org/html/2110.04410)
- The NVIDIA TitaNet-Large card reports 0.66% EER on cleaned VoxCeleb1 with ≈23M params, under CC-BY-4.0. It advises fine-tuning if your data is out of domain, and its training data covers VoxCeleb, Fisher and Switchboard. — [Hugging Face: nvidia/speakerverification_en_titanet_large](https://huggingface.co/nvidia/speakerverification_en_titanet_large)
- WeSpeaker VoxCeleb v2 recipe. Columns are Vox1-O, Vox1-E and Vox1-H EER %. "LM" means large-margin fine-tuning, "AS" means AS-norm, and "QMF" means quality-aware calibration. — [WeSpeaker voxceleb/v2 README](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)
  - ResNet34 (6.63M params, 4.55 GFLOPs):
    - plain: 0.867 / 1.049 / 1.959
    - AS: 0.787
    - LM: 0.797
    - LM+AS: 0.723 / 0.867 / 1.532
    - LM+AS+QMF: 0.659 / 0.821 / 1.437
  - ResNet221 (23.79M params, 21.29 GFLOPs): plain 0.569, LM 0.580, LM+AS 0.505.
  - ResNet293 (28.62M params, 28.10 GFLOPs):
    - plain: 0.595
    - LM: 0.532
    - LM+AS: 0.447
    - LM+AS+QMF: **0.425 / 0.641 / 1.146**
  - CAM++ (7.18M params, 1.15 GFLOPs): plain 0.803, LM 0.707, LM+AS 0.659 / 0.803 / 1.569.
  - ECAPA-TDNN c512 (6.19M, 1.04 GFLOPs): plain 1.069, LM+AS 0.782.
  - ECAPA-TDNN c1024 (14.65M, 2.65 GFLOPs): plain 0.856, LM+AS+QMF 0.707.
  - ERes2Net34-Base (7.88M): plain 0.914, LM+AS 0.744.
  - Gemini DF-ResNet114 (6.53M): plain 0.787, LM+AS 0.638.
  - SimAM-ResNet34, VoxBlink2-pretrained (25.2M): LM 0.415, LM+AS 0.372.
  - SimAM-ResNet100, VoxBlink2-pretrained (50.2M): LM 0.229, LM+AS+QMF **0.202 / 0.421 / 0.795**.
  - WavLM front end + ECAPA: best 0.415 / 0.551 / 1.118.
  - w2v-BERT 2.0 LoRA-adapter-MFA: best 0.250 / 0.398 / 0.838, with no AS-norm.
  - ReDimNet2-B6: 0.276 with the official checkpoint and 0.330 trained from scratch.
  - PLDA back end on ResNet34-LM: 1.207, against 0.797 with cosine scoring.
  - Uncertainty-aware "U³-xi" ReDimNet-B2: 0.782 plain to 0.399 with uncertainty-aware scoring, LM and AS. — same source
- 3D-Speaker README (supervised; EER on VoxCeleb1-O / CN-Celeb / 3D-Speaker test sets), Apache-2.0 licence, with an ONNX Runtime runtime added April 2024 — [3D-Speaker](https://github.com/modelscope/3D-Speaker):

  | Model | Params | VoxCeleb1-O | CN-Celeb | 3D-Speaker |
  |---|---|---|---|---|
  | CAM++ | 7.2M | 0.65% | 6.78% | 7.75% |
  | ERes2Net-base | 6.61M | 0.84% | — | — |
  | ERes2Net-large | 22.46M | 0.52% | — | — |
  | ERes2NetV2 | 17.8M | 0.61% | 6.14% | 6.52% |
  | ECAPA-TDNN | 20.8M | 0.86% | — | — |
  | ResNet34 | 6.34M | 1.05% | — | — |
  | Res2Net | 4.03M | 1.56% | — | — |

  The CAM++ paper itself reports 0.73% on Vox-O, which doesn't match the README's 0.65% (search summary). — [CAM++ paper](https://arxiv.org/pdf/2303.00332)
- ERes2NetV2 (Interspeech 2024) on VoxCeleb1-O — [ERes2NetV2 paper](https://arxiv.org/html/2406.02167v1):
  - full-length trials: 0.61% EER (minDCF 0.054)
  - 3 s trials: 0.98%
  - 2 s trials: 1.48%
  - Baselines at 3 s / 2 s: ECAPA-TDNN 1.27 / 1.95, ResNet34 1.47 / 2.12, ERes2Net 1.89 / 3.28.
  - No 1 s results are reported.
- ReDimNet (IDR&D, Interspeech 2024), MIT licence. Training type is "ft_lm" on VoxCeleb2; columns are Vox1-O EER without / with AS-norm. — [ReDimNet EVALUATION.md](https://github.com/IDRnD/redimnet/blob/master/EVALUATION.md)

  | Model | Params | GMACs | No AS-norm | AS-norm |
  |---|---|---|---|---|
  | B0 | 1.0M | 0.43 | 1.16 | 1.07 |
  | B1 | 2.2M | 0.54 | 0.85 | 0.73 |
  | B2 | 4.7M | 0.90 | 0.57 | 0.52 |
  | B3 | 3.0M | 3.00 | 0.50 | 0.47 |
  | B5 | 9.2M | 9.87 | 0.43 | 0.39 |
  | B6 | 15.0M | 20.27 | 0.40 | 0.37 |

  The repo loads models through torch.hub, needs PyTorch ≥2.0, takes 16 kHz input, outputs 192-dim embeddings, and mentions no ONNX export. — [ReDimNet repo](https://github.com/IDRnD/redimnet)
- ReDimNet2 (submitted to Interspeech 2026) spans 1.1M–12.3M params. The largest reaches 0.287% EER on Vox1-O at 12.3M params and 13 GMACs (search summary). — [ReDimNet2 arXiv 2603.11841](https://arxiv.org/abs/2603.11841)
- ECAPA2 (IDLab, Jan 2024), 27M params: 0.34 / 0.52 / 0.99% on Vox1-O/E/H, against ECAPA-TDNN (14M) at 0.87 / 1.12 / 2.12. It ships as TorchScript (`ecapa2.pt`, 16 kHz) on Hugging Face (search summary). — [ECAPA2 paper](https://arxiv.org/abs/2401.08342v1), [Jenthe/ECAPA2](https://huggingface.co/Jenthe/ECAPA2)
- w2v-BERT 2.0 speaker verification (Oct 2025 preprint), on a ≈600M-param encoder — [arXiv 2510.04213](https://arxiv.org/html/2510.04213v1):
  - 0.12% EER on Vox1-O and 0.55% on Vox1-H, with LM and calibration and VoxBlink2 as extra training data
  - 0.18% when trained on VoxCeleb2 only
  - 0.18% after 80% structured pruning
- SpeechBrain ECAPA (spkrec-ecapa-voxceleb): 0.80% EER on VoxCeleb1-test (cleaned), Apache-2.0, 16 kHz mono. — [Hugging Face card](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb)

**On-device availability (Apple Silicon)**
- The sherpa-onnx release `speaker-recongition-models` (sic) holds ready-to-use ONNX speaker models; the release notes say each model has its own licence — [GitHub release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models), [asset list via GitHub API](https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/speaker-recongition-models):
  - NeMo:
    - `nemo_en_titanet_small` (40.3 MB), the one ARES uses
    - `nemo_en_titanet_large` (101.4 MB)
    - `nemo_en_speakerverification_speakernet` (23.4 MB)
  - WeSpeaker:
    - `wespeaker_en_voxceleb_resnet34` and `_resnet34_LM` (26.5 MB each)
    - `_resnet152_LM` (79.2 MB)
    - `_resnet221_LM` (95.0 MB)
    - `_resnet293_LM` (114.3 MB)
    - `_CAM++` and `_CAM++_LM` (29.3 MB each)
    - two CN-Celeb ResNet34 variants
  - 3D-Speaker:
    - `3dspeaker_speech_campplus_sv_en_voxceleb_16k` (29.6 MB)
    - `3dspeaker_speech_eres2net_sv_en_voxceleb_16k` (26.5 MB)
    - `campplus_sv_zh_en_16k-common_advanced` (28.3 MB)
    - **ERes2NetV2 and ERes2Net-large only as zh-cn models** (71.4 MB and 116.1 MB)
- WeSpeaker publishes both `.pt` checkpoints and `.onnx` runtime models. Licences follow the training dataset; VoxCeleb is CC BY 4.0. LM variants "could perform better on long audios, e.g. >3s". ONNX files exist for ResNet34/152/221/293-LM, CAM++, ECAPA512/1024, Gemini DF-ResNet114 and SimAM-ResNet34/100. ReDimNet2-B6-LM and W2V-BERT2.0 are checkpoint only, with no ONNX. — [WeSpeaker pretrained.md](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)
- FluidAudio is an open-source Swift SDK that runs Core ML models on the Apple Neural Engine. It covers ASR, TTS, speaker diarization, speaker embedding extraction and VAD, is arm64 only, and needs macOS 14+ / iOS 17+. Its authors first tried sherpa-onnx, found that running diarization and ASR together slowed older devices, and so converted the PyTorch models straight to Core ML. — [FluidAudio GitHub](https://github.com/FluidInference/FluidAudio), [Show HN post](https://hn.svelte.dev/item/44546863)
- ARES already loads `sherpa-onnx-node`'s `SpeakerEmbeddingExtractor` with `nemo_en_titanet_small` in Electron's main process (`numThreads: 2`) and L2-normalises the output. — [local: voiceid.js](file:///Users/dhruv/My%20AI/voiceid.js)

**Commercial options, for comparison**
- **Picovoice Eagle**
  - What it is: an on-device, "language-agnostic and text-independent" speaker recognition engine. It runs on macOS x86_64 and arm64, and the SDK is Apache-2.0.
  - Licence check: it needs an AccessKey that is validated online and enforces account usage limits.
  - API: streaming `process()` returns a score per enrolled profile for each chunk. — [Picovoice/eagle](https://github.com/Picovoice/eagle)
  - Vendor's own claims (no independent check found): 0.18% EER against SpeechBrain's 0.49%, and a 4.5 MB model against SpeechBrain's 46.5 MB (search summary). — [Picovoice cookbook](https://picovoice.ai/cookbook/ai-voice-assistant-speaker-recognition/)
- **Microsoft Azure AI Speaker Recognition** was retired on 30 Sept 2025 (search summary). — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/cognitive-services/speaker-recognition/home)
- **Amazon Connect Voice ID** reached end of support on 20 May 2026, after new sign-ups closed in May 2025. AWS points customers to Pindrop or SMS one-time codes (search summary). — [AWS docs](https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html)
- **ID R&D IDVoice** (owned by Mitek since 2021)
  - Supports text-dependent and text-independent verification with anti-spoofing; v2.11's engine is under 1 MB (search summary). — [ID R&D v2.11](https://idrnd.ai/?p=2039), [Mitek acquisition](https://www.businesswire.com/news/home/20210601005240/en/Mitek-Acquires-ID-RD-to-Lead-Fight-Against-Biometric-Identity-Fraud)
  - A 2018 vendor claim says it verifies from 1–2 s of free speech, with ≈0.3% EER on microphone audio (vendor benchmark; search summary). — [SpeechTech](https://www.speechtechmag.com/Articles/News/Speech-Technology-News/ID-RD-Delivers-Voice-Biometrics-Authentication-Accuracy-Requiring-Just-1-2-Seconds-of-Free-Speech-with-IDVoice-126228.aspx)
- **Sensory TrulySecure Speaker Verification**
  - Offers text-dependent and text-independent modes, a prompted-challenge "voice liveness" check and optional face+voice fusion.
  - It runs on device, including macOS, and was priced at $2,500 for the SDK in 2018 (search summary). — [Voicebot 2018](https://voicebot.ai/2018/06/14/sensory-announces-updated-voice-security-with-trulysecure-speaker-verification-2-0/), [Sensory](https://sensory.com/voice-biometrics-sound-recognition/)
- **pyannoteAI**: voiceprint and speaker-identification features are reserved for the paid Precision-2 tier; the open community-1 model doesn't have them (search summary). — [pyannote.ai models reference](https://www.pyannote.ai/md/models)

### Inferences
- The cheapest real upgrade is changing `modelPath` to a sherpa-onnx model already in the same release, then re-enrolling. Embedding size changes (TitaNet 192, WeSpeaker ResNet 256), so old voiceprints can't be reused.
  - Benchmark relative EER reductions against TitaNet-S's 1.15%: ResNet293-LM ≈54%, ResNet221-LM ≈50%, TitaNet-L ≈41%, CAM++-LM ≈39%.
  - CAM++ costs about 1.15 GFLOPs against ResNet293's 28 GFLOPs as WeSpeaker reports them (the input length behind those FLOPs isn't stated). Measure real-time factor on the Mac before choosing.
- WeSpeaker's guidance is that LM variants help on clips longer than about 3 s. ARES's commands are often 1–2 s, so test LM and non-LM variants on ARES's own short clips rather than assuming LM is better.
- TitaNet's training set includes telephone corpora (Fisher, Switchboard, SRE). That may help with VoIP-style processed audio (Apple's voice processing) more than VoxCeleb-only WeSpeaker models, but this is untested. Choose the model empirically, on labelled clips captured through ARES's live audio path.
- The SSL verifiers (WavLM, w2v-BERT 2.0 at ~600M) and ECAPA2 or ReDimNet2 are the most accurate. They need conversion and cost more CPU or ANE time, so they suit a second-stage check only for risky requests, not every utterance.
- Model choice matters less than the deployment issues in Section 2. Every model degrades the same way on short, mismatched, far-field audio, so swapping models alone won't bring ARES's ~73% reject rate near benchmark levels.

### Gaps
- None of the sherpa-onnx models has published 1 s or 2 s EERs, and I found no EERs on Apple voice-processing (VPIO) audio.
- Not individually verified: the licences of `nemo_en_titanet_small.onnx` and the 3D-Speaker English ONNX files, whether `3dspeaker_speech_eres2net_sv_en_voxceleb_16k` is the 6.61M "base" model, and ECAPA2's licence.
- Eagle's benchmark method and any independent replication of it.
- No independent latency benchmarks of these models on Apple Silicon (CPU vs ANE).

## 2. Why does verification reject the real owner, and what do the literature and practitioners recommend?

### Takeaway
The owner's low live scores (≈0.29–0.43 against a 0.48 cosine threshold) match the textbook mismatch pattern. Live clips are 1–3 s long, while enrollment was careful, quiet and prompted. The live audio is voice-processed while ARES or music plays, at varying distance, and in conversational style. On top of that, ARES uses one raw-cosine threshold derived from how alike the enrollment clips are to each other, not from the owner's real live score distribution.

The literature's remedies:
- Enroll in the conditions where verification is used, and keep several enrollment vectors.
- Score whole utterances and accumulate evidence across a conversation.
- Normalise scores against an impostor cohort (AS-norm).
- Calibrate with quality measures such as duration and SNR, so each decision is a probability with duration-aware thresholds.
- Adapt the voiceprint only from speech confirmed to be the owner's by something other than the voice score.

### Cited Findings

**Short utterances**
- On VoxCeleb1-O, ERes2NetV2's EER is 0.61% on full-length trials, 0.98% at 3 s and 1.48% at 2 s. ECAPA-TDNN goes from 0.82% (full) to 1.27% (3 s) to 1.95% (2 s). — [ERes2NetV2 paper](https://arxiv.org/html/2406.02167v1)
- WeSpeaker says LM fine-tuned models perform better on clips longer than about 3 s. Later work (ICASSP 2023, adaptive large-margin fine-tuning) reports that conventional LM fine-tuning can hurt short utterances (search summary). — [WeSpeaker pretrained.md](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md), [ICASSP 2023 talk](https://rc.signalprocessingsociety.org/conferences/icassp-2023/spsicassp23vid0637)
- DAME (Jan 2026) nests sub-embeddings by utterance duration. It is model-agnostic and "consistently reduces the equal error rate on 1-s and other short-duration trials" at no extra inference cost; I did not retrieve its numbers. — [DAME arXiv 2601.13999](https://arxiv.org/abs/2601.13999)

**Distance and channel mismatch**
- FFSVC 2020 enrolled on close-talk phones and tested on far-field arrays. Baseline EERs were 6.27%, 6.55% and 7.18% on tasks 1–3, against sub-1% on VoxCeleb for similar-era models. — [FFSVC 2020 paper](https://arxiv.org/pdf/2005.08046)
- One FFSVC 2020 team named the main obstacles as "short utterance and cross-channel and distance mismatch for enrollment and test". — [NPU FFSVC system](https://arxiv.org/pdf/2008.03521)
- FFSVC 2022 found far-field still hard and also reported cross-time effects: baseline EER rose from about 6.1% to 7.9% as the gap between enrollment and test visits grew (search summary of tables). — [FFSVC 2022](https://arxiv.org/pdf/2209.05273)
- A 2023 EURASIP study measured distance in noise. EER for seen speakers rose from ≈1.0% at 0.1 m to ≈2.1–2.2% at 3–5 m, and unseen speakers went from ≈2.3% to ≈5% by 1 m (search summary). — [EURASIP JASMP table](https://asmp-eurasipjournals.springeropen.com/articles/10.1186/s13636-023-00293-8/tables/3)

**Front-end processing (enhancement, echo cancellation) shifts embeddings**
- Kataria et al. (Odyssey 2020) report mean EER of 9.90 with no enhancement, 8.68 when only the test audio was enhanced, and 11.49 when the x-vector and PLDA training data were enhanced too. Enhancement interacts with the back end. — [arXiv 2002.00139](https://arxiv.org/abs/2002.00139v1)
- A 2025 Technion preprint argues that enhancement can sound better to people while eroding the speaker traits a verifier relies on, especially with generative enhancers. Its fix fuses embeddings from the noisy and the enhanced versions of the same audio. — [arXiv 2508.18913](https://arxiv.org/pdf/2508.18913.pdf)
- Rozenberg et al. (Interspeech 2020): x-vector accuracy falls when recording conditions differ between enrollment and test audio. — [ISCA archive](https://www.isca-archive.org/interspeech_2020/rozenberg20_interspeech.html)
- SEED (diffusion-refined embeddings) reports up to 19.6% gains on environment-mismatch sets (search summary). — [SEED](https://pure.uos.ac.kr/en/publications/seed-speaker-embedding-enhancement-diffusion-model/)
- Apple's voice-processing path (VPIO) has separate switches for bypassing all uplink voice processing (`isVoiceProcessingBypassed`) and for automatic gain control (`isVoiceProcessingAGCEnabled`). — [Apple AVAudioInputNode docs](https://developer.apple.com/documentation/avfaudio/avaudioinputnode.md)
- On macOS, one developer found that turning off AGC through the low-level `kAUVoiceIOProperty_VoiceProcessingEnableAGC` made no difference to the gain drop (search summary). — [Apple Developer Forums](https://developer.apple.com/forums/thread/732823)
- macOS has three microphone modes, chosen per app by the user for apps on Apple's voice-processing APIs: Standard (ordinary voice processing), Voice Isolation and Wide Spectrum. A mode change alters the audio that reaches the voiceprint (search summary). — [AVCaptureDevice.MicrophoneMode](https://developer.apple.com/documentation/avfoundation/avcapturedevice/microphonemode.md), [WWDC23 session 10235](https://developer.apple.com/videos/play/wwdc2023/10235)

**Voice variation**
- Emotion lowers verification accuracy. EmoSpeechAuth (Interspeech 2025) cuts EER by 8.29 percentage points by fusing ECAPA2 embeddings with emotion2vec features (search summary). — [ISCA archive](https://www.isca-archive.org/interspeech_2025/goebiowska25_interspeech.html)
- An older study measured ≈1.0% EER on neutral speech against ≈7.5% on angry speech (search summary). — [arXiv 1804.00155](https://arxiv.org/pdf/1804.00155)
- Whispered speech: in an all-vs-all trial set that includes whispers, ReDimNet-B6 had 7.76% EER and B2 12.75% (search summary). — [arXiv 2604.20229](https://arxiv.org/pdf/2604.20229)

**Enrollment practice**
- Google's parameter-free attentive scoring paper shows multi-enrollment EER under half of single-enrollment EER in every row, clean and noisy (search summary). — [arXiv 2203.05642](https://arxiv.org/pdf/2203.05642)
- Apple's Personalized Hey Siri (PHS) enrolls explicitly with five phrases, then adds the speaker vector of each accepted utterance until the profile holds 40 vectors. — [Apple ML Research](https://machinelearning.apple.com/research/personalized-hey-siri)
  - Each test utterance is scored by cosine against every profile vector, and the average is compared with a fixed threshold.
  - Apple notes that clean enrollment recordings lack real-world variability, and that early false accepts could corrupt the profile.
  - The device keeps the trigger audio so the profile can be rebuilt when a new model ships.
- Per-utterance enrollment embeddings are commonly averaged; one alternative computes a single embedding from concatenated audio (search summary). — [Attention back-end for multiple enrollment utterances](https://arxiv.org/pdf/2104.01541)

**Score normalisation (AS-norm and relatives)**
- AS-norm (Karam et al. 2011) works per trial (search summary of the TAS-norm paper's description):
  1. Score the enrollment and the test embeddings against a cohort of impostor embeddings.
  2. Keep each side's top-N scores.
  3. Standardise the raw score with each side's mean and standard deviation, and average the two: `s' = ½[(s−μe)/σe + (s−μt)/σt]`.
  - N is a tuning parameter; TAS-norm (trainable cohort, 2025) beat plain AS-norm by ≈4% relative EER on ECAPA. — [TAS-norm arXiv 2504.04512](https://arxiv.org/html/2504.04512v1)
- Normalising at the embedding level instead of the score level held up better under severe mismatch on SRE16/19 (search summary). — [Cumani, Interspeech 2023](https://www.isca-archive.org/interspeech_2023/cumani23_interspeech.html)
- Measured AS-norm gains, Vox1-O EER — [WeSpeaker README](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md), [ReDimNet EVALUATION.md](https://github.com/IDRnD/redimnet/blob/master/EVALUATION.md):
  - ResNet34: 0.867 to 0.787
  - ResNet293-LM: 0.532 to 0.447
  - ReDimNet-B1: 0.85 to 0.73
  - ReDimNet-B6: 0.40 to 0.37
- Other calibration and back-end research that I did not read in full: [calibration methods comparison](https://arxiv.org/pdf/2203.15106), [robust back end across conditions](https://arxiv.org/pdf/2102.01760), [2026 unified uncertainty-aware back end](https://arxiv.org/pdf/2609.01221).

**Quality-aware calibration (QMF)**
- IDLab's VoxSRC-20 system feeds quality features, with utterance duration as the simplest, into score calibration, so decision thresholds adapt to trial conditions. — [IDLab arXiv 2010.11255](https://arxiv.org/abs/2010.11255)
- In WeSpeaker, QMF on top of AS-norm takes ResNet34-LM from 0.723 to 0.659, ResNet293-LM from 0.447 to 0.425, and ECAPA-1024-LM from 0.728 to 0.707. — [WeSpeaker README](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)

**PLDA (legacy back end)**
- On modern embeddings, PLDA scored worse than cosine in-domain: 1.207 against 0.797 for ResNet34-LM. — [WeSpeaker README](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/README.md)

**Accumulating evidence**
- Apple's 2018 PHS article proposed using the whole "Hey Siri, …" utterance for text-independent recognition. — [Apple ML Research 2018](https://machinelearning.apple.com/research/personalized-hey-siri)
- By 2023, Siri's pipeline runs speaker ID twice: on the trigger alone to decide whether to keep listening, and again at false-trigger mitigation on the trigger plus the request. An LSTM extractor handles variable-length input. — [Apple ML Research 2023](https://machinelearning.apple.com/research/voice-trigger)
- A 2026 preprint finds that pooling audio across several utterances keeps improving verification as more speech arrives, with frame-level pooling the most accurate (search summary). — [arXiv 2607.19636](https://arxiv.org/pdf/2607.19636)
- Older work found that data-dependent or sorted fusion of per-utterance scores beat plain averaging, for example an 11% EER cut (search summary). — [Princeton multi-sample fusion](https://collaborate.princeton.edu/en/publications/multi-sample-data-dependent-fusion-of-sorted-score-sequences-for-/)

**ARES today (local facts)**
- `voiceid.js` constants: `MIN_SECONDS = 1.2` for enrollment samples, `MAX_SAMPLES = 20`, `RECENT_WEIGHT = 0.4`, `LEARN_MARGIN = 0.12`. — [local: voiceid.js](file:///Users/dhruv/My%20AI/voiceid.js)
- Scoring is one cosine against a centroid. The threshold is set at enrollment as `min(0.48, max(0.4, worstLeaveOneOut − 0.2))`, which caps it at 0.48.
- Clips under 0.3 s count as rejects. A voiced-frame energy gate (20 ms frames, gate `max(3×floor, 0.12×peak)`) trims silence before embedding.
- Learning blends recent matched or near-miss embeddings into 40% of the centroid. A sample is only accepted if it scores at least threshold − 0.12 against the original enrollment.
- Enrollment and live audio both come through the same AVAudioEngine input with voice processing on. Enrollment waits for speech, stops after 1 s of silence, and treats the first 0.4 s as the room's noise level. — [local: native/AresListener.swift](file:///Users/dhruv/My%20AI/native/AresListener.swift)
- How `main.js` uses the score — [local: main.js](file:///Users/dhruv/My%20AI/main.js):
  - Barge-in accepts threshold − 0.15.
  - Desk mode forces verification for speech not addressed to ARES; push-to-talk ("trusted") skips it.
  - "Near-miss" learning happens at threshold − 0.08 within 60 s of a verified exchange.
- Logged checks — [local: ~/Library/Application Support/ARES/voiceid-log.jsonl](file:///Users/dhruv/Library/Application%20Support/ARES/voiceid-log.jsonl):
  - 220 checks from 2026-10-02 to 2026-10-08, accepted 26.8% of the time. Score deciles: 0.04, 0.10, 0.16, 0.24, 0.34, 0.40, 0.46, 0.54, 0.62.
  - Median score by clip length:

    | Clip length | Checks | Median score | Accept rate |
    |---|---|---|---|
    | 0–1 s | 21 | 0.358 | 19% |
    | 1–2 s | 63 | 0.399 | 32% |
    | 2–3 s | 37 | 0.331 | 32% |
    | 3–5 s | 56 | 0.303 | 27% |
    | ≥5 s | 43 | 0.147 | 19% |

  - 71 learn attempts, of which 55 were accepted.
- Current voiceprint: TitaNet-small, re-enrolled 2026-10-08 from 6 samples, leave-one-out consistency 0.768, threshold 0.48, 12 recent samples, Voice ID switched off. — [local: voiceprint.json](file:///Users/dhruv/Library/Application%20Support/ARES/voiceprint.json)

### Inferences
- **Why ARES rejects the owner** (inference from the findings above):
  1. **The threshold comes from the wrong distribution.** It is derived from the enrollment clips scored against each other (careful prompted speech, ~0.77), not from genuine live scores, so it sits above where the owner usually lands (≈0.29–0.43).
  2. **Clips are short.** Most live clips are 1–3 s, which per ERes2NetV2 raises EER about 1.6–2.4× over full-length trials, before any mismatch.
  3. **Conditions differ.** Enrollment happened in a quiet room with no playback. In desk mode, echo cancellation, noise suppression and AGC are working while ARES speaks or music plays, at varying distance, and the macOS mic mode can differ.
  4. **TitaNet-S** is the weakest model listed in Section 1.
  5. **Learning is biased.** Matched or near-miss samples only come from speech that already scores high, so the voiceprint can't learn the conditions where the owner scores low (selection bias).
- The ≥5 s bucket has the lowest median score (0.147). Long captures are probably dominated by non-owner audio (TV, podcasts, several talkers) or contain residual echo of ARES's own voice. The log is unlabelled, so the real owner false-reject rate is unknown; labelled trials are the first thing to collect (voice v2 prompt, step A3).
- **Raw cosine isn't comparable across conditions.** A threshold that works at 4 s near the mic is wrong at 1 s across the room. Two fixes from the literature map onto ARES:
  - AS-norm against a fixed public cohort (for example a few hundred to a few thousand VoxCeleb embeddings computed once with the same model).
  - A small logistic calibration on (normalised score, log duration, SNR or level) fitted to the owner's labelled trials. It produces a probability or log-likelihood ratio, so a 1 s clip says "unsure" instead of "not the owner".
- **Treat short clips as neutral evidence.** Below about 1 s, an embedding should not count against the owner; it should only shift the trust score a little.
- **Use the whole utterance, not a clip,** and use the wake phrase plus the command together, as Siri's two-stage design does. Within a conversation, combine evidence across turns (running mean of log-likelihood ratios with decay) instead of judging each turn alone.

### Gaps
- No published study measures how Apple's voice processing (AEC, NS, AGC, mic modes) affects speaker embeddings.
- Unconfirmed: whether turning AGC off works on macOS with AVAudioEngine, and whether the echo canceller's reference includes other apps' audio or only ARES's own output.
- DAME's 1 s numbers weren't retrieved, and I found no authoritative cohort size N for AS-norm.
- The owner's real false-reject and false-accept rates in ARES can't be computed from the unlabelled log.

## 3. Text-dependent verification on the wake phrase vs text-independent verification of any utterance; how do commercial assistants design voice ID, what do they gate, and how accurate are they?

### Takeaway
All three big assistants treat voice ID as convenience and personalisation, not security:
- **Design:** they verify mainly on the wake phrase (text-dependent), increasingly add text-independent evidence from the request that follows, and keep improving profiles from real use.
- **Gating:** sensitive actions step up to another factor. Alexa uses a voice code for purchases unless the voice is recognised, and HomePod's "Secure Requests" ask for confirmation on the iPhone. Google warns that similar voices may reach personal results.
- **Accuracy:** published figures are modest (Apple PHS: 5.2% false reject, 3.2% impostor accept; Google wake-phrase EER ≈2.4%).
- **Standards:** NIST SP 800-63-4 now forbids voice as an authenticator.

### Cited Findings
- **Apple Personalized Hey Siri (2018)** — [Apple ML Research](https://machinelearning.apple.com/research/personalized-hey-siri)
  - Design: a text-dependent speaker check that runs after the "Hey Siri" detector fires. Explicit enrollment is five phrases ("Hey Siri" three times, "Hey Siri, how is the weather today?", "Hey Siri, it's me"); implicit enrollment adds accepted utterances up to 40 vectors. The model is a DNN with four 256-unit sigmoid layers and a 100-dim linear output, trained on 16,000 users with about 150 utterances each, and 8-bit quantised.
  - Speaker-recognition EER on 200 users: linear transform 8.0%, 1×100 DNN 5.3%, 4×256 DNN 4.3%.
  - End to end with the 4×256 DNN: 1 false accept per month, 5.2% false reject, 3.2% impostor accept.
  - Reverberant and noisy settings (car, wind) "still remain more challenging".
- **Apple Siri voice trigger (Aug 2023)** — [Apple ML Research](https://machinelearning.apple.com/research/voice-trigger)
  - Speaker ID is one stage of a multistage pipeline: on the trigger alone after the application-processor checker, and again in false-trigger mitigation on trigger plus request.
  - Enrollment is guided ("Siri, how's the weather?"), the training loss is inspired by SphereFace2, and the article reports no metrics.
- **Google GE2E (2017)** — [arXiv 1710.10467](https://arxiv.org/pdf/1710.10467), [attention-based text-dependent verification paper](https://arxiv.org/pdf/1710.10470)
  - Text-dependent verification on "OK Google" and "Hey Google"; average text-dependent EER of 2.38% with the MultiReader method (3.10% without).
  - Cross-keyword trials have higher error than same-keyword trials: 2.99% and 2.30% against 0.82% and 1.15% (search summary).
  - The related attention-based paper ties these two global passwords to Google Home's Voice Match.
- **Google Voice Match** — [Google Help (en)](https://support.google.com/assistant/answer/9071681?hl=en), [Google Help (en-GB)](https://support.google.com/assistant/answer/9071681?hl=en-GB)
  - The voice model is created on Google's servers and stored only on devices with Voice Match on. Without a match, the query is handled as a guest query with no personal results.
  - Per the en-GB page (search summary): anyone whose voice resembles yours might still reach personal results such as email and calendar, the remedy is to turn personal results off, and a home can have up to six enrolled people. The en page I opened did not show the similar-voice wording.
- A September 2026 report describes Voice Match misidentifying household members and routing personal requests to the wrong person's lists (search summary). — [Android Authority](https://www.androidauthority.com/google-home-voice-match-recognition-issues-3711916/)
- **Amazon Alexa Voice ID** — [Amazon help (mirror)](https://digprjsurvey.amazon.com/csad/help/node/GYCXKY2AB2QWZT2X), [Alexa developer blog](https://developer.amazon.com/blogs/alexa/post/1ad16e9b-4f52-4e68-9187-ec2e93faae55/recognize-voices-and-personal)
  - Gates personalisation (search summary of Amazon help pages):
    - calls and messages go to the recognised person's contacts
    - flash briefings, music, calendar and reminders follow the speaker
    - skills receive a `personID`
    - purchases can be limited to recognised members, and a recognised voice skips the spoken voice code
  - Amazon uses recordings to build an acoustic model of the voice and updates it over time.
- A secondary explainer says Alexa enrolment is about ten phrases and combines a wake-word recogniser with a text-independent one. — [ScienceABC](https://www.scienceabc.com/innovation/how-does-alexa-identify-who-is-speaking)
- Amazon Science lists the paper "Fusion of Embeddings Networks for Robust Combination of Text Dependent and Independent Speaker Recognition" (Interspeech 2021). I did not open the abstract. — [Amazon Science](https://www.amazon.science/publications/fusion-of-embeddings-networks-for-robust-combination-of-text-dependent-and-independent-speaker-recognition)
- Amazon also lists "Improving speaker identification for shared devices by adapting embeddings to speaker subsets". — [Amazon Science](https://www.amazon.science/publications/improving-speaker-identification-for-shared-devices-by-adapting-embeddings-to-speaker-subsets)
- **Apple HomePod "Recognize My Voice"**
  - Supports up to six household members. Guests can still play music, set timers and ask for weather or news.
  - Personal Requests (Messages, Reminders, Notes, Calendar) can be set to "For Secure Requests", which needs authentication on the iPhone; without a tap on the iPhone banner, the HomePod stays silent.
  - The stated aim is to stop someone with a similar voice from getting your information (search summary).
  - Sources disagree on exactly which requests count as secure. — [Apple Support HT204753](https://support.apple.com/HT204753), [HomePod User Guide](https://support.apple.com/en-euro/guide/homepod/apd1841a8f81/homepod), [Gadget Hacks](https://ios.gadgethacks.com/how-to/homepod-setting-keeps-other-people-out-your-notes-reminders-calendar-for-good-0384503)
- Picovoice publishes a "personalized secure wake word" recipe that pairs its Porcupine wake word with Eagle speaker recognition, verifying who says the wake word. — [Picovoice cookbook](https://picovoice.ai/cookbook/personalized-wake-word/)
- **NIST SP 800-63-4** (sec. 3.2.3) — [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
  - "Biometrics SHALL only be used as part of multi-factor authentication with a physical authenticator".
  - Requires a false match rate of 1 in 10,000 or better, and should show a false non-match rate under 5%.
  - "Biometric comparison based on voice SHALL NOT be used."

### Inferences
- **Wake-phrase verification for ARES.** Once ARES has a real "Hey ARES" detector (voice v2 plan), the commercial pattern is to verify the speaker on the wake phrase against text-matched enrollments. GE2E's 3–4× lower error for same-text trials shows text matching matters.
  - Without a model trained for text-dependent verification, ARES can approximate it by enrolling 10–20 real repetitions of "Hey ARES" across conditions and comparing wake-phrase audio with that set.
  - Then add text-independent evidence from the full wake phrase plus command, as Siri and Alexa do.
- **Commercial gating maps onto ARES's tiers.** A voice match buys personalisation and low-risk actions. Risky actions need a second factor (the phone, the keyboard, an on-screen "yes"), which is what ARES's tier-3 rule already does. NIST's ban on voice authenticators supports never letting voice alone unlock tier-2 or tier-3 actions.

### Gaps
- No current (2024–2026) published false-reject or false-accept rates for Siri, Alexa or Google Voice Match.
- Amazon's official design documents were found only as help-page mirrors and a secondary explainer.
- Google's "similar voice" caveat was seen only in a search summary of the en-GB page.

## 4. Multi-signal trust as an alternative or complement to a hard voice gate

### Takeaway
Shipping products already replace a lone voice gate with fused signals and risk tiers:
- **Google Look and Talk** fuses Face Match, Voice Match, proximity, gaze, head pose and lip movement (over 100 signals, processed on device).
- **Apple** relies on devices proven to be nearby (Watch Auto Unlock: Bluetooth LE discovery plus a Wi-Fi time-of-flight check, within about 3 m) and on phone confirmation for secure requests.
- **Research** adds wearable-vibration matching (VAuth: 97% detection, under 0.1% false positives) and device-directed speech models that fuse acoustic, ASR and LLM cues.

For ARES, "the owner is at the Mac and talking to me" is better established by keyboard and mouse activity, an unlocked screen, optional face presence, near-field acoustics and rejection of the Mac's own playback than by a 1–2 s voiceprint.

### Cited Findings
- **Google Look and Talk** (Nest Hub Max, 2022) — [Google Research blog](https://research.google/blog/look-and-talk-natural-conversations-with-google-assistant/), [Google Nest Help](https://support.google.com/googlenest/answer/11410414)
  - Requires Face Match (which in turn requires Voice Match).
  - Proximity is estimated from face size, up to 5 ft (1.5 m); a gaze model has a higher bar before the display signals readiness. Audio and video are checked together so the recognised face belongs to the speaker, and the enrolled voice must agree with the face match.
  - Uses more than 100 signals, including head orientation, lip movement and intent. Video analysis, transcription and intent understanding run on the device (search summary).
- **Apple Watch Auto Unlock for Mac:** Bluetooth LE handles discovery, and a time-of-flight measurement over peer-to-peer Wi-Fi defeats relay attacks. Apple's guide puts the range at about 3 m (10 ft); it requires two-factor authentication and a Watch passcode. — [Apple Support (2019 guide)](https://support.apple.com/en-ca/guide/macbook-pro/unlock-with-apple-watch-apda4d638ecf/2019/mac/10.14.5), [BGR on Federighi's explanation](https://www.bgr.com/tech/macos-auto-unlock-security-apple-watch/)
- **VAuth** (MobiCom 2017) matches a wearable's accelerometer with the microphone signal: 97% detection accuracy with under 0.1% false positives, in a lab test of 18 users and 30 commands. — [arXiv 1701.04507](https://arxiv.org/pdf/1701.04507)
- **Apple device-directed speech detection** (2023–2025): the system decides whether speech is meant for the assistant without a trigger phrase, by feeding acoustic features and ASR output into an LLM. — [arXiv 2403.14438](https://arxiv.org/pdf/2403.14438), [Apple ML Research](https://machinelearning.apple.com/research/llm-device-directed-speech-detection), [arXiv 2411.00023](https://arxiv.org/html/2411.00023v2), [arXiv 2508.02801](https://arxiv.org/pdf/2508.02801)
  - Reported relative EER cuts are up to 39% against text-only and 61% against audio-only models; a later Apple page gives 38.9% and 20.5% (search summary).
  - Follow-up work covers follow-up turns without a trigger, and a 2025 distillation method.
- **Personal VAD and Personal VAD 2.0** (Google) are speaker-conditioned VADs that pass only the target user's speech to on-device ASR, saving compute. Version 2.0 adds enrollment-less operation. — [arXiv 1908.04284](https://arxiv.org/pdf/1908.04284), [arXiv 2204.03793](https://arxiv.org/pdf/2204.03793)
- **Rejecting the device's own playback**
  - Amazon patent US10586534 measures echo-return-loss enhancement (ERLE) over a window. If it drops while the wake word fires, the phrase is judged to come from outside the speaker rather than from its own playback (search summary). — [US10586534](https://patents.justia.com/patent/10586534)
  - Other patents check a loopback copy of the device's own output for self-triggers, or screen outgoing audio before it plays. — [US10529331](https://patents.google.com/patent/US10529331), [US10878811](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10878811), [US9747899](https://www.google.co.uk/patents/US9747899)
  - "Alexa versus Alexa" shows speakers can be driven by commands they play themselves, and proposes discarding wake words found in the device's own playback. — [arXiv 2202.08619](https://arxiv.org/pdf/2202.08619)
  - Implicit acoustic echo cancellation for keyword spotting and device-directed speech is evaluated at fixed false-accept rates with and without TTS playback. — [arXiv 2111.10639](https://arxiv.org/pdf/2111.10639)
- **TV and broadcast media:** Amazon uses acoustic fingerprints of known broadcast wake-word mentions, held on device and in the cloud, and matches the same audio arriving from many homes at once. Amazon says 80–90% of devices stay quiet during such broadcasts (search summary). — [Amazon Science blog](https://amazon.science/blog/why-alexa-wont-wake-up-when-she-hears-her-name-in-amazons-super-bowl-ad)
- **Risk-based step-up in products:** HomePod "For Secure Requests" (iPhone confirmation) and Alexa's purchase voice code (Section 3). NIST forbids voice as an authenticator (Section 3).
- **ARES's own plan** (voice v2, step B3) already lists the trust signals: near-field speech, active at the Mac (input in the last minute, unlocked), the Mac's playback rejected via the echo-cancellation reference, a session trust window, the upgraded embedding as a soft signal, and optional face presence. Its policy is that low-risk asks need "it's me at the Mac" or a voice match, tier 2 needs a good trust score, and tier 3 needs an explicit yes. — [local: docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md)
- ARES Vision already emits a face box and keyboard-idle seconds (frames never leave the helper), and desk mode never logs overheard speech. — [local: CLAUDE.md](file:///Users/dhruv/My%20AI/CLAUDE.md)

### Inferences
- **Signals available to ARES, roughly from strongest to weakest** (a ranking inferred from the product patterns above):
  1. Keyboard or mouse input in the last few seconds, plus the screen unlocked. This is cheap, deterministic presence evidence.
  2. A face in front of the screen, or looking at it, from ARES Vision (opt-in).
  3. Near-field acoustics: a high direct-path level and SNR, low reverberation, and a stable level compared with a TV across the room.
  4. Not coming from the Mac itself: echo-reduction statistics, correlation with ARES's own playback, and rejecting ARES's own voices (Katherine, Kokoro) as explicit impostor voiceprints.
  5. The paired phone nearby. The owner's phone runs ARES's Android app; the Apple Watch route applies only if he has a Watch.
  6. A session trust window after a confident turn.
  7. The voice log-likelihood ratio as a soft factor.
- **Fusion method:** add calibrated log-likelihood ratios (naive Bayes) or use a small logistic regression on these features, fitted on the labelled trials from step A3. Map the result to tiers rather than one threshold.
- **Behaviour when unsure:** stay quiet (the current desk-mode rule) instead of refusing aloud.

### Gaps
- No published accuracy figures for Look and Talk.
- I found no study that fuses keyboard/mouse activity with voice verification.
- Near-field and reverberation-based "speaker is at the laptop" detection on MacBook mics isn't covered in what I found.
- Unconfirmed whether macOS voice processing exposes echo-reduction statistics, and whether its echo reference covers system-wide audio (YouTube in a browser) or only ARES's own output.

## 5. Anti-spoofing and replay detection: rejecting recordings, TV and videos of the owner or others

### Takeaway
Deepfake countermeasures work well on the data they were trained on:
- AASIST: 0.83% EER on ASVspoof 2019 LA with 297k params.
- XLS-R + AASIST: 0.82% on 2021 LA and 2.85% on 2021 DF.

They generalise poorly:
- The best ASVspoof 2021 DF EER was 15.64%.
- The best ASVspoof 5 closed-condition EER was 8.61%, and performance degrades under neural codecs and adversarial attacks.

Real-room replay detection is weak (ASVspoof 2021 PA best: 24.25% EER). For ARES the main hazard is ordinary playback of other people (TV, videos), which plain verification already rejects, plus the Mac's own audio. Recordings of the owner are rarer. Physical cues and presence are worth more than a deepfake detector.

### Cited Findings
- **ASVspoof 2021**, 54 teams — [ASVspoof 2021 overview](https://arxiv.org/pdf/2210.02437):
  - Logical access (LA): best EER 1.32% (t-DCF 0.2177).
  - Physical access (replay): best EER 24.25% (t-DCF 0.6824). Replay detection was promising on simulated rooms but fragile once conditions moved to real rooms.
  - Deepfake (DF): best EER 15.64% (secondary source, search summary). DF systems tolerated compression to a degree but transferred poorly between source corpora.
- **ASVspoof 5** (2024 challenge, 2026 journal) — [ASVspoof 5 challenge paper](https://arxiv.org/pdf/2408.08739), [ASVspoof 5 journal](https://arxiv.org/abs/2601.03944):
  - Uses a crowdsourced database and includes adversarial attacks and neural codecs; 53 teams.
  - Detection quality "degrades under adversarial attacks and the application of neural encoding/compression schemes".
  - Best closed-condition Track 1 entry (T32): minDCF 0.2436 and EER 8.61%, with actDCF 0.9956, so its own threshold was badly calibrated (search summary of the official table).
- **AASIST:** 297k params, 0.83% EER (min t-DCF 0.0275) on 2019 LA. AASIST-L has 85k params (≈332 KB) and 0.99% EER. — [AASIST paper](https://arxiv.org/pdf/2110.01200), [clovaai/aasist](https://github.com/clovaai/aasist)
- **XLS-R (300M) + AASIST** (Tak et al., Odyssey 2022): 0.82% EER on 2021 LA and 2.85% on 2021 DF, with data augmentation. — [arXiv 2202.12233](https://arxiv.org/pdf/2202.12233)
- A 2026 audit, "When EER Hides Deployment Failure", examines how detector thresholds transfer and how to calibrate scores without labels; I read only the title and abstract-level summary. — [arXiv 2606.21584](https://arxiv.org/pdf/2606.21584)
- **Void** (USENIX Security 2020) separates live speech from loudspeaker playback using spectral power features. Replay EER was 0.3% on the authors' own large dataset and 11.6% on the public ASVspoof 2017 data. — [USENIX](https://www.usenix.org/conference/usenixsecurity20/presentation/ahmed)
- **Commercial liveness:** Sensory uses a prompted challenge to tell a live speaker from playback. ID R&D says it targets replay, synthetic and software-edited speech. — [Voicebot 2018](https://voicebot.ai/2018/06/14/sensory-announces-updated-voice-security-with-trulysecure-speaker-verification-2-0/), [ID R&D](https://idrnd.ai/?p=2039)

### Inferences
- **What ARES actually faces:**
  - TV, YouTube or podcast voices of other people: these are non-target speakers, and an upgraded, normalised verifier plus near-field cues handles them.
  - The Mac's own output, including ARES's voice and media played on the Mac: reject it with echo-reference correlation or loopback checks, a non-ML engineering fix.
  - Recordings of the owner (his own videos or voice notes): rare.
  - Deliberate deepfakes: rare, and they belong to tier 3, which already needs an explicit on-screen or phone yes.
- **What not to use as a gate:** an ASVspoof-trained deepfake detector, given its poor generalisation and calibration. A Void-style loudspeaker-vs-live feature, or simple direct-to-reverberant and level cues, may be a cheap soft signal against TV audio from across the room, but would need testing on ARES's own clips.

### Gaps
- Official ASVspoof 2019 best LA/PA numbers weren't retrieved (search budget exhausted).
- I found no on-device (Core ML) anti-spoofing model or evaluation on MacBook microphones.
- No published replay-detection results under Apple voice processing.

## 6. Speaker diarization for rooms with several people (pyannote 3.x/4, NVIDIA Sortformer, diart, WeSpeaker): does it help an assistant?

### Takeaway
Diarization answers "who spoke when" across a recording. Open systems bring seconds of latency (diart 0.5–5 s, streaming Sortformer chunks of several seconds), speaker caps (Sortformer: 4), and no persistent identities (community-1 has no voiceprints; Sortformer keeps no memory across recordings). For an assistant that only needs "is this utterance the owner's, and was it said to me?", target-speaker methods help more: Personal-VAD-style gating, or scoring each utterance against the owner. Diarization mainly helps split a capture that mixes several talkers, or transcribe meetings.

### Cited Findings
- **pyannote.audio 4.0 with community-1** (late 2025) — [pyannote.ai blog](https://pyannote.ai/blog/community-1), [changelog](https://www.pyannote.ai/changelog/community-1-now-available), [PyPI 4.0.4](https://pypi.org/project/pyannote-audio/4.0.4/), [models reference](https://www.pyannote.ai/md/models)
  - Improves speaker assignment and counting over 3.1, with voice activity and overlap detection at about 3.1's level. Needs Python ≥3.10 and is free to self-host.
  - Voiceprint and speaker-identification features are reserved for the commercial Precision-2 tier.
  - These accuracy claims come from the vendor (search summary).
- **NVIDIA Streaming Sortformer 4spk** (v2 / v2.1) — [HF model card v2.1](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1), [NeMo Curator docs](https://docs.nvidia.com/nemo/curator/curate-audio/process-data/quality-filtering/speaker-separation), [NeMo voice agent docs](https://docs.nvidia.com/nemo/labs-voice-agent/about/core-concepts/speech-pipeline/speaker-diarization), [pyannote vs NeMo](https://www.pyannote.ai/blog/pyannote-vs.-nvidia-nemo-diarization-accuracy-setup-and-production-readiness)
  - Designed around four speakers; accuracy drops with more.
  - The NeMo Curator documentation ties the chunk setting to a delay of about 8 s (lower accuracy), about 30 s by default, and about 48 s for the best accuracy.
  - A third-party note gives the licence as CC-BY-4.0 (search summary).
- FluidAudio's documentation of Sortformer (third-party index): it is trained to ignore background conversations, so it may miss quiet or distant speech, and it doesn't remember speakers across recordings. The licence is listed as the NVIDIA Open Model License (search summary). — [FluidAudio docs index](https://docsearch.algolia.com/mcp/docs/repo/fluidinference/fluidaudio)
- **diart** (MIT licence)
  - Streaming diarization: segmentation, embeddings and incremental clustering, with latency tunable from 500 ms to 5 s.
  - Defaults to pyannote segmentation and embedding models; also supports WeSpeaker, SpeechBrain, TitaNet and ONNX models.
  - The default segmentation model takes 12 ms on CPU (AMD Ryzen 9). — [diart GitHub](https://github.com/juanmc2005/diart)
- **Other diarization stacks**
  - sherpa-onnx diarization builds combine pyannote or rev.ai segmentation with 3D-Speaker or NeMo embeddings (search summary). — [sherpa-onnx APK listing](https://huggingface.co/csukuangfj/sherpa-onnx-apk/tree/1e8e147fc6f94104312952065d64031222883852/speaker-diarization/1.10.32)
  - 3D-Speaker's recipes cover VAD, segmentation, embeddings, clustering and optional overlap detection, plus audio-visual diarization (Feb 2024). — [3D-Speaker](https://github.com/modelscope/3D-Speaker)
  - FluidAudio offers online and offline diarization in Core ML for Swift, including LS-EEND and Sortformer. — [FluidAudio](https://github.com/FluidInference/FluidAudio)
- TitaNet-L's diarization error rate with oracle VAD and known speaker count is 1.73% on AMI MixHeadset and 6.73% on NIST SRE 2000. — [TitaNet-L card](https://huggingface.co/nvidia/speakerverification_en_titanet_large)
- Personal VAD gates ASR on one target speaker, which saves compute and battery on device. — [Personal VAD](https://arxiv.org/pdf/1908.04284), [Personal VAD 2.0](https://arxiv.org/pdf/2204.03793)

### Inferences
- **For ARES's job** (owner vs everyone else, in real time), full diarization adds latency and complexity for little gain.
- **One lightweight use:** when a long capture contains several talkers (the low-scoring ≥5 s clips), split it with a VAD or speaker-change step and score only the segment that carries the command. That avoids averaging the owner's speech with a TV voice into one embedding.
- **Option for multi-person rooms:** enrolling consenting household members as "known others" and choosing the best match with a margin (open-set identification, as Alexa and Google households do) improves discrimination more than diarization does.

### Gaps
- No DER figures retrieved for community-1 or diart.
- Sortformer's licence wasn't confirmed on the model card.
- I found no evaluation of diarization as an assistant's front end against per-utterance verification.

## 7. Concrete recommendations for ARES (synthesis)

### Takeaway
Make voice one soft, calibrated signal inside the trust score already planned in voice v2, not a hard gate:
1. Measure first.
2. Fix the cheap deployment problems: whole-utterance scoring, multi-condition enrollment through the live path, normalisation and duration-aware calibration, short clips treated as neutral, and session-level evidence.
3. Swap TitaNet-small for a stronger sherpa-onnx model chosen on ARES's own labelled clips.
4. Let presence, near-field cues and playback rejection carry low-risk turns.
5. Keep risky actions behind explicit confirmation, as Apple, Amazon, Google and NIST all do.

### Cited Findings
- **What ARES does now:** a single centroid with raw cosine; the threshold capped at 0.48 and derived from enrollment self-consistency; 26.8% of checks accepted; learning only from matched or near-miss speech; TitaNet-small. — [local: voiceid.js](file:///Users/dhruv/My%20AI/voiceid.js), [local: voiceid-log.jsonl](file:///Users/dhruv/Library/Application%20Support/ARES/voiceid-log.jsonl), [local: main.js](file:///Users/dhruv/My%20AI/main.js)
- **The voice v2 plan** already asks for the following — [local: docs/voice-prompt.md](file:///Users/dhruv/My%20AI/docs/voice-prompt.md):
  - A3: measure accept rates on short vs long, near vs far and with music, and compare larger embeddings, cohort/AS-norm and whole-utterance scoring.
  - B3: trust instead of Voice ID.
  - Replays of the A3 recordings as regression tests.
- **Evidence behind each recommendation** comes from Sections 1–6:
  - model gains (WeSpeaker, 3D-Speaker, TitaNet)
  - AS-norm and QMF gains (WeSpeaker, IDLab)
  - short-duration degradation (ERes2NetV2)
  - multi-vector profiles and implicit-enrollment risks (Apple PHS)
  - multi-enrollment benefit (Google)
  - commercial gating (Apple, Amazon, Google)
  - NIST ban on voice authenticators
  - multi-signal products (Look and Talk, Auto Unlock)
  - playback-rejection techniques (Amazon patents)

### Inferences
These recommendations are my synthesis; the numbers are starting points to tune on data.

1. **Measure before changing anything** (voice v2 step A3).
   - Collect labelled trials: owner positives from push-to-talk and keyboard-confirmed speech (near and far, music on and off, while ARES speaks), and negatives from an hour of TV, podcast and YouTube audio played through the speakers and from another device.
   - Store embeddings, scores, duration, level/SNR and mic mode, never audio of other people, consistent with the rule that overheard speech is never logged.
   - Report false rejects at fixed false-accept rates, by duration bucket.
2. **Score the whole utterance.**
   - Use the wake phrase plus the command (once "Hey ARES" exists), not a clip.
   - Below about 1 s of voiced speech, return "no evidence" rather than a rejection.
   - Split long captures at speaker changes or pauses and score only the command segment.
3. **Re-enroll through the exact live path, in several conditions.**
   - About 15–30 utterances over 3 or more sessions: at the keyboard, leaning back about 1 m, with music low, and while ARES is talking (so echo cancellation is working).
   - Mix "Hey ARES" repetitions with natural commands rather than read prompts.
   - Record the macOS mic mode with the profile, and warn when the live mode differs.
   - Keep every enrollment embedding, not just the centroid. Score as the mean of the top-k cosine scores against the set (as Apple averages against all 40 profile vectors), drop outliers, and cap the profile size (Apple uses 40).
4. **Normalise and calibrate.**
   - AS-norm against a fixed public cohort: a few hundred to a few thousand VoxCeleb utterances embedded once with the chosen model; tune top-N on the A3 data.
   - Then fit a logistic calibration on (normalised score, log duration, SNR/level) to the A3 labels, giving a per-utterance log-likelihood ratio.
   - Drop the "enrollment consistency − 0.2" threshold rule entirely.
5. **Accumulate evidence.** Keep a session trust value: a decayed sum of per-turn log-likelihood ratios plus presence events, lasting a few minutes while a conversation continues. One confident turn then carries the next weak 1 s turn ("and the other one?").
6. **Upgrade the model by measurement, not by benchmark.**
   - Candidates, already in the sherpa-onnx release, no new runtime:
     - `wespeaker_en_voxceleb_resnet293_LM` and `resnet221_LM` (most accurate)
     - `wespeaker_en_voxceleb_CAM++` and `CAM++_LM` (lightest at about 1.15 GFLOPs)
     - `nemo_en_titanet_large`
     - `3dspeaker_speech_campplus_sv_en_voxceleb_16k` / `eres2net_sv_en_voxceleb_16k`
   - Compare LM and non-LM variants on 1–2 s clips. Re-enroll after switching, since embedding sizes differ.
   - Later, optionally: ReDimNet-B2/B3 (MIT, 3–4.7M params, about 0.5% EER) or ECAPA2 via ONNX or Core ML conversion, or FluidAudio's Core ML path if CPU load matters.
7. **Add explicit negatives.**
   - Enroll ARES's own voices (Katherine via cached phrases, and Kokoro) and require the owner's score to beat the best impostor by a margin. That suppresses self-triggers that leak past echo cancellation.
   - Optionally enroll consenting household members as "known others" (open-set identification, as Alexa and Google households do).
8. **Fuse trust signals and gate by risk** (voice v2 step B3).
   - Presence: keyboard or mouse in the last N seconds, screen unlocked, optional face or gaze from ARES Vision.
   - Near-field level, SNR and reverberation.
   - Not the Mac's own playback: echo statistics and correlation with ARES's output.
   - The paired phone nearby.
   - The voice log-likelihood ratio.
   - Policy:
     - Low-risk asks pass on presence or voice.
     - Tier 2 needs a combined score.
     - Tier 3 always needs the explicit on-screen or phone yes. NIST forbids voice authenticators, and HomePod and Alexa step up the same way.
9. **Adapt safely.**
   - Learn only from utterances that other signals confirm are the owner's (push-to-talk, at the keyboard, near-field), never from voice-only near-misses.
   - Keep the original enrollment as the anchor, cap and age the recent set, record where each sample came from, and allow rollback.
   - Apple keeps trigger audio so profiles can be rebuilt after a model change. ARES keeps embeddings only, so a model switch means re-enrolling. Alternatively, keep the owner's own enrollment audio, encrypted and local, as an opt-in trade-off.
10. **Do not** adopt PLDA (worse than cosine on modern embeddings), use an ASVspoof-trained deepfake detector as a gate (poor generalisation), or use full diarization as the trust mechanism (latency, no persistent identities).

### Gaps
- Whether these steps get the owner's false-reject rate under about 5% at a useful false-accept rate can only be known from ARES's own A3 measurements; nothing in the literature covers MacBook voice-processed desk audio.
- Search-budget limits stopped me from verifying several items: VPIO's echo reference scope, macOS process taps for system audio, DAME numbers, diart DER and the ASVspoof 2019 numbers.
