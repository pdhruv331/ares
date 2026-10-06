#!/usr/bin/env node
// Synthesises the power sounds (docs/ignition-prompt.md §4e) into renderer/sounds/*.wav: short, subtle, designed for the reactor.
// Nothing sampled, nothing licensed: sine/triangle partials, noise and envelopes. 44.1 kHz, 16-bit mono. Run: node scripts/make-sounds.js
// The window plays them with Web Audio (renderer/sounds.js); the ignition helper with NSSound (copied into its bundle by build-app.sh).
const fs = require('fs');
const path = require('path');

const SR = 44100;
const OUT = path.join(__dirname, '..', 'renderer', 'sounds');
fs.mkdirSync(OUT, { recursive: true });

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Render `seconds` of audio with fn(t) → sample, then normalise to `peak`. */
function render(seconds, fn, peak = 0.5) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) { const v = fn(i / SR, i); out[i] = v; max = Math.max(max, Math.abs(v)); }
  const k = max > 0 ? peak / max : 1;
  for (let i = 0; i < n; i++) out[i] *= k;
  // a 3 ms fade at both ends against clicks
  const f = Math.round(0.003 * SR);
  for (let i = 0; i < f; i++) { out[i] *= i / f; out[n - 1 - i] *= i / f; }
  return out;
}
function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(clamp(samples[i], -1, 1) * 32767), 44 + i * 2);
  return buf;
}
// Envelopes and helpers
const env = (t, a, d, s = 0, r = 0, dur = a + d) => (t < a ? t / a : t < a + d ? 1 - (1 - s) * (t - a) / d : t < dur ? s : Math.max(0, s * (1 - (t - dur) / Math.max(1e-6, r))));
const expDecay = (t, k) => Math.exp(-t * k);
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 * 2 - 1; };
/** A soft "bell" partial set at frequency f. */
const bell = (t, f) => Math.sin(TAU * f * t) + 0.4 * Math.sin(TAU * f * 2.01 * t) * expDecay(t, 6) + 0.2 * Math.sin(TAU * f * 3.02 * t) * expDecay(t, 10);
/** Low-passed noise (one-pole), stateful per call site. */
function noise(cut) { let y = 0; const a = clamp(cut / SR * TAU, 0, 1); return () => { y += a * (rnd() - y); return y; }; }

