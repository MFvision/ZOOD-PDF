package sa.zood.nearmosque

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import sa.zood.nearmosque.ui.AppRoot
import sa.zood.nearmosque.ui.theme.NearMosqueTheme

/** AppCompatActivity so the per-app language override also applies on Android 12 and below. */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Always on a sky: light status and navigation bar icons.
        enableEdgeToEdge(
            statusBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        setContent {
            NearMosqueTheme {
                AppRoot(container)
            }
        }
    }
}
