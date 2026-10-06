// ares-theme: what the ARES OS theme (docs/ares-theme-prompt.md) needs from macOS, using public APIs only.
//
//   ares-theme apps                     Long-running. One JSON line whenever the running apps or the front app change
//                                       (NSWorkspace notifications, no polling): {"running":["com.apple.Safari",…],"front":"…"}
//                                       Reads commands on stdin: "badges" prints {"badges":{"<Dock item title>":"3",…}}
//                                       (the Dock's own badges, through the Accessibility API; {} without permission).
//   ares-theme app-icon <size> <out.png> <path>…   Each file's Finder icon as a PNG (<out> gets -<n> before .png for n > 0)
//   ares-theme set-icon <path> <png | ->           A custom Finder icon for a file or folder ("-" removes it)
//   ares-theme pointer                  Long-running: the Mac's pointer from stdin lines (hand gestures, vision.js):
//                                       "move <x> <y>" (screen px, top-left origin) | "down" | "up" | "scroll <px>".
//                                       Posts CGEvents (needs Accessibility, which ARES has): a pinch is a real click
//                                       anywhere, Finder, the ARES bar, any app.
//   ares-theme quit <bundleID>          Asks an app to quit (NSRunningApplication.terminate)
//   ares-theme activate <bundleID> <app path>   Open or switch to an app the way a Dock click does: Launch Services
//                                       (which switches Spaces), then, with Accessibility, frontmost + its window raised
//                                       (un-minimised if every window is minimised)
//   ares-theme windows <bundleID>       {"trusted":bool,"windows":[{"i":0,"title":"…","min":false}]} (Accessibility)
//   ares-theme raise <bundleID> <i>     Bring that window forward (un-minimised), and the app with it
//   ares-theme hide <bundleID>          Hide the app
//   ares-theme menubar <bundleID>       {"menus":["Edge","File",…],"trusted":bool,"name":"Microsoft Edge"}: the app's menu bar titles
//                                       (without the Apple menu; none without Accessibility)
//   ares-theme menu-items <bundleID> <path>   One menu's items: path "2" = the 2nd title, "2.5" = a submenu in it:
//                                       {"items":[{"t":"New Tab","e":true,"mark":"✓","key":"⌘T","sub":false,"sep":false}]}
//   ares-theme menu-press <bundleID> <path>   Choose a menu item ("2.5.1"): AXPress
//   ares-theme metrics                  {"menubar":<height of the menu bar on the main screen>,"left":<width left of the notch>,
//                                       "width":<screen width>} (points; no notch: left = width)
//   ares-theme extra-press <owner> <name>  Click a real menu-bar icon (Control Center, Tailscale…), found in its app's
//                                       extras menu bar by name/identifier: {"ok":bool}
//   ares-theme ax-prompt                Ask macOS to show the Accessibility permission prompt for ARES
//   ares-theme appearance-changed       Tells running apps the accent/highlight colours changed
//   ares-theme focus                    {"focus":true|false|null}: is a Focus on (null = macOS won't say, no Full Disk Access)
//   ares-theme ax                       {"trusted":true|false}: Accessibility permission (for the Dock badges)
//   ares-theme orb-watch                Long-running, for the corner orb (docs/orb-prompt.md). JSON lines when something changes:
//                                       {"drag":true,"files":true,"text":false} while a drag is in progress (the mouse held and the
//                                       drag pasteboard changed since), {"drag":false} when it ends; with "caret on" from stdin,
//                                       {"caret":[x,y,w,h]} (screen px, top-left origin) for the focused text field's caret or
//                                       selection, {"caret":null} when there's none. Polled gently (8 Hz / 4 Hz).
//   ares-theme refocus <bundleID>       Bring that app back to the front (after ARES sinks)
//   ares-theme front                    {"front":"<bundleID>"}: the frontmost app
//   ares-theme terminal-profile <out.terminal> <json>   A Terminal profile from {"name","bg","fg","bold","cursor","selection","ansi":[16]}
//                                       (colours as "#rrggbb"; Terminal stores them as archived NSColor)
//   ares-theme pref-get <domain> <key>   {"exists":bool,"plist":"<base64 XML plist of the value>"}: the user's setting, exactly
//   ares-theme pref-set <domain> <key> <base64 plist | ->   Writes it back (or removes it with "-"): {"ok":bool}
//                                       (CFPreferences, the same store `defaults` uses; domain "-g" = the global domain)
//   ares-theme pref-merge <domain> <key> <subkey> <base64 plist | ->   Sets (or removes) one entry of a dictionary setting,
//                                       leaving the rest alone (Terminal's profiles): {"ok":bool,"existed":bool}
import AppKit
import ApplicationServices
import Foundation

