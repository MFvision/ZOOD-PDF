package sa.zood.nearmosque

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import com.github.takahirom.roborazzi.captureRoboImage
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.Method
import sa.zood.nearmosque.data.PrayerLocation
import sa.zood.nearmosque.ui.AppRoot
import sa.zood.nearmosque.ui.Tab
import sa.zood.nearmosque.ui.theme.NearMosqueTheme
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Renders the real screens (real database, packs, calculations) at a fixed instant for visual review.
 * Output: PNG files in app/build/screenshots.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w393dp-h852dp-xxhdpi", application = android.app.Application::class)
class ScreenshotTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val capeTown = PrayerLocation("Cape Town", LatLng(-33.92584, 18.42322), ZoneId.of("Africa/Johannesburg"), "ZA", PrayerLocation.Source.CITY)
    // 2026-10-03 05:30 SAST: between Fajr and sunrise, like the reference screenshot's situation.
    private val fixed = ZonedDateTime.of(2026, 10, 3, 5, 30, 28, 0, ZoneId.of("Africa/Johannesburg")).toInstant()

    private fun container(location: PrayerLocation? = capeTown): AppContainer = runBlocking {
        val c = AppContainer(compose.activity, inMemoryDb = true, clock = { fixed }, settingsFile = java.io.File.createTempFile("settings", ".preferences_pb").also { it.delete() })
        c.packs.ensureBuiltins()
        c.start()
        if (location != null) {
            c.settings.setPrayerLocation(location, follow = false)
            c.settings.setMethod(Method.MUSLIM_WORLD_LEAGUE, byUser = false)
        }
        c
    }

    private fun shoot(name: String, tab: Tab, location: PrayerLocation? = capeTown, after: () -> Unit = {}) {
        val c = container(location)
        compose.setContent { NearMosqueTheme(dark = false) { AppRoot(c, initialTab = tab) } }
        compose.waitForIdle()
        after()
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("build/screenshots/$name.png")
    }

    @Test fun prayerEnglish() = shoot("prayer_en", Tab.PRAYER)

    @Test @Config(qualifiers = "ar-w393dp-h852dp-xxhdpi")
    fun prayerArabicRtl() = shoot("prayer_ar", Tab.PRAYER)

    @Test fun firstLaunchNoLocation() = shoot("prayer_first_launch_en", Tab.PRAYER, location = null)

    @Test fun prayerExpanded() = shoot("prayer_expanded_en", Tab.PRAYER) {
        compose.onNodeWithContentDescription("Expand").performClick()
    }

    @Test fun mosquesList() = shoot("mosques_en", Tab.MOSQUES)

    @Test @Config(qualifiers = "ur-w393dp-h852dp-xxhdpi")
    fun mosquesUrdu() = shoot("mosques_ur", Tab.MOSQUES)

    @Test fun askHome() = shoot("ask_en", Tab.ASK)

    @Test fun askAnswer() = shoot("ask_answer_en", Tab.ASK) {
        compose.waitUntil(15_000) { runCatching { compose.onNodeWithText("How do I perform wudu (ablution)?").assertExists() }.isSuccess }
        compose.onNodeWithText("How do I perform wudu (ablution)?").performClick()
        compose.waitUntil(15_000) { runCatching { compose.onNodeWithText("Sources").assertExists() }.isSuccess }
    }

    @Test @Config(qualifiers = "ar-w393dp-h852dp-xxhdpi")
    fun askAnswerArabic() = shoot("ask_answer_ar", Tab.ASK) {
        compose.waitUntil(15_000) { runCatching { compose.onNodeWithText("كيف أتوضأ؟").assertExists() }.isSuccess }
        compose.onNodeWithText("كيف أتوضأ؟").performClick()
        compose.waitUntil(15_000) { runCatching { compose.onNodeWithText("المصادر").assertExists() }.isSuccess }
    }

    @Test @Config(qualifiers = "tr-w393dp-h852dp-xxhdpi")
    fun askTurkish() = shoot("ask_tr", Tab.ASK)
}
