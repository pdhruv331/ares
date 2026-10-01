Before starting: make sure the project is a git repo with a clean working tree (if not, do the STEP 0 from docs/wallpaper-prompt.md). Tag pre-theme, and commit after each working step.

Build the "ARES OS" theme for my Mac: make the whole Mac feel like ARES. See the project notes. Do this AFTER docs/gui-update-prompt.md and docs/wallpaper-prompt.md are built; reuse their palette (cyan 62,230,255; violet for work; green for calls; amber for needs-me), the FRIDAY-content + EDITH-bracket panel style, and the materialize and launch animations.

RULES: supported APIs and free, open-source tools only. No SIP changes, no system-file edits, no replacing Apple resources. Install tools with Homebrew and tell me exactly what was installed. Before changing any of my settings, SAVE the original values; one ◉ menu switch "ARES theme" turns everything on or off and fully restores my previous setup. Ask me before the first apply.

1. SYSTEM LOOK (built-in settings)
- Dark mode; the accent colour and highlight colour closest to ARES cyan.
- Pointer colour (Accessibility → Display → Pointer): a cyan outline with a dark fill.
- A custom alert sound: a short ARES chime (generate it; put it in ~/Library/Sounds) set as the system alert sound.
- Dock auto-hide (optionally smaller, with the magnification off).
- My account picture: an ARES orb image (optional, ask).

2. ARES MENU BAR (SketchyBar)
- Replace the macOS menu bar look with a custom ARES bar using SketchyBar (free, open source), styled like the ARES top bar: the ARES mark + status pill ("● all systems ok", amber with a reason when something breaks), a listening/speaking indicator that pulses with her state, jobs working (count + violet dot), an "on call" indicator (green), a one-line weather, a clock, and the Wi-Fi/battery basics.
- LIVE-FED by ARES: ARES pushes state changes to SketchyBar (sketchybar --trigger / --set from main.js), no polling loops.
- Clicking items opens the relevant ARES view (Work panel, call summary, status details).
- Hide the native menu bar only via the supported "Automatically hide and show the menu bar" setting, saving the original.

3. ACTIVE WINDOW GLOW (JankyBorders)
- A thin cyan glowing border on the focused window, dimmer or none on the others. Colour follows ARES's state: violet while she's thinking, amber when something needs me.

3b. ARES DOCK (a launcher overlay; the Apple Dock stays but is auto-hidden, and the original setting is saved and restored)
- An ARES overlay window at the bottom centre, in all Spaces, above normal windows. It's click-through except the icons.
  - No background slab: just a faint cyan light line along the base.
  - App glyphs: outline icons in soft cyan. On hover: lift + slight scale, EDITH corner brackets lock onto the icon, and the app name appears in spaced capitals above it.
  - A small glowing dot under running apps; amber badges for unread mail and messages where the app exposes a badge.
  - A divider, then folders (Downloads) and the Trash.
- Setting "Icons: ARES glyphs / real app icons" (the real icons keep the brackets + glow).
- Setting "Always visible / show when the mouse touches the bottom edge".
- It does launch/switch/quit via standard APIs (NSWorkspace, a small Swift helper if needed). I choose the pinned apps. Minimised windows, drag-onto-app and Dock menus stay with the Apple Dock (still reachable, auto-hidden).
- ARES ORB, shown ONLY when the wallpaper brain is hidden:
  - When windows cover the centre of the desktop, or an app is in full screen (the same occlusion detection the wallpaper uses to pause), a mini ARES orb fades into the centre of the dock: a white core, a breathing halo that ripples with her real voice, violet + comet while thinking.
  - When the desktop and brain are visible again, the orb fades out, as if she "returned" to the wallpaper.
  - Clicking the orb summons ARES.

4. DESKTOP FILES and FOLDERS
- macOS can't change the default folder icon system-wide safely, but custom icons can be set per item (NSWorkspace setIcon:forFile:, reversible).
- Generate ARES-style icons: holographic outlined folders in cyan with EDITH-style corner brackets, plus file-type variants (document, image, PDF, code, archive).
- Apply them to the items on my Desktop, plus folders I choose (e.g. Documents, Downloads, Projects). Watch ~/Desktop, so new items get ARES icons automatically.
- Store the originals (in the extended attribute / a manifest) so turning the theme off restores every original icon exactly.
- Finder view options for the desktop: tidy grid spacing and icon size to suit the ARES scene. Label colour and font can't be changed; that's fine.
- Offer "Use Stacks" as an option.

5. ARES NOTIFICATIONS
- ARES's own alerts (job done, call summaries, reminders, needs-your-yes) appear as her FRIDAY panels materializing near the top-right of the screen (a transparent, click-through-except-panel overlay window above other apps), with the materialize animation, then dismissing themselves or on click. Other apps' notifications stay native macOS.
- Respect Focus/Do Not Disturb (only urgent ones through), and fall back to native notifications if the overlay can't show.

6. APP THEMES (optional, ask per app)
- Terminal/iTerm and VS Code: an "ARES" colour theme (near-black background, cyan/violet/green accents).
- Chrome: a simple ARES theme.
- Spotify via Spicetify (free), only if I say yes, since it modifies the Spotify app.

7. TEST on my real Mac
- Menu bar live states, window borders, cursor, alert sound, desktop icons applied and restored, notifications.
- The theme-off switch restores EVERYTHING exactly (verify by comparing the saved originals).
- Measure the CPU/battery impact of SketchyBar + JankyBorders + the overlay.
- Build with npm run build and restart ARES.
