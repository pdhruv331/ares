// The power sounds in the window (docs/ignition-prompt.md §4e): short local WAVs (renderer/sounds/, made by scripts/make-sounds.js)
// played through Web Audio at a gentle level that follows the system volume. Off with the ◉ setting "Power Sounds", and silent
// in quiet hours / a Focus (the main process says: Sounds.silent). The same files play in the ignition helper through NSSound.
//
//   Sounds.play('tick')            one-shot
//   Sounds.loop('charge-hum')      a looping sound; Sounds.rate('charge-hum', 1.4) pitches it; Sounds.stop(name, fadeSec)
const Sounds = (() => {
  const NAMES = ['tick', 'hold-rise', 'clunk', 'charge-hum', 'inhale', 'bloom', 'standby-down', 'wake-chime', 'winddown', 'thud', 'nope',
    'portal', 'portal-close', 'ptt-on', 'ptt-off', 'chime', 'attend']; // (the last six: the corner orb, docs/orb-prompt.md §8)
  const LEVEL = { tick: 0.5, 'hold-rise': 0.6, clunk: 0.8, 'charge-hum': 0.7, inhale: 0.6, bloom: 0.8, 'standby-down': 0.7, 'wake-chime': 0.7, winddown: 0.5, thud: 0.8, nope: 0.6,
    portal: 0.5, 'portal-close': 0.45, 'ptt-on': 0.5, 'ptt-off': 0.45, chime: 0.5, attend: 0.55 };
  let ctx = null;
  const buffers = new Map();
  const playing = new Map(); // name -> { src, gain }
  let enabled = true, silent = false;
  const ensure = () => { ctx ??= new AudioContext(); if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; };
  async function buffer(name) {
    if (buffers.has(name)) return buffers.get(name);
    const p = fetch(`sounds/${name}.wav`).then((r) => r.arrayBuffer()).then((b) => ensure().decodeAudioData(b)).catch(() => null);
    buffers.set(name, p);
    return p;
  }
  function stop(name, fade = 0.08) {
    const p = playing.get(name);
    if (!p) return;
    playing.delete(name);
    try {
      const t = ensure().currentTime;
      p.gain.gain.cancelScheduledValues(t); p.gain.gain.setValueAtTime(p.gain.gain.value, t); p.gain.gain.linearRampToValueAtTime(0, t + fade);
      p.src.stop(t + fade + 0.01);
    } catch {}
  }
  async function start(name, { loop = false, rate = 1 } = {}) {
    if (!enabled || silent || !NAMES.includes(name)) return null;
    const buf = await buffer(name);
    if (!buf) return null;
    stop(name, 0.02);
    const c = ensure();
    const src = c.createBufferSource(); src.buffer = buf; src.loop = loop; src.playbackRate.value = rate;
    const gain = c.createGain(); gain.gain.value = (LEVEL[name] || 0.6) * 0.5;
    src.connect(gain).connect(c.destination);
    src.start();
    const entry = { src, gain };
    playing.set(name, entry);
    src.onended = () => { if (playing.get(name) === entry) playing.delete(name); };
    return entry;
  }
  return {
    NAMES,
    play: (name) => { start(name, { loop: false }); },
    loop: (name) => { start(name, { loop: true }); },
    rate(name, r) { const p = playing.get(name); if (p) try { p.src.playbackRate.setTargetAtTime(r, ensure().currentTime, 0.1); } catch {} },
    stop,
    stopAll() { for (const n of [...playing.keys()]) stop(n); },
    set enabled(on) { enabled = Boolean(on); if (!enabled) this.stopAll(); },
    get enabled() { return enabled; },
    set silent(on) { silent = Boolean(on); if (silent) this.stopAll(); },
    get silent() { return silent; },
    preload() { for (const n of NAMES) buffer(n); },
  };
})();
