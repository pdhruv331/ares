// ares-vision: ARES's one camera owner (docs/hand-tracking-prompt.md, later docs/gaze-prompt.md).
// The built-in camera runs here and nowhere else. Frames never leave this process: nothing is stored, logged or
// sent. Only joint coordinates go out, as JSON lines on stdout.
//
// Requests are a list (hands now; face/gaze later share the same capture session and frames):
//   VisionTask.hands   VNDetectHumanHandPoseRequest, up to 2 hands, on-device
//
// Protocol (JSON lines on stdout):
//   {"type":"ready"}
//   {"type":"permission","status":"authorized|denied|restricted|notDetermined"}
//   {"type":"camera","on":true,"res":"low","fps":10,"w":640,"h":480}      the camera (and its green light) is on
//   {"type":"camera","on":false,"why":"stop|lid|error|suspended"}         the camera is fully off
//   {"type":"hands","ts":<ms>,"key":1.8,"face":[x,y,w,h]|null,"hands":[{"side":"left|right|?","c":0.93,"j":[[x,y,c] | null ×21]}]}
//        key = seconds since the last key press (CGEventSource, no permission needed), so typing can be ignored.
//        face = the largest face's box (VNDetectFaceRectanglesRequest, mirrored), so hands at the face can be ignored.
//        x,y normalised 0…1, origin top-left, x MIRRORED (move your hand right → x grows). c = confidence.
//        Joint order (as MediaPipe): wrist; thumb CMC MP IP tip; index MCP PIP DIP tip; middle …; ring …; little …
//        Joints under the confidence floor are null. Smoothed with a One Euro filter per joint.
//   {"type":"stats","fps":9.8,"ms":7.1}                                   every 5 s while on: frames processed, Vision ms/frame
//   {"type":"error","code":"denied|nocamera|config","message":"…"}
// Commands (lines on stdin, or on the socket):
//   start | stop | rate <fps> | res low|high | filter <minCutoff> <beta> | floor <confidence> | status | quit
//   preview on|off      a floating window showing what the camera sees, with the joints drawn on it (tuning). The
//                       frames still never leave this process: ARES only sends back what to draw over them:
//   overlay <json>      {"state","hands":[{"side","pose","valid"}],"box":[x,y,w,h],"cursor":[x,y],"acts":["…"]}
//   Events: {"type":"preview","on":false} when the window is closed by hand.
//
// Launch: ARES starts this as a real app through LaunchServices (`open -a "ARES Vision.app" --args --serve <socket>`), and the
// helper connects back to that UNIX socket and talks the line protocol over it. Why: macOS grants the camera to an app it can
// name; the same binary spawned as a plain child process is refused without any prompt (tested 2026-10-04). Over the socket,
// the helper exits as soon as ARES hangs up.
//
// Bench (no camera): ares-vision --bench <frames> <low|high> [image]   Vision cost per frame on a still image.
import AppKit
import AVFoundation
import CoreGraphics
import CoreImage
import Foundation
import IOKit
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

// Where lines go: stdout, or the socket ARES is listening on
var outFD: Int32 = 1
let outLock = NSLock()
func emitLine(_ s: String) {
  outLock.lock(); defer { outLock.unlock() }
  let data = Array((s + "\n").utf8)
  var off = 0
  data.withUnsafeBytes { p in
    while off < data.count {
      let n = write(outFD, p.baseAddress! + off, data.count - off)
      if n <= 0 { if outFD != 1 { exit(0) }; return } // ARES hung up
      off += Int(n)
    }
  }
}
func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
  emitLine(s)
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/** The lid is closed (clamshell). The built-in camera can't see anything then, so it stays off. */
func lidClosed() -> Bool {
  let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
  guard root != 0 else { return false }
  defer { IOObjectRelease(root) }
  let v = IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
  return (v as? Bool) ?? false
}

