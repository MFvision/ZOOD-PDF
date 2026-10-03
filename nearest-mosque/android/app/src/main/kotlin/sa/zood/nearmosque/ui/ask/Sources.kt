package sa.zood.nearmosque.ui.ask

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.intl.LocaleList
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.SourceChunk
import sa.zood.nearmosque.data.ResolvedCitation
import sa.zood.nearmosque.platform.ExternalActions
import sa.zood.nearmosque.ui.theme.LocalExtraColors
import sa.zood.nearmosque.ui.theme.QuranTextStyle
import sa.zood.nearmosque.ui.glass.glass
import androidx.compose.foundation.layout.width
import sa.zood.nearmosque.ui.theme.Tokens

/** "Quran 5:6 · Al-Maaida" (Arabic surah name for Arabic-script interfaces). */
@Composable
fun referenceLabel(c: SourceChunk, lang: String): String {
    val s = c.surah
    val a = c.ayah
    val base = if (s != null && a != null) stringResource(R.string.reference_quran, s, a) else c.anchor
    val name = if (lang == "ar" || lang == "ur") c.sectionName("nameAr") else c.sectionName("nameTranslit")
    return if (name != null) "$base · $name" else base
}

/**
 * A citation: reference, exact original quote (always in its own script direction), the translation
 * labelled with its translator, and actions to read in context offline or open the original link.
 */
@Composable
fun SourceCard(r: ResolvedCitation, lang: String, onRead: (ResolvedCitation) -> Unit) {
    val context = LocalContext.current
    val c = r.chunk
    val original = r.documents[c.original.docId]
    val white = androidx.compose.ui.graphics.Color.White
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp)
            .glass(RoundedCornerShape(20.dp), tint = white.copy(alpha = 0.04f), shadow = 4.dp).padding(14.dp),
    ) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.Top) {
            androidx.compose.material3.Icon(androidx.compose.ui.res.painterResource(R.drawable.ic_book), contentDescription = null, tint = Tokens.gold, modifier = Modifier.padding(top = 2.dp))
            Spacer(Modifier.width(10.dp))
            Column {
                Text(referenceLabel(c, lang), style = MaterialTheme.typography.titleSmall, color = white)
                Text(
                    stringResource(R.string.supporting_passage) + " · " + listOfNotNull(original?.title?.get(lang) ?: original?.title?.get("en"), original?.edition).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = white.copy(alpha = 0.7f),
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(stringResource(R.string.exact_quote), style = MaterialTheme.typography.labelSmall, color = Tokens.gold)
        CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides white) { OriginalText(c.original.text, c.original.lang) }
        c.translations.forEach { t ->
            val doc = r.documents[t.docId]
            Spacer(Modifier.height(6.dp))
            Text(
                stringResource(R.string.translation_by, listOfNotNull(doc?.translator, doc?.year?.toString()).joinToString(", ")),
                style = MaterialTheme.typography.labelSmall, color = Tokens.gold,
            )
            Text(
                t.text, color = white,
                style = MaterialTheme.typography.bodyMedium.copy(textDirection = TextDirection.Ltr, localeList = LocaleList(t.lang)),
            )
        }
        Row {
            val link = androidx.compose.ui.graphics.Color(0xFF8CC0DE)
            TextButton(onClick = { onRead(r) }, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.source_open), color = link) }
            c.url?.let { url -> TextButton(onClick = { ExternalActions.open(context, url) }, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.source_original_link), color = link) } }
        }
    }
}

@Composable
private fun OriginalText(text: String, lang: String, emphasized: Boolean = true) {
    val rtl = lang == "ar" || lang == "ur"
    CompositionLocalProvider(LocalLayoutDirection provides if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr) {
        Text(
            text,
            Modifier.fillMaxWidth(),
            style = (if (rtl) QuranTextStyle else MaterialTheme.typography.bodyLarge).copy(
                textDirection = if (rtl) TextDirection.Rtl else TextDirection.Ltr, localeList = LocaleList(lang),
                fontWeight = if (emphasized) FontWeight.Normal else FontWeight.Light,
            ),
            textAlign = TextAlign.Start,
        )
    }
}

/** Offline reader: the cited passage with its surrounding verses. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaderSheet(r: ResolvedCitation, vm: AskViewModel, onDismiss: () -> Unit) {
    val lang = sa.zood.nearmosque.ui.Format.languageCode(LocalContext.current)
    var around by remember { mutableStateOf<List<SourceChunk>>(emptyList()) }
    LaunchedEffect(r.chunk.id) { around = vm.context(r) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).padding(horizontal = 16.dp)) {
            Text(referenceLabel(r.chunk, lang), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.surrounding_context), style = MaterialTheme.typography.bodyMedium, color = LocalExtraColors.current.textSecondary)
            LazyColumn {
                items(around, key = { it.id }) { c ->
                    val cited = c.id == r.chunk.id
                    Column(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp)
                            .background(if (cited) Tokens.gold.copy(alpha = 0.16f) else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(12.dp))
                            .padding(10.dp),
                    ) {
                        Text(referenceLabel(c, lang), style = MaterialTheme.typography.labelLarge, color = Tokens.gold)
                        OriginalText(c.original.text, c.original.lang, emphasized = cited)
                        c.translations.forEach { t ->
                            Text(t.text, style = MaterialTheme.typography.bodyMedium.copy(textDirection = TextDirection.Ltr))
                        }
                    }
                }
            }
        }
    }
}
