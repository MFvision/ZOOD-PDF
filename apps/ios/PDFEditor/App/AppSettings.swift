import SwiftUI

/// The interface language: the system's, or Arabic or English chosen in
/// Settings. Chosen, it applies at once to every SwiftUI screen (the locale
/// and the reading direction in the environment) and, through
/// `AppleLanguages`, to the system's own pieces — alerts, the file
/// browser, PDFKit — from the next launch.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case arabic = "ar"
    case english = "en"

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .system: "System language"
        case .arabic: "العربية"
        case .english: "English"
        }
    }

    /// The locale SwiftUI localizes with; nil follows the system.
    var locale: Locale? {
        switch self {
        case .system: nil
        case .arabic: Locale(identifier: "ar")
        case .english: Locale(identifier: "en")
        }
    }

    var layoutDirection: LayoutDirection? {
        switch self {
        case .system: nil
        case .arabic: .rightToLeft
        case .english: .leftToRight
        }
    }

    /// Tells the system's frameworks, for the next launch.
    func applyToSystem() {
        let defaults = UserDefaults.standard
        switch self {
        case .system: defaults.removeObject(forKey: "AppleLanguages")
        case .arabic, .english: defaults.set([rawValue], forKey: "AppleLanguages")
        }
    }
}

enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .system: "System appearance"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// The keys in UserDefaults. A UI test sets them from the command line
/// (`-language ar -appearance dark`).
enum SettingsKey {
    static let language = "language"
    static let appearance = "appearance"
    /// The chrome's look — the system's, Liquid Glass, ZOOD's — from
    /// `AppTheme`. A UI test passes `-theme glass`.
    static let theme = "theme"
    // The scanner's own keys (`scanColorMode`, `ocrLanguages`) are its:
    // `PDFEditor/Scan/ScanSettingsSection.swift`.
    /// Face ID / Touch ID before the app shows anything; off by default.
    static let appLock = "appLock"
    /// Tabs or the classic stack on iPhone (`MenuStyle`).
    static let menuStyle = "menuStyle"
    /// The screen the app opens on (`StartScreen`).
    static let startScreen = "startScreen"
}

/// Applies the chosen language and appearance to a scene's root view.
struct AppEnvironment: ViewModifier {
    @AppStorage(SettingsKey.language) private var language: AppLanguage = .system
    @AppStorage(SettingsKey.appearance) private var appearance: AppAppearance = .system
    @AppStorage(SettingsKey.theme) private var theme: AppTheme = .standard
    @Environment(\.locale) private var systemLocale
    @Environment(\.layoutDirection) private var systemDirection

    func body(content: Content) -> some View {
        content
            // The accent is applied inside the theme, not over it: a
            // modifier put outside `.environment(\.appTheme, …)` would read
            // the theme that was there before, not the chosen one.
            .modifier(ThemeTint())
            // ZOOD's body face for every text that names none, on its theme.
            .modifier(ThemeTypeface())
            // The theme reaches every themed surface from here, and a change
            // to it cross-fades: nothing on screen travels, so Reduce Motion
            // takes nothing away.
            .environment(\.appTheme, theme)
            .environment(\.locale, language.locale ?? systemLocale)
            .environment(\.layoutDirection, language.layoutDirection ?? systemDirection)
            .preferredColorScheme(appearance.colorScheme)
            .animation(Motion.quick, value: theme)
            .onChange(of: language, initial: true) { _, chosen in chosen.applyToSystem() }
            .task { DebugLaunch.seedProfile() }
    }
}

extension View {
    func appEnvironment() -> some View {
        modifier(AppEnvironment())
    }
}
