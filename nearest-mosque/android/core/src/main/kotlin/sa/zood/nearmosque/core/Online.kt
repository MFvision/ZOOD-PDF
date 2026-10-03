package sa.zood.nearmosque.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlin.math.roundToInt

/**
 * Optional live mosque results (OpenStreetMap through the Overpass API), merged with downloaded data.
 * Only a rounded centre (0.01°, about 1 km) leaves the phone; distances are measured locally from the
 * exact point. Downloaded records always win over online duplicates.
 */
object OnlineMosques {
    const val PACK_ID = "online.osm"
    const val SAME_PLACE_M = 60.0
    const val ROUNDING_SLACK_M = 1_600
    private val prayerSpaceValues = setOf("musalla", "prayer_room", "mussalla", "musholla", "mushola")
    private val nameLangs = listOf("ar", "en", "ur", "tr", "id", "fr", "es")
    private val json = Json { ignoreUnknownKeys = true }

    fun privacyRound(p: LatLng): LatLng = LatLng(Math.round(p.latitude * 100) / 100.0, Math.round(p.longitude * 100) / 100.0)

    /** Query around the rounded centre, widened so the exact search radius stays covered. */
    fun overpassQuery(center: LatLng, radiusMeters: Double): String {
        val c = privacyRound(center)
        val r = radiusMeters.roundToInt() + ROUNDING_SLACK_M
        val around = "(around:$r,${c.latitude},${c.longitude})"
        return "[out:json][timeout:20];(" +
            "nwr[\"amenity\"=\"place_of_worship\"][\"religion\"=\"muslim\"]$around;" +
            "nwr[\"building\"=\"mosque\"][\"religion\"=\"muslim\"]$around;" +
            ");out center tags 200;"
    }

    fun parseOverpass(body: String): List<Mosque> {
        val root = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return emptyList()
        val stamp = (root["osm3s"] as? JsonObject)?.get("timestamp_osm_base")?.jsonPrimitive?.contentOrNull
        val elements = runCatching { root["elements"]!!.jsonArray }.getOrNull() ?: return emptyList()
        return elements.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val type = o["type"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val id = o["id"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
            val tags = (o["tags"] as? JsonObject)?.mapValues { it.value.jsonPrimitive.contentOrNull.orEmpty() } ?: return@mapNotNull null
            if (tags["religion"] != "muslim" || (tags["amenity"] != "place_of_worship" && tags["building"] != "mosque")) return@mapNotNull null
            val c = (o["center"] as? JsonObject) ?: o
            val loc = LatLng.orNull(c["lat"]?.jsonPrimitive?.doubleOrNull, c["lon"]?.jsonPrimitive?.doubleOrNull) ?: return@mapNotNull null
            val names = buildMap {
                tags["name"]?.takeIf { it.isNotBlank() }?.let { put("default", it) }
                nameLangs.forEach { l -> tags["name:$l"]?.takeIf { it.isNotBlank() }?.let { put(l, it) } }
            }
            val pow = (tags["place_of_worship"] ?: tags["place_of_worship:type"] ?: "").lowercase()
            val street = listOfNotNull(tags["addr:housenumber"], tags["addr:street"]).joinToString(" ").ifBlank { null }
            val address = tags["addr:full"] ?: listOfNotNull(street, tags["addr:suburb"], tags["addr:city"], tags["addr:postcode"]).joinToString(", ").ifBlank { null }
            Mosque(
                sourceId = "osm:$type/$id", packId = PACK_ID,
                category = if (pow in prayerSpaceValues || tags["indoor"] == "room") MosqueCategory.PRAYER_SPACE else MosqueCategory.MOSQUE,
                names = names, location = loc, address = address,
                phone = tags["phone"] ?: tags["contact:phone"], website = tags["website"] ?: tags["contact:website"],
                openingHoursRaw = tags["opening_hours"], sourceTimestamp = stamp,
            )
        }
    }

    /** Downloaded records first; an online record within [SAME_PLACE_M] of a kept one (or with the same id) is dropped. */
    fun merge(center: LatLng, offline: List<RankedMosque>, online: List<Mosque>, radiusMeters: Double, limit: Int = 100): List<RankedMosque> {
        val kept = offline.toMutableList()
        val ids = offline.mapTo(HashSet()) { it.mosque.sourceId }
        online.map { RankedMosque(it, Geo.distanceMeters(center, it.location)) }
            .filter { it.distanceMeters <= radiusMeters }
            .sortedWith(compareBy<RankedMosque> { it.distanceMeters }.thenBy { it.mosque.sourceId })
            .forEach { r ->
                if (r.mosque.sourceId in ids) return@forEach
                if (kept.any { Geo.distanceMeters(it.mosque.location, r.mosque.location) <= SAME_PLACE_M }) return@forEach
                kept += r; ids += r.mosque.sourceId
            }
        return kept.sortedWith(compareBy<RankedMosque> { it.distanceMeters }.thenBy { it.mosque.sourceId }).take(limit)
    }
}
