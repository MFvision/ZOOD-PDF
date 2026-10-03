import Foundation

public enum Qibla {
    public static let kaaba = LatLng(21.4225241, 39.8261818)!

    /// Great-circle initial bearing to the Kaaba, degrees clockwise from TRUE north.
    public static func bearing(from p: LatLng) -> Double { Geo.initialBearing(from: p, to: kaaba) }
    public static func distanceMeters(from p: LatLng) -> Double { Geo.distanceMeters(p, kaaba) }
}

public enum Angles {
    public static func normalize360(_ d: Double) -> Double {
        let r = d.truncatingRemainder(dividingBy: 360)
        return r < 0 ? r + 360 : r
    }

    /// (-180, 180]
    public static func normalize180(_ d: Double) -> Double {
        let n = normalize360(d)
        return n > 180 ? n - 360 : n
    }

    /// Signed angle from the phone's TRUE heading to the Qibla: positive means turn right (clockwise).
    public static func relativeToQibla(qiblaBearingTrue: Double, headingTrue: Double) -> Double {
        normalize180(qiblaBearingTrue - headingTrue)
    }

    /// Magnetic to true heading; declination positive east.
    public static func trueHeading(magnetic: Double, declination: Double) -> Double { normalize360(magnetic + declination) }

    /// Unbounded animation target reached by the shortest path from `current`.
    public static func shortestTarget(current: Double, target: Double) -> Double { current + normalize180(target - current) }
}

/// Circular low-pass filter on unit vectors, so 359° → 1° never swings through 180°.
public struct HeadingSmoother: Sendable {
    private var x = 0.0, y = 0.0, primed = false
    public let alpha: Double
    public init(alpha: Double = 0.18) { self.alpha = alpha }

    public mutating func reset() { primed = false }

    public mutating func update(_ heading: Double) -> Double {
        let r = heading * .pi / 180
        if !primed { x = cos(r); y = sin(r); primed = true } else {
            x += alpha * (cos(r) - x)
            y += alpha * (sin(r) - y)
        }
        return Angles.normalize360(atan2(y, x) * 180 / .pi)
    }
}

/// Aligned state with hysteresis, only when heading accuracy is acceptable.
public struct AlignmentDetector: Sendable {
    public let enterDeg: Double, exitDeg: Double, maxAccuracyDeg: Double
    public private(set) var aligned = false

    public init(enterDeg: Double = 5, exitDeg: Double = 8, maxAccuracyDeg: Double = 20) {
        self.enterDeg = enterDeg; self.exitDeg = exitDeg; self.maxAccuracyDeg = maxAccuracyDeg
    }

    /// Returns true exactly when the state changes to aligned (for a single haptic).
    public mutating func update(relativeDeg: Double, accuracyDeg: Double?) -> Bool {
        let trustworthy = accuracyDeg.map { $0 >= 0 && $0 <= maxAccuracyDeg } ?? false
        let was = aligned
        if !trustworthy { aligned = false } else if aligned { aligned = abs(relativeDeg) <= exitDeg } else { aligned = abs(relativeDeg) <= enterDeg }
        return aligned && !was
    }
}

/// What the Qibla view may honestly show.
public enum CompassState: Equatable, Sendable {
    /// No heading available: north-up diagram with the bearing only.
    case bearingOnly
    case live(headingTrue: Double, accuracyDeg: Double?, needsCalibration: Bool)
}
