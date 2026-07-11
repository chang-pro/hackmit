// RTCPublisher.swift — publishes the glasses' decoded video frames to the
// BloomKnights server's WebRTC signaling (the same contract phone.html uses):
//   POST /api/webrtc/join   {pair_code}            -> {session_id}
//   GET  /api/webrtc/config?session_id=            -> {ice_servers, ice_transport_policy}
//   POST /api/webrtc/signal {session_id, from:"phone", kind, payload}
//   GET  /api/webrtc/poll?session_id=&peer=phone   -> {signals:[{kind,payload}]}
// The phone is the OFFERER; the desktop viewer answers. Media flows
// peer-to-peer (STUN/TURN) — the tunnel only ever carries signaling.
//
// Compiles only when the WebRTC package (stasel/WebRTC) is linked via the
// xcodegen project; the hand-written no-SDK project skips it.

#if canImport(WebRTC)

import CoreMedia
import CoreVideo
import Foundation
import WebRTC

@MainActor
final class RTCPublisher: NSObject, ObservableObject {
    enum State: Equatable {
        case idle
        case joining
        case negotiating
        case connected
        case failed(String)

        var label: String {
            switch self {
            case .idle: return "RTC idle"
            case .joining: return "Joining…"
            case .negotiating: return "Negotiating…"
            case .connected: return "LIVE → viewer"
            case .failed(let why): return "RTC failed: \(why)"
            }
        }
    }

    @Published var state: State = .idle
    @Published var framesPushed = 0

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()

    private var peerConnection: RTCPeerConnection?
    // Written only on main (connect/disconnect); read from the SDK decode
    // thread in push(). WebRTC's capturer path is thread-safe by design.
    private nonisolated(unsafe) var videoSource: RTCVideoSource?
    private var videoTrack: RTCVideoTrack?
    private nonisolated(unsafe) let capturer = RTCVideoCapturer()
    private var baseURL: URL?
    private var sessionId: String?
    private var pollTask: Task<Void, Never>?
    private var pendingRemoteIce: [[String: Any]] = []
    private var haveRemoteDescription = false
    // Frame push happens on the SDK decode thread; count on main in batches.
    private nonisolated(unsafe) var pushCounter = 0

    // MARK: - HTTP signaling

