// Remote access: a private Telegram bot that lets the owner text or voice-note ARES from anywhere.
// Long-polls the Bot API (no inbound ports, no webhooks). Only the paired owner's account is answered.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const API = process.env.TELEGRAM_API || 'https://api.telegram.org'; // overridable for tests
const MAX_TEXT = 4000; // Telegram's limit is 4096

class TelegramRemote extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.token      bot token from @BotFather
   * @param {number|null} o.ownerId  paired Telegram user id (null = not paired yet)
   * @param {(msg: {text: string, voice: boolean}) => Promise<{text: string, audio?: Buffer}>} o.onMessage
   * @param {(buf: Buffer) => Promise<string>} o.transcribe
   * @param {Function} o.log
   */
  constructor({ token, ownerId, onMessage, transcribe, log }) {
    super();
    this.token = token;
    this.ownerId = ownerId || null;
    this.onMessage = onMessage;
    this.transcribe = transcribe;
    this.log = log;
    this.offset = 0;
    this.running = false;
    this.pairCode = this.ownerId ? null : String(crypto.randomInt(100000, 999999));
  }

  async call(method, params = {}, { signal } = {}) {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
    return json.result;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    try {
      this.me = await this.call('getMe');
      this.log('telegram', { bot: this.me.username, paired: Boolean(this.ownerId) });
      this.emit('ready', { bot: this.me.username, paired: Boolean(this.ownerId), code: this.pairCode });
    } catch (err) {
      this.running = false;
      this.log('telegram error', err.message);
      this.emit('error', err);
      return;
    }
    this.poll();
  }

  stop() {
    this.running = false;
    this.abort?.abort();
  }

  async poll() {
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message'] }, { signal: this.abort.signal });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) this.handle(u.message).catch((err) => this.log('telegram error', err.message));
        }
      } catch (err) {
        if (!this.running) return;
        this.log('telegram poll error', err.message);
        await new Promise((r) => setTimeout(r, 5000)); // offline / asleep: retry
      }
    }
  }

  async handle(msg) {
    const from = msg.from?.id;
    const chat = msg.chat.id;
    const text = (msg.text || '').trim();

    // Pairing: the first person to send the code shown on the Mac becomes the owner
    if (!this.ownerId) {
      if (this.pairCode && text.replace(/\D/g, '') === this.pairCode && msg.chat.type === 'private') {
        this.ownerId = from;
        this.pairCode = null;
        this.emit('paired', { id: from, name: msg.from.first_name });
        return this.send(chat, "Paired. Good to hear from you, sir. Text me or send a voice note whenever you're away from the Mac.");
      }
      return this.send(chat, 'This is a private assistant. To pair, send the six-digit code shown in the ARES window on your Mac.');
    }
    if (from !== this.ownerId || msg.chat.type !== 'private') {
      this.log('telegram ignored', { from });
      return; // strangers get nothing
    }

    if (text === '/start') return this.send(chat, "At your service, sir. Text me or send a voice note.");

    let input = text;
    const voice = Boolean(msg.voice || msg.audio);
    const typing = setInterval(() => this.call('sendChatAction', { chat_id: chat, action: voice ? 'record_voice' : 'typing' }).catch(() => {}), 4500);
    this.call('sendChatAction', { chat_id: chat, action: voice ? 'record_voice' : 'typing' }).catch(() => {});
    try {
      if (voice) {
        const file = await this.call('getFile', { file_id: (msg.voice || msg.audio).file_id });
        const res = await fetch(`${API}/file/bot${this.token}/${file.file_path}`);
        input = await this.transcribe(Buffer.from(await res.arrayBuffer()));
        if (!input) return this.send(chat, "Sorry, sir, I couldn't make that out. Mind trying again?");
      }
      if (!input) return;

      const reply = await this.onMessage({ text: input, voice });
      if (reply.audio) await this.sendVoice(chat, reply.audio, reply.text, reply.audioType);
      else await this.send(chat, reply.text);
    } finally {
      clearInterval(typing);
    }
  }

  async send(chat, text) {
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      await this.call('sendMessage', { chat_id: chat, text: text.slice(i, i + MAX_TEXT) });
    }
  }

  /** `type`: Ogg/Opus from ElevenLabs, or M4A from the backup voice (Telegram accepts both as voice notes). */
  async sendVoice(chat, audio, caption, type = 'audio/ogg') {
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append('voice', new Blob([audio], { type }), type === 'audio/mp4' ? 'ares.m4a' : 'ares.ogg');
    if (caption && caption.length <= 1000) form.append('caption', caption);
    const res = await fetch(`${API}/bot${this.token}/sendVoice`, { method: 'POST', body: form });
    const json = await res.json();
    if (!json.ok) throw new Error(`sendVoice: ${json.description}`);
    if (caption && caption.length > 1000) await this.send(chat, caption);
  }
}

module.exports = { TelegramRemote };
