package sa.zood.nearmosque.ui.mosques

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.Point
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.Geo
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.RankedMosque
import sa.zood.nearmosque.ui.glass.BLUE
import sa.zood.nearmosque.ui.glass.GlassButton
import sa.zood.nearmosque.ui.glass.GlassButtonText
import sa.zood.nearmosque.ui.theme.Tokens

/** OpenFreeMap vector tiles (free, no key, OpenStreetMap data); needs internet for the map images. */
private const val STYLE_URL = "https://tiles.openfreemap.org/styles/dark"
private const val SOURCE = "mosques"
private const val LAYER = "mosques-layer"
private const val YOU_SOURCE = "you"

/**
 * Live street map (MapLibre). Mosques are drawn as navy pins (gold for the nearest); tapping one opens
 * its details. Moving the map far from the search point offers "Search this area".
 */
@Composable
fun MosqueMap(
    items: List<RankedMosque>,
    center: LatLng,
    device: LatLng?,
    onSelect: (RankedMosque) -> Unit,
    onSearchHere: (LatLng) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentItems by rememberUpdatedState(items)
    val select by rememberUpdatedState(onSelect)
    var map by remember { mutableStateOf<MapLibreMap?>(null) }
    var style by remember { mutableStateOf<Style?>(null) }
    var visible by remember { mutableStateOf<LatLng?>(null) }
    val mapView = remember {
        MapLibre.getInstance(context)
        MapView(context).apply { onCreate(null) }
    }
    DisposableEffect(lifecycle, mapView) {
        val observer = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_START -> mapView.onStart()
                Lifecycle.Event.ON_RESUME -> mapView.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView.onPause()
                Lifecycle.Event.ON_STOP -> mapView.onStop()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) mapView.onStart()
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) mapView.onResume()
        onDispose {
            lifecycle.removeObserver(observer)
            mapView.onPause(); mapView.onStop(); mapView.onDestroy()
        }
    }
    LaunchedEffect(mapView) {
        mapView.getMapAsync { m ->
            map = m
            m.uiSettings.isRotateGesturesEnabled = true
            m.uiSettings.isCompassEnabled = true
            m.uiSettings.isAttributionEnabled = true
            m.uiSettings.isLogoEnabled = false
            m.setStyle(Style.Builder().fromUri(STYLE_URL)) { s ->
                s.addImage("pin", pinBitmap(Tokens.navy.toArgb()))
                s.addImage("pin-near", pinBitmap(Tokens.gold.toArgb()))
                s.addImage("you", dotBitmap())
                s.addSource(GeoJsonSource(SOURCE))
                s.addSource(GeoJsonSource(YOU_SOURCE))
                s.addLayer(SymbolLayer("you-layer", YOU_SOURCE).withProperties(PropertyFactory.iconImage("you"), PropertyFactory.iconAllowOverlap(true)))
                s.addLayer(
                    SymbolLayer(LAYER, SOURCE).withProperties(
                        PropertyFactory.iconImage(org.maplibre.android.style.expressions.Expression.get("icon")),
                        PropertyFactory.iconAllowOverlap(true), PropertyFactory.iconIgnorePlacement(true),
                    ),
                )
                style = s
            }
            m.addOnMapClickListener { point ->
                val screen = m.projection.toScreenLocation(point)
                val hit = m.queryRenderedFeatures(screen, LAYER).firstOrNull()?.getStringProperty("id")
                val r = currentItems.firstOrNull { it.mosque.sourceId == hit }
                if (r != null) { select(r); true } else false
            }
            m.addOnCameraIdleListener {
                val t = m.cameraPosition.target ?: return@addOnCameraIdleListener
                visible = LatLng.orNull(t.latitude, t.longitude)
            }
        }
    }
    LaunchedEffect(map, center, items.firstOrNull()?.distanceMeters) {
        val m = map ?: return@LaunchedEffect
        val span = (items.take(6).maxOfOrNull { it.distanceMeters } ?: 2000.0).coerceIn(700.0, 20_000.0)
        val zoom = (15.5 - kotlin.math.log2(span / 500.0)).coerceIn(9.0, 16.0)
        m.cameraPosition = CameraPosition.Builder().target(org.maplibre.android.geometry.LatLng(center.latitude, center.longitude)).zoom(zoom).build()
    }
    LaunchedEffect(style, items, device) {
        val s = style ?: return@LaunchedEffect
        val features = items.take(60).mapIndexed { i, r ->
            Feature.fromGeometry(Point.fromLngLat(r.mosque.location.longitude, r.mosque.location.latitude)).apply {
                addStringProperty("id", r.mosque.sourceId)
                addStringProperty("icon", if (i == 0) "pin-near" else "pin")
            }
        }
        (s.getSource(SOURCE) as? GeoJsonSource)?.setGeoJson(FeatureCollection.fromFeatures(features))
        (s.getSource(YOU_SOURCE) as? GeoJsonSource)?.setGeoJson(
            FeatureCollection.fromFeatures(listOfNotNull(device?.let { Feature.fromGeometry(Point.fromLngLat(it.longitude, it.latitude)) })),
        )
    }
    Box(modifier) {
        AndroidView({ mapView }, Modifier.fillMaxSize())
        val v = visible
        if (v != null && Geo.distanceMeters(v, center) > 400) {
            GlassButton(onClick = { onSearchHere(v) }, prominent = true, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp)) {
                GlassButtonText(stringResource(R.string.search_this_area))
            }
        }
    }
}

private fun pinBitmap(color: Int): Bitmap {
    val size = 96
    val b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val c = Canvas(b)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.color = android.graphics.Color.argb(80, 0, 0, 0)
    c.drawCircle(size / 2f, size / 2f + 3, size / 2f - 6, p)
    p.color = color
    c.drawCircle(size / 2f, size / 2f, size / 2f - 8, p)
    p.style = Paint.Style.STROKE
    p.strokeWidth = 7f
    p.color = android.graphics.Color.WHITE
    c.drawCircle(size / 2f, size / 2f, size / 2f - 10, p)
    // Dome and minarets
    p.style = Paint.Style.FILL
    val s = size / 100f
    c.drawRect(32 * s, 56 * s, 68 * s, 72 * s, p)
    val dome = android.graphics.Path().apply {
        moveTo(34 * s, 57 * s); cubicTo(33 * s, 45 * s, 45 * s, 38 * s, 50 * s, 32 * s); cubicTo(55 * s, 38 * s, 67 * s, 45 * s, 66 * s, 57 * s); close()
    }
    c.drawPath(dome, p)
    c.drawRect(25 * s, 42 * s, 30 * s, 72 * s, p)
    c.drawRect(70 * s, 42 * s, 75 * s, 72 * s, p)
    return b
}

private fun dotBitmap(): Bitmap {
    val size = 48
    val b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val c = Canvas(b)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.color = android.graphics.Color.WHITE
    c.drawCircle(size / 2f, size / 2f, size / 2f - 2, p)
    p.color = BLUE.toArgb()
    c.drawCircle(size / 2f, size / 2f, size / 2f - 9, p)
    return b
}
