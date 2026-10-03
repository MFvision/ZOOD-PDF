package sa.zood.nearmosque.core

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

object Qibla {
    val KAABA = LatLng(21.4225241, 39.8261818)

    /** Great-circle initial bearing to the Kaaba, degrees clockwise from TRUE north. */
    fun bearing(from: LatLng): Double = Geo.initialBearing(from, KAABA)

    fun distanceMeters(from: LatLng): Double = Geo.distanceMeters(from, KAABA)
}

object Angles {
    /** Normalize to [0, 360). */
    fun normalize360(deg: Double): Double = ((deg % 360.0) + 360.0) % 360.0

    /** Normalize to (-180, 180]. */
    fun normalize180(deg: Double): Double {
        val d = normalize360(deg)
        return if (d > 180.0) d - 360.0 else d
    }

    /**
     * Signed angle from the phone's heading to the Qibla, (-180, 180]: positive means turn right
     * (clockwise). Both inputs must be relative to TRUE north.
     */
    fun relativeToQibla(qiblaBearingTrue: Double, headingTrue: Double): Double =
        normalize180(qiblaBearingTrue - headingTrue)

    /** Magnetic to true heading. Declination is positive east (Android GeomagneticField convention). */
    fun trueHeading(magneticHeading: Double, declination: Double): Double = normalize360(magneticHeading + declination)

    /** Rotation target reached by the shortest path from [current] (unbounded, for animation). */
    fun shortestTarget(current: Double, target: Double): Double = current + normalize180(target - current)
}

/** Circular low-pass filter on unit vectors, so 359° → 1° never swings through 180°. */
class HeadingSmoother(private val alpha: Double = 0.18) {
    private var x = 0.0
    private var y = 0.0
    private var primed = false

    fun reset() {
        primed = false
    }

    fun update(headingDeg: Double): Double {
        val r = Math.toRadians(headingDeg)
        if (!primed) {
            x = cos(r); y = sin(r); primed = true
        } else {
            x += alpha * (cos(r) - x)
            y += alpha * (sin(r) - y)
        }
        return Angles.normalize360(Math.toDegrees(atan2(y, x)))
    }
}

/** Aligned state with hysteresis, only when heading accuracy is acceptable. */
class AlignmentDetector(
    private val enterDeg: Double = 5.0,
    private val exitDeg: Double = 8.0,
    private val maxAccuracyDeg: Double = 20.0,
) {
    var aligned = false
        private set

    /** Returns true exactly when the state changes to aligned (for a single haptic). */
    fun update(relativeDeg: Double, accuracyDeg: Double?): Boolean {
        val trustworthy = accuracyDeg != null && accuracyDeg >= 0 && accuracyDeg <= maxAccuracyDeg
        val was = aligned
        aligned = when {
            !trustworthy -> false
            aligned -> abs(relativeDeg) <= exitDeg
            else -> abs(relativeDeg) <= enterDeg
        }
        return aligned && !was
    }
}

/** What the Qibla view may honestly show. */
sealed interface CompassState {
    /** No heading sensor or permission: north-up diagram with the bearing only. */
    data object BearingOnly : CompassState
    data class Live(val headingTrue: Double, val accuracyDeg: Double?, val needsCalibration: Boolean) : CompassState
}
