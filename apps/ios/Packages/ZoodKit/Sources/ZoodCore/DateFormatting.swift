import Foundation

/// Gregorian + Hijri (Umm al-Qura) dates for recents, page marks and scan names.
/// Numerals follow the given locale (e.g. `ar-SA` gives ١٤٤٥, `en` gives 1445).
public enum DateFormatting {
    public struct HijriDay: Equatable, Sendable {
        public let year: Int
        public let month: Int
        public let day: Int
    }

    public static func hijriCalendar(timeZone: TimeZone) -> Calendar {
        var cal = Calendar(identifier: .islamicUmmAlQura)
        cal.timeZone = timeZone
        return cal
    }

    public static func hijriDay(_ date: Date, timeZone: TimeZone = .current) -> HijriDay {
        let c = hijriCalendar(timeZone: timeZone).dateComponents([.year, .month, .day], from: date)
        return HijriDay(year: c.year ?? 0, month: c.month ?? 0, day: c.day ?? 0)
    }

    /// "1 Ramadan 1445 AH" / "١ رمضان ١٤٤٥ هـ".
    public static func hijri(_ date: Date, locale: Locale, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        var cal = hijriCalendar(timeZone: timeZone)
        cal.locale = locale
        f.calendar = cal
        f.locale = locale
        f.timeZone = timeZone
        f.dateStyle = .long
        f.timeStyle = .none
        return f.string(from: date)
    }

    /// "11 March 2024" / "١١ مارس ٢٠٢٤".
    public static func gregorian(_ date: Date, locale: Locale, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        var cal = Calendar(identifier: .gregorian)
        cal.locale = locale
        cal.timeZone = timeZone
        f.calendar = cal
        f.locale = locale
        f.timeZone = timeZone
        f.dateStyle = .long
        f.timeStyle = .none
        return f.string(from: date)
    }

    /// Both calendars, the way recents show them: "11 March 2024 · 1 Ramadan 1445 AH".
    public static func both(_ date: Date, locale: Locale, timeZone: TimeZone = .current) -> String {
        "\(gregorian(date, locale: locale, timeZone: timeZone)) · \(hijri(date, locale: locale, timeZone: timeZone))"
    }

    /// Locale-aware integer (Arabic-Indic digits in Arabic locales that use them).
    public static func number(_ n: Int, locale: Locale) -> String {
        let f = NumberFormatter()
        f.locale = locale
        f.numberStyle = .decimal
        f.usesGroupingSeparator = false
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }
}
