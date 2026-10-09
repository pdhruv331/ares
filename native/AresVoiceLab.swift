// ARES Voice Lab (ares-voicelab): the voice v2 stage-A measurement helper (docs/voice-prompt.md A2–A6). A real .app bundle
// so macOS asks for the microphone and speech recognition in its own name (a command-line tool counts as part of whatever
// app launched it). Run it through `open` (scripts/voice-lab/lab.mjs does), with stdin/stdout as files or pipes.
// Everything is on-device: recordings stay in local files, recognition never uses Apple's servers.
//
//   record [--no-vpio]       records through the same input path ARES hears with (AVAudioEngine input, macOS voice
//                            processing on by default), 16 kHz mono 16-bit WAV. Commands on stdin, one per line:
//       rec <file.wav> · stop · play <file> (through THIS engine: engine-owned playback, for the echo test) · playstop · quit
//       Events: {"type":"ready","vpio","rate"} {"type":"level","rms","peak"} (10 Hz while recording) {"type":"saved","file","seconds"}
//   sf [--locale en-GB] [--context "Ares,Hey Ares"] [--lm <dir>] file…    SFSpeechRecognizer, as ARES today
//   st [--locale en-GB] file…                                             SpeechTranscriber (macOS 26)
//   lm-build <dir> [--locale en-GB] [--xsampa "E@ r i: z"]                 a custom language model with "Hey ARES …" templates
//                                                                          and ARES as the owner says it (A4's interim fix)
//   locales                                                               the English locales each engine has on device
//   Transcripts: one JSON line per file {file, engine, locale, text, ms, segments: [{t, d, s, c}]}

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}
func fail(_ msg: String) -> Never { emit(["type": "error", "message": msg]); exit(1) }

final class Lab {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let vpio: Bool
    let out16 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    var converter: AVAudioConverter?
    var inputMono: AVAudioFormat?
    var file: FileHandle?
    var path = ""
    var samples = 0
    let lock = NSLock()
    var sumSq: Float = 0, peak: Float = 0, n = 0

    init(vpio: Bool) { self.vpio = vpio }

    func start() -> Bool {
        let input = engine.inputNode
        if vpio {
            do {
                try input.setVoiceProcessingEnabled(true)
                if #available(macOS 14.0, *) {
                    input.voiceProcessingOtherAudioDuckingConfiguration =
                        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
                }
            } catch { emit(["type": "error", "message": "voice processing: \(error.localizedDescription)"]); return false }
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: nil)
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0 else { emit(["type": "error", "message": "no microphone"]); return false }
        inputMono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: fmt.sampleRate, channels: 1, interleaved: false)
        converter = inputMono.flatMap { AVAudioConverter(from: $0, to: out16) }
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in self?.consume(buf) }
        engine.prepare()
        do { try engine.start() } catch { emit(["type": "error", "message": error.localizedDescription]); return false }
        emit(["type": "ready", "vpio": vpio, "rate": fmt.sampleRate, "channels": fmt.channelCount])
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.report() }
        return true
    }

    func consume(_ buffer: AVAudioPCMBuffer) {
        // Voice processing can hand over several channels; the processed voice is the first (as in AresListener)
        guard let fmt = inputMono, let src = buffer.floatChannelData?[0],
              let mono = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: buffer.frameLength), let dst = mono.floatChannelData?[0],
              let converter else { return }
        mono.frameLength = buffer.frameLength
        dst.update(from: src, count: Int(buffer.frameLength))
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / fmt.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: out16, frameCapacity: cap) else { return }
        var supplied = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return mono
        }
        guard err == nil, let d = out.floatChannelData?[0] else { return }
        let count = Int(out.frameLength)
        var pcm = [Int16](repeating: 0, count: count)
        lock.lock()
        for i in 0..<count {
            let v = d[i]
            sumSq += v * v; peak = max(peak, abs(v)); n += 1
            pcm[i] = Int16(max(-1, min(1, v)) * 32767)
        }
        if let file { file.write(pcm.withUnsafeBufferPointer { Data(buffer: $0) }); samples += count }
        lock.unlock()
    }

    func report() {
        lock.lock()
        let rms = n > 0 ? sqrt(sumSq / Float(n)) : 0, p = peak
        sumSq = 0; peak = 0; n = 0
        let recording = file != nil
        lock.unlock()
        if recording { emit(["type": "level", "rms": Double(rms), "peak": Double(p)]) }
    }

    func rec(_ to: String) {
        stop()
        FileManager.default.createFile(atPath: to, contents: wavHeader(dataBytes: 0))
        guard let h = FileHandle(forWritingAtPath: to) else { return emit(["type": "error", "message": "can't write \(to)"]) }
        h.seekToEndOfFile()
        lock.lock(); file = h; path = to; samples = 0; lock.unlock()
        emit(["type": "recording", "file": to])
    }

    func stop() {
        lock.lock()
        guard let h = file else { lock.unlock(); return }
        file = nil
        let count = samples
        lock.unlock()
        h.seek(toFileOffset: 0)
        h.write(wavHeader(dataBytes: count * 2))
        h.closeFile()
        emit(["type": "saved", "file": path, "seconds": Double(count) / 16000])
    }

    func play(_ p: String) {
        do {
            let f = try AVAudioFile(forReading: URL(fileURLWithPath: p))
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: f.processingFormat)
            player.scheduleFile(f, at: nil, completionCallbackType: .dataPlayedBack) { _ in
                DispatchQueue.main.async { emit(["type": "played"]) }
            }
            player.play()
        } catch { emit(["type": "error", "message": "play: \(error.localizedDescription)"]) }
    }

    func wavHeader(dataBytes: Int) -> Data {
        var d = Data()
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(36 + dataBytes); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(dataBytes)
        return d
    }
}


