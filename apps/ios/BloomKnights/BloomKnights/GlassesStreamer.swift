// GlassesStreamer.swift — REAL Meta Ray-Ban streaming via the Meta Wearables
// Device Access Toolkit (MWDAT). Ported from the proven PokerAI streamer;
// the battle-tested lessons in the comments below were confirmed with device
// logs and must not be "simplified" away.
//
// BloomKnights difference vs PokerAI: instead of writing an mp4, we decode
// ~1 frame per second from the hvc1 stream (VTDecompressionSession), JPEG it,
// and POST it to the backend's /api/frames as source "rayban_sdk".
//
// The whole file only compiles when the MWDAT SDK is linked (xcodegen
// project). The hand-written no-SDK Xcode project skips it entirely, and the
// Glasses tab falls back to phone-camera mode.

#if canImport(MWDATCore) && canImport(MWDATCamera)

import AVFoundation
import CoreImage
import CoreMedia
import Foundation
import SwiftUI
import UIKit
import VideoToolbox
import MWDATCore
import MWDATCamera

// KEEP-ALIVE (audio session) — device logs PROVED this is required. The SDK
// routes the glasses through the Meta AI app (`stellaapp`) running in the
// background; iOS suspends that background app after ~85s, and the media
// daemon (audiomxd) then STOPS the capture — the "capture LED" failure.
// Holding an active audio session keeps the audio route (the glasses register
// as a "Headphone") + Meta AI alive, so streaming survives past 85s.
// `.mixWithOthers` so the user's audio still plays alongside.
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

// Meta's supported preview path is VideoFrame.makeUIImage(). Keep at most one
// conversion in flight so preview work can never back up the SDK delivery queue.
final class PreviewSink: @unchecked Sendable {
    private let lock = NSLock()
    private let work = DispatchQueue(label: "com.bloomknights.preview", qos: .userInitiated)
    private var busy = false
    var onImage: @Sendable (UIImage) -> Void = { _ in }

    func enqueue(_ frame: VideoFrame) {
        lock.lock()
        guard !busy else { lock.unlock(); return }
        busy = true
        lock.unlock()
        work.async { [weak self] in
            guard let self else { return }
            if let image = frame.makeUIImage() { self.onImage(image) }
            self.lock.lock()
            self.busy = false
            self.lock.unlock()
        }
    }
}

// FrameUplink — BloomKnights' replacement for PokerAI's mp4 RecorderBox.
// Frame callbacks arrive on the SDK's serial delivery queue; all state is
// guarded with a lock so it is safe to call from there.
//
// HEVC P-frames depend on prior frames, so we cannot decode "one frame per
// second" by skipping input — EVERY sample buffer is fed to the hardware
// VTDecompressionSession, and only ~1 decoded frame per
// second is JPEG-encoded and POSTed to /api/frames.
final class FrameUplink: @unchecked Sendable {
    private let lock = NSLock()
    private let work = DispatchQueue(label: "com.bloomknights.uplink", qos: .userInitiated)
    private let maxQueuedFrames = 4
    private var queuedFrames = 0
    private var waitForKeyframe = false
    private var decodeSession: VTDecompressionSession?
    private var streaming = false
    private var lastUploadAt = Date.distantPast
    private var lastPublishAt = Date.distantPast
    private let uploadInterval: TimeInterval = 0.2   // ~4.8 fps to the backend
    private let publishInterval: TimeInterval = 1.0 / 12.0
    // Every frame is base64'd into JSON, which inflates it by a third, and the
    // link is the bottleneck — not the encoder. Halving the payload buys more
    // frames per second than any encoder tuning does, and at 360x640 the
    // identification model cannot tell the difference.
    private let jpegQuality: CGFloat = 0.45
    private let ciContext = CIContext()
    // Encoding must not happen on the SDK's frame-delivery thread (see the
    // note by tickDiagnostics): a JPEG encode there stalls delivery and the
    // whole stream throttles to a crawl. One serial queue, and at most one
    // upload in flight — a backlog would only ever deliver stale frames.
    private let uploadQueue = DispatchQueue(label: "reloop.frame-upload", qos: .userInitiated)
    private var uploadInFlight = false

