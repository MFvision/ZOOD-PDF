package sa.zood.nearmosque.ui.mosques

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.Angles
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.core.Geo
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.MosqueCategory
import sa.zood.nearmosque.core.OnlineMosques
import sa.zood.nearmosque.core.RankedMosque
import sa.zood.nearmosque.data.MosqueResult
import sa.zood.nearmosque.platform.ExternalActions
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.glass.GlassButton
import sa.zood.nearmosque.ui.glass.GlassButtonText
import sa.zood.nearmosque.ui.glass.GlassCard
import sa.zood.nearmosque.ui.glass.GlassIconButton
import sa.zood.nearmosque.ui.glass.GlassSegmented
import sa.zood.nearmosque.ui.glass.MosquePin
import sa.zood.nearmosque.ui.glass.YouDot
import sa.zood.nearmosque.ui.glass.bottomBarPadding
import sa.zood.nearmosque.ui.glass.glass
import sa.zood.nearmosque.ui.glass.reducedMotion
import sa.zood.nearmosque.ui.theme.DataDirection
import sa.zood.nearmosque.ui.theme.Tokens
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

@Composable
fun MosquesScreen(vm: MosquesViewModel, compass: CompassState, onOpenSettings: () -> Unit) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    val ui by vm.ui.collectAsStateWithLifecycle()
    val device by vm.device.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf<RankedMosque?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { vm.useDevice(lang) }
    val requestLocation = { permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) }
    LaunchedEffect(Unit) { vm.start(lang) }
    val heading = (compass as? CompassState.Live)?.headingTrue

    Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            GlassIconButton(
                painterResource(if (ui.favoritesOnly) R.drawable.ic_star_filled else R.drawable.ic_star_outline), stringResource(R.string.favorites),
                onClick = { vm.setFavoritesOnly(!ui.favoritesOnly) }, tint = if (ui.favoritesOnly) Tokens.gold else Color.White,
            )
            Text(
                stringResource(R.string.tab_mosques), Modifier.weight(1f).semantics { heading() }, color = Color.White,
                style = MaterialTheme.typography.titleMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            GlassIconButton(rememberVectorPainter(Icons.Filled.Settings), stringResource(R.string.settings), onOpenSettings)
        }
        Spacer(Modifier.height(12.dp))
        val center = ui.center
        if (center != null && !ui.favoritesOnly) {
            GlassSegmented(ui.mode, listOf(stringResource(R.string.view_compass) to R.drawable.ic_compass, stringResource(R.string.view_map) to R.drawable.ic_map), vm::setMode)
            Spacer(Modifier.height(12.dp))
            if (ui.items.isNotEmpty()) {
                Crossfade(ui.mode, label = "mode") { m ->
                    if (m == 0) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            MosqueRadar(ui.items, center, heading, Modifier.fillMaxWidth(0.82f)) { selected = it }
                            guidance(ui.items, center, heading)?.let { g ->
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    g, color = if (g == stringResource(R.string.mosque_ahead)) Tokens.gold else Color.White,
                                    style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                                )
                            }
                        }
                    } else {
                        MosqueMap(
                            ui.items, center, device?.location, onSelect = { selected = it }, onSearchHere = { vm.searchAt(it, lang) },
                            modifier = Modifier.fillMaxWidth().height(300.dp).clip(RoundedCornerShape(Tokens.cardRadius.dp))
                                .border(1.dp, Color.White.copy(alpha = 0.25f), RoundedCornerShape(Tokens.cardRadius.dp)),
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
            }
        }
        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(bottom = bottomBarPadding(12.dp).calculateBottomPadding()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item("status") { StatusRow(ui, onUseDevice = requestLocation) }
            when {
                ui.favoritesOnly -> items(ui.favoriteMosques, key = { "fav-" + it.sourceId }) { m ->
                    val d = ui.center?.let { Geo.distanceMeters(it, m.location) }
                    MosqueCard(RankedMosque(m, d ?: 0.0), nearest = false, favorite = true, showDistance = d != null) { selected = RankedMosque(m, d ?: 0.0) }
                }
                center == null -> item("need") {
                    NeedLocation(ui.permissionDenied, ui.locating, onAllow = requestLocation, onUseCity = { vm.usePrayerCity(lang) })
                }
                ui.loading && ui.items.isEmpty() -> item("loading") {
                    Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Color.White) }
                }
                ui.items.isNotEmpty() -> {
                    itemsIndexed(ui.items.take(40), key = { _, r -> r.mosque.sourceId }) { i, r ->
                        MosqueCard(r, nearest = i == 0, favorite = r.mosque.sourceId in ui.favorites, showDistance = true) { selected = r }
                    }
                    item("attribution") {
                        val online = ui.items.any { it.mosque.packId == OnlineMosques.PACK_ID }
                        Text(
                            stringResource(R.string.data_attribution_osm) + (if (online) " · " + stringResource(R.string.source_online_osm) else "") +
                                (if (ui.mode == 1) " · " + stringResource(R.string.map_attribution_ofm) else ""),
                            color = Color.White.copy(alpha = 0.6f), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 4.dp),
                        )
                    }
                }
                ui.online != OnlineState.SEARCHING -> item("empty") {
                    when (val r = ui.result) {
                        is MosqueResult.NoRecordsInCoverage -> EmptyState(
                            stringResource(R.string.no_records_title),
                            stringResource(R.string.no_records_body, r.coverage, Format.distance(context, r.radiusMeters)),
                        )
                        is MosqueResult.AreaNotDownloaded -> EmptyState(
                            stringResource(R.string.region_not_downloaded_title),
                            stringResource(R.string.region_not_downloaded_body, r.installed.ifEmpty { listOf(stringResource(R.string.region_none_installed)) }.joinToString()),
                        )
                        else -> Unit
                    }
                }
            }
        }
    }
    selected?.let { s ->
        MosqueDetailSheet(s, s.mosque.sourceId in ui.favorites, onToggleFavorite = { vm.toggleFavorite(s.mosque.sourceId) }, onDismiss = { selected = null })
    }
}


