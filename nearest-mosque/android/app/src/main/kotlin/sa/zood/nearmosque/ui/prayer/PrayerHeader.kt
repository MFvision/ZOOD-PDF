package sa.zood.nearmosque.ui.prayer

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.Angles
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.core.PrayerCalculator
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.theme.Tokens
import java.time.Duration
import kotlin.math.cos
import kotlin.math.sin

/** Fraction of the current prayer period that has elapsed (time progress, not sun position). */
fun periodProgress(ui: PrayerUi): Float {
    val next = ui.next ?: return 0f
    val start = next.periodStart ?: return 0f
    val total = Duration.between(start, next.at).seconds.toFloat()
    if (total <= 0f) return 0f
    return (Duration.between(start, ui.now).seconds / total).coerceIn(0f, 1f)
}

/**
 * Expanded / home header: atmospheric sky, translucent arc whose gold marker is the elapsed fraction
 * of the current prayer period, central logo disc that glows only when the phone faces the Qibla.
 */
@Composable
fun PrayerHeader(
    ui: PrayerUi,
    height: Dp,
    collapse: Float,
    expanded: Boolean,
    aligned: Boolean,
    onToggleExpanded: () -> Unit,
    onSettings: () -> Unit,
) {
    val context = LocalContext.current
    val (top, bottom) = Tokens.sky(ui.current)
    val progress by animateFloatAsState(periodProgress(ui), spring(stiffness = 60f), label = "progress")
    val glow by animateFloatAsState(if (aligned) 1f else 0.35f, label = "glow")
    val next = ui.next
    val nextName = next?.let { stringResource(Format.prayerName(it.event)) }
    val zone = ui.location?.zoneId
    val nextTime = if (next != null && zone != null) Format.time(context, next.at, zone) else null
    val remaining = next?.let { Format.countdown(context, PrayerCalculator.remaining(ui.now, it.at)) }
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl

    val statusBar = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    Box(
        Modifier
            .fillMaxWidth()
            .height(height + statusBar)
            .graphicsLayer { alpha = 1f - collapse * 0.6f }
            .background(Brush.verticalGradient(listOf(top, bottom))),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            // Time-progress arc around the content. In RTL the progress runs right-to-left like the text.
            val r = minOf(size.width * 0.42f, size.height * 0.62f)
            val c = Offset(size.width / 2, size.height * 0.70f)
            val arcTopLeft = Offset(c.x - r, c.y - r)
            drawArc(Color.White.copy(alpha = 0.22f), 200f, 140f, false, arcTopLeft, Size(r * 2, r * 2), style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
            val sweep = 140f * progress
            val start = if (rtl) 340f - sweep else 200f
            drawArc(Tokens.gold.copy(alpha = 0.85f), start, sweep, false, arcTopLeft, Size(r * 2, r * 2), style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
            val angle = Math.toRadians((if (rtl) 340f - sweep else 200f + sweep).toDouble())
            val marker = Offset(c.x + r * cos(angle).toFloat(), c.y + r * sin(angle).toFloat())
            drawCircle(Brush.radialGradient(listOf(Tokens.gold.copy(alpha = 0.55f), Color.Transparent), marker, 18.dp.toPx()), 18.dp.toPx(), marker)
            drawCircle(Tokens.gold, 6.dp.toPx(), marker)
            drawCircle(Brush.radialGradient(listOf(Color.White.copy(alpha = 0.30f * glow), Color.Transparent), c, r * 0.55f), r * 0.55f, c)
        }
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            IconButton(onClick = onToggleExpanded) {
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = stringResource(if (expanded) R.string.collapse else R.string.expand), tint = Color.White,
                )
            }
            IconButton(onClick = onSettings) {
                Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings), tint = Color.White)
            }
        }
        Column(
            Modifier.fillMaxSize().statusBarsPadding().padding(top = 8.dp, bottom = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Column(
                Modifier.clearAndSetSemantics {
                    heading()
                    contentDescription = if (nextName != null && nextTime != null && remaining != null) {
                        context.getString(R.string.countdown_a11y, nextName, nextTime, remaining)
                    } else {
                        context.getString(R.string.app_name)
                    }
                },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (next == null) {
                    Image(painterResource(R.drawable.logo_mark), contentDescription = null, modifier = Modifier.size(72.dp))
                    Text(stringResource(R.string.app_name), color = Color.White, style = MaterialTheme.typography.headlineMedium)
                } else {
                    Text(stringResource(R.string.next_prayer), color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelLarge)
                    Text(nextName ?: "", color = Color.White, style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold)
                    if (nextTime != null) Text(nextTime, color = Color.White, style = MaterialTheme.typography.titleLarge)
                    if (remaining != null) {
                        Text(
                            stringResource(R.string.countdown_in, remaining), color = Tokens.gold,
                            style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"),
                        )
                    }
                }
            }
            // Expanded state: the central disc. It glows only when the phone faces the Qibla.
            AnimatedVisibility(visible = expanded && next != null) {
                Box(
                    Modifier.padding(top = 20.dp).size(84.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f + 0.25f * glow)),
                    contentAlignment = Alignment.Center,
                ) {
                    Image(painterResource(R.drawable.logo_mark), contentDescription = null, modifier = Modifier.size(58.dp))
                }
            }
        }
    }
}

