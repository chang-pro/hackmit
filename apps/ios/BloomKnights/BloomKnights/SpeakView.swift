// SpeakView.swift — reads the backend's presentation.spoken_text aloud,
// on demand or automatically whenever a new line arrives.

import SwiftUI

struct SpeakView: View {
    @EnvironmentObject private var store: ComparisonStore
    @EnvironmentObject private var speaker: Speaker
    @AppStorage("autoSpeak") private var autoSpeak = false

    private var spokenText: String? {
        store.latest?.presentation?.spokenText ?? store.latest?.presentation?.shortText
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                lineCard
                controls
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(BK.bg.ignoresSafeArea())
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "waveform")
                    .foregroundStyle(BK.accent)
                Text("SPEAK")
                    .font(BK.display(22))
                    .tracking(2)
                    .foregroundStyle(BK.textPrimary)
            }
            Text("Glasses-style audio: hear the read without looking away.")
                .font(BK.body(13))
                .foregroundStyle(BK.textSecondary)
        }
    }

    private var lineCard: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("CURRENT LINE")
                    .font(BK.caption(11))
                    .tracking(1.5)
                    .foregroundStyle(BK.textFaint)
                Text(spokenText ?? "Waiting for the first read from the backend…")
                    .font(BK.title(18))
                    .foregroundStyle(spokenText == nil ? BK.textSecondary : BK.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 14) {
            Button {
                if speaker.isSpeaking {
                    speaker.stop()
                } else if let text = spokenText {
                    speaker.speak(text)
                }
            } label: {
                HStack {
                    Image(systemName: speaker.isSpeaking ? "stop.fill" : "speaker.wave.2.fill")
                    Text(speaker.isSpeaking ? "Stop" : "Speak Latest")
                        .font(BK.title(16))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(spokenText == nil ? BK.surface : BK.accent)
                )
                .foregroundStyle(spokenText == nil ? BK.textFaint : Color.black)
            }
            .buttonStyle(.plain)
            .disabled(spokenText == nil && !speaker.isSpeaking)

            BKCard {
                Toggle(isOn: $autoSpeak) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Auto-speak")
                            .font(BK.title(15))
                            .foregroundStyle(BK.textPrimary)
                        Text("Say each new line as soon as it arrives.")
                            .font(BK.body(12))
                            .foregroundStyle(BK.textSecondary)
                    }
                }
                .tint(BK.accent)
            }
        }
    }
}
