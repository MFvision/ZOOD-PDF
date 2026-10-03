package sa.zood.nearmosque.ui.onboarding

import android.Manifest
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sa.zood.nearmosque.AppContainer
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.PrayerEvent
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.glass.BLUE
import sa.zood.nearmosque.ui.glass.GlassButton
import sa.zood.nearmosque.ui.glass.GlassButtonText
import sa.zood.nearmosque.ui.glass.GlassCard
import sa.zood.nearmosque.ui.glass.LogoDisc
import sa.zood.nearmosque.ui.glass.MosquePin
import sa.zood.nearmosque.ui.glass.SkyBackdrop
import sa.zood.nearmosque.ui.glass.YouDot
import sa.zood.nearmosque.ui.glass.glass
import sa.zood.nearmosque.ui.glass.reducedMotion
import sa.zood.nearmosque.ui.prayer.ArcMode
import sa.zood.nearmosque.ui.prayer.LocateState
import sa.zood.nearmosque.ui.prayer.PrayerUi
import sa.zood.nearmosque.ui.prayer.PrayerViewModel
import sa.zood.nearmosque.ui.prayer.QiblaArc
import sa.zood.nearmosque.ui.prayer.prayerIcon
import sa.zood.nearmosque.ui.theme.LocalSky
import sa.zood.nearmosque.ui.theme.Tokens
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

private const val PAGES = 6

private val LANGUAGES = listOf("en" to "English", "ar" to "العربية", "ur" to "اردو", "tr" to "Türkçe", "id" to "Bahasa Indonesia", "fr" to "Français", "es" to "Español")

/**
 * First-launch tour on the sky: five animated pages that show how each part works, then a setup page
 * for language and prayer location. Swipe or use the glass buttons; Skip finishes at any time. With
 * animations turned off every illustration shows its final, still frame.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OnboardingScreen(container: AppContainer, vm: PrayerViewModel, ui: PrayerUi, onPickCity: () -> Unit, onFinish: () -> Unit, startPage: Int = 0) {
    val pager = rememberPagerState(initialPage = startPage.coerceIn(0, PAGES - 1)) { PAGES }
    val scope = rememberCoroutineScope()
    BackHandler(enabled = pager.currentPage > 0) { scope.launch { pager.animateScrollToPage(pager.currentPage - 1) } }
    Box(Modifier.fillMaxSize()) {
        SkyBackdrop(LocalSky.current, Modifier.fillMaxSize(), horizon = 0.8f)
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                if (pager.currentPage < PAGES - 1) GlassButton(onClick = onFinish) { GlassButtonText(stringResource(R.string.onb_skip)) }
            }
            HorizontalPager(pager, Modifier.weight(1f)) { page ->
                when (page) {
                    0 -> Page(stringResource(R.string.onb_welcome_title), stringResource(R.string.onb_welcome_body)) { WelcomeArt() }
                    1 -> Page(stringResource(R.string.onb_prayer_title), stringResource(R.string.onb_prayer_body)) { PrayerArt() }
                    2 -> Page(stringResource(R.string.onb_qibla_title), stringResource(R.string.onb_qibla_body)) { QiblaArt() }
                    3 -> Page(stringResource(R.string.onb_mosque_title), stringResource(R.string.onb_mosque_body)) { MosqueArt() }
                    4 -> Page(stringResource(R.string.onb_ask_title), stringResource(R.string.onb_ask_body)) { AskArt() }
                    else -> SetupPage(vm, ui, onPickCity)
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (pager.currentPage > 0) {
                    GlassButton(onClick = { scope.launch { pager.animateScrollToPage(pager.currentPage - 1) } }, modifier = Modifier.semantics { contentDescription = "" }) {
                        Icon(rememberVectorPainter(Icons.AutoMirrored.Filled.KeyboardArrowLeft), contentDescription = stringResource(R.string.onb_back))
                    }
                } else {
                    Spacer(Modifier.size(64.dp, 48.dp))
                }
                Spacer(Modifier.weight(1f))
                Dots(pager.currentPage)
                Spacer(Modifier.weight(1f))
                val last = pager.currentPage == PAGES - 1
                GlassButton(onClick = { if (last) onFinish() else scope.launch { pager.animateScrollToPage(pager.currentPage + 1) } }, prominent = true) {
                    GlassButtonText(stringResource(if (last) R.string.onb_start else R.string.onb_next))
                }
            }
        }
    }
}

@Composable
private fun Dots(index: Int) {
    val label = stringResource(R.string.onb_page_a11y, index + 1, PAGES)
    Row(
        Modifier.glass(RoundedCornerShape(50), shadow = 4.dp).padding(horizontal = 12.dp, vertical = 10.dp).animateContentSize().clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        repeat(PAGES) { i ->
            Box(Modifier.size(if (i == index) 22.dp else 7.dp, 7.dp).background(if (i == index) Tokens.gold else Color.White.copy(alpha = 0.4f), RoundedCornerShape(50)))
        }
    }
}

@Composable
private fun Page(title: String, body: String, art: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.fillMaxWidth().widthIn(max = 420.dp).height(300.dp), contentAlignment = Alignment.Center) { art() }
        Spacer(Modifier.height(20.dp))
        Text(title, color = Color.White, style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold), textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(12.dp))
        Text(body, color = Color.White.copy(alpha = 0.88f), style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Normal), textAlign = TextAlign.Center)
    }
}

/** Phase 0…1 of a looping illustration; 1 (final frame) when animations are off. */
@Composable
private fun phase(periodMs: Int): Float = sa.zood.nearmosque.ui.glass.loopingFloat(!reducedMotion(), periodMs, reverse = false, label = "loop", still = 1f)

