Add a FREE local voice fallback + ElevenLabs credit savers to ARES. I've used a lot of my ElevenLabs credits building and testing. See the project notes. Do this in small, committed steps (if the project is a git repo; if not, do STEP 0 from docs/wallpaper-prompt.md first).

HARD RULES:
- Free and local only for the fallback. No new paid services.
- Do NOT clone Katherine or any ElevenLabs library voice (licensing/voice-actor rights). Use Kokoro's own voices.
- Keys never in chat. Never break the phone calls (see section 6).

1. LOCAL NEURAL VOICE: Kokoro via sherpa-onnx
- ARES already ships sherpa-onnx-node (used for Voice ID). Use its OfflineTts with a Kokoro model (Apache-2.0).
  - Download the model once into the ARES support folder (tell me the size first). Verify the licence.
  - Bundle-or-download logic in the build, like the speaker model.
- Render 3–4 samples of the British female voices (e.g. bf_emma, bf_isabella, bf_alice, bf_lily) saying a typical ARES line, and let me pick one. Setting ARES_LOCAL_VOICE, plus a speed setting (~1.0–1.1).
- Output 24 kHz 16-bit PCM, the same format as the ElevenLabs pcm_24000 stream, so it plugs into the existing sentence pipeline, native/renderer playback, the phone /api/ask audio stream, the Android app and Telegram voice notes (via the existing encoder) without changes downstream.
- Run synthesis off the main thread (a worker or child process), sentence by sentence, streaming as each finishes; measure first-audio latency (target < 400 ms on this Mac).
- Strip ElevenLabs-only [delivery cues] before sending text to Kokoro.
- Replace the old macOS fallback (Daniel, a MALE voice, wrong) with Kokoro. If Kokoro is unavailable, fall back to the best installed British FEMALE system voice (prefer the Premium/Enhanced ones, e.g. Serena/Kate/Stephanie, and tell me how to download one).

2. AUTOMATIC FALLBACK (seamless)
- The TTS layer tries ElevenLabs first. On quota exhausted (401/402/quota_exceeded messages), the character limit reached, repeated 429s, network failure or a timeout, it switches to Kokoro for that sentence and onwards: no silence, no error spoken.
- It retries ElevenLabs periodically (and at the credit reset) and switches back automatically.
- Tell me ONCE (status pill + menu bar + a short spoken note: "I'm on my backup voice until the credits reset"), not on every sentence.

3. BUDGET MODE (setting: off / auto / always)
- Katherine for substantive replies (answers, briefings, anything over ~12 words or with information); Kokoro for fillers and acknowledgements ("One moment.", "Done.", "Timer's set.", "Let me check.").
- AUTO = turn budget mode on when the credits are low (see 5) and near the end of the billing period.
- Easy to change: a "Budget voice" submenu in the ◉ tray menu (Off / Auto / Always, with a checkmark on the current one), a status line showing when AUTO has kicked in, and voice commands ("budget mode on/off/auto"). Persist it in settings. Default: Auto.

4. PHRASE CACHE (saves credits at zero quality cost)
- Cache generated Katherine audio for frequent short lines (the greeting variants, "One moment, sir.", "Let me check.", "Done.", timer/confirmation phrases, refusals), keyed by text + voice + model + speed + settings.
- Cache on disk in the support folder with a size cap (LRU) and invalidation when voice settings change. Replay from the cache instead of calling ElevenLabs.
- Log the cache hit rate.

5. CREDIT WATCH
- Read the usage from GET /v1/user/subscription (walk me through enabling that permission on my API key if it's missing; the key currently can't read it) on start and every ~30 min, plus local counting of characters sent.
- Warn at 80% and 95% (status pill, menu bar, phone), show "credits left / reset date" in the status details, and trigger budget mode AUTO.
- Keep a RESERVE for phone calls (section 6): e.g. switch the Mac/phone-app voice fully to Kokoro when the remaining credits drop below a reserve I set (default: enough for ~60 call minutes), so ARES's own talking never eats the phone line's budget.

6. PHONE CALLS MUST NOT BREAK (ElevenLabs Agents + Twilio)
- The phone agent ("ARES Calls", Hope voice) runs entirely in ElevenLabs' cloud and CANNOT use Kokoro. Do NOT modify the agent's voice/model/config, the Twilio number, or the call integration code paths as part of this work. Local fallback applies only to ARES's own speech (Mac, phone app, Telegram).
- Check whether agent call minutes and TTS characters share the same credit pool on my plan (read the subscription API / ElevenLabs docs) and set the reserve accordingly.
- Safety net for when ElevenLabs can't take calls (credits exhausted or outage): configure a Twilio VOICE FALLBACK for the number (a TwiML Bin, free, in Twilio): a short polite message ("Dhruv's assistant is unavailable right now, please leave a message after the tone") + <Record> voicemail, so callers never hit dead air. Walk me through setting it in the Twilio console (Phone Numbers → the number → "Primary handler fails" fallback URL) without touching the primary ElevenLabs webhook. ARES's call catch-up also fetches these voicemails (recordings/transcriptions via the Twilio API, with keys from the Keychain/.env) and includes them in the digest.
- After the changes, TEST: make one inbound and one outbound call through the agent to confirm they still work exactly as before.

7. DEVELOPER MODE (stop dev sessions eating credits)
- In dev builds (and a setting "Use backup voice while I'm building/testing"), use Kokoro by default. Any test scripts/sessions that need TTS use Kokoro unless explicitly asked for Katherine.
- Document this in the repo notes/CLAUDE.md, so future Claude sessions don't spend my ElevenLabs credits on testing.

TEST: force the ElevenLabs failure (a bad key in a test run, or a simulated 401) and confirm a seamless switch to Kokoro on the Mac, the phone app and Telegram; the phrase cache hits; budget mode; the credit warnings; phone calls unaffected (one real inbound + outbound test). Build with npm run build, restart ARES and verify.
