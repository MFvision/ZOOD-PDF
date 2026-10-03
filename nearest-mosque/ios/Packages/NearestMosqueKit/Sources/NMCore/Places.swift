import Foundation

public struct City: Hashable, Identifiable, Sendable {
    public let id: Int
    public let name: String
    public let asciiName: String
    public let arabicNames: [String]
    public let countryCode: String
    public let location: LatLng
    public let zoneId: String
    public let population: Int

    /// For ar/ur interfaces a name written entirely in Arabic script (romanized mixtures such as
    /// "kېp ټawn" are skipped), preferring spellings without Persian/Urdu letters for Arabic and with
    /// them for Urdu; otherwise the Latin name.
    public func displayName(_ lang: String) -> String {
        guard lang == "ar" || lang == "ur" else { return name }
        let clean = arabicNames.filter(City.isPureArabicScript)
        let urduStyle = clean.filter { $0.contains(where: { City.urduLetters.contains($0) }) }
        let arabicStyle = clean.filter { !urduStyle.contains($0) }
        return (lang == "ar" ? arabicStyle + urduStyle : urduStyle + arabicStyle).first ?? name
    }

    static let urduLetters: Set<Character> = Set("پچژگکیٹڈڑںےۃھ")

    static func isPureArabicScript(_ s: String) -> Bool {
        let letters = s.unicodeScalars.filter { CharacterSet.letters.contains($0) }
        return !letters.isEmpty && letters.allSatisfy { (0x0600...0x06FF).contains($0.value) || (0x0750...0x077F).contains($0.value) || (0xFB50...0xFEFF).contains($0.value) }
    }
}

/// Offline city search over the bundled GeoNames list (sorted by population).
public final class CityIndex: @unchecked Sendable {
    public let cities: [City]
    private let keys: [[String]]

    public init(_ cities: [City]) {
        self.cities = cities
        self.keys = cities.map { c in Array(Set(([c.name, c.asciiName] + c.arabicNames).map(TextNormalizer.foldForPrefix))) }
    }

    public static func parse(_ tsv: String) -> CityIndex {
        CityIndex(tsv.split(separator: "\n").compactMap { line in
            let c = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard c.count >= 9, let id = Int(c[0]), let lat = Double(c[5]), let lng = Double(c[6]), let loc = LatLng(lat, lng) else { return nil }
            return City(id: id, name: c[1], asciiName: c[2], arabicNames: c[3].split(separator: "|").map(String.init),
                        countryCode: c[4], location: loc, zoneId: c[7], population: Int(c[8]) ?? 0)
        })
    }

    public func search(_ query: String, limit: Int = 30) -> [City] {
        let q = TextNormalizer.foldForPrefix(query)
        if q.isEmpty { return Array(cities.prefix(limit)) }
        var prefix: [City] = [], contains: [City] = []
        for (i, k) in keys.enumerated() {
            if k.contains(where: { $0.hasPrefix(q) }) { prefix.append(cities[i]) }
            else if q.count >= 3, k.contains(where: { $0.contains(q) }) { contains.append(cities[i]) }
            if prefix.count >= limit { break }
        }
        return Array((prefix + contains).prefix(limit))
    }

    public func nearest(_ p: LatLng) -> (City, Double)? {
        cities.map { ($0, Geo.distanceMeters(p, $0.location)) }.min { $0.1 < $1.1 }
    }
}

public struct ZoneSuggestion: Sendable {
    public let zone: TimeZone
    public let nearestCity: City?
    public let distanceMeters: Double?
    public let needsConfirmation: Bool
}

/// Time zone for a device fix. The phone's own zone (set by the network) is the authority whenever it
/// is consistent with the location: same rules as the nearest bundled city, far from any city, or in
/// a border band where the nearest city can be on the wrong side. Only when the phone is clearly set
/// to another zone than a city within 30 km is the city's zone used, with a confirmation.
public struct TimeZoneResolver: Sendable {
    public let cities: CityIndex
    public var borderBandMeters = 30_000.0
    public init(_ cities: CityIndex) { self.cities = cities }

    public func resolve(_ p: LatLng, deviceZone: TimeZone?) -> ZoneSuggestion {
        guard let (city, d) = cities.nearest(p), let cityZone = TimeZone(identifier: city.zoneId) else {
            return ZoneSuggestion(zone: deviceZone ?? TimeZone(identifier: "UTC")!, nearestCity: nil, distanceMeters: nil, needsConfirmation: deviceZone == nil)
        }
        guard let device = deviceZone else {
            return ZoneSuggestion(zone: cityZone, nearestCity: city, distanceMeters: d, needsConfirmation: d > borderBandMeters)
        }
        if Self.sameRules(cityZone, device) || d > borderBandMeters {
            return ZoneSuggestion(zone: device, nearestCity: city, distanceMeters: d, needsConfirmation: false)
        }
        return ZoneSuggestion(zone: cityZone, nearestCity: city, distanceMeters: d, needsConfirmation: true)
    }

    /// Same identifier, or the same offsets now and at both solstices of this year (covers aliases).
    static func sameRules(_ a: TimeZone, _ b: TimeZone, now: Date = Date()) -> Bool {
        if a.identifier == b.identifier { return true }
        let year = Calendar(identifier: .gregorian).component(.year, from: now)
        let probes = [now] + [1, 7].compactMap { DateComponents(calendar: Calendar(identifier: .gregorian), timeZone: TimeZone(identifier: "UTC"), year: year, month: $0, day: 15).date }
        return probes.allSatisfy { a.secondsFromGMT(for: $0) == b.secondsFromGMT(for: $0) }
    }
}