@Composable
private fun guidance(items: List<RankedMosque>, center: LatLng, heading: Double?): String? {
    val context = LocalContext.current
    val h = heading ?: return null
    val first = items.firstOrNull() ?: return null
    val rel = Angles.normalize180(Geo.initialBearing(center, first.mosque.location) - h)
    return when {
        abs(rel) <= 12 -> stringResource(R.string.mosque_ahead)
        rel > 0 -> stringResource(R.string.qibla_turn_right, Format.degrees(context, abs(rel)))
        else -> stringResource(R.string.qibla_turn_left, Format.degrees(context, abs(rel)))
    }
}

@Composable
private fun StatusRow(ui: MosquesUi, onUseDevice: () -> Unit) {
    if (ui.favoritesOnly) return
    val text = when (val o = ui.origin) {
        SearchOrigin.Device -> stringResource(R.string.searching_from_you)
        is SearchOrigin.PrayerCity -> stringResource(R.string.searching_from_city, o.name)
        SearchOrigin.SelectedPoint -> stringResource(R.string.searching_from_point)
        null -> return
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(text, style = MaterialTheme.typography.bodyMedium, color = Color.White)
            when (ui.online) {
                OnlineState.SEARCHING -> Text(stringResource(R.string.online_searching), style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.7f))
                OnlineState.UNAVAILABLE -> Text(stringResource(R.string.online_offline_note), style = MaterialTheme.typography.bodySmall, color = Tokens.gold)
                else -> Unit
            }
        }
        if (ui.origin != SearchOrigin.Device) {
            Spacer(Modifier.width(8.dp))
            GlassButton(onClick = onUseDevice) { GlassButtonText(stringResource(R.string.recenter), painterResource(R.drawable.ic_pin)) }
        }
    }
}

@Composable
private fun NeedLocation(denied: Boolean, locating: Boolean, onAllow: () -> Unit, onUseCity: () -> Unit) {
    GlassCard(padding = 20.dp) {
        Text(stringResource(R.string.mosques_need_location_title), style = MaterialTheme.typography.titleLarge, color = Color.White, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(4.dp))
        Text(stringResource(if (denied) R.string.location_denied else R.string.mosques_need_location_body), style = MaterialTheme.typography.bodyLarge, color = Color.White.copy(alpha = 0.85f))
        Spacer(Modifier.height(14.dp))
        GlassButton(onClick = onAllow, prominent = true, enabled = !locating, modifier = Modifier.fillMaxWidth()) {
            GlassButtonText(stringResource(if (locating) R.string.locating else R.string.allow_location), painterResource(R.drawable.ic_pin))
        }
        Spacer(Modifier.height(10.dp))
        GlassButton(onClick = onUseCity, modifier = Modifier.fillMaxWidth()) { GlassButtonText(stringResource(R.string.choose_city_title)) }
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    GlassCard {
        Text(title, style = MaterialTheme.typography.titleMedium, color = Color.White, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(4.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.85f))
    }
}

/** Glass mosque card: name, straight-line distance, one Directions button (gold for the nearest). */
@Composable
private fun MosqueCard(r: RankedMosque, nearest: Boolean, favorite: Boolean, showDistance: Boolean, onOpen: () -> Unit) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    val m = r.mosque
    val name = m.displayName(lang) ?: stringResource(R.string.mosque_unnamed)
    val distance = Format.distance(context, r.distanceMeters)
    val a11y = stringResource(R.string.mosque_detail_a11y, name, distance)
    GlassCard(padding = 14.dp, tint = if (nearest) Tokens.gold.copy(alpha = 0.12f) else null) {
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onOpen).semantics { contentDescription = a11y },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MosquePin(nearest, size = 44.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                if (nearest) Text(stringResource(R.string.nearest_known_mosque), color = Tokens.gold, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold))
                Text(name, color = Color.White, style = MaterialTheme.typography.titleMedium.copy(textDirection = DataDirection), maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (showDistance) Text(stringResource(R.string.straight_line, distance), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.bodyMedium)
                when {
                    m.packId == OnlineMosques.PACK_ID -> Text(stringResource(R.string.source_online_osm), color = Color.White.copy(alpha = 0.6f), style = MaterialTheme.typography.labelSmall)
                    m.category == MosqueCategory.PRAYER_SPACE -> Text(stringResource(R.string.category_prayer_space), color = Color.White.copy(alpha = 0.6f), style = MaterialTheme.typography.labelSmall)
                }
            }
            if (favorite) Icon(painterResource(R.drawable.ic_star_filled), contentDescription = null, tint = Tokens.gold, modifier = Modifier.size(18.dp))
            Icon(rememberVectorPainter(Icons.AutoMirrored.Filled.KeyboardArrowRight), contentDescription = null, tint = Color.White.copy(alpha = 0.6f))
        }
        Spacer(Modifier.height(10.dp))
        GlassButton(onClick = { ExternalActions.directions(context, m.location, name) }, prominent = nearest, modifier = Modifier.fillMaxWidth()) {
            GlassButtonText(stringResource(R.string.get_directions), painterResource(R.drawable.ic_directions))
        }
    }
}

