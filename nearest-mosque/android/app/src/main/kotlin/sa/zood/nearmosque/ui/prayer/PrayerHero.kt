package sa.zood.nearmosque.ui.prayer

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.Angles
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.core.PrayerCalculator
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.glass.GlassButton
import sa.zood.nearmosque.ui.glass.GlassButtonText
import sa.zood.nearmosque.ui.glass.GlassIconButton
import sa.zood.nearmosque.ui.glass.LocationPill
import sa.zood.nearmosque.ui.glass.LogoDisc
import sa.zood.nearmosque.ui.glass.glass
import sa.zood.nearmosque.ui.glass.reducedMotion
import sa.zood.nearmosque.ui.theme.Tokens
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

enum class ArcMode { LIVE, NORTH_UP, NONE }

/**
 * Top of Prayer & Qibla: glass location pill and gear, the Qibla arc with the brand disc at the top and
 * the next prayer inside, and quick facts. The gold dot on the arc is where the Qibla is relative to
 * the top of the phone; when it meets the disc the phone faces the Qibla and the disc glows. Without
 * a live true heading the arc is north-up and the dot is the bearing from true north.
 */
@Composable
fun PrayerHero(ui: PrayerUi, compass: CompassState, aligned: Boolean, onLocation: () -> Unit, onSettings: () -> Unit, onQibla: () -> Unit) {
    val context = LocalContext.current
    val bearing = ui.qiblaBearing
    val live = compass as? CompassState.Live
    val mode = when {
        bearing == null -> ArcMode.NONE
        live != null -> ArcMode.LIVE
        else -> ArcMode.NORTH_UP
    }
    val dot = when {
        bearing == null -> 0.0
        live != null -> Angles.relativeToQibla(bearing, live.headingTrue)
        else -> bearing
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.size(48.dp))
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                LocationPill(ui.location?.name ?: stringResource(R.string.choose_city_title), onClick = onLocation)
            }
            GlassIconButton(rememberVectorPainter(Icons.Filled.Settings), stringResource(R.string.settings), onSettings)
        }
        QiblaArc(
            dot, mode, aligned,
            modifier = Modifier.widthIn(max = 520.dp).clickable(enabled = bearing != null, role = Role.Button, onClickLabel = stringResource(R.string.qibla_open_compass), onClick = onQibla),
        ) {
            ArcContent(ui, compass, mode, aligned)
        }
        if (bearing != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(stringResource(R.string.qibla_bearing, Format.degrees(context, bearing)))
                ui.qiblaDistance?.let { Chip(stringResource(R.string.qibla_distance, Format.distance(context, it))) }
            }
            Spacer(Modifier.size(8.dp))
            GlassButton(onClick = onQibla) { GlassButtonText(stringResource(R.string.qibla_open_compass), painterResource(R.drawable.ic_compass)) }
        }
    }
}

@Composable
private fun Chip(text: String) {
    Text(
        text, color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1,
        modifier = Modifier.glass(RoundedCornerShape(50), shadow = 4.dp).padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

@Composable
private fun ArcContent(ui: PrayerUi, compass: CompassState, mode: ArcMode, aligned: Boolean) {
    val context = LocalContext.current
    val zone = ui.location?.zoneId
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        val next = ui.next
        if (next != null && zone != null) {
            val name = stringResource(Format.prayerName(next.event))
            val time = Format.time(context, next.at, zone)
            val remaining = PrayerCalculator.remaining(ui.now, next.at)
            val a11y = stringResource(R.string.countdown_a11y, name, time, Format.countdown(context, remaining))
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.clearAndSetSemantics { contentDescription = a11y; heading() }) {
                Text(name, color = Color.White.copy(alpha = 0.92f), style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Medium))
                Text(time, color = Color.White, fontSize = 58.sp, fontWeight = FontWeight.Light, maxLines = 1, style = MaterialTheme.typography.displayMedium.copy(fontFeatureSettings = "tnum"))
                Text(
                    stringResource(R.string.remaining_long, Format.remainingLong(context, remaining)), color = Color.White.copy(alpha = 0.85f),
                    style = MaterialTheme.typography.bodyLarge.copy(fontFeatureSettings = "tnum"),
                )
            }
        } else if (ui.location == null) {
            Text(stringResource(R.string.app_name), color = Color.White, style = MaterialTheme.typography.headlineMedium)
        }
        val bearing = ui.qiblaBearing
        if (bearing != null) {
            val live = compass as? CompassState.Live
            val text = when {
                live == null -> stringResource(R.string.qibla_bearing, Format.degrees(context, bearing))
                live.needsCalibration -> stringResource(R.string.qibla_calibrate)
                aligned -> stringResource(R.string.qibla_you_are_facing)
                else -> stringResource(R.string.qibla_move_phone)
            }
            Spacer(Modifier.size(14.dp))
            Text(
                text, color = if (aligned) Tokens.gold else Color.White, textAlign = TextAlign.Center,
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            if (mode == ArcMode.NORTH_UP) {
                Text(
                    stringResource(R.string.qibla_from_north_hint), color = Color.White.copy(alpha = 0.75f), textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 24.dp, vertical = 2.dp),
                )
            }
        }
    }
}

/**
 * Large circle whose top is the phone's forward direction (live) or north (north-up). The brand disc
 * sits at the top and the gold dot at [angle] degrees clockwise from the top, reached by the shortest
 * path. The lower half fades out so content can sit inside. Geometry never mirrors with RTL.
 */
