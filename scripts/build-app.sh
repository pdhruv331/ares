#!/bin/zsh
# Builds ARES.app and installs it to /Applications.  Usage: npm run build
set -euo pipefail
cd "$(dirname "$0")/.."

# Sign with the local "ARES Local Signing" certificate when present: macOS then recognises every
# rebuild as the same app, so Microphone/Speech permissions stick. Falls back to ad-hoc signing.
IDENTITY=$(security find-identity -p codesigning 2>/dev/null | awk -F'"' '/ARES Local Signing/ {print $2; exit}')
SIGN=${IDENTITY:+"ARES Local Signing"}
SIGN=${SIGN:--}

echo "› Compiling wake-word listener"
mkdir -p native/build
xcrun swiftc -O -swift-version 5 native/AresListener.swift -o native/build/ares-listener \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/Info.plist
codesign --force --sign "$SIGN" native/build/ares-listener

echo "› Compiling desktop helper (wallpaper: is the desktop visible, desktop pictures)"
xcrun swiftc -O -swift-version 5 native/AresDesktop.swift -o native/build/ares-desktop
codesign --force --sign "$SIGN" native/build/ares-desktop

echo "› Backup voice model (Kokoro, downloaded once into the support folder)"
zsh scripts/get-voice-model.sh

echo "› Vendoring renderer libraries"
node scripts/vendor.mjs

echo "› Packaging ARES.app"
npx electron-packager . ARES \
  --platform=darwin --arch=arm64 \
  --app-bundle-id=com.dhruv.ares \
  --icon=assets/icon.icns \
  --extend-info=native/app-info.plist \
  --extra-resource=native/build/ares-listener \
  --extra-resource=native/build/ares-desktop \
  --extra-resource=models/speaker-titanet-small.onnx \
  --extra-resource=models/intent \
  --ignore='^/relay(/|$)' --ignore='^/(native|android|scripts|dist|assets|models|\.env.*|\.gitignore)' \
  --ignore='^/node_modules/onnxruntime-node/bin/napi-v6/(linux|win32|darwin/x64)' \
  --no-asar --prune --overwrite --out=dist --quiet

APP=dist/ARES-darwin-arm64/ARES.app
echo "› Signing (${IDENTITY:-ad-hoc})"
codesign --force --deep --sign "$SIGN" "$APP"

echo "› Installing to /Applications"
pkill -x ARES 2>/dev/null && sleep 1 || true
rm -rf /Applications/ARES.app
cp -R "$APP" /Applications/ARES.app

# Settings and keys live outside the app bundle
SUPPORT="$HOME/Library/Application Support/ARES"
mkdir -p "$SUPPORT"
if [[ -f .env ]]; then cp .env "$SUPPORT/.env"; chmod 600 "$SUPPORT/.env"; fi

echo "✓ Installed /Applications/ARES.app"

zsh scripts/build-saver.sh
