package sa.zood.nearmosque.ui.glass

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sa.zood.nearmosque.R
import sa.zood.nearmosque.ui.theme.LocalSky
import sa.zood.nearmosque.ui.theme.Tokens

/**
 * Glass surface in the spirit of Apple's Liquid Glass: a translucent body tinted with the sky so white
 * text stays legible, a light top-to-bottom sheen, a specular rim brighter at the top-left and a soft
 * shadow. The backdrop is a smooth procedural sky, so no blur pass is needed for the effect.
 */
fun Modifier.glass(shape: Shape, tint: Color? = null, shadow: Dp = 14.dp): Modifier = this
    .shadow(shadow, shape, ambientColor = Color.Black.copy(alpha = 0.35f), spotColor = Color.Black.copy(alpha = 0.35f))
    .clip(shape)
    .background(tint ?: Color.Transparent, shape)
    .background(Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.17f), Color.White.copy(alpha = 0.06f))), shape)
    .border(1.dp, Brush.linearGradient(listOf(Color.White.copy(alpha = 0.55f), Color.White.copy(alpha = 0.06f), Color.White.copy(alpha = 0.22f)), start = Offset.Zero, end = Offset.Infinite), shape)

@Composable
fun Modifier.glassSky(shape: Shape, tint: Color? = null): Modifier = glass(shape, tint ?: LocalSky.current.glassTint)

/** Glass card with the current sky tint; content is white. */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    padding: Dp = 16.dp,
    corner: Dp = Tokens.cardRadius.dp,
    tint: Color? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    CompositionLocalProvider(LocalContentColor provides Color.White) {
        Column(modifier.fillMaxWidth().glassSky(RoundedCornerShape(corner), tint).padding(padding), content = content)
    }
}

