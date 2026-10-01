import Foundation
import Security

/// The details form autofill starts from — a name in Arabic and English, a
/// national ID or Iqama number, phone, email, address, employer, date of
/// birth, IBAN — every one optional. They are personal data: kept in the
/// Keychain, protected by the device's passcode, never written to a file,
/// never logged, and never leave the device (the on-device model reads them
/// in the app's own process).
public struct Profile: Codable, Equatable, Sendable {
    public var nameArabic = ""
    public var nameEnglish = ""
    public var nationalID = ""
    public var phone = ""
    public var email = ""
    public var address = ""
    public var employer = ""
    public var dateOfBirth = ""
    public var iban = ""

    public init() {}

    /// Any detail left out reads as empty: a profile kept by an older
    /// build, or written by hand, has only the keys it has.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: ProfileKey.self)
        for key in ProfileKey.allCases {
            self[key] = try container.decodeIfPresent(String.self, forKey: key) ?? ""
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: ProfileKey.self)
        for key in ProfileKey.allCases {
            try container.encode(self[key], forKey: key)
        }
    }

    public var isEmpty: Bool {
        ProfileKey.allCases.allSatisfy { value($0).isEmpty }
    }

    /// The value of a key, trimmed: what fills a field.
    public func value(_ key: ProfileKey) -> String {
        self[key].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The value of a key as typed.
    public subscript(key: ProfileKey) -> String {
        get {
            switch key {
            case .nameArabic: nameArabic
            case .nameEnglish: nameEnglish
            case .nationalID: nationalID
            case .phone: phone
            case .email: email
            case .address: address
            case .employer: employer
            case .dateOfBirth: dateOfBirth
            case .iban: iban
            }
        }
        set {
            switch key {
            case .nameArabic: nameArabic = newValue
            case .nameEnglish: nameEnglish = newValue
            case .nationalID: nationalID = newValue
            case .phone: phone = newValue
            case .email: email = newValue
            case .address: address = newValue
            case .employer: employer = newValue
            case .dateOfBirth: dateOfBirth = newValue
            case .iban: iban = newValue
            }
        }
    }

    /// The keys that hold something, in the profile's order.
    public var filledKeys: [ProfileKey] {
        ProfileKey.allCases.filter { !value($0).isEmpty }
    }
}

/// One detail of the profile. The raw value is what the model is asked to
/// answer with: it names a detail, never writes one, so nothing can be
/// invented.
public enum ProfileKey: String, Codable, CaseIterable, Sendable, Identifiable, CodingKey {
    case nameArabic
    case nameEnglish
    case nationalID
    case phone
    case email
    case address
    case employer
    case dateOfBirth
    case iban

    public var id: String { rawValue }

    /// What the detail is, in English, for the model's prompt.
    public var promptDescription: String {
        switch self {
        case .nameArabic: "the person's full name written in Arabic"
        case .nameEnglish: "the person's full name written in English"
        case .nationalID: "the national ID or Iqama (residence permit) number"
        case .phone: "the mobile phone number"
        case .email: "the email address"
        case .address: "the postal address"
        case .employer: "the employer or company name"
        case .dateOfBirth: "the date of birth"
        case .iban: "the bank IBAN"
        }
    }
}

/// The profile in the Keychain: one generic-password item for the app,
/// readable only while the device is unlocked and never moved to another
/// device (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`). `service`
/// separates a test's item from the app's.
public struct ProfileStore: Sendable {
    public let service: String
    private static let account = "profile"

    public init(service: String = "app.warraq.ios.profile") {
        self.service = service
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
    }

    /// The profile, or an empty one when none is kept (or the item cannot
    /// be read: it is only a convenience).
    public func load() -> Profile {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return Profile() }
        return (try? JSONDecoder().decode(Profile.self, from: data)) ?? Profile()
    }

    /// Keeps the profile; an empty one removes the item.
    public func save(_ profile: Profile) throws {
        if profile.isEmpty {
            try delete()
            return
        }
        let data = try JSONEncoder().encode(profile)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecItemNotFound {
            var add = query
            add.merge(attributes) { _, new in new }
            let status = SecItemAdd(add as CFDictionary, nil)
            guard status == errSecSuccess else { throw ProfileStoreError.keychain(status) }
        } else if update != errSecSuccess {
            throw ProfileStoreError.keychain(update)
        }
    }

    /// Removes the profile from the Keychain.
    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ProfileStoreError.keychain(status)
        }
    }
}

public enum ProfileStoreError: Error, Equatable {
    case keychain(OSStatus)
}
