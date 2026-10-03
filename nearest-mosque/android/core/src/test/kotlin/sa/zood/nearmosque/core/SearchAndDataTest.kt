package sa.zood.nearmosque.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.time.ZoneId

class SearchAndDataTest {
    @Test
    fun normalizationFixtures() {
        val f = Fixtures.read("shared/fixtures/normalization.json").jsonObject
        for (c in f["cases"]!!.jsonArray.map { it.jsonObject }) {
            val want = c["tokens"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(c["id"]!!.jsonPrimitive.content, want, TextNormalizer.tokens(c["input"]!!.jsonPrimitive.content))
        }
    }

    @Test
    fun retrievalFixturesMatchReferenceExactly() {
        val r = Fixtures.retriever()
        val f = Fixtures.read("shared/fixtures/retrieval.json").jsonObject
        val failures = mutableListOf<String>()
        for (c in f["cases"]!!.jsonArray.map { it.jsonObject }) {
            val id = c["id"]!!.jsonPrimitive.content
            val context = (c["context"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
            val res = r.retrieve(c["q"]!!.jsonPrimitive.content, context)
            val ref = c["referenceResult"]!!.jsonObject
            val kind = ref["kind"]!!.jsonPrimitive.content.uppercase()
            val faq = ref["commonQuestionId"]?.jsonPrimitive?.contentOrNullSafe()
            val passages = ref["passages"]!!.jsonArray.map { it.jsonPrimitive.content }
            if (res.kind.name != kind) failures += "$id kind ${res.kind} != $kind"
            if (res.commonQuestion?.id != faq) failures += "$id faq ${res.commonQuestion?.id} != $faq"
            if (res.passages.map { it.chunkId } != passages) failures += "$id passages ${res.passages.map { it.chunkId }} != $passages"
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? = if (this is kotlinx.serialization.json.JsonNull) null else content

    @Test
    fun answersOnlyReferenceStoredPassages() {
        val r = Fixtures.retriever()
        val ids = Fixtures.quranChunks().map { it.id }.toSet()
        for (q in listOf("How do I perform wudu?", "neither slumber nor sleep", "What is the capital of France?")) {
            val a = AnswerComposer.compose(q, r.retrieve(q))
            assertTrue((a.citations + a.related).all { it in ids })
            if (a.kind == AnswerKind.INSUFFICIENT) assertTrue(a.citations.isEmpty() && a.generated == null)
        }
    }

    @Test
    fun citationAnchorsAreUniqueAndStable() {
        val chunks = Fixtures.quranChunks()
        assertEquals(6236, chunks.size)
        assertEquals(chunks.size, chunks.map { it.id }.toSet().size)
        val c = chunks.first { it.id == "quran:2:255" }
        assertEquals("2:255", c.anchor)
        assertEquals(2, c.surah); assertEquals(255, c.ayah)
        assertTrue("diacritics kept verbatim", c.original.text.contains('\u0651')) // shadda
        assertEquals(listOf("الله", "لا", "اله"), TextNormalizer.tokens(c.original.text).take(3))
        assertEquals("https://tanzil.net/#2:255", c.url)
    }

    @Test
    fun allBundledPacksVerifyAndTamperingIsDetected() {
        val packs = File(Fixtures.root, "packs").walk().filter { it.name == "manifest.json" }.toList()
        assertEquals(5, packs.size)
        for (m in packs) {
            val manifest = PackVerifier.parseManifest(m.readText())
            PackVerifier.verify(manifest) { path -> File(m.parentFile, path).takeIf { it.exists() }?.inputStream() }
        }
        val mosques = packs.first { it.parentFile.name == "za-cape-town" }
        val manifest = PackVerifier.parseManifest(mosques.readText())
        val err = runCatching {
            PackVerifier.verify(manifest) { ByteArrayInputStream("tampered".toByteArray()) }
        }.exceptionOrNull()
        assertTrue(err is PackError.Checksum)
        assertTrue(runCatching { PackVerifier.parseManifest("{\"id\":1}") }.exceptionOrNull() is PackError.Format)
        val newer = mosques.readText().replace("\"schemaVersion\": 1", "\"schemaVersion\": 99")
        assertTrue(runCatching { PackVerifier.parseManifest(newer) }.exceptionOrNull() is PackError.NewerSchema)
    }

    private fun capeTown(): List<Mosque> =
        File(Fixtures.root, "packs/mosques/za-cape-town/mosques.jsonl").readLines().filter { it.isNotBlank() }
            .mapNotNull { PackJson.decodeFromString(MosqueRecord.serializer(), it).toMosque("mosques.za-cape-town") }

    @Test
    fun mosqueRankingIsDeterministicAndDeduplicated() {
        val all = capeTown()
        val manifest = PackVerifier.parseManifest(File(Fixtures.root, "packs/mosques/za-cape-town/manifest.json").readText())
        assertEquals(manifest.recordCount, all.size)
        val center = LatLng(-33.9258, 18.4232)
        val ranked = MosqueRanking.rank(center, all, 20_000.0)
        assertTrue(ranked.isNotEmpty())
        assertEquals(ranked.sortedBy { it.distanceMeters }.map { it.mosque.sourceId }, ranked.map { it.mosque.sourceId })
        assertEquals(ranked, MosqueRanking.rank(center, all.shuffled(java.util.Random(7)), 20_000.0))
        assertTrue(ranked.all { it.distanceMeters <= 20_000.0 })
        // A way and a node for the same named place 10 m apart collapse to one; distinct names stay.
        val a = Mosque("osm:node/1", "p", MosqueCategory.MOSQUE, mapOf("default" to "Masjid Al-Noor"), LatLng(0.0, 0.0), null, null, null, null, null)
        val b = a.copy(sourceId = "osm:way/2", location = LatLng(0.00009, 0.0))
        val c = a.copy(sourceId = "osm:node/3", names = mapOf("default" to "Other Mosque"), location = LatLng(0.00009, 0.0))
        val r = MosqueRanking.rank(LatLng(0.0, 0.0), listOf(b, c, a), 1000.0)
        assertEquals(listOf("osm:node/1", "osm:node/3"), r.map { it.mosque.sourceId })
    }

    @Test
    fun unknownHoursAreNeverOpen() {
        val m = capeTown().firstOrNull { it.openingHoursRaw != null } ?: capeTown().first()
        assertEquals(OpenStatus.UNKNOWN, m.openStatus)
    }

    @Test
    fun staleSearchGenerationsAreDropped() {
        val g = SearchGeneration()
        val first = g.next()
        val second = g.next()
        assertFalse(g.isCurrent(first))
        assertTrue(g.isCurrent(second))
    }

    private val cities by lazy { CityIndex.parse(File(Fixtures.root, "packs/cities/cities.tsv").readText()) }

    @Test
    fun citySearchInSeveralScripts() {
        assertEquals("Makkah", cities.search("makk").first().name)
        assertEquals("Makkah", cities.search("مكة").first().name)
        assertEquals("Cape Town", cities.search("cape t").first().name)
        assertEquals("Istanbul", cities.search("İstanbul").first().name)
        assertTrue(cities.search("zzzzqqq").isEmpty())
        assertEquals("مكة", cities.search("makkah").first().displayName("ar"))
    }

    @Test
    fun cityDisplayNameSkipsRomanizedMixtures() {
        val ct = cities.search("cape town").first()
        assertEquals("كيب تاون", ct.displayName("ar"))
        assertEquals("کیپ ٹاؤن", ct.displayName("ur"))
        assertEquals("Cape Town", ct.displayName("en"))
    }

    @Test
    fun timeZoneResolution() {
        val tz = TimeZoneResolver(cities)
        val ct = tz.resolve(LatLng(-33.95, 18.47), ZoneId.of("Africa/Johannesburg"))
        assertEquals(ZoneId.of("Africa/Johannesburg"), ct.zoneId)
        assertFalse(ct.needsConfirmation)
        // Phone zone alias with identical rules is kept as-is.
        assertEquals(ZoneId.of("Africa/Maputo"), tz.resolve(LatLng(-33.95, 18.47), ZoneId.of("Africa/Maputo")).zoneId)
        // At sea the phone's zone is used (like the website), without a prompt.
        val ocean = tz.resolve(LatLng(-40.0, -30.0), ZoneId.of("UTC"))
        assertEquals(ZoneId.of("UTC"), ocean.zoneId)
        assertFalse(ocean.needsConfirmation)
        // In Cape Town with the phone left on London time: the city's zone, confirmation requested.
        val traveller = tz.resolve(LatLng(-33.95, 18.47), ZoneId.of("Europe/London"))
        assertEquals(ZoneId.of("Africa/Johannesburg"), traveller.zoneId)
        assertTrue(traveller.needsConfirmation)
        // No phone zone and no nearby city: ask.
        assertTrue(tz.resolve(LatLng(-40.0, -30.0), null).needsConfirmation)
        // A remote city never borrows the phone's zone.
        val makkah = cities.search("makkah").first()
        assertEquals("Asia/Riyadh", makkah.zoneId)
        assertNull(LatLng.orNull(Double.NaN, 1.0))
    }
}
