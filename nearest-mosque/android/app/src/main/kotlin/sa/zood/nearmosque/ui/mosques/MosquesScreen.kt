package sa.zood.nearmosque.ui.mosques

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.Geo
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.Mosque
import sa.zood.nearmosque.core.MosqueCategory
import sa.zood.nearmosque.core.RankedMosque
import sa.zood.nearmosque.data.MosqueResult
import sa.zood.nearmosque.platform.ExternalActions
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.components.SectionCard
import sa.zood.nearmosque.ui.theme.DataDirection
import sa.zood.nearmosque.ui.theme.LocalExtraColors
import sa.zood.nearmosque.ui.theme.Tokens
import kotlin.math.cos

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MosquesScreen(vm: MosquesViewModel, onOpenSettings: () -> Unit, contentPadding: PaddingValues) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    val ui by vm.ui.collectAsStateWithLifecycle()
    var mode by rememberSaveable { mutableStateOf("list") }
    var selected by remember { mutableStateOf<RankedMosque?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { vm.useDevice(lang) }
    LaunchedEffect(Unit) { vm.start(lang) }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.tab_mosques), Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
            IconButton(onClick = onOpenSettings) { Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings)) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                val segColors = SegmentedButtonDefaults.colors(activeContainerColor = Tokens.gold.copy(alpha = 0.30f))
                SegmentedButton(
                    mode == "list", { mode = "list" }, SegmentedButtonDefaults.itemShape(0, 2), colors = segColors,
                    icon = { Icon(painterResource(R.drawable.ic_list), contentDescription = null, Modifier.size(18.dp)) },
                ) { Text(stringResource(R.string.view_list)) }
                SegmentedButton(
                    mode == "map", { mode = "map" }, SegmentedButtonDefaults.itemShape(1, 2), colors = segColors,
                    icon = { Icon(painterResource(R.drawable.ic_map), contentDescription = null, Modifier.size(18.dp)) },
                ) { Text(stringResource(R.string.view_map)) }
            }
            Spacer(Modifier.width(8.dp))
            FilterChip(
                selected = ui.favoritesOnly, onClick = { vm.setFavoritesOnly(!ui.favoritesOnly) },
                label = { Text(stringResource(R.string.favorites)) },
                leadingIcon = { Icon(Icons.Filled.Star, contentDescription = null, Modifier.size(18.dp)) },
            )
        }
        OriginRow(ui, onUseDevice = {
            permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        })
        Box(Modifier.weight(1f)) {
            when {
                ui.favoritesOnly -> FavoritesList(ui, contentPadding) { m -> selected = RankedMosque(m, ui.center?.let { Geo.distanceMeters(it, m.location) } ?: 0.0) }
                ui.center == null -> NeedLocation(
                    denied = ui.permissionDenied, locating = ui.locating,
                    onAllow = { permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
                    onUseCity = { vm.usePrayerCity(lang) },
                )
                ui.loading && ui.result == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> when (val r = ui.result) {
                    is MosqueResult.Found -> if (mode == "list") {
                        ResultList(r.items, ui.favorites, contentPadding, onSelect = { selected = it })
                    } else {
                        OfflinePlot(ui.center!!, r.items, vm.device.collectAsStateWithLifecycle().value?.location, onSelect = { selected = it }, onSearchHere = { vm.searchAt(it, lang) })
                    }
                    is MosqueResult.NoRecordsInCoverage -> EmptyState(
                        stringResource(R.string.no_records_title),
                        stringResource(R.string.no_records_body, r.coverage, Format.distance(context, r.radiusMeters)),
                    )
                    is MosqueResult.AreaNotDownloaded -> EmptyState(
                        stringResource(R.string.region_not_downloaded_title),
                        stringResource(R.string.region_not_downloaded_body, r.installed.ifEmpty { listOf(stringResource(R.string.region_none_installed)) }.joinToString()),
                    )
                    null -> Unit
                }
            }
        }
    }
    selected?.let { s ->
        MosqueDetailSheet(s, s.mosque.sourceId in ui.favorites, onToggleFavorite = { vm.toggleFavorite(s.mosque.sourceId) }, onDismiss = { selected = null })
    }
}

