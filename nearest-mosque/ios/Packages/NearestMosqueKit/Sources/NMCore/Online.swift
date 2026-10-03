import Foundation

/// Optional live mosque results (OpenStreetMap through the Overpass API, or Apple Maps on iOS), merged
/// with downloaded data. Only a rounded centre (0.01°, about 1 km) leaves the phone; distances are
/// measured locally from the exact point. Downloaded records always win over online duplicates.
public enum OnlineMosques {
    public static let osmPackId = "online.osm"
    public static let applePackId = "online.apple"
    public static let samePlaceMeters = 60.0
    public static let roundingSlackMeters = 1_600
    static let prayerSpaceValues: Set<String> = ["musalla", "prayer_room", "mussalla", "musholla", "mushola"]
    static let nameLangs = ["ar", "en", "ur", "tr", "id", "fr", "es"]

    public static func privacyRound(_ p: LatLng) -> LatLng {
        LatLng((p.latitude * 100).rounded() / 100, (p.longitude * 100).rounded() / 100) ?? p
    }

    /// Query around the rounded centre, widened so the exact search radius stays covered.
    public static func overpassQuery(center: LatLng, radiusMeters: Double) -> String {
        let c = privacyRound(center)
        let r = Int(radiusMeters.rounded()) + roundingSlackMeters
        let around = "(around:\(r),\(fmt(c.latitude)),\(fmt(c.longitude)))"
        return "[out:json][timeout:20];("
            + "nwr[\"amenity\"=\"place_of_worship\"][\"religion\"=\"muslim\"]\(around);"
            + "nwr[\"building\"=\"mosque\"][\"religion\"=\"muslim\"]\(around);"
            + ");out center tags 200;"
    }

    /// Same number rendering as Kotlin's Double.toString for these values (e.g. -33.92, 18.42, 0.0).
    static func fmt(_ d: Double) -> String {
        let s = String(d)
        return s.contains(".") || s.contains("e") ? s : s + ".0"
    }

    public static func parseOverpass(_ data: Data) -> [Mosque] {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let elements = root["elements"] as? [[String: Any]] else { return [] }
        let stamp = (root["osm3s"] as? [String: Any])?["timestamp_osm_base"] as? String
        return elements.compactMap { o -> Mosque? in
            guard let type = o["type"] as? String, let id = num(o["id"]).map({ Int64($0) }),
                  let tags = o["tags"] as? [String: String] else { return nil }
            guard tags["religion"] == "muslim", tags["amenity"] == "place_of_worship" || tags["building"] == "mosque" else { return nil }
            let c = (o["center"] as? [String: Any]) ?? o
            guard let lat = num(c["lat"]), let lon = num(c["lon"]),
                  let loc = LatLng(lat, lon) else { return nil }
            var names: [String: String] = [:]
            if let n = tags["name"], !n.trimmingCharacters(in: .whitespaces).isEmpty { names["default"] = n }
            for l in nameLangs { if let n = tags["name:\(l)"], !n.trimmingCharacters(in: .whitespaces).isEmpty { names[l] = n } }
            let pow = (tags["place_of_worship"] ?? tags["place_of_worship:type"] ?? "").lowercased()
            let street = [tags["addr:housenumber"], tags["addr:street"]].compactMap { $0 }.joined(separator: " ")
            let parts = [street.isEmpty ? nil : street, tags["addr:suburb"], tags["addr:city"], tags["addr:postcode"]].compactMap { $0 }
            let address = tags["addr:full"] ?? (parts.isEmpty ? nil : parts.joined(separator: ", "))
            return Mosque(sourceId: "osm:\(type)/\(id)", packId: osmPackId,
                          category: prayerSpaceValues.contains(pow) || tags["indoor"] == "room" ? .prayer_space : .mosque,
                          names: names, location: loc, address: address,
                          phone: tags["phone"] ?? tags["contact:phone"], website: tags["website"] ?? tags["contact:website"],
                          openingHoursRaw: tags["opening_hours"], sourceTimestamp: stamp)
        }
    }

    private static func num(_ a: Any?) -> Double? {
        if let d = a as? Double { return d }
        if let i = a as? Int { return Double(i) }
        if let n = a as? NSNumber { return n.doubleValue }
        return nil
    }

    /// Downloaded records first; an online record within `samePlaceMeters` of a kept one (or with the same id) is dropped.
    public static func merge(center: LatLng, offline: [RankedMosque], online: [Mosque], radiusMeters: Double, limit: Int = 100) -> [RankedMosque] {
        let order: (RankedMosque, RankedMosque) -> Bool = { ($0.distanceMeters, $0.mosque.sourceId) < ($1.distanceMeters, $1.mosque.sourceId) }
        var kept = offline
        var ids = Set(offline.map(\.mosque.sourceId))
        let candidates = online.map { RankedMosque(mosque: $0, distanceMeters: Geo.distanceMeters(center, $0.location)) }
            .filter { $0.distanceMeters <= radiusMeters }
            .sorted(by: order)
        for r in candidates where !ids.contains(r.mosque.sourceId) {
            if kept.contains(where: { Geo.distanceMeters($0.mosque.location, r.mosque.location) <= samePlaceMeters }) { continue }
            kept.append(r); ids.insert(r.mosque.sourceId)
        }
        return Array(kept.sorted(by: order).prefix(limit))
    }
}
