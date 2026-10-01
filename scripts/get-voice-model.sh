#!/bin/zsh
# ARES's backup voice: Kokoro-82M v1.0 (Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M) packaged for
# sherpa-onnx. Downloaded once into the support folder (not bundled: ~430 MB). The full-precision model is
# ~2x faster than int8 on Apple silicon, so both archives are fetched and only model.onnx is kept from the fp32 one.
# Usage: zsh scripts/get-voice-model.sh   (npm run build runs it when the model is missing)
set -euo pipefail
DEST="$HOME/Library/Application Support/ARES/models/kokoro-v1_0"
BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models
if [[ -f "$DEST/model.onnx" && -f "$DEST/voices.bin" ]]; then echo "✓ Backup voice model already installed"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "› Downloading Kokoro v1.0 (int8 archive, 132 MB: voices, lexicons, espeak-ng data)"
curl -fL --progress-bar "$BASE/kokoro-int8-multi-lang-v1_0.tar.bz2" | tar xj -C "$TMP"
echo "› Downloading Kokoro v1.0 full-precision model (350 MB archive)"
curl -fL --progress-bar "$BASE/kokoro-multi-lang-v1_0.tar.bz2" | tar xj -C "$TMP" kokoro-multi-lang-v1_0/model.onnx
mkdir -p "$(dirname "$DEST")"
mv "$TMP/kokoro-int8-multi-lang-v1_0" "$DEST.partial"
mv "$TMP/kokoro-multi-lang-v1_0/model.onnx" "$DEST.partial/model.onnx"
mv "$DEST.partial" "$DEST"
grep -q "Apache License" "$DEST/LICENSE" && echo "✓ Licence: Apache-2.0"
echo "✓ Installed $DEST"
