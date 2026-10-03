package sa.zood.nearmosque.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
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
import sa.zood.nearmosque.ui.mosques.MosquesScreen
import sa.zood.nearmosque.ui.mosques.MosquesViewModel
import sa.zood.nearmosque.ui.prayer.CalculationSheet
import sa.zood.nearmosque.ui.prayer.CityPickerSheet
import sa.zood.nearmosque.ui.prayer.PrayerScreen
import sa.zood.nearmosque.ui.prayer.PrayerViewModel
import sa.zood.nearmosque.ui.prayer.QiblaCompassScreen
import sa.zood.nearmosque.ui.settings.SettingsScreen
import sa.zood.nearmosque.ui.theme.Tokens

enum class Tab(val label: Int, val icon: Int) {
    PRAYER(R.string.tab_prayer, R.drawable.ic_tab_prayer),
    MOSQUES(R.string.tab_mosques, R.drawable.ic_tab_mosque),
    ASK(R.string.tab_ask, R.drawable.ic_tab_ask),
}

/** Exactly three destinations. Settings, downloads and sources sit behind the gear on each tab. */
@Composable
fun AppRoot(container: AppContainer, initialTab: Tab = Tab.PRAYER) {
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

    // Heading sensors are collected only while the Prayer & Qibla tab or the compass is on screen
    // (collectAsStateWithLifecycle also stops them when the app is in the background).
    val loc = prayer.location?.location
    val headingFlow = remember(loc, tab, showCompass) {
        if (loc != null && (tab == Tab.PRAYER || showCompass) && !showSettings) container.heading.headings(loc) else flowOf(CompassState.BearingOnly)
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

    Scaffold(
        bottomBar = {
            // Opaque for legibility over scrolling lists; translucency is kept to the prayer header.
            NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(painterResource(t.icon), contentDescription = null) },
                        label = { Text(stringResource(t.label), maxLines = 1) },
                        colors = NavigationBarItemDefaults.colors(indicatorColor = Tokens.gold.copy(alpha = 0.30f)),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize()) {
            when (tab) {
                Tab.PRAYER -> PrayerScreen(
                    prayerVm, prayer, compass, aligned,
                    onOpenSettings = { showSettings = true }, onPickCity = { showCity = true },
                    onOpenCalculation = { showCalc = true }, onOpenCompass = { showCompass = true }, contentPadding = padding,
                )
                Tab.MOSQUES -> MosquesScreen(mosquesVm, onOpenSettings = { showSettings = true }, contentPadding = padding)
                Tab.ASK -> AskScreen(askVm, onOpenSettings = { showSettings = true }, contentPadding = padding)
            }
        }
    }
    if (showSettings) {
        SettingsScreen(container, prayer, onPickCity = { showCity = true }, onOpenCalculation = { showCalc = true }, onClose = { showSettings = false })
    }
    if (showCompass) {
        Dialog(onDismissRequest = { showCompass = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            QiblaCompassScreen(prayer, compass, aligned, onClose = { showCompass = false })
        }
    }
    if (showCity) CityPickerSheet(container, prayerVm, onDismiss = { showCity = false })
    if (showCalc) prayer.settings?.prayer?.let { CalculationSheet(it, prayerVm, onDismiss = { showCalc = false }) }
}
