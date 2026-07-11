import Foundation
import SwiftUI
import UIKit
import AVFoundation
import CoreMedia
import MWDATCore
import MWDATCamera

// KEEP-ALIVE (audio session) — device logs PROVED this is required. The SDK
// routes the glasses through the Meta AI app (`stellaapp`) running in the
// background; iOS suspends that background app after ~85s, and the media daemon
// (audiomxd) then STOPS the capture — the "capture LED" failure. Holding an
// active audio session keeps the audio route (the glasses register as a
// "Headphone") + Meta AI alive, so recording survives past 85s. `.mixWithOthers`
// so the user's music (via the phone speaker) still plays alongside.
final class KeepAlive {
    private let engine = AVAudioEngine()
    private var src: AVAudioSourceNode?
    private var running = false

    func start() {
        guard !running else { return }
        do {
            let sess = AVAudioSession.sharedInstance()
            try sess.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try sess.setActive(true)
            let fmt = engine.outputNode.inputFormat(forBus: 0)
            let node = AVAudioSourceNode { _, _, _, audioBufferList -> OSStatus in
                let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
                for buf in abl { memset(buf.mData, 0, Int(buf.mDataByteSize)) }
                return noErr
            }
            engine.attach(node)
            src = node
            engine.connect(node, to: engine.mainMixerNode, format: fmt)
            try engine.start()
            running = true
        } catch {
            engine.stop()
            if let node = src { engine.detach(node); src = nil }
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            running = false
        }
    }

    func stop() {
        guard running else { return }
        engine.stop()
        if let node = src { engine.detach(node); src = nil }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        running = false
    }
}

// Live preview for hvc1: makeUIImage() can't decode compressed HEVC (→ blank
// screen), so we feed the encoded sample buffers straight to an
// AVSampleBufferDisplayLayer, which decodes + renders them natively in real time.
// Sendable so the SDK delivery thread can enqueue without hopping through the
// @MainActor streamer. Enqueue is marshalled to main (the layer is UI).
final class PreviewSink: @unchecked Sendable {
    let layer = AVSampleBufferDisplayLayer()

    func enqueue(_ sb: CMSampleBuffer) {
        // Display immediately (live view — no timebase needed).
        if let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true),
           CFArrayGetCount(arr) > 0 {
            let d = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(d,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        let l = layer
        DispatchQueue.main.async {
            if l.status == .failed { l.flush() }
            if l.isReadyForMoreMediaData { l.enqueue(sb) }
        }
    }
}

// Thread-safe recorder. Frame callbacks arrive on the SDK's serial delivery
// queue; writer state is guarded with a lock so it is safe to call from there.
final class RecorderBox: @unchecked Sendable {
    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var started = false
    private var recording = false
    private(set) var url: URL?

    func setRecording(_ on: Bool) { lock.lock(); recording = on; lock.unlock() }

    // Preview throttle: decoding a full-res UIImage every frame on the SDK's
    // delivery thread can choke it and freeze the stream. Preview ~1 in 3.
    private var frameNo = 0
    func tickPreview() -> Bool { lock.lock(); defer { lock.unlock() }; frameNo += 1; return frameNo % 3 == 0 }

    // Writer is sized to the FIRST frame's native dimensions (no forced crop
    // or letterbox) so the recording keeps the exact field of view the glasses
    // send. reportedSize exposes those dims for on-screen diagnostics.
    private var reportedSize = "-"
    // Thread-safe read: reportedSize is written on the SDK delivery thread under
    // the lock, so callers on the main actor must read it under the lock too.
    func sizeLabel() -> String { lock.lock(); defer { lock.unlock() }; return reportedSize }

    func start() {
        lock.lock(); defer { lock.unlock() }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let u = docs.appendingPathComponent("poker_\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: u)
        writer = nil; input = nil; started = false; url = u
    }

    // The glasses deliver already-encoded HEVC (hvc1) samples, so we write them
    // straight to disk — no re-encode, no decode. outputSettings: nil = passthrough;
    // the sourceFormatHint carries the HEVC parameter sets the writer needs.
    private func makeWriter(formatDescription: CMFormatDescription) {
        guard let u = url, let w = try? AVAssetWriter(outputURL: u, fileType: .mp4) else { return }
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: formatDescription)
        inp.expectsMediaDataInRealTime = true
        // Fail fast if the input can't attach — otherwise appends silently no-op
        // and we'd think we're recording into a writer that never writes.
        guard w.canAdd(inp) else { return }
        w.add(inp)
        writer = w; input = inp
    }

