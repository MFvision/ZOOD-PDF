package sa.zood.nearmosque.ui.glass

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import sa.zood.nearmosque.ui.theme.Sky

/**
 * A 0…1 value that loops while [enabled]; [still] otherwise. No infinite transition is created when
 * disabled, so "remove animations" really stops all motion (and UI tests can settle).
 */
@Composable
fun loopingFloat(enabled: Boolean, periodMs: Int, reverse: Boolean, label: String, still: Float): Float {
    if (!enabled) return still
    val t = rememberInfiniteTransition(label = label)
    val v by t.animateFloat(0f, 1f, infiniteRepeatable(tween(periodMs, easing = LinearEasing), if (reverse) RepeatMode.Reverse else RepeatMode.Restart), label = label)
    return v
}

/** System "remove animations" setting (animator duration scale 0). */
@Composable
fun reducedMotion(): Boolean {
    val ctx = LocalContext.current
    return android.provider.Settings.Global.getFloat(ctx.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
}

/**
 * Full-screen landscape behind the glass: gradient sky, stars at night, drifting clouds, a horizon
 * glow behind two mountain ridges and a calm lake; optionally a mosque skyline. Decorative only.
 * Text never sits over the brightest glow (tools/check_tokens.py).
 */
@Composable
fun SkyBackdrop(sky: Sky, modifier: Modifier = Modifier, horizon: Float = 0.64f, skyline: Boolean = false, animate: Boolean = !reducedMotion()) {
    val top by animateColorAsState(sky.top, tween(1200), label = "top")
    val mid by animateColorAsState(sky.mid, tween(1200), label = "mid")
    val glow by animateColorAsState(sky.glow, tween(1200), label = "glow")
    val low by animateColorAsState(sky.low, tween(1200), label = "low")
    val d = loopingFloat(animate, 140_000, reverse = true, label = "drift", still = 0.3f)
    val tw = loopingFloat(animate, 3200, reverse = true, label = "twinkle", still = 0.5f)
    val stars = sky.period.hasStars
    Canvas(modifier.clearAndSetSemantics { }) {
        val w = size.width
        val h = size.height
        val y0 = h * horizon
        drawRect(
            Brush.verticalGradient(
                0f to top, horizon * 0.72f to mid, horizon to lerp(mid, glow, 0.4f),
                (horizon + 0.14f).coerceAtMost(1f) to low, 1f to low,
            ),
        )
        if (stars) {
            drawStars(7, Size(w, y0 * 0.85f), 0.55f + 0.4f * tw)
            drawStars(31, Size(w, y0 * 0.85f), 0.9f - 0.45f * tw)
        }
        // Horizon glow (ellipse), faded to nothing well below the text area.
        scale(1f, 0.42f, pivot = Offset(w / 2, y0)) {
            drawCircle(
                Brush.radialGradient(listOf(glow.copy(alpha = 0.95f), glow.copy(alpha = 0.4f), glow.copy(alpha = 0f)), center = Offset(w / 2, y0), radius = w * 0.7f),
                radius = w * 0.7f, center = Offset(w / 2, y0),
            )
        }
        val cloudTint = lerp(Color.White, glow, 0.35f)
        translate(left = -w * (0.1f + 0.45f * d), top = y0 * 0.38f) {
            drawClouds(Size(w * 1.7f, y0 * 0.55f), cloudTint, if (stars) 0.35f else 0.8f)
        }
        drawRidge(FAR, Offset(0f, y0 - h * 0.075f), Size(w, h * 0.16f), Brush.verticalGradient(listOf(lerp(mid, glow, 0.22f).copy(alpha = 0.85f), low), startY = y0 - h * 0.075f, endY = y0 + h * 0.085f))
        if (skyline) drawSkyline(Offset(w * 0.19f, y0 - h * 0.13f), Size(w * 0.62f, h * 0.15f), lerp(low, Color.Black, 0.25f))
        drawRidge(NEAR, Offset(0f, y0 - h * 0.035f), Size(w, h * 0.12f), Brush.verticalGradient(listOf(lerp(low, Color.Black, 0.18f), lerp(low, Color.Black, 0.18f))))
        val lakeTop = y0 + h * 0.06f
        drawRect(Brush.verticalGradient(listOf(lerp(low, glow, 0.12f), lerp(low, Color.Black, 0.2f)), startY = lakeTop, endY = h), topLeft = Offset(0f, lakeTop), size = Size(w, h - lakeTop))
        scale(1f, 1.3f, pivot = Offset(w / 2, y0 + h * 0.16f)) {
            drawCircle(
                Brush.radialGradient(listOf(glow.copy(alpha = 0.32f * (0.75f + 0.25f * tw)), glow.copy(alpha = 0f)), center = Offset(w / 2, y0 + h * 0.16f), radius = w * 0.3f),
                radius = w * 0.3f, center = Offset(w / 2, y0 + h * 0.16f),
            )
        }
    }
}

private val FAR = listOf(0f to 0.55f, 0.08f to 0.42f, 0.17f to 0.2f, 0.26f to 0.38f, 0.36f to 0.3f, 0.47f to 0.5f, 0.58f to 0.34f, 0.7f to 0.12f, 0.8f to 0.36f, 0.9f to 0.28f, 1f to 0.45f)
private val NEAR = listOf(0f to 0.35f, 0.12f to 0.55f, 0.24f to 0.42f, 0.38f to 0.7f, 0.52f to 0.6f, 0.66f to 0.75f, 0.8f to 0.5f, 0.92f to 0.62f, 1f to 0.4f)

private fun DrawScope.drawRidge(points: List<Pair<Float, Float>>, origin: Offset, sz: Size, brush: Brush) {
    val pts = points.map { Offset(origin.x + it.first * sz.width, origin.y + it.second * sz.height) }
    val p = Path().apply {
        moveTo(origin.x, origin.y + sz.height)
        lineTo(pts[0].x, pts[0].y)
        for (i in 1 until pts.size) {
            val a = pts[i - 1]
            val b = pts[i]
            quadraticTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2)
        }
        lineTo(pts.last().x, pts.last().y)
        lineTo(origin.x + sz.width, origin.y + sz.height)
        close()
    }
    drawPath(p, brush)
}