    // Counters mirror CameraStreamer's sent/accepted/skipped/failed so the
    // Glasses tab shows the same numbers for both sources.
    private var sent = 0
    private var accepted = 0
    private var skipped = 0
    private var failed = 0
    var onCounters: @Sendable (Int, Int, Int, Int) -> Void = { _, _, _, _ in }
    var sportProvider: @Sendable () -> String = { Sport.nba.rawValue }
    // Selected decoded frames (12 fps) feed the WebRTC publisher. Set from the
    // streamer; called on the VT decode callback thread.
    private var onDecodedFrame: (@Sendable (CVImageBuffer) -> Void)?

    func setFrameTap(_ tap: (@Sendable (CVImageBuffer) -> Void)?) {
        lock.lock()
        onDecodedFrame = tap
        lock.unlock()
    }

    func routeRaw(_ sb: CMSampleBuffer) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sb) else { return }
        lock.lock()
        guard streaming else { lock.unlock(); return }
        let now = Date()
        // The HTTP upload and the local preview run on independent clocks: the
        // preview wants every frame it can get, the upload wants ~1 fps. Both
        // are decided here because routeRaw is the ONLY path the live stream
        // actually takes — ingest() is not called by anything.
        let wantUpload = httpUploadEnabled && now.timeIntervalSince(lastUploadAt) >= uploadInterval
        if wantUpload { lastUploadAt = now }
        let wantPublish = now.timeIntervalSince(lastPublishAt) >= publishInterval
        if wantPublish { lastPublishAt = now }
        let tap = onDecodedFrame
        lock.unlock()
        if wantPublish { tap?(imageBuffer) }
        if wantUpload { scheduleUpload(imageBuffer) }
    }
    // The ~1 fps JPEG POST to /api/frames. This is how the web viewer sees the
    // glasses feed: the browser polls /api/live-frame rather than negotiating
    // WebRTC with the phone, which needs no signalling, no ICE, no TURN and no
    // HTTPS. It was switched off when the desktop viewer sampled WebRTC itself,
    // which left the server receiving nothing at all.
    var httpUploadEnabled = true

    // Diagnostics throttle (1-in-3), same trick as PokerAI: doing per-frame
    // work on the SDK's delivery thread can choke it and freeze the stream.
    private var frameNo = 0
    func tickDiagnostics() -> Bool { lock.lock(); defer { lock.unlock() }; frameNo += 1; return frameNo % 3 == 0 }

    private var reportedSize = "-"
    func sizeLabel() -> String { lock.lock(); defer { lock.unlock() }; return reportedSize }

    func note(_ frame: VideoFrame) {
        guard let fmt = CMSampleBufferGetFormatDescription(frame.sampleBuffer) else { return }
        let d = CMVideoFormatDescriptionGetDimensions(fmt)
        lock.lock()
        reportedSize = "\(d.width)x\(d.height)"
        lock.unlock()
    }

    func setStreaming(_ on: Bool) {
        lock.lock()
        streaming = on
        if on {
            sent = 0; accepted = 0; skipped = 0; failed = 0
            lastUploadAt = .distantPast; lastPublishAt = .distantPast
            waitForKeyframe = false
        }
        if !on, let s = decodeSession {
            VTDecompressionSessionInvalidate(s)
            decodeSession = nil
        }
        lock.unlock()
    }

    // A sample is a keyframe unless it is explicitly flagged NotSync. The
    // decoder must start on a keyframe or the first GOP is undecodable.
    private static func isKeyframe(_ sb: CMSampleBuffer) -> Bool {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false),
              CFArrayGetCount(arr) > 0 else { return true }
        let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary.self) as NSDictionary
        if let notSync = dict[kCMSampleAttachmentKey_NotSync as String] as? Bool { return !notSync }
        return true
    }

    func ingest(_ sb: CMSampleBuffer) {
        let keyframe = Self.isKeyframe(sb)
        lock.lock()
        guard streaming else { lock.unlock(); return }
        if waitForKeyframe {
            guard keyframe, queuedFrames == 0 else { lock.unlock(); return }
            if let session = decodeSession { VTDecompressionSessionInvalidate(session) }
            decodeSession = nil
            waitForKeyframe = false
        }
        guard queuedFrames < maxQueuedFrames else {
            waitForKeyframe = true
            lock.unlock()
            return
        }
        queuedFrames += 1
        lock.unlock()
        work.async { [weak self] in
            self?.ingestSync(sb)
            self?.finishedQueuedFrame()
        }
    }

    private func finishedQueuedFrame() {
        lock.lock()
        queuedFrames = max(0, queuedFrames - 1)
        lock.unlock()
    }

    private func ingestSync(_ sb: CMSampleBuffer) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb) else { return }

        lock.lock()
        guard streaming else { lock.unlock(); return }
        if let s = decodeSession, !VTDecompressionSessionCanAcceptFormatDescription(s, formatDescription: fmt) {
            VTDecompressionSessionInvalidate(s)
            decodeSession = nil
        }
        if decodeSession == nil {
            guard Self.isKeyframe(sb) else { lock.unlock(); return }   // wait for the first keyframe
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            ]
            var session: VTDecompressionSession?
            let status = VTDecompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                formatDescription: fmt,
                decoderSpecification: nil,
                imageBufferAttributes: attrs as CFDictionary,
                outputCallback: nil,
                decompressionSessionOut: &session
            )
            guard status == noErr, let session else { lock.unlock(); return }
            decodeSession = session
        }
        guard let session = decodeSession else { lock.unlock(); return }
        let now = Date()
        let wantUpload = httpUploadEnabled && now.timeIntervalSince(lastUploadAt) >= uploadInterval
        if wantUpload { lastUploadAt = now }
        let wantPublish = now.timeIntervalSince(lastPublishAt) >= publishInterval
        if wantPublish { lastPublishAt = now }
        lock.unlock()

        // Decode every frame (required for P-frame continuity). Publish at a
        // bounded 12 fps; the ~1/second "wantUpload" frames additionally get
        // JPEG-encoded and POSTed when enabled.
        VTDecompressionSessionDecodeFrame(session,
                                          sampleBuffer: sb,
                                          flags: [],
                                          infoFlagsOut: nil) { [weak self] status, _, imageBuffer, _, _ in
            guard status == noErr, let imageBuffer, let self else { return }
            if wantPublish {
                self.lock.lock()
                let tap = self.onDecodedFrame
                self.lock.unlock()
                tap?(imageBuffer)
            }
            if wantUpload { self.scheduleUpload(imageBuffer) }
        }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    // Hands the frame to the upload queue and returns immediately, so the
    // SDK's delivery thread is never blocked on an encode or a network call.
    private func scheduleUpload(_ imageBuffer: CVImageBuffer) {
        lock.lock()
        if uploadInFlight { lock.unlock(); return }
        uploadInFlight = true
        lock.unlock()
        uploadQueue.async { [weak self] in
            self?.encodeAndPost(imageBuffer)
            self?.lock.lock()
            self?.uploadInFlight = false
            self?.lock.unlock()
        }
    }

    private func encodeAndPost(_ imageBuffer: CVImageBuffer) {
        let ciImage = CIImage(cvImageBuffer: imageBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent),
              let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: jpegQuality) else { return }

        let submission = FrameSubmission(
            source: "rayban_sdk",
            sport: sportProvider(),
            capturedAt: Self.isoFormatter.string(from: Date()),
            imageBase64: jpeg.base64EncodedString(),
            width: Int(ciImage.extent.width),
            height: Int(ciImage.extent.height)
        )

        report(sentDelta: 1)
        Task { [weak self] in
            guard let self else { return }
            do {
                let api = try ApiClient.fromSettings()
                let result = try await api.submitFrame(submission)
                if result.selection?.accepted == true {
                    self.report(acceptedDelta: 1)
                } else {
                    self.report(skippedDelta: 1)
                }
            } catch {
                self.report(failedDelta: 1)
            }
        }
    }

    private func report(sentDelta: Int = 0, acceptedDelta: Int = 0,
                        skippedDelta: Int = 0, failedDelta: Int = 0) {
        lock.lock()
        sent += sentDelta
        accepted += acceptedDelta
        skipped += skippedDelta
        failed += failedDelta
        let snapshot = (sent, accepted, skipped, failed)
        lock.unlock()
        onCounters(snapshot.0, snapshot.1, snapshot.2, snapshot.3)
    }
}

