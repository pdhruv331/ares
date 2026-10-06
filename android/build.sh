#!/bin/zsh
# Builds the ARES Android app (signed release) and hands it to the Mac's phone server, which offers it
# to the phone as an update.  Usage: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
[ -f ../renderer/sounds/bloom.wav ] || (cd .. && node scripts/make-sounds.js >/dev/null) # the power sounds, bundled as raw resources
CODE=$(( $(date +%s) / 60 )) # every build gets a higher version code (minutes since 1970)
./gradlew assembleRelease --console=plain -q -ParesVersionCode=$CODE
cp app/build/outputs/apk/release/app-release.apk ARES.apk

NAME=$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)
OUT="${ARES_APK_DIR:-$HOME/Library/Application Support/ARES/android}"
mkdir -p "$OUT"
cp ARES.apk "$OUT/ARES.apk"
# Written last: the phone server watches this file, and it must only change once the APK is in place
printf '{"versionCode":%s,"versionName":"%s","sha256":"%s","size":%s}\n' \
  $CODE "$NAME" "$(shasum -a 256 ARES.apk | cut -d' ' -f1)" "$(stat -f%z ARES.apk)" > "$OUT/ARES.json.tmp"
mv "$OUT/ARES.json.tmp" "$OUT/ARES.json"
echo "› Built ARES $NAME ($CODE): $(pwd)/ARES.apk ($(du -h ARES.apk | cut -f1)). Your phone will offer it as an update."
