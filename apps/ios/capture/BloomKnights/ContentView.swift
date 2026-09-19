// Barebones UI: one big START/STOP button + status. No video on the phone —
// the feed is watched on the website (/capture). The lightest possible screen.
import SwiftUI

struct ContentView: View {
    @StateObject private var streamer = GlassesStreamer()

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("BloomKnights")
                .font(.largeTitle).bold()

            Text(streamer.status)
                .font(.headline)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if !streamer.rtcStatus.isEmpty {
                Text(streamer.rtcStatus)
                    .font(.subheadline)
                    .foregroundColor(streamer.rtcStatus.contains("LIVE") ? .green : .orange)
            }

            Text("Watch the feed on the website")
                .font(.footnote)
                .foregroundColor(.secondary)

            Spacer()

            Button(action: {
                streamer.isLive ? streamer.stop() : streamer.start()
            }) {
                Text(streamer.isLive ? "STOP" : "START")
                    .font(.system(size: 36, weight: .heavy))
                    .frame(maxWidth: .infinity)
                    .frame(height: 92)
                    .background(streamer.isLive ? Color.red : Color.green)
                    .foregroundColor(.white)
                    .cornerRadius(20)
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .task { streamer.monitor() }
    }
}
