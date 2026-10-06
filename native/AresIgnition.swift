// ares-ignition: "ARES Ignition.app" (docs/ignition-prompt.md §2, §3). While ARES is quit, the desktop shows the offline still; this
// small native app sits over the still's reactor on every display with a transparent, click-through window and draws the SAME cold
// reactor (renderer/reactor.js + renderer/ignite.js in a WKWebView), so hovering warms it, holding it charges it, and the handover to
// the live ARES is seamless. ~0% CPU at rest (the page draws at 4 fps while cold), no microphone, no network, not in the Dock.
//
//   ares-ignition --support <ARES support folder> [--login]
//
// Runs only while ARES's pid (<support>/ignition/ares.pid) is dead. Started at login (a LaunchAgent, packaged builds) and by ARES
// on quit; exits once ARES is up and has handed over. Ignite: hold the core ~0.7 s, or ⌥Space (Carbon hot key, registered only while
// ARES is off). Then: launch ARES (config.json "app"), connect to <support>/ignition/ignition.sock and feed the real start-up steps
// to the page; on "handover" fade out and exit.
//
// Files it reads (all written by ARES, ignition.js): ignition/ares.pid, ignition/geometry.json (the reactor's place per display),
// ignition/config.json ({ app, sounds }). It writes ignition/helper.pid while it runs.
import AppKit
import Carbon.HIToolbox
import WebKit

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
func arg(_ name: String) -> String? { if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }; return nil }
guard let supportDir = arg("--support") else { FileHandle.standardError.write(Data("usage: ares-ignition --support <dir> [--login]\n".utf8)); exit(2) }
let atLogin = args.contains("--login")
let dir = URL(fileURLWithPath: supportDir).appendingPathComponent("ignition")
let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
func log(_ s: String) {
  let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
  FileHandle.standardError.write(Data(line.utf8))
  // and <support>/ignition/helper.log (launched by `open` or launchd there's no terminal; kept short)
  let f = dir.appendingPathComponent("helper.log")
  if let h = try? FileHandle(forWritingTo: f) { h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile() } else { try? line.write(to: f, atomically: true, encoding: .utf8) }
  if let size = try? FileManager.default.attributesOfItem(atPath: f.path)[.size] as? Int, size > 200_000 { try? FileManager.default.removeItem(at: f) }
}
let windowLevel = Int(arg("--level") ?? "") ?? -1 // (testing: the level the windows sit at; -1 = just below app windows, like the ARES desktop)

// ---- ARES's state ---------------------------------------------------------------------------------------------------------------
func aresPid() -> pid_t? {
  guard let s = try? String(contentsOf: dir.appendingPathComponent("ares.pid"), encoding: .utf8), let pid = pid_t(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return nil }
  return kill(pid, 0) == 0 ? pid : nil
}
struct Geometry { let frame: CGRect; let cx: CGFloat; let cy: CGFloat; let r: CGFloat; let scale: CGFloat }
func geometries() -> [Geometry] {
  guard let data = try? Data(contentsOf: dir.appendingPathComponent("geometry.json")), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let list = json["displays"] as? [[String: Any]] else { return [] }
  return list.compactMap { d in
    guard let x = d["x"] as? Double, let y = d["y"] as? Double, let w = d["w"] as? Double, let h = d["h"] as? Double, let cx = d["cx"] as? Double, let cy = d["cy"] as? Double, let r = d["r"] as? Double else { return nil }
    return Geometry(frame: CGRect(x: x, y: y, width: w, height: h), cx: cx, cy: cy, r: r, scale: (d["scale"] as? Double) ?? 2)
  }
}
func config() -> [String: Any] {
  guard let data = try? Data(contentsOf: dir.appendingPathComponent("config.json")), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
  return json
}

