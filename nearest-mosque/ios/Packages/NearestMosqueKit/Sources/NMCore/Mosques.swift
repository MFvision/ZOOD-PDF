import Foundation

public enum MosqueCategory: String, Codable, Sendable { case mosque, prayer_space }

/// Opening status is never assumed: without verified evidence it is unknown.
public enum OpenStatus: Sendable { case open, closed, unknown, stale }

public struct Mosque: Hashable, Identifiable, Sendable {
    public var id: String { sourceId }
    public let sourceId: String
    public let packId: String
    public let category: MosqueCategory
    public let names: [String: String]
    public let location: LatLng
    public let address: String?
    public let phone: String?
    public let website: String?
    public let openingHoursRaw: String?
    public let sourceTimestamp: String?

    public init(sourceId: String, packId: String, category: MosqueCategory, names: [String: String], location: LatLng,
                address: String? = nil, phone: String? = nil, website: String? = nil, openingHoursRaw: String? = nil, sourceTimestamp: String? = nil) {
        self.sourceId = sourceId; self.packId = packId; self.category = category; self.names = names; self.location = location
        self.address = address; self.phone = phone; self.website = website; self.openingHoursRaw = openingHoursRaw; self.sourceTimestamp = sourceTimestamp
    }

    public func displayName(_ lang: String) -> String? { names[lang] ?? names["default"] ?? names["en"] ?? names.values.sorted().first }

    /// opening_hours is shown verbatim and not interpreted yet, so status is unknown.
    public var openStatus: OpenStatus { .unknown }
}

public struct RankedMosque: Hashable, Identifiable, Sendable {
    public var id: String { mosque.sourceId }
    public let mosque: Mosque
    public let distanceMeters: Double
    public init(mosque: Mosque, distanceMeters: Double) { self.mosque = mosque; self.distanceMeters = distanceMeters }
}

/// One JSON line of a mosque pack (tools/build_mosque_pack.py).
public struct MosqueRecord: Codable, Sendable {
    public let sourceId: String
    public var category: String?
    public var names: [String: String]?
    public let lat: Double
    public let lng: Double
    public var address: String?
    public var phone: String?
    public var website: String?
    public var openingHoursRaw: String?
    public var sourceTimestamp: String?

    public func toMosque(packId: String) -> Mosque? {
        guard let loc = LatLng(lat, lng) else { return nil }
        return Mosque(sourceId: sourceId, packId: packId, category: category == "prayer_space" ? .prayer_space : .mosque,
                      names: names ?? [:], location: loc, address: address, phone: phone, website: website,
                      openingHoursRaw: openingHoursRaw, sourceTimestamp: sourceTimestamp)
    }
}

public enum MosqueRanking {
    public static let duplicateRadiusM = 40.0

    /// Exact distance, deterministic order (distance, then source id), duplicates removed.
    public static func rank(center: LatLng, candidates: [Mosque], radiusMeters: Double, limit: Int = 100) -> [RankedMosque] {
        var seen = Set<String>()
        let sorted = candidates.filter { seen.insert($0.sourceId).inserted }
            .map { RankedMosque(mosque: $0, distanceMeters: Geo.distanceMeters(center, $0.location)) }
            .filter { $0.distanceMeters <= radiusMeters }
            .sorted { ($0.distanceMeters, $0.mosque.sourceId) < ($1.distanceMeters, $1.mosque.sourceId) }
        var kept: [RankedMosque] = []
        for r in sorted {
            let key = nameKey(r.mosque)
            let dup = key != nil && kept.contains { nameKey($0.mosque) == key && Geo.distanceMeters($0.mosque.location, r.mosque.location) <= duplicateRadiusM }
            if !dup { kept.append(r) }
            if kept.count >= limit { break }
        }
        return kept
    }

    static func nameKey(_ m: Mosque) -> String? {
        guard let n = m.names["default"] else { return nil }
        let k = TextNormalizer.tokens(n).joined(separator: " ")
        return k.isEmpty ? nil : k
    }
}

/// Monotonic generation counter so an older, slower search can never replace a newer one.
public final class SearchGeneration: @unchecked Sendable {
    private var current = 0
    private let lock = NSLock()
    public init() {}
    public func next() -> Int { lock.lock(); defer { lock.unlock() }; current += 1; return current }
    public func isCurrent(_ g: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return g == current }
}