    // A sample is a keyframe unless it is explicitly flagged NotSync. HEVC files
    // must begin on a keyframe or they are undecodable from the front.
    private static func isKeyframe(_ sb: CMSampleBuffer) -> Bool {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false),
              CFArrayGetCount(arr) > 0 else { return true }
        let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary.self) as NSDictionary
        if let notSync = dict[kCMSampleAttachmentKey_NotSync as String] as? Bool { return !notSync }
        return true
    }

    // Records the incoming frame size even before recording starts, so we can
    // display the true stream dimensions on screen.
    func note(_ frame: VideoFrame) {
        guard let fmt = CMSampleBufferGetFormatDescription(frame.sampleBuffer) else { return }
        let d = CMVideoFormatDescriptionGetDimensions(fmt)
        lock.lock()
        reportedSize = "\(d.width)x\(d.height)"
        lock.unlock()
    }

    func append(_ frame: VideoFrame) {
        lock.lock(); defer { lock.unlock() }
        guard recording else { return }
        let sb = frame.sampleBuffer
        if writer == nil {
            guard let fmt = CMSampleBufferGetFormatDescription(sb) else { return }
            makeWriter(formatDescription: fmt)
        }
        guard let w = writer, let inp = input else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if !started {
            guard Self.isKeyframe(sb) else { return }   // wait for the first keyframe
            w.startWriting(); w.startSession(atSourceTime: pts); started = true
        }
        if inp.isReadyForMoreMediaData { inp.append(sb) }
    }

    func stop(completion: @escaping @Sendable (URL?) -> Void) {
        lock.lock(); recording = false
        guard let w = writer, let inp = input else { lock.unlock(); completion(nil); return }
        let u = url; writer = nil; input = nil
        lock.unlock()
        inp.markAsFinished()
        w.finishWriting { completion(u) }
    }
}

@MainActor
final class GlassesStreamer: ObservableObject {
    @Published var latestFrame: UIImage?
    @Published var status = "Starting up..."
    @Published var isRecording = false
    @Published var savedFile = ""
    // On-screen diagnostics
    @Published var regState = "-"
    @Published var deviceInfo = "No glasses paired yet"
    @Published var hasActiveDevice = false
    @Published var lastError = ""
    @Published var frameSize = "-"
    @Published var elapsed = "00:00"
    @Published var uploadStatus = ""

    // Mac Mini on the HOME LAN — recordings auto-upload here after STOP whenever
    // the phone is on home Wi-Fi. No Tailscale/VPN (that double-burns cellular);
    // this is local-network only, zero cellular data. If not on home Wi-Fi the
    // upload just fails and the clip stays on the phone until next time home.
    // NOTE: pin 192.168.1.113 as a DHCP reservation on the router so it never moves.
    private let uploadURL = "http://192.168.1.113:8009/upload"

    private var elapsedTimer: Timer?
    private var startedAt: Date?
    private var lastRestartAt = Date.distantPast

    private let wearables = Wearables.shared
    private let deviceSelector: AutoDeviceSelector
    private var session: DeviceSession?
    private var stream: MWDATCamera.Stream?
    private var tokens: [any AnyListenerToken] = []
    private var compatTokens: [DeviceIdentifier: any AnyListenerToken] = [:]
    private let recorder = RecorderBox()
    private let keepAlive = KeepAlive()   // keeps Meta AI + glasses alive past ~85s
    let preview = PreviewSink()   // live on-screen view of the hvc1 stream

    init() {
        deviceSelector = AutoDeviceSelector(wearables: Wearables.shared)
    }

    // Start all the live monitors so the screen always shows current state.
    func monitor() {
        Task { [weak self] in
            guard let self else { return }
            for await s in wearables.registrationStateStream() {
                self.regState = "\(s)"
            }
        }
        Task { [weak self] in
            guard let self else { return }
            for await _ in wearables.devicesStream() {
                self.refreshDeviceInfo()
            }
        }
        Task { [weak self] in
            guard let self else { return }
            for await dev in deviceSelector.activeDeviceStream() {
                self.hasActiveDevice = (dev != nil)
                self.refreshDeviceInfo()
                // If START was pressed while the glasses were still waking up,
                // kick off the moment they go active.
                if dev != nil && pendingStart {
                    self.beginCapture()
                }
                // Glasses went away mid-session — reflect it.
                if dev == nil && stream != nil {
                    self.status = "Glasses disconnected - put them on"
                }
            }
        }
    }

