// The Mac's side of the ARES relay (relay/worker.js on Cloudflare): register the phone's FCM token, send the
// Mac's own notifications through FCM, and ask which calls the relay already announced. Every request is
// signed with ARES_RELAY_SECRET (HMAC over time + body), and only ever goes out: nothing connects to the Mac.
// Also reads the Firebase app config the Android app needs (google-services.json in the support folder).
const crypto = require('crypto');
const fs = require('fs');

class Relay {
  constructor({ log, firebaseFile }) {
    this.url = (process.env.ARES_RELAY_URL || '').replace(/\/+$/, '');
    this.secret = process.env.ARES_RELAY_SECRET || '';
    this.log = log;
    this.firebaseFile = firebaseFile;
  }

  get ready() { return Boolean(this.url && this.secret); }

  async post(path, body, timeoutMs = 10_000) {
    if (!this.ready) throw new Error('relay not set up');
    const text = JSON.stringify(body);
    const time = String(Date.now());
    const sig = crypto.createHmac('sha256', this.secret).update(`${time}.${text}`).digest('hex');
    const res = await fetch(this.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ares-time': time, 'x-ares-sig': sig },
      body: text,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`relay ${res.status}${out.error ? `: ${out.error}` : ''}`);
    return out;
  }

  register(token, device) { return this.post('/register', { token, device }); }
  unregisterAll() { return this.post('/unregister', { all: true }); }

  /** A Mac notification to the Android app over FCM. Returns how many phones got it (0 on failure). */
  async notify({ title, body, tag, job, buttons }) {
    try {
      const data = { title, body: String(body || '').slice(0, 1500), tag, job, buttons: buttons?.length ? JSON.stringify(buttons) : undefined };
      return (await this.post('/notify', { data })).sent || 0;
    } catch (err) { this.log('relay notify failed', err.message); return 0; }
  }

  /** Which of these calls the relay already pushed to the phone. */
  async delivered(ids) {
    if (!this.ready || !ids.length) return [];
    try { return (await this.post('/delivered', { ids })).delivered || []; } catch (err) { this.log('relay delivered failed', err.message); return []; }
  }

  /** Firebase options for com.dhruv.ares from google-services.json (not secret: they identify the app), or null. */
  firebase() {
    try {
      const g = JSON.parse(fs.readFileSync(this.firebaseFile, 'utf8'));
      const client = g.client.find((c) => c.client_info?.android_client_info?.package_name === 'com.dhruv.ares') || g.client[0];
      return {
        appId: client.client_info.mobilesdk_app_id,
        apiKey: client.api_key?.[0]?.current_key,
        projectId: g.project_info.project_id,
        senderId: g.project_info.project_number,
      };
    } catch { return null; }
  }
}

module.exports = { Relay };