/** Capsule glass button. Prominent: gold with a dark label (white on gold is below 4.5:1). */
@Composable
fun GlassButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    prominent: Boolean = false,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.96f else 1f, spring(dampingRatio = 0.6f, stiffness = 700f), label = "press")
    val shape = RoundedCornerShape(50)
    val base = if (prominent) Modifier.shadow(10.dp, shape, spotColor = Tokens.gold).clip(shape).background(Tokens.gold, shape)
        .border(1.dp, Color.White.copy(alpha = 0.35f), shape)
    else Modifier.glass(shape, shadow = 6.dp)
    CompositionLocalProvider(LocalContentColor provides if (prominent) Tokens.navyNight else Color.White) {
        Row(
            modifier.scale(scale).alpha(if (enabled) 1f else 0.5f).then(base)
                .clickable(interactionSource = source, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
                .heightIn(min = 48.dp).padding(horizontal = 18.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
}

@Composable
fun GlassButtonText(text: String, icon: Painter? = null) {
    if (icon != null) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
    }
    Text(text, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Round 48 dp glass icon button. */
@Composable
fun GlassIconButton(icon: Painter, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = Color.White) {
    Box(
        modifier.size(48.dp).glass(CircleShape, shadow = 6.dp).clickable(role = Role.Button, onClickLabel = label, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
    }
}

/** Glass capsule with the prayer location; opens the city picker. */
@Composable
fun LocationPill(name: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.glass(RoundedCornerShape(50), shadow = 6.dp).clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp).widthIn(max = 260.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_pin), contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            name, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
            style = MaterialTheme.typography.titleSmall.copy(textDirection = sa.zood.nearmosque.ui.theme.DataDirection),
        )
        Spacer(Modifier.width(6.dp))
        Icon(painterResource(R.drawable.ic_chevron_down), contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
    }
}

/** Two-option glass segmented control with a gold thumb. */
@Composable
fun GlassSegmented(selected: Int, options: List<Pair<String, Int>>, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().glass(RoundedCornerShape(50), shadow = 6.dp).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        options.forEachIndexed { i, (label, icon) ->
            val on = i == selected
            val bg by animateColorAsState(if (on) Tokens.gold else Color.Transparent, tween(250), label = "seg")
            Row(
                Modifier.weight(1f).heightIn(min = 44.dp).clip(RoundedCornerShape(50)).background(bg)
                    .clickable(role = Role.Tab) { onSelect(i) }.semantics { this.selected = on },
                horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
            ) {
                val fg = if (on) Tokens.navyNight else Color.White
                Icon(painterResource(icon), contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(label, color = fg, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold))
            }
        }
    }
}

/** Brand disc on top of the Qibla arc; glows gold when the phone faces the Qibla. */
@Composable
fun LogoDisc(glow: Boolean, modifier: Modifier = Modifier, size: Dp = Tokens.discSize.dp, animate: Boolean = !reducedMotion()) {
    val k = 0.94f + 0.14f * loopingFloat(animate && glow, 1600, reverse = true, label = "pulse", still = 0.5f)
    val glowAlpha by animateFloatAsState(if (glow) 1f else 0f, tween(500), label = "glow")
    Box(modifier.size(size).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        if (glowAlpha > 0f) {
            Box(
                Modifier.requiredSize(size * 1.9f).scale(k).alpha(glowAlpha)
                    .background(Brush.radialGradient(listOf(Tokens.gold.copy(alpha = 0.6f), Tokens.gold.copy(alpha = 0.25f), Color.Transparent)), CircleShape),
            )
        }
        Box(
            Modifier.size(size).shadow(if (glow) 18.dp else 8.dp, CircleShape, spotColor = if (glow) Tokens.gold else Color.Black)
                .background(Color.White.copy(alpha = 0.94f), CircleShape)
                .border(if (glow) 3.dp else 1.5.dp, if (glow) Tokens.gold else Color.White.copy(alpha = 0.7f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Image(painterResource(R.drawable.logo_mark), contentDescription = null, modifier = Modifier.padding(size * 0.16f))
        }
    }
}

/** Mosque glyph (dome, finial, two minarets) drawn into [origin]/[sz]. */
fun DrawScope.drawMosqueGlyph(origin: Offset, sz: Size, color: Color) {
    fun p(x: Float, y: Float) = Offset(origin.x + x * sz.width, origin.y + y * sz.height)
    val path = Path()
    fun rect(x: Float, y: Float, w: Float, h: Float) { val a = p(x, y); path.addRect(Rect(a.x, a.y, a.x + w * sz.width, a.y + h * sz.height)) }
    rect(0.2f, 0.6f, 0.6f, 0.34f)
    val s0 = p(0.24f, 0.62f); path.moveTo(s0.x, s0.y)
    val c1 = p(0.22f, 0.42f); val c2 = p(0.42f, 0.3f); val t = p(0.5f, 0.2f)
    path.cubicTo(c1.x, c1.y, c2.x, c2.y, t.x, t.y)
    val c3 = p(0.58f, 0.3f); val c4 = p(0.78f, 0.42f); val e = p(0.76f, 0.62f)
    path.cubicTo(c3.x, c3.y, c4.x, c4.y, e.x, e.y)
    path.close()
    rect(0.485f, 0.1f, 0.03f, 0.12f)
    val dot = p(0.465f, 0.04f); path.addOval(Rect(dot.x, dot.y, dot.x + 0.07f * sz.width, dot.y + 0.07f * sz.height))
    for (x in listOf(0.04f, 0.86f)) {
        rect(x, 0.32f, 0.1f, 0.62f)
        val a = p(x, 0.32f); val b = p(x + 0.05f, 0.16f); val c = p(x + 0.1f, 0.32f)
        path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); path.lineTo(c.x, c.y); path.close()
    }
    drawPath(path, color)
}

/** Pin in the website's style: navy disc with a white mosque, gold when nearest or selected. */
@Composable
fun MosquePin(highlighted: Boolean, modifier: Modifier = Modifier, size: Dp = 38.dp) {
    val k by animateFloatAsState(if (highlighted) 1.15f else 1f, spring(dampingRatio = 0.6f), label = "pin")
    Canvas(modifier.size(size).scale(k).shadow(if (highlighted) 10.dp else 4.dp, CircleShape, spotColor = if (highlighted) Tokens.gold else Color.Black)) {
        val r = this.size.minDimension / 2
        drawCircle(if (highlighted) Tokens.gold else Tokens.navy, r)
        drawCircle(Color.White, r - 1.5.dp.toPx(), style = Stroke(3.dp.toPx()))
        val inset = this.size.width * 0.24f
        drawMosqueGlyph(Offset(inset, inset), Size(this.size.width - 2 * inset, this.size.height - 2 * inset), Color.White)
    }
}

/** Blue "you are here" dot. */
@Composable
fun YouDot(modifier: Modifier = Modifier) {
    Box(modifier.size(18.dp).shadow(4.dp, CircleShape).background(Color.White, CircleShape).padding(3.dp).background(BLUE, CircleShape))
}

val BLUE = Color(0xFF4F8EF7)

/** Content padding helper for screens under the floating glass tab bar. */
fun bottomBarPadding(extra: Dp = 0.dp) = PaddingValues(bottom = 104.dp + extra)
