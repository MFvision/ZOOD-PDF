package sa.zood.nearmosque.ui.prayer

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import sa.zood.nearmosque.AppContainer
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.AsrMadhab
import sa.zood.nearmosque.core.City
import sa.zood.nearmosque.core.HighLatRule
import sa.zood.nearmosque.core.Method
import sa.zood.nearmosque.core.PolarRule
import sa.zood.nearmosque.core.PrayerEvent
import sa.zood.nearmosque.core.PrayerSettings
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.theme.LocalExtraColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CityPickerSheet(container: AppContainer, vm: PrayerViewModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<City>>(emptyList()) }
    LaunchedEffect(query) { results = container.cities.index().search(query, 40) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        vm.useDeviceLocation(context.getString(R.string.location_current))
        onDismiss()
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).imePadding().padding(horizontal = 16.dp)) {
            Text(stringResource(R.string.choose_city_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) {
                Icon(Icons.Filled.LocationOn, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.use_my_location))
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                label = { Text(stringResource(R.string.search_city)) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth(),
            )
            if (results.isEmpty() && query.isNotBlank()) {
                Text(stringResource(R.string.no_city_results), Modifier.padding(vertical = 16.dp), color = LocalExtraColors.current.textSecondary)
            }
            LazyColumn(Modifier.fillMaxWidth()) {
                items(results, key = { it.id }) { city ->
                    val name = city.displayName(lang)
                    Column(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button) {
                            vm.chooseCity(city, name)
                            onDismiss()
                        }.padding(vertical = 10.dp),
                    ) {
                        Text(name, style = MaterialTheme.typography.bodyLarge.copy(textDirection = sa.zood.nearmosque.ui.theme.DataDirection))
                        Text(
                            Format.country(context, city.countryCode) + " · " + city.zoneId,
                            style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary,
                        )
                    }
                    HorizontalDivider(color = LocalExtraColors.current.textSecondary.copy(alpha = 0.12f))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalculationSheet(settings: PrayerSettings, vm: PrayerViewModel, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
            SheetHeading(stringResource(R.string.calculation_method))
            Text(stringResource(R.string.method_suggested), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
            Method.entries.forEach { m ->
                RadioRow(stringResource(Format.methodName(m)), settings.method == m) { vm.setMethod(m) }
            }
            SheetHeading(stringResource(R.string.asr_method))
            RadioRow(stringResource(R.string.asr_standard), settings.madhab == AsrMadhab.SHAFI) { vm.setMadhab(AsrMadhab.SHAFI) }
            RadioRow(stringResource(R.string.asr_hanafi), settings.madhab == AsrMadhab.HANAFI) { vm.setMadhab(AsrMadhab.HANAFI) }
            SheetHeading(stringResource(R.string.high_latitude_rule))
            listOf(
                HighLatRule.AUTO to R.string.hl_auto, HighLatRule.MIDDLE_OF_THE_NIGHT to R.string.hl_middle,
                HighLatRule.SEVENTH_OF_THE_NIGHT to R.string.hl_seventh, HighLatRule.TWILIGHT_ANGLE to R.string.hl_twilight,
            ).forEach { (r, label) -> RadioRow(stringResource(label), settings.highLatitudeRule == r) { vm.setHighLat(r) } }
            SheetHeading(stringResource(R.string.polar_rule))
            RadioRow(stringResource(R.string.polar_none), settings.polarRule == PolarRule.UNAVAILABLE) { vm.setPolar(PolarRule.UNAVAILABLE) }
            RadioRow(stringResource(R.string.polar_nearest), settings.polarRule == PolarRule.NEAREST_LATITUDE) { vm.setPolar(PolarRule.NEAREST_LATITUDE) }
            if (settings.method == Method.UMM_AL_QURA) {
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.ramadan_isha), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    Switch(checked = settings.ramadanIshaExtension, onCheckedChange = vm::setRamadanIsha)
                }
            }
            SheetHeading(stringResource(R.string.hijri_adjustment))
            Stepper(settings.hijriAdjustmentDays.toString(), { vm.setHijriAdjustment(settings.hijriAdjustmentDays - 1) }, { vm.setHijriAdjustment(settings.hijriAdjustmentDays + 1) })
            SheetHeading(stringResource(R.string.minute_adjustments))
            PrayerEvent.entries.forEach { e ->
                val v = settings.offsets[e] ?: 0
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(Format.prayerName(e)), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    Stepper(stringResource(R.string.minutes_value, v), { vm.setOffset(e, v - 1) }, { vm.setOffset(e, v + 1) })
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun SheetHeading(text: String) {
    Text(text, Modifier.padding(top = 16.dp, bottom = 4.dp).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
}

@Composable
fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).selectable(selected, role = Role.RadioButton, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun Stepper(value: String, onMinus: () -> Unit, onPlus: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = onMinus, modifier = Modifier.heightIn(min = 48.dp)) { Text("−") }
        Text(value, style = MaterialTheme.typography.bodyLarge)
        TextButton(onClick = onPlus, modifier = Modifier.heightIn(min = 48.dp)) { Text("+") }
    }
}
