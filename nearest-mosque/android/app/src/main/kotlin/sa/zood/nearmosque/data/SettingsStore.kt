package sa.zood.nearmosque.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import sa.zood.nearmosque.core.AsrMadhab
import sa.zood.nearmosque.core.HighLatRule
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.Method
import sa.zood.nearmosque.core.PolarRule
import sa.zood.nearmosque.core.PrayerEvent
import sa.zood.nearmosque.core.PrayerSettings
import java.time.ZoneId

/** The location prayer times are calculated for. Separate from the device position and map centre. */
data class PrayerLocation(
    val name: String,
    val location: LatLng,
    val zoneId: ZoneId,
    val countryCode: String?,
    val source: Source,
    val zoneConfirmed: Boolean = true,
) {
    enum class Source { CITY, DEVICE }
}

data class AppSettings(
    val prayerLocation: PrayerLocation?,
    val followDevice: Boolean,
    val prayer: PrayerSettings,
    val methodChosenByUser: Boolean,
    val reminders: Set<PrayerEvent>,
    val mosqueView: String,
    val onboarded: Boolean = false,
    /** Live mosque results (OpenStreetMap via Overpass) added to downloaded data; disclosed in onboarding and Settings. */
    val onlineSearch: Boolean = true,
)

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/** [store] is injectable so tests get an isolated file (DataStore allows one instance per file). */
class SettingsStore(private val store: DataStore<Preferences>) {
    constructor(context: Context) : this(context.dataStore)

    private object K {
        val locName = stringPreferencesKey("loc_name")
        val locLat = doublePreferencesKey("loc_lat")
        val locLng = doublePreferencesKey("loc_lng")
        val locZone = stringPreferencesKey("loc_zone")
        val locCountry = stringPreferencesKey("loc_country")
        val locSource = stringPreferencesKey("loc_source")
        val locZoneConfirmed = booleanPreferencesKey("loc_zone_confirmed")
        val follow = booleanPreferencesKey("follow_device")
        val method = stringPreferencesKey("method")
        val methodByUser = booleanPreferencesKey("method_by_user")
        val madhab = stringPreferencesKey("madhab")
        val highLat = stringPreferencesKey("high_lat")
        val polar = stringPreferencesKey("polar")
        val ramadan = booleanPreferencesKey("ramadan_isha")
        val hijriAdj = intPreferencesKey("hijri_adj")
        val reminders = stringSetPreferencesKey("reminders")
        val mosqueView = stringPreferencesKey("mosque_view")
        val onboarded = booleanPreferencesKey("onboarded")
        val onlineSearch = booleanPreferencesKey("online_search")
        fun offset(e: PrayerEvent) = intPreferencesKey("offset_${e.name}")
    }

    val settings: Flow<AppSettings> = store.data.map { p ->
        val loc = run {
            val lat = p[K.locLat]
            val lng = p[K.locLng]
            val zone = p[K.locZone]?.let { runCatching { ZoneId.of(it) }.getOrNull() }
            val ll = LatLng.orNull(lat, lng)
            if (ll != null && zone != null) {
                PrayerLocation(
                    p[K.locName] ?: "", ll, zone, p[K.locCountry],
                    if (p[K.locSource] == "DEVICE") PrayerLocation.Source.DEVICE else PrayerLocation.Source.CITY,
                    p[K.locZoneConfirmed] ?: true,
                )
            } else null
        }
        AppSettings(
            prayerLocation = loc,
            followDevice = p[K.follow] ?: false,
            prayer = PrayerSettings(
                method = p[K.method]?.let { runCatching { Method.valueOf(it) }.getOrNull() } ?: Method.MUSLIM_WORLD_LEAGUE,
                madhab = p[K.madhab]?.let { runCatching { AsrMadhab.valueOf(it) }.getOrNull() } ?: AsrMadhab.SHAFI,
                highLatitudeRule = p[K.highLat]?.let { runCatching { HighLatRule.valueOf(it) }.getOrNull() } ?: HighLatRule.AUTO,
                polarRule = p[K.polar]?.let { runCatching { PolarRule.valueOf(it) }.getOrNull() } ?: PolarRule.UNAVAILABLE,
                offsets = PrayerEvent.entries.associateWith { p[K.offset(it)] ?: 0 }.filterValues { it != 0 },
                ramadanIshaExtension = p[K.ramadan] ?: true,
                hijriAdjustmentDays = p[K.hijriAdj] ?: 0,
            ),
            methodChosenByUser = p[K.methodByUser] ?: false,
            reminders = p[K.reminders].orEmpty().mapNotNull { runCatching { PrayerEvent.valueOf(it) }.getOrNull() }.toSet(),
            mosqueView = p[K.mosqueView] ?: "compass",
            onboarded = p[K.onboarded] ?: false,
            onlineSearch = p[K.onlineSearch] ?: true,
        )
    }

    suspend fun setPrayerLocation(loc: PrayerLocation, follow: Boolean) = store.edit { p ->
        p[K.locName] = loc.name
        p[K.locLat] = loc.location.latitude
        p[K.locLng] = loc.location.longitude
        p[K.locZone] = loc.zoneId.id
        loc.countryCode?.let { p[K.locCountry] = it } ?: p.remove(K.locCountry)
        p[K.locSource] = loc.source.name
        p[K.locZoneConfirmed] = loc.zoneConfirmed
        p[K.follow] = follow
    }

    suspend fun setMethod(method: Method, byUser: Boolean) = store.edit {
        it[K.method] = method.name
        if (byUser) it[K.methodByUser] = true
    }

    suspend fun setMadhab(m: AsrMadhab) = store.edit { it[K.madhab] = m.name }
    suspend fun setHighLatitudeRule(r: HighLatRule) = store.edit { it[K.highLat] = r.name }
    suspend fun setPolarRule(r: PolarRule) = store.edit { it[K.polar] = r.name }
    suspend fun setRamadanIsha(on: Boolean) = store.edit { it[K.ramadan] = on }
    suspend fun setHijriAdjustment(days: Int) = store.edit { it[K.hijriAdj] = days.coerceIn(-2, 2) }
    suspend fun setOffset(e: PrayerEvent, minutes: Int) = store.edit { it[K.offset(e)] = minutes.coerceIn(-30, 30) }
    suspend fun setMosqueView(v: String) = store.edit { it[K.mosqueView] = v }
    suspend fun setOnboarded(on: Boolean) = store.edit { it[K.onboarded] = on }
    suspend fun setOnlineSearch(on: Boolean) = store.edit { it[K.onlineSearch] = on }
    suspend fun setReminder(e: PrayerEvent, on: Boolean) = store.edit { p ->
        val cur = p[K.reminders].orEmpty().toMutableSet()
        if (on) cur += e.name else cur -= e.name
        p[K.reminders] = cur
    }
}
