package sa.zood.nearmosque.ui.prayer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sa.zood.nearmosque.AppContainer
import sa.zood.nearmosque.core.AsrMadhab
import sa.zood.nearmosque.core.City
import sa.zood.nearmosque.core.DaySchedule
import sa.zood.nearmosque.core.HighLatRule
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.Method
import sa.zood.nearmosque.core.PolarRule
import sa.zood.nearmosque.core.PrayerCalculator
import sa.zood.nearmosque.core.PrayerEvent
import sa.zood.nearmosque.core.Qibla
import sa.zood.nearmosque.core.Upcoming
import sa.zood.nearmosque.data.AppSettings
import sa.zood.nearmosque.data.PrayerLocation
import sa.zood.nearmosque.platform.LocationPermission
import sa.zood.nearmosque.platform.ReminderScheduler
import sa.zood.nearmosque.ui.theme.SkyPeriod
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

data class PrayerUi(
    val settings: AppSettings? = null,
    val location: PrayerLocation? = null,
    val now: Instant = Instant.EPOCH,
    val today: DaySchedule? = null,
    val tomorrow: DaySchedule? = null,
    val next: Upcoming? = null,
    /** The prayer period in progress (for the sky and the arc), null before today's Fajr. */
    val current: PrayerEvent? = null,
    val fajrEndsAt: Instant? = null,
    val qiblaBearing: Double? = null,
    val qiblaDistance: Double? = null,
    val sky: SkyPeriod = SkyPeriod.NIGHT,
)

sealed interface LocateState {
    data object Idle : LocateState
    data object Locating : LocateState
    data object Denied : LocateState
    data object NoFix : LocateState
}

class PrayerViewModel(private val c: AppContainer) : ViewModel() {
    private val calc = c.calculator
    private var cacheKey: Any? = null
    private var cached: List<DaySchedule> = emptyList()

    private val ticker = flow {
        while (true) {
            emit(c.clock())
            // Wake on the next whole second; the countdown is recomputed from instants each time.
            delay(1000 - (c.clock().toEpochMilli() % 1000))
        }
    }

    val ui: StateFlow<PrayerUi> = combine(c.settings.settings, ticker) { s, now -> build(s, now) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PrayerUi())

    private val _locate = MutableStateFlow<LocateState>(LocateState.Idle)
    val locate: StateFlow<LocateState> = _locate.asStateFlow()

    init {
        // "Follow my location": refresh on launch only if permission was already granted; never prompts.
        viewModelScope.launch {
            val s = c.settings.settings.first()
            if (s.followDevice && c.location.permission() != LocationPermission.DENIED) {
                useDeviceLocation(s.prayerLocation?.name ?: "")
            }
        }
    }

    private fun build(s: AppSettings, now: Instant): PrayerUi {
        val loc = s.prayerLocation ?: return PrayerUi(settings = s, now = now)
        val zone = loc.zoneId
        val today = now.atZone(zone).toLocalDate()
        val key = listOf(loc.location, zone, s.prayer, today)
        if (key != cacheKey) {
            cached = (-1L..1L).map { calc.schedule(loc.location, today.plusDays(it), zone, s.prayer) }
            cacheKey = key
        }
        val next = calc.nextPrayer(cached, now)
        val todaySchedule = cached[1]
        val current = PrayerEvent.entries.lastOrNull { e -> todaySchedule[e]?.let { !it.isAfter(now) } == true }
            ?: if (cached[0][PrayerEvent.ISHA] != null) PrayerEvent.ISHA else null
        return PrayerUi(
            settings = s, location = loc, now = now, today = todaySchedule, tomorrow = cached[2], next = next,
            current = current, fajrEndsAt = calc.fajrEndsAt(todaySchedule, now),
            qiblaBearing = Qibla.bearing(loc.location), qiblaDistance = Qibla.distanceMeters(loc.location),
            sky = SkyPeriod.at(now, todaySchedule[PrayerEvent.SUNRISE], current, hasLocation = true),
        )
    }