func runRecorder() {
        let lab = Lab(vpio: !CommandLine.arguments.contains("--no-vpio"))
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async {
            guard granted else { emit(["type": "error", "message": "microphone permission not granted"]); exit(1) }
            if !lab.start() { exit(1) }
        }
    }
    FileHandle.standardInput.readabilityHandler = { h in
        let data = h.availableData
        if data.isEmpty { DispatchQueue.main.async { lab.stop(); exit(0) } }
        for line in String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline) {
            let s = line.trimmingCharacters(in: .whitespaces)
            let cmd = s.split(separator: " ", maxSplits: 1).map(String.init)
            DispatchQueue.main.async {
                switch cmd.first ?? "" {
                case "rec": if cmd.count > 1 { lab.rec(cmd[1]) }
                case "stop": lab.stop()
                case "play": if cmd.count > 1 { lab.play(cmd[1]) }
                case "playstop": lab.player.stop()
                case "quit": lab.stop(); exit(0)
                default: break
                }
            }
        }
    }
}

var argv = Array(CommandLine.arguments.dropFirst())
let mode = argv.isEmpty ? "" : argv.removeFirst()
func option(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    let v = argv[i + 1]; argv.removeSubrange(i...(i + 1)); return v
}
let localeId = option("--locale") ?? "en-GB"
let context = option("--context")?.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } ?? ["Ares", "Hey Ares"]
let lmDir = option("--lm")
let xsampa = option("--xsampa") ?? "E@ r i: z"
let files = argv

func authorize() async {
    let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
    if status != .authorized { fail("speech recognition permission not granted") }
}

// ---- SFSpeechRecognizer ----------------------------------------------------------------------------------------------
func lmConfig(_ dir: String) -> SFSpeechLanguageModel.Configuration {
    let base = URL(fileURLWithPath: dir)
    return SFSpeechLanguageModel.Configuration(languageModel: base.appendingPathComponent("lm"), vocabulary: base.appendingPathComponent("vocab"))
}

func transcribeSF(_ path: String) async -> [String: Any] {
    guard let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else { return ["file": path, "error": "no recognizer for \(localeId)"] }
    if !rec.supportsOnDeviceRecognition { return ["file": path, "error": "\(localeId) has no on-device recognition"] }
    let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    req.requiresOnDeviceRecognition = true
    req.shouldReportPartialResults = false
    req.addsPunctuation = false
    req.contextualStrings = context
    if let lmDir { req.customizedLanguageModel = lmConfig(lmDir) }
    let t0 = Date()
    return await withCheckedContinuation { c in
        var done = false
        rec.recognitionTask(with: req) { result, error in
            guard !done else { return }
            if let result, result.isFinal {
                done = true
                let t = result.bestTranscription
                c.resume(returning: ["file": path, "engine": lmDir == nil ? "sf" : "sf+lm", "locale": localeId, "text": t.formattedString,
                                     "ms": Int(Date().timeIntervalSince(t0) * 1000),
                                     "segments": t.segments.map { ["t": $0.timestamp, "d": $0.duration, "s": $0.substring, "c": Double($0.confidence)] }])
            } else if let error {
                done = true
                let ns = error as NSError
                // 1110 = no speech detected: an empty transcript, not a failure
                c.resume(returning: ns.code == 1110 ? ["file": path, "engine": "sf", "locale": localeId, "text": "", "ms": Int(Date().timeIntervalSince(t0) * 1000), "segments": []]
                                                    : ["file": path, "error": "\(ns.domain) \(ns.code): \(ns.localizedDescription)"])
            }
        }
    }
}

