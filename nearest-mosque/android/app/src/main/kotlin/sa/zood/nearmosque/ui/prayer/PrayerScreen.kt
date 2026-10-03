package sa.zood.nearmosque.ui.prayer

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.core.PrayerEvent
import sa.zood.nearmosque.core.ScheduleStatus
import sa.zood.nearmosque.data.PrayerLocation
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.components.SectionCard
import sa.zood.nearmosque.ui.theme.LocalExtraColors
import sa.zood.nearmosque.ui.theme.Tokens

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
    contentPadding: PaddingValues,
) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var expanded by rememberSaveable { mutableStateOf(false) }
    val headerHeight by animateDpAsState(
        (if (expanded) Tokens.expandedHeader else Tokens.homeHeader).dp, spring(dampingRatio = 0.86f, stiffness = 300f), label = "header",
    )
    val density = LocalDensity.current
    val collapseRange = with(density) { (Tokens.homeHeader - Tokens.compactHeader).dp.toPx() }
    val collapse by remember {
        derivedStateOf {
            if (listState.firstVisibleItemIndex > 0) 1f else (listState.firstVisibleItemScrollOffset / collapseRange).coerceIn(0f, 1f)
        }
    }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        vm.useDeviceLocation(context.getString(R.string.location_current))
    }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { vm.rescheduleReminders(context) }
    val locate by vm.locate.collectAsStateWithLifecycle()

    LaunchedEffect(ui.settings?.reminders) { if (ui.settings?.reminders?.isNotEmpty() == true) vm.rescheduleReminders(context) }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(state = listState, contentPadding = PaddingValues(bottom = contentPadding.calculateBottomPadding() + 16.dp)) {
            item("header") {
                PrayerHeader(
                    ui, headerHeight, collapse, expanded, aligned,
                    onToggleExpanded = { expanded = !expanded },
                    onSettings = onOpenSettings,
                )
            }
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
                        onUseLocation = {
                            locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                        },
                        onPickCity = onPickCity,
                    )
                }
                return@LazyColumn
            }
            item("location") { LocationRow(loc, ui, onPickCity, onOpenCalculation) }
            if (!loc.zoneConfirmed) item("zone") { ZoneConfirmCard(loc, onConfirm = vm::confirmZone, onChange = onPickCity) }
            ui.fajrEndsAt?.let { end ->
                item("fajr-ends") {
                    Text(
                        stringResource(R.string.fajr_ends_at_sunrise, Format.time(context, end, loc.zoneId)),
                        Modifier.padding(horizontal = 20.dp, vertical = 4.dp), color = LocalExtraColors.current.accentText,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            val today = ui.today
            if (today != null && today.status == ScheduleStatus.Unavailable) {
                item("polar") { PolarCard(onUseNearest = { vm.setPolar(sa.zood.nearmosque.core.PolarRule.NEAREST_LATITUDE) }) }
            }
            item("qibla") { QiblaCard(ui, compass, onOpenCompass) }
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
            item("dates") { DatesCard(ui) }
        }
        AnimatedVisibility(
            visible = collapse >= 0.98f && ui.next != null,
            enter = fadeIn() + slideInVertically { -it }, exit = fadeOut() + slideOutVertically { -it },
        ) {
            CompactPrayerBar(ui, compass) {
                scope.launch { listState.animateScrollToItem(0) }
                expanded = true
            }
        }
    }
}

@Composable
private fun ChooseLocationCard(locating: Boolean, error: String?, onUseLocation: () -> Unit, onPickCity: () -> Unit) {
    SectionCard(Modifier.padding(16.dp)) {
        Text(stringResource(R.string.choose_city_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(6.dp))
        Text(stringResource(R.string.choose_city_body), style = MaterialTheme.typography.bodyLarge, color = LocalExtraColors.current.textSecondary)
        Spacer(Modifier.height(16.dp))
        Button(onClick = onPickCity, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(stringResource(R.string.search_city)) }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onUseLocation, enabled = !locating, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
            if (locating) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.locating))
            } else {
                Icon(Icons.Filled.LocationOn, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.use_my_location))
            }
        }
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun LocationRow(loc: PrayerLocation, ui: PrayerUi, onPickCity: () -> Unit, onOpenCalculation: () -> Unit) {
    val method = ui.settings?.prayer?.method
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(
            Modifier.weight(1f).clickable(role = Role.Button, onClick = onPickCity).padding(vertical = 4.dp),
        ) {
            Text(loc.name, style = MaterialTheme.typography.titleMedium.copy(textDirection = sa.zood.nearmosque.ui.theme.DataDirection), fontWeight = FontWeight.SemiBold)
            if (method != null) {
                Text(stringResource(Format.methodName(method)), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.textSecondary)
            }
        }
        TextButton(onClick = onOpenCalculation, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.calculation)) }
        TextButton(onClick = onPickCity, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.change)) }
    }
    if (ui.today?.status is ScheduleStatus.Estimated) {
        Text(
            stringResource(R.string.estimated_badge), Modifier.padding(horizontal = 16.dp),
            color = LocalExtraColors.current.accentText, style = MaterialTheme.typography.labelLarge,
        )
    }
}

