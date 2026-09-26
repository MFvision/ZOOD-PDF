import SwiftUI

/// The ZOOD PDF look on iOS: system font, semantic colours, one blue accent (AccentColor asset),
/// translucent "glass" panels over a soft original gradient, springs only as touch feedback.
/// Reduce Motion, Reduce Transparency and Increase Contrast are honoured everywhere through the
/// modifiers below.
enum Theme {
    static let radiusSmall: CGFloat = 10
    static let radiusMedium: CGFloat = 16
    static let radiusLarge: CGFloat = 24
    static let spacing: CGFloat = 16

    /// Pastel tile colours for tool icons (hue per tool, like the web sidebar).
    static func tileColor(_ tool: ToolKind) -> Color {
        switch tool {
        case .open: Color(red: 0.36, green: 0.55, blue: 0.98)
        case .scan: Color(red: 0.20, green: 0.67, blue: 0.56)
        case .edit: Color(red: 0.93, green: 0.55, blue: 0.20)
        case .convert: Color(red: 0.56, green: 0.42, blue: 0.93)
        case .ai: Color(red: 0.84, green: 0.36, blue: 0.62)
        case .more: Color(red: 0.45, green: 0.50, blue: 0.58)
        case .organize: Color(red: 0.25, green: 0.60, blue: 0.90)
        case .combine: Color(red: 0.30, green: 0.70, blue: 0.40)
        case .compress: Color(red: 0.90, green: 0.40, blue: 0.35)
        case .protect: Color(red: 0.35, green: 0.40, blue: 0.80)
        case .readAloud: Color(red: 0.15, green: 0.62, blue: 0.75)
        case .fillForm: Color(red: 0.62, green: 0.48, blue: 0.20)
        }
    }
}

/// Glass panel: `.ultraThinMaterial` normally, an opaque grouped background with Reduce
/// Transparency, and a stronger outline with Increase Contrast.
struct GlassBackground: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    var cornerRadius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                if reduceTransparency {
                    shape.fill(Color(uiColor: .secondarySystemGroupedBackground))
                } else {
                    shape.fill(.ultraThinMaterial)
                }
            }
            .overlay {
                shape.strokeBorder(
                    contrast == .increased ? Color.primary.opacity(0.7) : Color.primary.opacity(0.08),
                    lineWidth: contrast == .increased ? 1.5 : 0.5)
            }
            .clipShape(shape)
    }
}

extension View {
    func glass(_ cornerRadius: CGFloat = Theme.radiusMedium) -> some View {
        modifier(GlassBackground(cornerRadius: cornerRadius))
    }
}

/// Original soft backdrop (blue / lilac / peach mesh). Plain system background when
/// transparency is reduced.
struct AppBackdrop: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if reduceTransparency {
            Color(uiColor: .systemGroupedBackground).ignoresSafeArea()
        } else {
            MeshGradient(
                width: 3, height: 3,
                points: [
                    [0, 0], [0.5, 0], [1, 0],
                    [0, 0.5], [0.55, 0.45], [1, 0.5],
                    [0, 1], [0.5, 1], [1, 1],
                ],
                colors: scheme == .dark ? darkColors : lightColors
            )
            .ignoresSafeArea()
        }
    }

    private var lightColors: [Color] {
        [
            Color(red: 0.90, green: 0.94, blue: 1.00), Color(red: 0.95, green: 0.93, blue: 1.00), Color(red: 1.00, green: 0.95, blue: 0.92),
            Color(red: 0.93, green: 0.96, blue: 1.00), Color(red: 0.97, green: 0.97, blue: 1.00), Color(red: 0.99, green: 0.94, blue: 0.96),
            Color(red: 0.94, green: 0.97, blue: 0.99), Color(red: 0.93, green: 0.94, blue: 1.00), Color(red: 0.96, green: 0.95, blue: 1.00),
        ]
    }

    private var darkColors: [Color] {
        [
            Color(red: 0.06, green: 0.08, blue: 0.16), Color(red: 0.09, green: 0.07, blue: 0.16), Color(red: 0.12, green: 0.08, blue: 0.10),
            Color(red: 0.05, green: 0.07, blue: 0.12), Color(red: 0.07, green: 0.07, blue: 0.11), Color(red: 0.10, green: 0.06, blue: 0.12),
            Color(red: 0.04, green: 0.06, blue: 0.10), Color(red: 0.06, green: 0.06, blue: 0.12), Color(red: 0.08, green: 0.06, blue: 0.12),
        ]
    }
}

/// Press feedback: a small spring scale, or an opacity change when Reduce Motion is on.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.7 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// Rounded pastel tile with an SF Symbol, used for tools and action cards.
struct ToolTile: View {
    let tool: ToolKind
    var size: CGFloat = 36

    var body: some View {
        Image(systemName: tool.symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Theme.tileColor(tool).gradient, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// HUD toast shown briefly at the top of a screen ("Saved", "Compressed 40%").
struct Toast: Equatable, Identifiable {
    let id = UUID()
    let message: String
    var isError = false
}

struct ToastOverlay: ViewModifier {
    @Binding var toast: Toast?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let toast {
                Label(toast.message, systemImage: toast.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .glass(Theme.radiusLarge)
                    .padding(.top, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .accessibilityAddTraits(.isStaticText)
                    .task(id: toast.id) {
                        AccessibilityNotification.Announcement(toast.message).post()
                        try? await Task.sleep(for: .seconds(2.5))
                        withAnimation(reduceMotion ? nil : .easeOut) { self.toast = nil }
                    }
            }
        }
    }
}

extension View {
    func toast(_ toast: Binding<Toast?>) -> some View {
        modifier(ToastOverlay(toast: toast))
    }
}