    private func api(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let baseURL else { throw URLError(.badURL) }
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var endpoint = baseURL.appendingPathComponent(String(parts[0]))
        if parts.count == 2 {
            guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
                throw URLError(.badURL)
            }
            components.percentEncodedQuery = String(parts[1])
            guard let url = components.url else { throw URLError(.badURL) }
            endpoint = url
        }
        var req = URLRequest(url: endpoint)
        req.httpMethod = method
        req.timeoutInterval = 15
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw NSError(domain: "rtc", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: (json["error"] as? String) ?? "HTTP \(http.statusCode)"])
        }
        return json
    }

    private func sendSignal(kind: String, payload: Any) async {
        guard let sessionId else { return }
        _ = try? await api("api/webrtc/signal", method: "POST", body: [
            "session_id": sessionId, "from": "phone", "kind": kind, "payload": payload,
        ])
    }

    // MARK: - Connect / disconnect

    // Empty pairCode = one-button mode: ask the server for the newest open
    // pairing session (created by the desktop /capture page) and join it.
    func connect(baseURL: URL, pairCode: String) async {
        disconnect()
        self.baseURL = baseURL
        state = .joining
        do {
            var code = pairCode
            if code.isEmpty {
                let hint = try await api("api/webrtc/pair-hint")
                guard let hinted = hint["pair_code"] as? String else {
                    throw NSError(domain: "rtc", code: 3,
                                  userInfo: [NSLocalizedDescriptionKey: "no open session — open /capture on the desktop"])
                }
                code = hinted
            }
            let joined = try await api("api/webrtc/join", method: "POST", body: ["pair_code": code])
            guard let sid = joined["session_id"] as? String else {
                throw NSError(domain: "rtc", code: 1, userInfo: [NSLocalizedDescriptionKey: "join returned no session_id"])
            }
            sessionId = sid

            let cfg = try await api("api/webrtc/config?session_id=\(sid)")
            let rtcConfig = RTCConfiguration()
            rtcConfig.sdpSemantics = .unifiedPlan
            if let servers = cfg["ice_servers"] as? [[String: Any]] {
                rtcConfig.iceServers = servers.compactMap { server in
                    let urls: [String]
                    if let list = server["urls"] as? [String] { urls = list }
                    else if let one = server["urls"] as? String { urls = [one] }
                    else { return nil }
                    return RTCIceServer(urlStrings: urls,
                                        username: server["username"] as? String,
                                        credential: server["credential"] as? String)
                }
            }
            if (cfg["ice_transport_policy"] as? String) == "relay" { rtcConfig.iceTransportPolicy = .relay }

            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let pc = Self.factory.peerConnection(with: rtcConfig, constraints: constraints, delegate: self) else {
                throw NSError(domain: "rtc", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not create peer connection"])
            }
            peerConnection = pc

            let source = Self.factory.videoSource()
            videoSource = source
            let track = Self.factory.videoTrack(with: source, trackId: "glasses-video0")
            videoTrack = track
            pc.add(track, streamIds: ["glasses"])

            state = .negotiating
            let offer = try await pc.offer(for: RTCMediaConstraints(
                mandatoryConstraints: ["OfferToReceiveVideo": "false", "OfferToReceiveAudio": "false"],
                optionalConstraints: nil))
            try await pc.setLocalDescription(offer)
            await sendSignal(kind: "offer", payload: ["type": "offer", "sdp": offer.sdp])
            startPolling()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func disconnect() {
        pollTask?.cancel(); pollTask = nil
        // Capture ids now — they're nilled below before the Task runs.
        if let sid = sessionId, let base = baseURL {
            Task {
                var req = URLRequest(url: base.appendingPathComponent("api/webrtc/signal"))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try? JSONSerialization.data(withJSONObject: [
                    "session_id": sid, "from": "phone", "kind": "hangup", "payload": [String: String](),
                ])
                _ = try? await URLSession.shared.data(for: req)
            }
        }
        peerConnection?.close(); peerConnection = nil
        videoTrack = nil; videoSource = nil
        sessionId = nil
        pendingRemoteIce = []
        haveRemoteDescription = false
        state = .idle
    }

    // MARK: - Signal polling (answer + remote ICE)

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled, self.sessionId != nil {
                await self.pollOnce()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func pollOnce() async {
        guard let sessionId else { return }
        guard let data = try? await api("api/webrtc/poll?session_id=\(sessionId)&peer=phone"),
              let signals = data["signals"] as? [[String: Any]] else { return }
        for signal in signals {
            let kind = signal["kind"] as? String
            if kind == "hangup" {
                disconnect()
                state = .failed("viewer hung up")
                return
            }
            if kind == "answer", let payload = signal["payload"] as? [String: Any],
               let sdp = payload["sdp"] as? String {
                let answer = RTCSessionDescription(type: .answer, sdp: sdp)
                try? await peerConnection?.setRemoteDescription(answer)
                haveRemoteDescription = true
                for ice in pendingRemoteIce { addRemoteIce(ice) }
                pendingRemoteIce = []
            }
            if kind == "ice", let payload = signal["payload"] as? [String: Any] {
                if haveRemoteDescription { addRemoteIce(payload) } else { pendingRemoteIce.append(payload) }
            }
        }
    }

    private func addRemoteIce(_ json: [String: Any]) {
        guard let sdp = json["candidate"] as? String else { return }
        let candidate = RTCIceCandidate(
            sdp: sdp,
            sdpMLineIndex: Int32(json["sdpMLineIndex"] as? Int ?? 0),
            sdpMid: json["sdpMid"] as? String
        )
        peerConnection?.add(candidate) { _ in }
    }

    // MARK: - Frame input (called from the SDK decode thread)

    nonisolated func push(_ imageBuffer: CVImageBuffer) {
        guard let source = videoSource else { return }
        let rtcBuffer = RTCCVPixelBuffer(pixelBuffer: imageBuffer)
        let timeNs = Int64(CACurrentMediaTime() * 1_000_000_000)
        let frame = RTCVideoFrame(buffer: rtcBuffer, rotation: ._0, timeStampNs: timeNs)
        source.capturer(capturer, didCapture: frame)
        pushCounter += 1
        if pushCounter % 24 == 0 {
            let count = pushCounter
            Task { @MainActor [weak self] in self?.framesPushed = count }
        }
    }
}

extension RTCPublisher: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let payload: [String: Any] = [
            "candidate": candidate.sdp,
            "sdpMLineIndex": Int(candidate.sdpMLineIndex),
            "sdpMid": candidate.sdpMid ?? "0",
        ]
        Task { @MainActor [weak self] in await self?.sendSignal(kind: "ice", payload: payload) }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            switch newState {
            case .connected: self.state = .connected
            case .failed: self.state = .failed("no route (TURN needed?)")
            case .disconnected: if self.state == .connected { self.state = .negotiating }
            default: break
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

#endif // canImport(WebRTC)