@Composable
fun QiblaArc(angle: Double, mode: ArcMode, aligned: Boolean, modifier: Modifier = Modifier, springs: Boolean = true, content: @Composable BoxScope.() -> Unit) {
    val reduced = reducedMotion()
    val shown = remember { Animatable(angle.toFloat()) }
    LaunchedEffect(angle) {
        val target = Angles.shortestTarget(shown.value.toDouble(), angle).toFloat()
        if (reduced || !springs) shown.snapTo(target) else shown.animateTo(target, spring(dampingRatio = 0.75f, stiffness = 140f))
    }
    val outer = LocalLayoutDirection.current
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(modifier.fillMaxWidth().aspectRatio(1f)) {
            val density = LocalDensity.current
            val wPx = with(density) { maxWidth.toPx() }
            val r = wPx * 0.43f
            val discPx = with(density) { Tokens.discSize.dp.toPx() }
            val discY = discPx / 2 + with(density) { 6.dp.toPx() }
            val c = Offset(wPx / 2, discY + r)
            Canvas(Modifier.fillMaxSize()) {
                drawCircle(
                    Brush.verticalGradient(0f to Color.White.copy(alpha = 0.55f), 0.45f to Color.White.copy(alpha = 0.22f), 0.8f to Color.White.copy(alpha = 0f), startY = c.y - r, endY = c.y + r),
                    radius = r, center = c, style = Stroke(1.5.dp.toPx()),
                )
                val box = Offset(c.x - r, c.y - r)
                val sz = Size(2 * r, 2 * r)
                if (aligned) {
                    drawArc(Tokens.gold.copy(alpha = 0.9f), -90f, 38f, false, box, sz, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
                    drawArc(Tokens.gold.copy(alpha = 0.9f), -90f, -38f, false, box, sz, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
                }
                if (mode != ArcMode.NONE) {
                    val rel = Angles.normalize180(shown.value.toDouble()).toFloat()
                    drawArc(Color.White.copy(alpha = 0.75f), -90f, rel, false, box, sz, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
                    val rad = Math.toRadians(shown.value.toDouble())
                    val m = Offset(c.x + r * sin(rad).toFloat(), c.y - r * cos(rad).toFloat())
                    drawCircle(Brush.radialGradient(listOf(Tokens.gold.copy(alpha = 0.6f), Color.Transparent), center = m, radius = 22.dp.toPx()), 22.dp.toPx(), m)
                    drawCircle(Tokens.gold, 10.dp.toPx(), m)
                    drawCircle(Color.White.copy(alpha = 0.85f), 10.dp.toPx(), m, style = Stroke(2.dp.toPx()))
                }
            }
            LogoDisc(aligned, Modifier.align(Alignment.TopCenter).padding(top = 6.dp))
            if (mode == ArcMode.NORTH_UP) {
                Text(
                    stringResource(R.string.compass_north), color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold),
                    modifier = Modifier.align(Alignment.TopCenter).padding(top = (Tokens.discSize + 12).dp),
                )
            }
            CompositionLocalProvider(LocalLayoutDirection provides outer) {
                // Content starts below the disc (never overlapping it), centred horizontally inside the circle.
                Box(
                    Modifier.width(with(density) { (r * 1.7f).toDp() }).align(Alignment.TopCenter)
                        .padding(top = (Tokens.discSize + 6 + 26).dp),
                    contentAlignment = Alignment.TopCenter,
                    content = content,
                )
            }
        }
    }
}

/** Compact glass summary pinned while scrolling: next prayer, countdown, small Qibla indicator. */
@Composable
fun CompactPrayerBar(ui: PrayerUi, compass: CompassState, onExpand: () -> Unit) {
    val context = LocalContext.current
    val next = ui.next ?: return
    val zone = ui.location?.zoneId ?: return
    Row(
        Modifier.fillMaxWidth().heightIn(min = Tokens.compactHeight.dp).glass(RoundedCornerShape(50)).padding(start = 20.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(Format.prayerName(next.event)) + "  " + Format.time(context, next.at, zone), color = Color.White, style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.remaining_long, Format.remainingLong(context, PrayerCalculator.remaining(ui.now, next.at))),
                color = Tokens.gold, style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
            )
        }
        ui.qiblaBearing?.let { MiniQiblaIndicator(it, compass) }
        Box(Modifier.size(48.dp).clickable(role = Role.Button, onClickLabel = stringResource(R.string.expand), onClick = onExpand), contentAlignment = Alignment.Center) {
            Icon(rememberVectorPainter(Icons.Filled.KeyboardArrowUp), contentDescription = stringResource(R.string.expand), tint = Color.White)
        }
    }
}

@Composable
private fun MiniQiblaIndicator(bearing: Double, compass: CompassState) {
    val live = compass as? CompassState.Live
    val angle = if (live != null) Angles.relativeToQibla(bearing, live.headingTrue) else bearing
    val label = stringResource(R.string.qibla) + ", " + stringResource(R.string.qibla_bearing, Format.degrees(LocalContext.current, bearing))
    Box(Modifier.size(40.dp).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            drawCircle(Color.White.copy(alpha = 0.6f), size.minDimension / 2 - 1.dp.toPx(), style = Stroke(1.5.dp.toPx()))
            if (live == null) drawCircle(Color.White, 2.dp.toPx(), Offset(center.x, 4.dp.toPx()))
        }
        Icon(painterResource(R.drawable.ic_directions), contentDescription = null, tint = Tokens.gold, modifier = Modifier.size(18.dp).rotate(angle.toFloat()))
    }
}
