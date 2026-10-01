// ares-listener: always-on, on-device "Hey ARES" wake word + voice command capture.
// Uses Apple's Speech framework with on-device recognition, so audio never leaves the Mac.
//
// Protocol (JSON lines on stdout):
//   {"type":"ready"} {"type":"error","code","message"}
//   {"type":"wake"}                      heard the wake phrase, now capturing the command
//   {"type":"partial","text"}            command transcript so far
//   {"type":"command","text","audio","trusted"}  final command after the user stops talking; audio is
//                                        base64 16kHz 16-bit mono PCM of the wake phrase + command,
//                                        for speaker verification. trusted = push-to-talk (no wake word)
//   {"type":"recording","audio","seconds"}  one enrollment sample (from "record")
//   {"type":"timeout"}                   capture window ended with nothing said
//   {"type":"level","v"}                 mic level 0..1 while capturing (for the HUD)
//   {"type":"muted"} {"type":"unmuted"}
// Commands (lines on stdin): start | mute | unmute | pause | resume | listen [ms] [trusted] | record [ms]
//                             | awake on|off   (always-listening: every utterance is a command, no wake word)
//                             | clip <id> | play <id> <base64 pcm24k> | playend <id> | stopplay   (ARES's voice)
//                             | speaking on|off   (listen for the user cutting in while she talks) | barge yes|no
// Playback events: {"type":"played","id"} {"type":"stopped","ids"} {"type":"outlevel","v"}
// Barge-in: {"type":"barge","text","audio"} while speaking; the app answers "barge yes" (she stops and
// captures the new request) or "barge no" (it was her own echo / someone else).
//
// ARES's voice is played through this engine, not the app window, so macOS voice processing (echo
// cancellation) can subtract it from the microphone. That's what lets her hear you over herself.
// Wake phrases: --wake "hey ares" --wake "ares" ...  A multi-word phrase matches anywhere; a single
// word (a bare name) only counts at the start of an utterance, so merely mentioning ARES won't wake her.

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

final class Listener {
    enum Mode { case muted, idle, capturing, paused, recording, speaking }

    private let phrasePattern: NSRegularExpression?   // multi-word wake phrases, e.g. "hey ares"
    private let barePattern: NSRegularExpression?     // single-word wake names, e.g. "ares"

    private let recognizer: SFSpeechRecognizer
    private let engine = AVAudioEngine()
    var echoCancel = true                 // --no-aec turns voice processing (and so barge-in) off
    private var voiceProcessingOn = false
    private var inputMono: AVAudioFormat?  // voice processing can report many channels; we use the first

    // Playback of ARES's voice (raw 24kHz 16-bit mono PCM streamed from ElevenLabs via the app)
    private let player = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    final class Clip {
        let id: String
        var pending: [AVAudioPCMBuffer] = []
        var ended = false
        var scheduled = 0
        var completed = 0
        var carry: UInt8? = nil
        var started = false   // playback of this clip has begun (after the jitter buffer filled)
        init(id: String) { self.id = id }
    }
    private var clips: [Clip] = []
    private var loggedDumpFormat = false
    private let debugDump: FileHandle? = {
        guard ProcessInfo.processInfo.environment["ARES_DEBUG_AUDIO"] == "1" else { return nil }
        let path = NSTemporaryDirectory() + "ares-out.f32"
        FileManager.default.createFile(atPath: path, contents: nil)
        return FileHandle(forWritingAtPath: path)
    }()
    private var playGen = 0
    private var lastOutLevel = Date.distantPast

    // Barge-in
    private var bargePending = false
    private var bargeCooldownUntil = Date.distantPast
    private var bargeVoiceStart: Date? = nil
    private var bargeText = ""
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = 0

    private var mode: Mode = .muted
    private var wakeRequired = true
    private var commandStart = 0          // character offset in the transcript where the command begins
    private var command = ""
    private var silenceTimer: Timer?
    private var deadlineTimer: Timer?
    private var recycleTimer: Timer?
    private var lastLevel = Date.distantPast

