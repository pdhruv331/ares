// ARES screen saver: the ARES scene (stars, brain, halo, pedestal) from files bundled inside the .saver, in a WKWebView.
// No network and nothing exposed: the page is local, and the only outside input is a small read-only file the running
// ARES writes (~/Library/Application Support/ARES/saver-state.json: jobs in progress, shown as orbs). If it can't be
// read (ARES not running, or the screen saver sandbox), the scene simply runs without orbs.
import AppKit
import IOKit.ps
import ScreenSaver
import WebKit

@objc(AresSaverView)
final class AresSaverView: ScreenSaverView, WKNavigationDelegate {
  private var web: WKWebView?
  private var poll: Timer?
  private var loaded = false
  private var lastState = ""

  override init?(frame: NSRect, isPreview: Bool) {
    super.init(frame: frame, isPreview: isPreview)
    animationTimeInterval = 1.0 // the page animates itself; this only paces the native side
    wantsLayer = true
    layer?.backgroundColor = NSColor(red: 0.008, green: 0.02, blue: 0.04, alpha: 1).cgColor
    // macOS sometimes leaves a screen saver instance running after it's dismissed: stop drawing when told it ended
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(willStop), name: NSNotification.Name("com.apple.screensaver.willstop"), object: nil)
  }

  required init?(coder: NSCoder) { super.init(coder: coder) }

  private func makeWeb() {
    guard web == nil, let res = Bundle(for: AresSaverView.self).resourceURL else { return }
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.suppressesIncrementalRendering = true
    let w = WKWebView(frame: bounds, configuration: config)
    w.autoresizingMask = [.width, .height]
    w.navigationDelegate = self
    w.setValue(false, forKey: "drawsBackground")
    addSubview(w)
    web = w
    w.loadFileURL(res.appendingPathComponent("scene/saver.html"), allowingReadAccessTo: res.appendingPathComponent("scene"))
  }

  override func startAnimation() {
    super.startAnimation()
    makeWeb()
    poll?.invalidate()
    poll = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.push() }
  }

  override func stopAnimation() {
    super.stopAnimation()
    tearDown()
  }

  @objc private func willStop() { tearDown() }

  private func tearDown() {
    poll?.invalidate()
    poll = nil
    web?.removeFromSuperview()
    web = nil
    loaded = false
    lastState = ""
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded = true
    push()
  }

  /** On battery: the simpler scene. And the jobs ARES says are running, as orbs. */
  private func push() {
    guard loaded, let web else { return }
    let battery = Self.onBattery()
    var jobs = "[]"
    var look = "reactor"
    let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ARES/saver-state.json")
    if let data = try? Data(contentsOf: file),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let t = obj["t"] as? Double, Date().timeIntervalSince1970 * 1000 - t < 6 * 3600 * 1000, // ignore a stale file
       let list = obj["jobs"], let out = try? JSONSerialization.data(withJSONObject: list), let s = String(data: out, encoding: .utf8) {
      jobs = s
      if let l = obj["look"] as? String, l == "brain" { look = "brain" }
    }
    let state = "\(battery)|\(look)|\(jobs)"
    if state == lastState { return }
    lastState = state
    web.evaluateJavaScript("window.ARESWall && (ARESWall.setMode({battery: \(battery)}), ARESWall.prefs({look: '\(look)'}), ARESWall.jobs(\(jobs)))", completionHandler: nil)
  }

  private static func onBattery() -> Bool {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? else { return false }
    return type == kIOPMBatteryPowerKey
  }

  override func animateOneFrame() {}
  override var hasConfigureSheet: Bool { false }
  override var configureSheet: NSWindow? { nil }
}
