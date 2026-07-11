// Theme.swift — BloomKnights design system.
// Near-black background, one electric volt accent, bold rounded type.

import SwiftUI

enum BK {
    // Palette
    static let bg = Color(hex: 0x0A0A0F)          // near-black
    static let surface = Color(hex: 0x15151E)     // card
    static let surfaceRaised = Color(hex: 0x1D1D2A)
    static let stroke = Color.white.opacity(0.08)
    static let accent = Color(hex: 0xB4FF39)      // electric volt
    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.55)
    static let textFaint = Color.white.opacity(0.32)
    static let warn = Color(hex: 0xFFB02E)
    static let danger = Color(hex: 0xFF4D5E)

    // Type
    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .heavy, design: .rounded)
    }
    static func title(_ size: CGFloat) -> Font {
        .system(size: size, weight: .bold, design: .rounded)
    }
    static func body(_ size: CGFloat) -> Font {
        .system(size: size, weight: .medium, design: .rounded)
    }
    static func caption(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold, design: .rounded)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1.0
        )
    }
}

// Shared card container.
struct BKCard<Content: View>: View {
    var content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(BK.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(BK.stroke, lineWidth: 1)
                    )
            )
    }
}

// Sent/accepted/skipped/failed counters — shared by both Glasses sources
// (Meta SDK stream and phone camera) so the numbers read identically.
struct FrameCountersCard: View {
    let sent: Int
    let accepted: Int
    let skipped: Int
    let failed: Int
    var footnote: String? = nil

    var body: some View {
        BKCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("FRAME STREAM")
                    .font(BK.caption(11))
                    .tracking(1.5)
                    .foregroundStyle(BK.textFaint)

                HStack(spacing: 0) {
                    counter(label: "SENT", value: sent, color: BK.textPrimary)
                    counter(label: "ACCEPTED", value: accepted, color: BK.accent)
                    counter(label: "SKIPPED", value: skipped, color: BK.warn)
                    counter(label: "FAILED", value: failed, color: BK.danger)
                }

                if let footnote {
                    Text(footnote)
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

// Small uppercase tag pill (REPLAY / MOCK / status).
struct TagPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .tracking(1.2)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(color.opacity(0.14)))
            .overlay(Capsule().stroke(color.opacity(0.35), lineWidth: 1))
    }
}