// The interim fix (A4): "Hey ARES …" templates weighted up, and ARES as the owner says it (X-SAMPA)
func buildLM(_ dir: String) async {
    let base = URL(fileURLWithPath: dir)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    let data = SFCustomLanguageModelData(locale: Locale(identifier: localeId), identifier: "com.dhruv.ares.voicelab", version: "1.0") {
        SFCustomLanguageModelData.PhraseCount(phrase: "Hey Ares", count: 400)
        SFCustomLanguageModelData.PhraseCount(phrase: "Ares", count: 200)
        SFCustomLanguageModelData.PhraseCountsFromTemplates(classes: [
            "cmd": ["what time is it", "set a timer", "stop", "what's the weather", "open", "call", "text", "remind me", "go quiet", "stay awake", "pause the music", "power down"],
        ]) {
            SFCustomLanguageModelData.TemplatePhraseCountGenerator.Template("Hey Ares <cmd>", count: 300)
            SFCustomLanguageModelData.TemplatePhraseCountGenerator.Template("Ares <cmd>", count: 100)
        }
        SFCustomLanguageModelData.CustomPronunciation(grapheme: "Ares", phonemes: [xsampa])
    }
    let bin = base.appendingPathComponent("training.bin")
    do {
        try await data.export(to: bin)
        try await SFSpeechLanguageModel.prepareCustomLanguageModel(for: bin, clientIdentifier: "com.dhruv.ares.voicelab", configuration: lmConfig(dir))
        emit(["type": "lm", "dir": dir, "locale": localeId, "xsampa": xsampa])
    } catch { fail("custom language model: \(error.localizedDescription)") }
}

// ---- SpeechTranscriber (macOS 26) ------------------------------------------------------------------------------------
@available(macOS 26.0, *)
func transcribeST(_ path: String) async -> [String: Any] {
    do {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
            return ["file": path, "error": "SpeechTranscriber has no \(localeId)"]
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange, .transcriptionConfidence])
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await req.downloadAndInstall() }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let t0 = Date()
        let collect = Task { () -> (String, [[String: Any]]) in
            var text = ""
            var segs: [[String: Any]] = []
            for try await r in transcriber.results {
                text += String(r.text.characters)
                for run in r.text.runs {
                    guard let range = run.audioTimeRange else { continue }
                    segs.append(["t": range.start.seconds, "d": range.duration.seconds, "s": String(r.text[run.range].characters),
                                 "c": run.transcriptionConfidence ?? -1])
                }
            }
            return (text, segs)
        }
        if let last = try await analyzer.analyzeSequence(from: file) { try await analyzer.finalizeAndFinish(through: last) }
        else { await analyzer.cancelAndFinishNow() }
        let (text, segs) = try await collect.value
        return ["file": path, "engine": "st", "locale": locale.identifier, "text": text.trimmingCharacters(in: .whitespaces),
                "ms": Int(Date().timeIntervalSince(t0) * 1000), "segments": segs]
    } catch { return ["file": path, "error": "SpeechTranscriber: \(error.localizedDescription)"] }
}


// ---- Main ------------------------------------------------------------------------------------------------------------
if mode == "record" { runRecorder() } else { Task {
    switch mode {
    case "sf":
        await authorize()
        for f in files { emit(await transcribeSF(f)) }
    case "lm-build":
        await authorize()
        guard let dir = files.first else { fail("lm-build <dir>") }
        await buildLM(dir)
    case "st":
        guard #available(macOS 26.0, *) else { fail("SpeechTranscriber needs macOS 26") }
        await authorize()
        for f in files { emit(await transcribeST(f)) }
    case "locales":
        let sf = SFSpeechRecognizer.supportedLocales().map(\.identifier).filter { $0.hasPrefix("en") }.sorted()
        let onDevice = sf.filter { SFSpeechRecognizer(locale: Locale(identifier: $0))?.supportsOnDeviceRecognition == true }
        var out: [String: Any] = ["sf": sf, "sfOnDevice": onDevice]
        if #available(macOS 26.0, *) {
            out["st"] = await SpeechTranscriber.supportedLocales.map(\.identifier).filter { $0.hasPrefix("en") }.sorted()
            out["stInstalled"] = await SpeechTranscriber.installedLocales.map(\.identifier).filter { $0.hasPrefix("en") }.sorted()
        }
        emit(out)
    default:
        fail("usage: ares-voicelab record|sf|st|lm-build|locales …")
    }
    exit(0)
} }
RunLoop.main.run()
