// ares-theme: what the ARES OS theme (docs/ares-theme-prompt.md) needs from macOS, using public APIs only.
//
//   ares-theme apps                     Long-running. One JSON line whenever the running apps or the front app change
//                                       (NSWorkspace notifications, no polling): {"running":["com.apple.Safari",…],"front":"…"}
//                                       Reads commands on stdin: "badges" prints {"badges":{"<Dock item title>":"3",…}}
//                                       (the Dock's own badges, through the Accessibility API; {} without permission).
//   ares-theme app-icon <size> <out.png> <path>…   Each file's Finder icon as a PNG (<out> gets -<n> before .png for n > 0)
//   ares-theme set-icon <path> <png | ->           A custom Finder icon for a file or folder ("-" removes it)
//   ares-theme quit <bundleID>          Asks an app to quit (NSRunningApplication.terminate)
//   ares-theme appearance-changed       Tells running apps the accent/highlight colours changed
//   ares-theme focus                    {"focus":true|false|null}: is a Focus on (null = macOS won't say, no Full Disk Access)
//   ares-theme ax                       {"trusted":true|false}: Accessibility permission (for the Dock badges)
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

case "appearance-changed":
  let dnc = DistributedNotificationCenter.default()
  for n in ["AppleColorPreferencesChangedNotification", "AppleAquaColorVariantChanged", "AppleInterfaceThemeChangedNotification"] {
    dnc.postNotificationName(NSNotification.Name(n), object: nil, userInfo: nil, deliverImmediately: true)
  }
  emit(["ok": true])

case "focus":
  emit(["focus": focusState()])

case "ax":
  emit(["trusted": AXIsProcessTrusted()])

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
  fail("usage: ares-theme apps | app-icon | set-icon | quit | appearance-changed | focus | ax | terminal-profile | pref-get | pref-set | pref-merge | plist-file")
}
