package sa.zood.nearmosque.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
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

/** Values mirror shared/design/tokens.json (checked by ThemeTokensTest). */
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

    /** Header sky by the period that is current now (keyed by the event that started it). */
    fun sky(current: PrayerEvent?): Pair<Color, Color> = when (current) {
        PrayerEvent.FAJR -> Color(0xFF1B2A4A) to Color(0xFF7A4F6D)
        PrayerEvent.SUNRISE -> Color(0xFF2F6E9A) to Color(0xFF8CC0DE)
        PrayerEvent.DHUHR -> Color(0xFF2F6E9A) to Color(0xFF8CC0DE)
        PrayerEvent.ASR -> Color(0xFF3D6F8F) to Color(0xFFE3B76B)
        PrayerEvent.MAGHRIB -> Color(0xFF2A1B3D) to Color(0xFFC2504A)
        PrayerEvent.ISHA -> Color(0xFF0E2F45) to Color(0xFF24476B)
        null -> Color(0xFF081B29) to Color(0xFF1A4D6E)
    }

    const val cardRadius = 20
    const val sheetRadius = 28
    const val expandedHeader = 360
    const val homeHeader = 236
    const val compactHeader = 72
}

@Immutable
data class ExtraColors(val card: Color, val textSecondary: Color, val accentText: Color)

val LocalExtraColors = staticCompositionLocalOf { ExtraColors(Tokens.cardLight, Tokens.textSecondaryLight, Tokens.goldText) }

@Composable
fun NearMosqueTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
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
