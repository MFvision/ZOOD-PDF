package sa.zood.nearmosque.core

import java.time.ZoneId

data class City(
    val id: Long,
    val name: String,
    val asciiName: String,
    val arabicNames: List<String>,
    val countryCode: String,
    val location: LatLng,
    val zoneId: String,
    val population: Long,
) {
    /**
     * Name for display: for ar/ur interfaces a name written entirely in Arabic script (GeoNames also
     * carries romanized mixtures such as "kېp ټawn", which are skipped), preferring spellings without
     * Persian/Urdu letters for Arabic and with them for Urdu; otherwise the Latin name.
     */
    fun displayName(languageCode: String): String {
        if (languageCode != "ar" && languageCode != "ur") return name
        val clean = arabicNames.filter(::isPureArabicScript)
        val urduStyle = clean.filter { n -> n.any { it in URDU_LETTERS } }
        val arabicStyle = clean - urduStyle.toSet()
        return (if (languageCode == "ar") arabicStyle + urduStyle else urduStyle + arabicStyle).firstOrNull() ?: name
    }

    companion object {
        private const val URDU_LETTERS = "پچژگکیٹڈڑںےۃھ"

        fun isPureArabicScript(s: String): Boolean =
            s.any { it.isLetter() } && s.all { !it.isLetter() || it.code in 0x0600..0x06FF || it.code in 0x0750..0x077F || it.code in 0xFB50..0xFEFF }
    }
}

/** Offline city search over the bundled GeoNames list (sorted by population). */
class CityIndex(val cities: List<City>) {
    private val keys: List<List<String>> = cities.map { c ->
        (listOf(c.name, c.asciiName) + c.arabicNames).map { TextNormalizer.foldForPrefix(it) }.distinct()
    }

    fun search(query: String, limit: Int = 30): List<City> {
        val q = TextNormalizer.foldForPrefix(query)
        if (q.isEmpty()) return cities.take(limit)
        val prefix = ArrayList<City>()
        val contains = ArrayList<City>()
        for (i in cities.indices) {
            val k = keys[i]
            when {
                k.any { it.startsWith(q) } -> prefix += cities[i]
                q.length >= 3 && k.any { it.contains(q) } -> contains += cities[i]
            }
            if (prefix.size >= limit) break
        }
        return (prefix + contains).take(limit)
    }

    fun nearest(p: LatLng): Pair<City, Double>? =
        cities.minByOrNull { Geo.distanceMeters(p, it.location) }?.let { it to Geo.distanceMeters(p, it.location) }

    companion object {
        /** Parse packs/cities/cities.tsv (see tools/build_cities.py for columns). */
        fun parse(tsv: String): CityIndex = CityIndex(
            tsv.lineSequence().filter { it.isNotBlank() }.mapNotNull { line ->
                val c = line.split('\t')
                if (c.size < 9) return@mapNotNull null
                val loc = LatLng.orNull(c[5].toDoubleOrNull(), c[6].toDoubleOrNull()) ?: return@mapNotNull null
                City(c[0].toLong(), c[1], c[2], c[3].split('|').filter { it.isNotBlank() }, c[4], loc, c[7], c[8].toLongOrNull() ?: 0)
            }.toList()
        )
    }
}

data class ZoneSuggestion(val zoneId: ZoneId, val nearestCity: City?, val distanceMeters: Double?, val needsConfirmation: Boolean)

/**
 * Time zone for a device fix. The phone's own zone (set by the network) is the authority, as on the
 * website, whenever it is consistent with the location: same rules as the nearest bundled city, at
 * sea or far from any city, or in a border band where the nearest city can be on the wrong side.
 * Only when the phone is clearly set to another zone than a city within 30 km (a traveller with a
 * manual clock) is the city's zone used, and the user is asked to confirm.
 */
class TimeZoneResolver(private val cities: CityIndex, private val borderBandMeters: Double = 30_000.0) {
    fun resolve(p: LatLng, deviceZone: ZoneId?): ZoneSuggestion {
        val nearest = cities.nearest(p)
        if (nearest == null) {
            return ZoneSuggestion(deviceZone ?: ZoneId.of("UTC"), null, null, needsConfirmation = deviceZone == null)
        }
        val (city, d) = nearest
        val cityZone = ZoneId.of(city.zoneId)
        if (deviceZone == null) return ZoneSuggestion(cityZone, city, d, needsConfirmation = d > borderBandMeters)
        return when {
            sameRules(cityZone, deviceZone) -> ZoneSuggestion(deviceZone, city, d, needsConfirmation = false)
            d > borderBandMeters -> ZoneSuggestion(deviceZone, city, d, needsConfirmation = false)
            else -> ZoneSuggestion(cityZone, city, d, needsConfirmation = true)
        }
    }

    /** Same zone, or the same offsets now and mid-January/mid-July this year (covers aliases). */
    private fun sameRules(a: ZoneId, b: ZoneId, now: java.time.Instant = java.time.Instant.now()): Boolean {
        if (a == b) return true
        val year = now.atZone(java.time.ZoneOffset.UTC).year
        val probes = listOf(now) + listOf(1, 7).map { java.time.LocalDate.of(year, it, 15).atStartOfDay(java.time.ZoneOffset.UTC).toInstant() }
        return probes.all { a.rules.getOffset(it) == b.rules.getOffset(it) }
    }
}
