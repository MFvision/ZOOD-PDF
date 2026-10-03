package sa.zood.nearmosque.ui.prayer

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.core.PrayerEvent
import sa.zood.nearmosque.core.ScheduleStatus
import sa.zood.nearmosque.data.PrayerLocation
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.glass.GlassButton
import sa.zood.nearmosque.ui.glass.GlassButtonText
import sa.zood.nearmosque.ui.glass.GlassCard
import sa.zood.nearmosque.ui.glass.bottomBarPadding
import sa.zood.nearmosque.ui.glass.glass
import sa.zood.nearmosque.ui.theme.Tokens

/**
 * Prayer & Qibla: the sky for the current prayer period (drawn by AppRoot), the Qibla arc with the
 * next prayer inside, today's times on glass. Scrolling past the arc pins a compact glass summary.
 */
@Composable
fun PrayerScreen(
    vm: PrayerViewModel,
    ui: PrayerUi,
    compass: CompassState,
    aligned: Boolean,
    onOpenSettings: () -> Unit,
    onPickCity: () -> Unit,
    onOpenCalculation: () -> Unit,
    onOpenCompass: () -> Unit,
) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val showCompact by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 900 } }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        vm.useDeviceLocation(context.getString(R.string.location_current))
    }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { vm.rescheduleReminders(context) }
    val locate by vm.locate.collectAsStateWithLifecycle()

    LaunchedEffect(ui.settings?.reminders) { if (ui.settings?.reminders?.isNotEmpty() == true) vm.rescheduleReminders(context) }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().statusBarsPadding(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = bottomBarPadding(16.dp).calculateBottomPadding()),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item("hero") { PrayerHero(ui, compass, aligned, onLocation = onPickCity, onSettings = onOpenSettings, onQibla = onOpenCompass) }
            val loc = ui.location
            if (loc == null) {
                item("choose") {
                    ChooseLocationCard(
                        locating = locate == LocateState.Locating,
                        error = when (locate) {
                            LocateState.Denied -> stringResource(R.string.location_denied)
                            LocateState.NoFix -> stringResource(R.string.location_fix_failed)
                            else -> null
                        },
                        onUseLocation = { locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
                        onPickCity = onPickCity,
                    )
                }
                return@LazyColumn
            }
            if (ui.today?.status is ScheduleStatus.Estimated) {
                item("estimated") {
                    Text(
                        stringResource(R.string.estimated_badge), color = Tokens.gold, style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.glass(RoundedCornerShape(50), shadow = 4.dp).padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }
            if (!loc.zoneConfirmed) item("zone") { ZoneConfirmCard(loc, onConfirm = vm::confirmZone, onChange = onPickCity) }
            val today = ui.today
            if (today != null && today.status == ScheduleStatus.Unavailable) {
                item("polar") { PolarCard(onUseNearest = { vm.setPolar(sa.zood.nearmosque.core.PolarRule.NEAREST_LATITUDE) }) }
            }
            if (today != null && today.status != ScheduleStatus.Unavailable) {
                item("schedule") {
                    ScheduleCard(
                        ui = ui,
                        reminders = ui.settings?.reminders.orEmpty(),
                        onToggleReminder = { e, on ->
                            if (on && Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                            vm.setReminder(context, e, on)
                        },
                    )
                }
            }
            item("dates") { DatesCard(ui, onOpenCalculation) }
        }
        AnimatedVisibility(
            visible = showCompact && ui.next != null,
            enter = fadeIn() + slideInVertically { -it }, exit = fadeOut() + slideOutVertically { -it },
            modifier = Modifier.statusBarsPadding().padding(horizontal = 16.dp, vertical = 6.dp),
        ) {
            CompactPrayerBar(ui, compass) { scope.launch { listState.animateScrollToItem(0) } }
        }
    }
}

@Composable
private fun ChooseLocationCard(locating: Boolean, error: String?, onUseLocation: () -> Unit, onPickCity: () -> Unit) {
    GlassCard(padding = 20.dp) {
        Text(stringResource(R.string.choose_city_title), style = MaterialTheme.typography.titleLarge, color = Color.White, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(6.dp))
        Text(stringResource(R.string.choose_city_body), style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = 0.85f))
        Spacer(Modifier.height(16.dp))
        GlassButton(onClick = onUseLocation, prominent = true, enabled = !locating, modifier = Modifier.fillMaxWidth()) {
            if (locating) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Tokens.navyNight)
                Spacer(Modifier.width(8.dp))
                GlassButtonText(stringResource(R.string.locating))
            } else {
                GlassButtonText(stringResource(R.string.use_my_location), painterResource(R.drawable.ic_pin))
            }
        }
        Spacer(Modifier.height(10.dp))
        GlassButton(onClick = onPickCity, modifier = Modifier.fillMaxWidth()) { GlassButtonText(stringResource(R.string.search_city)) }
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error, color = Color(0xFFF2B8B5), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ZoneConfirmCard(loc: PrayerLocation, onConfirm: () -> Unit, onChange: () -> Unit) {
    val context = LocalContext.current
    GlassCard {
        Text(stringResource(R.string.confirm_time_zone_title), style = MaterialTheme.typography.titleMedium, color = Color.White)
        Spacer(Modifier.height(4.dp))
        Text(stringResource(R.string.confirm_time_zone_body, Format.zoneName(context, loc.zoneId)), style = MaterialTheme.typography.bodyMedium, color = Color.White)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GlassButton(onClick = onConfirm, prominent = true) { GlassButtonText(stringResource(R.string.use_this_time_zone)) }
            GlassButton(onClick = onChange) { GlassButtonText(stringResource(R.string.change)) }
        }
    }
}

