import SwiftUI
import AVFoundation

// Hosts the streamer's AVSampleBufferDisplayLayer so SwiftUI can show the live
// (decoded) hvc1 preview. The layer is owned by the streamer's PreviewSink.
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

struct ContentView: View {
    @StateObject private var streamer = GlassesStreamer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Text("BloomKnights")
                    .font(.largeTitle).bold()

                ZStack {
                    Group {
                        if let image = streamer.latestFrame {
                            Image(uiImage: image)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                        } else {
                            Color.black
                        }
                    }
                        .frame(height: 320)
                        .background(Color.black)
                        .cornerRadius(12)
                    if !streamer.isRunning {
                        Text("Put glasses on,\nthen press START")
                            .multilineTextAlignment(.center)
                            .foregroundColor(.gray)
                    }
                }

                Text(streamer.status)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                HStack(spacing: 16) {
                    Text("time \(streamer.elapsed)")
                    Text("video \(streamer.frameSize)")
                }
                .font(.footnote)
                .foregroundColor(.secondary)

                if !streamer.savedFile.isEmpty {
                    Text("Saved: \(streamer.savedFile)")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundColor(.secondary)
                }
                if !streamer.uploadStatus.isEmpty {
                    Text(streamer.uploadStatus)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundColor(streamer.uploadStatus.hasPrefix("Uploaded") ? .green : .orange)
                }
                if !streamer.uplinkStatus.isEmpty {
                    Text(streamer.uplinkStatus)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundColor(streamer.uplinkStatus.contains("fail 0") ? .green : .orange)
                }
                if !streamer.rtcStatus.isEmpty {
                    Text(streamer.rtcStatus)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundColor(streamer.rtcStatus.contains("LIVE") ? .green : .orange)
                }
                if !streamer.lastError.isEmpty {
                    Text(streamer.lastError)
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }
            .padding()
        }
        // Button is pinned to the bottom and always visible/tappable.
        .safeAreaInset(edge: .bottom) {
            Button(action: {
                streamer.isRunning ? streamer.stop() : streamer.start()
            }) {
                Text(streamer.isRunning ? "STOP" : "START")
                    .font(.system(size: 34, weight: .heavy))
                    .frame(maxWidth: .infinity)
                    .frame(height: 84)
                    .background(streamer.isRunning ? Color.red : Color.green)
                    .foregroundColor(.white)
                    .cornerRadius(18)
            }
            .padding(.horizontal)
            .padding(.bottom, 12)
            .background(.ultraThinMaterial)
        }
        .task { streamer.monitor() }
        // If the phone locks / app backgrounds while recording, iOS + Meta will
        // kill the capture — so finalize NOW to save a playable file of the
        // foreground portion instead of leaving a half-written, unplayable clip.
        .onChange(of: scenePhase) { _, phase in
            // Only finalize on real .background (lock / app-switch). Ignore transient
            // .inactive (Control Center, notification banners, Siri, call overlay) —
            // those must NOT tear down a live capture.
            if phase == .background && streamer.isBusy {
                streamer.stop()
            }
        }
    }
}
