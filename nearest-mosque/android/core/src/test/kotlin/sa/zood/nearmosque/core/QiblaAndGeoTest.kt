package sa.zood.nearmosque.core

import com.batoulapps.adhan2.Coordinates
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QiblaAndGeoTest {
    @Test
    fun qiblaFixtures() {
        val f = Fixtures.read("shared/fixtures/qibla.json").jsonObject
        val tol = f["toleranceDegrees"]!!.jsonPrimitive.double
        val dtol = f["distanceToleranceMeters"]!!.jsonPrimitive.double
        for (c in f["cases"]!!.jsonArray.map { it.jsonObject }) {
            val p = LatLng(c["latitude"]!!.jsonPrimitive.double, c["longitude"]!!.jsonPrimitive.double)
            val id = c["id"]!!.jsonPrimitive.content
            val want = c["bearingDegrees"]!!.jsonPrimitive.double
            assertEquals(id, 0.0, Angles.normalize180(Qibla.bearing(p) - want), tol)
            assertEquals(id, c["distanceMeters"]!!.jsonPrimitive.double, Qibla.distanceMeters(p), dtol)
            // Cross-check against Adhan's own Qibla away from the antipode, where any bearing is valid.
            if (!id.startsWith("antipode")) {
                val adhan = com.batoulapps.adhan2.Qibla(Coordinates(p.latitude, p.longitude)).direction
                assertEquals("$id vs Adhan", 0.0, Angles.normalize180(Qibla.bearing(p) - adhan), 0.1)
            }
        }
    }

    @Test
    fun angleWrapAndShortestPath() {
        assertEquals(0.0, Angles.normalize360(360.0), 1e-9)
        assertEquals(359.0, Angles.normalize360(-1.0), 1e-9)
        assertEquals(180.0, Angles.normalize180(-180.0), 1e-9)
        assertEquals(-179.0, Angles.normalize180(181.0), 1e-9)
        // Qibla at 2°, phone at 358°: turn right 4°, not left 356°.
        assertEquals(4.0, Angles.relativeToQibla(2.0, 358.0), 1e-9)
        assertEquals(-4.0, Angles.relativeToQibla(358.0, 2.0), 1e-9)
        // Animation from 350° to 10° goes forward 20°.
        assertEquals(370.0, Angles.shortestTarget(350.0, 10.0), 1e-9)
        assertEquals(-10.0, Angles.shortestTarget(10.0, 350.0), 1e-9)
    }

    @Test
    fun magneticHeadingIsCorrectedByDeclination() {
        // Magnetic 100° with 3.5° east declination is true 103.5°; west declination subtracts.
        assertEquals(103.5, Angles.trueHeading(100.0, 3.5), 1e-9)
        assertEquals(358.0, Angles.trueHeading(1.0, -3.0), 1e-9)
    }

    @Test
    fun smootherCrossesNorthWithoutSwingingThroughSouth() {
        val s = HeadingSmoother(alpha = 0.5)
        s.update(358.0)
        repeat(10) {
            val h = s.update(2.0)
            assertTrue("heading $h swung away from north", h > 350.0 || h < 10.0)
        }
        assertEquals(2.0, s.update(2.0).let { Angles.normalize180(it) }, 0.1)
    }

    @Test
    fun alignmentHasHysteresisAndNeedsAccuracy() {
        val a = AlignmentDetector()
        assertFalse(a.update(4.0, null)) // no accuracy => never aligned
        assertFalse(a.aligned)
        assertFalse(a.update(4.0, 45.0)) // poor accuracy
        assertTrue(a.update(4.0, 10.0)) // enters at <= 5°
        assertFalse(a.update(7.0, 10.0)) // stays (exit at > 8°), no second haptic
        assertTrue(a.aligned)
        assertFalse(a.update(9.0, 10.0))
        assertFalse(a.aligned)
        assertFalse(a.update(6.0, 10.0)) // must come back within 5° to re-enter
    }

    @Test
    fun zeroCoordinatesAreValidAndInvalidOnesRejected() {
        LatLng(0.0, 0.0)
        assertTrue(LatLng.isValid(-90.0, 180.0))
        assertFalse(LatLng.isValid(Double.NaN, 0.0))
        assertFalse(LatLng.isValid(91.0, 0.0))
        assertFalse(LatLng.isValid(0.0, Double.POSITIVE_INFINITY))
        assertEquals(null, LatLng.orNull(null, 0.0))
    }

    @Test
    fun boundingBoxAcrossAntimeridian() {
        val box = Geo.boundingBox(LatLng(-17.7, 179.9), 20_000.0)
        assertTrue(box.crossesAntimeridian)
        assertTrue(box.contains(LatLng(-17.7, -179.95)))
        assertTrue(box.contains(LatLng(-17.7, 179.95)))
        assertFalse(box.contains(LatLng(-17.7, 170.0)))
    }
}
