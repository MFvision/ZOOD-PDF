import NMCore
import SwiftUI
import UIKit

/// Values mirror shared/design/tokens.json.
enum Theme {
    static let navy = Color(hex: 0x1A4D6E)
    static let navyDeep = Color(hex: 0x0E2F45)
    static let gold = Color(hex: 0xD4A843)
    static let goldDeep = Color(hex: 0xB8922F)
    static let goldText = Color(hex: 0x8A6A1C)
    static let sand = Color(hex: 0xF4EEDF)
    static let cardRadius: CGFloat = 20
    static let expandedHeader: CGFloat = 360
    static let homeHeader: CGFloat = 236
    static let compactHeader: CGFloat = 72

    /// Header sky for the prayer period in progress.
    static func sky(_ current: PrayerEvent?) -> [Color] {
        switch current {
        case .fajr: return [Color(hex: 0x1B2A4A), Color(hex: 0x5E3D56)]
        case .sunrise, .dhuhr: return [Color(hex: 0x1E4D6E), Color(hex: 0x285A7C)]
        case .asr: return [Color(hex: 0x2B5470), Color(hex: 0x5E4C24)]
        case .maghrib: return [Color(hex: 0x2A1B3D), Color(hex: 0x8A3A36)]
        case .isha: return [Color(hex: 0x0E2F45), Color(hex: 0x24476B)]
        case nil: return [Color(hex: 0x081B29), Color(hex: 0x1A4D6E)]
        }
    }

    static func accentText(_ scheme: ColorScheme) -> Color { scheme == .dark ? gold : goldText }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}

/// Liquid Glass on iOS 26 (Xcode 26 / Swift 6.2 SDK); readable standard materials before that, and
/// solid surfaces when Reduce Transparency is on. Used for floating controls only, never for content.
struct GlassChrome: ViewModifier {
    var cornerRadius: CGFloat = 22
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: cornerRadius))
        } else {
            #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                content.glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
            } else {
                content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
            }
            #else
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
            #endif
        }
    }
}

extension View {
    func glassChrome(cornerRadius: CGFloat = 22) -> some View { modifier(GlassChrome(cornerRadius: cornerRadius)) }

    /// Opaque content card (content surfaces stay legible; glass is for chrome).
    func card() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: Theme.cardRadius))
    }

    /// Prominent button: glass-prominent on iOS 26, bordered-prominent before.
    @ViewBuilder func prominentButton() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { buttonStyle(.glassProminent) } else { buttonStyle(.borderedProminent) }
        #else
        buttonStyle(.borderedProminent)
        #endif
    }
}
