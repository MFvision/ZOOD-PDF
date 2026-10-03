import Foundation
import NMCore

/// Locale-aware formatting; every number, time and date the user sees goes through here.
enum Format {
    static func prayerKey(_ e: PrayerEvent) -> String { "prayer_\(e.rawValue)" }
    static func methodKey(_ m: PrayerMethod) -> String { "method_\(m.rawValue)" }

    static func time(_ d: Date, zone: TimeZone, locale: Locale) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: Calendar(identifier: .gregorian), timeZone: zone)
        style.capitalizationContext = .standalone
        return d.formatted(style)
    }

    static func gregorian(_ d: CivilDate, locale: Locale) -> String {
        d.noonUTC.formatted(Date.FormatStyle(date: .complete, time: .omitted, locale: locale, calendar: Calendar(identifier: .gregorian), timeZone: TimeZone(identifier: "UTC")!))
    }

    static func hijri(_ d: CivilDate, adjustment: Int, locale: Locale) -> String {
        d.adding(days: adjustment).noonUTC.formatted(
            Date.FormatStyle(date: .long, time: .omitted, locale: locale, calendar: Calendar(identifier: .islamicUmmAlQura), timeZone: TimeZone(identifier: "UTC")!)
        )
    }

    /// H:MM:SS (M:SS under an hour), localized digits, derived from instants.
    static func countdown(_ seconds: TimeInterval, locale: Locale) -> String {
        let d = Duration.seconds(Int(max(0, seconds)))
        let pattern: Duration.TimeFormatStyle.Pattern = seconds >= 3600 ? .hourMinuteSecond : .minuteSecond
        return d.formatted(.time(pattern: pattern).locale(locale))
    }

    /// "50 min, 28 sec" style remaining time in the interface language (hours hidden when zero).
    static func remainingLong(_ seconds: TimeInterval, locale: Locale) -> String {
        Duration.seconds(Int(max(0, seconds)))
            .formatted(.units(allowed: [.hours, .minutes, .seconds], width: .abbreviated, maximumUnitCount: 3).locale(locale))
    }

    static func number(_ v: Double, digits: Int, locale: Locale) -> String {
        v.formatted(.number.precision(.fractionLength(digits)).locale(locale))
    }

    static func distance(_ meters: Double, l10n: Localization) -> String {
        if meters < 1000 {
            return l10n.t("distance_m", number((meters / 10).rounded() * 10, digits: 0, locale: l10n.locale))
        }
        return l10n.t("distance_km", number(meters / 1000, digits: meters < 10_000 ? 1 : 0, locale: l10n.locale))
    }

    static func degrees(_ d: Double, locale: Locale) -> String { number(d, digits: 0, locale: locale) }

    static func country(_ code: String, locale: Locale) -> String { locale.localizedString(forRegionCode: code) ?? code }

    static func zoneName(_ z: TimeZone, locale: Locale) -> String {
        (z.localizedName(for: .generic, locale: locale) ?? z.identifier) + " (" + z.identifier + ")"
    }
}
