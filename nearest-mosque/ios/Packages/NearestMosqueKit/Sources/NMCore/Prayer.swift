import Adhan
import Foundation

/// A calendar date in the prayer location's own time zone (never the phone's, unless they match).
public struct CivilDate: Hashable, Comparable, Codable, Sendable {
    public let year: Int, month: Int, day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year; self.month = month; self.day = day
    }

    public init?(iso: String) {
        let p = iso.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        self.init(year: p[0], month: p[1], day: p[2])
    }

    static let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    public static func of(_ instant: Date, in zone: TimeZone) -> CivilDate {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let c = cal.dateComponents([.year, .month, .day], from: instant)
        return CivilDate(year: c.year!, month: c.month!, day: c.day!)
    }

    public func adding(days: Int) -> CivilDate {
        let d = CivilDate.utc.date(from: DateComponents(year: year, month: month, day: day))!
        let n = CivilDate.utc.date(byAdding: .day, value: days, to: d)!
        let c = CivilDate.utc.dateComponents([.year, .month, .day], from: n)
        return CivilDate(year: c.year!, month: c.month!, day: c.day!)
    }

    public var components: DateComponents { DateComponents(year: year, month: month, day: day) }

    /// Noon UTC of this date, for date-only formatting and calendar conversion.
    public var noonUTC: Date { CivilDate.utc.date(from: DateComponents(year: year, month: month, day: day, hour: 12))! }

    public static func < (a: CivilDate, b: CivilDate) -> Bool { (a.year, a.month, a.day) < (b.year, b.month, b.day) }
}

public enum PrayerEvent: String, CaseIterable, Codable, Sendable {
    case fajr, sunrise, dhuhr, asr, maghrib, isha
    public var isPrayer: Bool { self != .sunrise }
    public static let prayers: [PrayerEvent] = allCases.filter(\.isPrayer)
}

/// Calculation conventions offered to the user; raw values match Kotlin and the fixtures.
public enum PrayerMethod: String, CaseIterable, Codable, Sendable {
    case MUSLIM_WORLD_LEAGUE, UMM_AL_QURA, EGYPTIAN, KARACHI, NORTH_AMERICA, DUBAI, KUWAIT, QATAR, SINGAPORE, TURKEY, MOON_SIGHTING_COMMITTEE

    var adhan: CalculationMethod {
        switch self {
        case .MUSLIM_WORLD_LEAGUE: return .muslimWorldLeague
        case .UMM_AL_QURA: return .ummAlQura
        case .EGYPTIAN: return .egyptian
        case .KARACHI: return .karachi
        case .NORTH_AMERICA: return .northAmerica
        case .DUBAI: return .dubai
        case .KUWAIT: return .kuwait
        case .QATAR: return .qatar
        case .SINGAPORE: return .singapore
        case .TURKEY: return .turkey
        case .MOON_SIGHTING_COMMITTEE: return .moonsightingCommittee
        }
    }
}

public enum AsrMadhab: String, Codable, Sendable { case SHAFI, HANAFI }
public enum HighLatRule: String, CaseIterable, Codable, Sendable { case AUTO, MIDDLE_OF_THE_NIGHT, SEVENTH_OF_THE_NIGHT, TWILIGHT_ANGLE }
/// What to do when the sun does not rise or set on a date (polar day/night).
public enum PolarRule: String, Codable, Sendable { case UNAVAILABLE, NEAREST_LATITUDE }

public struct PrayerSettings: Hashable, Codable, Sendable {
    public var method: PrayerMethod = .MUSLIM_WORLD_LEAGUE
    public var madhab: AsrMadhab = .SHAFI
    public var highLatitudeRule: HighLatRule = .AUTO
    public var polarRule: PolarRule = .UNAVAILABLE
    public var offsets: [PrayerEvent: Int] = [:]
    /// Umm al-Qura convention: Isha is 120 instead of 90 minutes after Maghrib in Ramadan.
    public var ramadanIshaExtension = true
    public var hijriAdjustmentDays = 0

