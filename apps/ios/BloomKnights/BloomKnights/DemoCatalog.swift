// DemoCatalog.swift — the 5 supported sports and their famous demo moments,
// plus the shared observable store that polls GET /api/comparison every 5 s.
//
// The catalog is server-driven: at launch the store fetches GET /api/sports
// and builds each sport's demo moments from the backend's own registry, so
// fixture ids can never drift. The hardcoded fallback below mirrors the
// canonical ids (services/sports/*.js) and is used until the fetch succeeds
// or when the backend is unreachable/older.

import Foundation
import SwiftUI

enum Sport: String, CaseIterable, Identifiable {
    case nba, ufc, soccer, football, golf

    var id: String { rawValue }

    var label: String {
        switch self {
        case .nba: return "NBA"
        case .ufc: return "UFC"
        case .soccer: return "Soccer"
        case .football: return "Football"
        case .golf: return "Golf"
        }
    }

    var symbol: String {
        switch self {
        case .nba: return "basketball.fill"
        case .ufc: return "figure.boxing"
        case .soccer: return "soccerball"
        case .football: return "football.fill"
        case .golf: return "figure.golf"
        }
    }

    /// Curated card title per sport (the server's moment labels become subtitles).
    var eventTitle: String {
        switch self {
        case .nba: return "Celtics @ Knicks"
        case .ufc: return "UFC 229"
        case .soccer: return "2022 World Cup Final"
        case .football: return "Super Bowl LI"
        case .golf: return "2019 Masters"
        }
    }

    /// Offline fallback — canonical fixture ids, kept in sync with the backend.
    var fallbackMoments: [DemoMoment] {
        switch self {
        case .nba:
            return [
                DemoMoment(fixture: "frame_000184",
                           title: "Celtics @ Knicks",
                           subtitle: "Q4 2:14 · BOS 104–101 NYK"),
                DemoMoment(fixture: "frame_000260",
                           title: "Celtics @ Knicks",
                           subtitle: "Q4 0:30 · BOS 112–105 NYK"),
            ]
        case .ufc:
            return [
                DemoMoment(fixture: "ufc229_r2",
                           title: "UFC 229",
                           subtitle: "R2 3:30 · Khabib vs McGregor"),
                DemoMoment(fixture: "ufc229_r4",
                           title: "UFC 229",
                           subtitle: "R4 3:03 · the finish round"),
            ]
        case .soccer:
            return [
                DemoMoment(fixture: "wc22_final_60min",
                           title: "2022 World Cup Final",
                           subtitle: "60' · ARG 2–0 FRA"),
                DemoMoment(fixture: "wc22_final_118min",
                           title: "2022 World Cup Final",
                           subtitle: "118' (ET) · ARG 3–3 FRA"),
            ]
        case .football:
            return [
                DemoMoment(fixture: "sb51_q3_831",
                           title: "Super Bowl LI",
                           subtitle: "Q3 8:31 · ATL 28–3 NE (the hole)"),
                DemoMoment(fixture: "sb51_q4_057",
                           title: "Super Bowl LI",
                           subtitle: "Q4 0:57 · 28–28 (the comeback)"),
            ]
        case .golf:
            return [
                DemoMoment(fixture: "masters19_h12",
                           title: "2019 Masters",
                           subtitle: "Thru 12 · Tiger ties Molinari −11"),
                DemoMoment(fixture: "masters19_h16",
                           title: "2019 Masters",
                           subtitle: "Thru 16 · Tiger −14, two clear"),
            ]
        }
    }
}

struct DemoMoment: Identifiable, Equatable {
    var fixture: String
    var title: String
    var subtitle: String

    var id: String { fixture }
}

// MARK: - Live comparison store (poll every 5 s)

@MainActor
final class ComparisonStore: ObservableObject {
    @Published private(set) var sport: Sport = .nba
    @Published private(set) var moment: DemoMoment = Sport.nba.fallbackMoments[0]
    @Published private(set) var latest: ComparisonResponse?
    @Published private(set) var errorText: String?
    @Published private(set) var lastUpdated: Date?
    // Server-driven catalog (GET /api/sports), seeded with the offline fallback.
    @Published private(set) var momentsBySport: [Sport: [DemoMoment]] = {
        var map: [Sport: [DemoMoment]] = [:]
        for sport in Sport.allCases { map[sport] = sport.fallbackMoments }
        return map
    }()

    private var pollTask: Task<Void, Never>?
    private var catalogLoaded = false
    private static let pollIntervalNs: UInt64 = 5_000_000_000

    func moments(for sport: Sport) -> [DemoMoment] {
        momentsBySport[sport] ?? sport.fallbackMoments
    }

    /// Pulls the sport/fixture catalog from the backend so the app's demo
    /// moments always match the server's allowlist (ids can never drift).
    func loadCatalog() async {
        guard let api = try? ApiClient.fromSettings(),
              let entries = try? await api.sports() else { return }
        var map = momentsBySport
        for entry in entries {
            guard let id = entry.id, let sport = Sport(rawValue: id) else { continue }
            let moments = (entry.demoMoments ?? []).compactMap { m -> DemoMoment? in
                guard let fixture = m.fixture else { return nil }
                return DemoMoment(fixture: fixture,
                                  title: sport.eventTitle,
                                  subtitle: m.label ?? fixture)
            }
            if !moments.isEmpty { map[sport] = moments }
        }
        momentsBySport = map
        catalogLoaded = true
        // If the selected moment's fixture vanished from the server list,
        // snap to the sport's first live moment.
        let current = moments(for: sport)
        if !current.contains(where: { $0.fixture == moment.fixture }), let first = current.first {
            moment = first
            resetAndRefresh()
        }
    }

    func select(sport: Sport) {
        guard sport != self.sport else { return }
        self.sport = sport
        self.moment = moments(for: sport).first ?? sport.fallbackMoments[0]
        resetAndRefresh()
    }

    func select(moment: DemoMoment) {
        guard moment != self.moment else { return }
        self.moment = moment
        resetAndRefresh()
    }

    private func resetAndRefresh() {
        latest = nil
        errorText = nil
        Task { await refresh() }
    }

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            // First pass (and retry until it lands): sync the sport/fixture
            // catalog from the backend before/alongside comparison polling.
            while !Task.isCancelled {
                if let self, !self.catalogLoaded { await self.loadCatalog() }
                await self?.refresh()
                try? await Task.sleep(nanoseconds: ComparisonStore.pollIntervalNs)
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        do {
            let api = try ApiClient.fromSettings()
            let result = try await api.comparison(sport: sport.rawValue, fixture: moment.fixture)
            latest = result
            errorText = nil
            lastUpdated = Date()
        } catch {
            errorText = friendlyMessage(for: error)
        }
    }

    private func friendlyMessage(for error: Error) -> String {
        if case ApiError.server(let message) = error, message.contains("unknown fixture") {
            return "This moment's fixture isn't on the backend build you're running. Pull the latest backend or pick another moment."
        }
        if let apiError = error as? ApiError {
            return apiError.localizedDescription
        }
        if (error as? URLError) != nil {
            return "Can't reach the backend. Check the base URL in Settings and make sure `node services/api/server.js` is running on the same network."
        }
        return error.localizedDescription
    }
}