    private func refreshDeviceInfo() {
        let ids = wearables.devices
        if ids.isEmpty { deviceInfo = "No glasses paired yet"; return }
        var lines: [String] = []
        for id in ids {
            if let dev = wearables.deviceForIdentifier(id) {
                let compat = dev.compatibility()
                lines.append("GLASSES \(dev.nameOrId()): \(compat.displayString)")
                if compatTokens[id] == nil {
                    let t = dev.addCompatibilityListener { [weak self] _ in
                        Task { @MainActor in self?.refreshDeviceInfo() }
                    }
                    compatTokens[id] = t
                }
            }
        }
        lines.append(hasActiveDevice ? "ACTIVE: ready to stream" : "waiting for handshake...")
        deviceInfo = lines.joined(separator: "\n")
    }

    // MARK: - One-button control

    private var pendingStart = false

    var isRunning: Bool { stream != nil }
    // Running OR still connecting — so a background transition mid-startup also
    // fully tears down (otherwise pendingStart stays armed and can resume later).
    var isBusy: Bool { isRunning || pendingStart }

    // THE START BUTTON. Does everything: register if needed, open the session,
    // stream, record video, and snap photos on an interval — one tap.
    func start() {
        guard stream == nil else { return }   // already running — ignore double taps
        lastError = ""
        pendingStart = true
        // Register first if the glasses have never been linked to this app.
        if wearables.registrationState != .registered {
            status = "Opening Meta AI to connect..."
            Task { [weak self] in try? await self?.wearables.startRegistration() }
            return
        }
        if hasActiveDevice {
            beginCapture()
        } else {
            status = "Put glasses on your face — waiting..."
        }
    }

    // THE STOP BUTTON. Ends everything and saves the video.
    func stop() {
        pendingStart = false
        elapsedTimer?.invalidate(); elapsedTimer = nil
        keepAlive.stop()
        UIApplication.shared.isIdleTimerDisabled = false
        let wasRecording = isRecording
        recorder.setRecording(false); isRecording = false
        stream?.stop(); stream = nil
        session?.stop(); session = nil
        // Drop the stream's frame/state/error listeners so a restart doesn't
        // stack duplicate subscriptions (double callbacks + leak). Compatibility
        // listeners are keyed per-device and deduped, so they stay.
        tokens.removeAll()
        latestFrame = nil
        if wasRecording {
            recorder.stop { [weak self] url in
                Task { @MainActor in
                    self?.savedFile = url?.lastPathComponent ?? ""
                    self?.status = "Saved \(url?.lastPathComponent ?? "?")"
                    if let url { self?.uploadToMac(url) }
                }
            }
        } else {
            status = "Stopped"
        }
    }