    public init(method: PrayerMethod = .MUSLIM_WORLD_LEAGUE, madhab: AsrMadhab = .SHAFI, highLatitudeRule: HighLatRule = .AUTO, polarRule: PolarRule = .UNAVAILABLE) {
        self.method = method; self.madhab = madhab; self.highLatitudeRule = highLatitudeRule; self.polarRule = polarRule
    }
}

public enum ScheduleStatus: Equatable, Sendable {
    case normal
    /// Produced by the user-selected nearest-latitude rule, not the real latitude.
    case estimated(latitudeUsed: Double)
    /// The convention cannot produce times for this date; nothing is invented.
    case unavailable

    public var isEstimated: Bool { if case .estimated = self { return true } else { return false } }
}

public struct DaySchedule: Equatable, Sendable {
    public let date: CivilDate
    public let zone: TimeZone
    public let times: [PrayerEvent: Date]
    public let status: ScheduleStatus
    public let ramadanIshaApplied: Bool
    public subscript(_ e: PrayerEvent) -> Date? { times[e] }
}

public struct Upcoming: Equatable, Sendable {
    public let event: PrayerEvent
    public let at: Date
    public let periodStart: Date?
    public let isTomorrow: Bool
}

public struct PrayerCalculator: Sendable {
    /// Documented polar fallback latitude ("nearest latitude" rule), user-selected only.
    public static let nearestLatitude = 48.5

    public init() {}

    public func schedule(_ location: LatLng, date: CivilDate, zone: TimeZone, settings: PrayerSettings) -> DaySchedule {
        let ramadan = settings.method == .UMM_AL_QURA && settings.ramadanIshaExtension &&
            HijriCalendar.isRamadan(date, adjustmentDays: settings.hijriAdjustmentDays)
        if let real = compute(location.latitude, location.longitude, date, zone, settings, ramadan) {
            return DaySchedule(date: date, zone: zone, times: real, status: .normal, ramadanIshaApplied: ramadan)
        }
        if settings.polarRule == .NEAREST_LATITUDE, abs(location.latitude) > Self.nearestLatitude {
            let lat = location.latitude > 0 ? Self.nearestLatitude : -Self.nearestLatitude
            if let est = compute(lat, location.longitude, date, zone, settings, ramadan) {
                return DaySchedule(date: date, zone: zone, times: est, status: .estimated(latitudeUsed: lat), ramadanIshaApplied: ramadan)
            }
        }
        return DaySchedule(date: date, zone: zone, times: [:], status: .unavailable, ramadanIshaApplied: ramadan)
    }

    public func nextPrayer(_ location: LatLng, now: Date, zone: TimeZone, settings: PrayerSettings) -> Upcoming? {
        let today = CivilDate.of(now, in: zone)
        return nextPrayer((-1...1).map { schedule(location, date: today.adding(days: $0), zone: zone, settings: settings) }, now: now)
    }

    /// Next prayer from consecutive days (sunrise is never a prayer; after Isha it is tomorrow's Fajr).
    public func nextPrayer(_ days: [DaySchedule], now: Date) -> Upcoming? {
        guard let zone = days.first?.zone else { return nil }
        let today = CivilDate.of(now, in: zone)
        let prayers = days.flatMap { d in PrayerEvent.prayers.compactMap { e in d[e].map { (e, $0, d.date) } } }
            .sorted { $0.1 < $1.1 }
        guard let idx = prayers.firstIndex(where: { $0.1 > now }) else { return nil }
        let (event, at, date) = prayers[idx]
        return Upcoming(event: event, at: at, periodStart: idx > 0 ? prayers[idx - 1].1 : nil, isTomorrow: date > today)
    }

    public func fajrEndsAt(_ s: DaySchedule, now: Date) -> Date? {
        guard let fajr = s[.fajr], let sunrise = s[.sunrise] else { return nil }
        return now >= fajr && now < sunrise ? sunrise : nil
    }

