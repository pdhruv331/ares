# ARES

My personal assistant. ARES lives on my Mac, follows me to my phone, and answers my phone line when I can't.
I talk to her by voice ("hey ARES"), type to her, or message her, and she gets things done on the Mac for me.

This is a personal project, built for one person (me) on my own machines. It isn't a product and isn't set up
for anyone else to install. I design it, make the product decisions, and test and debug it; Claude Code writes
most of the code under my direction.

## What she does

- **Talks.** An on-device wake word, speech recognition and voice ID (she only takes commands from me), Claude as
  the brain, and an ElevenLabs voice (Katherine) streamed sentence by sentence so she starts speaking right away.
  If ElevenLabs is slow, out of credits or offline, a free local voice (Kokoro) takes over mid-sentence.
- **Works on the Mac.** Files in my folders, windows, apps, the calendar and reminders, OCR and PDFs, and step-by-step
  UI automation. Each action has a tier: simple things she just does; risky ones (sending, deleting, paying) wait
  for my own "yes", and everything goes in an audit log.
- **Runs jobs in the background.** Research and writing jobs, whole coding projects in their own folders (checked
  against a definition of done before she calls them finished), multi-step goals, and routines on a schedule. One
  phrase, "stop everything", pauses all of it.
- **Keeps an eye on my Claude Code sessions.** She tells me when a session finishes or needs an answer, and I can
  reply from my phone.
- **Is on my phone.** A native Android app and home-screen launcher: a floating bubble, hold-to-talk, cards,
  live job progress in the status bar, and approvals with my fingerprint. The phone talks to the Mac over my
  private Tailscale network.
- **Answers my phone.** A separate ElevenLabs agent on a Twilio number takes calls when I can't, sends me the caller,
  topic and callback number, and can place calls for me. If the agent is down, callers get a voicemail and ARES
  transcribes it.
- **Has a look.** An arc-reactor interface with panels for the calendar, tasks and jobs, plus power states: standby,
  power down and a charge-up on wake, mirrored on the phone.

## How it's built

| Part | Where | What |
|---|---|---|
| Mac app | `main.js`, `*.js`, `renderer/` | Electron (Node.js + Chromium). The main process holds the services; `renderer/` is the interface. |
| Brain | `claude.js`, `bridge.js`, `tools/` | Claude through the Claude Code CLI on my own subscription. Tools reach the Mac through a local bridge. |
| Native helpers | `native/` | Swift: the microphone and wake word, Mac control (Accessibility, input, OCR), calendar/EventKit, camera, and the start-up screen. |
| Voice | `voice.js`, `kokoro-worker.js`, `voiceid.js` | ElevenLabs streaming TTS, the local Kokoro voice, and voice ID. Every engine outputs the same 24 kHz PCM. |
| Phone server | `phone.js`, `phone/` | Pairing, streamed answers, live events and file sharing for the phone. Paired devices only. |
| Android app | `android/` | Kotlin: the app, the launcher, the bubble, widgets, notifications. See [android/README.md](android/README.md). |
| Relay | `relay/` | A small Cloudflare Worker for push notifications and waking the Mac while ARES is off. See [relay/README.md](relay/README.md). |
| Phone line | `calls.js`, `voicemail.js` | The ElevenLabs agent and the Twilio voicemail fallback. |
| Docs | `docs/`, `CLAUDE.md` | The design brief for each feature (`docs/*-prompt.md`) and the working notes. |

## Running it

On my Mac (Apple silicon):

```bash
npm install
cp .env.example .env    # then fill in the keys I use
npm start               # a development build; it speaks with the free local voice
npm run build           # builds, signs and installs ARES.app
```

It needs the Xcode command-line tools (for the Swift helpers), Node.js, and the Claude Code CLI signed in.
ElevenLabs, Twilio, Telegram and the relay are optional: anything without a key is simply switched off.
The backup voice model is downloaded once by `scripts/get-voice-model.sh`.

Tests live in `scripts/test-*.js`. They use fakes and mocks, so they don't spend Claude usage or ElevenLabs credits.

## Privacy

- Listening, the wake word and voice ID stay on the Mac. Speech that isn't meant for her is never stored or sent anywhere.
- The Mac accepts no connections from the internet. The phone reaches it over Tailscale; everything else goes out over HTTPS.
- Keys live in `.env` (never committed) and the macOS Keychain. Session text sent to my phone is cleaned by `redact.js` first.
- Phone calls are kept as transcripts only, with no audio recorded.