func emit(_ obj: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) {
    print(s)
    fflush(stdout)
  }
}
func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(2)
}

func png(_ image: NSImage, size: Int) -> Data? {
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
  rep.size = NSSize(width: size, height: size)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current?.imageInterpolation = .high
  image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])
}

func color(_ hex: String) -> NSColor {
  var v: UInt64 = 0
  Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
  return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

// ---- apps -------------------------------------------------------------------------------------------------
final class Apps {
  var last = ""

  func report() {
    let ws = NSWorkspace.shared
    let running = ws.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { $0.bundleIdentifier }
    let state: [String: Any] = ["running": Array(Set(running)).sorted(), "front": ws.frontmostApplication?.bundleIdentifier ?? ""]
    if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8), s != last {
      last = s
      print(s)
      fflush(stdout)
    }
  }

  /** The Dock's badges (AXStatusLabel on its items), keyed by the item's title. */
  func badges() -> [String: String] {
    guard AXIsProcessTrusted(),
          let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return [:] }
    let app = AXUIElementCreateApplication(dock.processIdentifier)
    var out: [String: String] = [:]
    func children(_ el: AXUIElement) -> [AXUIElement] {
      var v: CFTypeRef?
      return AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success ? (v as? [AXUIElement]) ?? [] : []
    }
    func str(_ el: AXUIElement, _ attr: String) -> String? {
      var v: CFTypeRef?
      return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v as? String : nil
    }
    for list in children(app) {
      for item in children(list) {
        guard let title = str(item, kAXTitleAttribute), let label = str(item, "AXStatusLabel"), !label.isEmpty else { continue }
        out[title] = label
      }
    }
    return out
  }

  func run() {
    let nc = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                 NSWorkspace.didActivateApplicationNotification, NSWorkspace.didHideApplicationNotification] {
      nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.report() }
    }
    DispatchQueue.global().async {
      while let line = readLine() {
        if line == "badges" { DispatchQueue.main.async { emit(["badges": self.badges()]) } }
      }
      exit(0) // ARES went away
    }
    report()
    RunLoop.main.run()
  }
}

// ---- Focus ------------------------------------------------------------------------------------------------
/** A Focus is on when the Do Not Disturb store holds an active assertion. The store is private to the user and needs
 *  Full Disk Access to read; without it this says null and ARES treats Focus as unknown. */
func focusState() -> Any {
  let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/DoNotDisturb/DB/Assertions.json")
  guard let data = try? Data(contentsOf: url), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return NSNull() }
  let entries = json["data"] as? [[String: Any]] ?? []
  return entries.contains { (($0["storeAssertionRecords"] as? [Any]) ?? []).count > 0 }
}

