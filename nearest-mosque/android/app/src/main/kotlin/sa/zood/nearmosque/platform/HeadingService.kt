package sa.zood.nearmosque.platform

import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.Surface
import android.view.WindowManager
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import sa.zood.nearmosque.core.Angles
import sa.zood.nearmosque.core.CompassState
import sa.zood.nearmosque.core.HeadingSmoother
import sa.zood.nearmosque.core.LatLng

/**
 * True-north heading from TYPE_ROTATION_VECTOR (accelerometer + gyroscope + magnetometer fusion,
 * referenced to magnetic north) corrected by the World Magnetic Model declination for the location.
 * GAME_ROTATION_VECTOR is never used: it has no north reference. Sensors run only while collected.
 */
class HeadingService(private val context: Context) {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager

    val hasCompass: Boolean
        get() = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) != null ||
            (sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) != null && sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null)

    fun headings(location: LatLng, altitudeMeters: Double = 0.0, smoothing: Double = 0.18): Flow<CompassState> = callbackFlow {
        val rotation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        val magnetic = sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
        val accel = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        if (rotation == null && (magnetic == null || accel == null)) {
            trySend(CompassState.BearingOnly)
            awaitClose { }
            return@callbackFlow
        }
        val declination = GeomagneticField(
            location.latitude.toFloat(), location.longitude.toFloat(), altitudeMeters.toFloat(), System.currentTimeMillis(),
        ).declination.toDouble()
        val smoother = HeadingSmoother(smoothing)
        val rotationMatrix = FloatArray(9)
        val remapped = FloatArray(9)
        val orientation = FloatArray(3)
        var gravity: FloatArray? = null
        var geomagnetic: FloatArray? = null
        var magAccuracy = SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM

        fun emit(estimatedErrorDeg: Double?) {
            remap(rotationMatrix, remapped)
            SensorManager.getOrientation(remapped, orientation)
            val magneticHeading = Angles.normalize360(Math.toDegrees(orientation[0].toDouble()))
            val trueHeading = smoother.update(Angles.trueHeading(magneticHeading, declination))
            val calibrate = magAccuracy <= SensorManager.SENSOR_STATUS_ACCURACY_LOW
            val accuracy = estimatedErrorDeg ?: when (magAccuracy) {
                SensorManager.SENSOR_STATUS_ACCURACY_HIGH -> 10.0
                SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM -> 20.0
                SensorManager.SENSOR_STATUS_ACCURACY_LOW -> 35.0
                else -> null
            }
            trySend(CompassState.Live(trueHeading, accuracy, calibrate))
        }

        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                when (e.sensor.type) {
                    Sensor.TYPE_ROTATION_VECTOR -> {
                        SensorManager.getRotationMatrixFromVector(rotationMatrix, e.values)
                        // values[4] is the estimated heading accuracy in radians when available (-1 otherwise).
                        val est = if (e.values.size > 4 && e.values[4] >= 0) Math.toDegrees(e.values[4].toDouble()) else null
                        emit(est)
                    }
                    Sensor.TYPE_ACCELEROMETER -> gravity = e.values.clone()
                    Sensor.TYPE_MAGNETIC_FIELD -> {
                        geomagnetic = e.values.clone()
                        val g = gravity
                        if (rotation == null && g != null && SensorManager.getRotationMatrix(rotationMatrix, null, g, e.values)) emit(null)
                    }
                }
            }

            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
                if (sensor.type == Sensor.TYPE_MAGNETIC_FIELD || sensor.type == Sensor.TYPE_ROTATION_VECTOR) magAccuracy = accuracy
            }
        }
        if (rotation != null) sensors.registerListener(listener, rotation, SensorManager.SENSOR_DELAY_UI)
        // The magnetometer is also registered to receive its calibration status.
        magnetic?.let { sensors.registerListener(listener, it, SensorManager.SENSOR_DELAY_UI) }
        if (rotation == null) accel?.let { sensors.registerListener(listener, it, SensorManager.SENSOR_DELAY_UI) }
        awaitClose { sensors.unregisterListener(listener) }
    }

    /** Keep north correct whatever way the screen is rotated. */
    private fun remap(input: FloatArray, out: FloatArray) {
        @Suppress("DEPRECATION")
        val rotation = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation
        val (x, y) = when (rotation) {
            Surface.ROTATION_90 -> SensorManager.AXIS_Y to SensorManager.AXIS_MINUS_X
            Surface.ROTATION_180 -> SensorManager.AXIS_MINUS_X to SensorManager.AXIS_MINUS_Y
            Surface.ROTATION_270 -> SensorManager.AXIS_MINUS_Y to SensorManager.AXIS_X
            else -> SensorManager.AXIS_X to SensorManager.AXIS_Y
        }
        SensorManager.remapCoordinateSystem(input, x, y, out)
    }
}
