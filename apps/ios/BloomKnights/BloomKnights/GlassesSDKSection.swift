// GlassesSDKSection.swift — UI for the REAL Meta Ray-Ban stream (MWDAT SDK).
// Only compiles when the SDK is linked (xcodegen project); the no-SDK
// fallback project shows a "regenerate with xcodegen" card instead.

#if canImport(MWDATCore) && canImport(MWDATCamera)

import AVFoundation
import SwiftUI
import UIKit

// Hosts the streamer's AVSampleBufferDisplayLayer so SwiftUI can show the
// live (decoded) hvc1 preview. The layer is owned by the streamer's PreviewSink.
struct SampleBufferPreview: UIViewRepresentable {
    let layer: AVSampleBufferDisplayLayer
    func makeUIView(context: Context) -> HostView { HostView(display: layer) }
    func updateUIView(_ uiView: HostView, context: Context) {}

    final class HostView: UIView {
        let display: AVSampleBufferDisplayLayer
        init(display: AVSampleBufferDisplayLayer) {
            self.display = display
            super.init(frame: .zero)
            backgroundColor = .black
            display.videoGravity = .resizeAspect
            layer.addSublayer(display)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func layoutSubviews() { super.layoutSubviews(); display.frame = bounds }
    }
}

struct GlassesSDKSection: View {
    @EnvironmentObject private var store: ComparisonStore
    @StateObject private var streamer = GlassesStreamer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            previewBlock
            statusCard
            FrameCountersCard(sent: streamer.sent,
                              accepted: streamer.accepted,
                              skipped: streamer.skipped,
                              failed: streamer.failed,
                              footnote: "video \(streamer.frameSize) · time \(streamer.elapsed)")
            startStopButton
            takePictureButton
            if !streamer.lastError.isEmpty {
                Text(streamer.lastError)
                    .font(BK.caption(11))
                    .foregroundStyle(BK.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { streamer.monitor() }
        .onAppear { streamer.updateSport(store.sport.rawValue) }
        .onChange(of: store.sport) { _, newSport in
            streamer.updateSport(newSport.rawValue)
        }
        // If the phone locks / app backgrounds while streaming, iOS + Meta
        // will kill the capture — tear down NOW so state stays honest. Ignore
        // transient .inactive (Control Center, banners, Siri): those must NOT
        // stop a live capture.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background && streamer.isBusy {
                streamer.stop()
            }
        }
    }

    private var previewBlock: some View {
        ZStack {
            Group {
                if let image = streamer.latestFrame {
                    Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                } else {
                    Color.black
                }
            }
                .frame(height: 260)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(streamer.isRunning ? BK.accent.opacity(0.5) : BK.stroke, lineWidth: 1)
                )
            if !streamer.isRunning {
                Text("Put the glasses on,\nthen press START")
                    .font(BK.body(14))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(BK.textSecondary)
            }
        }
    }

    private var statusCard: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    TagPill(text: streamer.isStreaming ? "Streaming" : "Idle",
                            color: streamer.isStreaming ? BK.accent : BK.textFaint)
                    TagPill(text: "rayban_sdk", color: BK.textSecondary)
                }
                Text(streamer.status)
                    .font(BK.title(14))
                    .foregroundStyle(BK.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(streamer.deviceInfo)
                    .font(BK.caption(11))
                    .foregroundStyle(BK.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Registration: \(streamer.regState)")
                    .font(BK.caption(10))
                    .foregroundStyle(BK.textFaint)
            }
        }
    }

    // Only meaningful while the stream is live: capturePhoto() needs an active
    // camera. Hidden rather than disabled when idle, so the idle screen stays
    // a single obvious action.
    @ViewBuilder private var takePictureButton: some View {
        if streamer.isStreaming {
            VStack(spacing: 6) {
                Button {
                    streamer.takePicture()
                } label: {
                    HStack {
                        Image(systemName: "camera.fill")
                        Text("Take Picture").font(BK.title(16))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(BK.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(BK.accent.opacity(0.6), lineWidth: 1)
                    )
                    .foregroundStyle(BK.accent)
                }
                .buttonStyle(.plain)

                if !streamer.photoStatus.isEmpty {
                    Text(streamer.photoStatus)
                        .font(BK.body(12))
                        .foregroundStyle(BK.textFaint)
                }
            }
        }
    }

    private var startStopButton: some View {
        Button {
            streamer.isBusy ? streamer.stop() : streamer.start()
        } label: {
            HStack {
                Image(systemName: streamer.isBusy ? "stop.fill" : "dot.radiowaves.left.and.right")
                Text(streamer.isBusy ? "Stop Glasses Stream" : "Start Glasses Stream")
                    .font(BK.title(16))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(streamer.isBusy ? BK.surface : BK.accent)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(streamer.isBusy ? BK.danger.opacity(0.6) : Color.clear, lineWidth: 1)
            )
            .foregroundStyle(streamer.isBusy ? BK.danger : Color.black)
        }
        .buttonStyle(.plain)
    }
}

#endif  // canImport(MWDATCore) && canImport(MWDATCamera)
