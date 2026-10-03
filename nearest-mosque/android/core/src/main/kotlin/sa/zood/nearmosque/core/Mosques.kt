package sa.zood.nearmosque.core

import kotlinx.serialization.Serializable

enum class MosqueCategory { MOSQUE, PRAYER_SPACE }

/** Opening status is never assumed: without verified evidence it is UNKNOWN. */
enum class OpenStatus { OPEN, CLOSED, UNKNOWN, STALE }

data class Mosque(
    val sourceId: String,
    val packId: String,
    val category: MosqueCategory,
    val names: Map<String, String>,
    val location: LatLng,
    val address: String?,
    val phone: String?,
    val website: String?,
    val openingHoursRaw: String?,
    val sourceTimestamp: String?,
) {
    /** Best name for the interface language, then the default tag, then any name; null if unnamed. */
    fun displayName(languageCode: String): String? =
        names[languageCode] ?: names["default"] ?: names["en"] ?: names.values.firstOrNull()

    /** The apps do not interpret opening_hours yet; a tagged string is shown verbatim, status unknown. */
    val openStatus: OpenStatus get() = OpenStatus.UNKNOWN
}

data class RankedMosque(val mosque: Mosque, val distanceMeters: Double)

/** One JSON line of a mosque pack (see tools/build_mosque_pack.py). */
@Serializable
data class MosqueRecord(
    val sourceId: String,
    val category: String = "mosque",
    val names: Map<String, String> = emptyMap(),
    val lat: Double,
    val lng: Double,
    val address: String? = null,
    val phone: String? = null,
    val website: String? = null,
    val openingHoursRaw: String? = null,
    val denomination: String? = null,
    val sourceVersion: Int? = null,
    val sourceTimestamp: String? = null,
) {
    fun toMosque(packId: String): Mosque? {
        val loc = LatLng.orNull(lat, lng) ?: return null
        return Mosque(
            sourceId, packId,
            if (category == "prayer_space") MosqueCategory.PRAYER_SPACE else MosqueCategory.MOSQUE,
            names, loc, address, phone, website, openingHoursRaw, sourceTimestamp,
        )
    }
}

object MosqueRanking {
    /** Records closer than this with the same normalized name are treated as one place (way + node). */
    const val DUPLICATE_RADIUS_M = 40.0

    /**
     * Exact distance, deterministic order (distance, then source id), duplicates removed. "Nearest"
     * means nearest known record in the installed coverage.
     */
    fun rank(center: LatLng, candidates: List<Mosque>, radiusMeters: Double, limit: Int = 100): List<RankedMosque> {
        val sorted = candidates.asSequence()
            .distinctBy { it.sourceId }
            .map { RankedMosque(it, Geo.distanceMeters(center, it.location)) }
            .filter { it.distanceMeters <= radiusMeters }
            .sortedWith(compareBy<RankedMosque> { it.distanceMeters }.thenBy { it.mosque.sourceId })
            .toList()
        val kept = ArrayList<RankedMosque>()
        for (r in sorted) {
            val key = nameKey(r.mosque)
            val dup = key != null && kept.any { k ->
                nameKey(k.mosque) == key && Geo.distanceMeters(k.mosque.location, r.mosque.location) <= DUPLICATE_RADIUS_M
            }
            if (!dup) kept += r
            if (kept.size >= limit) break
        }
        return kept
    }

    private fun nameKey(m: Mosque): String? =
        m.names["default"]?.let { TextNormalizer.tokens(it).joinToString(" ") }?.takeIf { it.isNotEmpty() }
}

/** Monotonic generation counter so an older, slower search can never replace a newer one. */
class SearchGeneration {
    private var current = 0L

    @Synchronized
    fun next(): Long = ++current

    @Synchronized
    fun isCurrent(generation: Long): Boolean = generation == current
}
