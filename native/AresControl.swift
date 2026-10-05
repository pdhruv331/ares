// ares-control: what full Mac control (docs/autonomy-prompt.md, section 0) needs from macOS, public APIs only.
// Run by control.js in the ARES app; every command prints one JSON line. Needs Accessibility for the element
// tree, window moves and synthetic input (under ARES's own grant), Screen Recording for other apps' window
// titles. Nothing here reads the screen's pixels: screenshots are taken by `screencapture` in control.js.
//
//   ares-control session                 {"locked":bool,"asleep":bool,"accessibility":bool,"screenRecording":bool,
//                                         "front":{"name","bundle","pid"}}
//   ares-control screen-prompt           Asks macOS for the Screen Recording prompt for ARES: {"granted":bool}
//   ares-control screens                 Displays, top-left origin: [{"i","x","y","w","h","visible":{x,y,w,h},"main":bool}]
//   ares-control windows                 Every ordinary window, front to back: [{"wid","pid","app","bundle","title","x","y","w","h",
//                                         "onscreen","min","front"}]
//   ares-control window <pid> <json>     One window of an app, picked by {"title","x","y","w","h"} (frame first, then title), and
//                                         an op: {"op":"frame","x","y","w","h"} | minimize | unminimize | zoom | fullscreen |
//                                         unfullscreen | close | raise  → {"ok":bool,"title"}
//   ares-control ax-tree <pid> [max]     The app's focused window as a flat list of its elements (buttons, fields, links, text…),
//                                         each with a short id that ax-act takes: {"app","window","frame":[x,y,w,h],"elements":[…]}
//   ares-control ax-act <pid> <id> <action> [text]   press | focus | set <text> | type <text> | click | dblclick | scroll <dy>
//   ares-control menu <pid> <path>       Chooses a menu item by titles, e.g. "File>Save As…" (AXPress): {"ok":bool}
//   ares-control click <x> <y> [double|right]   A real click at screen coordinates (CGEvents)
//   ares-control type <text>             Types text into whatever has focus (newlines press Return)
//   ares-control key <combo>             A key press: "return", "esc", "cmd+s", "ctrl+right", "cmd+shift+t"
//   ares-control pdf-text <file> [maxChars]   The PDF's text (PDFKit); scans without a text layer are OCR'd (Vision, up to 20 pages):
//                                         {"pages","text","ocr":bool,"chars"}
//   ares-control ocr <image>             Text in a picture (Vision): {"text"}
//   ares-control highlight <x> <y> <w> <h> <ms>   A glowing frame around that screen rectangle for <ms>, so the user sees
//                                         what ARES is about to touch (click-through, on every Space)
import AppKit
import ApplicationServices
import Foundation
import PDFKit
import Vision

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

