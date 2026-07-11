// GlassesStreamer — BAREBONES. One job: connect to the Meta Ray-Ban glasses,
// take the hvc1 video stream, decode it, and publish it over WebRTC so the
// website (/capture) shows the feed. No recording, no on-phone preview, no
// analysis frames — the lightest, fastest pipe possible.
import Foundation
import SwiftUI
import AVFoundation
import CoreMedia
import MWDATCore
import MWDATCamera

// KEEP-ALIVE (audio session) — device logs PROVED this is required. The SDK
// routes the glasses through the Meta AI app which iOS suspends after ~85s,
// killing capture. Holding an active (silent, mix-with-others) audio session
// keeps the route + Meta AI alive so streaming survives past 85s.
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
            let node = AVAudioSourceNode { _, _, _, abl -> OSStatus in
                let list = UnsafeMutableAudioBufferListPointer(abl)
                for buf in list { memset(buf.mData, 0, Int(buf.mDataByteSize)) }
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

@MainActor
final class GlassesStreamer: ObservableObject {
    @Published var status = "Ready"
    @Published var isLive = false
    @Published var rtcStatus = ""

    // The laptop backend behind the Cloudflare tunnel — WebRTC signaling.
    static let backendBase = URL(string: "https://capture.saicharanramineni.com")!

    private let wearables = Wearables.shared
    private let deviceSelector: AutoDeviceSelector
    private var session: DeviceSession?
    private var stream: MWDATCamera.Stream?
    private var tokens: [any AnyListenerToken] = []
    private var statusTimer: Timer?
    private var lastRestartAt = Date.distantPast
    private var pendingStart = false

    private let decoder = FrameDecoder()
    let rtc = RTCPublisher()
    private let keepAlive = KeepAlive()

    init() {
        deviceSelector = AutoDeviceSelector(wearables: Wearables.shared)
        let rtc = self.rtc
        decoder.onFrame = { buf in rtc.push(buf) }   // decoded frame → WebRTC
    }

    // Watch the active-device stream so START works even if the glasses were
    // still waking up when it was pressed.
    func monitor() {
        Task { [weak self] in
            guard let self else { return }
            for await dev in deviceSelector.activeDeviceStream() {
                if dev != nil && self.pendingStart { self.beginCapture() }
                if dev == nil && self.stream != nil { self.status = "Glasses disconnected — put them on" }
            }
        }
    }

    // MARK: - START / STOP

    func start() {
        guard stream == nil else { return }
        pendingStart = true
        if wearables.registrationState != .registered {
            status = "Opening Meta AI to connect…"
            Task { [weak self] in try? await self?.wearables.startRegistration() }
            return
        }
        // Kick off immediately; if no active device yet, monitor() starts it.
        beginCapture()
    }

    func stop() {
        pendingStart = false
        statusTimer?.invalidate(); statusTimer = nil
        decoder.setRunning(false)
        rtc.disconnect(); rtcStatus = ""
        keepAlive.stop()
        UIApplication.shared.isIdleTimerDisabled = false
        stream?.stop(); stream = nil
        session?.stop(); session = nil
        tokens.removeAll()
        isLive = false
        status = "Stopped"
    }

    private func beginCapture() {
        guard pendingStart, stream == nil else { return }
        pendingStart = false
        Task { [weak self] in
            guard let self else { return }
            do {
                var perm = try await wearables.checkPermissionStatus(.camera)
                if perm != .granted {
                    status = "Allow camera in Meta AI…"
                    perm = try await wearables.requestPermission(.camera)
                }
                guard perm == .granted else { status = "Camera permission denied"; return }

                let session = try wearables.createSession(deviceSelector: deviceSelector)
                self.session = session
                try session.start()
                if session.state != .started {
                    for await st in session.stateStream() {
                        if st == .started { break }
                        if st == .stopped { status = "Session stopped early"; return }
                    }
                }

                // 720p for quality, 15fps for a smooth, low-load, stable feed.
                let config = StreamConfiguration(videoCodec: .hvc1, resolution: .high, frameRate: 15)
                guard let stream = try session.addStream(config: config) else {
                    status = "Could not open camera"
                    session.stop(); self.session = nil
                    return
                }
                self.stream = stream

                let decoder = self.decoder
                // The ONLY per-frame work: hand the sample to the decoder (which
                // decodes on its own bounded queue → WebRTC). Delivery thread stays
                // free.
                let frameTok = stream.videoFramePublisher.listen { frame in
                    decoder.ingest(frame.sampleBuffer)
                }
                tokens.append(frameTok)

                // Transient stalls surface as .paused and self-recover — don't touch.
                // Only a full .stopped gets a debounced nudge.
                let stateTok = stream.statePublisher.listen { [weak self] s in
                    Task { @MainActor in
                        guard let self else { return }
                        switch s {
                        case .streaming: self.status = "LIVE 720p → site"
                        case .paused:    self.status = "Buffering…"
                        case .stopped:   self.nudgeRestart()
                        default:         self.status = "Stream: \(s)"
                        }
                    }
                }
                tokens.append(stateTok)

                let errTok = stream.errorPublisher.listen { _ in }   // transient; ignore
                tokens.append(errTok)

                decoder.setRunning(true)
                Task { [weak self] in await self?.rtc.connect(baseURL: Self.backendBase) }
                self.isLive = true
                self.lastRestartAt = .distantPast
                self.keepAlive.start()
                UIApplication.shared.isIdleTimerDisabled = true
                self.startStatusTimer()
                stream.start()
                self.status = "LIVE 720p → site"
            } catch {
                if "\(error)".contains("Session ended by device") {
                    status = "Glasses stuck. Case them, close the lid ~30s, reopen, press START."
                } else {
                    status = "Failed to start: \(error)"
                }
            }
        }
    }

    private func nudgeRestart() {
        guard isLive, let s = stream else { return }
        if Date().timeIntervalSince(lastRestartAt) < 4 { status = "Buffering…"; return }
        lastRestartAt = Date()
        status = "Reconnecting…"
        s.start()
    }

    // Mirror the WebRTC link state and retry the connect if the viewer wasn't
    // open when we first joined.
    private func startStatusTimer() {
        statusTimer?.invalidate()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.rtcStatus = self.rtc.state.label
                if self.isLive, case .failed = self.rtc.state {
                    Task { [weak self] in await self?.rtc.connect(baseURL: Self.backendBase) }
                }
            }
        }
    }
}
