// ares-desktop: what ARES's wallpaper needs to know about the Mac's desktop, using public APIs only.
//
//   ares-desktop watch            Long-running. Reads "ids <windowID> …" lines on stdin (the wallpaper windows), and
//                                 prints one JSON line whenever anything changes, checked about once a second:
//                                 {"windows":{"<id>":{"onScreen":true,"covered":0.42}},"locked":false,"lowPower":false,"asleep":false}
//                                 onScreen = false while a full-screen app (or another Space) is in front on that display;
//                                 covered = how much of the window ordinary app windows hide (0…1).
//   ares-desktop wallpaper-get    The desktop picture of every screen: [{"id":1,"name":"…","url":"file:///…","scaling":3,"clip":false}]
//   ares-desktop wallpaper-set <screenID> <file URL or path> [scaling] [clip 0|1]
//                                 Sets one screen's desktop picture (NSWorkspace.setDesktopImageURL).
import AppKit
import CoreGraphics
import Foundation

func emit(_ obj: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) {
    print(s)
    fflush(stdout)
  }
}

func screenID(_ s: NSScreen) -> Int {
  (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
}

// ---- watch -----------------------------------------------------------------------------------------------
final class Watcher {
  var ids: [Int] = []
  var last = ""
  let lock = NSLock()

  func readCommands() {
    DispatchQueue.global().async {
      while let line = readLine() {
        let parts = line.split(separator: " ")
        if parts.first == "ids" {
          self.lock.lock()
          self.ids = parts.dropFirst().compactMap { Int($0) }
          self.last = "" // report straight away
          self.lock.unlock()
        }
      }
      exit(0) // ARES went away
    }
  }

  func rect(_ w: [String: Any]) -> CGRect? {
    guard let b = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: b)
  }

  /** The usable area (NSScreen.visibleFrame) of the display under a window, in CoreGraphics (top-left) coordinates. */
  func usable(_ r: CGRect) -> CGRect {
    guard let main = NSScreen.screens.first else { return r }
    let h0 = main.frame.height
    let flip = { (f: NSRect) in CGRect(x: f.minX, y: h0 - f.maxY, width: f.width, height: f.height) }
    let centre = CGPoint(x: r.midX, y: r.midY)
    guard let s = NSScreen.screens.first(where: { flip($0.frame).contains(centre) }) else { return r }
    let v = flip(s.visibleFrame).intersection(r)
    return v.isNull || v.width < 10 ? r : v
  }

  func tick() {
    lock.lock(); let ids = self.ids; lock.unlock()
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let all = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    // Ordinary app windows (layer 0, visible, not tiny), front to back
    let apps: [CGRect] = list.compactMap { w in
      guard (w[kCGWindowLayer as String] as? Int) == 0,
            ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0.05,
            let r = rect(w), r.width > 40, r.height > 40 else { return nil }
      return r
    }
    var windows: [String: Any] = [:]
    for id in ids {
      guard let mine = all.first(where: { ($0[kCGWindowNumber as String] as? Int) == id }), let r = rect(mine) else {
        windows[String(id)] = ["onScreen": false, "covered": 1.0]
        continue
      }
      // Coverage by sampling a grid (cheap, and exact enough to tell "fully covered"), over the part of the display
      // apps can use: the strip under the menu bar and the Dock don't count. That's also how a full-screen app shows
      // up: the wallpaper stays "on screen" in a full-screen Space, under a window filling the usable area (on a
      // notched MacBook, everything below the notch).
      let a = usable(r)
      let cols = 48, rows = 30
      var hidden = 0
      for i in 0..<cols {
        for j in 0..<rows {
          let p = CGPoint(x: a.minX + (CGFloat(i) + 0.5) * a.width / CGFloat(cols), y: a.minY + (CGFloat(j) + 0.5) * a.height / CGFloat(rows))
          if apps.contains(where: { $0.contains(p) }) { hidden += 1 }
        }
      }
      let covered = (Double(hidden) / Double(cols * rows) * 100).rounded() / 100
      windows[String(id)] = ["onScreen": true, "covered": covered]
    }
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false
    var asleep = false
    var count: UInt32 = 0
    var displays = [CGDirectDisplayID](repeating: 0, count: 16)
    if CGGetOnlineDisplayList(16, &displays, &count) == .success {
      asleep = count > 0 && displays[0..<Int(count)].allSatisfy { CGDisplayIsAsleep($0) != 0 }
    }
    let state: [String: Any] = ["windows": windows, "locked": locked, "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled, "asleep": asleep]
    if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8), s != last {
      last = s
      print(s)
      fflush(stdout)
    }
  }
}

// ---- main -------------------------------------------------------------------------------------------------
let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "watch":
  let w = Watcher()
  w.readCommands()
  let timer = Timer(timeInterval: 1.0, repeats: true) { _ in w.tick() }
  timer.tolerance = 0.3
  RunLoop.main.add(timer, forMode: .common)
  w.tick()
  RunLoop.main.run()

case "wallpaper-get":
  emit(NSScreen.screens.map { s -> [String: Any] in
    let opts = NSWorkspace.shared.desktopImageOptions(for: s) ?? [:]
    return [
      "id": screenID(s), "name": s.localizedName,
      "url": NSWorkspace.shared.desktopImageURL(for: s)?.absoluteString ?? "",
      "scaling": (opts[.imageScaling] as? NSNumber)?.intValue ?? -1,
      "clip": (opts[.allowClipping] as? NSNumber)?.boolValue ?? false,
    ]
  })

case "wallpaper-set":
  guard args.count >= 4, let target = Int(args[2]), let screen = NSScreen.screens.first(where: { screenID($0) == target }) else {
    FileHandle.standardError.write("usage: ares-desktop wallpaper-set <screenID> <url> [scaling] [clip]\n".data(using: .utf8)!)
    exit(2)
  }
  let url = args[3].hasPrefix("file://") ? URL(string: args[3])! : URL(fileURLWithPath: args[3])
  var opts: [NSWorkspace.DesktopImageOptionKey: Any] = [:]
  if args.count >= 5, let sc = Int(args[4]), sc >= 0 { opts[.imageScaling] = NSNumber(value: sc) }
  if args.count >= 6 { opts[.allowClipping] = NSNumber(value: args[5] == "1") }
  do {
    try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: opts)
    emit(["ok": true])
  } catch {
    emit(["ok": false, "error": error.localizedDescription])
    exit(1)
  }

default:
  FileHandle.standardError.write("usage: ares-desktop watch | wallpaper-get | wallpaper-set <screenID> <url> [scaling] [clip]\n".data(using: .utf8)!)
  exit(2)
}