@Composable
private fun OriginRow(ui: MosquesUi, onUseDevice: () -> Unit) {
    val text = when (val o = ui.origin) {
        SearchOrigin.Device -> stringResource(R.string.searching_from_you)
        is SearchOrigin.PrayerCity -> stringResource(R.string.searching_from_city, o.name)
        SearchOrigin.SelectedPoint -> stringResource(R.string.searching_from_point)
        null -> return
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.textSecondary)
        if (ui.origin != SearchOrigin.Device) {
            OutlinedButton(onClick = onUseDevice, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Filled.LocationOn, contentDescription = null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp)); Text(stringResource(R.string.recenter))
            }
        }
    }
}

@Composable
private fun NeedLocation(denied: Boolean, locating: Boolean, onAllow: () -> Unit, onUseCity: () -> Unit) {
    SectionCard(Modifier.padding(16.dp)) {
        Text(stringResource(R.string.mosques_need_location_title), style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(4.dp))
        Text(stringResource(if (denied) R.string.location_denied else R.string.mosques_need_location_body), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(12.dp))
        Button(onClick = onAllow, enabled = !locating, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
            Text(stringResource(if (locating) R.string.locating else R.string.allow_location))
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onUseCity, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(stringResource(R.string.choose_city_title)) }
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    SectionCard(Modifier.padding(16.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(4.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ResultList(items: List<RankedMosque>, favorites: Set<String>, contentPadding: PaddingValues, onSelect: (RankedMosque) -> Unit) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = contentPadding.calculateBottomPadding() + 16.dp)) {
        item("nearest") {
            val first = items.first()
            SectionCard {
                Text(stringResource(R.string.nearest_known_mosque), style = MaterialTheme.typography.labelLarge, color = LocalExtraColors.current.accentText)
                Text(first.mosque.displayName(lang) ?: stringResource(R.string.mosque_unnamed), style = MaterialTheme.typography.titleLarge.copy(textDirection = DataDirection))
                Text(stringResource(R.string.straight_line, Format.distance(context, first.distanceMeters)), style = MaterialTheme.typography.bodyLarge)
                first.mosque.address?.let { Text(it, style = MaterialTheme.typography.bodyMedium.copy(textDirection = DataDirection), color = LocalExtraColors.current.textSecondary) }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { ExternalActions.directions(context, first.mosque.location, first.mosque.displayName(lang)) },
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    ) {
                        Icon(painterResource(R.drawable.ic_directions), contentDescription = null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.directions))
                    }
                    OutlinedButton(onClick = { onSelect(first) }, modifier = Modifier.heightIn(min = 52.dp)) { Text(stringResource(R.string.show_more_detail)) }
                }
            }
            Spacer(Modifier.height(12.dp))
            Text(pluralStringResource(R.plurals.mosque_count, items.size, items.size), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(vertical = 4.dp))
        }
        items(items.drop(1), key = { it.mosque.sourceId }) { r -> MosqueRow(r, r.mosque.sourceId in favorites) { onSelect(r) } }
        item("attr") {
            Text(stringResource(R.string.data_attribution_osm), Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
        }
    }
}

@Composable
private fun FavoritesList(ui: MosquesUi, contentPadding: PaddingValues, onSelect: (Mosque) -> Unit) {
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = contentPadding.calculateBottomPadding() + 16.dp)) {
        items(ui.favoriteMosques.filter { it.sourceId in ui.favorites }, key = { it.sourceId }) { m ->
            MosqueRow(RankedMosque(m, ui.center?.let { Geo.distanceMeters(it, m.location) } ?: Double.NaN), true) { onSelect(m) }
        }
        if (ui.favoriteMosques.isEmpty()) {
            item { Text(stringResource(R.string.favorites) + ": " + Format.number(LocalContext.current, 0.0, 0), style = MaterialTheme.typography.bodyLarge) }
        }
    }
}