// ---- Accessibility helpers ---------------------------------------------------------------------------------
func axValue(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}
func axString(_ el: AXUIElement, _ attr: String) -> String? {
  guard let v = axValue(el, attr) else { return nil }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  if let u = v as? URL { return u.absoluteString }
  if let a = v as? NSAttributedString { return a.string }
  return nil
}
func axBool(_ el: AXUIElement, _ attr: String) -> Bool { (axValue(el, attr) as? Bool) ?? false }
func axElements(_ el: AXUIElement, _ attr: String) -> [AXUIElement] { (axValue(el, attr) as? [AXUIElement]) ?? [] }
func axElement(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
  guard let v = axValue(el, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}
func axPoint(_ el: AXUIElement) -> CGPoint? {
  guard let v = axValue(el, kAXPositionAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}
func axSize(_ el: AXUIElement) -> CGSize? {
  guard let v = axValue(el, kAXSizeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var s = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}
func axFrame(_ el: AXUIElement) -> CGRect? {
  guard let p = axPoint(el), let s = axSize(el) else { return nil }
  return CGRect(origin: p, size: s)
}
@discardableResult func axSet(_ el: AXUIElement, _ attr: String, _ value: CFTypeRef) -> Bool {
  AXUIElementSetAttributeValue(el, attr as CFString, value) == .success
}
func axSetPoint(_ el: AXUIElement, _ p: CGPoint) -> Bool {
  var p = p
  guard let v = AXValueCreate(.cgPoint, &p) else { return false }
  return axSet(el, kAXPositionAttribute, v)
}
func axSetSize(_ el: AXUIElement, _ s: CGSize) -> Bool {
  var s = s
  guard let v = AXValueCreate(.cgSize, &s) else { return false }
  return axSet(el, kAXSizeAttribute, v)
}
func axActions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
  return list
}
func axWindows(_ app: AXUIElement) -> [AXUIElement] { axElements(app, kAXWindowsAttribute) }
func runningApp(_ pid: Int32) -> NSRunningApplication? { NSRunningApplication(processIdentifier: pid) }
func appElement(_ pid: Int32) -> AXUIElement { AXUIElementCreateApplication(pid) }
func round4(_ v: CGFloat) -> Int { Int((v / 4).rounded()) * 4 }

// ---- Screens (top-left origin, like CGWindowList and screencapture) -----------------------------------------
let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
func flipRect(_ r: NSRect) -> [String: Any] { ["x": r.minX, "y": primaryHeight - r.maxY, "w": r.width, "h": r.height] }
func screensInfo() -> [[String: Any]] {
  NSScreen.screens.enumerated().map { (i, s) in
    var d = flipRect(s.frame)
    d["i"] = i
    d["visible"] = flipRect(s.visibleFrame)
    d["main"] = s == NSScreen.main
    return d
  }
}

// ---- Windows -----------------------------------------------------------------------------------------------
let IGNORED_OWNERS: Set<String> = ["Window Server", "Dock", "Notification Center", "Control Center", "Spotlight", "SystemUIServer", "Wallpaper", "ARES Wallpaper",
                                   "borders", "sketchybar", "CursorUIViewService", "Open and Save Panel Service", "loginwindow", "ScreenSaverEngine", "TextInputMenuAgent"]
func cgWindows() -> [[String: Any]] {
  guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  let trusted = AXIsProcessTrusted()
  var axCache: [Int32: [(title: String, frame: CGRect, min: Bool)]] = [:]
  var out: [[String: Any]] = []
  let front = NSWorkspace.shared.frontmostApplication
  var seenFront = false
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    if IGNORED_OWNERS.contains(owner) { continue }
    let bundleId = runningApp(pid)?.bundleIdentifier ?? ""
    if bundleId.contains(".xpc.") || bundleId.hasSuffix(".xpc") { continue } // system view services, not the user's windows
    guard let b = w[kCGWindowBounds as String] as? [String: Any], let wd = b["Width"] as? CGFloat, let ht = b["Height"] as? CGFloat,
          let x = b["X"] as? CGFloat, let y = b["Y"] as? CGFloat, wd >= 50, ht >= 50 else { continue }
    let frame = CGRect(x: x, y: y, width: wd, height: ht)
    var title = w[kCGWindowName as String] as? String ?? "" // empty without Screen Recording: fall back to Accessibility
    var minimized = false
    if trusted {
      if axCache[pid] == nil {
        axCache[pid] = axWindows(appElement(pid)).compactMap { el in
          guard let f = axFrame(el) else { return nil }
          return (axString(el, kAXTitleAttribute) ?? "", f, axBool(el, kAXMinimizedAttribute))
        }
      }
      if let match = axCache[pid]!.first(where: { abs($0.frame.minX - frame.minX) < 3 && abs($0.frame.minY - frame.minY) < 3 && abs($0.frame.width - frame.width) < 3 }) {
        if title.isEmpty { title = match.title }
        minimized = match.min
      }
    }
    let onscreen = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
    let isFront = !seenFront && onscreen && front?.processIdentifier == pid
    if isFront { seenFront = true }
    out.append([
      "wid": (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0, "pid": Int(pid), "app": owner,
      "bundle": bundleId, "title": title,
      "x": x, "y": y, "w": wd, "h": ht, "onscreen": onscreen, "min": minimized, "front": isFront,
    ])
  }
  return out
}

/** The AX window of an app that best matches a frame or title. */
func pickWindow(_ pid: Int32, _ spec: [String: Any]) -> AXUIElement? {
  let wins = axWindows(appElement(pid))
  if let x = spec["x"] as? CGFloat, let y = spec["y"] as? CGFloat, let wd = spec["w"] as? CGFloat {
    if let w = wins.first(where: { f in guard let fr = axFrame(f) else { return false }; return abs(fr.minX - x) < 3 && abs(fr.minY - y) < 3 && abs(fr.width - wd) < 3 }) { return w }
  }
  if let t = spec["title"] as? String, !t.isEmpty {
    if let w = wins.first(where: { (axString($0, kAXTitleAttribute) ?? "") == t }) { return w }
    if let w = wins.first(where: { (axString($0, kAXTitleAttribute) ?? "").localizedCaseInsensitiveContains(t) }) { return w }
  }
  return wins.first(where: { !axBool($0, kAXMinimizedAttribute) }) ?? wins.first
}

// ---- The element tree (what ARES "sees" in a window) -------------------------------------------------------
let INTERACTIVE: Set<String> = ["AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea",
                                "AXComboBox", "AXLink", "AXMenuItem", "AXTab", "AXSlider", "AXIncrementor", "AXDisclosureTriangle",
                                "AXColorWell", "AXSearchField", "AXSegmentedControl", "AXSwitch", "AXToggle", "AXCell", "AXRow", "AXDateField", "AXTimeField"]
let TEXTUAL: Set<String> = ["AXStaticText", "AXHeading", "AXImage"]
let ROLE_WORDS: [String: String] = ["AXButton": "button", "AXPopUpButton": "popup", "AXMenuButton": "menu-button", "AXCheckBox": "checkbox", "AXRadioButton": "radio",
                                    "AXTextField": "field", "AXTextArea": "textarea", "AXComboBox": "combo", "AXLink": "link", "AXMenuItem": "menu-item", "AXTab": "tab",
                                    "AXSlider": "slider", "AXIncrementor": "stepper", "AXDisclosureTriangle": "disclosure", "AXStaticText": "text", "AXHeading": "heading",
                                    "AXImage": "image", "AXCell": "cell", "AXRow": "row", "AXSearchField": "search", "AXSegmentedControl": "segments", "AXSwitch": "switch",
                                    "AXToggle": "toggle", "AXColorWell": "colour", "AXDateField": "date", "AXTimeField": "time"]

func fnv(_ s: String) -> String {
  var h: UInt64 = 0xcbf29ce484222325
  for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
  return String(h % 1_679_616, radix: 36).leftPad(4) // four base-36 characters
}
extension String { func leftPad(_ n: Int) -> String { count >= n ? self : String(repeating: "0", count: n - count) + self } }
func short(_ s: String?, _ n: Int = 90) -> String {
  guard let s = s else { return "" }
  let flat = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
  return flat.count > n ? String(flat.prefix(n - 1)) + "…" : flat
}

struct Element { let el: AXUIElement; let id: String; let role: String; let title: String; let value: String; let frame: CGRect; let actions: [String]; let enabled: Bool; let focused: Bool }

func elementTitle(_ el: AXUIElement, _ role: String) -> String {
  for attr in [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXPlaceholderValueAttribute, kAXHelpAttribute, kAXRoleDescriptionAttribute] {
    if let s = axString(el, attr), !s.isEmpty, !(attr == kAXRoleDescriptionAttribute && INTERACTIVE.contains(role)) { return s }
  }
  if let titleEl = axElement(el, kAXTitleUIElementAttribute), let s = axString(titleEl, kAXValueAttribute) ?? axString(titleEl, kAXTitleAttribute) { return s }
  return ""
}

func collect(_ root: AXUIElement, within bounds: CGRect, max: Int) -> (elements: [Element], truncated: Bool) {
  var out: [Element] = []
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var visited = 0
  var truncated = false
  while !queue.isEmpty {
    let (el, depth) = queue.removeFirst()
    visited += 1
    if visited > 6000 || out.count >= max { truncated = true; break }
    let role = axString(el, kAXRoleAttribute) ?? ""
    let frame = axFrame(el) ?? .zero
    let visible = frame.width > 1 && frame.height > 1 && frame.intersects(bounds)
    let subrole = axString(el, kAXSubroleAttribute) ?? ""
    let effectiveRole = subrole == "AXSearchField" ? "AXSearchField" : role
    if visible && (INTERACTIVE.contains(effectiveRole) || TEXTUAL.contains(role)) && depth > 0 {
      let title = short(elementTitle(el, effectiveRole))
      var value = ""
      if let v = axValue(el, kAXValueAttribute) {
        if let s = v as? String { value = short(s, 120) }
        else if let n = v as? NSNumber { value = n.stringValue }
        else if let a = v as? NSAttributedString { value = short(a.string, 120) }
      }
      if role == "AXStaticText" && title.isEmpty && value.isEmpty { /* nothing to show */ }
      else if role == "AXImage" && title.isEmpty { /* decoration */ }
      else {
        let key = "\(effectiveRole)|\(title)|\(round4(frame.minX)),\(round4(frame.minY)),\(round4(frame.width)),\(round4(frame.height))"
        let actions = axActions(el).map { $0.replacingOccurrences(of: "AX", with: "").lowercased() }.filter { $0 != "showmenu" && $0 != "scrolltovisible" && $0 != "showdefaultui" && $0 != "showalternateui" }
        out.append(Element(el: el, id: fnv(key), role: effectiveRole, title: title, value: value, frame: frame, actions: actions,
                           enabled: (axValue(el, kAXEnabledAttribute) as? Bool) ?? true, focused: axBool(el, kAXFocusedAttribute)))
      }
    }
    if depth < 60 && role != "AXMenuBar" {
      for c in axElements(el, kAXChildrenAttribute) { queue.append((c, depth + 1)) }
    }
  }
  return (out, truncated)
}

func focusedWindow(_ pid: Int32) -> AXUIElement? {
  let app = appElement(pid)
  if let w = axElement(app, kAXFocusedWindowAttribute) { return w }
  if let w = axElement(app, kAXMainWindowAttribute) { return w }
  return axWindows(app).first(where: { !axBool($0, kAXMinimizedAttribute) }) ?? axWindows(app).first
}

func tree(_ pid: Int32, max: Int) -> (window: AXUIElement?, frame: CGRect, elements: [Element], truncated: Bool) {
  guard let win = focusedWindow(pid) else { return (nil, .zero, [], false) }
  let frame = axFrame(win) ?? CGRect(x: 0, y: 0, width: 10000, height: 10000)
  let (els, truncated) = collect(win, within: frame, max: max)
  return (win, frame, els, truncated)
}

func elementJSON(_ e: Element) -> [String: Any] {
  var d: [String: Any] = ["id": e.id, "role": ROLE_WORDS[e.role] ?? e.role.replacingOccurrences(of: "AX", with: "").lowercased(), "title": e.title,
                          "frame": [Int(e.frame.minX), Int(e.frame.minY), Int(e.frame.width), Int(e.frame.height)]]
  if !e.value.isEmpty { d["value"] = e.value }
  if !e.actions.isEmpty { d["actions"] = e.actions }
  if !e.enabled { d["enabled"] = false }
  if e.focused { d["focused"] = true }
  return d
}

// ---- Synthetic input (CGEvents: a real click or key press, under Accessibility) ------------------------------
let eventSource = CGEventSource(stateID: .combinedSessionState)
func pause(_ ms: Int) { usleep(useconds_t(ms * 1000)) }
func mouse(_ type: CGEventType, _ p: CGPoint, button: CGMouseButton = .left, clicks: Int = 1) {
  guard let e = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
  e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
  e.post(tap: .cghidEventTap)
}
func clickAt(_ p: CGPoint, double: Bool = false, right: Bool = false) {
  mouse(.mouseMoved, p)
  pause(60)
  if right { mouse(.rightMouseDown, p, button: .right); pause(40); mouse(.rightMouseUp, p, button: .right); return }
  mouse(.leftMouseDown, p); pause(40); mouse(.leftMouseUp, p)
  if double { pause(60); mouse(.leftMouseDown, p, clicks: 2); pause(40); mouse(.leftMouseUp, p, clicks: 2) }
}
func scrollAt(_ p: CGPoint, _ dy: Int) {
  mouse(.mouseMoved, p)
  pause(40)
  // Several small ticks read more like a person's wheel than one big jump
  let steps = max(1, min(12, abs(dy) / 40))
  for _ in 0..<steps {
    if let e = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 1, wheel1: Int32(-dy / steps), wheel2: 0, wheel3: 0) { e.location = p; e.post(tap: .cghidEventTap) }
    pause(25)
  }
}
let KEYS: [String: CGKeyCode] = ["a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
  "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "forwarddelete": 117, "esc": 53, "escape": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111]
func keyPress(_ combo: String) -> Bool {
  var flags: CGEventFlags = []
  var key: CGKeyCode?
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    switch part {
    case "cmd", "command", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default: key = KEYS[part]
    }
  }
  guard let code = key, let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false) else { return false }
  down.flags = flags; up.flags = flags
  down.post(tap: .cghidEventTap); pause(30); up.post(tap: .cghidEventTap)
  return true
}
func typeText(_ text: String) {
  for line in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
    if line.offset > 0 { _ = keyPress("return"); pause(40) }
    var rest = Substring(line.element)
    while !rest.isEmpty {
      let chunk = String(rest.prefix(16)) // CGEvent takes short unicode strings; chunks keep every character
      rest = rest.dropFirst(chunk.count)
      var units = Array(chunk.utf16)
      guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) else { continue }
      down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      down.post(tap: .cghidEventTap); pause(8); up.post(tap: .cghidEventTap); pause(12)
    }
  }
}

