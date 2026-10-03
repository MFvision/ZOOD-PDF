package sa.zood.nearmosque.ui.settings

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sa.zood.nearmosque.AppContainer
import sa.zood.nearmosque.BuildConfig
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.PackError
import sa.zood.nearmosque.core.PackJson
import sa.zood.nearmosque.core.PackManifest
import sa.zood.nearmosque.data.InstalledPackEntity
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.prayer.RadioRow
import sa.zood.nearmosque.ui.prayer.PrayerUi
import sa.zood.nearmosque.ui.theme.LocalExtraColors

/** Each language is listed in its own name so anyone can find theirs. */
val LANGUAGES = listOf(
    "en" to "English", "ar" to "العربية", "ur" to "اردو", "tr" to "Türkçe",
    "id" to "Bahasa Indonesia", "fr" to "Français", "es" to "Español",
)

@Composable
fun SettingsScreen(
    container: AppContainer,
    prayer: PrayerUi,
    onPickCity: () -> Unit,
    onOpenCalculation: () -> Unit,
    onReplayTour: () -> Unit,
    onOnlineSearch: (Boolean) -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    val scope = rememberCoroutineScope()
    val packs by container.packs.installed.collectAsStateWithLifecycle(emptyList())
    var message by remember { mutableStateOf<String?>(null) }
    var confirmRemove by remember { mutableStateOf<InstalledPackEntity?>(null) }
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            message = try {
                val m = container.packs.importZip(uri)
                context.getString(R.string.import_done, m.title(lang))
            } catch (e: PackError.Checksum) {
                context.getString(R.string.import_failed, context.getString(R.string.error_pack_checksum))
            } catch (e: PackError.NewerSchema) {
                context.getString(R.string.import_failed, context.getString(R.string.error_pack_newer))
            } catch (e: Exception) {
                context.getString(R.string.import_failed, context.getString(R.string.error_pack_format))
            }
        }
    }
    val current = AppCompatDelegate.getApplicationLocales().takeIf { !it.isEmpty }?.get(0)?.language?.let { if (it == "in") "id" else it }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.settings), Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
                IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.close)) }
            }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                Section(stringResource(R.string.language))
                RadioRow(stringResource(R.string.use_device_language), current == null) {
                    AppCompatDelegate.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
                }
                LANGUAGES.forEach { (code, name) ->
                    RadioRow(name, current == code) { AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(code)) }
                }
                Text(stringResource(R.string.draft_translations_note), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)

                Section(stringResource(R.string.location_section))
                Text(prayer.location?.name ?: "—", style = MaterialTheme.typography.bodyLarge)
                prayer.location?.let { Text(stringResource(R.string.time_zone_label, Format.zoneName(context, it.zoneId)), style = MaterialTheme.typography.bodySmall) }
                OutlinedButton(onClick = onPickCity, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.change)) }

                Section(stringResource(R.string.tab_mosques))
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.online_search), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    androidx.compose.material3.Switch(checked = prayer.settings?.onlineSearch ?: true, onCheckedChange = onOnlineSearch)
                }
                Text(stringResource(R.string.online_search_body), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)

                Section(stringResource(R.string.prayer_section))
                prayer.settings?.prayer?.let { Text(stringResource(Format.methodName(it.method)), style = MaterialTheme.typography.bodyLarge) }
                OutlinedButton(onClick = onOpenCalculation, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.calculation)) }

                Section(stringResource(R.string.downloads))
                Text(stringResource(R.string.downloads_body), style = MaterialTheme.typography.bodyMedium)
                container.packs.citiesManifest()?.let { m ->
                    PackRow(stringResource(R.string.pack_kind_cities), m, m.recordCount, m.files.sumOf { it.bytes }, builtin = true, onRemove = null)
                }
                packs.forEach { p ->
                    val m = PackJson.decodeFromString(PackManifest.serializer(), p.manifestJson)
                    val title = when (p.kind) {
                        "mosques" -> stringResource(R.string.pack_kind_mosques, m.coverage?.name ?: m.title(lang))
                        else -> stringResource(R.string.pack_kind_books, m.title(lang))
                    }
                    PackRow(title, m, p.recordCount, p.bytes, p.builtin) { confirmRemove = p }
                }
                Row {
                    TextButton(onClick = { importer.launch(arrayOf("application/zip", "application/octet-stream")) }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.import_pack))
                    }
                    TextButton(onClick = { scope.launch { container.packs.restoreBuiltins() } }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.restore_builtin))
                    }
                }
                message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.accentText) }

                Section(stringResource(R.string.on_device_ai))
                Text(stringResource(R.string.ai_pack_not_installed), style = MaterialTheme.typography.bodyMedium)
                Section(stringResource(R.string.cloud_ai))
                Text(stringResource(R.string.cloud_ai_off), style = MaterialTheme.typography.bodyMedium)

                Section(stringResource(R.string.sources_licenses))
                (listOfNotNull(container.packs.citiesManifest()) + packs.map { PackJson.decodeFromString(PackManifest.serializer(), it.manifestJson) })
                    .distinctBy { it.license.attribution }
                    .forEach { m ->
                        Text(m.license.attribution, style = MaterialTheme.typography.bodyMedium)
                        Text(m.license.name + " · " + m.license.url, style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
                        Spacer(Modifier.height(6.dp))
                    }
                Text("Adhan (MIT) · Batoul Apps; MapLibre Android (BSD-2-Clause)", style = MaterialTheme.typography.bodySmall)
                Text(stringResource(R.string.map_attribution_ofm), style = MaterialTheme.typography.bodySmall)

                Section(stringResource(R.string.privacy))
                Text(stringResource(R.string.privacy_body), style = MaterialTheme.typography.bodyMedium)

                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onReplayTour, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.onb_replay)) }

                Section(stringResource(R.string.about))
                Text(stringResource(R.string.version_label, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(32.dp))
            }
        }
    }
    confirmRemove?.let { p ->
        val m = PackJson.decodeFromString(PackManifest.serializer(), p.manifestJson)
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            text = { Text(stringResource(R.string.remove_pack_confirm, m.coverage?.name ?: m.title(lang))) },
            confirmButton = { TextButton(onClick = { scope.launch { container.packs.remove(p.id) }; confirmRemove = null }) { Text(stringResource(R.string.remove)) } },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun Section(title: String) {
    Spacer(Modifier.height(20.dp))
    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
    HorizontalDivider(Modifier.padding(vertical = 6.dp))
}

@Composable
private fun PackRow(title: String, m: PackManifest, records: Int, bytes: Long, builtin: Boolean, onRemove: (() -> Unit)?) {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                stringResource(
                    R.string.pack_details, Format.number(context, records.toDouble(), 0),
                    android.text.format.Formatter.formatShortFileSize(context, bytes), m.version.toString(),
                ) + if (builtin) " · " + stringResource(R.string.pack_builtin) else "",
                style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary,
            )
        }
        if (onRemove != null) TextButton(onClick = onRemove, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.remove)) }
    }
}
