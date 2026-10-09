# Voice v2, stage A: what we measured (9 October 2026)

Status: **interim.** Everything that could be measured without your voice is measured. The parts that need your
desk recordings (A2–A5) and the echo test (A6) have their tooling built, tested end to end on a pretend session read by
Kokoro, and waiting on one command each. Numbers marked *(report)* are the research report's vendor or benchmark figures;
everything else is ours, on this M5 MacBook.

## The short version

1. **The brain is the biggest slice, and the quick-turn route is backwards today.** ARES's router sends quick turns to
   `haiku`, but this Claude Code (2.1.286) still resolves that alias to **Haiku 4.5**, which was *slower* than Sonnet 5.5
   (warm first text p50 1.72 s vs 0.76–1.03 s). **Haiku 5.5** asked for by its full id is the fastest we measured:
   **p50 0.51 s, p95 1.05 s** to first text through the same session, persona and 139 tools. Claude Code refuses to switch
   to it mid-session ("isn't described by this version's model catalog"), so B6 needs a Claude Code update or a model
   override first.
2. **Katherine works on `eleven_v4_turbo`**, over the Text to Dialogue WebSocket with raw 24 kHz PCM (not just MP3 as
   the guide shows). First audio **p50 0.21 s** after the text is sent, vs **p50 3.07 s** for today's `eleven_v3` in the
   same run (0.62 s p50 / 4.06 s p95 over 103 sentences in your log). Flash v2.5: 0.19 s. Audio tags appear to survive on
   v4 (it didn't read "[laughs softly]" aloud, and the clip is longer by about a laugh). **How they sound is your call:**
   open `~/Library/Application Support/ARES/voice-lab/a7/compare.html`.
3. **Today's wake word has a plain bug:** the recognisers write "Okay", so the "ok ares" phrase never matches. On clean
   Kokoro speech that alone costs 8–16 points of recall (SFSpeech 80% → 93% with it fixed; SpeechTranscriber 82% → 98%).
   The only false wake on 392 confusable sentences was "Aries is my star sign", which no acoustic detector can fix
   ("Aries" and "Ares" are the same sound): only stage 4's text check can.
4. **Your voiceprint's problem is the enrolment/live gap, not other voices.** Your six enrolment clips score 0.84 against
   each other; your live checks cluster at 0.29–0.43; the bar is 0.48. Katherine's 193 cached sentences score **0.00 p50,
   0.19 max**: nowhere near you. So a calibrated, multi-condition enrolment can lower the bar a long way before TTS
   becomes a risk.
5. **The fast path decides in 2 ms but is 85% precise** (target ~99%): 8 wrong local actions in 54 firings on clean text,
   e.g. "stop it Jake" (goes quiet), "power down the generator first" (powers down), "stop everything you're doing and
   look at this" (kill switch), "how much battery does the new iPhone have" (opens the battery readout).

## A1. Latency log (built; your 20 real turns need the next build)

- `latency.js` writes one record per turn to `<support>/latency.jsonl` (times, counts and decisions only, never words):
  speech start, wake, mic-quiet (VAD stop), last transcript change, end-of-turn decision, heard, intent, voice check,
  addressed, handle, plan, brain sent / first token / done (model, why, tools used, reply length), first sentence, TTS
  request / first byte (engine), first audio out. `node scripts/latency-report.mjs` prints p50/p95 per slice and per kind
  of turn (question, command, tool turn, long answer). Tested end to end in a dev instance.
- From your existing log, before the new stages existed:

| Slice (your log, 6–9 Oct) | n | p50 | p95 | Report's estimate |
|---|---|---|---|---|
| Brain to first text (Sonnet, ARES's session) | 25 | 3.32 s | 9.40 s | 1–2.5 s |
| ElevenLabs v3 first audio per sentence | 103 | 0.62 s | 4.06 s | ~0.76 s |
| Whole turn: start of handling → her first sound | 20 | 4.18 s | 10.0 s | 3–4.5 s |
| End of turn (the timer, by design) | — | 1.3 s + re-arms | | 1.3 s |

- In the dev instance (Kokoro, warm brain): listener → brain sent was **~20 ms** in total (intent 5 ms, plan 3 ms);
  first token → first sentence ~0.4 s; Kokoro first byte 0.44 s. The local plumbing is not the problem; the end-of-turn
  wait, the brain and v3 are.
- **Still to do:** the 20 real turns (short question, command, tool turn, long answer) through the installed app. That
  needs `npm run build` and a restart of ARES (I'll ask first).

## A2. Wake word

| | Recall | False wakes | Notes |
|---|---|---|---|
| Today's rule, SFSpeech, clean Kokoro (28 voices) | 80% | 28/392 sentences (all "Aries is my star sign") | "Okay ARES" never works; "Hey" heard as "Hell"/"Helly" |
| Same, "okay" fixed | 93% | same | |
| Today's rule on SpeechTranscriber | 82% → 98% fixed | 19/392 (same sentence) | |
| livekit-wakeword "hey ares" (trained here), its own test: 12,000 Piper clips + 24.2 h of other audio | 88.0% at 0.5 · **79.0% at 0.75** | 0.33/h at 0.5 · **0.08/h at 0.75** | ~1 MB model; DET AUT 0.0018 |
| Same model on Kokoro's 28 voices (a TTS it never saw), "Hey ARES …" lines only | **107/112 (96%) at 0.75** | 9/392 (6 "Aries is my star sign", 3 "Hey, Harry's here!") | bare "ARES, …" and "Okay ARES" low by design (not trained) |
| Today's regex on the same "Hey ARES …" lines | 102/112 (91%) | 28/392 | |
| sherpa-onnx KWS "HEY ARES" | *pending session* | | tokenised `▁HE Y ▁ARE S`, no training |
| Report *(livekit vendor)* | 86.1% | 0.08/h | on "hey livekit" |

- Training data: livekit's 2,000 h of negative features (16 GB), MUSAN noise, RIRs, Piper's 904 voices. Negatives from
  ARES's confusions (Harris, Paris, heiress, erase, ears, Iris, Harry's, areas…); **not "Aries"**, which espeak renders
  identically to "Ares" (`'e@ri:z`).
- Training took ~2.5 h on this Mac (synthesis ~1.5 h, augmentation/features ~30 min, 60,000 steps ~1 h at ~15 steps/s).
- **Still to do:** your session (0.5 / 1 / 3 m, music, TV, while she talks), then a retrain with your own takes added to
  the positives (all training voices are synthetic and US-accented), and a "Harry's" / "hey Harry" negative added.

## A3. Voice trust

- TitaNet-small (today), Katherine vs your voiceprint: p50 0.00, p95 0.09, max 0.19 (threshold 0.48). Enrolment
  leave-one-out: 0.84. Your Voice ID log has only two labelled-for-sure samples (push-to-talk: 0.705 and 0.103), and the
  voiceprint was re-enrolled on 8 Oct, so older log scores were against a different print: not usable as labels.
- Models ready to compare (sherpa-onnx, all local): TitaNet-small/large, WeSpeaker CAM++ LM, ResNet221/293 LM, 3D-Speaker
  CAM++ and ERes2Net (English), ERes2NetV2 (Chinese-trained, as asked). ECAPA isn't in sherpa-onnx's release; skipped.
- Scoring variants ready: whole utterance with < 1 s = no evidence, centroid vs top-3 of all enrolment vectors, desk-only
  vs multi-condition enrolment, AS-norm (cohort = Kokoro voices), FRR at 1% and 5% FAR by length, distance, music, TV.
- **Still to do:** your session (owner side) and its 3-minute "other voices" block (features kept, audio deleted).

## A4. Hearing

| Engine | On device here | Notes |
|---|---|---|
| SFSpeechRecognizer (today) | en-GB, en-US (no en-IN on device) | contextual strings; custom LM with X-SAMPA "E@ r i: z" built OK |
| SpeechTranscriber (macOS 26) | en-GB, en-IN, en-US, … all installed | needs one long pass, not per file (per-file set-up stalls) |
| Parakeet TDT v2 / v3 (FluidAudio) | yes, ~0.45 s per command warm | vocabulary aliases **over-fire** on short commands unless the acoustic rescue is off ("set a timer for ARES"); with `--vocab-disable-spotter-rescue`, "Aries" → ARES and nothing else changes |

- **Still to do:** WER, names and latency on your 50–100 commands near and far (`score-session.mjs`).

## A5. End of turn

- Silero VAD v6 + Smart Turn v3.2 (8.7 MB) + transcript cues + 3 s cap vs silence timers, eot-bench style (silence needed
  for ≤ 5% / ≤ 10% cut-offs, latency at true ends). Pipeline built (`eot.py`); **pending your "thinking out loud" lines**.

## A6. Echo

- `echo-test.mjs` plays a passage from another process (`afplay`, the same situation as the window or a browser) and
  from the engine itself, voice processing on and off, and reports echo reduction in dB and how many of her words the
  recogniser still hears. **Not run: waiting for your go** (audible for ~3 minutes, ARES muted).

## A7. Voice model and brain (done)

| Line | v3 HTTPS (today) | Flash v2.5 HTTPS | v4 Turbo socket |
|---|---|---|---|
| first audio p50 / max | 3.07 s / 5.23 s | 0.19 s / 0.28 s | 0.21 s / 0.31 s (+0.3–0.9 s to open the socket, done at turn start) |

| Brain, 10 quick turns, same session | cold | warm p50 | warm p95 | done p50 |
|---|---|---|---|---|
| Sonnet 5.5 (default; two runs) | 1.5 s | 0.76–1.03 s | 1.8–2.2 s | 2.2–2.4 s |
| `haiku` alias = Haiku 4.5 (today's quick route) | 4.7 s | 1.72 s | 8.5 s | 2.7 s |
| Haiku 5.5 (`claude-haiku-5-5`) | 0.97 s | **0.51 s** | 1.05 s | 1.65 s |

- The prompt cache works across model switches (each model keeps its own ~60k-token prefix warm), so per-turn routing
  doesn't throw the cache away. The prefix is ~60k tokens with 139 tools: trimming tools is still worth measuring in B6.
- Credits: the counter showed 123 for the 15 clips right after the run; expected ~500 (v3 1/char, the others ½). Will
  re-read.

## A8. Intent (done)

154 labelled utterances (remarks, listening controls, Mac actions, personal data, questions, 26 deliberate negatives) plus
454 noisy-transcript variants (`scripts/voice-lab/intent-set.mjs`).

| Today | Clean | Noisy variants |
|---|---|---|
| Fast-path precision (target ~99%) | 46/54 (85%) | 88/108 (81%) |
| Fast-path recall (things it should catch) | 46/51 | 88/135 |
| Negatives that fired | 6/26 | 14/90 |
| Router picks the labelled model | 55/70 | 134/216 |
| Desk mode, overheard: answers commands/questions meant for her | 50/93 | |
| Desk mode, overheard: answers things not for her | 6/22 | 13/76 |
| Decision latency | 1.9 ms p50, 2.4 ms p95 | |

Every Mac action (timers, volume, apps, media) goes to the brain today: no tier-0/1 fast path yet.

## Picks so far (provisional where marked)

- **A7 TTS:** `eleven_v4_turbo` over the dialogue socket, PCM 24 kHz, socket opened at turn start; Flash v2.5 then Kokoro
  as fallbacks. *Subject to your ears on compare.html.*
- **A7 brain:** Haiku 5.5 for quick turns; needs the Claude Code update / model override; Sonnet stays the default.
- **A8:** fix the eight wrong fast actions first (anchor kill/power phrases to being addressed, battery readout only for
  "my battery", "stop it <name>" → not for her), then the B13 registry.
- **A2 (provisional):** the trained livekit-wakeword "hey ares" model as stage 1 at ~0.75, with sherpa KWS (respelled
  "HEY AIRES") as the stage-2 check and the text check for "Aries…"; fix "okay" in today's rule meanwhile. Confirm on
  your recordings (accent, 3 m, TV, while she talks) before committing.
- **A3–A6:** pending your session and the echo test.

## Wave plan, adjusted

*(to be finalised with the session numbers)*