// ---- Text out of documents and pictures ------------------------------------------------------------------
func recognise(_ cg: CGImage) -> String {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  // Reading order: top to bottom, then left to right (Vision's origin is bottom-left)
  let lines = (req.results ?? []).compactMap { r -> (String, CGFloat, CGFloat)? in
    guard let s = r.topCandidates(1).first?.string else { return nil }
    return (s, r.boundingBox.midY, r.boundingBox.minX)
  }.sorted { a, b in abs(a.1 - b.1) > 0.012 ? a.1 > b.1 : a.2 < b.2 }
  return lines.map { $0.0 }.joined(separator: "\n")
}
func cgImage(_ image: NSImage) -> CGImage? {
  var rect = NSRect(origin: .zero, size: image.size)
  return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

// ---- The highlight: a glowing frame where ARES is about to act --------------------------------------------
final class HighlightView: NSView {
  override func draw(_ dirtyRect: NSRect) {
    let r = bounds.insetBy(dx: 5, dy: 5)
    let path = NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8)
    NSColor(red: 0.24, green: 0.9, blue: 1, alpha: 0.95).setStroke()
    path.lineWidth = 3
    path.stroke()
    let glow = NSBezierPath(roundedRect: r.insetBy(dx: -3, dy: -3), xRadius: 10, yRadius: 10)
    NSColor(red: 0.24, green: 0.9, blue: 1, alpha: 0.35).setStroke()
    glow.lineWidth = 5
    glow.stroke()
    let label = NSAttributedString(string: "ARES", attributes: [.font: NSFont.systemFont(ofSize: 10, weight: .bold), .foregroundColor: NSColor(red: 0.24, green: 0.9, blue: 1, alpha: 1)])
    let size = label.size()
    let box = NSRect(x: r.minX + 4, y: r.maxY - size.height - 4, width: size.width + 8, height: size.height + 2)
    NSColor(red: 0.05, green: 0.1, blue: 0.14, alpha: 0.85).setFill()
    NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4).fill()
    label.draw(at: NSPoint(x: box.minX + 4, y: box.minY + 1))
  }
}

