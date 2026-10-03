package sa.zood.nearmosque.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.Mosque
import sa.zood.nearmosque.core.OnlineMosques
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Live mosque lookup; null means unavailable (offline or the service failed). */
fun interface OnlineMosqueSource {
    suspend fun search(center: LatLng, radiusMeters: Double): List<Mosque>?
}

/**
 * OpenStreetMap through the public Overpass API. Only the rounded centre (about 1 km) is sent, in the
 * query built by [OnlineMosques.overpassQuery]; no identifiers, no cookies.
 */
class OverpassMosqueSource(private val endpoint: String = "https://overpass-api.de/api/interpreter") : OnlineMosqueSource {
    override suspend fun search(center: LatLng, radiusMeters: Double): List<Mosque>? = withContext(Dispatchers.IO) {
        runCatching {
            val conn = URL(endpoint).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.connectTimeout = 10_000
                conn.readTimeout = 25_000
                conn.doOutput = true
                conn.setRequestProperty("User-Agent", "NearMosque/0.2 (Android)")
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                val body = "data=" + URLEncoder.encode(OnlineMosques.overpassQuery(center, radiusMeters), "UTF-8")
                conn.outputStream.use { it.write(body.toByteArray()) }
                if (conn.responseCode != 200) null else OnlineMosques.parseOverpass(conn.inputStream.bufferedReader().use { it.readText() })
            } finally {
                conn.disconnect()
            }
        }.getOrNull()
    }
}
