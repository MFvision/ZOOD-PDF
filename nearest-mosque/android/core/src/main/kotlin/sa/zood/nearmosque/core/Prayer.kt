package sa.zood.nearmosque.core

import com.batoulapps.adhan2.CalculationMethod
import com.batoulapps.adhan2.Coordinates
import com.batoulapps.adhan2.HighLatitudeRule
import com.batoulapps.adhan2.Madhab
import com.batoulapps.adhan2.PrayerAdjustments
import com.batoulapps.adhan2.PrayerTimes
import com.batoulapps.adhan2.data.DateComponents
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.chrono.HijrahDate
import java.time.temporal.ChronoField

enum class PrayerEvent(val isPrayer: Boolean) {
    FAJR(true), SUNRISE(false), DHUHR(true), ASR(true), MAGHRIB(true), ISHA(true);

    companion object {
        val prayers = entries.filter { it.isPrayer }
    }
}

/** Calculation conventions offered to the user. Names match Adhan and the shared fixtures. */
enum class Method(val adhan: CalculationMethod) {
    MUSLIM_WORLD_LEAGUE(CalculationMethod.MUSLIM_WORLD_LEAGUE),
    UMM_AL_QURA(CalculationMethod.UMM_AL_QURA),
    EGYPTIAN(CalculationMethod.EGYPTIAN),
    KARACHI(CalculationMethod.KARACHI),
    NORTH_AMERICA(CalculationMethod.NORTH_AMERICA),
    DUBAI(CalculationMethod.DUBAI),
    KUWAIT(CalculationMethod.KUWAIT),
    QATAR(CalculationMethod.QATAR),
    SINGAPORE(CalculationMethod.SINGAPORE),
    TURKEY(CalculationMethod.TURKEY),
    MOON_SIGHTING_COMMITTEE(CalculationMethod.MOON_SIGHTING_COMMITTEE),
}

enum class AsrMadhab { SHAFI, HANAFI }

enum class HighLatRule { AUTO, MIDDLE_OF_THE_NIGHT, SEVENTH_OF_THE_NIGHT, TWILIGHT_ANGLE }

/** What to do when the sun does not rise or set on a date (polar day/night). */
enum class PolarRule { UNAVAILABLE, NEAREST_LATITUDE }

data class PrayerSettings(
    val method: Method = Method.MUSLIM_WORLD_LEAGUE,
    val madhab: AsrMadhab = AsrMadhab.SHAFI,
    val highLatitudeRule: HighLatRule = HighLatRule.AUTO,
    val polarRule: PolarRule = PolarRule.UNAVAILABLE,
    /** Minutes added per event, keyed by event. */
    val offsets: Map<PrayerEvent, Int> = emptyMap(),
    /** Umm al-Qura convention: Isha is 120 instead of 90 minutes after Maghrib in Ramadan. */
    val ramadanIshaExtension: Boolean = true,
    /** Days added to the Umm al-Qura Hijri date for display and Ramadan detection (-2..2). */
    val hijriAdjustmentDays: Int = 0,
)

sealed interface ScheduleStatus {
    data object Normal : ScheduleStatus
    /** Times were produced by the user-selected nearest-latitude rule, not the real latitude. */
    data class Estimated(val latitudeUsed: Double) : ScheduleStatus
    /** The convention cannot produce times for this date; nothing is invented. */
    data object Unavailable : ScheduleStatus
}

data class DaySchedule(
    val date: LocalDate,
    val zone: ZoneId,
    val times: Map<PrayerEvent, Instant>,
    val status: ScheduleStatus,
    val ramadanIshaApplied: Boolean = false,
) {
    operator fun get(event: PrayerEvent): Instant? = times[event]
}

data class Upcoming(
    val event: PrayerEvent,
    val at: Instant,
    /** The previous prayer instant (start of the current period), for progress display. */
    val periodStart: Instant?,
    val isTomorrow: Boolean,
)

class PrayerCalculator {