@Composable
private fun PolarCard(onUseNearest: () -> Unit) {
    GlassCard {
        Text(stringResource(R.string.polar_unavailable_title), style = MaterialTheme.typography.titleMedium, color = Color.White)
        Spacer(Modifier.height(4.dp))
        Text(stringResource(R.string.polar_unavailable_body), style = MaterialTheme.typography.bodyMedium, color = Color.White)
        Spacer(Modifier.height(10.dp))
        GlassButton(onClick = onUseNearest, prominent = true) { GlassButtonText(stringResource(R.string.polar_use_nearest)) }
    }
}

fun prayerIcon(e: PrayerEvent): Int = when (e) {
    PrayerEvent.FAJR -> R.drawable.ic_p_fajr
    PrayerEvent.SUNRISE -> R.drawable.ic_p_sunrise
    PrayerEvent.DHUHR -> R.drawable.ic_p_dhuhr
    PrayerEvent.ASR -> R.drawable.ic_p_asr
    PrayerEvent.MAGHRIB -> R.drawable.ic_p_maghrib
    PrayerEvent.ISHA -> R.drawable.ic_p_isha
}

/** Today's times on glass; the upcoming prayer sits in a gold glass pill with an "Upcoming" badge. */
@Composable
private fun ScheduleCard(ui: PrayerUi, reminders: Set<PrayerEvent>, onToggleReminder: (PrayerEvent, Boolean) -> Unit) {
    val context = LocalContext.current
    val today = ui.today ?: return
    val zone = today.zone
    GlassCard(padding = 10.dp) {
        Text(
            stringResource(R.string.todays_times), style = MaterialTheme.typography.titleSmall, color = Color.White.copy(alpha = 0.8f),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp).semantics { heading() },
        )
        PrayerEvent.entries.forEachIndexed { i, e ->
            val at = today[e] ?: return@forEachIndexed
            val isNext = ui.next?.event == e && !ui.next.isTomorrow
            val name = stringResource(Format.prayerName(e))
            val nextDay = at.atZone(zone).toLocalDate().isAfter(today.date)
            val fg = if (isNext) Tokens.gold else if (e.isPrayer) Color.White else Color.White.copy(alpha = 0.7f)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 54.dp)
                    .then(
                        if (isNext) Modifier.background(Tokens.gold.copy(alpha = 0.14f), RoundedCornerShape(18.dp))
                            .border(1.dp, Tokens.gold.copy(alpha = 0.55f), RoundedCornerShape(18.dp)) else Modifier,
                    )
                    .padding(start = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(painterResource(prayerIcon(e)), contentDescription = null, tint = fg, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(12.dp))
                Text(name, style = MaterialTheme.typography.bodyLarge, fontWeight = if (isNext) FontWeight.SemiBold else FontWeight.Normal, color = fg)
                if (isNext) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        stringResource(R.string.upcoming), color = Tokens.gold, style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.border(1.dp, Tokens.gold.copy(alpha = 0.7f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    Format.time(context, at, zone) + if (nextDay) " (" + stringResource(R.string.next_day) + ")" else "",
                    style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"),
                    fontWeight = if (isNext) FontWeight.SemiBold else FontWeight.Normal, color = fg,
                )
                if (e.isPrayer) {
                    val on = e in reminders
                    val label = stringResource(if (on) R.string.reminder_on_a11y else R.string.reminder_off_a11y, name)
                    Box(
                        Modifier.size(48.dp).clickable { onToggleReminder(e, !on) }.semantics { contentDescription = label },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painterResource(if (on) R.drawable.ic_bell else R.drawable.ic_bell_off), contentDescription = null,
                            tint = if (on) Tokens.gold else Color.White.copy(alpha = 0.55f), modifier = Modifier.size(18.dp),
                        )
                    }
                } else {
                    Spacer(Modifier.width(48.dp))
                }
            }
            if (i < PrayerEvent.entries.size - 1 && !isNext) HorizontalDivider(Modifier.padding(horizontal = 10.dp), color = Color.White.copy(alpha = 0.10f))
        }
        Text(
            stringResource(R.string.sunrise_not_prayer_note), Modifier.padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
            style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.7f),
        )
    }
}

@Composable
private fun DatesCard(ui: PrayerUi, onOpenCalculation: () -> Unit) {
    val context = LocalContext.current
    val loc = ui.location ?: return
    val date = ui.now.atZone(loc.zoneId).toLocalDate()
    val adj = ui.settings?.prayer?.hijriAdjustmentDays ?: 0
    GlassCard {
        Text(Format.gregorian(context, date), style = MaterialTheme.typography.titleMedium, color = Color.White)
        Format.hijri(context, date, adj)?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = Tokens.gold) }
        Text(stringResource(R.string.hijri_calendar_note), style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.7f))
        HorizontalDivider(Modifier.padding(vertical = 10.dp), color = Color.White.copy(alpha = 0.18f))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                ui.settings?.prayer?.method?.let { Text(stringResource(Format.methodName(it)), style = MaterialTheme.typography.bodyMedium, color = Color.White) }
                Text(stringResource(R.string.time_zone_label, Format.zoneName(context, loc.zoneId)), style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.7f))
            }
            Spacer(Modifier.width(8.dp))
            GlassButton(onClick = onOpenCalculation) { GlassButtonText(stringResource(R.string.calculation)) }
        }
    }
}
