// Voicemails left on the ARES line's Twilio fallback ("Primary handler fails" -> a TwiML Bin that records a
// message), for when the ElevenLabs agent can't take a call (credits exhausted or an outage). Read-only Twilio REST
// calls with the keys from the .env; nothing here touches the agent, the number's primary webhook or calls.js.
// Each new voicemail is saved to calls/voicemail/, transcribed when possible, and reported like a missed call.
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const POLL_MS = 10 * 60_000;

class Voicemail extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir                calls folder
   * @param {Function} o.log
   * @param {() => string} o.number       the ARES line (E.164), to tell its voicemails from any other recordings
   * @param {(audio: Buffer, type: string) => Promise<string>} o.transcribe
   * @param {(n: string) => string} o.contactByNumber
   */
  constructor({ dir, log, number, transcribe, contactByNumber }) {
    super();
    this.dir = path.join(dir, 'voicemail');
    this.log = log;
    this.number = () => (number() || '').replace(/[^\d+]/g, '');
    this.transcribe = transcribe;
    this.contactByNumber = contactByNumber;
    this.sid = process.env.TWILIO_ACCOUNT_SID;
    // An API key (SK…) + secret is preferred; the account auth token also works
    this.user = process.env.TWILIO_API_KEY_SID || this.sid;
    this.secret = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
    this.stateFile = path.join(this.dir, 'state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { this.state = null; }
  }

  get ready() { return Boolean(this.sid && this.user && this.secret); }

  start() {
    if (!this.ready) return this.log('voicemail off', 'no Twilio keys (TWILIO_ACCOUNT_SID + TWILIO_API_KEY_SID/SECRET)');
    fs.mkdirSync(this.dir, { recursive: true });
    this.check('start');
    this.timer = setInterval(() => this.check('poll'), POLL_MS);
  }
  stop() { clearInterval(this.timer); }

  async #get(url, raw = false) {
    const res = await fetch(url.startsWith('http') ? url : `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/${url}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.user}:${this.secret}`).toString('base64')}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }

  async check(why) {
    if (!this.ready || this.checking) return;
    this.checking = true;
    try {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const { recordings = [] } = await this.#get(`Recordings.json?DateCreated%3E=${since}&PageSize=50`);
      const first = !this.state; // first run: what's already there is old news
      this.state ||= { seen: [] };
      const fresh = recordings.filter((r) => r.status === 'completed' && !this.state.seen.includes(r.sid)).reverse();
      for (const r of fresh) {
        this.state.seen.push(r.sid);
        if (first) continue;
        const call = await this.#get(`Calls/${r.call_sid}.json`).catch(() => null);
        if (this.number() && call && call.to?.replace(/[^\d+]/g, '') !== this.number()) continue; // not the ARES line
        await this.#report(r, call);
      }
      this.state.seen = this.state.seen.slice(-500);
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
      if (fresh.length) this.log('voicemail check', { why, fresh: fresh.length, imported: first });
    } catch (err) {
      this.log('voicemail check failed', err.message);
    } finally {
      this.checking = false;
    }
  }

  async #report(rec, call) {
    const from = call?.from || '';
    const name = (from && this.contactByNumber(from)) || from || 'an unknown number';
    const file = path.join(this.dir, `${new Date(rec.date_created).toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${rec.sid}.wav`);
    let text = '';
    try {
      const audio = await this.#get(`Recordings/${rec.sid}.wav`, true);
      fs.writeFileSync(file, audio);
      text = await this.transcribe(audio, 'audio/wav');
    } catch (err) {
      this.log('voicemail transcribe failed', err.message);
    }
    const secs = Number(rec.duration) || 0;
    const line = text
      ? `${name} left a voicemail on my line while I couldn't answer: "${text.slice(0, 300)}"`
      : `${name} left a ${secs}-second voicemail on my line while I couldn't answer. It's in the calls folder.`;
    this.log('voicemail', { sid: rec.sid, secs, transcribed: Boolean(text) });
    this.emit('voicemail', { from, name, text, secs, file, line, title: `Voicemail from ${name}`, body: text || `${secs}s voicemail (not transcribed)` });
  }
}

module.exports = { Voicemail };
