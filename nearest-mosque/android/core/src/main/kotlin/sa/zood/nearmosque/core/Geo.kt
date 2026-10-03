package sa.zood.nearmosque.core

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** A validated WGS84 point. Zero is a valid latitude and longitude. */
data class LatLng(val latitude: Double, val longitude: Double) {
    init {
        require(isValid(latitude, longitude)) { "Invalid coordinate ($latitude, $longitude)" }
    }

    companion object {
        fun isValid(latitude: Double, longitude: Double): Boolean =
            latitude.isFinite() && longitude.isFinite() &&
                latitude in -90.0..90.0 && longitude in -180.0..180.0

        fun orNull(latitude: Double?, longitude: Double?): LatLng? =
            if (latitude != null && longitude != null && isValid(latitude, longitude)) LatLng(latitude, longitude) else null
    }
}

object Geo {
    const val EARTH_RADIUS_M = 6_371_008.8

    /** Haversine great-circle distance in metres (a straight line over the ellipsoid's mean sphere). */
    fun distanceMeters(a: LatLng, b: LatLng): Double {
        val p1 = Math.toRadians(a.latitude)
        val p2 = Math.toRadians(b.latitude)
        val dp = p2 - p1
        val dl = Math.toRadians(b.longitude - a.longitude)
        val h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
    }

    /** Initial great-circle bearing from [from] to [to], degrees clockwise from true north in [0, 360). */
    fun initialBearing(from: LatLng, to: LatLng): Double {
        val p1 = Math.toRadians(from.latitude)
        val p2 = Math.toRadians(to.latitude)
        val dl = Math.toRadians(to.longitude - from.longitude)
        val y = sin(dl) * cos(p2)
        val x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    /** A latitude/longitude box that contains every point within [radiusM] of [center] (prefilter only). */
    fun boundingBox(center: LatLng, radiusM: Double): BoundingBox {
        val dLat = Math.toDegrees(radiusM / EARTH_RADIUS_M)
        val cosLat = cos(Math.toRadians(center.latitude))
        val dLng = if (cosLat < 1e-6) 180.0 else min(180.0, Math.toDegrees(radiusM / (EARTH_RADIUS_M * cosLat)))
        return BoundingBox(
            minLat = (center.latitude - dLat).coerceAtLeast(-90.0),
            maxLat = (center.latitude + dLat).coerceAtMost(90.0),
            minLng = center.longitude - dLng,
            maxLng = center.longitude + dLng,
        )
    }
}

data class BoundingBox(val minLat: Double, val maxLat: Double, val minLng: Double, val maxLng: Double) {
    /** True when the box crosses the antimeridian and must be queried as two longitude ranges. */
    val crossesAntimeridian: Boolean get() = minLng < -180.0 || maxLng > 180.0

    fun contains(p: LatLng): Boolean {
        if (p.latitude < minLat || p.latitude > maxLat) return false
        if (!crossesAntimeridian) return p.longitude in minLng..maxLng
        val lng = p.longitude
        return lng >= wrap(minLng) || lng <= wrap(maxLng)
    }

    private fun wrap(lng: Double) = ((lng + 540.0) % 360.0) - 180.0
}
