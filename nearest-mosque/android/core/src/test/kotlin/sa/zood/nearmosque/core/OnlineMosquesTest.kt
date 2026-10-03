package sa.zood.nearmosque.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnlineMosquesTest {
    private val sample = Fixtures.file("shared/fixtures/overpass-sample.json").readText()

    @Test
    fun parsesOnlyValidMuslimPlaces() {
        val list = OnlineMosques.parseOverpass(sample)
        assertEquals(listOf("osm:node/101", "osm:way/202", "osm:node/303", "osm:node/606"), list.map { it.sourceId })
        val first = list[0]
        assertEquals("Masjid Test One", first.displayName("en"))
        assertEquals("مسجد الاختبار", first.displayName("ar"))
        assertEquals("12 Long Street, Cape Town", first.address)
        assertEquals("2026-10-01T12:00:00Z", first.sourceTimestamp)
        assertEquals(OpenStatus.UNKNOWN, first.openStatus)
        assertEquals(MosqueCategory.PRAYER_SPACE, list[2].category)
        assertEquals(-33.925, list[1].location.latitude, 1e-9)
        assertTrue(OnlineMosques.parseOverpass("not json").isEmpty())
    }

    @Test
    fun queryUsesRoundedCentreOnly() {
        val q = OnlineMosques.overpassQuery(LatLng(-33.92487, 18.42401), 5_000.0)
        assertTrue(q.contains("(around:6600,-33.92,18.42)"))
        assertFalse(q.contains("33.924"))
        assertEquals(LatLng(0.0, 0.0), OnlineMosques.privacyRound(LatLng(0.001, -0.004)))
    }

    @Test
    fun mergeKeepsDownloadedRecordsAndDropsNearbyDuplicates() {
        val center = LatLng(-33.92, 18.42)
        val offline = Mosque("osm:node/1", "mosques.za-cape-town", MosqueCategory.MOSQUE, mapOf("default" to "Offline"), LatLng(-33.9201, 18.4201), null, null, null, null, null)
        val online = OnlineMosques.parseOverpass(sample)
        val merged = OnlineMosques.merge(center, listOf(RankedMosque(offline, Geo.distanceMeters(center, offline.location))), online, 5_000.0)
        val ids = merged.map { it.mosque.sourceId }
        assertEquals("osm:node/1", ids.first())
        assertFalse("online duplicate of the downloaded record is dropped", "osm:node/101" in ids)
        assertTrue("osm:way/202" in ids)
        assertEquals(merged.sortedBy { it.distanceMeters }, merged)
        assertTrue(OnlineMosques.merge(LatLng(-33.0, 18.0), emptyList(), online, 100.0).isEmpty())
    }
}
