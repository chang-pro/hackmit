// GlassesView.swift — "Connect Meta Ray-Bans" flow.
// The phone is the bridge: point the iPhone at the screen showing the
// broadcast (or at a display mirroring the glasses stream). The camera
// samples ~1 frame/second and POSTs each to /api/frames.

import AVFoundation
import SwiftUI
import UIKit

struct GlassesView: View {
    @EnvironmentObject private var store: ComparisonStore
    @StateObject private var streamer = CameraStreamer()
    // Default to the real glasses stream; the phone camera stays as fallback.
    @State private var useSDK = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                sourcePicker
                if useSDK {
                    #if canImport(MWDATCore) && canImport(MWDATCamera)
                    GlassesSDKSection()
                    #else
                    sdkUnavailableCard
                    #endif
                } else if streamer.isRunning {
                    previewCard
                    countersCard
                } else {
                    connectCard
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(BK.bg.ignoresSafeArea())
        .onAppear {
            let sport = store.sport.rawValue
            streamer.sportProvider = { sport }
        }
        .onChange(of: store.sport) { _, newSport in
            let sport = newSport.rawValue
            streamer.sportProvider = { sport }
        }
        .onDisappear {
            streamer.stop()
        }
    }

    // MARK: - Source picker (Meta glasses SDK vs phone camera)

    private var sourcePicker: some View {
        HStack(spacing: 8) {
            sourceButton(title: "Meta glasses (SDK)", icon: "eyeglasses", selected: useSDK) {
                if !useSDK { streamer.stop() } // phone camera off before SDK mode
                useSDK = true
            }
            sourceButton(title: "Phone camera", icon: "camera.fill", selected: !useSDK) {
                useSDK = false
            }
        }
    }

    private func sourceButton(title: String, icon: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                Text(title).font(BK.title(13))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(selected ? BK.accent.opacity(0.16) : BK.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(selected ? BK.accent : BK.stroke, lineWidth: 1)
            )
            .foregroundStyle(selected ? BK.accent : BK.textSecondary)
        }
        .buttonStyle(.plain)
    }

    #if !(canImport(MWDATCore) && canImport(MWDATCamera))
    // Shown when the app was built from the hand-written no-SDK project.
    private var sdkUnavailableCard: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Glasses SDK not linked")
                    .font(BK.title(16))
                    .foregroundStyle(BK.textPrimary)
                Text("This build doesn't include the Meta Wearables Device Access Toolkit. On a Mac, run `xcodegen` in apps/ios/BloomKnights to regenerate the project with the SDK, then rebuild. Until then, use Phone camera mode.")
                    .font(BK.body(13))
                    .foregroundStyle(BK.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    #endif

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "eyeglasses")
                    .foregroundStyle(BK.accent)
                Text("GLASSES")
                    .font(BK.display(22))
                    .tracking(2)
                    .foregroundStyle(BK.textPrimary)
            }
            Text("Bridge the Ray-Ban view into the pipeline.")
                .font(BK.body(13))
                .foregroundStyle(BK.textSecondary)
        }
    }

    // MARK: - Connect flow

    private var connectCard: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 16) {
                Text("Connect Meta Ray-Bans")
                    .font(BK.title(18))
                    .foregroundStyle(BK.textPrimary)

                step(number: 1, text: "Put the game on a TV or laptop screen.")
                step(number: 2, text: "Point this iPhone at the screen — or mirror your glasses' live view onto a display and point at that.")
                step(number: 3, text: "Frames stream to the BloomKnights backend at ~1 fps for scoreboard reading.")

                if streamer.permissionDenied {
                    Text("Camera access is denied. Enable it in iOS Settings → BloomKnights → Camera.")
                        .font(BK.body(13))
                        .foregroundStyle(BK.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    streamer.start()
                } label: {
                    HStack {
                        Image(systemName: "dot.radiowaves.left.and.right")
                        Text("Start Capture")
                            .font(BK.title(16))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(BK.accent)
                    )
                    .foregroundStyle(Color.black)
                }
                .buttonStyle(.plain)

                Text("Frames are held in a small in-memory buffer server-side; nothing is written to disk.")
                    .font(BK.caption(11))
                    .foregroundStyle(BK.textFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func step(number: Int, text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(BK.title(13))
                .foregroundStyle(BK.accent)
                .frame(width: 24, height: 24)
                .background(Circle().fill(BK.accent.opacity(0.14)))
            Text(text)
                .font(BK.body(14))
                .foregroundStyle(BK.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Live capture

    private var previewCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            CameraPreview(session: streamer.session)
                .frame(height: 260)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(BK.accent.opacity(0.5), lineWidth: 1)
                )
                .overlay(alignment: .topLeading) {
                    TagPill(text: streamer.statusText, color: BK.accent)
                        .padding(10)
                }

            Button {
                streamer.stop()
            } label: {
                HStack {
                    Image(systemName: "stop.fill")
                    Text("Stop Capture")
                        .font(BK.title(15))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(BK.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(BK.danger.opacity(0.6), lineWidth: 1)
                )
                .foregroundStyle(BK.danger)
            }
            .buttonStyle(.plain)
        }
    }

    private var countersCard: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("FRAME STREAM")
                    .font(BK.caption(11))
                    .tracking(1.5)
                    .foregroundStyle(BK.textFaint)

                HStack(spacing: 0) {
                    counter(label: "SENT", value: streamer.sent, color: BK.textPrimary)
                    counter(label: "ACCEPTED", value: streamer.accepted, color: BK.accent)
                    counter(label: "SKIPPED", value: streamer.skipped, color: BK.warn)
                    counter(label: "FAILED", value: streamer.failed, color: BK.danger)
                }

                if let frameId = streamer.lastFrameId {
                    Text("Last frame: \(frameId)")
                        .font(BK.caption(11))
                        .monospacedDigit()
                        .foregroundStyle(BK.textFaint)
                }
            }
        }
    }

    private func counter(label: String, value: Int, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(BK.display(26))
                .monospacedDigit()
                .foregroundStyle(color)
            Text(label)
                .font(BK.caption(9))
                .tracking(1.2)
                .foregroundStyle(BK.textFaint)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Camera preview layer

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