// ---- Terminal profile -------------------------------------------------------------------------------------
func terminalProfile(out: String, spec: [String: Any]) {
  func archived(_ hex: String) -> Data { (try? NSKeyedArchiver.archivedData(withRootObject: color(hex), requiringSecureCoding: false)) ?? Data() }
  let names = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"]
  var p: [String: Any] = [
    "name": spec["name"] as? String ?? "ARES", "type": "Window Settings", "ProfileCurrentVersion": 2.07,
    "BackgroundColor": archived(spec["bg"] as? String ?? "#000000"), "TextColor": archived(spec["fg"] as? String ?? "#ffffff"),
    "TextBoldColor": archived(spec["bold"] as? String ?? "#ffffff"), "CursorColor": archived(spec["cursor"] as? String ?? "#ffffff"),
    "SelectionColor": archived(spec["selection"] as? String ?? "#333333"), "UseBrightBold": true, "columnCount": 110, "rowCount": 32,
  ]
  // SF Mono ships inside Terminal itself: archive Menlo, then name SF Mono in the archive (Terminal resolves it)
  if let menlo = NSFont(name: "Menlo-Regular", size: 12), let data = try? NSKeyedArchiver.archivedData(withRootObject: menlo, requiringSecureCoding: false),
     var archive = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any], var objects = archive["$objects"] as? [Any] {
    objects = objects.map { ($0 as? String) == "Menlo-Regular" ? "SFMono-Regular" : $0 }
    archive["$objects"] = objects
    p["Font"] = (try? PropertyListSerialization.data(fromPropertyList: archive, format: .binary, options: 0)) ?? data
  }
  let ansi = spec["ansi"] as? [String] ?? []
  for (i, hex) in ansi.prefix(16).enumerated() { p["ANSI\(i >= 8 ? "Bright" : "")\(names[i % 8])Color"] = archived(hex) }
  guard let data = try? PropertyListSerialization.data(fromPropertyList: p, format: .xml, options: 0) else { fail("could not encode profile") }
  do { try data.write(to: URL(fileURLWithPath: out)) } catch { fail(error.localizedDescription) }
  emit(["ok": true])
}

