# ARES

My personal assistant. ARES lives on my Mac, follows me to my phone, and answers my phone line when I can't.
I talk to her by voice ("hey ARES"), type to her, or message her, and she gets things done on the Mac for me.

This is a personal project, built for one person (me) on my own machines. It isn't a product and isn't set up
for anyone else to install. I design it, make the product decisions, and test and debug it; Claude Code writes
most of the code under my direction.

## How it fits together

**Talking to her.** Every way I reach her ends up at the same brain on the Mac. Grey boxes are outside services.

```mermaid
flowchart TB
  desk(["Me at the desk<br/><i>“hey ARES”</i>"])
  phone(["Me on my phone<br/><i>ARES Android app</i>"])
  tg(["Me on Telegram"])

  subgraph mac["My Mac · the ARES app"]
    ears["Ears<br/>wake word · speech · voice ID<br/><i>on-device</i>"]
    phonesrv["Phone server"]
    brain{{"Brain · intent router"}}
    tools["Mac tools<br/>files · apps · UI · OCR<br/>Calendar + Reminders"]
    jobs["Background work<br/>jobs · projects · routines"]
    voice["Voice<br/>sentence by sentence"]
    kokoro["Kokoro<br/><i>local backup voice</i>"]
  end

  claude["Claude<br/><i>Claude Code CLI</i>"]
  gtasks["Google Tasks"]
  web["Web tools<br/>Playwright · Firecrawl · Unsplash"]
  eleven["ElevenLabs TTS<br/><i>Katherine</i>"]

  desk --> ears --> brain
  phone -- "Tailscale" --> phonesrv --> brain
  tg -- "bot" --> brain
  brain <--> claude
  brain --> tools --> gtasks
  brain --> jobs --> web
  jobs <--> claude
  brain --> voice --> eleven
  voice -. "if slow or offline" .-> kokoro

  classDef ext fill:#f4f4f5,stroke:#a1a1aa,color:#18181b
  class claude,eleven,web,gtasks ext
```

**My phone line and notifications.** The phone line runs in the cloud, so it works even when the Mac is off.

```mermaid
flowchart TB
  caller(["Someone calls me"])
  twilio["Twilio number"]
  agent["ElevenLabs agent<br/><i>ARES Calls · Hope</i>"]
  vm["TwiML voicemail"]
  mac["ARES on my Mac"]
  relay["Cloudflare Worker relay"]
  fcm["Firebase Cloud Messaging"]
  phone["ARES Android app"]

  caller --> twilio --> agent
  twilio -. "agent can't answer" .-> vm
  mac -- "context · outbound calls" --> agent
  agent -- "after each call" --> relay
  vm -. "fetched + transcribed" .-> mac
  mac -- "pushes" --> relay --> fcm --> phone

  classDef ext fill:#f4f4f5,stroke:#a1a1aa,color:#18181b
  class twilio,agent,vm,relay,fcm ext
```

Everything the Mac does goes out over HTTPS; nothing on the internet can connect in. The phone reaches the Mac
only through my own Tailscale network.

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
  live job progress in the status bar, and approvals with my fingerprint.
- **Answers my phone.** A separate ElevenLabs agent on a Twilio number takes calls when I can't, sends me the caller,
  topic and callback number, and can place calls for me. If the agent is down, callers get a voicemail and ARES
  transcribes it.
- **Has a look.** An arc-reactor interface with panels for the calendar, tasks and jobs, plus power states: standby,
  power down and a charge-up on wake, mirrored on the phone.

## What's in the repo

| Folder | What |
|---|---|
| `src/` | The Mac app (Electron: Node.js + Chromium). `main.js` and the other files hold the services; `renderer/` is the interface, `tools/` the brain's tools, `phone/` the phone's web page. |
| `native/` | Swift helpers: the microphone and wake word, Mac control (Accessibility, input, OCR), calendar/EventKit, camera, and the start-up screen. |
| `android/` | The Android app and launcher (Kotlin). See [android/README.md](android/README.md). |
| `relay/` | The Cloudflare Worker for push notifications and waking the Mac. See [relay/README.md](relay/README.md). |
| `scripts/` | Build scripts and tests. |
| `models/` | The small on-device models (intents, voice ID). The big ones are downloaded, not committed. |
| `docs/` | The design brief for each feature (`docs/*-prompt.md`). `CLAUDE.md` has the working notes. |

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
