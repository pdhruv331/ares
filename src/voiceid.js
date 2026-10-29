// Speaker verification: only the enrolled owner's voice gets through. Runs entirely on this Mac
// with NVIDIA's TitaNet (small) speaker-embedding model via sherpa-onnx; no audio leaves the machine.
const fs = require('fs');

const RATE = 16000;
const MIN_SECONDS = 1.2;       // shorter samples make unreliable voiceprints
const MAX_SAMPLES = 20;        // cap on stored enrollment samples
// Keeping the voiceprint current (the mic, the room, a cold): recent samples that are surely the owner's are blended in,
// but the enrolment stays the anchor. A sample only counts if it's within LEARN_MARGIN of the threshold against the
// ORIGINAL enrolment, and the recent ones never outweigh it, so the voiceprint can't wander off towards someone else.
const RECENT = 12;             // recent samples kept
const RECENT_WEIGHT = 0.4;     // their share of the voiceprint (the enrolment keeps the rest)
const LEARN_MARGIN = 0.12;

const normalize = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const mean = (vs) => normalize(vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0)));

/** base64 16-bit mono PCM -> Float32Array in [-1, 1] */
function decode(b64) {
  const buf = Buffer.from(b64 || '', 'base64');
  const out = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Keep only the parts where someone is talking (20ms frames well above the clip's quiet level), so
 *  seconds of silence or room noise don't drag the voiceprint comparison down. */
function voiced(samples) {
  const F = 320; // 20ms at 16kHz
  const frames = Math.floor(samples.length / F);
  if (frames < 5) return samples;
  const rms = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * F; i < (f + 1) * F; i++) sum += samples[i] * samples[i];
    rms.push(Math.sqrt(sum / F));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(frames * 0.2)];
  const peak = sorted[Math.floor(frames * 0.98)];
  const gate = Math.max(floor * 3, peak * 0.12, 1e-4);
  const keep = rms.map((r) => r > gate);
  // pad each voiced frame by 3 frames either side so word edges aren't clipped
  const out = [];
  for (let f = 0; f < frames; f++) {
    let on = false;
    for (let d = -3; d <= 3 && !on; d++) on = keep[f + d] === true;
    if (on) for (let i = f * F; i < (f + 1) * F; i++) out.push(samples[i]);
  }
  return out.length >= RATE * 0.4 ? Float32Array.from(out) : samples; // too little left: use the whole clip
}