// ---- The socket to ARES ----------------------------------------------------------------------------------------------------------
final class Link {
  var fd: Int32 = -1
  var onLine: ((String) -> Void)?
  var onClose: (() -> Void)?
  var connected: Bool { fd >= 0 }
  func connect() -> Bool {
    let path = dir.appendingPathComponent("ignition.sock").path
    let s = socket(AF_UNIX, SOCK_STREAM, 0)
    guard s >= 0 else { return false }
    var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
    _ = path.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, len) } } == 0
    if !ok { close(s); return false }
    fd = s
    DispatchQueue.global(qos: .utility).async { [weak self] in
      var buf = [UInt8](repeating: 0, count: 4096), pending = Data()
      while let self = self, self.fd >= 0 {
        let n = read(self.fd, &buf, buf.count)
        if n <= 0 { break }
        pending.append(buf, count: n)
        while let nl = pending.firstIndex(of: 10) {
          let line = String(decoding: pending[..<nl], as: UTF8.self); pending.removeSubrange(...nl)
          DispatchQueue.main.async { self.onLine?(line) }
        }
      }
      DispatchQueue.main.async { [weak self] in self?.disconnect(); self?.onClose?() }
    }
    return true
  }
  func send(_ obj: [String: Any]) {
    guard fd >= 0, let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    var line = data; line.append(10)
    _ = line.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
  }
  func disconnect() { if fd >= 0 { close(fd); fd = -1 } }
}

// ---- One window per display ----------------------------------------------------------------------------------------------------------
final class Panel: NSObject, WKScriptMessageHandler {
  let geo: Geometry
  let window: NSWindow
  let web: WKWebView
  var ready = false
  var queued: [String] = []
  weak var app: Ignition?
  var inside = false

  init(geo: Geometry, screen: NSScreen, app: Ignition) {
    self.geo = geo; self.app = app
    window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
    window.level = NSWindow.Level(rawValue: windowLevel) // just below app windows, above the desktop icons: where the ARES desktop window lives (surface.js)
    window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
    window.ignoresMouseEvents = true
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
    window.isReleasedWhenClosed = false
    window.animationBehavior = .none
    let cfg = WKWebViewConfiguration()
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    web = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: cfg)
    super.init()
    cfg.userContentController.add(self, name: "ares")
    web.setValue(false, forKey: "drawsBackground")
    web.autoresizingMask = [.width, .height]
    window.contentView = web
    // The geometry and the cold start go in as a script at document start (loadFileURL refuses a file URL with a query)
    let boot = "window.SCENE_GEOMETRY = { cx: \(Int(geo.cx)), cy: \(Int(geo.cy)), r: \(Int(geo.r)) }; window.SCENE_POWER = 'cold'; window.SCENE_IGNITION = true;"
    cfg.userContentController.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    window.orderFrontRegardless()
    web.loadFileURL(resources.appendingPathComponent("ignition.html"), allowingReadAccessTo: resources)
  }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready": ready = true; log("page ready (\(geo.cx),\(geo.cy),\(geo.r)) visible=\(window.isVisible) onActiveSpace=\(window.isOnActiveSpace)"); for js in queued { web.evaluateJavaScript(js) }; queued.removeAll()
    case "ignite": app?.ignite(why: "hold")
    case "wake": app?.wake() // the bloom: ARES fades its live desktop in now; this window fades out on the same curve
    case "sound": if let name = body["name"] as? String { app?.play(name, stop: body["stop"] as? Bool ?? false) }
    case "log": log("page: \(body["text"] ?? "")")
    default: break
    }
  }
  /** A message into the page: Ignition.rx({...}). */
  func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let json = String(data: data, encoding: .utf8) else { return }
    let js = "window.Ignition && Ignition.rx(\(json))"
    if ready { web.evaluateJavaScript(js) } else { queued.append(js) }
  }
  /** The pointer, in the page's CSS px (top-left origin) when it's on this display. */
  func pointer(_ p: NSPoint) -> (x: CGFloat, y: CGFloat, on: Bool) {
    let f = window.frame
    let on = f.contains(p)
    return (p.x - f.minX, f.maxY - p.y, on)
  }
}