    fun schedule(location: LatLng, date: LocalDate, zone: ZoneId, settings: PrayerSettings): DaySchedule {
        val ramadan = settings.method == Method.UMM_AL_QURA && settings.ramadanIshaExtension &&
            HijriCalendar.isRamadan(date, settings.hijriAdjustmentDays)
        val real = computeForLocalDate(location.latitude, location.longitude, date, zone, settings, ramadan)
        if (real != null) return DaySchedule(date, zone, real, ScheduleStatus.Normal, ramadan)
        if (settings.polarRule == PolarRule.NEAREST_LATITUDE && kotlin.math.abs(location.latitude) > NEAREST_LATITUDE) {
            val lat = if (location.latitude > 0) NEAREST_LATITUDE else -NEAREST_LATITUDE
            val est = computeForLocalDate(lat, location.longitude, date, zone, settings, ramadan)
            if (est != null) return DaySchedule(date, zone, est, ScheduleStatus.Estimated(lat), ramadan)
        }
        return DaySchedule(date, zone, emptyMap(), ScheduleStatus.Unavailable, ramadan)
    }

    /**
     * Next prayer (sunrise is never a prayer). After Isha this is tomorrow's Fajr. Returns null when
     * neither today nor tomorrow can be calculated.
     */
    fun nextPrayer(location: LatLng, now: Instant, zone: ZoneId, settings: PrayerSettings): Upcoming? {
        val today = now.atZone(zone).toLocalDate()
        val days = (-1L..1L).map { schedule(location, today.plusDays(it), zone, settings) }
        return nextPrayer(days, now)
    }

    /** Next prayer from already-computed consecutive days (yesterday, today, tomorrow). */
    fun nextPrayer(days: List<DaySchedule>, now: Instant): Upcoming? {
        if (days.isEmpty()) return null
        val today = now.atZone(days.first().zone).toLocalDate()
        val prayers = days.flatMap { d -> PrayerEvent.prayers.mapNotNull { e -> d[e]?.let { Triple(e, it, d.date) } } }
            .sortedBy { it.second }
        val idx = prayers.indexOfFirst { it.second.isAfter(now) }
        if (idx < 0) return null
        val (event, at, date) = prayers[idx]
        return Upcoming(event, at, prayers.getOrNull(idx - 1)?.second, date.isAfter(today))
    }

    /** Sunrise of the current Fajr period, when now is between Fajr and sunrise. */
    fun fajrEndsAt(schedule: DaySchedule, now: Instant): Instant? {
        val fajr = schedule[PrayerEvent.FAJR] ?: return null
        val sunrise = schedule[PrayerEvent.SUNRISE] ?: return null
        return if (!now.isBefore(fajr) && now.isBefore(sunrise)) sunrise else null
    }

    private fun computeForLocalDate(
        lat: Double, lng: Double, date: LocalDate, zone: ZoneId, settings: PrayerSettings, ramadan: Boolean,
    ): Map<PrayerEvent, Instant>? {
        // Adhan resolves the date on the solar (UTC-anchored) day. Where the civil zone is far from the
        // solar offset (e.g. Apia UTC+13 at 171°W), the result can land on the neighbouring civil date,
        // so try adjacent dates until Dhuhr falls on the requested local date.
        for (shift in longArrayOf(0, -1, 1)) {
            val times = adhan(lat, lng, date.plusDays(shift), settings, ramadan) ?: continue
            val dhuhrDate = times.getValue(PrayerEvent.DHUHR).atZone(zone).toLocalDate()
            if (dhuhrDate == date) return times
        }
        return null
    }