    // Send the finished recording to the Mac Mini over Tailscale. If it fails
    // (offline / Tailscale off), the file stays on the phone as a fallback.
    private func uploadToMac(_ fileURL: URL) {
        let name = fileURL.lastPathComponent
        guard var comps = URLComponents(string: uploadURL) else { return }
        comps.queryItems = [URLQueryItem(name: "name", value: name)]
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        uploadStatus = "Uploading \(name)..."
        let task = URLSession.shared.uploadTask(with: req, fromFile: fileURL) { [weak self] _, resp, err in
            Task { @MainActor in
                if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                    self?.uploadStatus = "Uploaded \(name) to Mac"
                } else {
                    self?.uploadStatus = "Upload failed (kept on phone): \(err?.localizedDescription ?? "no Tailscale?")"
                }
            }
        }
        task.resume()
    }

    // Debounced recovery: nudge the stream back ONLY if it fully stopped while we
    // still intend to record, and at most once every 4s — so a flurry of state
    // churn can never restart the camera in a tight loop (the LED-flicker storm).
    private func nudgeRestart(_ reason: String) {
        guard isRecording, let s = stream else { return }
        if Date().timeIntervalSince(lastRestartAt) < 4 { status = "Buffering…"; return }
        lastRestartAt = Date()
        status = "Reconnecting…"
        s.start()
    }

    // Opens the session + stream and immediately begins recording + photos.
    private func beginCapture() {
        guard pendingStart, stream == nil else { return }
        pendingStart = false
        Task { [weak self] in
            guard let self else { return }
            do {
                var perm = try await wearables.checkPermissionStatus(.camera)
                if perm != .granted {
                    self.status = "Allow camera in Meta AI..."
                    perm = try await wearables.requestPermission(.camera)
                }
                guard perm == .granted else { self.status = "Camera permission denied"; return }

                let session = try wearables.createSession(deviceSelector: deviceSelector)
                self.session = session
                try session.start()
                if session.state != .started {
                    for await st in session.stateStream() {
                        if st == .started { break }
                        if st == .stopped { self.status = "Session stopped early"; return }
                    }
                }

                // .high (720x1280) for readable cards INCLUDING the board at table
                // distance. SDK 0.8 added automatic WiFi transport ("consistent video
                // quality at high resolution settings") — at .high the SDK delivers
                // frames over WiFi/softAP instead of Bluetooth (far more bandwidth),
                // so 720p runs stable where it used to stall on BT. The phone drops to
                // cellular during the session (fine — we record locally) + a one-time
                // WiFi permission prompt. If it still cuts, WiFi didn't engage and we
                // dig into the enable path; fall back to .medium 504x896.
                let config = StreamConfiguration(videoCodec: .hvc1, resolution: .high, frameRate: 24)
                guard let stream = try session.addStream(config: config) else {
                    self.status = "Could not open camera"
                    session.stop(); self.session = nil   // don't orphan the started session
                    return
                }
                self.stream = stream

                let recorder = self.recorder
                let preview = self.preview
                // Record EVERY frame (cheap pass-through) AND feed the live preview
                // layer, which decodes the encoded HEVC natively. Captured as locals
                // so the SDK delivery thread never touches the @MainActor streamer.
                let frameTok = stream.videoFramePublisher.listen { [weak self] frame in
                    recorder.append(frame)
                    preview.enqueue(frame.sampleBuffer)
                    guard recorder.tickPreview() else { return }
                    recorder.note(frame)
                    Task { @MainActor in self?.frameSize = recorder.sizeLabel() }
                }
                tokens.append(frameTok)

                // Stream state. Transient BT stalls surface as .paused and the SDK
                // SELF-RECOVERS in ~1-2s — do NOT restart on pause (restarting the
                // stream every hiccup re-inits the camera = the LED-flicker "restart
                // storm"). Only a full, unexpected .stopped gets a DEBOUNCED nudge.
                let stateTok = stream.statePublisher.listen { [weak self] s in
                    Task { @MainActor in
                        guard let self else { return }
                        if s == .streaming {
                            self.status = "RECORDING (hvc1, \(self.elapsed))"
                        } else if s == .paused {
                            self.status = "Buffering…"          // self-recovers; don't touch it
                        } else if s == .stopped {
                            self.nudgeRestart("stream stopped")
                        } else {
                            self.status = "Stream: \(s)"
                        }
                    }
                }
                tokens.append(stateTok)

                // Most stream errors are transient ("stream can continue regardless",
                // BT jitter) and recover on their own (SDK #214) — restarting on every
                // one is what caused the camera to keep restarting. Log it; the
                // .stopped state handler owns recovery, debounced.
                let errTok = stream.errorPublisher.listen { [weak self] e in
                    Task { @MainActor in self?.lastError = "Stream note: \(e)" }
                }
                tokens.append(errTok)

                // Arm the recorder BEFORE starting the stream so the very first
                // frame/keyframe is never dropped (append() no-ops until armed, and
                // gates on the first keyframe anyway).
                recorder.start(); recorder.setRecording(true)
                self.isRecording = true
                self.lastRestartAt = .distantPast   // fresh session: clear stale debounce
                // Keep Meta AI + the glasses audio route alive (or iOS suspends it
                // at ~85s and the capture dies). Also stop the phone auto-locking.
                self.keepAlive.start()
                UIApplication.shared.isIdleTimerDisabled = true
                self.startElapsedTimer()
                stream.start()
                self.status = "RECORDING (hvc1, max clarity)"
            } catch {
                self.lastError = "\(error)"
                // Meta SDK #231: a prior hard suspension (e.g. phone locked mid-
                // stream) can leave the glasses holding a phantom broadcast, and
                // every start then fails with "Session ended by device". Only a
                // physical reset clears it — tell the user instead of a generic error.
                if "\(error)".contains("Session ended by device") {
                    self.status = "Glasses stuck from a dropped session. Put them in the case, close the lid ~30s, then reopen and press START."
                } else {
                    self.status = "Failed to start"
                }
            }
        }
    }

    private func startElapsedTimer() {
        startedAt = Date()
        elapsedTimer?.invalidate()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let start = self.startedAt else { return }
                let s = Int(Date().timeIntervalSince(start))
                self.elapsed = String(format: "%02d:%02d", s / 60, s % 60)
            }
        }
    }

}
