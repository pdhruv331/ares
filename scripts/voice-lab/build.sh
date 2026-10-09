#!/bin/zsh
# Builds "ARES Voice Lab.app" (native/AresVoiceLab.swift), the stage-A measurement helper. Development only: not shipped
# in ARES.app. A real bundle so macOS asks for the microphone and speech recognition in its own name.
set -euo pipefail
cd "$(dirname "$0")/../.."
IDENTITY=$(security find-identity -p codesigning 2>/dev/null | awk -F'"' '/ARES Local Signing/ {print $2; exit}')
SIGN=${IDENTITY:+"ARES Local Signing"}
SIGN=${SIGN:--}
LAB="native/build/ARES Voice Lab.app"
mkdir -p "$LAB/Contents/MacOS"
xcrun swiftc -O -swift-version 5 native/AresVoiceLab.swift -o "$LAB/Contents/MacOS/ares-voicelab"
cp native/VoiceLab-Info.plist "$LAB/Contents/Info.plist"
codesign --force --sign "$SIGN" "$LAB"
echo "✓ $LAB"