class VoiceId {
  constructor({ modelPath, profilePath, logPath, threshold }) {
    this.modelPath = modelPath;
    this.profilePath = profilePath;
    this.logPath = logPath;
    this.thresholdOverride = threshold;
    this.extractor = null;
    this.pending = null; // enrollment samples in progress
    try { this.profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch { this.profile = null; }
  }

  get enrolled() { return Boolean(this.profile?.centroid); }
  get enabled() { return this.enrolled && this.profile.enabled !== false; }
  get threshold() { return this.thresholdOverride || this.profile?.threshold || 0.55; }

  status() {
    return { enrolled: this.enrolled, enabled: this.enabled, threshold: this.threshold, samples: this.profile?.samples?.length ?? 0 };
  }

  embed(samples) {
    if (!this.extractor) {
      const sherpa = require('sherpa-onnx-node'); // native addon; loaded on first use
      this.extractor = new sherpa.SpeakerEmbeddingExtractor({ model: this.modelPath, numThreads: 2 });
    }
    const stream = this.extractor.createStream();
    stream.acceptWaveform({ samples, sampleRate: RATE });
    stream.inputFinished();
    return normalize(Array.from(this.extractor.compute(stream, false))); // Electron forbids external buffers
  }

  /** Is this the owner? Returns { ok, score, seconds }. Always ok when no voiceprint is set up.
   *  force: check against the voiceprint even with Voice ID switched off (speech heard without the wake word). */
  verify(b64, { force = false } = {}) {
    if (!this.enrolled || (!this.enabled && !force)) return { ok: true, score: null, seconds: 0 };
    const samples = voiced(decode(b64));
    const seconds = samples.length / RATE;
    if (seconds < 0.3) return { ok: false, score: 0, seconds }; // nothing usable captured
    const emb = this.embed(samples);
    const score = cosine(this.profile.centroid, emb);
    const ok = score >= this.threshold;
    this.log({ score: +score.toFixed(3), ok, seconds: +seconds.toFixed(1) });
    (this.scores ??= []).push(score);
    if (this.scores.length > 20) this.scores.shift();
    return { ok, score, seconds, emb };
  }
  /** An utterance's embedding, without judging it (push-to-talk: the owner at the keyboard). */
  embedAudio(b64) {
    if (!this.enrolled) return null;
    const samples = voiced(decode(b64));
    return samples.length / RATE >= 1 ? this.embed(samples) : null;
  }
  /** The enrolment itself: what every learned sample is measured against. */
  get anchor() { return this.profile?.samples?.length ? mean(this.profile.samples) : this.profile?.centroid; }
  /**
   * Blend one sample that's surely the owner's into the voiceprint (see RECENT_WEIGHT). Returns whether it was used.
   * why: 'push-to-talk' | 'matched' | 'near-miss' (just under the threshold, mid-conversation with a verified owner).
   */
  learn(emb, why) {
    if (!this.enrolled || !emb) return false;
    const anchor = this.anchor;
    const score = cosine(anchor, emb);
    if (score < this.threshold - LEARN_MARGIN) { this.log({ learn: false, why, anchorScore: +score.toFixed(3) }); return false; }
    const recent = [...(this.profile.recent || []), emb.map((x) => +x.toFixed(5))].slice(-RECENT);
    this.profile.recent = recent;
    if (recent.length >= 3) {
      const r = mean(recent);
      this.profile.centroid = normalize(anchor.map((x, i) => (1 - RECENT_WEIGHT) * x + RECENT_WEIGHT * r[i]));
    }
    this.save();
    this.log({ learn: true, why, anchorScore: +score.toFixed(3), recent: recent.length });
    return true;
  }
  /** Recent checks scoring under the threshold on average: the voiceprint needs retraining (mic mode, new room…). */
  get drifting() {
    const s = (this.scores || []).slice(-8);
    return s.length >= 4 && s.reduce((a, b) => a + b, 0) / s.length < this.threshold;
  }

  // ---- Enrollment ----------------------------------------------------------------
  startEnrollment() { this.pending = []; }
  cancelEnrollment() { this.pending = null; }

  addSample(b64, seconds) {
    if (!this.pending) this.startEnrollment();
    if (!b64 || seconds < MIN_SECONDS) return { ok: false, reason: seconds ? 'too-short' : 'no-speech', seconds };
    this.pending.push(this.embed(voiced(decode(b64))));
    return { ok: true, seconds, count: this.pending.length };
  }

  /** Save the voiceprint and calibrate a threshold from how consistent the samples are. */
  finishEnrollment() {
    const samples = this.pending || [];
    this.pending = null;
    if (samples.length < 3) return { ok: false, reason: 'not-enough-samples' };

    // Leave-one-out: how well does each sample match a voiceprint built from the others?
    const loo = samples.map((s, i) => cosine(mean(samples.filter((_, j) => j !== i)), s));
    const worst = Math.min(...loo);
    const threshold = Math.min(0.48, Math.max(0.4, worst - 0.2)); // everyday speech scores well below careful enrolment

    this.profile = {
      version: 1,
      model: 'nemo_en_titanet_small',
      createdAt: new Date().toISOString(),
      enabled: true,
      threshold: +threshold.toFixed(3),
      consistency: +worst.toFixed(3),
      samples: samples.slice(-MAX_SAMPLES).map((v) => v.map((x) => +x.toFixed(5))),
      centroid: mean(samples),
    };
    this.save();
    return { ok: true, threshold, consistency: worst, samples: samples.length };
  }

  setEnabled(on) {
    if (!this.enrolled) return;
    this.profile.enabled = on;
    this.save();
  }

  forget() {
    this.profile = null;
    try { fs.unlinkSync(this.profilePath); } catch {}
  }

  save() {
    fs.writeFileSync(this.profilePath, JSON.stringify(this.profile), { mode: 0o600 });
  }

  /** Scores only (never audio), so the threshold can be tuned later. */
  log(entry) {
    try {
      fs.appendFileSync(this.logPath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
      const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
      if (lines.length > 300) fs.writeFileSync(this.logPath, lines.slice(-200).join('\n') + '\n');
    } catch {}
  }
}

module.exports = { VoiceId };