const sounds = {
  // Notch / core hover: a soft tick
  tick: () => render(0.06, (t) => Math.sin(TAU * 1800 * t) * expDecay(t, 90) + 0.3 * Math.sin(TAU * 3600 * t) * expDecay(t, 140), 0.18),
  // Hold begins: a rising tone that tracks the hold (1.6 s; the player stops it early on release)
  'hold-rise': () => render(1.6, (t) => { const f = 220 + 440 * Math.pow(t / 1.6, 1.4); return (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * f * 2 * t)) * env(t, 0.08, 1.6, 0.9, 0.1) * (0.5 + 0.5 * t / 1.6); }, 0.22),
  // Commit: a muted clunk
  clunk: () => { const n = noise(600); return render(0.22, (t) => (Math.sin(TAU * 95 * t) * expDecay(t, 22) + 0.6 * n() * expDecay(t, 40) + 0.3 * Math.sin(TAU * 60 * t) * expDecay(t, 14)), 0.4); },
  // Charge-to-wake: a hum that rises with the charge (3 s; the player pitches it by playbackRate from the real %)
  'charge-hum': () => render(3.0, (t) => { const f = 55; return (Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * f * 2 * t + Math.sin(t * 3) * 0.3) + 0.25 * Math.sin(TAU * f * 3 * t) + 0.08 * Math.sin(TAU * f * 7.01 * t)) * env(t, 0.3, 3.0, 1, 0.3) * (0.7 + 0.3 * Math.sin(TAU * 6 * t)); }, 0.26),
  // The held breath: a tiny inhale (near-silence: a filtered breath of noise fading to nothing)
  inhale: () => { const n = noise(1800); return render(0.35, (t) => n() * env(t, 0.2, 0.15, 0, 0) * (0.3 + t), 0.08); },
  // Wake: a bright bloom chime
  bloom: () => render(1.6, (t) => (bell(t, 880) * expDecay(t, 2.2) + 0.7 * bell(t, 1318.5) * expDecay(t, 2.6) * (t > 0.05 ? 1 : 0) + 0.5 * bell(t, 1760) * expDecay(t, 3) * (t > 0.1 ? 1 : 0) + 0.3 * Math.sin(TAU * 220 * t) * expDecay(t, 1.6)), 0.4),
  // Standby: two soft falling notes and a gentle whir down
  'standby-down': () => render(1.4, (t) => { const a = t < 0.7 ? bell(t, 660) * expDecay(t, 4) : 0; const b = t > 0.25 ? bell(t - 0.25, 494) * expDecay(t - 0.25, 3.5) : 0; const whir = Math.sin(TAU * (160 - 100 * clamp(t / 1.4, 0, 1)) * t) * env(t, 0.1, 1.4, 0.4, 0.2) * 0.35; return a + b + whir; }, 0.3),
  // Wake from standby: a short rising chime
  'wake-chime': () => render(0.9, (t) => (bell(t, 494) * expDecay(t, 5) + (t > 0.12 ? bell(t - 0.12, 740) * expDecay(t - 0.12, 4) : 0) + (t > 0.24 ? bell(t - 0.24, 988) * expDecay(t - 0.24, 3.5) : 0)), 0.32),
  // Power down: a long turbine wind-down matching the rings' deceleration (3.8 s)
  winddown: () => { const n = noise(900); return render(3.8, (t) => { const k = Math.exp(-t * 1.1); const f = 40 + 180 * k; return (Math.sin(TAU * f * t * (1 + 0.002 * Math.sin(t * 20))) + 0.4 * Math.sin(TAU * f * 2 * t) + 0.25 * Math.sin(TAU * f * 3 * t)) * (0.3 + 0.7 * k) * env(t, 0.05, 3.8, 0.0, 0.2) + 0.35 * n() * k * k; }, 0.3); },
  // The cold thud at the end
  thud: () => { const n = noise(300); return render(0.5, (t) => Math.sin(TAU * 48 * t) * expDecay(t, 9) + 0.5 * n() * expDecay(t, 18), 0.4); },
  // Error: a low two-note "nope"
  nope: () => render(0.5, (t) => (t < 0.22 ? Math.sin(TAU * 196 * t) * env(t, 0.01, 0.2, 0, 0) : 0) + (t > 0.22 ? Math.sin(TAU * 147 * (t - 0.22)) * env(t - 0.22, 0.01, 0.26, 0, 0) : 0), 0.3),

  // ---- The corner orb (docs/orb-prompt.md §8) ----
  // The portal opening: a short whoosh that rises as the circle grows (0.6 s, like the reveal)
  portal: () => { const n = noise(2600); return render(0.62, (t) => { const k = t / 0.62; const f = 180 + 900 * k * k; return n() * env(t, 0.12, 0.5, 0, 0) * (0.4 + 0.6 * k) * 0.8 + 0.25 * Math.sin(TAU * f * t) * env(t, 0.05, 0.57, 0, 0); }, 0.16); },
  // ...and closing: the same breath, falling
  'portal-close': () => { const n = noise(2200); return render(0.55, (t) => { const k = 1 - t / 0.55; const f = 160 + 800 * k * k; return n() * env(t, 0.03, 0.52, 0, 0) * (0.35 + 0.65 * k) * 0.8 + 0.22 * Math.sin(TAU * f * t) * env(t, 0.02, 0.5, 0, 0); }, 0.14); },
  // Push-to-talk: a bright blip up (listening) and down (sent)
  'ptt-on': () => render(0.14, (t) => Math.sin(TAU * (880 + 440 * t / 0.14) * t) * env(t, 0.01, 0.13, 0, 0), 0.2),
  'ptt-off': () => render(0.14, (t) => Math.sin(TAU * (1320 - 440 * t / 0.14) * t) * env(t, 0.01, 0.13, 0, 0), 0.18),
  // A result card: one gentle bell
  chime: () => render(0.7, (t) => bell(t, 1174.7) * expDecay(t, 5) + 0.4 * bell(t, 1760) * expDecay(t, 6) * (t > 0.04 ? 1 : 0), 0.22),
  // Needs you: two soft notes, a fourth apart
  attend: () => render(0.75, (t) => bell(t, 659.3) * expDecay(t, 6) + (t > 0.2 ? bell(t - 0.2, 880) * expDecay(t - 0.2, 5) : 0), 0.24),
};

for (const [name, make] of Object.entries(sounds)) {
  const file = path.join(OUT, `${name}.wav`);
  fs.writeFileSync(file, wav(make()));
  console.log(`› ${name}.wav ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
