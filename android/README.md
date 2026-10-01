# ARES for Android

A native companion for the Galaxy S26 Ultra. The Mac stays the brain: the app talks to the same phone
server (`phone.js`) over Tailscale, with the same pairing, `/api/ask` streaming and ARES's voice.

| Piece | What it does |
|---|---|
| **App** | Reactor, conversation (shared with the Mac and Telegram), tap-to-talk or hold like a walkie-talkie |
| **Floating bubble** | Tap: talk. Drag: move (snaps to the edge). Drag onto the ✕: put away |
| **Widget** | Resizable from a single orb → bar → card → a whole empty home page (quick asks, last exchange) |
| **Quick Settings tile** | Swipe down, tap ARES, talk |
| **Persistent notification** | Talk · Type (inline reply, answer comes back as a notification) · Show/Hide bubble |
| **Notifications from ARES** | Timers, reminders, "send that to my phone": arrive over a live line to the Mac (`/api/events`), not Web Push |
| **Share → ARES** | Share text, links or up to 3 images from any app, then say what to do with them |
| **Default assistant** | Long-press the side button or swipe up from a bottom corner: ARES appears over any app, listening. With "Share my screen when summoned" on (menu), a screenshot + the screen's text go with your next question (tap ✕ on the chip to leave it out). Only ever sent to your Mac |
| **Updates from the Mac** | `./build.sh` publishes the build to the Mac; the phone offers it ("ARES update ready"), one tap installs it over the old one |

## Build

```
./build.sh          # → android/ARES.apk (signed release), and published to the Mac for the phone to update
```

`build.sh` gives every build a higher version code and copies it (plus `ARES.json`: version and SHA-256)
to `~/Library/Application Support/ARES/android/` (override with `ARES_APK_DIR`). The phone server
watches that file and tells connected phones; they download over Tailscale, check the SHA-256, and install.
The first self-update asks once for "Install unknown apps" for ARES.

**Samsung Auto Blocker** blocks every install that isn't from a store (self-updates, Android's installer,
APKs from My Files). When ARES hits that, the update screen explains it with a Security settings button:
switch Auto Blocker off, tap Install, and after the update a notification reminds you to switch it back on.
(ARES also stops trying to update herself directly once Samsung refuses it, and saves each update to
Downloads as `ARES-<version>.apk` instead.)

Needs JDK 21 (`brew install openjdk@21`) and the Android SDK in `~/Library/Android/sdk`.
Releases are signed with `ares.jks` (password in `keystore.properties`). **Back both up**: without
that key, an update can't install over the old app (you'd uninstall and re-pair).

## Install on the phone

1. Send `ARES.apk` to the phone (Tailscale → Send file, Quick Share, or USB) and open it.
   Allow "Install unknown apps" for whichever app opened it.
2. With Tailscale on, choose **Pair a Phone…** in the ARES menu on the Mac and enter the code.
3. Follow the purple **Finish setup** line: notifications, microphone, "Appear on top" (bubble),
   and unrestricted battery.
4. Samsung: Settings → Apps → ARES → Battery → **Unrestricted**, or One UI will eventually stop the
   notification. Tailscale's Always-on VPN helps too.
5. Optional: menu → **Make ARES your assistant…** (Digital assistant app → ARES; turn on "Use
   screenshot" there too for screen context). Then Settings → Advanced features → Side button →
   Press and hold → **Digital assistant**.
6. Add the widget (long-press the home screen → Widgets → ARES) and the tile (edit Quick Settings).

## Notes

- Debug builds (`./gradlew assembleDebug`) also allow plain HTTP to `10.0.2.2`, the emulator's host,
  for testing against a local server. Release builds are HTTPS only.
- The pairing key lives in the app's private storage and is excluded from backups.
- If the Mac forgets this phone (Unpair All Phones), the app says so and asks you to pair again.
