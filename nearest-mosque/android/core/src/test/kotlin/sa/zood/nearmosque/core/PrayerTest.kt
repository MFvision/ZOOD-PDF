package sa.zood.nearmosque.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime

class PrayerTest {
    private val calc = PrayerCalculator()
    private val fixture = Fixtures.read("shared/fixtures/prayer-times.json").jsonObject
    private val tolerance = fixture["toleranceSeconds"]!!.jsonPrimitive.long

    private fun settingsFor(case: JsonObject) = PrayerSettings(
        method = Method.valueOf(case["method"]!!.jsonPrimitive.content),
        madhab = AsrMadhab.valueOf(case["madhab"]!!.jsonPrimitive.content),
        highLatitudeRule = case["highLatitudeRule"]?.takeIf { it !is JsonNull }?.let { HighLatRule.valueOf(it.jsonPrimitive.content) } ?: HighLatRule.AUTO,
    )

    @Test
    fun goldenFixturesMatchIndependentReference() {
        val failures = mutableListOf<String>()
        var worst = 0L
        for (c in fixture["cases"]!!.jsonArray.map { it.jsonObject }) {
            val id = c["id"]!!.jsonPrimitive.content
            val loc = LatLng(c["latitude"]!!.jsonPrimitive.double, c["longitude"]!!.jsonPrimitive.double)
            val zone = ZoneId.of(c["timeZone"]!!.jsonPrimitive.content)
            val date = LocalDate.parse(c["date"]!!.jsonPrimitive.content)
            val s = calc.schedule(loc, date, zone, settingsFor(c))
            val expected = c["expected"]
            if (expected == null || expected is JsonNull) {
                if (s.status != ScheduleStatus.Unavailable) failures += "$id: expected unavailable, got ${s.status}"
                if (s.times.isNotEmpty()) failures += "$id: times invented for an impossible date"
                continue
            }
            if (s.status != ScheduleStatus.Normal) { failures += "$id: status ${s.status}"; continue }
            for ((key, value) in expected.jsonObject) {
                val event = PrayerEvent.valueOf(key.uppercase())
                val want = OffsetDateTime.parse(value.jsonPrimitive.content).toInstant()
                val got = s[event]!!
                val diff = Math.abs(Duration.between(want, got).seconds)
                worst = maxOf(worst, diff)
                if (diff > tolerance) failures += "$id $key: got ${got.atZone(zone)} want ${want.atZone(zone)} (${diff}s)"
            }
            // Every event lands on (or, for late Isha, just after) the requested civil date.
            assertEquals("$id dhuhr date", date, s[PrayerEvent.DHUHR]!!.atZone(zone).toLocalDate())
        }
        println("ADHAN_VS_REFERENCE_MAX_SECONDS=$worst")
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun polarNightUsesOnlyTheExplicitlySelectedFallback() {
        val tromso = LatLng(69.6492, 18.9553)
        val zone = ZoneId.of("Europe/Oslo")
        val date = LocalDate.of(2026, 12, 21)
        val none = calc.schedule(tromso, date, zone, PrayerSettings())
        assertEquals(ScheduleStatus.Unavailable, none.status)
        val est = calc.schedule(tromso, date, zone, PrayerSettings(polarRule = PolarRule.NEAREST_LATITUDE))
        assertEquals(ScheduleStatus.Estimated(48.5), est.status)
        assertEquals(6, est.times.size)
    }

    @Test
    fun nextPrayerSkipsSunriseAndRollsToTomorrowAfterIsha() {
        val makkah = LatLng(21.4225, 39.8262)
        val zone = ZoneId.of("Asia/Riyadh")
        val s = PrayerSettings(method = Method.UMM_AL_QURA)
        val today = calc.schedule(makkah, LocalDate.of(2026, 10, 3), zone, s)
        // Between Fajr and sunrise: next prayer is Dhuhr, and Fajr is reported as ending at sunrise.
        val afterFajr = today[PrayerEvent.FAJR]!!.plusSeconds(60)
        val next = calc.nextPrayer(makkah, afterFajr, zone, s)!!
        assertEquals(PrayerEvent.DHUHR, next.event)
        assertEquals(today[PrayerEvent.SUNRISE], calc.fajrEndsAt(today, afterFajr))
        // After Isha: tomorrow's Fajr.
        val afterIsha = today[PrayerEvent.ISHA]!!.plusSeconds(60)
        val n2 = calc.nextPrayer(makkah, afterIsha, zone, s)!!
        assertEquals(PrayerEvent.FAJR, n2.event)
        assertTrue(n2.isTomorrow)
        assertEquals(LocalDate.of(2026, 10, 4), n2.at.atZone(zone).toLocalDate())
        assertEquals(today[PrayerEvent.ISHA], n2.periodStart)
    }

    @Test
    fun countdownIsDerivedFromInstantsAcrossDstChange() {
        val london = LatLng(51.5085, -0.1257)
        val zone = ZoneId.of("Europe/London")
        val s = PrayerSettings()
        // 23:30 local on the night clocks go forward (2026-03-29 01:00 UTC).
        val now = ZonedDateTime.of(2026, 3, 28, 23, 30, 0, 0, zone).toInstant()
        val next = calc.nextPrayer(london, now, zone, s)!!
        assertEquals(PrayerEvent.FAJR, next.event)
        val fajr = calc.schedule(london, LocalDate.of(2026, 3, 29), zone, s)[PrayerEvent.FAJR]!!
        assertEquals(fajr, next.at)
        // Wall clock shows ~5:06 BST but only ~4h36m of real time elapse (one hour skipped).
        val remaining = PrayerCalculator.remaining(now, next.at)
        assertTrue(remaining.toMinutes() in 270..280)
    }

    @Test
    fun ummAlQuraRamadanExtendsIshaOnlyInRamadan() {
        val makkah = LatLng(21.4225, 39.8262)
        val zone = ZoneId.of("Asia/Riyadh")
        val s = PrayerSettings(method = Method.UMM_AL_QURA)
        val ramadanDay = LocalDate.of(2026, 3, 1) // 12 Ramadan 1447 (Umm al-Qura)
        assertTrue(HijriCalendar.isRamadan(ramadanDay, 0))
        val r = calc.schedule(makkah, ramadanDay, zone, s)
        assertTrue(r.ramadanIshaApplied)
        assertEquals(120, Duration.between(r[PrayerEvent.MAGHRIB], r[PrayerEvent.ISHA]).toMinutes())
        val normal = calc.schedule(makkah, LocalDate.of(2026, 10, 3), zone, s)
        assertEquals(90, Duration.between(normal[PrayerEvent.MAGHRIB], normal[PrayerEvent.ISHA]).toMinutes())
        val off = calc.schedule(makkah, ramadanDay, zone, s.copy(ramadanIshaExtension = false))
        assertEquals(90, Duration.between(off[PrayerEvent.MAGHRIB], off[PrayerEvent.ISHA]).toMinutes())
    }

    @Test
    fun offsetsShiftOnlyTheirEvent() {
        val loc = LatLng(30.0626, 31.2497)
        val zone = ZoneId.of("Africa/Cairo")
        val d = LocalDate.of(2026, 10, 3)
        val base = calc.schedule(loc, d, zone, PrayerSettings(method = Method.EGYPTIAN))
        val adj = calc.schedule(loc, d, zone, PrayerSettings(method = Method.EGYPTIAN, offsets = mapOf(PrayerEvent.ASR to 3)))
        assertEquals(3, Duration.between(base[PrayerEvent.ASR], adj[PrayerEvent.ASR]).toMinutes())
        assertEquals(base[PrayerEvent.DHUHR], adj[PrayerEvent.DHUHR])
    }

    @Test
    fun hijriDateUsesUmmAlQuraWithAdjustment() {
        val h = HijriCalendar.of(LocalDate.of(2026, 3, 1), 0)!!
        assertEquals(1447, h.year); assertEquals(9, h.month)
        val adj = HijriCalendar.of(LocalDate.of(2026, 3, 1), 1)!!
        assertEquals(h.day + 1, adj.day)
        assertNull(HijriCalendar.of(LocalDate.of(1800, 1, 1), 0))
    }

    @Test
    fun suggestedMethodIsByRegionNotLanguage() {
        assertEquals(Method.UMM_AL_QURA, PrayerCalculator.suggestedMethod("SA"))
        assertEquals(Method.MUSLIM_WORLD_LEAGUE, PrayerCalculator.suggestedMethod("ZA"))
        assertEquals(Method.MUSLIM_WORLD_LEAGUE, PrayerCalculator.suggestedMethod(null))
        assertNotNull(PrayerCalculator.suggestedMethod("TR"))
    }
}
