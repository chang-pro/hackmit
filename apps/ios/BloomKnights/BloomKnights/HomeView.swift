// HomeView.swift — sport picker, famous-moment cards, and the live
// model-vs-market comparison (polled every 5 s by ComparisonStore).

import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var store: ComparisonStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                sportPicker
                momentCards
                comparisonSection
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(BK.bg.ignoresSafeArea())
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "eye.fill")
                    .foregroundStyle(BK.accent)
                Text("BLOOMKNIGHTS")
                    .font(BK.display(22))
                    .tracking(2)
                    .foregroundStyle(BK.textPrimary)
            }
            Text("Look at the game. See the probability.")
                .font(BK.body(13))
                .foregroundStyle(BK.textSecondary)
        }
    }

    // MARK: - Sport picker

    private var sportPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Sport.allCases) { sport in
                    SportChip(sport: sport, isSelected: sport == store.sport) {
                        store.select(sport: sport)
                    }
                }
            }
        }
    }

    // MARK: - Moment cards

    private var momentCards: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("DEMO MOMENTS")
                .font(BK.caption(11))
                .tracking(1.5)
                .foregroundStyle(BK.textFaint)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(store.moments(for: store.sport)) { moment in
                        MomentCard(moment: moment, isSelected: moment == store.moment) {
                            store.select(moment: moment)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Comparison

    @ViewBuilder
    private var comparisonSection: some View {
        if let latest = store.latest {
            ComparisonCard(response: latest, lastUpdated: store.lastUpdated)
        } else if let error = store.errorText {
            BKCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "antenna.radiowaves.left.and.right.slash")
                            .foregroundStyle(BK.warn)
                        Text("Waiting for signal")
                            .font(BK.title(16))
                            .foregroundStyle(BK.textPrimary)
                    }
                    Text(error)
                        .font(BK.body(13))
                        .foregroundStyle(BK.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else {
            BKCard {
                HStack(spacing: 10) {
                    ProgressView().tint(BK.accent)
                    Text("Reading the game…")
                        .font(BK.body(14))
                        .foregroundStyle(BK.textSecondary)
                }
            }
        }
    }
}

// MARK: - Sport chip

private struct SportChip: View {
    let sport: Sport
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: sport.symbol)
                    .font(.system(size: 13, weight: .bold))
                Text(sport.label)
                    .font(BK.caption(13))
            }
            .foregroundStyle(isSelected ? Color.black : BK.textSecondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                Capsule().fill(isSelected ? BK.accent : BK.surface)
            )
            .overlay(
                Capsule().stroke(isSelected ? Color.clear : BK.stroke, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Moment card

private struct MomentCard: View {
    let moment: DemoMoment
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                Text(moment.title)
                    .font(BK.title(15))
                    .foregroundStyle(BK.textPrimary)
                    .lineLimit(1)
                Text(moment.subtitle)
                    .font(BK.body(12))
                    .foregroundStyle(BK.textSecondary)
                    .lineLimit(1)
            }
            .padding(14)
            .frame(width: 210, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(BK.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(isSelected ? BK.accent : BK.stroke, lineWidth: isSelected ? 1.5 : 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Comparison card

struct ComparisonCard: View {
    let response: ComparisonResponse
    let lastUpdated: Date?

    private var status: String { response.presentation?.status ?? "unknown" }

    private var statusColor: Color {
        switch status {
        case "ready": return BK.accent
        case "low_confidence": return BK.warn
        case "stale_market": return BK.danger
        default: return BK.textFaint
        }
    }

    private var statusLabel: String {
        switch status {
        case "ready": return "Live read"
        case "low_confidence": return "Low confidence"
        case "stale_market": return "Stale market"
        case "no_state": return "No state"
        default: return status
        }
    }

    private var periodPrefix: String {
        switch response.sport {
        case "ufc": return "R"          // rounds
        case "soccer": return "H"       // halves (ET shows as H3+)
        case "golf": return "Hole "
        default: return "Q"             // nba, football
        }
    }

    private var matchupTitle: String {
        let away = teamName(response.event?.awayTeamId)
        let home = teamName(response.event?.homeTeamId)
        if let away, let home { return "\(away) @ \(home)" }
        return "Live comparison"
    }

    private func teamName(_ teamId: String?) -> String? {
        guard let teamId else { return nil }
        // "nba_bos" -> "BOS"
        let parts = teamId.split(separator: "_")
        guard let last = parts.last else { return nil }
        return String(last).uppercased()
    }

    private func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return "\(Int((value * 100).rounded()))%"
    }

    var body: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 16) {
                // Status row
                HStack(spacing: 8) {
                    TagPill(text: statusLabel, color: statusColor)
                    if response.source == "fixture" {
                        TagPill(text: "Replay", color: BK.textSecondary)
                    } else if response.source == "live" {
                        TagPill(text: "Live frames", color: BK.accent)
                    }
                    Spacer()
                    if let lastUpdated {
                        Text(lastUpdated, style: .time)
                            .font(BK.caption(11))
                            .foregroundStyle(BK.textFaint)
                    }
                }

                // Matchup + game state
                VStack(alignment: .leading, spacing: 4) {
                    Text(matchupTitle)
                        .font(BK.title(18))
                        .foregroundStyle(BK.textPrimary)
                    if let state = response.state,
                       let away = state.awayScore, let home = state.homeScore,
                       let period = state.period, let clock = state.clockSeconds {
                        Text("\(periodPrefix)\(period) · \(clock / 60):\(String(format: "%02d", clock % 60)) · \(away)–\(home)")
                            .font(BK.body(13))
                            .foregroundStyle(BK.textSecondary)
                    }
                }

                // The big numbers
                HStack(alignment: .center, spacing: 0) {
                    probabilityColumn(label: "MODEL",
                                      value: response.comparison?.modelProbability,
                                      color: BK.accent)
                    gapBadge
                    probabilityColumn(label: "MARKET",
                                      value: response.comparison?.marketProbability,
                                      color: BK.textPrimary)
                }
                .frame(maxWidth: .infinity)

                confidenceBar

                if let shortText = response.presentation?.shortText {
                    Text(shortText)
                        .font(BK.body(13))
                        .foregroundStyle(BK.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let outcome = response.estimate?.outcome, let version = response.estimate?.modelVersion {
                    Text("\(outcome) · \(version)")
                        .font(BK.caption(10))
                        .foregroundStyle(BK.textFaint)
                }
            }
        }
    }

    private func probabilityColumn(label: String, value: Double?, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(BK.caption(11))
                .tracking(1.5)
                .foregroundStyle(BK.textFaint)
            Text(percent(value))
                .font(BK.display(44))
                .monospacedDigit()
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity)
    }

    private var gapBadge: some View {
        VStack(spacing: 2) {
            let gap = response.comparison?.gapPercentagePoints
            Text(gapText(gap))
                .font(BK.title(16))
                .monospacedDigit()
                .foregroundStyle(gapColor(gap))
            Text("GAP")
                .font(BK.caption(9))
                .tracking(1.5)
                .foregroundStyle(BK.textFaint)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(BK.surfaceRaised)
        )
    }

    private func gapText(_ gap: Double?) -> String {
        guard let gap else { return "—" }
        let sign = gap > 0 ? "+" : ""
        return "\(sign)\(String(format: "%.1f", gap))"
    }

    private func gapColor(_ gap: Double?) -> Color {
        guard let gap, gap != 0 else { return BK.textSecondary }
        return gap > 0 ? BK.accent : BK.warn
    }

    private var confidenceBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("STATE CONFIDENCE")
                    .font(BK.caption(10))
                    .tracking(1.5)
                    .foregroundStyle(BK.textFaint)
                Spacer()
                Text(percent(response.comparison?.stateConfidence ?? response.state?.confidence))
                    .font(BK.caption(11))
                    .monospacedDigit()
                    .foregroundStyle(BK.textSecondary)
            }
            GeometryReader { geo in
                let confidence = response.comparison?.stateConfidence ?? response.state?.confidence ?? 0
                ZStack(alignment: .leading) {
                    Capsule().fill(BK.surfaceRaised)
                    Capsule()
                        .fill(BK.accent)
                        .frame(width: max(0, min(1, confidence)) * geo.size.width)
                }
            }
            .frame(height: 6)
        }
    }
}