// ---- One Euro filter (Casiez et al. 2012): little lag when moving fast, little jitter when still ------------------
final class OneEuro {
  var minCutoff: Double, beta: Double, dCutoff: Double
  private var x: Double? = nil, dx = 0.0, t: Double = 0
  init(minCutoff: Double, beta: Double, dCutoff: Double = 1.0) { self.minCutoff = minCutoff; self.beta = beta; self.dCutoff = dCutoff }
  private func alpha(_ cutoff: Double, _ dt: Double) -> Double { let tau = 1 / (2 * Double.pi * cutoff); return 1 / (1 + tau / dt) }
  func reset() { x = nil }
  func filter(_ v: Double, _ ts: Double) -> Double {
    guard let px = x else { x = v; t = ts; return v }
    let dt = max(1e-3, (ts - t) / 1000)
    t = ts
    let a_d = alpha(dCutoff, dt)
    dx = a_d * ((v - px) / dt) + (1 - a_d) * dx
    let a = alpha(minCutoff + beta * abs(dx), dt)
    let nx = a * v + (1 - a) * px
    x = nx
    return nx
  }
}

// ---- Requests: what is looked for in each frame -------------------------------------------------------------------
protocol VisionTask: AnyObject {
  var request: VNRequest { get }
  /** Called after the request ran on a frame; returns its part of the frame line ("key":value pairs). */
  func publish(ts: Double) -> String
}

/** Where the face is, as a box (the cheap face request, not landmarks): hands at the face are scratching, not gesturing. */
final class FaceTask: VisionTask {
  let face = VNDetectFaceRectanglesRequest()
  var request: VNRequest { face }
  private var last: (box: CGRect, ts: Double)? = nil
  func publish(ts: Double) -> String {
    if let o = (face.results ?? []).max(by: { $0.boundingBox.width < $1.boundingBox.width }) {
      let b = o.boundingBox // normalised, bottom-left origin, unmirrored
      let box = CGRect(x: 1 - b.maxX, y: 1 - b.maxY, width: b.width, height: b.height)
      last = (box, ts)
    } else if let l = last, ts - l.ts > 1500 { last = nil } // a face lost for a moment keeps its box
    guard let l = last else { return "\"face\":null" }
    return String(format: "\"face\":[%.3f,%.3f,%.3f,%.3f]", l.box.minX, l.box.minY, l.box.width, l.box.height)
  }
}

final class HandsTask: VisionTask {
  static let joints: [VNHumanHandPoseObservation.JointName] = [
    .wrist, .thumbCMC, .thumbMP, .thumbIP, .thumbTip, .indexMCP, .indexPIP, .indexDIP, .indexTip,
    .middleMCP, .middlePIP, .middleDIP, .middleTip, .ringMCP, .ringPIP, .ringDIP, .ringTip,
    .littleMCP, .littlePIP, .littleDIP, .littleTip,
  ]
  let hand = VNDetectHumanHandPoseRequest()
  var request: VNRequest { hand }
  var floor: Float = 0.3
  var minCutoff = 1.2, beta = 0.02
  var lastJoints: [[CGPoint?]] = []  // the last frame's filtered joints (mirrored, normalised), for the preview
  // Filters per hand slot ("left"/"right"/"?0"/"?1") × 21 joints × x,y
  private var filters: [String: [OneEuro]] = [:]
  private var lastSeen: [String: Double] = [:]

  init() { hand.maximumHandCount = 2 }

  func tune(minCutoff: Double, beta: Double) {
    self.minCutoff = minCutoff; self.beta = beta
    for fs in filters.values { for f in fs { f.minCutoff = minCutoff; f.beta = beta } }
  }