/**
 * Compass view of nearby mosques: you in the centre, each mosque at its true bearing and (square-root
 * scaled) distance. With a live heading the dial turns so the top is where the phone points; without
 * heading it is north-up. Geometry never mirrors.
 */
@Composable
private fun MosqueRadar(items: List<RankedMosque>, center: LatLng, heading: Double?, modifier: Modifier = Modifier, onSelect: (RankedMosque) -> Unit) {
    val reduced = reducedMotion()
    val rotation = remember { Animatable(-(heading ?: 0.0).toFloat()) }
    LaunchedEffect(heading) {
        val target = Angles.shortestTarget(rotation.value.toDouble(), -(heading ?: 0.0)).toFloat()
        if (reduced) rotation.snapTo(target) else rotation.animateTo(target, spring(dampingRatio = 0.85f, stiffness = 180f))
    }
    val shown = items.take(10)
    val maxD = maxOf(300.0, shown.maxOfOrNull { it.distanceMeters } ?: 1000.0)
    val north = stringResource(R.string.compass_north)
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(modifier.aspectRatio(1f).glass(CircleShape), contentAlignment = Alignment.Center) {
            val density = LocalDensity.current
            val s = with(density) { maxWidth.toPx() }
            val usable = s / 2 - with(density) { 28.dp.toPx() }
            fun pos(r: RankedMosque): Offset {
                val b = Math.toRadians(Geo.initialBearing(center, r.mosque.location) + rotation.value)
                val rad = sqrt(r.distanceMeters / maxD).toFloat() * usable
                return Offset(rad * sin(b).toFloat(), -rad * cos(b).toFloat())
            }
            Canvas(Modifier.fillMaxSize()) {
                val c = this.center
                for (k in 1..2) drawCircle(Color.White.copy(alpha = 0.16f), size.minDimension / 2 * k / 3f, c, style = Stroke(1.dp.toPx()))
                rotate(rotation.value, c) {
                    for (i in 0 until 36) {
                        val major = i % 9 == 0
                        rotate(i * 10f, c) {
                            drawLine(
                                Color.White.copy(alpha = if (major) 0.8f else 0.3f), Offset(c.x, 4.dp.toPx()),
                                Offset(c.x, (if (major) 14 else 9).dp.toPx()), (if (major) 2 else 1).dp.toPx(),
                            )
                        }
                    }
                }
                shown.firstOrNull()?.let { first ->
                    val p = pos(first)
                    drawLine(Tokens.gold, c, c + p, 3.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(14f, 14f)))
                }
                if (heading != null) drawLine(Color.White, Offset(c.x, -2.dp.toPx()), Offset(c.x, 12.dp.toPx()), 4.dp.toPx(), StrokeCap.Round)
            }
            val nr = Math.toRadians(rotation.value.toDouble())
            val nDist = s / 2 - with(density) { 26.dp.toPx() }
            Text(
                north, color = Color(0xFFF2B8B5), style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold),
                modifier = Modifier.offset { IntOffset((nDist * sin(nr)).roundToInt(), (-nDist * cos(nr)).roundToInt()) },
            )
            shown.forEachIndexed { i, r ->
                val p = pos(r)
                val label = stringResource(R.string.mosque_detail_a11y, r.mosque.displayName(lang) ?: stringResource(R.string.mosque_unnamed), Format.distance(context, r.distanceMeters))
                Box(
                    Modifier.offset { IntOffset(p.x.roundToInt(), p.y.roundToInt()) }.size(48.dp)
                        .clickable(role = Role.Button) { onSelect(r) }.semantics { contentDescription = label },
                    contentAlignment = Alignment.Center,
                ) { MosquePin(i == 0, size = 34.dp) }
            }
            YouDot()
        }
    }
}