    fun chooseCity(city: City, displayName: String) = viewModelScope.launch {
        val s = c.settings.settings.first()
        c.settings.setPrayerLocation(
            PrayerLocation(displayName, city.location, ZoneId.of(city.zoneId), city.countryCode, PrayerLocation.Source.CITY), follow = false,
        )
        if (!s.methodChosenByUser) c.settings.setMethod(PrayerCalculator.suggestedMethod(city.countryCode), byUser = false)
    }

    /** Called after the permission dialog; uses a fresh fix, falls back to a recent one, never to a default city. */
    fun useDeviceLocation(nameForCurrent: String) = viewModelScope.launch {
        if (c.location.permission() == LocationPermission.DENIED) { _locate.value = LocateState.Denied; return@launch }
        _locate.value = LocateState.Locating
        val fix = c.location.currentPosition() ?: c.location.lastKnown(30 * 60_000L)
        if (fix == null) { _locate.value = LocateState.NoFix; return@launch }
        c.devicePosition.value = fix
        val resolver = c.cities.timeZones()
        val zone = withContext(Dispatchers.Default) { resolver.resolve(fix.location, ZoneId.systemDefault()) }
        val s = c.settings.settings.first()
        val name = zone.nearestCity?.takeIf { (zone.distanceMeters ?: Double.MAX_VALUE) < 30_000 }?.name ?: nameForCurrent
        c.settings.setPrayerLocation(
            PrayerLocation(name, fix.location, zone.zoneId, zone.nearestCity?.countryCode, PrayerLocation.Source.DEVICE, zoneConfirmed = !zone.needsConfirmation),
            follow = true,
        )
        if (!s.methodChosenByUser) c.settings.setMethod(PrayerCalculator.suggestedMethod(zone.nearestCity?.countryCode), byUser = false)
        _locate.value = LocateState.Idle
    }

    fun confirmZone() = viewModelScope.launch {
        val s = c.settings.settings.first()
        s.prayerLocation?.let { c.settings.setPrayerLocation(it.copy(zoneConfirmed = true), s.followDevice) }
    }

    fun setZone(zone: ZoneId) = viewModelScope.launch {
        val s = c.settings.settings.first()
        s.prayerLocation?.let { c.settings.setPrayerLocation(it.copy(zoneId = zone, zoneConfirmed = true), s.followDevice) }
    }

    fun setOnboarded(on: Boolean) = viewModelScope.launch { c.settings.setOnboarded(on) }
    fun setOnlineSearch(on: Boolean) = viewModelScope.launch { c.settings.setOnlineSearch(on) }

    fun clearLocateState() { _locate.value = LocateState.Idle }

    fun setMethod(m: Method) = viewModelScope.launch { c.settings.setMethod(m, byUser = true) }
    fun setMadhab(m: AsrMadhab) = viewModelScope.launch { c.settings.setMadhab(m) }
    fun setHighLat(r: HighLatRule) = viewModelScope.launch { c.settings.setHighLatitudeRule(r) }
    fun setPolar(r: PolarRule) = viewModelScope.launch { c.settings.setPolarRule(r) }
    fun setRamadanIsha(on: Boolean) = viewModelScope.launch { c.settings.setRamadanIsha(on) }
    fun setHijriAdjustment(d: Int) = viewModelScope.launch { c.settings.setHijriAdjustment(d) }
    fun setOffset(e: PrayerEvent, m: Int) = viewModelScope.launch { c.settings.setOffset(e, m) }

    fun setReminder(context: android.content.Context, e: PrayerEvent, on: Boolean) = viewModelScope.launch {
        c.settings.setReminder(e, on)
        withContext(Dispatchers.Default) { ReminderScheduler(context).reschedule(c.settings.settings.first()) }
    }

    fun rescheduleReminders(context: android.content.Context) = viewModelScope.launch(Dispatchers.Default) {
        ReminderScheduler(context).reschedule(c.settings.settings.first())
    }

    companion object {
        fun dateOf(instant: Instant, zone: ZoneId): LocalDate = instant.atZone(zone).toLocalDate()
        fun isSameLocation(a: LatLng?, b: LatLng?) = a == b
    }
}