// ---- main ------------------------------------------------------------------------------------------------------
let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "session":
  let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
  let locked = (session["CGSSessionScreenIsLocked"] as? Bool) ?? ((session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false)
  let front = NSWorkspace.shared.frontmostApplication
  emit(["locked": locked, "asleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
        "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
        "front": ["name": front?.localizedName ?? "", "bundle": front?.bundleIdentifier ?? "", "pid": Int(front?.processIdentifier ?? 0)]])

case "screen-prompt":
  emit(["granted": CGRequestScreenCaptureAccess()])

case "screens":
  emit(screensInfo())

case "windows":
  emit(cgWindows())

case "window":
  guard args.count >= 4, let pid = Int32(args[2]), let data = args[3].data(using: .utf8),
        let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fail("usage: ares-control window <pid> <json>") }
  guard AXIsProcessTrusted() else { emit(["ok": false, "error": "no Accessibility permission"]); exit(0) }
  guard let win = pickWindow(pid, spec) else { emit(["ok": false, "error": "no such window"]); exit(0) }
  let app = appElement(pid)
  var ok = false
  switch spec["op"] as? String ?? "" {
  case "frame":
    guard let x = spec["x"] as? CGFloat, let y = spec["y"] as? CGFloat, let w = spec["w"] as? CGFloat, let h = spec["h"] as? CGFloat else { fail("frame needs x y w h") }
    if axBool(win, kAXMinimizedAttribute) { axSet(win, kAXMinimizedAttribute, kCFBooleanFalse) }
    if axBool(win, "AXFullScreen") { axSet(win, "AXFullScreen", kCFBooleanFalse); pause(900) }
    // Size first so a window that can't shrink past a minimum still lands where asked
    _ = axSetSize(win, CGSize(width: w, height: h))
    ok = axSetPoint(win, CGPoint(x: x, y: y))
    _ = axSetSize(win, CGSize(width: w, height: h))
    _ = axSetPoint(win, CGPoint(x: x, y: y))
  case "minimize": ok = axSet(win, kAXMinimizedAttribute, kCFBooleanTrue)
  case "unminimize": ok = axSet(win, kAXMinimizedAttribute, kCFBooleanFalse)
  case "zoom": if let b = axElement(win, kAXZoomButtonAttribute) { ok = AXUIElementPerformAction(b, kAXPressAction as CFString) == .success }
  case "fullscreen": ok = axSet(win, "AXFullScreen", kCFBooleanTrue)
  case "unfullscreen": ok = axSet(win, "AXFullScreen", kCFBooleanFalse)
  case "close": if let b = axElement(win, kAXCloseButtonAttribute) { ok = AXUIElementPerformAction(b, kAXPressAction as CFString) == .success }
  case "raise":
    axSet(win, kAXMinimizedAttribute, kCFBooleanFalse)
    runningApp(pid)?.activate(options: [])
    axSet(app, kAXFrontmostAttribute, kCFBooleanTrue)
    ok = AXUIElementPerformAction(win, kAXRaiseAction as CFString) == .success
  default: fail("unknown op")
  }
  emit(["ok": ok, "title": axString(win, kAXTitleAttribute) ?? ""])