@MainActor
final class GlassesStreamer: ObservableObject {
    @Published var latestFrame: UIImage?
    @Published var status = "Ready"
    @Published var isStreaming = false
    // On-screen diagnostics
    @Published var regState = "-"
    @Published var deviceInfo = "No glasses paired yet"
    @Published var hasActiveDevice = false
    @Published var lastError = ""
    @Published var frameSize = "-"
    @Published var elapsed = "00:00"
    // Uplink counters (mirrors CameraStreamer)
    @Published var sent = 0
    @Published var accepted = 0
    @Published var skipped = 0
    @Published var failed = 0

    private var elapsedTimer: Timer?
    private var startedAt: Date?
    private var lastRestartAt = Date.distantPast

    private let wearables = Wearables.shared
    private let deviceSelector: AutoDeviceSelector
    private var session: DeviceSession?
    // DAT 0.9.0 consolidated streaming under Camera: the session hands back a
    // Camera that owns the hardware, and the stream is its child. The camera
    // reference must be held — stopping it cascades to the stream.
    private var camera: MWDATCamera.Camera?
    private var stream: MWDATCamera.Stream?
    private var tokens: [any AnyListenerToken] = []
    private var compatTokens: [DeviceIdentifier: any AnyListenerToken] = [:]
    private let uplink = FrameUplink()
    private let keepAlive = KeepAlive()   // keeps Meta AI + glasses alive past ~85s
    let preview = PreviewSink()