@Composable
private fun MosqueRow(r: RankedMosque, favorite: Boolean, onClick: () -> Unit) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    val name = r.mosque.displayName(lang) ?: stringResource(R.string.mosque_unnamed)
    val dist = if (r.distanceMeters.isNaN()) "" else Format.distance(context, r.distanceMeters)
    val a11y = stringResource(R.string.mosque_detail_a11y, name, dist)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = a11y }.padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_tab_mosque), contentDescription = null, tint = Tokens.navy, modifier = Modifier.size(28.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyLarge.copy(textDirection = DataDirection), fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val sub = listOfNotNull(
                if (r.mosque.category == MosqueCategory.PRAYER_SPACE) stringResource(R.string.category_prayer_space) else null,
                r.mosque.address,
            ).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall.copy(textDirection = DataDirection), color = LocalExtraColors.current.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (favorite) Icon(Icons.Filled.Star, contentDescription = null, tint = Tokens.gold, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(dist, style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"), color = MaterialTheme.colorScheme.primary)
    }
}

/**
 * Offline view without map tiles: north-up, distance rings, pins positioned by local projection.
 * Drag to move the search point; "Search this area" re-runs the list from there. The device marker
 * always stays at the real device position.
 */
@Composable
private fun OfflinePlot(center: LatLng, items: List<RankedMosque>, device: LatLng?, onSelect: (RankedMosque) -> Unit, onSearchHere: (LatLng) -> Unit) {
    val context = LocalContext.current
    var pan by remember(center) { mutableStateOf(Offset.Zero) }
    var half by remember { mutableStateOf(1f) }
    val maxDist = (items.maxOfOrNull { it.distanceMeters } ?: 1000.0).coerceAtLeast(500.0) * 1.1
    val ringColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.15f)
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
            Canvas(
                Modifier.fillMaxSize()
                    .onSizeChanged { half = it.width / 2f }
                    .pointerInput(items, center) {
                        detectTapGestures { tap ->
                            val scale = (size.width / 2f) / maxDist.toFloat()
                            val hit = items.minByOrNull { r -> (project(center, r.mosque.location, scale, size.width / 2f, pan) - tap).getDistance() }
                            if (hit != null && (project(center, hit.mosque.location, scale, size.width / 2f, pan) - tap).getDistance() < 28.dp.toPx()) onSelect(hit)
                        }
                    }
                    .pointerInput(center) { detectDragGestures { _, d -> pan += d } }
                    .semantics { contentDescription = context.getString(R.string.map_offline_plot) },
            ) {
                val half = size.width / 2f
                val scale = half / maxDist.toFloat()
                val origin = Offset(half, half) + pan
                for (k in 1..3) drawCircle(ringColor, half * k / 3f, origin, style = Stroke(1.dp.toPx()))
                drawLine(ringColor, Offset(origin.x, 0f), Offset(origin.x, size.height))
                drawCircle(Tokens.navy, 5.dp.toPx(), origin)
                items.forEach { r ->
                    val p = project(center, r.mosque.location, scale, half, pan)
                    drawCircle(Color.White, 9.dp.toPx(), p)
                    drawCircle(if (r == items.first()) Tokens.gold else Tokens.navy, 7.dp.toPx(), p)
                }
                device?.let {
                    val p = project(center, it, scale, half, pan)
                    drawCircle(Color(0xFF2E7DD7).copy(alpha = 0.25f), 14.dp.toPx(), p)
                    drawCircle(Color(0xFF2E7DD7), 6.dp.toPx(), p)
                }
            }
            Text(stringResource(R.string.compass_north), Modifier.align(Alignment.TopCenter), style = MaterialTheme.typography.labelLarge)
        }
        Text(stringResource(R.string.map_offline_plot), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
        Text(stringResource(R.string.distance_km, Format.number(context, maxDist / 1000.0, 1)) + " ⟷", style = MaterialTheme.typography.bodySmall)
        if (pan != Offset.Zero) {
            Spacer(Modifier.height(8.dp))
            Button(onClick = {
                // Dragging the content right reveals what lies west, so the new centre is west of the old one.
                val metersPerPx = maxDist / half
                onSearchHere(unproject(center, eastMeters = -pan.x * metersPerPx, northMeters = pan.y * metersPerPx))
            }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(stringResource(R.string.search_this_area)) }
        }
    }
}

private fun project(center: LatLng, p: LatLng, scale: Float, half: Float, pan: Offset): Offset {
    val dy = (p.latitude - center.latitude) * 111_320.0
    val dx = (p.longitude - center.longitude) * 111_320.0 * cos(Math.toRadians(center.latitude))
    return Offset(half + (dx * scale).toFloat(), half - (dy * scale).toFloat()) + pan
}

private fun unproject(center: LatLng, eastMeters: Double, northMeters: Double): LatLng {
    val lat = (center.latitude + northMeters / 111_320.0).coerceIn(-90.0, 90.0)
    val lng = center.longitude + eastMeters / (111_320.0 * cos(Math.toRadians(center.latitude)).coerceAtLeast(1e-6))
    return LatLng(lat, ((lng + 540.0) % 360.0) - 180.0)
}
