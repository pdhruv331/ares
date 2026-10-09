"""livekit-wakeword scores for A2 (docs/voice-prompt.md): slides the model's 2 s window over each file every 80 ms (the
model is stateless), and reports the highest score and how many times it would have fired at each threshold, with a 2 s
refractory period (so one long "Hey ARES" counts once). Run in the livekit-wakeword environment:
  uv run --project <livekit-wakeword> python -I wake_score.py model.onnx files.json   →  {file: {max, fires: {thr: n}, seconds}}
"""
import json
import sys

import numpy as np
import soundfile as sf
from livekit.wakeword import WakeWordModel

model = WakeWordModel(models=[sys.argv[1]])
files = json.load(open(sys.argv[2]))
THRESHOLDS = [0.3, 0.5, 0.68, 0.8, 0.9]
SR, WIN, HOP = 16000, 32000, 1280
out = {}
for f in files:
    x, sr = sf.read(f, dtype="float32")
    if x.ndim > 1:
        x = x[:, 0]
    if sr != SR:  # (the session clips are 16 kHz already)
        x = np.interp(np.arange(0, len(x), sr / SR), np.arange(len(x)), x).astype(np.float32)
    x = np.concatenate([np.zeros(SR, dtype=np.float32), x, np.zeros(SR // 2, dtype=np.float32)])
    scores = []
    for start in range(0, max(1, len(x) - WIN + 1), HOP):
        scores.append(next(iter(model.predict(x[start:start + WIN]).values())))
    fires = {}
    for thr in THRESHOLDS:
        n, last = 0, -1e9
        for i, s in enumerate(scores):
            t = i * HOP / SR
            if s >= thr and t - last >= 2.0:
                n, last = n + 1, t
        fires[str(thr)] = n
    out[f] = {"max": float(max(scores) if scores else 0), "fires": fires, "seconds": len(x) / SR}
print(json.dumps(out))
