import NMCore
import SwiftUI
import UIKit

/// Values mirror shared/design/tokens.json.
enum Theme {
    static let navy = Color(hex: 0x1A4D6E)
    static let navyDeep = Color(hex: 0x0E2F45)
    static let navyNight = Color(hex: 0x081B29)
    static let gold = Color(hex: 0xD4A843)
    static let goldDeep = Color(hex: 0xB8922F)
    static let goldText = Color(hex: 0x8A6A1C)
    static let sand = Color(hex: 0xF4EEDF)
    static let solidSurface = Color(hex: 0x14232F)
    static let cardRadius: CGFloat = 26
    static let discSize: CGFloat = 76
    static let compactHeight: CGFloat = 64
    static let spring = Animation.spring(response: 0.42, dampingFraction: 0.86)

    /// On the sky everything is light-on-dark; gold reads well there.
    static func accentText(_ scheme: ColorScheme) -> Color { scheme == .dark ? gold : goldText }

    static func icon(_ e: PrayerEvent) -> String {
        switch e {
        case .fajr: return "sun.horizon"
        case .sunrise: return "sunrise"
        case .dhuhr: return "sun.max"
        case .asr: return "sun.min"
        case .maghrib: return "sunset"
        case .isha: return "moon.stars"
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}

// MARK: - Liquid Glass

/// Liquid Glass on iOS 26 (Xcode 26 SDK), tinted with the sky so white text stays legible; frosted
/// material with a specular rim before iOS 26; a solid surface when Reduce Transparency is on.
struct GlassSurface<S: Shape>: ViewModifier {
    let shape: S
    var tint: Color?
    var interactive = false
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(Theme.solidSurface, in: shape)
                .overlay(shape.stroke(Color.white.opacity(0.18), lineWidth: 1))
        } else {
            #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                content.glassEffect(Self.glass(tint: tint, interactive: interactive), in: shape)
            } else {
                fallback(content)
            }
            #else
            fallback(content)
            #endif
        }
    }

    #if compiler(>=6.2)
    @available(iOS 26.0, *)
    static func glass(tint: Color?, interactive: Bool) -> Glass {
        var g = Glass.regular
        if let tint { g = g.tint(tint) }
        if interactive { g = g.interactive() }
        return g
    }
    #endif

    private func fallback(_ content: Content) -> some View {
        content
            .background {
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    if let tint { shape.fill(tint) }
                }
            }
            .overlay(
                shape.stroke(LinearGradient(colors: [.white.opacity(0.5), .white.opacity(0.06), .white.opacity(0.2)],
                                            startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }
}

/// Glass card using the current sky's tint.
struct GlassCard: ViewModifier {
    var padding: CGFloat = 16
    var cornerRadius: CGFloat = Theme.cardRadius
    var tint: Color?
    @Environment(\.sky) private var sky

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(GlassSurface(shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous), tint: tint ?? sky.glassTint))
    }
}

/// Groups glass shapes so they blend and morph together on iOS 26.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content

    var body: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
        #else
        content
        #endif
    }
}

/// Capsule button for iOS 18–25, matching the glass button shapes of iOS 26.
struct FallbackGlassButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .foregroundStyle(prominent ? Theme.navyNight : .white)
            .background {
                if prominent { Capsule().fill(Theme.gold) } else { Capsule().fill(.ultraThinMaterial) }
            }
            .overlay(Capsule().stroke(.white.opacity(prominent ? 0.35 : 0.25), lineWidth: 1))
            .opacity(enabled ? 1 : 0.5)
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension View {
    func glass<S: Shape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, tint: tint, interactive: interactive))
    }

    func glassCard(padding: CGFloat = 16, cornerRadius: CGFloat = Theme.cardRadius, tint: Color? = nil) -> some View {
        modifier(GlassCard(padding: padding, cornerRadius: cornerRadius, tint: tint))
    }

    /// Kept for older call sites.
    func glassChrome(cornerRadius: CGFloat = 22) -> some View { glass(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)) }

    func card() -> some View { glassCard() }

    @ViewBuilder func glassButton() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { buttonStyle(.glass) } else { buttonStyle(FallbackGlassButtonStyle(prominent: false)) }
        #else
        buttonStyle(FallbackGlassButtonStyle(prominent: false))
        #endif
    }

    /// Gold prominent glass button with a dark label (white on gold is below 4.5:1).
    @ViewBuilder func prominentButton() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            buttonStyle(.glassProminent).tint(Theme.gold).foregroundStyle(Theme.navyNight)
        } else {
            buttonStyle(FallbackGlassButtonStyle(prominent: true))
        }
        #else
        buttonStyle(FallbackGlassButtonStyle(prominent: true))
        #endif
    }
}

/// Round glass icon button (44 pt target) used in custom headers.
struct GlassIconButton: View {
    let systemImage: String
    let label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glass(Circle())
        .accessibilityLabel(label)
    }
}

/// The brand disc on top of the Qibla arc; glows gold when the phone faces the Qibla.
struct LogoDisc: View {
    var size: CGFloat = Theme.discSize
    var glow: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        // The glow is a background so it never changes the disc's own size (a larger child in the
        // ZStack would make the circles grow with it).
        ZStack {
            Circle().fill(.white.opacity(0.94))
            Circle().stroke(glow ? Theme.gold : .white.opacity(0.7), lineWidth: glow ? 3 : 1.5)
            Image("LogoMark").resizable().scaledToFit().padding(size * 0.16)
        }
        .frame(width: size, height: size)
        .background {
            Circle()
                .fill(RadialGradient(colors: [Theme.gold.opacity(0.6), Theme.gold.opacity(0.25), .clear], center: .center, startRadius: 0, endRadius: size * 0.95))
                .frame(width: size * 1.9, height: size * 1.9)
                .scaleEffect(pulse ? 1.08 : 0.94)
                .opacity(glow ? 1 : 0)
        }
        .shadow(color: glow ? Theme.gold.opacity(0.7) : .black.opacity(0.25), radius: glow ? 22 : 10, y: glow ? 0 : 4)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.5), value: glow)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { pulse = true }
        }
        .accessibilityHidden(true)
    }
}
