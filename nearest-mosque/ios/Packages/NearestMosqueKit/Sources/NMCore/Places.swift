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

    /// An Arabic-script name for ar/ur interfaces when GeoNames has one.
    public func displayName(_ lang: String) -> String {
        (lang == "ar" || lang == "ur") ? (arabicNames.first ?? name) : name
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

/// Time zone for arbitrary coordinates from the nearest bundled city, flagged for confirmation when far.
public struct TimeZoneResolver: Sendable {
    public let cities: CityIndex
    public var confidentWithinMeters = 150_000.0
    public init(_ cities: CityIndex) { self.cities = cities }

    public func resolve(_ p: LatLng, deviceZone: TimeZone?) -> ZoneSuggestion {
        guard let (city, d) = cities.nearest(p), let zone = TimeZone(identifier: city.zoneId) else {
            return ZoneSuggestion(zone: deviceZone ?? TimeZone(identifier: "UTC")!, nearestCity: nil, distanceMeters: nil, needsConfirmation: true)
        }
        let far = d > confidentWithinMeters
        let disagrees = deviceZone.map { $0.identifier != zone.identifier && $0.secondsFromGMT() != zone.secondsFromGMT() } ?? false
        return ZoneSuggestion(zone: zone, nearestCity: city, distanceMeters: d, needsConfirmation: far || (disagrees && d > 30_000))
    }
}
