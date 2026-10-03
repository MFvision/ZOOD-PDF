package sa.zood.nearmosque.ui

import android.content.Context
import android.text.format.DateFormat
import androidx.annotation.StringRes
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.Method
import sa.zood.nearmosque.core.PrayerEvent
import java.text.NumberFormat
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.chrono.HijrahChronology
import java.time.chrono.HijrahDate
import java.time.format.DateTimeFormatter
import java.time.format.DecimalStyle
import java.time.format.FormatStyle
import java.util.Locale

/** Locale-aware formatting. Every number, time and date the user sees goes through here. */
object Format {
    fun locale(context: Context): Locale = context.resources.configuration.locales[0] ?: Locale.getDefault()

    fun languageCode(context: Context): String = when (val l = locale(context).language) {
        "in" -> "id"
        else -> l
    }

    @StringRes
    fun prayerName(e: PrayerEvent): Int = when (e) {
        PrayerEvent.FAJR -> R.string.prayer_fajr
        PrayerEvent.SUNRISE -> R.string.prayer_sunrise
        PrayerEvent.DHUHR -> R.string.prayer_dhuhr
        PrayerEvent.ASR -> R.string.prayer_asr
        PrayerEvent.MAGHRIB -> R.string.prayer_maghrib
        PrayerEvent.ISHA -> R.string.prayer_isha
    }

    @StringRes
    fun methodName(m: Method): Int = when (m) {
        Method.MUSLIM_WORLD_LEAGUE -> R.string.method_MUSLIM_WORLD_LEAGUE
        Method.UMM_AL_QURA -> R.string.method_UMM_AL_QURA
        Method.EGYPTIAN -> R.string.method_EGYPTIAN
        Method.KARACHI -> R.string.method_KARACHI
        Method.NORTH_AMERICA -> R.string.method_NORTH_AMERICA
        Method.DUBAI -> R.string.method_DUBAI
        Method.KUWAIT -> R.string.method_KUWAIT
        Method.QATAR -> R.string.method_QATAR
        Method.SINGAPORE -> R.string.method_SINGAPORE
        Method.TURKEY -> R.string.method_TURKEY
        Method.MOON_SIGHTING_COMMITTEE -> R.string.method_MOON_SIGHTING_COMMITTEE
    }

    private fun timeFormatter(context: Context): DateTimeFormatter {
        val loc = locale(context)
        val skeleton = if (DateFormat.is24HourFormat(context)) "Hm" else "hm"
        return DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(loc, skeleton), loc).withDecimalStyle(DecimalStyle.of(loc))
    }

    fun time(context: Context, instant: Instant, zone: ZoneId): String = timeFormatter(context).format(instant.atZone(zone))

    fun gregorian(context: Context, date: LocalDate): String {
        val loc = locale(context)
        return DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(loc).withDecimalStyle(DecimalStyle.of(loc)).format(date)
    }

    fun hijri(context: Context, date: LocalDate, adjustmentDays: Int): String? = runCatching {
        val loc = locale(context)
        val h = HijrahDate.from(date.plusDays(adjustmentDays.toLong()))
        DateTimeFormatter.ofPattern("d MMMM y G", loc).withChronology(HijrahChronology.INSTANCE).withDecimalStyle(DecimalStyle.of(loc)).format(h)
    }.getOrNull()

    /** H:MM:SS (or M:SS under an hour), localized digits. */
    fun countdown(context: Context, d: Duration): String {
        val s = d.seconds.coerceAtLeast(0)
        val h = (s / 3600).toInt()
        val m = ((s % 3600) / 60).toInt()
        val sec = (s % 60).toInt()
        return if (h > 0) context.getString(R.string.duration_hms, h, m, sec) else context.getString(R.string.duration_ms, m, sec)
    }

    /** "50 min, 28 sec" style remaining time in the interface language (hours omitted when zero). */
    fun remainingLong(context: Context, d: Duration): String {
        val s = d.seconds.coerceAtLeast(0)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        val parts = buildList {
            if (h > 0) add(android.icu.util.Measure(h, android.icu.util.MeasureUnit.HOUR))
            if (h > 0 || m > 0) add(android.icu.util.Measure(m, android.icu.util.MeasureUnit.MINUTE))
            add(android.icu.util.Measure(sec, android.icu.util.MeasureUnit.SECOND))
        }
        return android.icu.text.MeasureFormat.getInstance(locale(context), android.icu.text.MeasureFormat.FormatWidth.SHORT)
            .formatMeasures(*parts.toTypedArray())
    }

    fun number(context: Context, value: Double, fractionDigits: Int): String =
        NumberFormat.getNumberInstance(locale(context)).apply {
            minimumFractionDigits = fractionDigits
            maximumFractionDigits = fractionDigits
        }.format(value)

    fun distance(context: Context, meters: Double): String = if (meters < 1000) {
        context.getString(R.string.distance_m, number(context, (Math.round(meters / 10.0) * 10).toDouble(), 0))
    } else {
        context.getString(R.string.distance_km, number(context, meters / 1000.0, if (meters < 10_000) 1 else 0))
    }

    fun degrees(context: Context, deg: Double): String = number(context, deg, 0)

    fun country(context: Context, code: String?): String =
        code?.let { Locale.Builder().setRegion(it).build().getDisplayCountry(locale(context)) }.orEmpty()

    fun zoneName(context: Context, zone: ZoneId): String =
        zone.getDisplayName(java.time.format.TextStyle.FULL, locale(context)) + " (" + zone.id + ")"
}
