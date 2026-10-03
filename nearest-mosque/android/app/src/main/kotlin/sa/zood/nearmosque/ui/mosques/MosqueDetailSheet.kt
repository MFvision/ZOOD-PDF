package sa.zood.nearmosque.ui.mosques

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import sa.zood.nearmosque.R
import sa.zood.nearmosque.container
import sa.zood.nearmosque.core.MosqueCategory
import sa.zood.nearmosque.core.PackManifest
import sa.zood.nearmosque.core.RankedMosque
import sa.zood.nearmosque.platform.ExternalActions
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.theme.DataDirection
import sa.zood.nearmosque.ui.theme.LocalExtraColors
import sa.zood.nearmosque.ui.theme.Tokens

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MosqueDetailSheet(r: RankedMosque, favorite: Boolean, onToggleFavorite: () -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    val m = r.mosque
    val name = m.displayName(lang) ?: stringResource(R.string.mosque_unnamed)
    var manifest by remember { mutableStateOf<PackManifest?>(null) }
    LaunchedEffect(m.packId) { manifest = context.container.mosques.packManifest(m.packId) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.headlineSmall.copy(textDirection = DataDirection), modifier = Modifier.semantics { heading() })
                    // Other recorded names (e.g. Arabic and English) are shown, never translated by the app.
                    m.names.filterKeys { it != "default" }.values.filter { it != name }.distinct().take(2).forEach {
                        Text(it, style = MaterialTheme.typography.bodyMedium.copy(textDirection = DataDirection), color = LocalExtraColors.current.textSecondary)
                    }
                }
                // Only downloaded records can be favorites (live results have no stable record on the phone).
                if (m.packId.startsWith("mosques.")) {
                    IconToggleButton(checked = favorite, onCheckedChange = { onToggleFavorite() }) {
                        Icon(
                            Icons.Filled.Star, tint = if (favorite) Tokens.gold else LocalExtraColors.current.textSecondary,
                            contentDescription = stringResource(if (favorite) R.string.favorite_remove else R.string.favorite_add),
                        )
                    }
                }
            }
            Text(
                stringResource(if (m.category == MosqueCategory.PRAYER_SPACE) R.string.category_prayer_space else R.string.category_mosque) +
                    " · " + stringResource(R.string.straight_line, Format.distance(context, r.distanceMeters)),
                style = MaterialTheme.typography.bodyLarge,
            )
            m.address?.let { Text(it, style = MaterialTheme.typography.bodyMedium.copy(textDirection = DataDirection)) }
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.hours_unknown), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.accentText)
            m.openingHoursRaw?.let { Text(stringResource(R.string.hours_listed, it), style = MaterialTheme.typography.bodyMedium) }
            Text(stringResource(R.string.hours_unverified_note), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = { ExternalActions.directions(context, m.location, name) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) {
                Icon(painterResource(R.drawable.ic_directions), contentDescription = null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.directions))
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { m.phone?.let { ExternalActions.call(context, it) } }, enabled = m.phone != null, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Icon(Icons.Filled.Call, contentDescription = null); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.call))
                }
                OutlinedButton(onClick = { m.website?.let { ExternalActions.open(context, it) } }, enabled = m.website != null, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Icon(painterResource(R.drawable.ic_globe), contentDescription = null); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.website))
                }
            }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.external_maps_note), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
            val src = manifest?.source
            if (m.packId == sa.zood.nearmosque.core.OnlineMosques.PACK_ID) {
                Text(stringResource(R.string.source_online_osm), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
            }
            Text(
                stringResource(R.string.record_source, "OpenStreetMap " + m.sourceId.removePrefix("osm:"), (m.sourceTimestamp ?: src?.snapshot ?: "").take(10)),
                style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary,
            )
            Text(stringResource(R.string.data_attribution_osm), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
            Spacer(Modifier.height(16.dp))
        }
    }
}
