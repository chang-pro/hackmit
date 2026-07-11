// BloomKnightsApp.swift — app entry point and tab root.
// Owns the shared ComparisonStore (5 s polling) and the Speaker, and wires
// auto-speak so a new spoken line is voiced no matter which tab is open.

import SwiftUI
import UIKit

@main
struct BloomKnightsApp: App {
    @StateObject private var store = ComparisonStore()
    @StateObject private var speaker = Speaker()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(speaker)
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: ComparisonStore
    @EnvironmentObject private var speaker: Speaker
    @AppStorage("autoSpeak") private var autoSpeak = false
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Dark, premium tab bar.
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(red: 0.04, green: 0.04, blue: 0.06, alpha: 1.0)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "bolt.fill") }
            GlassesView()
                .tabItem { Label("Glasses", systemImage: "eyeglasses") }
            SpeakView()
                .tabItem { Label("Speak", systemImage: "waveform") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .tint(BK.accent)
        .onAppear { store.startPolling() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: store.startPolling()
            case .background: store.stopPolling()
            default: break
            }
        }
        .onChange(of: store.latest?.presentation?.spokenText) { _, newText in
            if autoSpeak, let text = newText, !text.isEmpty {
                speaker.speakIfNew(text)
            }
        }
    }
}
