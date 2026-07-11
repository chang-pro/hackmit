// BloomKnightsApp.swift — BARE-BONES glasses connector.
// One full-screen job: Meta Ray-Ban stream in -> WebRTC out to the desktop
// viewer (pair code from the /capture page). No tabs, no dashboard.

import AVFoundation
import SwiftUI
import UIKit

@main
struct BloomKnightsApp: App {
    var body: some Scene {
        WindowGroup {
            ConnectorView()
                .preferredColorScheme(.dark)
                .statusBarHidden()
        }
    }
}

#if canImport(MWDATCore) && canImport(MWDATCamera)

struct ConnectorView: View {
    @StateObject private var glasses = GlassesStreamer()
    #if canImport(WebRTC)
    @StateObject private var rtc = RTCPublisher()
    #endif
    @AppStorage("apiBaseURL") private var apiBaseURL = "http://localhost:3000"
    @AppStorage("pairCode") private var pairCode = ""
    @State private var showControls = true
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            // FULL-SCREEN live glasses view — edge to edge, always.
            FullScreenPreview(layer: glasses.preview.layer)
                .ignoresSafeArea()
                .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { showControls.toggle() } }

            if !glasses.isRunning {
                VStack(spacing: 10) {
                    Image(systemName: "eyeglasses")
                        .font(.system(size: 44))
                        .foregroundStyle(Color(red: 0.71, green: 1.0, blue: 0.22))
                    Text(glasses.status)
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white.opacity(0.9))
                        .padding(.horizontal, 32)
                }
            }

            if showControls { controls }
        }
        .background(Color.black)
        .task { glasses.monitor() }
        .onChange(of: scenePhase) { _, phase in
            // Locking / backgrounding kills the SDK capture — tear down honestly.
            if phase == .background && glasses.isBusy { stopEverything() }
        }
    }

    private var controls: some View {
        VStack {
            // Top status strip
            HStack(spacing: 8) {
                statusChip(glasses.isStreaming ? "GLASSES LIVE" : "GLASSES OFF",
                           on: glasses.isStreaming)
                #if canImport(WebRTC)
                statusChip(rtc.state.label.uppercased(), on: rtc.state == .connected)
                #endif
                Spacer()
                Text(glasses.frameSize)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            Spacer()

            // Bottom control card
            VStack(spacing: 10) {
                HStack(spacing: 8) {
                    TextField("Server URL", text: $apiBaseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("PAIR CODE", text: $pairCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .frame(width: 110)
                        .font(.system(.body, design: .monospaced).weight(.bold))
                }
                .textFieldStyle(.plain)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 12).fill(.white.opacity(0.08)))
                .foregroundStyle(.white)

                Button(action: toggle) {
                    Text(glasses.isBusy ? "STOP" : "CONNECT")
                        .font(.system(.headline, design: .rounded).weight(.heavy))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(
                            RoundedRectangle(cornerRadius: 14)
                                .fill(glasses.isBusy ? Color.red.opacity(0.85)
                                                     : Color(red: 0.71, green: 1.0, blue: 0.22))
                        )
                        .foregroundStyle(glasses.isBusy ? .white : .black)
                }
                .buttonStyle(.plain)

                if !glasses.lastError.isEmpty {
                    Text(glasses.lastError)
                        .font(.caption2)
                        .foregroundStyle(.red.opacity(0.9))
                        .lineLimit(2)
                }
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 20).fill(.black.opacity(0.55)))
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        }
    }

    private func statusChip(_ text: String, on: Bool) -> some View {
        HStack(spacing: 5) {
            Circle().fill(on ? Color(red: 0.71, green: 1.0, blue: 0.22) : .gray)
                .frame(width: 7, height: 7)
            Text(text)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.85))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule().fill(.black.opacity(0.55)))
    }

    private func toggle() {
        if glasses.isBusy { stopEverything(); return }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                        to: nil, from: nil, for: nil)
        glasses.start()
        #if canImport(WebRTC)
        // Every decoded frame -> WebRTC track.
        let publisher = rtc
        glasses.setFrameTap { buffer in publisher.push(buffer) }
        if let base = URL(string: apiBaseURL.trimmingCharacters(in: .whitespaces)),
           !pairCode.trimmingCharacters(in: .whitespaces).isEmpty {
            Task { await rtc.connect(baseURL: base, pairCode: pairCode.trimmingCharacters(in: .whitespaces).uppercased()) }
        }
        #endif
    }

    private func stopEverything() {
        glasses.setFrameTap(nil)
        glasses.stop()
        #if canImport(WebRTC)
        rtc.disconnect()
        #endif
    }
}

// Edge-to-edge host for the streamer's AVSampleBufferDisplayLayer.
struct FullScreenPreview: UIViewRepresentable {
    let layer: AVSampleBufferDisplayLayer

    final class HostView: UIView {
        let display: AVSampleBufferDisplayLayer
        init(display: AVSampleBufferDisplayLayer) {
            self.display = display
            super.init(frame: .zero)
            backgroundColor = .black
            display.videoGravity = .resizeAspectFill   // FULL SCREEN, no letterbox
            layer.addSublayer(display)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func layoutSubviews() { super.layoutSubviews(); display.frame = bounds }
    }

    func makeUIView(context: Context) -> HostView { HostView(display: layer) }
    func updateUIView(_ uiView: HostView, context: Context) {}
}

#else

// No-SDK build (hand-written project without xcodegen): explain, don't crash.
struct ConnectorView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "eyeglasses").font(.system(size: 44))
            Text("Glasses SDK not linked")
                .font(.headline)
            Text("Run `xcodegen` in apps/ios/BloomKnights on the Mac, then rebuild. That pulls in the Meta Wearables SDK and WebRTC.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 30)
        }
    }
}

#endif