case "ax-tree":
  guard args.count >= 3, let pid = Int32(args[2]) else { fail("usage: ares-control ax-tree <pid> [max]") }
  guard AXIsProcessTrusted() else { emit(["error": "no Accessibility permission", "elements": []]); exit(0) }
  let maxN = args.count > 3 ? Int(args[3]) ?? 300 : 300
  let t = tree(pid, max: maxN)
  guard let win = t.window else { emit(["error": "the app has no window", "elements": []]); exit(0) }
  emit(["app": runningApp(pid)?.localizedName ?? "", "window": axString(win, kAXTitleAttribute) ?? "",
        "frame": [Int(t.frame.minX), Int(t.frame.minY), Int(t.frame.width), Int(t.frame.height)],
        "elements": t.elements.map(elementJSON), "truncated": t.truncated])

case "ax-act":
  guard args.count >= 5, let pid = Int32(args[2]) else { fail("usage: ares-control ax-act <pid> <id> <action> [text]") }
  guard AXIsProcessTrusted() else { emit(["ok": false, "error": "no Accessibility permission"]); exit(0) }
  let id = args[3], action = args[4], text = args.count > 5 ? args[5] : ""
  let t = tree(pid, max: 2000)
  guard let e = t.elements.first(where: { $0.id == id }) else { emit(["ok": false, "error": "that element isn't there any more: read the window again"]); exit(0) }
  let centre = CGPoint(x: e.frame.midX, y: e.frame.midY)
  var ok = false
  func focus() { axSet(appElement(pid), kAXFrontmostAttribute, kCFBooleanTrue); runningApp(pid)?.activate(options: []); axSet(e.el, kAXFocusedAttribute, kCFBooleanTrue); pause(120) }
  switch action {
  case "press":
    if e.actions.contains("press") { ok = AXUIElementPerformAction(e.el, kAXPressAction as CFString) == .success }
    if !ok { runningApp(pid)?.activate(options: []); pause(150); clickAt(centre); ok = true }
  case "click": runningApp(pid)?.activate(options: []); pause(150); clickAt(centre); ok = true
  case "dblclick": runningApp(pid)?.activate(options: []); pause(150); clickAt(centre, double: true); ok = true
  case "focus": focus(); ok = axBool(e.el, kAXFocusedAttribute)
  case "set":
    focus()
    ok = axSet(e.el, kAXValueAttribute, text as CFTypeRef)
    if !ok || (axString(e.el, kAXValueAttribute) ?? "") != text { // the app won't take a value directly: select all and type it
      clickAt(centre); pause(120); _ = keyPress("cmd+a"); pause(60); typeText(text); ok = true
    }
  case "type": focus(); if !axBool(e.el, kAXFocusedAttribute) { clickAt(centre); pause(120) }; typeText(text); ok = true
  case "scroll": runningApp(pid)?.activate(options: []); pause(120); scrollAt(centre, Int(text) ?? 300); ok = true
  default: fail("unknown action")
  }
  emit(["ok": ok, "title": e.title, "role": ROLE_WORDS[e.role] ?? e.role, "value": axString(e.el, kAXValueAttribute) ?? ""])

