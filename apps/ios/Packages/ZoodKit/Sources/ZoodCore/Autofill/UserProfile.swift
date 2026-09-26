import Foundation

/// The person's own details for form autofill. Kept only on this device (a file protected with
/// Data Protection "complete", excluded from backups); never sent anywhere.
public struct UserProfile: Codable, Sendable, Equatable {
    public var fullNameArabic = ""
    public var fullNameEnglish = ""
    /// National ID or Iqama number.
    public var nationalID = ""
    public var nationality = ""
    public var phone = ""
    public var email = ""
    public var address = ""
    public var city = ""
    public var postalCode = ""
    /// Gregorian date of birth as "yyyy-MM-dd" (the Hijri date is derived from it).
    public var dateOfBirth = ""
    public var employer = ""
    public var jobTitle = ""

    public init() {}

    enum CodingKeys: String, CodingKey {
        case fullNameArabic, fullNameEnglish, nationalID, nationality, phone, email, address, city, postalCode
        case dateOfBirth, employer, jobTitle
    }

    /// Missing keys read as empty, so older or newer files still load.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func s(_ k: CodingKeys) throws -> String { try c.decodeIfPresent(String.self, forKey: k) ?? "" }
        fullNameArabic = try s(.fullNameArabic)
        fullNameEnglish = try s(.fullNameEnglish)
        nationalID = try s(.nationalID)
        nationality = try s(.nationality)
        phone = try s(.phone)
        email = try s(.email)
        address = try s(.address)
        city = try s(.city)
        postalCode = try s(.postalCode)
        dateOfBirth = try s(.dateOfBirth)
        employer = try s(.employer)
        jobTitle = try s(.jobTitle)
    }

    public var isEmpty: Bool { ProfileKey.stored.allSatisfy { value(for: $0).isEmpty } }

    /// Parsed date of birth (noon UTC, so the calendar day is stable in any time zone).
    public var birthDate: Date? { Self.parseDate(dateOfBirth) }

    public static func parseDate(_ s: String) -> Date? {
        let parts = s.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var c = DateComponents()
        c.year = parts[0]
        c.month = parts[1]
        c.day = parts[2]
        c.hour = 12
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard let d = cal.date(from: c), cal.component(.day, from: d) == parts[2],
              cal.component(.month, from: d) == parts[1] else { return nil }
        return d
    }

    public static func formatDate(_ d: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The value proposed for a form field of this kind ("" when unknown). Dates use
    /// dd/MM/yyyy with Western digits, the usual form format in Saudi Arabia.
    public func value(for key: ProfileKey) -> String {
        let v: String
        switch key {
        case .fullNameArabic: v = fullNameArabic
        case .fullNameEnglish: v = fullNameEnglish
        case .firstNameArabic: v = Self.words(fullNameArabic).first ?? ""
        case .lastNameArabic: v = Self.words(fullNameArabic).count > 1 ? Self.words(fullNameArabic).last ?? "" : ""
        case .firstNameEnglish: v = Self.words(fullNameEnglish).first ?? ""
        case .lastNameEnglish: v = Self.words(fullNameEnglish).count > 1 ? Self.words(fullNameEnglish).last ?? "" : ""
        case .nationalID: v = nationalID
        case .nationality: v = nationality
        case .phone: v = phone
        case .email: v = email
        case .address: v = address
        case .city: v = city
        case .postalCode: v = postalCode
        case .dateOfBirthGregorian:
            v = birthDate.map { Self.dayMonthYear($0, calendar: Calendar(identifier: .gregorian)) } ?? ""
        case .dateOfBirthHijri:
            v = birthDate.map { Self.dayMonthYear($0, calendar: Calendar(identifier: .islamicUmmAlQura)) } ?? ""
        case .employer: v = employer
        case .jobTitle: v = jobTitle
        }
        return v.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func words(_ s: String) -> [String] {
        s.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    static func dayMonthYear(_ d: Date, calendar: Calendar) -> String {
        var cal = calendar
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%02d/%02d/%04d", c.day ?? 0, c.month ?? 0, c.year ?? 0)
    }

    /// Non-empty values, for the model prompt.
    public var filledKeys: [ProfileKey] { ProfileKey.allCases.filter { !value(for: $0).isEmpty } }
}

/// Profile values a form field can take (stored ones plus derived first/last names and dates).
public enum ProfileKey: String, CaseIterable, Sendable, Codable {
    case fullNameArabic, fullNameEnglish, firstNameArabic, lastNameArabic, firstNameEnglish, lastNameEnglish
    case nationalID, nationality, phone, email, address, city, postalCode
    case dateOfBirthGregorian, dateOfBirthHijri, employer, jobTitle

    /// Keys the person types in (the rest are derived).
    public static let stored: [ProfileKey] = [
        .fullNameArabic, .fullNameEnglish, .nationalID, .nationality, .phone, .email, .address, .city,
        .postalCode, .dateOfBirthGregorian, .employer, .jobTitle,
    ]
}

/// Saudi national ID (starts with 1) and Iqama (starts with 2): 10 digits with a Luhn check
/// digit. Used only to warn about a typo in the profile.
public enum SaudiID {
    public enum Kind: Equatable, Sendable { case citizen, resident }

    public static func kind(_ id: String) -> Kind? {
        let digits = SearchNormalizer.normalize(id).filter { !$0.isWhitespace }
        guard digits.count == 10, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        var sum = 0
        for (i, ch) in digits.enumerated() {
            let d = Int(String(ch))!
            if i % 2 == 0 {
                let x = d * 2
                sum += x / 10 + x % 10
            } else {
                sum += d
            }
        }
        guard sum % 10 == 0 else { return nil }
        switch digits.first {
        case "1": return .citizen
        case "2": return .resident
        default: return nil
        }
    }
}

/// Reads and writes the profile file. The app passes `protection: true` so iOS encrypts it with
/// the device passcode (Data Protection "complete"); it is also excluded from backups.
public struct ProfileStore: Sendable {
    public static let formatVersion = 1
    public let url: URL

    public init(directory: URL) {
        url = directory.appendingPathComponent("profile.json")
    }

    struct Envelope: Codable {
        let version: Int
        let profile: UserProfile
    }

    public enum StoreError: Error, Equatable {
        case unsupportedVersion(Int)
    }

    public static func encode(_ profile: UserProfile) throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return try e.encode(Envelope(version: formatVersion, profile: profile))
    }

    public static func decode(_ data: Data) throws -> UserProfile {
        let env = try JSONDecoder().decode(Envelope.self, from: data)
        guard env.version == formatVersion else { throw StoreError.unsupportedVersion(env.version) }
        return env.profile
    }

    public func load() -> UserProfile {
        guard let data = try? Data(contentsOf: url), let p = try? Self.decode(data) else { return UserProfile() }
        return p
    }

    public func save(_ profile: UserProfile) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if canImport(Darwin)
        try Self.encode(profile).write(to: url, options: [.atomic, .completeFileProtection])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var u = url
        try? u.setResourceValues(values)
        #else
        try Self.encode(profile).write(to: url, options: [.atomic])
        #endif
    }

    /// "Clear": the file is deleted (not just emptied).
    public func clear() throws {
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }
}