// ---- The app --------------------------------------------------------------------------------------------------------------------------
final class Ignition: NSObject, NSApplicationDelegate {
  var panels: [Panel] = []
  let link = Link()
  var hotKey: EventHotKeyRef?
  var igniting = false
  var handedOver = false
  var sounds: [String: NSSound] = [:]
  var mouseMonitor: Any?
  var launchedAt: Date?
  var aliveSince: Date?

  func applicationDidFinishLaunching(_ n: Notification) {
    log("starting pid \(getpid())")
    NSApp.setActivationPolicy(.accessory) // (LSUIElement: no Dock, no Cmd-Tab; .prohibited would forbid windows altogether)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? "\(getpid())".write(to: dir.appendingPathComponent("helper.pid"), atomically: true, encoding: .utf8)
    // Already running (another helper)? Only one.
    if let s = try? String(contentsOf: dir.appendingPathComponent("helper.pid"), encoding: .utf8), let pid = pid_t(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid != getpid(), kill(pid, 0) == 0 { log("another helper runs (\(pid))"); exit(0) }
    if let pid = aresPid(), !atLogin { log("ARES is running (\(pid)): nothing to do"); exit(0) }
    buildPanels()
    registerHotKey()
    mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] e in self?.mouse(e); return e }
    Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in self?.pollPointer() }
    Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.pollAres() }
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.buildPanels() }
    log("up: \(panels.count) display(s), login=\(atLogin)")
  }
  func applicationWillTerminate(_ n: Notification) { try? FileManager.default.removeItem(at: dir.appendingPathComponent("helper.pid")); unregisterHotKey() }

  func buildPanels() {
    for p in panels { p.window.orderOut(nil) }
    panels = []
    let geos = geometries()
    for screen in NSScreen.screens {
      // Match ARES's display (its bounds are in a top-left, Electron coordinate space; match by size and the primary's origin)
      let primary = NSScreen.screens.first!.frame
      let fx = screen.frame.minX, fy = primary.maxY - screen.frame.maxY
      let geo = geos.first { abs($0.frame.minX - fx) < 2 && abs($0.frame.minY - fy) < 2 && abs($0.frame.width - screen.frame.width) < 2 }
        ?? geos.first { abs($0.frame.width - screen.frame.width) < 2 && abs($0.frame.height - screen.frame.height) < 2 }
        ?? Geometry(frame: screen.frame, cx: screen.frame.width / 2, cy: screen.frame.height / 2 + screen.frame.height * 0.03, r: min(screen.frame.height * 0.26, screen.frame.width * 0.22), scale: screen.backingScaleFactor)
      panels.append(Panel(geo: geo, screen: screen, app: self))
    }
  }

  // ---- Pointer: click-through everywhere except inside the reactor's circle --------------------------------------------------------
  func pollPointer() {
    let p = NSEvent.mouseLocation
    for panel in panels {
      let (x, y, on) = panel.pointer(p)
      let inside = on && hypot(x - panel.geo.cx, y - panel.geo.cy) <= panel.geo.r * 1.05
      if inside != panel.inside {
        panel.inside = inside
        panel.window.ignoresMouseEvents = !inside
        if !inside { panel.send(["type": "pointer", "inside": false]) }
      }
      if inside { panel.send(["type": "pointer", "inside": true, "x": x, "y": y]) }
    }
  }
  func mouse(_ e: NSEvent) {
    guard let panel = panels.first(where: { $0.window == e.window }) else { return }
    let (x, y, _) = panel.pointer(NSEvent.mouseLocation)
    panel.send(["type": e.type == .leftMouseDown ? "down" : "up", "x": x, "y": y])
  }

  // ---- ⌥Space while ARES is off ----------------------------------------------------------------------------------------------------------
  var handlerInstalled = false
  func registerHotKey() {
    guard hotKey == nil else { return }
    let id = EventHotKeyID(signature: OSType(0x41524553), id: 1) // 'ARES'
    if !handlerInstalled {
      handlerInstalled = true
      var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
      InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in Ignition.shared?.ignite(why: "hotkey"); return noErr }, 1, &spec, nil, nil)
    }
    RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKey)
  }
  func unregisterHotKey() { if let h = hotKey { UnregisterEventHotKey(h); hotKey = nil } }
  static weak var shared: Ignition?

  // ---- Ignite: launch ARES and follow its start-up ----------------------------------------------------------------------------------------
  func ignite(why: String) {
    guard !igniting else { return }
    igniting = true
    unregisterHotKey() // ARES takes ⌥Space over as it comes up
    log("ignite (\(why))")
    for p in panels { p.send(["type": "ignite"]) }
    if aresPid() == nil {
      let cfg = config()
      if let app = cfg["app"] as? String, !app.isEmpty {
        // -g: don't activate (no Space switch, nothing comes to the front); -j: launch hidden (no Dock bounce). ARES shows its desktop itself.
        let t = Process(); t.executableURL = URL(fileURLWithPath: "/usr/bin/open"); t.arguments = ["-g", "-j", "-a", app]; try? t.run()
        launchedAt = Date()
      } else { log("no app to launch in config.json (development): waiting for ARES to be started by hand") }
    }
  }
  func pollAres() {
    let alive = aresPid() != nil
    if alive { aliveSince = aliveSince ?? Date() } else { aliveSince = nil }
    if alive && !link.connected {
      if link.connect() {
        log("connected to ARES")
        if !igniting { igniting = true; unregisterHotKey(); for p in panels { p.send(["type": "ignite"]) } } // ARES started from the Dock: the same sequence
        link.onLine = { [weak self] line in self?.fromAres(line) }
        link.onClose = { [weak self] in log("ARES hung up"); if self?.handedOver == true || aresPid() == nil { self?.finish() } }
        link.send(["type": "hello", "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"])
      } else if let since = aliveSince, Date().timeIntervalSince(since) > 20 { log("ARES runs but has no socket: leaving"); finish() }
    }
    if !alive && igniting, let at = launchedAt, Date().timeIntervalSince(at) > 60 { log("ARES never came up"); igniting = false; launchedAt = nil; registerHotKey(); for p in panels { p.send(["type": "failed"]) } }
    if !alive && !igniting && hotKey == nil { registerHotKey() }
  }
  func fromAres(_ line: String) {
    guard let data = line.data(using: .utf8), let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = msg["type"] as? String else { return }
    switch type {
    case "hello", "step", "ready": for p in panels { p.send(msg) }
    case "handover", "exit": for p in panels { p.send(["type": "handover"]) }; handedOver = true; DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { self.finish() }
    default: break
    }
  }
  func wake() { link.send(["type": "wake"]); handedOver = true; DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { self.finish() } }
  func finish() { log("done"); for p in panels { p.window.orderOut(nil) }; NSApp.terminate(nil) }

  // ---- Sounds (the same WAVs as the window; silent when ARES's setting says so) ------------------------------------------------------------
  func play(_ name: String, stop: Bool) {
    if stop { sounds[name]?.stop(); return }
    guard (config()["sounds"] as? Bool) != false else { return }
    let url = resources.appendingPathComponent("sounds/\(name).wav")
    guard let s = sounds[name] ?? NSSound(contentsOf: url, byReference: true) else { return }
    sounds[name] = s
    s.volume = 0.5
    s.stop(); s.play()
  }
}

let app = NSApplication.shared
let delegate = Ignition()
Ignition.shared = delegate
app.delegate = delegate
signal(SIGTERM) { _ in try? FileManager.default.removeItem(at: dir.appendingPathComponent("helper.pid")); exit(0) }
app.run()