case "menu":
  guard args.count >= 4, let pid = Int32(args[2]) else { fail("usage: ares-control menu <pid> <Menu>Item>Subitem>") }
  guard AXIsProcessTrusted() else { emit(["ok": false, "error": "no Accessibility permission"]); exit(0) }
  let titles = args[3].split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }
  guard var node = axElement(appElement(pid), kAXMenuBarAttribute) else { emit(["ok": false, "error": "no menu bar"]); exit(0) }
  var found = true
  for (i, want) in titles.enumerated() {
    let children = axElements(node, kAXChildrenAttribute)
    let items = i == 0 ? children : (children.first.map { axElements($0, kAXChildrenAttribute) } ?? children) // a menu's items live in its one AXMenu child
    let clean = { (s: String) in s.replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces).lowercased() }
    guard let next = items.first(where: { clean(axString($0, kAXTitleAttribute) ?? "") == clean(want) })
      ?? items.first(where: { clean(axString($0, kAXTitleAttribute) ?? "").hasPrefix(clean(want)) }) else { found = false; break }
    node = next
  }
  guard found else { emit(["ok": false, "error": "no menu item \(args[3])"]); exit(0) }
  runningApp(pid)?.activate(options: [])
  pause(120)
  emit(["ok": AXUIElementPerformAction(node, kAXPressAction as CFString) == .success, "title": axString(node, kAXTitleAttribute) ?? ""])

