import Foundation

/// A validated WGS84 point. Zero is a valid latitude and longitude.
public struct LatLng: Hashable, Codable, Sendable {
    public let latitude: Double
    public let longitude: Double

    public init?(_ latitude: Double, _ longitude: Double) {
        guard LatLng.isValid(latitude, longitude) else { return nil }
        self.latitude = latitude
        self.longitude = longitude
    }

    public static func isValid(_ latitude: Double, _ longitude: Double) -> Bool {
        latitude.isFinite && longitude.isFinite && (-90...90).contains(latitude) && (-180...180).contains(longitude)
    }
}

public enum Geo {
    public static let earthRadiusM = 6_371_008.8

    static func rad(_ d: Double) -> Double { d * .pi / 180 }
    static func deg(_ r: Double) -> Double { r * 180 / .pi }

    /// Haversine great-circle distance in metres.
    public static func distanceMeters(_ a: LatLng, _ b: LatLng) -> Double {
        let p1 = rad(a.latitude), p2 = rad(b.latitude)
        let dp = p2 - p1, dl = rad(b.longitude - a.longitude)
        let h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * earthRadiusM * asin(min(1, sqrt(h)))
    }

    /// Initial great-circle bearing, degrees clockwise from true north in [0, 360).
    public static func initialBearing(from: LatLng, to: LatLng) -> Double {
        let p1 = rad(from.latitude), p2 = rad(to.latitude)
        let dl = rad(to.longitude - from.longitude)
        let y = sin(dl) * cos(p2)
        let x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
        return (deg(atan2(y, x)) + 360).truncatingRemainder(dividingBy: 360)
    }

    public struct BoundingBox: Equatable, Sendable {
        public let minLat, maxLat, minLng, maxLng: Double
        public var crossesAntimeridian: Bool { minLng < -180 || maxLng > 180 }

        /// Longitude ranges to query, split at the antimeridian.
        public var longitudeRanges: [ClosedRange<Double>] {
            if minLng < -180 { return [(minLng + 360)...180, -180...maxLng] }
            if maxLng > 180 { return [minLng...180, -180...(maxLng - 360)] }
            return [minLng...maxLng]
        }

        public func contains(_ p: LatLng) -> Bool {
            guard (minLat...maxLat).contains(p.latitude) else { return false }
            return longitudeRanges.contains { $0.contains(p.longitude) }
        }
    }

    /// Prefilter box containing every point within `radiusM` of `center`.
    public static func boundingBox(_ center: LatLng, radiusM: Double) -> BoundingBox {
        let dLat = deg(radiusM / earthRadiusM)
        let cosLat = cos(rad(center.latitude))
        let dLng = cosLat < 1e-6 ? 180 : min(180, deg(radiusM / (earthRadiusM * cosLat)))
        return BoundingBox(
            minLat: max(-90, center.latitude - dLat), maxLat: min(90, center.latitude + dLat),
            minLng: center.longitude - dLng, maxLng: center.longitude + dLng
        )
    }
}
