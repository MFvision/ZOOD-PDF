package sa.zood.nearmosque.ui.prayer

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.Angles
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.components.SectionCard
import sa.zood.nearmosque.ui.theme.LocalExtraColors
import sa.zood.nearmosque.ui.theme.Tokens
import kotlin.math.abs
import kotlin.math.roundToInt

@Composable
fun QiblaCard(ui: PrayerUi, compass: CompassState, onOpenCompass: () -> Unit) {
    val context = LocalContext.current
    val bearing = ui.qiblaBearing ?: return
    SectionCard(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.qibla), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                Text(stringResource(R.string.qibla_bearing, Format.degrees(context, bearing)), style = MaterialTheme.typography.bodyLarge)
                ui.qiblaDistance?.let {
                    Text(stringResource(R.string.qibla_distance, Format.distance(context, it)), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.textSecondary)
                }
                Text(guidance(compass, bearing), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.accentText)
            }
            QiblaDial(bearing, compass, aligned = false, modifier = Modifier.size(96.dp))
        }
        Spacer(Modifier.height(8.dp))
        Button(onClick = onOpenCompass, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Icon(painterResource(R.drawable.ic_compass), contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.qibla_open_compass))
        }
    }
}

@Composable
private fun guidance(compass: CompassState, bearing: Double): String {
    val context = LocalContext.current
    return when (compass) {
        is CompassState.BearingOnly -> stringResource(R.string.qibla_no_sensor, Format.degrees(context, bearing))
        is CompassState.Live -> {
            val rel = Angles.relativeToQibla(bearing, compass.headingTrue)
            when {
                compass.needsCalibration -> stringResource(R.string.qibla_calibrate)
                abs(rel) <= 5 -> stringResource(R.string.qibla_aligned)
                rel > 0 -> stringResource(R.string.qibla_turn_right, Format.degrees(context, abs(rel)))
                else -> stringResource(R.string.qibla_turn_left, Format.degrees(context, abs(rel)))
            }
        }
    }
}

private fun reducedMotion(context: android.content.Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

/**
 * The dial. Live: the ring rotates so N points to true north and the gold arrow points to the Qibla,
 * both by the shortest path across 359°/0°. Bearing-only: a fixed north-up diagram.
 * Compass geometry never mirrors with RTL text.
 */
@Composable
fun QiblaDial(bearing: Double, compass: CompassState, aligned: Boolean, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val live = compass as? CompassState.Live
    val ringTarget = if (live != null) -live.headingTrue else 0.0
    val ring = remember { Animatable(ringTarget.toFloat()) }
    val instant = reducedMotion(context)
    LaunchedEffect(ringTarget) {
        val target = Angles.shortestTarget(ring.value.toDouble(), ringTarget).toFloat()
        if (instant) ring.snapTo(target) else ring.animateTo(target, spring(dampingRatio = 0.9f, stiffness = 220f))
    }
    val north = stringResource(R.string.compass_north)
    val desc = stringResource(R.string.qibla_dial_a11y, stringResource(R.string.qibla_bearing, Format.degrees(context, bearing)))
    val onSurface = MaterialTheme.colorScheme.onSurface
    val textPaint = remember { android.graphics.Paint().apply { isAntiAlias = true; textAlign = android.graphics.Paint.Align.CENTER } }
    Canvas(modifier.aspectRatio(1f).semantics { contentDescription = desc }) {
        val c = Offset(size.width / 2, size.height / 2)
        val r = size.minDimension / 2 - 4.dp.toPx()
        if (aligned) drawCircle(Brush.radialGradient(listOf(Tokens.gold.copy(alpha = 0.45f), Color.Transparent), c, r * 1.05f), r * 1.05f, c)
        drawCircle(onSurface.copy(alpha = 0.08f), r, c)
        drawCircle(onSurface.copy(alpha = 0.35f), r, c, style = Stroke(1.5.dp.toPx()))
        rotate(ring.value, c) {
            ticks(c, r, onSurface)
            textPaint.color = android.graphics.Color.argb(255, 179, 38, 30)
            textPaint.textSize = r * 0.22f
            drawContext.canvas.nativeCanvas.drawText(north, c.x, c.y - r + r * 0.32f, textPaint)
            // Qibla arrow fixed to the ring at the true bearing.
            rotate(bearing.toFloat(), c) {
                val tip = Offset(c.x, c.y - r * 0.82f)
                drawLine(Tokens.gold, c, tip, 5.dp.toPx(), StrokeCap.Round)
                drawCircle(Tokens.gold, 7.dp.toPx(), tip)
                drawCircle(Tokens.navy, 3.dp.toPx(), tip)
            }
        }
        // Phone's forward direction.
        if (live != null) drawLine(onSurface.copy(alpha = 0.6f), Offset(c.x, c.y - r - 2.dp.toPx()), Offset(c.x, c.y - r + 10.dp.toPx()), 3.dp.toPx(), StrokeCap.Round)
        drawCircle(Tokens.navy, 6.dp.toPx(), c)
    }
}

private fun DrawScope.ticks(c: Offset, r: Float, color: Color) {
    for (i in 0 until 72) {
        val major = i % 18 == 0
        rotate(i * 5f, c) {
            drawLine(
                color.copy(alpha = if (major) 0.7f else 0.25f),
                Offset(c.x, c.y - r), Offset(c.x, c.y - r + (if (major) 12 else 6).dp.toPx()),
                (if (major) 2 else 1).dp.toPx(),
            )
        }
    }
}

/** Full-screen compass. Sensors run only while this (or the Prayer tab) is visible. */
@Composable
fun QiblaCompassScreen(ui: PrayerUi, compass: CompassState, aligned: Boolean, onClose: () -> Unit) {
    val context = LocalContext.current
    val bearing = ui.qiblaBearing ?: return
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.qibla), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
                IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.close)) }
            }
            Text(ui.location?.name.orEmpty(), style = MaterialTheme.typography.bodyLarge, color = LocalExtraColors.current.textSecondary)
            Spacer(Modifier.height(16.dp))
            Box(Modifier.fillMaxWidth().widthIn(max = 420.dp).weight(1f, fill = false), contentAlignment = Alignment.Center) {
                QiblaDial(bearing, compass, aligned, Modifier.fillMaxWidth(0.86f))
            }
            Spacer(Modifier.height(16.dp))
            Text(
                guidance(compass, bearing), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center,
                color = if (aligned) LocalExtraColors.current.accentText else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.qibla_bearing, Format.degrees(context, bearing)), style = MaterialTheme.typography.bodyLarge)
            when (compass) {
                is CompassState.Live -> compass.accuracyDeg?.let {
                    Text(stringResource(R.string.heading_accuracy, it.roundToInt().toString()), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.textSecondary)
                }
                CompassState.BearingOnly -> Text(stringResource(R.string.qibla_north_up), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.textSecondary)
            }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.qibla_hold_flat) + " · " + stringResource(R.string.qibla_approximate), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, color = LocalExtraColors.current.textSecondary)
        }
    }
}
