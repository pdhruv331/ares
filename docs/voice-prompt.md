VOICE v2: make talking to ARES effortless. ONE listening mode (desk mode, perfected), a REAL "Hey ARES" detector, TRUST instead of the Voice ID hassle, better hearing, faster answers and a natural conversation flow. See CLAUDE.md (live desktop and desk mode, ignition: the ears open after the wake, the corner orb's push-to-talk) and the project notes. Read first: native/AresListener.swift (SFSpeech en-GB, the wake phrase regex over transcripts, awake mode, silence timers, VPIO), listener.js, desk.js, addressed.js (regex rules), voiceid.js (TitaNet small via sherpa-onnx, learn), intent.js, router.js, claude.js (the brain session), voice.js (ElevenLabs eleven_v3 at 1.1x, Kokoro fallback, phrase cache), main.js (the listening menu items, onBarge, KILL_PHRASE, "go quiet"), renderer/comms.js (captions). Commit after each working step.

HARD RULES
- Audio never leaves the Mac for listening/wake/trust/turn-taking (all on-device). ElevenLabs is only for her voice, as now.
- Overheard speech (not for her) is never logged as text, sent to the brain or shown, as now. Test recordings only with my go, stored locally under <support>/voice-lab, deleted when the work is done.
- Don't touch the phone line (CLAUDE.md). Dev/test speech uses Kokoro or mocks; never loop real ElevenLabs requests. Only A/B Katherine models with my go, a handful of short lines.
- Claude subscription only.

STAGE A: MEASURE AND DECIDE (report to me before building B)
A1. Instrument the whole loop with timestamps (local log, no transcript text for overheard speech): speech start, speech end (VAD), endpoint decision, final transcript, wake detected, trust decision, brain first token, first sentence ready, TTS first byte, first audio out. Report median and p90 for 20 real turns (short questions, a command, a long answer).
A2. Wake word: measure the current "Hey ARES" at my desk (normal voice, 1 m and 3 m, music on, while she's speaking): detection rate and false wakes per hour (an hour of YouTube/TV/podcast audio played through the speakers and from another device). Then compare candidates on the SAME recordings:
  - sherpa-onnx open-vocabulary keyword spotting (KWS zipformer; we already ship sherpa-onnx) with "HEY ARES" and "ARES" variants, tuned thresholds/boosting;
  - an openWakeWord-style custom model trained for "hey ares" from SYNTHETIC samples (Kokoro voices + varied speeds/pitches + noise/reverb augmentation; plus my own ~30 recordings), run in a small native or onnxruntime process;
  - (only to compare; needs an account/key) Picovoice Porcupine custom keyword. Tell me before creating any account.
  - the current transcript regex, with fuzzy variants (aries, ayres, harris, a res, iris…) as a baseline/fallback.
A3. Trust: measure today's Voice ID on my real speech (accept rate, short vs long utterances, near vs far, while music plays) and on other voices (podcast/TV). Compare a bigger embedding model (TitaNet-large, ECAPA-TDNN, CAM++/ERes2Net via sherpa-onnx), score normalisation (cohort/AS-norm) and scoring over the whole utterance instead of a clip. Also measure simple near-field cues: level/SNR and direct-to-reverberant estimate (me at the Mac vs a TV across the room), and whether the Mac's own playback correlates with the mic (the AEC reference) to reject audio the Mac itself is playing.
A4. Hearing: on ~50 sentences I read (my accent; names like ARES, Dhruv, my projects, app names), compare word error rate and latency for: Apple on-device in en-GB vs en-IN vs en-US; NVIDIA Parakeet (TDT, via sherpa-onnx) on Apple Silicon; Whisper large-v3-turbo (whisper.cpp + Core ML) as a final pass; Moonshine if streaming helps. Contextual strings / hotwords for names in each.
A5. Turn-taking: compare the fixed silence timeout with a semantic end-of-turn model (e.g. Pipecat's open "smart-turn" or LiveKit's turn detector, run locally) on my recordings with natural mid-sentence pauses: how often each cuts me off vs waits too long.
A6. Voice model: time-to-first-audio and cost for eleven_v3 vs eleven_flash_v2_5 (and turbo) with Katherine on 5 short lines (with my go), plus how they sound to me side by side.
REPORT: plain-words findings with the numbers, your recommendation for each of A2–A6, and what you'd change. Wait for my go.

STAGE B: BUILD (after my go; adapt to what I picked)
B1. ONE MODE. Remove the separate modes and toggles (Stay Awake, wake-word-only, the Voice ID switch, the Microphone Mode menu, Start/Stop Listening as a mode). What remains, automatically:
  - AT THE MAC (unlocked, input in the last ~5 min, not on a call): she listens continuously and answers when I'm talking to her (no wake word needed).
  - AWAY / idle / locked / on a call or in a meeting: only "Hey ARES" (or "ARES" at the start of a sentence) wakes her.
  - Always available: the corner orb's hold-to-talk, ⌥Space, "go quiet" / "stop listening" (until I'm back or say "I'm back"), one ◉ item "Mute Microphone" (a hard mute, shown in the bar).
  - Migrate existing settings silently; keep standby/ignition behaviour (ears after the wake).
B2. "HEY ARES" DETECTOR: the dedicated on-device detector picked in A2, running continuously and cheaply (it must not need SFSpeech to be running; measure CPU), with the transcript match as a fallback. It works while she is speaking (through the echo-cancelled mic) so "Hey ARES, stop" always works. Targets (from A2's numbers, agreed with me): ≥ 95% at normal voice at the desk, ≥ 85% at 3 m, ≤ 1 false wake per 8 hours of TV/music. A quiet chime + the orb/reactor pulse confirm a wake.
B3. TRUST INSTEAD OF VOICE ID (no more "voice not recognised" hassle):
  - A trust score from layered signals: near-field speech (level/SNR/reverb), me actively at the Mac (input in the last minute, unlocked), the Mac's own playback rejected via the AEC reference, a recent confident match (a session trust window of a few minutes while we're talking), and the upgraded speaker embedding as a SOFT signal (picked in A3). Optional, off by default: face presence from ARES Vision (presence only, frames never leave the helper).
  - Policy by what's asked, not a hard gate: questions, chat, reading/showing my info, timers, opening things → need only "it's me at the Mac" (near-field + present) or a voice match; tier-2 actions → a good trust score; tier-3 actions still need my explicit yes as now (on screen or phone), never voice alone.
  - When unsure she simply doesn't answer (no nagging). If it was probably me (near-field, at the Mac, borderline voice), she answers anyway for low-risk requests and quietly learns (voiceid learn's rules). A tiny "not sure that was for me" dot on the orb/reactor is enough feedback.
  - Remove the retrain nags; enrolment becomes optional and passive (it improves from confident turns). Keep "retrain my voice" by voice/menu for when I want it.