    private fun adhan(lat: Double, lng: Double, date: LocalDate, s: PrayerSettings, ramadan: Boolean): Map<PrayerEvent, Instant>? {
        val base = s.method.adhan.parameters
        val off = s.offsets
        val params = base.copy(
            madhab = if (s.madhab == AsrMadhab.HANAFI) Madhab.HANAFI else Madhab.SHAFI,
            highLatitudeRule = when (s.highLatitudeRule) {
                HighLatRule.AUTO -> null
                HighLatRule.MIDDLE_OF_THE_NIGHT -> HighLatitudeRule.MIDDLE_OF_THE_NIGHT
                HighLatRule.SEVENTH_OF_THE_NIGHT -> HighLatitudeRule.SEVENTH_OF_THE_NIGHT
                HighLatRule.TWILIGHT_ANGLE -> HighLatitudeRule.TWILIGHT_ANGLE
            },
            ishaInterval = if (ramadan && base.ishaInterval > 0) base.ishaInterval + 30 else base.ishaInterval,
            prayerAdjustments = PrayerAdjustments(
                fajr = off[PrayerEvent.FAJR] ?: 0,
                sunrise = off[PrayerEvent.SUNRISE] ?: 0,
                dhuhr = off[PrayerEvent.DHUHR] ?: 0,
                asr = off[PrayerEvent.ASR] ?: 0,
                maghrib = off[PrayerEvent.MAGHRIB] ?: 0,
                isha = off[PrayerEvent.ISHA] ?: 0,
            ),
        )
        val pt = try {
            PrayerTimes(Coordinates(lat, lng), DateComponents(date.year, date.monthValue, date.dayOfMonth), params)
        } catch (_: IllegalStateException) {
            return null
        } catch (_: IllegalArgumentException) {
            return null
        }
        fun j(t: kotlin.time.Instant): Instant = Instant.ofEpochMilli(t.toEpochMilliseconds())
        return linkedMapOf(
            PrayerEvent.FAJR to j(pt.fajr),
            PrayerEvent.SUNRISE to j(pt.sunrise),
            PrayerEvent.DHUHR to j(pt.dhuhr),
            PrayerEvent.ASR to j(pt.asr),
            PrayerEvent.MAGHRIB to j(pt.maghrib),
            PrayerEvent.ISHA to j(pt.isha),
        )
    }

    companion object {
        /** Documented polar fallback latitude ("nearest latitude" rule), user-selected only. */
        const val NEAREST_LATITUDE = 48.5

        /** Countdown parts derived from instants, never from accumulated ticks. */
        fun remaining(now: Instant, target: Instant): Duration =
            Duration.between(now, target).let { if (it.isNegative) Duration.ZERO else it }

        /** Suggest a method for a country (ISO 3166 alpha-2). Language is never a convention. */
        fun suggestedMethod(countryCode: String?): Method = when (countryCode?.uppercase()) {
            "SA", "YE" -> Method.UMM_AL_QURA
            "AE" -> Method.DUBAI
            "KW" -> Method.KUWAIT
            "QA", "BH" -> Method.QATAR
            "EG", "SD", "LY", "SY", "LB", "IQ", "JO", "PS" -> Method.EGYPTIAN
            "PK", "IN", "BD", "AF" -> Method.KARACHI
            "US", "CA" -> Method.NORTH_AMERICA
            "SG", "MY", "ID", "BN" -> Method.SINGAPORE
            "TR" -> Method.TURKEY
            else -> Method.MUSLIM_WORLD_LEAGUE
        }
    }
}

/** Umm al-Qura Hijri calendar (java.time HijrahChronology is the Umm al-Qura variant). */
object HijriCalendar {
    data class HijriDate(val year: Int, val month: Int, val day: Int)

    fun of(date: LocalDate, adjustmentDays: Int): HijriDate? = try {
        val h = HijrahDate.from(date.plusDays(adjustmentDays.toLong()))
        HijriDate(h.get(ChronoField.YEAR), h.get(ChronoField.MONTH_OF_YEAR), h.get(ChronoField.DAY_OF_MONTH))
    } catch (_: java.time.DateTimeException) {
        null // outside the calendar's supported range
    }

    fun isRamadan(date: LocalDate, adjustmentDays: Int): Boolean = of(date, adjustmentDays)?.month == 9
}
