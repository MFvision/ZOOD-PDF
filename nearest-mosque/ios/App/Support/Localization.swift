import SwiftUI

/// Interface language: the device's ordered preference (which already reflects the per-app choice in
/// iOS Settings) or a persistent in-app override. Strings come from the compiled String Catalog of
/// the chosen language, so switching works offline and immediately.
@Observable
final class Localization {
    static let supported = ["en", "ar", "ur", "tr", "id", "fr", "es"]
    static let nativeNames: [String: String] = [
        "en": "English", "ar": "العربية", "ur": "اردو", "tr": "Türkçe", "id": "Bahasa Indonesia", "fr": "Français", "es": "Español",
    ]
    private static let key = "languageOverride"

    /// nil = use device language.
    var override: String? {
        didSet {
            UserDefaults.standard.set(override, forKey: Self.key)
            reload()
        }
    }
    private(set) var language: String = "en"
    private(set) var bundle: Bundle = .main

    init() {
        override = UserDefaults.standard.string(forKey: Self.key)
        reload()
    }

    private func reload() {
        let device = Bundle.main.preferredLocalizations.first.map { Self.base($0) } ?? "en"
        let lang = override ?? (Self.supported.contains(device) ? device : Self.bestMatch() ?? "en")
        language = lang
        bundle = Bundle.main.path(forResource: lang, ofType: "lproj").flatMap(Bundle.init(path:)) ?? .main
    }

    /// First supported language in the user's ordered preferences.
    private static func bestMatch() -> String? {
        Locale.preferredLanguages.map(base).first(where: supported.contains)
    }

    static func base(_ id: String) -> String {
        let b = String(id.split(separator: "-").first ?? Substring(id))
        return b == "in" ? "id" : b
    }

    var locale: Locale { Locale(identifier: language) }
    var isRTL: Bool { language == "ar" || language == "ur" }
    var layoutDirection: LayoutDirection { isRTL ? .rightToLeft : .leftToRight }

    func t(_ key: String) -> String { bundle.localizedString(forKey: key, value: nil, table: nil) }

    func t(_ key: String, _ args: CVarArg...) -> String {
        String(format: t(key), locale: locale, arguments: args)
    }

    /// Plural-aware lookup (String Catalog variations) with localized digits.
    func plural(_ key: String, _ count: Int) -> String {
        let format = bundle.localizedString(forKey: key, value: nil, table: nil)
        // The interface locale selects the plural category (Arabic has six).
        let s = String(format: format, locale: locale, count)
        return s.replacingOccurrences(of: String(count), with: count.formatted(.number.locale(locale)))
    }
}
