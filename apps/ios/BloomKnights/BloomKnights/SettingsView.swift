// SettingsView.swift — backend base URL (AppStorage) + connection test.

import SwiftUI

struct SettingsView: View {
    @AppStorage(ApiClient.baseURLDefaultsKey) private var baseURL = ApiClient.defaultBaseURL
    @EnvironmentObject private var store: ComparisonStore

    @State private var testResult: String?
    @State private var testOk = false
    @State private var testing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                backendCard
                aboutCard
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
                Image(systemName: "gearshape.fill")
                    .foregroundStyle(BK.accent)
                Text("SETTINGS")
                    .font(BK.display(22))
                    .tracking(2)
                    .foregroundStyle(BK.textPrimary)
            }
        }
    }

    private var backendCard: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("BACKEND")
                    .font(BK.caption(11))
                    .tracking(1.5)
                    .foregroundStyle(BK.textFaint)

                TextField("http://192.168.1.20:3000", text: $baseURL)
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .foregroundStyle(BK.textPrimary)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(BK.surfaceRaised)
                    )

                Text("On a real iPhone, \"localhost\" is the phone itself. Use your computer's LAN IP, e.g. http://192.168.1.20:3000 (see the README).")
                    .font(BK.body(12))
                    .foregroundStyle(BK.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    runTest()
                } label: {
                    HStack {
                        if testing {
                            ProgressView().tint(Color.black)
                        } else {
                            Image(systemName: "bolt.fill")
                        }
                        Text("Test Connection")
                            .font(BK.title(15))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(BK.accent)
                    )
                    .foregroundStyle(Color.black)
                }
                .buttonStyle(.plain)
                .disabled(testing)

                if let testResult {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: testOk ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(testOk ? BK.accent : BK.danger)
                        Text(testResult)
                            .font(BK.body(13))
                            .foregroundStyle(BK.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private var aboutCard: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("ABOUT")
                    .font(BK.caption(11))
                    .tracking(1.5)
                    .foregroundStyle(BK.textFaint)
                Text("BloomKnights compares a model estimate against the market-implied probability for the game you're looking at. A displayed difference is a signal to inspect, not proof of profit.")
                    .font(BK.body(13))
                    .foregroundStyle(BK.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func runTest() {
        testing = true
        testResult = nil
        Task { @MainActor in
            defer { testing = false }
            do {
                let api = try ApiClient.fromSettings()
                // Test with a fixture the backend always knows.
                let result = try await api.comparison(sport: "nba", fixture: "frame_000184")
                testOk = true
                let text = result.presentation?.shortText ?? "Connected."
                testResult = "Connected — \(text)"
                await store.loadCatalog()
                await store.refresh()
            } catch {
                testOk = false
                testResult = (error as? ApiError)?.localizedDescription ?? error.localizedDescription
            }
        }
    }
}
