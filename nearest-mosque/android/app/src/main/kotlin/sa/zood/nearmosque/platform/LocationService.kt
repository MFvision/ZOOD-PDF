package sa.zood.nearmosque.platform

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import sa.zood.nearmosque.core.LatLng
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/** "You are here". Never substituted with a default city. */
data class DevicePosition(val location: LatLng, val accuracyMeters: Float?, val timeMillis: Long, val altitudeMeters: Double?)

enum class LocationPermission { GRANTED_PRECISE, GRANTED_APPROXIMATE, DENIED }

/**
 * Foreground location through the platform LocationManager (GNSS works without mobile data;
 * no Google Play services dependency). Requested only at the point of use.
 */
class LocationService(private val context: Context) {
    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val executor = Executors.newSingleThreadExecutor()

    fun permission(): LocationPermission = when {
        granted(Manifest.permission.ACCESS_FINE_LOCATION) -> LocationPermission.GRANTED_PRECISE
        granted(Manifest.permission.ACCESS_COARSE_LOCATION) -> LocationPermission.GRANTED_APPROXIMATE
        else -> LocationPermission.DENIED
    }

    fun isLocationEnabled(): Boolean = runCatching {
        if (Build.VERSION.SDK_INT >= 28) manager.isLocationEnabled
        else manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }.getOrDefault(false)

    private fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

    /** A recent last-known fix, if any (age is reported to the user, never hidden). */
    @SuppressLint("MissingPermission")
    fun lastKnown(maxAgeMillis: Long = 10 * 60_000L): DevicePosition? {
        if (permission() == LocationPermission.DENIED) return null
        val now = System.currentTimeMillis()
        return providers().mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .filter { now - it.time <= maxAgeMillis }
            .minByOrNull { it.accuracy }
            ?.toPosition()
    }

    /** One fresh fix, or null on timeout/no provider. */
    @SuppressLint("MissingPermission")
    suspend fun currentPosition(timeoutMillis: Long = 20_000): DevicePosition? {
        if (permission() == LocationPermission.DENIED) return null
        val provider = providers().firstOrNull() ?: return null
        return withTimeoutOrNull(timeoutMillis) {
            suspendCancellableCoroutine { cont ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val signal = CancellationSignal()
                    cont.invokeOnCancellation { signal.cancel() }
                    manager.getCurrentLocation(provider, signal, executor) { loc -> if (cont.isActive) cont.resume(loc?.toPosition()) }
                } else {
                    val listener = object : LocationListener {
                        override fun onLocationChanged(location: Location) {
                            manager.removeUpdates(this)
                            if (cont.isActive) cont.resume(location.toPosition())
                        }
                        @Deprecated("Deprecated in Java")
                        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
                        override fun onProviderEnabled(provider: String) {}
                        override fun onProviderDisabled(provider: String) {}
                    }
                    cont.invokeOnCancellation { manager.removeUpdates(listener) }
                    manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
                }
            }
        }
    }

    private fun providers(): List<String> {
        val enabled = runCatching { manager.getProviders(true) }.getOrDefault(emptyList())
        val order = buildList {
            if (permission() == LocationPermission.GRANTED_PRECISE) add(LocationManager.GPS_PROVIDER)
            if (Build.VERSION.SDK_INT >= 31) add(LocationManager.FUSED_PROVIDER)
            add(LocationManager.NETWORK_PROVIDER)
            add(LocationManager.PASSIVE_PROVIDER)
        }
        return order.filter { it in enabled }
    }

    private fun Location.toPosition(): DevicePosition? = LatLng.orNull(latitude, longitude)?.let {
        DevicePosition(it, if (hasAccuracy()) accuracy else null, time, if (hasAltitude()) altitude else null)
    }
}