    // End-of-speech detection: the command is finished only when the transcript has stopped changing
    // for `endSilence` AND the mic itself has been quiet for a while (so mid-sentence pauses and a
    // lagging recogniser don't cut you off).
    var endSilence: TimeInterval = 1.3
    private let audioQuietNeeded: TimeInterval = 0.8
    private var noiseFloor: Float = 0.002
    private var lastVoiceAt = Date.distantPast
    private var captureStartedAt = Date()
    private var lastTranscriptChangeAt = Date()
    var debug = false                  // --debug: report mic level + what was heard (diagnostics only)
    private var debugPeak: Float = 0
    private var debugHeard = ""
    private var debugTimer: Timer?
    private var buffersSeen = 0          // audio-thread counter (diagnostics only)
    private var tasksStarted = 0
    private var lastError = ""
    private var taskStartedAt = Date()
    private var backoff: TimeInterval = 0 // grows when recognition sessions fail straight away
    func startHeartbeat() {
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.lock.lock(); let n = self.buffersSeen; self.lock.unlock()
            emit(["type": "debug", "heartbeat": true, "mode": "\(self.mode)", "buffers": n, "engineRunning": self.engine.isRunning,
                  "inputSR": self.engine.inputNode.outputFormat(forBus: 0).sampleRate, "heard": self.debugHeard,
                  "tasks": self.tasksStarted, "lastError": self.lastError, "backoff": self.backoff])
        }
    }
    private var quietTimer: Timer?

    // Rolling 16kHz mono copy of the mic, so each command's audio can be checked against the owner's voice
    private static let rate = 16000.0
    private let ringSize = 16000 * 20
    private lazy var ring = [Float](repeating: 0, count: ringSize)
    private var ringTotal = 0            // samples ever written (absolute position)
    private var converter: AVAudioConverter?
    private let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private var taskStartSample = 0
    private var captureStartSample = 0
    private var trustedCapture = false
    private var addressed = true         // false when captured in always-listening mode without the wake word
    private var awake = false

    // Enrollment recording
    private var recStart = Date()
    private var recMax: TimeInterval = 7
    private var recFirstLoud: Int? = nil
    private var recLastLoud = 0
    private var recLastLoudAt = Date()
    private var recFloor: Float = 0          // loudest level heard during the start-up grace (chime, room noise)

    init?(wakePhrases: [String]) {
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: "en-GB")) ?? SFSpeechRecognizer() else { return nil }
        recognizer = r

        // "Ares" is often transcribed as Aries/Arras/etc., so the name matches its common near-misses.
        let name = "(?:ares|aries|arras|arris|aris|arez|eris)"
        func wordPattern(_ w: String) -> String { w == "ares" ? name : NSRegularExpression.escapedPattern(for: w) }
        var phrases: [String] = []
        var bare: [String] = []
        for phrase in wakePhrases {
            let words = phrase.lowercased().split(whereSeparator: { !$0.isLetter && $0 != "'" }).map(String.init)
            if words.count == 1 { bare.append(wordPattern(words[0])) }
            else if words.count > 1 { phrases.append(words.map(wordPattern).joined(separator: #"[\s,]+"#)) }
        }
        phrasePattern = phrases.isEmpty ? nil
            : try? NSRegularExpression(pattern: #"\b(?:"# + phrases.joined(separator: "|") + #")\b[\s,.!?]*"#, options: [.caseInsensitive])
        barePattern = bare.isEmpty ? nil
            : try? NSRegularExpression(pattern: "^(?:" + bare.joined(separator: "|") + ")$", options: [.caseInsensitive])

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.audioRouteChanged()
        }
    }

    // MARK: Commands

    func handle(_ line: String) {
        let parts = line.split(separator: " ")
        switch parts.first.map(String.init) ?? "" {
        case "start": authorize()
        case "mute": mute()
        case "unmute": unmute()
        case "pause":
            if mode == .muted { return }
            mode = .paused
            stopTask()
        case "resume":
            if mode == .paused || mode == .speaking { mode = .idle; startTask() }
        case "speaking":
            if parts.count > 1, parts[1] == "on" {
                guard echoCancel, mode == .idle || mode == .paused else { return }
                mode = .speaking
                bargePending = false
                bargeVoiceStart = nil
                startTask()
            } else if mode == .speaking {
                mode = .idle
                startTask()
            }
        case "barge":
            guard mode == .speaking, bargePending else { return }
            if parts.count > 1, parts[1] == "yes" { acceptBarge() }
            else {
                bargePending = false
                bargeVoiceStart = nil
                bargeCooldownUntil = Date().addingTimeInterval(0.8)
                startTask() // drop the echo from the transcript
            }
        case "clip":
            if parts.count > 1 { clips.append(Clip(id: String(parts[1]))) }
        case "play":
            if parts.count > 2 { clipData(String(parts[1]), parts[2]) }
        case "playend":
            if parts.count > 1 { clips.first { $0.id == String(parts[1]) }?.ended = true; pumpPlayback(); checkHead() }
        case "stopplay":
            stopPlayback()
        case "listen":
            let ms = parts.count > 1 ? Double(parts[1]) ?? 6000 : 6000
            listen(timeout: ms / 1000, trusted: parts.contains("trusted"))
        case "awake":
            awake = parts.count > 1 && parts[1] == "on"
            if mode == .idle { startTask() }
            emit(["type": "awake", "on": awake])
        case "record":
            let ms = parts.count > 1 ? Double(parts[1]) ?? 7000 : 7000
            record(max: ms / 1000)
        default: break
        }
    }

    private func authorize() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    emit(["type": "error", "code": "speech-denied", "message": "Speech recognition permission was not granted"])
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard granted else {
                            emit(["type": "error", "code": "mic-denied", "message": "Microphone permission was not granted"])
                            return
                        }
                        emit(["type": "ready", "onDevice": self.recognizer.supportsOnDeviceRecognition])
                        self.unmute()
                    }
                }
            }
        }
    }

    private func mute() {
        if !clips.isEmpty { stopPlayback() }
        mode = .muted
        stopTask()
        stopEngine()
        emit(["type": "muted"])
    }

    private func unmute() {
        guard startEngine() else { return }
        mode = .idle
        startTask()
        emit(["type": "unmuted"])
    }

    /// Capture a command without the wake phrase (push-to-talk, or a follow-up after ARES replies).
    private func listen(timeout: TimeInterval, trusted: Bool) {
        if mode == .muted { guard startEngine() else { return } }
        startTask()
        mode = .capturing
        wakeRequired = false
        trustedCapture = trusted
        addressed = true
        commandStart = 0
        command = ""
        captureStartSample = currentSample()
        captureStartedAt = Date()
        armDeadline(timeout)
    }

    /// Record one enrollment sample: waits for speech, stops after a second of silence (or at max).
    private func record(max: TimeInterval) {
        if mode == .muted { guard startEngine() else { return } }
        stopTask()
        mode = .recording
        recStart = Date()
        recMax = max
        recFirstLoud = nil
        recFloor = 0
    }

    private func recordingTick(_ rms: Float) {
        guard mode == .recording else { return }
        let now = Date()
        // The first moment is the prompt chime and the room: learn the noise level, don't treat it as speech
        if now.timeIntervalSince(recStart) < 0.4 { return }
        if rms > 0.015 {
            if recFirstLoud == nil { recFirstLoud = currentSample() }
            recLastLoud = currentSample()
            recLastLoudAt = now
        }
        let elapsed = now.timeIntervalSince(recStart)
        let silentAfterSpeech = recFirstLoud != nil && now.timeIntervalSince(recLastLoudAt) > 1.0
        guard silentAfterSpeech || elapsed > recMax || (recFirstLoud == nil && elapsed > 6) else { return }

        var audio = ""
        var seconds = 0.0
        if let first = recFirstLoud {
            let pad = Int(Listener.rate * 0.3)
            let samples = read(from: first - pad, to: min(currentSample(), recLastLoud + pad))
            seconds = Double(samples.count) / Listener.rate
            audio = encode(samples)
        }
        mode = .idle
        startTask()
        emit(["type": "recording", "audio": audio, "seconds": seconds])
    }

    // MARK: Audio

    private func startEngine() -> Bool {
        if engine.isRunning { return true }
        let input = engine.inputNode
        if echoCancel && !voiceProcessingOn {
            do {
                try input.setVoiceProcessingEnabled(true)
                voiceProcessingOn = true
                if #available(macOS 14.0, *) {
                    // Don't turn other apps (music, calls) down while ARES is listening
                    input.voiceProcessingOtherAudioDuckingConfiguration =
                        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
                }
            } catch {
                echoCancel = false
                emit(["type": "error", "code": "aec", "message": "Echo cancellation unavailable: \(error.localizedDescription)"])
            }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            emit(["type": "error", "code": "no-mic", "message": "No microphone input available"])
            return false
        }
        inputMono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)
        converter = inputMono.flatMap { AVAudioConverter(from: $0, to: monoFormat) }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.consume(buffer)
        }
        engine.mainMixerNode.removeTap(onBus: 0)
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            self?.outputLevel(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch {
            emit(["type": "error", "code": "engine", "message": error.localizedDescription])
            return false
        }
        return true
    }

    private func stopEngine() {
        engine.inputNode.removeTap(onBus: 0)
        engine.mainMixerNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func audioRouteChanged() {
        // Headphones plugged in, AirPods connected, etc: rebuild the tap on the new device.
        guard mode != .muted else { return }
        stopEngine()
        if startEngine(), mode == .idle || mode == .capturing { startTask(keepMode: true) }
    }

    // Runs on the audio thread.
    private func consume(_ input: AVAudioPCMBuffer) {
        guard let buffer = mono(input) else { return }
        lock.lock(); let req = request; buffersSeen += 1; lock.unlock()
        req?.append(buffer)
        store(buffer)

        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
        let rms = sqrt(sum / Float(buffer.frameLength))
        DispatchQueue.main.async { self.reportLevel(rms) }
    }

    /// Voice processing can hand us a many-channel buffer; the processed voice is on the first channel.
    private func mono(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format.channelCount == 1 { return buffer }
        guard let fmt = inputMono, let src = buffer.floatChannelData?[0],
              let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: buffer.frameLength),
              let dst = out.floatChannelData?[0] else { return nil }
        out.frameLength = buffer.frameLength
        dst.update(from: src, count: Int(buffer.frameLength))
        return out
    }

    // MARK: Playback (ARES's voice)

    private func clipData(_ id: String, _ b64: Substring) {
        guard let clip = clips.first(where: { $0.id == id }), var data = Data(base64Encoded: String(b64)) else { return }
        if let c = clip.carry { data.insert(c, at: 0); clip.carry = nil }
        if data.count % 2 == 1 { clip.carry = data.removeLast() }
        let n = data.count / 2
        guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)),
              let dst = buf.floatChannelData?[0] else { return }
        buf.frameLength = AVAudioFrameCount(n)
        data.withUnsafeBytes { raw in
            let s = raw.bindMemory(to: Int16.self)
            for i in 0..<n { dst[i] = Float(Int16(littleEndian: s[i])) / 32768 }
        }
        clip.pending.append(buf)
        pumpPlayback()
    }

    /// Schedule whatever has arrived for the clip at the front of the queue (clips play strictly in order).
    private func pumpPlayback() {
        guard engine.isRunning, let head = clips.first else { return }
        if !head.started {
            // Jitter buffer: start a sentence only once ~0.2s has arrived (or all of it), so a late network
            // chunk can't leave the speaker running dry mid-word, which is what makes a pop
            let buffered = head.pending.reduce(0) { $0 + Int($1.frameLength) }
            guard buffered >= Int(playFormat.sampleRate * 0.2) || head.ended, buffered > 0 || head.ended else { return }
            head.started = true
            if let first = head.pending.first, let d = first.floatChannelData?[0] {
                let n = min(Int(first.frameLength), 120) // 5ms fade-in: no click from a non-zero first sample
                for i in 0..<n { d[i] *= Float(i) / Float(n) }
            }
        }
        let gen = playGen
        while !head.pending.isEmpty {
            let buf = head.pending.removeFirst()
            head.scheduled += 1
            player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, gen == self.playGen else { return }
                    head.completed += 1
                    self.checkHead()
                }
            }
        }
        if !player.isPlaying { player.play() }
    }

    private func checkHead() {
        guard let head = clips.first, head.ended, head.completed == head.scheduled, head.pending.isEmpty else { return }
        clips.removeFirst()
        emit(["type": "played", "id": head.id])
        pumpPlayback()
        checkHead() // the next clip may already be complete (or empty)
    }

    private func stopPlayback() {
        playGen += 1
        let ids = clips.map(\.id)
        clips.removeAll()
        player.stop()
        emit(["type": "stopped", "ids": ids])
    }

    // Audio thread: how loud ARES is right now, for the HUD
    private func outputLevel(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        if let dump = debugDump { // ARES_DEBUG_AUDIO=1: raw float32 of what goes to the speakers, for diagnosis
            dump.write(Data(bytes: samples, count: Int(buffer.frameLength) * 4))
            if !loggedDumpFormat { loggedDumpFormat = true; emit(["type": "debug", "dumpRate": buffer.format.sampleRate]) }
        }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
        let rms = sqrt(sum / Float(buffer.frameLength))
        DispatchQueue.main.async {
            guard !self.clips.isEmpty, Date().timeIntervalSince(self.lastOutLevel) > 0.03 else { return }
            self.lastOutLevel = Date()
            emit(["type": "outlevel", "v": min(1, Double(rms) * 5)])
        }
    }

    // MARK: Barge-in

    /// The app confirmed it's really the user talking: stop her voice and treat what they're saying as the new request.
    private func acceptBarge() {
        stopPlayback()
        bargePending = false
        mode = .capturing
        wakeRequired = false
        trustedCapture = false
        addressed = true
        commandStart = 0
        command = ""
        captureStartSample = taskStartSample
        captureStartedAt = Date()
        lastTranscriptChangeAt = Date()
        emit(["type": "listening"])
        updateCommand(from: bargeText)
        armDeadline(6)
    }

    /// Resample to 16kHz mono and append to the ring buffer (audio thread).
    private func store(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Listener.rate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let data = out.floatChannelData?[0] else { return }
        let n = Int(out.frameLength)
        lock.lock()
        for i in 0..<n { ring[(ringTotal + i) % ringSize] = data[i] }
        ringTotal += n
        lock.unlock()
    }

    private func currentSample() -> Int {
        lock.lock(); defer { lock.unlock() }
        return ringTotal
    }

    /// Samples between two absolute positions (clamped to what the ring still holds).
    private func read(from: Int, to: Int) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let start = max(from, ringTotal - ringSize, 0)
        let end = min(to, ringTotal)
        guard end > start else { return [] }
        return (start..<end).map { ring[$0 % ringSize] }
    }

    private func encode(_ samples: [Float]) -> String {
        var pcm = [Int16](repeating: 0, count: samples.count)
        for i in 0..<samples.count { pcm[i] = Int16(max(-1, min(1, samples[i])) * 32767) }
        return pcm.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
    }

    private func trackVoice(_ rms: Float) {
        // Floor drops fast to quiet moments and creeps up slowly, so it follows the room's background noise
        noiseFloor = rms < noiseFloor ? rms : noiseFloor + (rms - noiseFloor) * 0.002
        if rms > max(0.006, noiseFloor * 3) {
            lastVoiceAt = Date()
            if mode == .speaking, bargeVoiceStart == nil { bargeVoiceStart = Date() }
        }
    }

    private func reportLevel(_ rms: Float) {
        trackVoice(rms)
        if debug {
            debugPeak = max(debugPeak, rms)
            if debugTimer == nil {
                debugTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                    guard let self else { return }
                    emit(["type": "debug", "mode": "\(self.mode)", "peak": Double(self.debugPeak), "heard": self.debugHeard])
                    self.debugPeak = 0
                }
            }
        }
        recordingTick(rms)
        guard mode == .capturing || mode == .recording, Date().timeIntervalSince(lastLevel) > 0.05 else { return }
        lastLevel = Date()
        emit(["type": "level", "v": min(1, Double(rms) * 12)])
    }

    // MARK: Recognition

    private func startTask(keepMode: Bool = false) {
        stopTask()
        generation += 1
        let gen = generation
        if !keepMode { wakeRequired = true; commandStart = 0; command = "" }

        taskStartSample = currentSample()
        taskStartedAt = Date()
        tasksStarted += 1
        debugHeard = ""
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        req.contextualStrings = ["Ares", "Hey Ares"]
        req.addsPunctuation = false
        lock.lock(); request = req; lock.unlock()

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                if let result {
                    self.backoff = 0
                    self.onTranscript(result.bestTranscription)
                    if result.isFinal { self.onTaskEnded() }
                } else if let error {
                    let ns = error as NSError
                    self.lastError = "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
                    self.onTaskEnded(failedFast: Date().timeIntervalSince(self.taskStartedAt) < 1.0)
                }
            }
        }

        // Recognition sessions shouldn't run forever; recycle while idle to keep them fresh.
        recycleTimer?.invalidate()
        recycleTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in
            guard let self, self.mode == .idle else { return }
            self.startTask()
        }
    }

    private func stopTask() {
        generation += 1
        silenceTimer?.invalidate()
        deadlineTimer?.invalidate()
        recycleTimer?.invalidate()
        quietTimer?.invalidate()
        task?.cancel()
        task = nil
        lock.lock(); request?.endAudio(); request = nil; lock.unlock()
    }

    private func onTaskEnded(failedFast: Bool = false) {
        if mode == .capturing, !command.isEmpty { return finishCommand() }
        guard mode == .idle || mode == .capturing || mode == .speaking else { return }
        // A session that fails straight away usually means the speech service needs a moment;
        // restarting instantly just spins, so back off (0.5s, 1s, 2s … up to 5s).
        backoff = failedFast ? min(5, max(0.5, backoff * 2)) : 0
        let keep = mode == .capturing
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
            guard let self, gen == self.generation, self.mode == .idle || self.mode == .capturing || self.mode == .speaking else { return }
            self.startTask(keepMode: keep)
        }
    }

    /// Where the command starts (character offset), and when the wake phrase was said (seconds into
    /// this recognition task), if the transcript contains a wake phrase.
    private func findWake(_ t: SFTranscription) -> (offset: Int, time: TimeInterval)? {
        let text = t.formattedString
        if let m = phrasePattern?.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) {
            let seg = t.segments.first { NSLocationInRange(m.range.location, $0.substringRange) }
            return (m.range.location + m.range.length, seg?.timestamp ?? 0)
        }
        guard let bare = barePattern else { return nil }
        let segs = t.segments
        for (i, seg) in segs.enumerated() {
            let word = seg.substring.trimmingCharacters(in: .punctuationCharacters)
            guard bare.firstMatch(in: word, range: NSRange(location: 0, length: (word as NSString).length)) != nil else { continue }
            // A bare name only counts when it opens an utterance: first word, or after a pause.
            let gap = i == 0 ? .infinity : seg.timestamp - (segs[i - 1].timestamp + segs[i - 1].duration)
            if i == 0 || gap >= 0.6 { return (seg.substringRange.location + seg.substringRange.length, seg.timestamp) }
        }
        return nil
    }

    private func onTranscript(_ t: SFTranscription) {
        let text = t.formattedString
        if debug { debugHeard = text }
        switch mode {
        case .idle:
            if findWake(t) == nil, awake, let first = t.segments.first,
               !text.trimmingCharacters(in: .whitespaces).isEmpty {
                // Always-listening: whatever was said is the command.
                quietTimer?.invalidate()
                mode = .capturing
                wakeRequired = false
                trustedCapture = false
                addressed = false
                commandStart = 0
                captureStartSample = taskStartSample + Int((first.timestamp - 0.3) * Listener.rate)
                captureStartedAt = Date()
                command = ""
                emit(["type": "listening"])
                updateCommand(from: text)
                return
            }
            guard let wake = findWake(t) else {
                // Background speech with no wake word: once it goes quiet, start a fresh transcript
                // so the next thing said begins a new utterance (that's what makes a bare "ARES" work).
                quietTimer?.invalidate()
                quietTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
                    guard let self, self.mode == .idle else { return }
                    self.startTask()
                }
                return
            }
            quietTimer?.invalidate()
            mode = .capturing
            wakeRequired = true
            trustedCapture = false
            addressed = true
            commandStart = wake.offset
            captureStartSample = taskStartSample + Int((wake.time - 0.3) * Listener.rate)
            captureStartedAt = Date()
            command = ""
            emit(["type": "wake"])
            armDeadline(6)
            updateCommand(from: text)
        case .speaking:
            // Someone is talking over her. Propose a barge-in; the app checks it isn't her own echo
            // (and, with Voice ID, that it's the owner) before she actually stops.
            guard !bargePending, Date() >= bargeCooldownUntil else { return }
            let words = text.split(separator: " ")
            let voiced = bargeVoiceStart.map { Date().timeIntervalSince($0) } ?? 0
            guard words.count >= 2 || (words.count == 1 && voiced >= 0.35) else { return }
            bargePending = true
            bargeText = text
            let end = currentSample()
            emit(["type": "barge", "text": text, "audio": encode(read(from: max(taskStartSample, end - Int(Listener.rate * 4)), to: end))])
        case .capturing:
            if wakeRequired, let wake = findWake(t) {
                commandStart = wake.offset // the recogniser may revise earlier words
            }
            updateCommand(from: text)
        default:
            break
        }
    }

    private func updateCommand(from text: String) {
        let ns = text as NSString
        let start = min(commandStart, ns.length)
        let next = ns.substring(from: start).trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != command else { return }
        command = next
        guard !command.isEmpty else { return }
        deadlineTimer?.invalidate()
        emit(["type": "partial", "text": command])
        lastTranscriptChangeAt = Date()
        armSilence(endSilence)
    }

    private func armSilence(_ after: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: after, repeats: false) { [weak self] _ in
            guard let self, self.mode == .capturing else { return }
            let stillTalking = Date().timeIntervalSince(self.lastVoiceAt) < self.audioQuietNeeded
            // Background noise alone can't hold her forever: 1.5s after the words stop, answer anyway.
            let tooLong = Date().timeIntervalSince(self.lastTranscriptChangeAt) > self.endSilence + 1.5
                || Date().timeIntervalSince(self.captureStartedAt) > 30
            if stillTalking && !tooLong { return self.armSilence(0.25) } // sound is still coming in: keep waiting
            self.finishCommand()
        }
    }

    private func armDeadline(_ seconds: TimeInterval) {
        deadlineTimer?.invalidate()
        deadlineTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self, self.mode == .capturing, self.command.isEmpty else { return }
            emit(["type": "timeout"])
            self.mode = .idle
            self.startTask()
        }
    }

    private func finishCommand() {
        guard mode == .capturing else { return }
        let text = command
        let end = currentSample()
        let audio = encode(read(from: max(captureStartSample, end - Int(Listener.rate * 10)), to: end))
        mode = .idle
        startTask() // fresh transcript so the command can't retrigger the wake word
        if text.isEmpty { emit(["type": "timeout"]) }
        else { emit(["type": "command", "text": text, "audio": audio, "trusted": trustedCapture, "addressed": addressed]) }
    }
}

var wakePhrases: [String] = []
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
    if arg == "--wake", let phrase = args.next() { wakePhrases.append(phrase) }
}
if wakePhrases.isEmpty { wakePhrases = ["hey ares", "ok ares", "ares"] }

guard let listener = Listener(wakePhrases: wakePhrases) else {
    emit(["type": "error", "code": "unsupported", "message": "Speech recognition isn't available for this language"])
    exit(1)
}

FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { exit(0) } // parent app quit
    for line in String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline) {
        let cmd = line.trimmingCharacters(in: .whitespaces)
        DispatchQueue.main.async { listener.handle(cmd) }
    }
}

listener.debug = CommandLine.arguments.contains("--debug")
listener.echoCancel = !CommandLine.arguments.contains("--no-aec")
if let i = CommandLine.arguments.firstIndex(of: "--end-silence"), i + 1 < CommandLine.arguments.count,
   let ms = Double(CommandLine.arguments[i + 1]) {
    listener.endSilence = max(0.5, ms / 1000)
}
if listener.debug { listener.startHeartbeat() }
if CommandLine.arguments.contains("--start") {
    listener.handle("start")
}

RunLoop.main.run()