case "click":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { fail("usage: ares-control click <x> <y> [double|right]") }
  let mode = args.count > 4 ? args[4] : ""
  clickAt(CGPoint(x: x, y: y), double: mode == "double", right: mode == "right")
  emit(["ok": true])

case "type":
  guard args.count >= 3 else { fail("usage: ares-control type <text>") }
  typeText(args[2])
  emit(["ok": true])

case "key":
  guard args.count >= 3 else { fail("usage: ares-control key <combo>") }
  emit(["ok": keyPress(args[2])])

case "pdf-text":
  guard args.count >= 3 else { fail("usage: ares-control pdf-text <file> [maxChars]") }
  guard let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else { emit(["error": "not a readable PDF"]); exit(0) }
  let maxChars = args.count > 3 ? Int(args[3]) ?? 60000 : 60000
  var text = ""
  for i in 0..<doc.pageCount {
    if let s = doc.page(at: i)?.string { text += "\n\n[Page \(i + 1)]\n" + s }
    if text.count > maxChars * 2 { break }
  }
  let words = text.split(whereSeparator: { $0.isWhitespace }).count
  var ocr = false
  if words < 12 * max(1, min(doc.pageCount, 3)) { // no text layer: a scan. Read the pictures
    ocr = true
    text = ""
    for i in 0..<min(doc.pageCount, 20) {
      guard let page = doc.page(at: i) else { continue }
      let box = page.bounds(for: .mediaBox)
      let scale = min(3.0, 2400 / max(box.width, box.height))
      let img = page.thumbnail(of: CGSize(width: box.width * scale, height: box.height * scale), for: .mediaBox)
      if let cg = cgImage(img) { text += "\n\n[Page \(i + 1)]\n" + recognise(cg) }
      if text.count > maxChars { break }
    }
  }
  emit(["pages": doc.pageCount, "text": String(text.prefix(maxChars)), "ocr": ocr, "chars": text.count])

case "ocr":
  guard args.count >= 3, let img = NSImage(contentsOfFile: args[2]), let cg = cgImage(img) else { emit(["error": "not a readable image"]); exit(0) }
  emit(["text": recognise(cg), "width": cg.width, "height": cg.height])

case "highlight":
  guard args.count >= 7, let x = Double(args[2]), let y = Double(args[3]), let w = Double(args[4]), let h = Double(args[5]), let ms = Int(args[6]) else { fail("usage: ares-control highlight <x> <y> <w> <h> <ms>") }
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let pad: CGFloat = 8
  let rect = NSRect(x: x - Double(pad), y: Double(primaryHeight) - y - h - Double(pad), width: w + Double(pad) * 2, height: h + Double(pad) * 2)
  let win = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
  win.level = .screenSaver
  win.isOpaque = false
  win.backgroundColor = .clear
  win.hasShadow = false
  win.ignoresMouseEvents = true
  win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
  win.contentView = HighlightView(frame: NSRect(origin: .zero, size: rect.size))
  win.orderFrontRegardless()
  DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { exit(0) }
  app.run()

default:
  fail("ares-control: unknown command. See the header of AresControl.swift.")
}
