package sa.zood.nearmosque.ui.ask

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.AnswerKind
import sa.zood.nearmosque.core.CommonQuestion
import sa.zood.nearmosque.data.ResolvedCitation
import sa.zood.nearmosque.ui.Format
import sa.zood.nearmosque.ui.components.SectionCard
import sa.zood.nearmosque.ui.theme.LocalExtraColors
import sa.zood.nearmosque.ui.theme.Tokens

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AskScreen(vm: AskViewModel, onOpenSettings: () -> Unit, contentPadding: PaddingValues) {
    val context = LocalContext.current
    val lang = Format.languageCode(context)
    val ui by vm.ui.collectAsStateWithLifecycle()
    var input by rememberSaveable { mutableStateOf("") }
    var reading by remember { mutableStateOf<ResolvedCitation?>(null) }
    val list = rememberLazyListState()
    LaunchedEffect(ui.turns.size, ui.turns.lastOrNull()?.answer) { if (ui.turns.isNotEmpty()) list.animateScrollToItem(list.layoutInfo.totalItemsCount.coerceAtLeast(1) - 1) }

    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.tab_ask), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, color = LocalExtraColors.current.textSecondary)
            if (ui.turns.isNotEmpty()) {
                IconButton(onClick = vm::newConversation) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.new_conversation)) }
            }
            IconButton(onClick = onOpenSettings) { Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings)) }
        }
        LazyColumn(Modifier.weight(1f), state = list, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (ui.turns.isEmpty()) {
                item("intro") {
                    Text(stringResource(R.string.ask_title), style = MaterialTheme.typography.displaySmall, modifier = Modifier.semantics { heading() })
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.ask_subtitle), style = MaterialTheme.typography.bodyLarge, color = LocalExtraColors.current.textSecondary)
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.ai_pack_not_installed), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
                }
                item("common") {
                    Text(stringResource(R.string.common_questions), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp).semantics { heading() })
                    Spacer(Modifier.height(8.dp))
                    if (!ui.ready) CircularProgressIndicator(Modifier.size(24.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ui.common.forEach { q ->
                            val text = q.question[lang] ?: q.question["en"] ?: q.id
                            AssistChip(onClick = { vm.askCommon(q, text) }, label = { Text(text, Modifier.padding(vertical = 8.dp)) }, modifier = Modifier.heightIn(min = 48.dp))
                        }
                    }
                }
            }
            items(ui.turns, key = { it.id }) { t ->
                Column {
                    Surface(shape = RoundedCornerShape(18.dp), color = Tokens.navy, modifier = Modifier.align(Alignment.End)) {
                        Text(t.question, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.typography.bodyLarge)
                    }
                    Spacer(Modifier.height(8.dp))
                    if (t.answer == null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(R.string.answer_searching), modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                            TextButton(onClick = vm::stop) { Text(stringResource(R.string.stop)) }
                        }
                    } else {
                        AnswerCard(t, lang, onRead = { reading = it })
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = contentPadding.calculateBottomPadding() + 8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = input, onValueChange = { input = it }, modifier = Modifier.weight(1f),
                placeholder = { Text(stringResource(if (ui.turns.isEmpty()) R.string.ask_placeholder else R.string.ask_follow_up_placeholder)) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { vm.ask(input); input = "" }),
                maxLines = 4, shape = RoundedCornerShape(24.dp),
            )
            Spacer(Modifier.width(8.dp))
            FilledIconButton(onClick = { vm.ask(input); input = "" }, enabled = input.isNotBlank() && !ui.busy, modifier = Modifier.size(52.dp)) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.ask_send))
            }
        }
    }
    reading?.let { ReaderSheet(it, vm, onDismiss = { reading = null }) }
}

@Composable
private fun AnswerCard(t: Turn, lang: String, onRead: (ResolvedCitation) -> Unit) {
    val a = t.answer ?: return
    var more by rememberSaveable(t.id) { mutableStateOf(false) }
    SectionCard(Modifier.semantics(mergeDescendants = false) { liveRegion = LiveRegionMode.Polite }) {
        when (a.kind) {
            AnswerKind.COMMON -> {
                val q = a.commonQuestion!!
                Text(
                    if (q.isReviewed) stringResource(R.string.answer_common_reviewed, q.reviewedBy!!) else stringResource(R.string.answer_common_unreviewed),
                    style = MaterialTheme.typography.labelLarge, color = LocalExtraColors.current.accentText,
                )
                Spacer(Modifier.height(6.dp))
                Text(summaryFor(q, lang), style = MaterialTheme.typography.bodyLarge)
            }
            AnswerKind.PASSAGES -> {
                Text(stringResource(R.string.answer_from_passages), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.answer_from_passages_body), style = MaterialTheme.typography.bodyMedium)
            }
            AnswerKind.INSUFFICIENT -> {
                Text(stringResource(R.string.answer_insufficient_title), style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(4.dp))
                Text(stringResource(R.string.answer_insufficient_body), style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (t.citations.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.sources), style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
            t.citations.forEach { SourceCard(it, lang, onRead) }
        }
        if (t.related.isNotEmpty()) {
            TextButton(onClick = { more = !more }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(if (more) R.string.show_less_detail else R.string.show_more_detail))
            }
            if (more) {
                Text(stringResource(R.string.related_passages), style = MaterialTheme.typography.titleSmall)
                t.related.forEach { SourceCard(it, lang, onRead) }
            }
        }
        if (lang != "ar" && lang != "en" && a.kind != AnswerKind.INSUFFICIENT) {
            Text(stringResource(R.string.answer_language_note), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
        }
        Spacer(Modifier.height(6.dp))
        Text(stringResource(R.string.answer_not_fatwa), style = MaterialTheme.typography.bodySmall, color = LocalExtraColors.current.textSecondary)
    }
}

/** Summary in the interface language, else English; the label always says it is not yet reviewed. */
fun summaryFor(q: CommonQuestion, lang: String): String = q.summary[lang] ?: q.summary["en"].orEmpty()