B4. HEARING: the recogniser picked in A4 (likely: fast streaming partials for responsiveness + an accurate final pass), the right locale for my accent, and a living vocabulary (names, contacts, projects, apps, recent topics) fed as contextual strings/hotwords. Never drop the first word after the wake word ("Hey ARES what's…" must keep "what's").
B5. TURN-TAKING: the semantic end-of-turn model picked in A5 decides when I'm done (short silence + "finished" = answer fast; a pause mid-thought = wait). Fallback: the current silence rule. Barge-in: my speaking over her stops her within ~200 ms (trust-checked, as today's lenient rule), and "wait / hold on / stop" always works. Follow-ups without the wake word for ~20 s after her reply, in both places (desk and away).
B6. SPEED: targets agreed from A1 (aim: first audio < 1 s after I stop for simple questions, < 1.5 s for ones that need the brain):
  - the faster endpointing above;
  - the brain session kept warm and the first sentence streamed to TTS as soon as it's complete (or a clause, if long);
  - the TTS model picked in A6 for conversational turns (e.g. Flash for speed and half the credits, v3 kept for wake lines/longer expressive answers if I prefer the sound), with the phrase cache for common lines;
  - an instant short acknowledgment from the cache ("One sec." / "On it.") only when the brain will clearly take > ~1.5 s (a tool call), never on quick answers;
  - simple intents (time, timers, volume, open X) answered by intent.js/router.js without the brain.
B7. ADDRESSED CHECK (desk mode's "is this for me?"): keep addressed.js's rules, add the trust signals and a small local classifier or the semantic turn model's features (direct question/command vs talking to someone else/thinking aloud), plus context (she just asked me something, I'm looking at the screen if Vision presence is on). When unsure, stay quiet.

TESTS
- Replays of the A recordings (wake, trust, hearing, turn-taking) as automated regression tests with pass thresholds; the harness injects speech for the brain/flow tests (CLAUDE.md); latency log before/after.
- A one-evening real trial at my desk with a short checklist (wake from across the room, TV on, a call, follow-ups, barge-in, a tier-2 action, "go quiet", away → wake word only), then fix what fails.
- Build with npm run build, ask me before restarting ARES, and tell me what to try.
