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
    /** Name for display: an Arabic-script name for ar/ur interfaces when GeoNames has one. */
    fun displayName(languageCode: String): String =
        if ((languageCode == "ar" || languageCode == "ur") && arabicNames.isNotEmpty()) arabicNames.first() else name
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
 * Time zone for arbitrary coordinates without a boundary database: the nearest bundled city's IANA
 * zone, flagged for confirmation when that city is far away. The phone's zone is only a tie-breaker.
 */
class TimeZoneResolver(private val cities: CityIndex, private val confidentWithinMeters: Double = 150_000.0) {
    fun resolve(p: LatLng, deviceZone: ZoneId?): ZoneSuggestion {
        val nearest = cities.nearest(p)
        if (nearest == null) {
            val z = deviceZone ?: ZoneId.of("UTC")
            return ZoneSuggestion(z, null, null, needsConfirmation = true)
        }
        val (city, d) = nearest
        val zone = ZoneId.of(city.zoneId)
        val far = d > confidentWithinMeters
        // Near a city whose zone differs from the phone's, the point may be across a border.
        val disagreesWithDevice = deviceZone != null && !sameRules(zone, deviceZone) && d > 30_000.0
        return ZoneSuggestion(zone, city, d, needsConfirmation = far || disagreesWithDevice)
    }

    private fun sameRules(a: ZoneId, b: ZoneId): Boolean = a == b || a.rules == b.rules
}
