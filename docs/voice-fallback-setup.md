# Voice fallback: one-time setup

The code is done. These steps happen in web consoles, and you do them yourself. Keys never go in chat:
paste them into `.env` in the project, then run `npm run build`, which copies `.env` to the support folder.

## 1. Let ARES read your ElevenLabs credits (user_read)

Right now the API key can't read `GET /v1/user/subscription`, so ARES only counts what it sends itself.
Your phone calls aren't included in that count.

1. Open https://elevenlabs.io/app/settings/api-keys.
2. Find the key ARES uses, open **⋯ → Edit**, and set the **User** permission to **Read**
   (it shows as `user_read`). Keep everything else as it is. The phone line uses the same key, so
   don't remove any permissions.
3. Save. If your plan doesn't let you edit permissions on an existing key, create a new key with the
   same permissions plus User: Read. Put it in `.env` as `ELEVENLABS_API_KEY`, rebuild, then delete
   the old key.
4. Check: the ARES status panel shows "NNk credits left · resets <date>" instead of "key needs user_read".

## 2. Twilio voicemail fallback (no dead air when the agent can't answer)

You need two TwiML Bins, which are free. Without the second one, `<Record>` loops back into the greeting.

**Twilio Console → Develop → TwiML Bins → Create new TwiML Bin**

Bin 1, friendly name `ARES hangup`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Thank you. Goodbye.</Say>
  <Hangup/>
</Response>
```
Save it, then copy its URL (`https://handler.twilio.com/twiml/EH…`).

Bin 2, friendly name `ARES voicemail`. Replace `HANGUP_BIN_URL` with the URL from Bin 1:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Hello. Dhruv's assistant is unavailable right now. Please leave a message after the tone.</Say>
  <Record maxLength="120" timeout="5" playBeep="true" action="HANGUP_BIN_URL" />
</Response>
```
Save it and copy its URL.

**Phone Numbers → Manage → Active numbers → (the ARES number) → Voice Configuration**

- Leave **"A call comes in"** exactly as it is. That's the ElevenLabs webhook, so don't touch it.
- In **"Primary handler fails"**, choose **TwiML Bin** and pick `ARES voicemail`
  (or choose Webhook and paste Bin 2's URL, HTTP POST).
- Click **Save configuration**.

Cost: recordings are about $0.0025 per minute, and `<Say>` with a standard Polly voice is fractions of a cent.
Twilio's own transcription isn't used. ARES downloads each recording and transcribes it. That uses ElevenLabs
Scribe, so if the credits are gone you get the voicemail without a transcript, saved in the calls folder.

**Let ARES fetch voicemails:** go to Twilio Console → Account → API keys & tokens → Create API key
(Standard). In `.env`, set `TWILIO_ACCOUNT_SID` (AC…), `TWILIO_API_KEY_SID` (SK…) and
`TWILIO_API_KEY_SECRET`, then run `npm run build`. ARES checks every 10 minutes and on wake. Each
voicemail arrives as a push to your phone (with Call back / Text buttons) and a spoken note if you're
at the Mac. The audio is saved in `~/Library/Application Support/ARES/calls/voicemail/`.

The fallback isn't guaranteed to fire. Twilio uses it only when the primary handler fails: an HTTP
error, a timeout or invalid TwiML. If ElevenLabs answers the webhook normally but then can't run the
agent (for example with no credits), Twilio may never use the fallback. That's why ARES keeps a credit
reserve for calls (section 3).

**Your bins (created 2026-10-01):** `ARES hangup` and `ARES voicemail`, each at `https://handler.twilio.com/twiml/EH…`
(the full URLs are in the Twilio console under TwiML Bins).

## 3. Credits and the call reserve

ElevenLabs agent calls and TTS **share one credit pool**: the Creator plan has about 121k credits a
month, roughly 275 agent minutes. When the remaining credits drop below the reserve
(`ARES_VOICE_RESERVE_MIN`, default 60 call minutes ≈ 26k credits), ARES's own voice on the Mac, phone
app and Telegram switches to the backup voice, so the phone line keeps its budget. This needs step 1:
without `user_read`, ARES can't see what the calls used.

## 4. A better last-resort Mac voice (optional)

If Kokoro itself is ever unavailable, ARES uses the best British female macOS voice installed. Right
now that's Flo. To install a natural-sounding one:
System Settings → Accessibility → Spoken Content → System voice → **Manage Voices…** →
English (United Kingdom) → download **Serena (Premium)** (or Kate/Stephanie, Enhanced). ARES picks it
up after a restart.

## Settings at a glance

- Menu bar ◉ → **Budget Voice** → Off / Auto / Always (default Auto). Or say "budget mode on / off / auto".
- Menu bar ◉ → **Use Backup Voice While I'm Building/Testing**.
- `.env`: `ARES_LOCAL_VOICE` (bf_emma), `ARES_LOCAL_SPEED` (1.05), `ARES_VOICE_RESERVE_MIN` (60).