  func publish(ts: Double) -> String {
    let obs = hand.results ?? []
    var out: [String] = []   // written by hand: compact, fixed 4 decimals
    var used = Set<String>()
    var drawn: [[CGPoint?]] = []
    for (i, o) in obs.enumerated() {
      guard let pts = try? o.recognizedPoints(.all) else { continue }
      var side = "?"
      if #available(macOS 12.0, *) {
        // Vision names the hand as it appears in the (unmirrored) camera image; mirrored, it's the user's own hand
        switch o.chirality { case .left: side = "left"; case .right: side = "right"; default: side = "?" }
      }
      var slot = side == "?" ? "?\(i)" : side
      if used.contains(slot) { slot = "\(slot)\(i)" }
      used.insert(slot)
      if filters[slot] == nil || ts - (lastSeen[slot] ?? 0) > 400 {
        filters[slot] = (0..<42).map { _ in OneEuro(minCutoff: minCutoff, beta: beta) }
      }
      lastSeen[slot] = ts
      let fs = filters[slot]!
      var j: [String] = []
      var pts2: [CGPoint?] = []
      for (k, name) in HandsTask.joints.enumerated() {
        guard let p = pts[name], p.confidence >= floor else { j.append("null"); pts2.append(nil); continue }
        let x = fs[k * 2].filter(1 - Double(p.location.x), ts)      // mirrored
        let y = fs[k * 2 + 1].filter(1 - Double(p.location.y), ts)  // top-left origin
        j.append(String(format: "[%.4f,%.4f,%.2f]", x, y, p.confidence))
        pts2.append(CGPoint(x: x, y: y))
      }
      drawn.append(pts2)
      out.append(String(format: "{\"side\":\"%@\",\"c\":%.2f,\"j\":[%@]}", side, o.confidence, j.joined(separator: ",")))
    }
    lastJoints = drawn
    return "\"hands\":[" + out.joined(separator: ",") + "]"
  }
}

// ---- Preview window (tuning): the frame, the joints, and what ARES made of them ----------------------------------
final class PreviewView: NSView {
  var image: CGImage?
  var joints: [[CGPoint?]] = []
  var overlay: [String: Any] = [:]
  override var isFlipped: Bool { true }
  static let bones: [(Int, Int)] = [(0,1),(1,2),(2,3),(3,4),(0,5),(5,6),(6,7),(7,8),(0,9),(9,10),(10,11),(11,12),(0,13),(13,14),(14,15),(15,16),(0,17),(17,18),(18,19),(19,20),(5,9),(9,13),(13,17)]
  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    NSColor.black.setFill(); bounds.fill()
    let W = bounds.width, H = bounds.height
    if let img = image {
      // mirrored, so it reads like a mirror (joints are already mirrored)
      ctx.saveGState()
      ctx.translateBy(x: W, y: H); ctx.scaleBy(x: -1, y: -1)
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
      ctx.restoreGState()
    }
    let cyan = NSColor(calibratedRed: 0.24, green: 0.9, blue: 1, alpha: 1)
    let P = { (p: CGPoint) in CGPoint(x: p.x * W, y: p.y * H) }
    // the interaction box and where the hand maps inside it
    if let b = overlay["box"] as? [Double], b.count == 4 {
      let r = CGRect(x: b[0] * W, y: b[1] * H, width: b[2] * W, height: b[3] * H)
      ctx.setStrokeColor(cyan.withAlphaComponent(0.7).cgColor); ctx.setLineWidth(1); ctx.setLineDash(phase: 0, lengths: [4, 3]); ctx.stroke(r); ctx.setLineDash(phase: 0, lengths: [])
      if let c = overlay["cursor"] as? [Double], c.count == 2 {
        let p = CGPoint(x: r.minX + c[0] * r.width, y: r.minY + c[1] * r.height)
        ctx.setFillColor(NSColor.white.cgColor); ctx.fillEllipse(in: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8))
      }
    }
    let handInfo = overlay["hands"] as? [[String: Any]] ?? []
    for (i, h) in joints.enumerated() {
      let info = i < handInfo.count ? handInfo[i] : [:]
      let valid = (info["valid"] as? Bool) ?? true
      let col = valid ? cyan : NSColor.systemRed
      ctx.setStrokeColor(col.withAlphaComponent(0.9).cgColor); ctx.setLineWidth(2)
      for (a, b) in PreviewView.bones { if let pa = h[a], let pb = h[b] { ctx.move(to: P(pa)); ctx.addLine(to: P(pb)); ctx.strokePath() } }
      ctx.setFillColor(NSColor.white.cgColor)
      for p in h.compactMap({ $0 }) { let q = P(p); ctx.fillEllipse(in: CGRect(x: q.x - 2.5, y: q.y - 2.5, width: 5, height: 5)) }
      if let w = h[0] {
        let label = "\(info["side"] as? String ?? "?") · \(info["pose"] as? String ?? "")\(valid ? "" : " (ignored)")"
        (label as NSString).draw(at: CGPoint(x: P(w).x + 8, y: P(w).y + 4), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold), .foregroundColor: col])
      }
    }
    var lines = ["state: \(overlay["state"] as? String ?? "–")"]
    for a in (overlay["acts"] as? [String] ?? []) { lines.append(a) }
    var y: CGFloat = 8
    for (i, l) in lines.enumerated() {
      (l as NSString).draw(at: CGPoint(x: 8, y: y), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: i == 0 ? 13 : 11, weight: i == 0 ? .bold : .regular), .foregroundColor: i == 0 ? cyan : NSColor.white.withAlphaComponent(0.85)])
      y += i == 0 ? 18 : 14
    }
  }
}

