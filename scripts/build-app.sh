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

echo "› Compiling theme helper (ARES OS theme: app icons, custom icons, running apps, preferences)"
xcrun swiftc -O -swift-version 5 native/AresTheme.swift -o native/build/ares-theme
codesign --force --sign "$SIGN" native/build/ares-theme

echo "› Compiling control helper (full Mac control: windows, Accessibility, input, PDF text, OCR)"
xcrun swiftc -O -swift-version 5 native/AresControl.swift -o native/build/ares-control
codesign --force --sign "$SIGN" native/build/ares-control

echo "› Compiling camera helper (hand gestures: joints only, frames never leave it)"
# A real .app bundle: macOS only grants the camera to something it can name (a bare binary is refused without a prompt)
VISION="native/build/ARES Vision.app"
mkdir -p "$VISION/Contents/MacOS"
xcrun swiftc -O -swift-version 5 native/AresVision.swift -o "$VISION/Contents/MacOS/ares-vision"
cp native/Vision-Info.plist "$VISION/Contents/Info.plist"
codesign --force --sign "$SIGN" "$VISION"

echo "› Compiling calendar helper (EventKit: calendars, reminders, live changes; the Keychain for tokens)"
CAL="native/build/ARES Calendar.app"
mkdir -p "$CAL/Contents/MacOS"
xcrun swiftc -O -swift-version 5 native/AresCalendar.swift -o "$CAL/Contents/MacOS/ares-calendar"
cp native/Calendar-Info.plist "$CAL/Contents/Info.plist"
codesign --force --sign "$SIGN" "$CAL"

echo "› Compiling ignition helper (the cold reactor over the offline still while ARES is quit; hold to wake)"
IGN="native/build/ARES Ignition.app"
mkdir -p "$IGN/Contents/MacOS" "$IGN/Contents/Resources/sounds"
xcrun swiftc -O -swift-version 5 native/AresIgnition.swift -o "$IGN/Contents/MacOS/ares-ignition"
cp native/Ignition-Info.plist "$IGN/Contents/Info.plist"
# The page reuses the window's scene: the same drawing code, so the handover is pixel-for-pixel
node scripts/make-sounds.js >/dev/null
cp native/ignition.html native/ignition.js renderer/perf.js renderer/neural.js renderer/reactor.js renderer/ignite.js renderer/scene-boot.js renderer/scene.js "$IGN/Contents/Resources/"
cp renderer/sounds/*.wav "$IGN/Contents/Resources/sounds/"
codesign --force --sign "$SIGN" "$IGN"

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
  --extra-resource=native/build/ares-theme \
  --extra-resource=native/build/ares-control \
  --extra-resource="native/build/ARES Vision.app" \
  --extra-resource="native/build/ARES Calendar.app" \
  --extra-resource="native/build/ARES Ignition.app" \
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
