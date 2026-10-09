"""End of turn (docs/voice-prompt.md A5), LiveKit eot-bench style: on recorded utterances with natural mid-sentence pauses,
how much silence each policy needs before it ends the turn, and how often it cuts the speaker off mid-sentence.

Policies
  silence T      end after T s of silence (today's listener is ~1.3 s after the text settles, with the mic quiet 0.8 s)
  smart-turn p   Silero VAD stop after 0.2 s, then Smart Turn v3.2 on the last 8 s; end when P(complete) >= p, else re-score
                 every 0.1 s while it stays silent; a cap ends it anyway (3 s)
  +cues          as smart-turn, but a pause whose last word is "and / um / so / uh / the / to / but / or / like" waits for the cap

Input: a JSON list of clips [{"wav": path, "words": [{"t","d","s"}...]}] (words from a recogniser, for the cues).
Output: JSON with, per policy, the silence needed for <= 5 % and <= 10 % cut-offs, cut-off rates and latency at true ends.
Run: uv run --no-project --with numpy --with onnxruntime --with soundfile --with transformers python -I eot.py clips.json models_dir
"""
import json
import sys

import numpy as np
import onnxruntime as ort
import soundfile as sf
from transformers import WhisperFeatureExtractor

clips = json.load(open(sys.argv[1]))
models = sys.argv[2]
SR = 16000
FRAME = 512  # Silero at 16 kHz: 32 ms frames with 64 samples of context

vad = ort.InferenceSession(f"{models}/vad/silero_vad.onnx")
turn = ort.InferenceSession(f"{models}/turn/smart-turn-v3.2-cpu.onnx")
fe = WhisperFeatureExtractor(chunk_length=8)
CUE = {"and", "um", "uh", "so", "the", "to", "but", "or", "like", "a", "of", "erm", "er", "hmm", "with", "for"}


def vad_probs(x):
    state = np.zeros((2, 1, 128), dtype=np.float32)
    ctx = np.zeros(64, dtype=np.float32)
    out = []
    for i in range(0, len(x) - FRAME + 1, FRAME):
        chunk = np.concatenate([ctx, x[i:i + FRAME]]).astype(np.float32)[None, :]
        p, state = vad.run(None, {"input": chunk, "state": state, "sr": np.array(SR, dtype=np.int64)})
        out.append(float(p[0][0]))
        ctx = x[i + FRAME - 64:i + FRAME]
    return np.array(out)


def segments(probs, on=0.5, off=0.35, min_speech=0.1):
    """Speech runs (start, end) in seconds with hysteresis; a run must last min_speech."""
    runs, start, speaking = [], 0, False
    for i, p in enumerate(probs):
        t = i * FRAME / SR
        if not speaking and p >= on:
            speaking, start = True, t
        elif speaking and p < off:
            speaking = False
            if t - start >= min_speech:
                runs.append((start, t))
    if speaking:
        runs.append((start, len(probs) * FRAME / SR))
    return runs


def p_complete(x, t):
    a = x[: int(t * SR)][-8 * SR:]
    a = np.pad(a, (8 * SR - len(a), 0))
    f = fe(a, sampling_rate=SR, return_tensors="np", padding="max_length", max_length=8 * SR, truncation=True, do_normalize=True)
    v = float(turn.run(None, {"input_features": f.input_features.astype(np.float32)})[0][0][0])
    return v if 0.0 <= v <= 1.0 else 1 / (1 + np.exp(-v))


def last_word_before(words, t):
    w = [x for x in words if x["t"] + x["d"] <= t + 0.15]
    return w[-1]["s"].strip().strip(",.!?").lower() if w else ""


# Every pause, labelled: internal (the speaker carries on) or final (the true end). For each, the silence each policy
# waits before ending, capped at the pause's own length (it can't wait past the speaker resuming).
pauses = []
for c in clips:
    x, sr = sf.read(c["wav"], dtype="float32")
    if x.ndim > 1:
        x = x[:, 0]
    runs = segments(vad_probs(x))
    if not runs:
        continue
    end_of_clip = len(x) / SR
    for k, (s, e) in enumerate(runs):
        final = k == len(runs) - 1
        gap = (runs[k + 1][0] - e) if not final else max(3.0, end_of_clip - e)
        if not final and gap < 0.2:
            continue
        probs = []  # P(complete) from 0.2 s into the pause, every 0.1 s, while it stays silent (up to 3 s)
        t = 0.2
        while t <= min(gap, 3.0) + 1e-6:
            probs.append((round(t, 2), p_complete(x, e + t)))
            t += 0.1
        pauses.append({"final": final, "gap": gap, "probs": probs, "cue": last_word_before(c.get("words", []), e) in CUE})


def waits(policy, param, cap=3.0):
    """Silence this policy waits at each pause before ending the turn (inf = it never ends within the pause)."""
    out = []
    for p in pauses:
        if policy == "silence":
            w = param
        else:
            hits = [t for t, pr in p["probs"] if pr >= param]
            w = cap if (policy == "cues" and p["cue"]) else (hits[0] if hits else cap)
        out.append(w if w <= p["gap"] + 1e-6 or p["final"] else float("inf"))
    return out


def summary(policy, param):
    w = waits(policy, param)
    internal = [wi for wi, p in zip(w, pauses) if not p["final"]]
    finals = [wi for wi, p in zip(w, pauses) if p["final"]]
    cut = sum(1 for wi in internal if wi != float("inf")) / max(1, len(internal))  # ended at a mid-sentence pause
    return {"policy": policy, "param": param, "cutoff": round(cut, 3),
            "latency_p50": round(float(np.median(finals)), 2) if finals else None,
            "latency_p90": round(float(np.percentile(finals, 90)), 2) if finals else None}


internal = [p for p in pauses if not p["final"]]
report = {"clips": len(clips), "pauses_internal": len(internal), "ends": len(pauses) - len(internal),
          "internal_pause_s": {"p50": round(float(np.median([p["gap"] for p in internal])), 2) if internal else None,
                               "p90": round(float(np.percentile([p["gap"] for p in internal], 90)), 2) if internal else None,
                               "max": round(max([p["gap"] for p in internal]), 2) if internal else None}}
grid_s = [round(0.2 + 0.1 * i, 1) for i in range(29)]
grid_p = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99]
rows = [summary("silence", s) for s in grid_s] + [summary("smart", p) for p in grid_p] + [summary("cues", p) for p in grid_p]
report["rows"] = rows
for budget in (0.05, 0.10):
    ok = [r for r in rows if r["cutoff"] <= budget and r["latency_p50"] is not None]
    best = {}
    for pol in ("silence", "smart", "cues"):
        cand = [r for r in ok if r["policy"] == pol]
        if cand:
            best[pol] = min(cand, key=lambda r: r["latency_p50"])
    report[f"best_at_{int(budget * 100)}pct"] = best
report["today_1.3s"] = summary("silence", 1.3)
print(json.dumps(report, indent=1))