final class Preview: NSObject, NSWindowDelegate {
  var window: NSWindow?
  let view = PreviewView()
  let ci = CIContext()
  var on: Bool { window != nil }
  func show() {
    if window == nil {
      let w = NSWindow(contentRect: NSRect(x: 60, y: 120, width: 480, height: 360), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
      w.title = "ARES Vision — what the camera sees"
      w.level = .floating
      w.isReleasedWhenClosed = false
      w.contentView = view
      w.delegate = self
      w.contentAspectRatio = NSSize(width: 4, height: 3)
      window = w
    }
    window?.orderFrontRegardless()
  }
  func hide() { window?.close(); window = nil }
  func windowWillClose(_ n: Notification) { window = nil; emit(["type": "preview", "on": false]) }
  /** From the capture queue. */
  func frame(_ px: CVPixelBuffer, joints: [[CGPoint?]]) {
    guard on, let cg = ci.createCGImage(CIImage(cvPixelBuffer: px), from: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(px), height: CVPixelBufferGetHeight(px))) else { return }
    DispatchQueue.main.async { self.view.image = cg; self.view.joints = joints; self.view.needsDisplay = true }
  }
  func overlay(_ o: [String: Any]) { DispatchQueue.main.async { self.view.overlay = o; self.view.needsDisplay = true } }
}
let preview = Preview()

func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }

// ---- The camera ------------------------------------------------------------------------------------------------
final class Camera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let session = AVCaptureSession()
  let queue = DispatchQueue(label: "ares.vision.frames")
  let output = AVCaptureVideoDataOutput()
  var device: AVCaptureDevice?
  var tasks: [VisionTask] = []
  var running = false
  var res = "low"
  var fps: Double = 10
  private var lastFrame = 0.0
  private var frames = 0, visionMs = 0.0, statsAt = nowMs()
  private var lidTimer: DispatchSourceTimer?

  func start() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: break
    case .notDetermined:
      emit(["type": "permission", "status": "notDetermined"])
      AVCaptureDevice.requestAccess(for: .video) { ok in
        emit(["type": "permission", "status": ok ? "authorized" : "denied"])
        if ok { DispatchQueue.main.async { self.start() } }
      }
      return
    case .denied: emit(["type": "error", "code": "denied", "message": "Camera access is off for ARES"]); return
    case .restricted: emit(["type": "error", "code": "denied", "message": "Camera access is restricted"]); return
    @unknown default: return
    }
    if running { return }
    if lidClosed() { emit(["type": "camera", "on": false, "why": "lid"]); return }
    let found = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified).devices
    guard let dev = found.first(where: { $0.position == .front }) ?? found.first else {
      emit(["type": "error", "code": "nocamera", "message": "No built-in camera"]); return
    }
    device = dev
    session.beginConfiguration()
    for i in session.inputs { session.removeInput(i) }
    guard let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) else {
      session.commitConfiguration()
      emit(["type": "error", "code": "config", "message": "Camera input unavailable"]); return
    }
    session.addInput(input)
    if session.outputs.isEmpty {
      output.alwaysDiscardsLateVideoFrames = true
      output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
      output.setSampleBufferDelegate(self, queue: queue)
      if session.canAddOutput(output) { session.addOutput(output) }
    }
    applyPreset()
    session.commitConfiguration()
    applyRate()
    session.startRunning()
    running = true
    emitState()
    watchLid()
  }

  func stop(_ why: String = "stop") {
    lidTimer?.cancel(); lidTimer = nil
    guard running else { emit(["type": "camera", "on": false, "why": why]); return }
    session.stopRunning()
    for i in session.inputs { session.removeInput(i) } // fully released: the camera light goes off
    running = false
    emit(["type": "camera", "on": false, "why": why])
  }

  /** Closing the lid stops the camera straight away (main also stops on lock/idle/calls). */
  func watchLid() {
    lidTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 2, repeating: 2)
    t.setEventHandler { [weak self] in
      guard let self, self.running else { return }
      if lidClosed() { self.stop("lid") } else if self.device?.isSuspended == true { self.stop("suspended") }
    }
    t.resume()
    lidTimer = t
  }

  func applyPreset() {
    let preset: AVCaptureSession.Preset = res == "high" ? .hd1280x720 : .vga640x480
    if session.canSetSessionPreset(preset) { session.sessionPreset = preset }
  }

  func setRes(_ r: String) {
    guard r != res else { return }
    res = r
    guard running else { return }
    session.beginConfiguration(); applyPreset(); session.commitConfiguration()
    applyRate()
    emitState()
  }

  func setRate(_ f: Double) {
    fps = max(1, min(30, f))
    if running { applyRate(); emitState() }
  }

  /** Ask the camera itself for the rate when it supports it (less work all the way down); frames are also skipped here. */
  func applyRate() {
    guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return }
    defer { dev.unlockForConfiguration() }
    let want = fps
    if dev.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= want && want <= $0.maxFrameRate }) {
      let d = CMTime(value: 1000, timescale: CMTimeScale(want * 1000))
      dev.activeVideoMinFrameDuration = d
      dev.activeVideoMaxFrameDuration = d
    } else {
      dev.activeVideoMinFrameDuration = .invalid
      dev.activeVideoMaxFrameDuration = .invalid
    }
  }

  func emitState() {
    emit(["type": "camera", "on": running, "res": res, "fps": fps, "w": res == "high" ? 1280 : 640, "h": res == "high" ? 720 : 480])
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    let ts = nowMs()
    if ts - lastFrame < 1000 / fps - 4 { return } // the camera ran faster than asked
    lastFrame = ts
    guard let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let t0 = nowMs()
    let handler = VNImageRequestHandler(cvPixelBuffer: px, orientation: .up, options: [:])
    try? handler.perform(tasks.map { $0.request })
    visionMs += nowMs() - t0
    frames += 1
    let key = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    let parts = tasks.map { $0.publish(ts: ts) }
    if preview.on, let h = tasks.compactMap({ $0 as? HandsTask }).first { preview.frame(px, joints: h.lastJoints) }
    emitLine(String(format: "{\"type\":\"hands\",\"ts\":%.0f,\"key\":%.2f,", ts, key) + parts.joined(separator: ",") + "}")
    // The frame is dropped here: never kept, written or sent anywhere
    if ts - statsAt > 5000 {
      emit(["type": "stats", "fps": round4(Double(frames) * 1000 / (ts - statsAt)), "ms": round4(visionMs / Double(max(1, frames)))])
      frames = 0; visionMs = 0; statsAt = ts
    }
  }
}