    init() {
        deviceSelector = AutoDeviceSelector(wearables: Wearables.shared)
        uplink.onCounters = { [weak self] s, a, k, f in
            Task { @MainActor in
                guard let self else { return }
                self.sent = s
                self.accepted = a
                self.skipped = k
                self.failed = f
            }
        }
        preview.onImage = { [weak self] image in
            Task { @MainActor in self?.latestFrame = image }
        }
    }

    func updateSport(_ sportId: String) {
        uplink.sportProvider = { sportId }
    }

    // Route selected raw frames to a consumer — the RTC publisher.
    func setFrameTap(_ tap: (@Sendable (CVImageBuffer) -> Void)?) {
        uplink.setFrameTap(tap)
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

    // THE START BUTTON. Registers if needed, opens the session, and streams.
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

    // THE STOP BUTTON. Ends the session and the uplink.
    func stop() {
        pendingStart = false
        elapsedTimer?.invalidate(); elapsedTimer = nil
        keepAlive.stop()
        UIApplication.shared.isIdleTimerDisabled = false
        uplink.setStreaming(false); isStreaming = false
        stream?.stop(); stream = nil
        camera?.stop(); camera = nil
        session?.stop(); session = nil
        // Drop the stream's frame/state/error listeners so a restart doesn't
        // stack duplicate subscriptions (double callbacks + leak). Compatibility
        // listeners are keyed per-device and deduped, so they stay.
        tokens.removeAll()
        latestFrame = nil
        status = "Stopped"
    }

    // Debounced recovery: nudge the stream back ONLY if it fully stopped while
    // we still intend to stream, and at most once every 4s — so a flurry of
    // state churn can never restart the camera in a tight loop (the
    // LED-flicker storm).
    private func nudgeRestart(_ reason: String) {
        guard isStreaming, let s = stream else { return }
        if Date().timeIntervalSince(lastRestartAt) < 4 { status = "Buffering…"; return }
        lastRestartAt = Date()
        status = "Reconnecting…"
        s.start()
    }

    // Opens the session + stream and immediately begins the frame uplink.
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

                // Match Meta's supported CameraAccess sample exactly.
                // .hvc1 + .medium (504x896) @ 24fps. Device-tested by this project
                // in July: .medium is the only resolution that streams smooth and
                // continuous over Bluetooth on this SDK (.high stalls at any fps
                // once the BT channel congests; .medium ran clean ~8 minutes).
                //
                // The codec matters more than the resolution. .raw is
                // UNCOMPRESSED — 360x640 YUV is ~345KB a frame, ~8MB/s at 24fps,
                // against a Bluetooth channel that tops out near 300KB/s — so the
                // glasses throttle hard and the feed crawls. .hvc1 is H.265 and
                // fits, which is why a bigger picture over .hvc1 beats a smaller
                // one over .raw.
                //
                // 15fps rather than the 24 that test used: a later pass called
                // 15 "the lightest, fastest pipe", and we only need ~5fps for the
                // uploads and 12 for the preview. Asking a congested Bluetooth
                // link for 24 buys nothing and costs freshness.
                let config = StreamConfiguration(videoCodec: .hvc1, resolution: .medium, frameRate: 15)
                guard let camera = try session.addCamera(config: config) else {
                    self.status = "Could not open camera"
                    session.stop(); self.session = nil   // don't orphan the started session
                    return
                }
                self.camera = camera
                let stream = camera.stream
                self.stream = stream

                let uplink = self.uplink
                let preview = self.preview
                let frameTok = stream.videoFramePublisher.listen { [weak self] frame in
                    // .hvc1 arrives encoded, so it goes through the decode path.
                    // ingest() hands off to VTDecompressionSession and never
                    // blocks the SDK's delivery thread.
                    uplink.ingest(frame.sampleBuffer)
                    preview.enqueue(frame)
                    guard uplink.tickDiagnostics() else { return }
                    uplink.note(frame)
                    Task { @MainActor in self?.frameSize = uplink.sizeLabel() }
                }
                tokens.append(frameTok)

                // Stream state. Transient BT stalls surface as .paused and the
                // SDK SELF-RECOVERS in ~1-2s — do NOT restart on pause
                // (restarting the stream every hiccup re-inits the camera =
                // the LED-flicker "restart storm"). Only a full, unexpected
                // .stopped gets a DEBOUNCED nudge.
                let stateTok = stream.statePublisher.listen { [weak self] s in
                    Task { @MainActor in
                        guard let self else { return }
                        if s == .streaming {
                            self.status = "STREAMING (raw, \(self.elapsed))"
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

                // Most stream errors are transient ("stream can continue
                // regardless", BT jitter) and recover on their own (SDK #214)
                // — restarting on every one is what caused the camera to keep
                // restarting. Log it; the .stopped state handler owns
                // recovery, debounced.
                let errTok = stream.errorPublisher.listen { [weak self] e in
                    Task { @MainActor in self?.lastError = "Stream note: \(e)" }
                }
                tokens.append(errTok)

                // Arm the uplink BEFORE starting the stream so the very first
                // frame/keyframe is never dropped (ingest() no-ops until armed,
                // and gates on the first keyframe anyway).
                uplink.setStreaming(true)
                self.isStreaming = true
                self.lastRestartAt = .distantPast   // fresh session: clear stale debounce
                // Keep Meta AI + the glasses audio route alive (or iOS
                // suspends it at ~85s and the capture dies). Also stop the
                // phone auto-locking.
                self.keepAlive.start()
                UIApplication.shared.isIdleTimerDisabled = true
                self.startElapsedTimer()
                stream.start()
                self.status = "STREAMING (raw, low latency)"
            } catch {
                self.lastError = "\(error)"
                // Meta SDK #231: a prior hard suspension (e.g. phone locked
                // mid-stream) can leave the glasses holding a phantom
                // broadcast, and every start then fails with "Session ended by
                // device". Only a physical reset clears it — tell the user
                // instead of a generic error.
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

#endif  // canImport(MWDATCore) && canImport(MWDATCamera)
