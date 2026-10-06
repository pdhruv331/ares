// Desk mode (docs/live-desktop-prompt.md §4): while the user is at the Mac, ARES listens without the wake word.
//
// On when ALL of: the setting is on (default), a voiceprint exists (only the owner's voice counts without the wake
// word), the user touched the keyboard or mouse in the last few minutes (default 5), the screen is unlocked and
// awake, no other app is using the microphone (a FaceTime/Zoom/Meet/Teams/phone call, dictation, a recording), and
// they haven't told her to go quiet. "Go quiet" holds until they've been away (idle or locked) and come back.
// The listener's own always-listening mode does the hearing (on-device); main.js decides what gets answered.
const EventEmitter = require('events');

// Mic users that aren't a call: ARES herself, macOS's audio bookkeeping, and macOS's speech recognition (CoreSpeech and
// friends), which is what ARES's own listener hears through (and Siri's "Hey Siri")
const NOT_A_CALL = [/^com\.dhruv\.ares/, /^historicalaudiod$/, /^com\.github\.Electron/, /corespeech/i, /speechrecognition/i,
  /^com\.apple\.(siri|assistantd|SpeechRecognitionCore|speech)/i, /^(localspeechrecognition|speechrecognitiond|assistantd)$/];
const CALL_APPS = { 'us.zoom.xos': 'Zoom', 'com.apple.FaceTime': 'FaceTime', avconferenced: 'FaceTime', 'com.microsoft.teams2': 'Teams',
  'com.microsoft.teams': 'Teams', 'com.google.Chrome': 'Chrome (Meet?)', 'com.apple.Safari': 'Safari', 'com.tinyspeck.slackmacgap': 'Slack',
  'com.hnc.Discord': 'Discord', 'net.whatsapp.WhatsApp': 'WhatsApp', 'com.apple.mobilephone': 'Phone', 'com.apple.TelephonyUtilities': 'Phone' };

class DeskMode extends EventEmitter {
  constructor({ log, readSettings, writeSettings, voiceId, powerMonitor }) {
    super();
    Object.assign(this, { log, readSettings, writeSettings, voiceId, powerMonitor });
    this.locked = false;
    this.mic = [];
    this.quiet = false;      // "go quiet": until they've been away and back
    this.awayAt = null;
    this.state = { active: false, reason: 'starting' };
    powerMonitor.on('lock-screen', () => { this.locked = true; this.away(); this.check(); });
    powerMonitor.on('unlock-screen', () => { this.locked = false; this.check(); });
    powerMonitor.on('suspend', () => { this.away(); this.check(); });
    this.timer = setInterval(() => this.check(), 4000);
  }

  get opts() {
    const d = this.readSettings().desk || {};
    return { enabled: d.enabled !== false, idleMin: Number(d.idleMin) || 5 };
  }
  set(patch) { this.writeSettings({ desk: { ...(this.readSettings().desk || {}), ...patch } }); this.check(); }

  /** From the desktop helper: the other processes using the microphone. */
  setMic(list) {
    const calls = (list || []).filter((m) => !NOT_A_CALL.some((re) => re.test(m)));
    if (calls.join() === this.mic.join()) return;
    this.mic = calls;
    this.check();
  }

  /** "Go quiet" / "stop listening" / "go to sleep" while desk mode is on: off until they've been away and back. */
  goQuiet() { if (this.state.active) { this.quiet = true; this.log('desk mode', { quiet: true }); this.check(); } }
  /** Standby (power.js): desk mode held off while she stands by, whatever else is true. */
  hold(on) { this.held = Boolean(on); this.check(); }

  away() { this.awayAt ??= Date.now(); this.quiet = false; }

  check() {
    const o = this.opts;
    const idle = this.powerMonitor.getSystemIdleTime(); // seconds since the last keyboard or mouse input
    if (idle > o.idleMin * 60) this.away(); else this.awayAt = null;
    let reason = 'at the Mac';
    if (!o.enabled) reason = 'off';
    else if (this.held) reason = 'standby';
    else if (!this.voiceId.enrolled) reason = 'needs Voice ID';
    else if (this.locked) reason = 'locked';
    else if (idle > o.idleMin * 60) reason = 'idle';
    else if (this.mic.length) reason = CALL_APPS[this.mic[0]] ? `on a call (${CALL_APPS[this.mic[0]]})` : `${this.mic[0]} is using the mic`;
    else if (this.quiet) reason = 'told to go quiet';
    const active = reason === 'at the Mac';
    if (active === this.state.active && reason === this.state.reason) return;
    const was = this.state;
    this.state = { active, reason };
    this.log('desk mode', this.state);
    this.emit('change', this.state, was);
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { DeskMode };