// ---- Bench: what Vision costs per frame, without the camera ---------------------------------------------------
func bench(_ n: Int, _ res: String, _ imagePath: String?) {
  let (w, h) = res == "high" ? (1280, 720) : (640, 480)
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
  guard let buf = pb else { print("no buffer"); return }
  let ctx = CIContext()
  if let p = imagePath, let img = CIImage(contentsOf: URL(fileURLWithPath: p)) {
    let s = max(CGFloat(w) / img.extent.width, CGFloat(h) / img.extent.height)
    ctx.render(img.transformed(by: CGAffineTransform(scaleX: s, y: s)), to: buf)
  } else {
    ctx.render(CIFilter(name: "CIRandomGenerator")!.outputImage!.cropped(to: CGRect(x: 0, y: 0, width: w, height: h)), to: buf)
  }
  let task = HandsTask()
  var ru = rusage(); getrusage(RUSAGE_SELF, &ru)
  let cpu0 = Double(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000 + Double(ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1000
  let t0 = nowMs()
  var found = 0
  for _ in 0..<n {
    try? VNImageRequestHandler(cvPixelBuffer: buf, orientation: .up, options: [:]).perform([task.request])
    found += task.hand.results?.count ?? 0
  }
  let wall = nowMs() - t0
  getrusage(RUSAGE_SELF, &ru)
  let cpu1 = Double(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000 + Double(ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1000
  emit(["type": "bench", "res": res, "frames": n, "wallMsPerFrame": round4(wall / Double(n)), "cpuMsPerFrame": round4((cpu1 - cpu0) / Double(n)), "hands": found])
}

let args = CommandLine.arguments
// --probe <file>: ask for camera access as a launched app (open -a), write the answer to the file and exit (diagnostics)
if let i = args.firstIndex(of: "--probe"), args.count > i + 1 {
  let out = args[i + 1]
  let write = { (s: String) in try? s.write(toFile: out, atomically: true, encoding: .utf8); exit(0) }
  switch AVCaptureDevice.authorizationStatus(for: .video) {
  case .authorized: write("authorized")
  case .denied: write("denied")
  case .restricted: write("restricted")
  default: AVCaptureDevice.requestAccess(for: .video) { ok in write(ok ? "granted" : "refused") }
  }
  RunLoop.main.run()
}
if let i = args.firstIndex(of: "--bench") {
  let n = Int(args.count > i + 1 ? args[i + 1] : "100") ?? 100
  bench(n, args.count > i + 2 ? args[i + 2] : "low", args.count > i + 3 ? args[i + 3] : nil)
  exit(0)
}

let camera = Camera()
let hands = HandsTask()
camera.tasks = [FaceTask(), hands]

func handle(_ line: String) {
  let parts = line.split(separator: " ").map(String.init)
  guard let cmd = parts.first else { return }
  DispatchQueue.main.async {
    switch cmd {
    case "start": camera.start()
    case "stop": camera.stop()
    case "quit": camera.stop(); exit(0)
    case "preview": if parts.count > 1 && parts[1] == "on" { preview.show() } else { preview.hide() }
    case "overlay":
      if let d = line.dropFirst(8).data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { preview.overlay(o) }
    case "rate": if parts.count > 1, let f = Double(parts[1]) { camera.setRate(f) }
    case "res": if parts.count > 1 { camera.setRes(parts[1] == "high" ? "high" : "low") }
    case "filter": if parts.count > 2, let a = Double(parts[1]), let b = Double(parts[2]) { camera.queue.async { hands.tune(minCutoff: a, beta: b) } }
    case "floor": if parts.count > 1, let f = Float(parts[1]) { camera.queue.async { hands.floor = f } }
    case "status":
      let s: String
      switch AVCaptureDevice.authorizationStatus(for: .video) { case .authorized: s = "authorized"; case .denied: s = "denied"; case .restricted: s = "restricted"; default: s = "notDetermined" }
      emit(["type": "permission", "status": s]); camera.emitState()
    default: break
    }
  }
}

/** Commands from a file descriptor (the socket), line by line, until it closes. */
func readCommands(fd: Int32) {
  DispatchQueue.global(qos: .userInitiated).async {
    var buf = [UInt8](repeating: 0, count: 4096), acc = [UInt8]()
    while true {
      let n = read(fd, &buf, buf.count)
      if n <= 0 { break }
      acc.append(contentsOf: buf[0..<Int(n)])
      while let nl = acc.firstIndex(of: 10) {
        if let line = String(bytes: acc[0..<nl], encoding: .utf8) { handle(line.trimmingCharacters(in: .whitespaces)) }
        acc.removeSubrange(0...nl)
      }
    }
    // ARES went away: let go of the camera and exit
    DispatchQueue.main.async { camera.stop(); exit(0) }
  }
}

if let i = args.firstIndex(of: "--serve"), args.count > i + 1 {
  // Launched by LaunchServices: connect back to ARES's socket
  let path = args[i + 1]
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard fd >= 0, bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { exit(1) }
  withUnsafeMutableBytes(of: &addr.sun_path) { p in for (k, b) in bytes.enumerated() { p[k] = b } }
  let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
  guard ok == 0 else { exit(1) }
  outFD = fd
  readCommands(fd: fd)
} else {
  // Plain stdin/stdout (tests, the bench)
  DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() { handle(line) }
    DispatchQueue.main.async { camera.stop(); exit(0) }
  }
}

emit(["type": "ready"])
let nsapp = NSApplication.shared
nsapp.setActivationPolicy(.accessory)
nsapp.run()