private fun ease(x: Float): Float { val t = x.coerceIn(0f, 1f); return t * t * (3 - 2 * t) }

@Composable
private fun WelcomeArt() {
    val p = phase(3200)
    Box(Modifier.clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(280.dp)) {
            repeat(3) { i ->
                val k = (p + i / 3f) % 1f
                drawCircle(Tokens.gold.copy(alpha = 0.6f * (1 - k)), (55.dp.toPx() + 80.dp.toPx() * k), style = Stroke(2.dp.toPx()))
            }
        }
        LogoDisc(glow = true, size = 110.dp)
    }
}

@Composable
private fun PrayerArt() {
    val p = phase(6000)
    val events = listOf(PrayerEvent.FAJR, PrayerEvent.DHUHR, PrayerEvent.ASR, PrayerEvent.MAGHRIB, PrayerEvent.ISHA)
    val active = (p * 5).toInt().coerceAtMost(4)
    Column(Modifier.clearAndSetSemantics { }, horizontalAlignment = Alignment.CenterHorizontally) {
        Canvas(Modifier.size(240.dp, 80.dp)) {
            val c = Offset(size.width / 2, size.height + 40.dp.toPx())
            val r = 110.dp.toPx()
            drawArc(Color.White.copy(alpha = 0.4f), -160f, 140f, false, Offset(c.x - r, c.y - r), androidx.compose.ui.geometry.Size(2 * r, 2 * r), style = Stroke(2.dp.toPx()))
            val a = Math.toRadians((-70 + 140 * ease(p)).toDouble())
            val m = Offset(c.x + r * sin(a).toFloat(), c.y - r * cos(a).toFloat())
            drawCircle(Tokens.gold.copy(alpha = 0.4f), 16.dp.toPx(), m)
            drawCircle(Tokens.gold, 9.dp.toPx(), m)
        }
        Spacer(Modifier.height(10.dp))
        GlassCard(Modifier.width(250.dp), padding = 6.dp) {
            events.forEachIndexed { i, e ->
                val on = i == active
                Row(
                    Modifier.fillMaxWidth().height(32.dp).background(if (on) Tokens.gold.copy(alpha = 0.15f) else Color.Transparent, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(painterResource(prayerIcon(e)), contentDescription = null, tint = if (on) Tokens.gold else Color.White, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(stringResource(Format.prayerName(e)), color = if (on) Tokens.gold else Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal))
                }
            }
        }
    }
}

@Composable
private fun QiblaArt() {
    val p = phase(5000)
    val angle = if (p < 0.65f) 75.0 * (1 - ease(p / 0.65f)) else 0.0
    Box(Modifier.width(280.dp).clearAndSetSemantics { }) {
        QiblaArc(angle, ArcMode.LIVE, aligned = p >= 0.65f, springs = false) {
            Icon(painterResource(R.drawable.ic_phone_outline), contentDescription = null, tint = Color.White, modifier = Modifier.size(64.dp).rotate((-angle * 0.4).toFloat()).offset(y = 30.dp))
        }
    }
}

@Composable
private fun MosqueArt() {
    val p = phase(5000)
    val pins = listOf(0.72f to 0.28f, 0.25f to 0.32f, 0.78f to 0.7f, 0.3f to 0.74f, 0.55f to 0.15f)
    Box(Modifier.size(280.dp).glass(CircleShape).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            for (k in 1..2) drawCircle(Color.White.copy(alpha = 0.22f), size.minDimension / 2 * k / 3f, style = Stroke(1.dp.toPx()))
            val t = ease((p - 0.45f) / 0.3f)
            val target = Offset(pins[0].first * size.width, pins[0].second * size.height)
            drawLine(Tokens.gold, center, center + (target - center) * t, 3.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(14f, 14f)))
        }
        pins.forEachIndexed { i, (x, y) ->
            val shown = ease((p - i * 0.07f) / 0.15f)
            Box(Modifier.offset { IntOffset(((x - 0.5f) * 280.dp.roundToPx()).roundToInt(), ((y - 0.5f) * 280.dp.roundToPx()).roundToInt()) }.scale(shown * (if (i == 0 && p > 0.75f) 1.2f else 1f))) {
                MosquePin(i == 0, size = 36.dp)
            }
        }
        YouDot()
    }
}

