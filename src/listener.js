// Runs the native ares-listener helper (on-device "Hey ARES" wake word) and relays its events.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class WakeListener extends EventEmitter {
  constructor(binPath, wakePhrases = []) {
    super();
    this.bin = binPath;
    this.wakePhrases = wakePhrases;
    this.child = null;
    this.muted = false;
    this.awake = false;
    this.muteTimer = null;
    this.muteUntil = null;
    this.restarts = 0;
    this.stopped = false;
    this.ready = false;
  }

  /** Echo cancellation is running, so the user can talk over ARES while she speaks. */
  get canBarge() {
    return Boolean(this.child) && this.ready && !this.muted && process.env.ARES_ECHO_CANCEL !== '0';
  }

  /** ARES's voice can also play through the listener itself. Off by default: macOS voice processing
   *  degrades that output to crackly call quality, and it cancels the window's audio just as well. */
  get canPlay() {
    return this.canBarge && process.env.ARES_NATIVE_PLAYBACK === '1';
  }

  get available() {
    return fs.existsSync(this.bin);
  }

  start() {
    if (!this.available || this.child) return;
    this.stopped = false;
    const args = this.wakePhrases.flatMap((p) => ['--wake', p]);
    if (process.env.ARES_DEBUG_HEARING === '1') args.push('--debug');
    if (process.env.ARES_END_SILENCE_MS) args.push('--end-silence', process.env.ARES_END_SILENCE_MS);
    if (process.env.ARES_ECHO_CANCEL === '0') args.push('--no-aec');
    if (this.muted) args.push('--muted'); // the engine stays off until unmute (no device glitch under a power sound)
    this.child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', (err) => { if (err.code !== 'EPIPE') this.emit('stderr', `stdin: ${err.message}`); });
    let buf = '';
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { this.onEvent(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
    });
    this.child.stderr.on('data', (d) => this.emit('stderr', String(d).trim()));
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.ready = false;
      this.emit('stderr', `listener exited code=${code} signal=${signal}`);
      if (this.stopped) return;
      // Crashed: restart with backoff, but give up if it keeps dying (e.g. permissions revoked).
      if (++this.restarts > 5) return this.emit('event', { type: 'error', code: 'crashed', message: `listener exited (${code})` });
      setTimeout(() => this.start(), 1000 * this.restarts);
    });
    this.send(this.muted ? 'start\nmute' : 'start');
    if (this.awake) this.send('awake on');
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  onEvent(evt) {
    if (evt.type === 'ready') { this.restarts = 0; this.ready = true; }
    if (evt.type === 'error' && evt.code === 'aec') process.env.ARES_ECHO_CANCEL = '0';
    if (evt.type === 'ready' && this.muted && !this.child?.spawnargs?.includes('--muted')) this.send('mute');
    if (evt.type === 'ready') this.send('micmode'); // which Apple mic mode is in use, for the log
    this.emit('event', evt);
  }

  send(cmd) {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return; // (stopped or gone: a write would raise EPIPE and take the main process with it)
    try { stdin.write(cmd + '\n', (err) => { if (err && err.code !== 'EPIPE') this.emit('stderr', `stdin: ${err.message}`); }); } catch {}
  }

  /** Mute the mic entirely (the orange dot goes away). minutes = null means until unmuted. */
  mute(minutes = null) {
    this.muted = true;
    if (this.awake) { this.awake = false; this.send('awake off'); }
    clearTimeout(this.muteTimer);
    this.muteUntil = minutes ? Date.now() + minutes * 60_000 : null;
    if (minutes) this.muteTimer = setTimeout(() => this.unmute(), minutes * 60_000);
    this.send('mute');
    this.emit('state');
  }

  unmute() {
    this.muted = false;
    clearTimeout(this.muteTimer);
    this.muteUntil = null;
    this.send('unmute');
    this.emit('state');
  }

  /** Capture a command without needing the wake word. trusted = push-to-talk (skips voice ID). */
  listen(ms = 6000, trusted = false) {
    if (this.muted) this.unmute();
    this.send(`listen ${ms}${trusted ? ' trusted' : ''}`);
  }

  /** Record one enrollment sample; resolves with the listener's "recording" event. */
  record(ms = 7000) {
    return new Promise((resolve) => {
      const onEvent = (evt) => {
        if (evt.type !== 'recording') return;
        this.off('event', onEvent);
        resolve(evt);
      };
      this.on('event', onEvent);
      if (this.muted) this.unmute();
      this.send(`record ${ms}`);
    });
  }

  /** Always-listening mode: every utterance is treated as a command (no wake word needed). */
  setAwake(on) {
    if (on && this.muted) this.unmute();
    this.awake = on;
    this.send(`awake ${on ? 'on' : 'off'}`);
    this.emit('state');
  }

  // ARES's voice
  clip(id) { this.send(`clip ${id}`); }
  play(id, chunk) { this.send(`play ${id} ${Buffer.from(chunk).toString('base64')}`); }
  playEnd(id) { this.send(`playend ${id}`); }
  stopPlay() { this.send('stopplay'); }
  /** While ARES talks, listen for the user cutting in (barge-in). */
  speaking(on) { if (!this.muted) this.send(`speaking ${on ? 'on' : 'off'}`); }
  barge(accept) { this.send(`barge ${accept ? 'yes' : 'no'}`); }

  pause() { if (!this.muted) this.send('pause'); }
  resume() { if (!this.muted) this.send('resume'); }
}

function listenerPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ares-listener')
    : path.join(__dirname, '..', 'native', 'build', 'ares-listener');
}

module.exports = { WakeListener, listenerPath };
