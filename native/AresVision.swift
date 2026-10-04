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
// Commands (lines on stdin):
//   start | stop | rate <fps> | res low|high | filter <minCutoff> <beta> | floor <confidence> | status
//
// Bench (no camera): ares-vision --bench <frames> <low|high> [image]   Vision cost per frame on a still image.
import AVFoundation
import CoreGraphics
import CoreImage
import Foundation
import IOKit
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
  print(s)
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
      for (k, name) in HandsTask.joints.enumerated() {
        guard let p = pts[name], p.confidence >= floor else { j.append("null"); continue }
        let x = fs[k * 2].filter(1 - Double(p.location.x), ts)      // mirrored
        let y = fs[k * 2 + 1].filter(1 - Double(p.location.y), ts)  // top-left origin
        j.append(String(format: "[%.4f,%.4f,%.2f]", x, y, p.confidence))
      }
      out.append(String(format: "{\"side\":\"%@\",\"c\":%.2f,\"j\":[%@]}", side, o.confidence, j.joined(separator: ",")))
    }
    return "\"hands\":[" + out.joined(separator: ",") + "]"
  }
}

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
    print(String(format: "{\"type\":\"hands\",\"ts\":%.0f,\"key\":%.2f,", ts, key) + parts.joined(separator: ",") + "}")
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
if let i = args.firstIndex(of: "--bench") {
  let n = Int(args.count > i + 1 ? args[i + 1] : "100") ?? 100
  bench(n, args.count > i + 2 ? args[i + 2] : "low", args.count > i + 3 ? args[i + 3] : nil)
  exit(0)
}

let camera = Camera()
let hands = HandsTask()
camera.tasks = [FaceTask(), hands]

// Commands arrive on stdin; everything camera-related runs on the main queue
DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine() {
    let parts = line.split(separator: " ").map(String.init)
    guard let cmd = parts.first else { continue }
    DispatchQueue.main.async {
      switch cmd {
      case "start": camera.start()
      case "stop": camera.stop()
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
  // ARES went away: let go of the camera and exit
  DispatchQueue.main.async { camera.stop(); exit(0) }
}

emit(["type": "ready"])
RunLoop.main.run()
