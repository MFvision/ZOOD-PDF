package sa.zood.nearmosque.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.flowOf
import sa.zood.nearmosque.AppContainer
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.AlignmentDetector
import sa.zood.nearmosque.core.Angles
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.ui.ask.AskScreen
import sa.zood.nearmosque.ui.ask.AskViewModel
import sa.zood.nearmosque.ui.glass.SkyBackdrop
import sa.zood.nearmosque.ui.glass.glass
import sa.zood.nearmosque.ui.mosques.MosquesScreen
import sa.zood.nearmosque.ui.mosques.MosquesViewModel
import sa.zood.nearmosque.ui.onboarding.OnboardingScreen
import sa.zood.nearmosque.ui.prayer.CalculationSheet
import sa.zood.nearmosque.ui.prayer.CityPickerSheet
import sa.zood.nearmosque.ui.prayer.PrayerScreen
import sa.zood.nearmosque.ui.prayer.PrayerViewModel
import sa.zood.nearmosque.ui.prayer.QiblaCompassScreen
import sa.zood.nearmosque.ui.settings.SettingsScreen
import sa.zood.nearmosque.ui.theme.LocalSky
import sa.zood.nearmosque.ui.theme.Sky
import sa.zood.nearmosque.ui.theme.Tokens

enum class Tab(val label: Int, val icon: Int, val horizon: Float) {
    PRAYER(R.string.tab_prayer, R.drawable.ic_tab_prayer, 0.64f),
    MOSQUES(R.string.tab_mosques, R.drawable.ic_tab_mosque, 0.42f),
    ASK(R.string.tab_ask_short, R.drawable.ic_tab_ask, 0.30f),
}

/**
 * Exactly three destinations on a floating glass tab bar, all over one animated sky that follows the
 * prayer period (the horizon glides between tabs). Settings, downloads and sources sit behind the
 * gear on each tab. First launch shows the animated tour.
 */
@Composable
fun AppRoot(container: AppContainer, initialTab: Tab = Tab.PRAYER, showOnboarding: Boolean? = null, onboardingPage: Int = 0) {
    val factory = remember(container) {
        viewModelFactory {
            initializer { PrayerViewModel(container) }
            initializer { MosquesViewModel(container) }
            initializer { AskViewModel(container) }
        }
    }
    val prayerVm: PrayerViewModel = viewModel(factory = factory)
    val mosquesVm: MosquesViewModel = viewModel(factory = factory)
    val askVm: AskViewModel = viewModel(factory = factory)
    var tab by rememberSaveable { mutableStateOf(initialTab) }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var showCity by rememberSaveable { mutableStateOf(false) }
    var showCalc by rememberSaveable { mutableStateOf(false) }
    var showCompass by rememberSaveable { mutableStateOf(false) }
    val prayer by prayerVm.ui.collectAsStateWithLifecycle()

    // Heading sensors run only while a compass-bearing screen is visible (and the app is in the foreground).
    val loc = prayer.location?.location
    val headingFlow = remember(loc, tab, showCompass, showSettings) {
        if (loc != null && (tab != Tab.ASK || showCompass) && !showSettings) container.heading.headings(loc) else flowOf(CompassState.BearingOnly)
    }
    val compass by headingFlow.collectAsStateWithLifecycle<CompassState>(CompassState.BearingOnly)
    val detector = remember { AlignmentDetector() }
    val haptics = LocalHapticFeedback.current
    var aligned by remember { mutableStateOf(false) }
    LaunchedEffect(compass, prayer.qiblaBearing) {
        val live = compass as? CompassState.Live
        val bearing = prayer.qiblaBearing
        if (live == null || bearing == null || live.accuracyDeg == null) { aligned = false; detector.update(180.0, null); return@LaunchedEffect }
        if (detector.update(Angles.relativeToQibla(bearing, live.headingTrue), live.accuracyDeg)) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        aligned = detector.aligned
    }

    BackHandler(enabled = tab != Tab.PRAYER && !showSettings) { tab = Tab.PRAYER }

    val sky = Sky.of(prayer.sky)
    val horizon by animateFloatAsState(tab.horizon, spring(dampingRatio = 0.86f, stiffness = 120f), label = "horizon")
    CompositionLocalProvider(LocalSky provides sky) {
        Box(Modifier.fillMaxSize().background(sky.low)) {
            SkyBackdrop(sky, Modifier.fillMaxSize(), horizon = horizon, skyline = tab == Tab.ASK)
            when (tab) {
                Tab.PRAYER -> PrayerScreen(
                    prayerVm, prayer, compass, aligned,
                    onOpenSettings = { showSettings = true }, onPickCity = { showCity = true },
                    onOpenCalculation = { showCalc = true }, onOpenCompass = { showCompass = true },
                )
                Tab.MOSQUES -> MosquesScreen(mosquesVm, compass, onOpenSettings = { showSettings = true })
                Tab.ASK -> AskScreen(askVm, onOpenSettings = { showSettings = true })
            }
            GlassTabBar(tab, onSelect = { tab = it }, modifier = Modifier.align(Alignment.BottomCenter))
        }

        if (showSettings) {
            SettingsScreen(
                container, prayer, onPickCity = { showCity = true }, onOpenCalculation = { showCalc = true },
                onReplayTour = { showSettings = false; prayerVm.setOnboarded(false) },
                onOnlineSearch = prayerVm::setOnlineSearch,
                onClose = { showSettings = false },
            )
        }
        if (showCompass) {
            Dialog(onDismissRequest = { showCompass = false }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
                QiblaCompassScreen(prayer, compass, aligned, onClose = { showCompass = false })
            }
        }
        val onboard = showOnboarding ?: (prayer.settings?.onboarded == false)
        AnimatedVisibility(onboard, enter = fadeIn(tween(300)), exit = fadeOut(tween(400))) {
            OnboardingScreen(container, prayerVm, prayer, onPickCity = { showCity = true }, onFinish = { prayerVm.setOnboarded(true) }, startPage = onboardingPage)
        }
        if (showCity) CityPickerSheet(container, prayerVm, onDismiss = { showCity = false })
        if (showCalc) prayer.settings?.prayer?.let { CalculationSheet(it, prayerVm, onDismiss = { showCalc = false }) }
    }
}

/** Floating glass capsule with the three tabs; the selected one sits in a gold glass bubble. */
@Composable
private fun GlassTabBar(selected: Tab, onSelect: (Tab) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.navigationBarsPadding().padding(bottom = 10.dp).widthIn(max = 420.dp)
            .padding(horizontal = 20.dp)
            .glass(RoundedCornerShape(50), tint = LocalSky.current.glassTint)
            .padding(6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Tab.entries.forEach { t ->
            val on = t == selected
            val bg by animateFloatAsState(if (on) 1f else 0f, tween(250), label = "tab")
            Column(
                Modifier.weight(1f).heightIn(min = 56.dp)
                    .background(Tokens.gold.copy(alpha = 0.22f * bg), RoundedCornerShape(50))
                    .clickable(role = Role.Tab) { onSelect(t) }
                    .semantics { this.selected = on }
                    .padding(horizontal = 6.dp, vertical = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Icon(painterResource(t.icon), contentDescription = null, tint = if (on) Tokens.gold else Color.White, modifier = Modifier.size(24.dp))
                Text(
                    stringResource(t.label), color = if (on) Tokens.gold else Color.White.copy(alpha = 0.9f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium, fontSize = 11.sp),
                )
            }
        }
    }
}