private val PUFFS = listOf(
    floatArrayOf(0.08f, 0.55f, 0.10f, 0.32f, 0.20f), floatArrayOf(0.18f, 0.62f, 0.14f, 0.28f, 0.16f), floatArrayOf(0.30f, 0.40f, 0.09f, 0.35f, 0.14f),
    floatArrayOf(0.42f, 0.70f, 0.16f, 0.25f, 0.18f), floatArrayOf(0.55f, 0.50f, 0.12f, 0.30f, 0.15f), floatArrayOf(0.66f, 0.66f, 0.15f, 0.26f, 0.20f),
    floatArrayOf(0.78f, 0.45f, 0.10f, 0.34f, 0.13f), floatArrayOf(0.88f, 0.60f, 0.14f, 0.28f, 0.17f), floatArrayOf(0.97f, 0.52f, 0.09f, 0.32f, 0.12f),
)

private fun DrawScope.drawClouds(sz: Size, tint: Color, opacity: Float) {
    for (p in PUFFS) {
        val c = Offset(p[0] * sz.width, p[1] * sz.height)
        val r = p[2] * sz.width
        scale(1f, p[3], pivot = c) {
            drawCircle(Brush.radialGradient(listOf(tint.copy(alpha = p[4] * opacity), tint.copy(alpha = 0f)), center = c, radius = r), radius = r, center = c)
        }
    }
}

private fun DrawScope.drawStars(seed: Long, area: Size, alpha: Float) {
    var s = seed * 6364136223846793005L + 1442695040888963407L
    fun next(): Float {
        s = s * 6364136223846793005L + 1442695040888963407L
        return ((s ushr 33) % 10_000).toFloat() / 10_000f
    }
    repeat(45) {
        val x = next() * area.width
        val y = next() * area.height
        val r = (0.5f + next() * 1.1f) * density
        val fade = 1f - (y / area.height) * 0.7f
        drawCircle(Color.White.copy(alpha = (fade * alpha).coerceIn(0f, 1f)), radius = r, center = Offset(x, y))
    }
}

/** Mosque skyline on the horizon: a large dome, two side domes, two minarets. */
fun DrawScope.drawSkyline(origin: Offset, sz: Size, color: Color) {
    fun p(x: Float, y: Float) = Offset(origin.x + x * sz.width, origin.y + y * sz.height)
    val path = Path()
    fun rect(x: Float, y: Float, w: Float, h: Float) {
        val a = p(x, y)
        path.addRect(androidx.compose.ui.geometry.Rect(a.x, a.y, a.x + w * sz.width, a.y + h * sz.height))
    }
    rect(0.16f, 0.66f, 0.68f, 0.34f)
    fun dome(cx: Float, hw: Float, base: Float, top: Float) {
        val s0 = p(cx - hw, base)
        path.moveTo(s0.x, s0.y)
        val c1 = p(cx - hw * 1.05f, base - (base - top) * 0.55f); val c2 = p(cx - hw * 0.45f, top + (base - top) * 0.2f); val e1 = p(cx, top)
        path.cubicTo(c1.x, c1.y, c2.x, c2.y, e1.x, e1.y)
        val c3 = p(cx + hw * 0.45f, top + (base - top) * 0.2f); val c4 = p(cx + hw * 1.05f, base - (base - top) * 0.55f); val e2 = p(cx + hw, base)
        path.cubicTo(c3.x, c3.y, c4.x, c4.y, e2.x, e2.y)
        path.close()
        rect(cx - 0.004f, top - 0.08f, 0.008f, 0.09f)
    }
    dome(0.5f, 0.17f, 0.68f, 0.2f)
    dome(0.27f, 0.08f, 0.7f, 0.46f)
    dome(0.73f, 0.08f, 0.7f, 0.46f)
    for (x in listOf(0.06f, 0.9f)) {
        rect(x, 0.12f, 0.04f, 0.88f)
        rect(x - 0.008f, 0.34f, 0.056f, 0.03f)
        val a = p(x, 0.12f); val b = p(x + 0.02f, 0f); val c = p(x + 0.04f, 0.12f)
        path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); path.lineTo(c.x, c.y); path.close()
    }
    drawPath(path, color)
}