    public static func remaining(_ now: Date, _ target: Date) -> TimeInterval { max(0, target.timeIntervalSince(now)) }

    /// Suggest a method for a country (ISO 3166 alpha-2). Language is never a convention.
    public static func suggestedMethod(_ countryCode: String?) -> PrayerMethod {
        switch countryCode?.uppercased() {
        case "SA", "YE": return .UMM_AL_QURA
        case "AE": return .DUBAI
        case "KW": return .KUWAIT
        case "QA", "BH": return .QATAR
        case "EG", "SD", "LY", "SY", "LB", "IQ", "JO", "PS": return .EGYPTIAN
        case "PK", "IN", "BD", "AF": return .KARACHI
        case "US", "CA": return .NORTH_AMERICA
        case "SG", "MY", "ID", "BN": return .SINGAPORE
        case "TR": return .TURKEY
        default: return .MUSLIM_WORLD_LEAGUE
        }
    }

    private func compute(_ lat: Double, _ lng: Double, _ date: CivilDate, _ zone: TimeZone, _ s: PrayerSettings, _ ramadan: Bool) -> [PrayerEvent: Date]? {
        // Adhan resolves the date on the solar (UTC-anchored) day; far from the solar offset (Apia,
        // Kiritimati) the result can land on the neighbouring civil date, so try adjacent dates.
        for shift in [0, -1, 1] {
            guard let t = adhan(lat, lng, date.adding(days: shift), s, ramadan), let dhuhr = t[.dhuhr] else { continue }
            if CivilDate.of(dhuhr, in: zone) == date { return t }
        }
        return nil
    }

    private func adhan(_ lat: Double, _ lng: Double, _ date: CivilDate, _ s: PrayerSettings, _ ramadan: Bool) -> [PrayerEvent: Date]? {
        var p = s.method.adhan.params
        p.madhab = s.madhab == .HANAFI ? .hanafi : .shafi
        switch s.highLatitudeRule {
        case .AUTO: p.highLatitudeRule = nil
        case .MIDDLE_OF_THE_NIGHT: p.highLatitudeRule = .middleOfTheNight
        case .SEVENTH_OF_THE_NIGHT: p.highLatitudeRule = .seventhOfTheNight
        case .TWILIGHT_ANGLE: p.highLatitudeRule = .twilightAngle
        }
        if ramadan && p.ishaInterval > 0 { p.ishaInterval += 30 }
        let o = s.offsets
        p.adjustments = PrayerAdjustments(
            fajr: o[.fajr] ?? 0, sunrise: o[.sunrise] ?? 0, dhuhr: o[.dhuhr] ?? 0,
            asr: o[.asr] ?? 0, maghrib: o[.maghrib] ?? 0, isha: o[.isha] ?? 0
        )
        guard let pt = PrayerTimes(coordinates: Coordinates(latitude: lat, longitude: lng), date: date.components, calculationParameters: p) else { return nil }
        return [.fajr: pt.fajr, .sunrise: pt.sunrise, .dhuhr: pt.dhuhr, .asr: pt.asr, .maghrib: pt.maghrib, .isha: pt.isha]
    }
}

/// Umm al-Qura Hijri calendar with a user adjustment of -2...2 days.
public enum HijriCalendar {
    public struct HijriDate: Equatable, Sendable { public let year, month, day: Int }

    static let calendar: Calendar = {
        var c = Calendar(identifier: .islamicUmmAlQura)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    public static func of(_ date: CivilDate, adjustmentDays: Int) -> HijriDate? {
        let d = date.adding(days: adjustmentDays).noonUTC
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        guard let y = c.year, let m = c.month, let dd = c.day else { return nil }
        return HijriDate(year: y, month: m, day: dd)
    }

    public static func isRamadan(_ date: CivilDate, adjustmentDays: Int) -> Bool { of(date, adjustmentDays: adjustmentDays)?.month == 9 }
}
