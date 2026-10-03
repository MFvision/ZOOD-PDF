package sa.zood.nearmosque.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import sa.zood.nearmosque.core.PrayerEvent

/** Values mirror shared/design/tokens.json (checked by tools/check_tokens.py). The app always sits on a sky, so it uses the dark scheme. */
object Tokens {
    val navy = Color(0xFF1A4D6E)
    val navyDeep = Color(0xFF0E2F45)
    val navyNight = Color(0xFF081B29)
    val gold = Color(0xFFD4A843)
    val goldDeep = Color(0xFFB8922F)
    val goldText = Color(0xFF8A6A1C)
    val sand = Color(0xFFF4EEDF)
    val surfaceLight = Color(0xFFF2F2F7)
    val cardLight = Color(0xFFFFFFFF)
    val textLight = Color(0xFF10202B)
    val textSecondaryLight = Color(0xFF4A5A66)
    val surfaceDark = Color(0xFF0B1620)
    val cardDark = Color(0xFF14232F)
    val textDark = Color(0xFFF1F4F6)
    val textSecondaryDark = Color(0xFFA9B6C0)
    val danger = Color(0xFFB3261E)

    const val cardRadius = 26
    const val sheetRadius = 28
    const val discSize = 76
    const val compactHeight = 64
}

/** The sky follows the prayer period in progress. Colours mirror shared/design/tokens.json ("sky"). */
enum class SkyPeriod {
    NIGHT, FAJR, SUNRISE, DAY, ASR, MAGHRIB, ISHA;

    val hasStars: Boolean get() = this == NIGHT || this == ISHA || this == FAJR

    companion object {
        fun at(now: java.time.Instant, sunrise: java.time.Instant?, current: PrayerEvent?, hasLocation: Boolean): SkyPeriod {
            if (!hasLocation) return NIGHT
            return when (current) {
                PrayerEvent.FAJR -> FAJR
                PrayerEvent.SUNRISE -> if (sunrise != null && java.time.Duration.between(sunrise, now).seconds < 3600) SUNRISE else DAY
                PrayerEvent.DHUHR -> DAY
                PrayerEvent.ASR -> ASR
                PrayerEvent.MAGHRIB -> MAGHRIB
                PrayerEvent.ISHA -> ISHA
                null -> NIGHT
            }
        }
    }
}

@Immutable
data class Sky(val period: SkyPeriod, val top: Color, val mid: Color, val glow: Color, val low: Color) {
    /** Tint for glass over this sky, so white text stays legible where the horizon is bright. */
    val glassTint: Color get() = low.copy(alpha = 0.35f)

    companion object {
        fun of(p: SkyPeriod): Sky = when (p) {
            SkyPeriod.NIGHT -> Sky(p, Color(0xFF081B29), Color(0xFF12304A), Color(0xFF2C4C7A), Color(0xFF0B1A2C))
            SkyPeriod.FAJR -> Sky(p, Color(0xFF141E3C), Color(0xFF3A3566), Color(0xFFC98A8A), Color(0xFF1E2242))
            SkyPeriod.SUNRISE -> Sky(p, Color(0xFF1C3F7A), Color(0xFF345A99), Color(0xFFF3C98B), Color(0xFF26365E))
            SkyPeriod.DAY -> Sky(p, Color(0xFF1C3F7A), Color(0xFF2F5590), Color(0xFFF7E0A8), Color(0xFF22406E))
            SkyPeriod.ASR -> Sky(p, Color(0xFF173F5A), Color(0xFF23606F), Color(0xFFF2D27A), Color(0xFF1D3E4E))
            SkyPeriod.MAGHRIB -> Sky(p, Color(0xFF1B1F45), Color(0xFF4A2F5E), Color(0xFFF08A5D), Color(0xFF2A1E3E))
            SkyPeriod.ISHA -> Sky(p, Color(0xFF0A1430), Color(0xFF16264D), Color(0xFF3A4E86), Color(0xFF0B1530))
        }
    }
}

val LocalSky = staticCompositionLocalOf { Sky.of(SkyPeriod.NIGHT) }

@Immutable
data class ExtraColors(val card: Color, val textSecondary: Color, val accentText: Color)

val LocalExtraColors = staticCompositionLocalOf { ExtraColors(Tokens.cardLight, Tokens.textSecondaryLight, Tokens.goldText) }

@Composable
fun NearMosqueTheme(dark: Boolean = true, content: @Composable () -> Unit) {
    val scheme = if (dark) {
        darkColorScheme(
            primary = Tokens.gold, onPrimary = Tokens.navyNight, secondary = Color(0xFF8CC0DE),
            background = Tokens.surfaceDark, surface = Tokens.surfaceDark, surfaceContainer = Tokens.cardDark,
            onBackground = Tokens.textDark, onSurface = Tokens.textDark, onSurfaceVariant = Tokens.textSecondaryDark,
            error = Color(0xFFF2B8B5),
        )
    } else {
        lightColorScheme(
            primary = Tokens.navy, onPrimary = Color.White, secondary = Tokens.goldDeep,
            background = Tokens.surfaceLight, surface = Tokens.surfaceLight, surfaceContainer = Tokens.cardLight,
            onBackground = Tokens.textLight, onSurface = Tokens.textLight, onSurfaceVariant = Tokens.textSecondaryLight,
            error = Tokens.danger,
        )
    }
    val extra = if (dark) ExtraColors(Tokens.cardDark, Tokens.textSecondaryDark, Tokens.gold)
    else ExtraColors(Tokens.cardLight, Tokens.textSecondaryLight, Tokens.goldText)
    val base = Typography()
    val typography = base.copy(
        displaySmall = base.displaySmall.copy(fontWeight = FontWeight.SemiBold),
        headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
    )
    androidx.compose.runtime.CompositionLocalProvider(LocalExtraColors provides extra) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}

/** Quranic Arabic is shown larger with generous line height; it always keeps its own direction. */
val QuranTextStyle = TextStyle(fontSize = 22.sp, lineHeight = 40.sp)

/**
 * Data from packs (mosque names, addresses, city names) keeps its own direction, so a Latin address
 * stays in order inside an Arabic or Urdu layout. Interface strings keep the layout direction.
 */
val DataDirection = androidx.compose.ui.text.style.TextDirection.Content
