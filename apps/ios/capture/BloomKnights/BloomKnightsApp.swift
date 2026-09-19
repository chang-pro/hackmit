import SwiftUI
import MWDATCore

@main
struct BloomKnightsApp: App {
    init() {
        do {
            try Wearables.configure()
        } catch {
            print("DAT SDK config failed: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { url in
                    Task {
                        try? await Wearables.shared.handleUrl(url)
                    }
                }
        }
    }
}