@Composable
private fun ZoneConfirmCard(loc: PrayerLocation, onConfirm: () -> Unit, onChange: () -> Unit) {
    val context = LocalContext.current
    SectionCard(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(stringResource(R.string.confirm_time_zone_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.confirm_time_zone_body, Format.zoneName(context, loc.zoneId)), style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onConfirm) { Text(stringResource(R.string.use_this_time_zone)) }
            TextButton(onClick = onChange) { Text(stringResource(R.string.change)) }
        }
    }
}

@Composable
private fun PolarCard(onUseNearest: () -> Unit) {
    SectionCard(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = LocalExtraColors.current.accentText)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.polar_unavailable_title), style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.height(4.dp))
        Text(stringResource(R.string.polar_unavailable_body), style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(8.dp))
        Button(onClick = onUseNearest) { Text(stringResource(R.string.polar_use_nearest)) }
    }
}

@Composable
private fun ScheduleCard(ui: PrayerUi, reminders: Set<PrayerEvent>, onToggleReminder: (PrayerEvent, Boolean) -> Unit) {
    val context = LocalContext.current
    val today = ui.today ?: return
    val zone = today.zone
    SectionCard(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(stringResource(R.string.todays_times), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(4.dp))
        PrayerEvent.entries.forEachIndexed { i, e ->
            val at = today[e] ?: return@forEachIndexed
            val isNext = ui.next?.event == e && !ui.next.isTomorrow
            val name = stringResource(Format.prayerName(e))
            val nextDay = at.atZone(zone).toLocalDate().isAfter(today.date)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp)
                    .background(if (isNext) Tokens.gold.copy(alpha = 0.14f) else Color.Transparent, RoundedCornerShape(12.dp))
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    name, Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (isNext) FontWeight.Bold else FontWeight.Normal,
                    color = if (e.isPrayer) MaterialTheme.colorScheme.onSurface else LocalExtraColors.current.textSecondary,
                )
                Text(
                    Format.time(context, at, zone) + if (nextDay) " (" + stringResource(R.string.next_day) + ")" else "",
                    style = MaterialTheme.typography.bodyLarge.copy(fontFeatureSettings = "tnum"),
                    fontWeight = if (isNext) FontWeight.Bold else FontWeight.Medium,
                )
                if (e.isPrayer) {
                    val on = e in reminders
                    IconToggleButton(checked = on, onCheckedChange = { onToggleReminder(e, it) }) {
                        Icon(
                            painterResource(if (on) R.drawable.ic_bell else R.drawable.ic_bell_off),
                            contentDescription = stringResource(if (on) R.string.reminder_on_a11y else R.string.reminder_off_a11y, name),
                            tint = if (on) MaterialTheme.colorScheme.primary else LocalExtraColors.current.textSecondary,
                        )
                    }
                } else {
                    Spacer(Modifier.width(48.dp))
                }
            }
            if (i < PrayerEvent.entries.size - 1) HorizontalDivider(color = LocalExtraColors.current.textSecondary.copy(alpha = 0.12f))
        }
        Text(
            stringResource(R.string.sunrise_not_prayer_note), Modifier.padding(top = 8.dp),
            style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary,
        )
    }
}

@Composable
private fun DatesCard(ui: PrayerUi) {
    val context = LocalContext.current
    val zone = ui.location?.zoneId ?: return
    val date = ui.now.atZone(zone).toLocalDate()
    val adj = ui.settings?.prayer?.hijriAdjustmentDays ?: 0
    SectionCard(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(Format.gregorian(context, date), style = MaterialTheme.typography.bodyLarge)
        Format.hijri(context, date, adj)?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = LocalExtraColors.current.accentText) }
        Text(stringResource(R.string.hijri_calendar_note), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
    }
}

@Composable
fun SmallLabel(text: String) = Text(text, style = MaterialTheme.typography.labelMedium, color = LocalExtraColors.current.textSecondary)

@Composable
fun primaryButtonColors() = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)

@Composable
fun cardColors() = CardDefaults.cardColors(containerColor = LocalExtraColors.current.card)

@Composable
fun PlainCard(content: @Composable () -> Unit) = Card(colors = cardColors()) { content() }
