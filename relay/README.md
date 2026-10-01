# ARES relay

A tiny Cloudflare Worker (free tier) that lets call notifications reach the ARES Android app with the Mac off:

```
caller → Twilio → ElevenLabs agent ──post-call webhook (HMAC)──▶ Worker ──FCM data message──▶ ARES app
                                                                   ▲
                    Mac (outbound only, signed) ── /register, /notify, /delivered
```

- **Stores:** only the phone's push token, plus the ids of calls it has already notified (kept 7 days, so the Mac's catch-up doesn't repeat them). It never stores transcripts. Only the caller, a short summary and the callback number pass through, straight to the phone.
- **Secrets:** all three live in Cloudflare's secret store: `FCM_SERVICE_ACCOUNT`, `RELAY_SECRET` (shared with the Mac's `.env`) and `ELEVENLABS_WEBHOOK_SECRET`.
- **The Mac** still accepts no inbound connections. It only calls out to the Worker.

## Setup (about 15 minutes, once)

### 1. Firebase (free Spark plan, no billing)
1. Go to https://console.firebase.google.com → **Create a project**, name it `ares`. Turn **Google Analytics off** when asked.
2. On the project page, click the Android icon (**Add app**).
   - Package name: `com.dhruv.ares` (exactly)
   - Nickname: `ARES`
   - Leave the SHA-1 empty. Click **Register app**.
3. **Download google-services.json**. Skip the "add the SDK" steps: ARES is already built for it.
4. Click ⚙ → **Project settings** → **Service accounts** → **Generate new private key** → **Generate key**. A file like `ares-xxxxx-firebase-adminsdk-….json` downloads. It's a real key: don't share it or put it in the project folder.
5. Check that **Project settings → Cloud Messaging** shows *Firebase Cloud Messaging API (V1): Enabled* (it is by default).

### 2. Cloudflare (free)
1. Sign up at https://dash.cloudflare.com/sign-up (free plan). You don't need a domain; the Worker gets a `*.workers.dev` address.
2. On the Mac, in the ARES folder:
   ```bash
   npx wrangler login
   ```
   A browser opens: click **Allow**.

### 3. Wire it all up (one command)
```bash
node scripts/setup-relay.mjs --service-account ~/Downloads/ares-xxxxx-firebase-adminsdk-xxxxx.json --google-services ~/Downloads/google-services.json
```
This command:
- creates the KV store and deploys the Worker;
- pipes the secrets into Cloudflare (it never prints them);
- creates the ElevenLabs post-call webhook and assigns it to the ARES Calls agent (transcripts only, no audio);
- writes `ARES_RELAY_URL` and `ARES_RELAY_SECRET` to both ARES `.env` files;
- copies `google-services.json` to `~/Library/Application Support/ARES/`, where the Mac hands it to the phone app. It isn't secret: it only identifies the app.

Then **quit and reopen ARES**, and open the ARES app on the phone once. It gets the Firebase config from the Mac, and its push token goes back through the Mac to the relay. Delete the downloaded service-account file afterwards.

To replace the secrets later: `node scripts/setup-relay.mjs … --rotate`.

## Checking it
- `https://ares-relay.<you>.workers.dev/health` shows `{"ok":true,"phones":1}` once the phone is registered.
- Logs: `cd relay && npx wrangler tail`
- Call the ARES line with the Mac asleep. The notification arrives from the relay, and when the Mac wakes, its catch-up won't send it again.

## Future option (not built)
The phone agent could read Google Calendar itself: an ElevenLabs server tool pointing at a Worker route with Calendar OAuth. That would give live free/busy with the Mac off. For now the Mac pushes busy/free to the agent hourly and just before it sleeps.