@Composable
private fun AskArt() {
    val p = phase(6000)
    Column(Modifier.width(300.dp).clearAndSetSemantics { }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val q = ease(p / 0.15f)
        Text(
            stringResource(R.string.onb_demo_question), color = Color.White, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.align(Alignment.End).alpha(q).offset(y = (12 * (1 - q)).dp)
                .glass(RoundedCornerShape(18.dp), tint = Tokens.navy.copy(alpha = 0.5f), shadow = 4.dp).padding(horizontal = 14.dp, vertical = 10.dp),
        )
        if (p > 0.2f && p < 0.4f) {
            Row(Modifier.glass(RoundedCornerShape(50), shadow = 4.dp).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                repeat(3) { i -> Box(Modifier.size(7.dp).alpha(0.3f + 0.7f * abs(sin((p * 20 + i) * 1.2f))).background(Color.White, CircleShape)) }
            }
        }
        val c = ease((p - 0.4f) / 0.15f)
        GlassCard(Modifier.alpha(c).offset(y = (20 * (1 - c)).dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_book), contentDescription = null, tint = Tokens.gold, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Qur’an 13:28", color = Tokens.gold, style = MaterialTheme.typography.titleSmall)
            }
            Text(stringResource(R.string.supporting_passage), color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.bodySmall)
            Text(
                "أَلَا بِذِكْرِ اللَّهِ تَطْمَئِنُّ الْقُلُوبُ", color = Color.White, style = MaterialTheme.typography.titleLarge.copy(textDirection = androidx.compose.ui.text.style.TextDirection.Rtl),
                modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.End,
            )
        }
    }
}

/** Last page: language and prayer location, both changeable later in Settings. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SetupPage(vm: PrayerViewModel, ui: PrayerUi, onPickCity: () -> Unit) {
    val context = LocalContext.current
    val locate by vm.locate.collectAsStateWithLifecycle()
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        vm.useDeviceLocation(context.getString(R.string.location_current))
    }
    val current = Format.languageCode(context)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
        Text(stringResource(R.string.onb_setup_title), color = Color.White, style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold), modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.onb_setup_body), color = Color.White.copy(alpha = 0.88f), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(18.dp))
        Text(stringResource(R.string.language), color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            LANGUAGES.forEach { (code, name) ->
                val on = code == current
                Text(
                    name, color = if (on) Tokens.navyNight else Color.White, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal),
                    modifier = Modifier.heightIn(min = 48.dp).glass(RoundedCornerShape(50), tint = if (on) Tokens.gold else null, shadow = 4.dp)
                        .clickable(role = Role.RadioButton) { AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(code)) }
                        .semantics { selected = on }
                        .padding(horizontal = 16.dp, vertical = 13.dp),
                )
            }
        }
        Spacer(Modifier.height(18.dp))
        Text(stringResource(R.string.location_section), color = Color.White, style = MaterialTheme.typography.titleMedium)
        ui.location?.let {
            Spacer(Modifier.height(6.dp))
            Text(stringResource(R.string.onb_location_set, it.name), color = Tokens.gold, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
        }
        Spacer(Modifier.height(10.dp))
        GlassButton(
            onClick = { permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
            prominent = true, enabled = locate != LocateState.Locating, modifier = Modifier.fillMaxWidth(),
        ) { GlassButtonText(stringResource(if (locate == LocateState.Locating) R.string.locating else R.string.use_my_location), painterResource(R.drawable.ic_pin)) }
        Spacer(Modifier.height(10.dp))
        GlassButton(onClick = onPickCity, modifier = Modifier.fillMaxWidth()) { GlassButtonText(stringResource(R.string.search_city)) }
        when (locate) {
            LocateState.Denied -> Text(stringResource(R.string.location_denied), color = Color(0xFFF2B8B5), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
            LocateState.NoFix -> Text(stringResource(R.string.location_fix_failed), color = Color(0xFFF2B8B5), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
            else -> Unit
        }
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.online_search_body), color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(24.dp))
    }
}
