// Models.swift — Codable models matching the backend pipeline JSON exactly.
// Source of truth: services/api/pipeline.js (runPipeline return value) and
// services/api/server.js (POST /api/frames response).
// Decoding uses .convertFromSnakeCase, so `gap_percentage_points` maps to
// `gapPercentagePoints`, etc. Almost everything is optional because the
// gated "no_state" response carries only `presentation`.

import Foundation

// MARK: - GET /api/comparison

struct ComparisonResponse: Codable, Equatable {
    var sessionId: String?
    var sport: String?           // e.g. "nba"
    var source: String?          // "fixture" | "live"
    var extraction: String?      // "fixture_parse" until real OCR lands
    var event: EventInfo?
    var state: GameState?
    var estimate: Estimate?
    var market: MarketInfo?
    var comparison: Comparison?
    var presentation: Presentation?
}

struct EventInfo: Codable, Equatable {
    var eventId: String?
    var league: String?
    var awayTeamId: String?
    var homeTeamId: String?
    var scheduledStart: String?
}

struct GameState: Codable, Equatable {
    var awayScore: Int?
    var homeScore: Int?
    var period: Int?
    var clockSeconds: Int?
    var confidence: Double?
    var observedAt: String?
    var accepted: Bool?
    var rejectionReason: String?
}

struct Estimate: Codable, Equatable {
    var outcome: String?
    var probability: Double?
    var modelVersion: String?
}

struct MarketInfo: Codable, Equatable {
    var provider: String?
    var marketId: String?
    var probability: Double?
    var isMock: Bool?
    var providerTimestamp: String?
}

struct Comparison: Codable, Equatable {
    var eventId: String?
    var outcome: String?
    var modelProbability: Double?
    var marketProbability: Double?
    var gapPercentagePoints: Double?
    var direction: String?       // "model_higher" | "model_lower" | "aligned"
    var stateConfidence: Double?
    var freshnessMs: Double?
    var generatedAt: String?
}

struct Presentation: Codable, Equatable {
    var status: String?          // "ready" | "low_confidence" | "stale_market" | "no_state"
    var shortText: String?
    var spokenText: String?
    var reason: String?
}

// MARK: - POST /api/frames

struct FrameSubmission: Codable {
    var source: String           // "ios_app"
    var sport: String            // selected sport (forward-compat; server may ignore)
    var capturedAt: String       // ISO-8601
    var imageBase64: String
    var width: Int
    var height: Int
}

struct FrameSubmissionResponse: Codable {
    var frame: FrameMeta?
    var selection: FrameSelection?
}

struct FrameMeta: Codable {
    var frameId: String?
    var capturedAt: String?
    var source: String?
    var imageUri: String?
    var width: Int?
    var height: Int?
}

struct FrameSelection: Codable {
    var accepted: Bool?
    var reason: String?          // "rate_limited" | "near_duplicate" | null
}

// MARK: - GET /api/sports (catalog)

struct SportCatalogEntry: Codable {
    var id: String?
    var label: String?
    var league: String?
    var defaultFixture: String?
    var fixtures: [String]?
    var demoMoments: [CatalogMoment]?
}

struct CatalogMoment: Codable {
    var fixture: String?
    var label: String?
}

// MARK: - Error body

struct ApiErrorBody: Codable {
    var error: String?
}