// ---- Accessibility helpers ----------------------------------------------------------------------------------
func runningApp(_ id: String) -> NSRunningApplication? { NSRunningApplication.runningApplications(withBundleIdentifier: id).first }
func axValue(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}
func axString(_ el: AXUIElement, _ attr: String) -> String? { axValue(el, attr) as? String }
func axBool(_ el: AXUIElement, _ attr: String) -> Bool { (axValue(el, attr) as? Bool) ?? false }
func axNumber(_ el: AXUIElement, _ attr: String) -> Int? { (axValue(el, attr) as? NSNumber)?.intValue }
func axChildren(_ el: AXUIElement?) -> [AXUIElement] { el.flatMap { axValue($0, kAXChildrenAttribute) as? [AXUIElement] } ?? [] }
func axWindows(_ app: AXUIElement) -> [AXUIElement] { (axValue(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }
func axMenuBar(_ app: AXUIElement) -> AXUIElement? { axValue(app, kAXMenuBarAttribute).map { $0 as! AXUIElement } }
/** "2" = the menu under the 2nd title (after the Apple menu), "2.5" = the submenu of its 5th item. */
func axMenuAt(_ app: AXUIElement, _ path: String) -> AXUIElement? {
  let idx = path.split(separator: ".").compactMap { Int($0) }
  guard let first = idx.first else { return nil }
  let titles = axChildren(axMenuBar(app))
  guard first + 1 < titles.count else { return nil }
  var menu = axChildren(titles[first + 1]).first
  for i in idx.dropFirst() {
    let items = axChildren(menu)
    guard i < items.count else { return nil }
    menu = axChildren(items[i]).first
  }
  return menu
}

// ---- main -------------------------------------------------------------------------------------------------
let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "apps":
  _ = NSApplication.shared // workspace notifications need an app object
  Apps().run()

case "app-icon":
  guard args.count >= 5, let size = Int(args[2]) else { fail("usage: ares-theme app-icon <size> <out.png> <path>…") }
  let out = args[3]
  var written: [String] = []
  for (i, file) in args.dropFirst(4).enumerated() {
    let dest = i == 0 ? out : out.replacingOccurrences(of: ".png", with: "-\(i).png")
    let img = NSWorkspace.shared.icon(forFile: file)
    if let data = png(img, size: size), (try? data.write(to: URL(fileURLWithPath: dest))) != nil { written.append(dest) } else { written.append("") }
  }
  emit(["files": written])

case "set-icon":
  guard args.count >= 4 else { fail("usage: ares-theme set-icon <path> <png | ->") }
  let image = args[3] == "-" ? nil : NSImage(contentsOfFile: args[3])
  if args[3] != "-" && image == nil { emit(["ok": false, "error": "unreadable image"]); exit(1) }
  let ok = NSWorkspace.shared.setIcon(image, forFile: args[2], options: [])
  emit(["ok": ok])
  exit(ok ? 0 : 1)

case "quit":
  guard args.count >= 3 else { fail("usage: ares-theme quit <bundleID>") }
  let apps = NSRunningApplication.runningApplications(withBundleIdentifier: args[2])
  emit(["ok": !apps.isEmpty && apps.allSatisfy { $0.terminate() }])

case "activate":
  guard args.count >= 4 else { fail("usage: ares-theme activate <bundleID> <app path>") }
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = true
  let done = DispatchSemaphore(value: 0)
  var openError = ""
  NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: args[3]), configuration: cfg) { _, err in openError = err?.localizedDescription ?? ""; done.signal() }
  _ = done.wait(timeout: .now() + 10)
  var raised = false
  if AXIsProcessTrusted(), let app = runningApp(args[2]) {
    let el = AXUIElementCreateApplication(app.processIdentifier)
    let wins = axWindows(el)
    // Every window minimised: bring the first one back, as the Dock does
    if !wins.isEmpty && wins.allSatisfy({ axBool($0, kAXMinimizedAttribute) }) { AXUIElementSetAttributeValue(wins[0], kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
    AXUIElementSetAttributeValue(el, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if let w = wins.first(where: { !axBool($0, kAXMinimizedAttribute) }) { raised = AXUIElementPerformAction(w, kAXRaiseAction as CFString) == .success }
  }
  emit(["ok": openError.isEmpty, "error": openError, "raised": raised])

case "windows":
  guard args.count >= 3 else { fail("usage: ares-theme windows <bundleID>") }
  guard AXIsProcessTrusted() else { emit(["trusted": false, "windows": []]); exit(0) }
  guard let app = runningApp(args[2]) else { emit(["trusted": true, "windows": []]); exit(0) }
  let wins = axWindows(AXUIElementCreateApplication(app.processIdentifier))
  emit(["trusted": true, "windows": wins.enumerated().compactMap { (i, w) -> [String: Any]? in
    let role = axString(w, kAXSubroleAttribute) ?? ""
    guard role == "AXStandardWindow" || role == "AXDialog" || role.isEmpty else { return nil }
    return ["i": i, "title": axString(w, kAXTitleAttribute) ?? "", "min": axBool(w, kAXMinimizedAttribute)]
  }])

case "raise":
  guard args.count >= 4, let i = Int(args[3]), let app = runningApp(args[2]) else { fail("usage: ares-theme raise <bundleID> <i>") }
  let el = AXUIElementCreateApplication(app.processIdentifier)
  let wins = axWindows(el)
  guard i < wins.count else { emit(["ok": false]); exit(1) }
  AXUIElementSetAttributeValue(wins[i], kAXMinimizedAttribute as CFString, kCFBooleanFalse)
  AXUIElementSetAttributeValue(wins[i], kAXMainAttribute as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(el, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  emit(["ok": AXUIElementPerformAction(wins[i], kAXRaiseAction as CFString) == .success])

case "hide":
  guard args.count >= 3 else { fail("usage: ares-theme hide <bundleID>") }
  emit(["ok": runningApp(args[2])?.hide() ?? false])

case "menubar":
  guard args.count >= 3 else { fail("usage: ares-theme menubar <bundleID>") }
  let name = runningApp(args[2])?.localizedName ?? ""
  guard AXIsProcessTrusted(), let app = runningApp(args[2]) else { emit(["menus": [], "trusted": AXIsProcessTrusted(), "name": name]); exit(0) }
  let bar = axMenuBar(AXUIElementCreateApplication(app.processIdentifier))
  emit(["menus": axChildren(bar).dropFirst().map { axString($0, kAXTitleAttribute) ?? "" }, "trusted": true, "name": name])

case "menu-items":
  guard args.count >= 4, let app = runningApp(args[2]), AXIsProcessTrusted() else { emit(["items": []]); exit(0) }
  guard let menu = axMenuAt(AXUIElementCreateApplication(app.processIdentifier), args[3]) else { emit(["items": []]); exit(0) }
  emit(["items": axChildren(menu).map { item -> [String: Any] in
    let title = axString(item, kAXTitleAttribute) ?? ""
    let mods = (axNumber(item, kAXMenuItemCmdModifiersAttribute) ?? 0)
    var key = axString(item, kAXMenuItemCmdCharAttribute) ?? ""
    if !key.isEmpty {
      // kAXMenuItemModifier*: 1 shift, 2 option, 4 control, 8 = no command
      key = (mods & 4 != 0 ? "⌃" : "") + (mods & 2 != 0 ? "⌥" : "") + (mods & 1 != 0 ? "⇧" : "") + (mods & 8 == 0 ? "⌘" : "") + key
    }
    return ["t": title, "e": axBool(item, kAXEnabledAttribute), "mark": axString(item, kAXMenuItemMarkCharAttribute) ?? "", "key": key,
            "sub": !axChildren(item).isEmpty, "sep": title.isEmpty]
  }])

case "menu-press":
  guard args.count >= 4, let app = runningApp(args[2]), AXIsProcessTrusted() else { emit(["ok": false]); exit(1) }
  var parts = args[3].split(separator: ".").compactMap { Int($0) }
  guard parts.count >= 2, let last = parts.popLast(),
        let menu = axMenuAt(AXUIElementCreateApplication(app.processIdentifier), parts.map(String.init).joined(separator: ".")) else { emit(["ok": false]); exit(1) }
  let items = axChildren(menu)
  guard last < items.count else { emit(["ok": false]); exit(1) }
  emit(["ok": AXUIElementPerformAction(items[last], kAXPressAction as CFString) == .success])

case "metrics":
  // The menu bar's height: the top of the main screen that isn't usable (the notch's band on a notched MacBook),
  // or the safe-area inset while the menu bar is set to hide
  let s = NSScreen.screens.first!
  let top = s.frame.maxY - s.visibleFrame.maxY
  emit(["menubar": top > 0 ? top : max(s.safeAreaInsets.top, NSStatusBar.system.thickness),
        "left": s.auxiliaryTopLeftArea?.width ?? s.frame.width, "width": s.frame.width])

case "extra-press":
  guard args.count >= 4, AXIsProcessTrusted() else { emit(["ok": false]); exit(1) }
  let owner = args[2], name = args[3].lowercased()
  let apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == owner || ($0.bundleIdentifier ?? "").lowercased().contains(owner.lowercased().replacingOccurrences(of: " ", with: "")) }
  var pressed = false
  for app in apps where !pressed {
    let el = AXUIElementCreateApplication(app.processIdentifier)
    let extras = axChildren(axValue(el, "AXExtrasMenuBar").map { $0 as! AXUIElement })
    guard !extras.isEmpty else { continue }
    let text = { (e: AXUIElement) in [kAXIdentifierAttribute, kAXDescriptionAttribute, kAXTitleAttribute].compactMap { axString(e, $0)?.lowercased() }.joined(separator: " ") }
    // By name; Control Center's own icon ("BentoBox") is the one whose identifier says controlcenter; else the only one
    let pick = extras.first { text($0).contains(name) }
      ?? (name.contains("bentobox") ? extras.first { text($0).contains("controlcenter") } : nil)
      ?? (extras.count == 1 && owner != "Control Center" ? extras[0] : nil) // (Control Center owns several: never guess)
    if let p = pick { pressed = AXUIElementPerformAction(p, kAXPressAction as CFString) == .success }
  }
  emit(["ok": pressed])

case "ax-prompt":
  emit(["trusted": AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)])

case "appearance-changed":
  let dnc = DistributedNotificationCenter.default()
  for n in ["AppleColorPreferencesChangedNotification", "AppleAquaColorVariantChanged", "AppleInterfaceThemeChangedNotification"] {
    dnc.postNotificationName(NSNotification.Name(n), object: nil, userInfo: nil, deliverImmediately: true)
  }
  emit(["ok": true])

case "focus":
  emit(["focus": focusState()])

case "pointer":
  var at = CGPoint(x: 0, y: 0), held = false
  let src = CGEventSource(stateID: .combinedSessionState)
  func post(_ type: CGEventType, _ p: CGPoint) {
    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
    e.post(tap: CGEventTapLocation.cghidEventTap)
  }
  emit(["ok": true, "trusted": AXIsProcessTrusted()])
  while let line = readLine() {
    let a = line.split(separator: " ").map(String.init)
    guard let cmd = a.first else { continue }
    switch cmd {
    case "move":
      guard a.count > 2, let x = Double(a[1]), let y = Double(a[2]) else { continue }
      at = CGPoint(x: x, y: y)
      post(held ? .leftMouseDragged : .mouseMoved, at)
    case "down": held = true; post(.leftMouseDown, at)
    case "up": held = false; post(.leftMouseUp, at)
    case "scroll":
      guard a.count > 1, let dy = Double(a[1]) else { continue }
      if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: Int32(dy.rounded()), wheel2: 0, wheel3: 0) {
        e.location = at
        e.post(tap: CGEventTapLocation.cghidEventTap)
      }
    default: break
    }
  }
  if held { post(.leftMouseUp, at) } // ARES went away mid-drag: let go

case "ax":
  emit(["trusted": AXIsProcessTrusted()])

case "front":
  emit(["front": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""])

case "refocus":
  guard args.count >= 3 else { fail("usage: ares-theme refocus <bundleID>") }
  let ok = runningApp(args[2])?.activate(options: []) ?? false
  emit(["ok": ok])

case "orb-watch":
  _ = NSApplication.shared
  let dragPB = NSPasteboard(name: .drag)
  var upCount = dragPB.changeCount   // the drag pasteboard's count the last time no button was held
  var dragging = false
  var caretOn = false
  var lastCaret = "unset"
  var tick = 0
  DispatchQueue.global().async {
    while let line = readLine() {
      let on = line.trimmingCharacters(in: .whitespaces) == "caret on"
      DispatchQueue.main.async { caretOn = on; if !on { lastCaret = "unset" } }
    }
    exit(0) // ARES went away
  }
  /// The caret (or selection) of the focused text element, system-wide, as a screen rect; nil when nothing has one.
  func caretRect() -> CGRect? {
    guard AXIsProcessTrusted() else { return nil }
    let sys = AXUIElementCreateSystemWide()
    guard let f = axValue(sys, kAXFocusedUIElementAttribute) else { return nil }
    let el = f as! AXUIElement
    guard let rangeV = axValue(el, kAXSelectedTextRangeAttribute) else { return nil }
    var bounds: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(el, kAXBoundsForRangeParameterizedAttribute as CFString, rangeV, &bounds) == .success,
          let b = bounds else { return nil }
    var rect = CGRect.zero
    guard AXValueGetValue(b as! AXValue, .cgRect, &rect) else { return nil }
    if rect.width > 4000 || rect.height > 4000 || rect.height <= 0 { return nil }
    if rect.width == 0 && rect.height == 0 { return nil }
    return rect
  }
  Timer.scheduledTimer(withTimeInterval: 0.125, repeats: true) { _ in
    tick += 1
    let held = (NSEvent.pressedMouseButtons & 1) != 0
    if !held { upCount = dragPB.changeCount }
    let now = held && dragPB.changeCount != upCount
    if now != dragging {
      dragging = now
      if now {
        let types = dragPB.types ?? []
        let files = types.contains(where: { $0.rawValue.contains("file-url") || $0 == .fileURL || $0.rawValue == "NSFilenamesPboardType" })
        let text = types.contains(where: { $0 == .string || $0 == .URL || $0.rawValue.contains("url") || $0.rawValue.contains("text") })
        emit(["drag": true, "files": files, "text": text && !files])
      } else { emit(["drag": false]) }
    }
    if caretOn && tick % 2 == 0 {
      let r = caretRect()
      let key = r.map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" } ?? "none"
      if key != lastCaret {
        lastCaret = key
        if let r { emit(["caret": [Int(r.minX), Int(r.minY), Int(r.width), Int(r.height)]]) } else { emit(["caret": NSNull()]) }
      }
    }
  }
  emit(["ok": true, "trusted": AXIsProcessTrusted()])
  RunLoop.main.run()

case "terminal-profile":
  guard args.count >= 4, let data = args[3].data(using: .utf8),
        let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fail("usage: ares-theme terminal-profile <out> <json>") }
  terminalProfile(out: args[2], spec: spec)

case "pref-get":
  guard args.count >= 4 else { fail("usage: ares-theme pref-get <domain> <key>") }
  let domain = (args[2] == "-g" ? kCFPreferencesAnyApplication : args[2] as CFString)
  if let v = CFPreferencesCopyValue(args[3] as CFString, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost),
     let data = try? PropertyListSerialization.data(fromPropertyList: v, format: .xml, options: 0) {
    emit(["exists": true, "plist": data.base64EncodedString()])
  } else {
    emit(["exists": false])
  }

case "pref-set":
  guard args.count >= 5 else { fail("usage: ares-theme pref-set <domain> <key> <base64 plist | ->") }
  let domain = (args[2] == "-g" ? kCFPreferencesAnyApplication : args[2] as CFString)
  var value: CFPropertyList? = nil
  if args[4] != "-" {
    guard let data = Data(base64Encoded: args[4]), let v = try? PropertyListSerialization.propertyList(from: data, format: nil) else { fail("bad plist") }
    value = v as CFPropertyList
  }
  CFPreferencesSetValue(args[3] as CFString, value, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
  let ok = CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
  // Read it back: a protected domain can accept the write in memory and still not save it
  let now = CFPreferencesCopyValue(args[3] as CFString, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
  let same = value == nil ? now == nil : (now.map { CFEqual($0, value) } ?? false)
  emit(["ok": ok && same])
  exit(ok && same ? 0 : 1)

case "pref-merge":
  guard args.count >= 6 else { fail("usage: ares-theme pref-merge <domain> <key> <subkey> <base64 plist | ->") }
  let domain = (args[2] == "-g" ? kCFPreferencesAnyApplication : args[2] as CFString)
  var dict = (CFPreferencesCopyValue(args[3] as CFString, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String: Any]) ?? [:]
  let existed = dict[args[4]] != nil
  if args[5] == "-" { dict.removeValue(forKey: args[4]) } else {
    guard let data = Data(base64Encoded: args[5]), let v = try? PropertyListSerialization.propertyList(from: data, format: nil) else { fail("bad plist") }
    dict[args[4]] = v
  }
  CFPreferencesSetValue(args[3] as CFString, dict as CFPropertyList, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
  emit(["ok": CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost), "existed": existed])

case "plist-file":
  // A plist file as a base64 XML plist (to merge a generated Terminal profile): {"plist":"…"}
  guard args.count >= 3, let data = FileManager.default.contents(atPath: args[2]),
        let v = try? PropertyListSerialization.propertyList(from: data, format: nil),
        let xml = try? PropertyListSerialization.data(fromPropertyList: v, format: .xml, options: 0) else { fail("unreadable plist") }
  emit(["plist": xml.base64EncodedString()])

default:
  fail("usage: ares-theme apps | app-icon | set-icon | quit | appearance-changed | focus | ax | terminal-profile | pref-get | pref-set | pref-merge | plist-file | activate | windows | raise | hide | menubar | menu-items | menu-press | metrics | extra-press | ax-prompt")
}