/** Compact sticky summary shown while scrolling: event, countdown and a small direction indicator. */
@Composable
fun CompactPrayerBar(ui: PrayerUi, compass: CompassState, onExpand: () -> Unit) {
    val context = LocalContext.current
    val next = ui.next ?: return
    val zone = ui.location?.zoneId ?: return
    val (top, bottom) = Tokens.sky(ui.current)
    Row(
        Modifier.fillMaxWidth().background(Brush.horizontalGradient(listOf(top, bottom))).statusBarsPadding()
            .height(Tokens.compactHeader.dp - 24.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(Format.prayerName(next.event)) + "  " + Format.time(context, next.at, zone), color = Color.White, style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.countdown_in, Format.countdown(context, PrayerCalculator.remaining(ui.now, next.at))),
                color = Tokens.gold, style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
            )
        }
        ui.qiblaBearing?.let { MiniQiblaIndicator(it, compass, Modifier.size(40.dp)) }
        Spacer(Modifier.width(4.dp))
        IconButton(onClick = onExpand) {
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.expand), tint = Color.White)
        }
    }
}

/**
 * Small circular indicator. With a live heading the arrow points to the Qibla relative to the phone;
 * without one it is a north-up diagram (N marked) showing the bearing only.
 */
@Composable
fun MiniQiblaIndicator(bearing: Double, compass: CompassState, modifier: Modifier = Modifier) {
    val live = compass as? CompassState.Live
    val angle = if (live != null) Angles.relativeToQibla(bearing, live.headingTrue) else bearing
    val desc = stringResource(R.string.qibla) + ", " + stringResource(R.string.qibla_bearing, Format.degrees(LocalContext.current, bearing))
    Canvas(modifier.semantics { contentDescription = desc }.clip(CircleShape).background(Color.White.copy(alpha = 0.16f))) {
        val c = Offset(size.width / 2, size.height / 2)
        drawCircle(Color.White.copy(alpha = 0.5f), size.minDimension / 2 - 1.dp.toPx(), c, style = Stroke(1.dp.toPx()))
        if (live == null) drawCircle(Color.White, 2.dp.toPx(), Offset(c.x, 4.dp.toPx())) // north tick
        rotate(angle.toFloat(), c) {
            val tip = Offset(c.x, 5.dp.toPx())
            drawLine(Tokens.gold, c, tip, 2.5.dp.toPx(), StrokeCap.Round)
            drawCircle(Tokens.gold, 3.dp.toPx(), tip)
        }
    }
}

@Composable
fun HeaderShape() = RoundedCornerShape(bottomStart = 28.dp, bottomEnd = 28.dp)

val HeaderTitleSize = 34.sp
