#!/bin/zsh
# Builds the ARES screen saver (native/saver) and installs it to ~/Library/Screen Savers/ARES.saver.
# The scene's files are bundled inside it, so it runs on its own (no network, ARES needn't be running).
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY=$(security find-identity -p codesigning 2>/dev/null | awk -F'"' '/ARES Local Signing/ {print $2; exit}')
SIGN=${IDENTITY:+"ARES Local Signing"}
SIGN=${SIGN:--}

OUT=native/build/ARES.saver
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/scene"
cp native/saver/Info.plist "$OUT/Contents/Info.plist"

echo "› Screen saver: compiling"
xcrun swiftc -O -swift-version 5 -parse-as-library -module-name AresSaver native/saver/AresSaver.swift \
  -o "$OUT/Contents/MacOS/AresSaver" -Xlinker -bundle -framework ScreenSaver -framework WebKit -framework IOKit

echo "› Screen saver: bundling the scene"
SCENE="$OUT/Contents/Resources/scene"
cp native/saver/saver.html renderer/wallpaper.css renderer/perf.js renderer/stars.js renderer/neural.js renderer/wallpaper.js "$SCENE/"
npx esbuild renderer/brain3d.mjs --bundle --format=iife --minify --log-level=warning --outfile="$SCENE/brain3d.js"
[[ -f native/saver/thumbnail.png ]] && cp native/saver/thumbnail*.png "$OUT/Contents/Resources/"

codesign --force --deep --sign "$SIGN" "$OUT"

echo "› Screen saver: installing to ~/Library/Screen Savers"
mkdir -p "$HOME/Library/Screen Savers"
rm -rf "$HOME/Library/Screen Savers/ARES.saver"
cp -R "$OUT" "$HOME/Library/Screen Savers/ARES.saver"
# A running screen saver host keeps the old copy loaded
killall legacyScreenSaver 2>/dev/null || true
echo "✓ Installed ~/Library/Screen Savers/ARES.saver"
