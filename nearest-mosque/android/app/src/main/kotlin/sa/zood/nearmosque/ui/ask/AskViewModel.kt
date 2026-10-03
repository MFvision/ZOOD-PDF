package sa.zood.nearmosque.ui.ask

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import sa.zood.nearmosque.AppContainer
import sa.zood.nearmosque.core.Answer
import sa.zood.nearmosque.core.CommonQuestion
import sa.zood.nearmosque.data.ResolvedCitation

data class Turn(
    val id: Long,
    val question: String,
    val answer: Answer? = null,
    val citations: List<ResolvedCitation> = emptyList(),
    val related: List<ResolvedCitation> = emptyList(),
)

data class AskUi(
    val ready: Boolean = false,
    val common: List<CommonQuestion> = emptyList(),
    val turns: List<Turn> = emptyList(),
    val busy: Boolean = false,
)

/**
 * Conversation lives in memory only (not persisted, not sent anywhere). Answers come from the
 * local retriever; there is no on-device generator on Android in this build, so every answer is
 * the cited-search form, which is the required fallback anyway.
 */
class AskViewModel(private val c: AppContainer) : ViewModel() {
    private val _ui = MutableStateFlow(AskUi())
    val ui: StateFlow<AskUi> = _ui.asStateFlow()
    private var job: Job? = null
    private var nextId = 1L

    init {
        viewModelScope.launch {
            c.ready.first { it }
            _ui.value = _ui.value.copy(ready = true, common = c.ask.commonQuestions())
        }
    }

    fun ask(text: String) {
        val q = text.trim()
        if (q.isEmpty() || _ui.value.busy) return
        val context = _ui.value.turns.takeLast(2).map { it.question }
        run(q) { c.ask.ask(q, context) }
    }

    fun askCommon(q: CommonQuestion, displayed: String) = run(displayed) { c.ask.answerFor(q, displayed) }

    private fun run(question: String, block: suspend () -> Answer) {
        val turn = Turn(nextId++, question)
        _ui.value = _ui.value.copy(turns = _ui.value.turns + turn, busy = true)
        job = viewModelScope.launch {
            try {
                val a = block()
                val cites = c.ask.resolve(a.citations)
                val related = c.ask.resolve(a.related)
                update(turn.id) { it.copy(answer = a, citations = cites, related = related) }
            } finally {
                _ui.value = _ui.value.copy(busy = false)
            }
        }
    }

    fun stop() {
        job?.cancel()
        _ui.value = _ui.value.copy(busy = false, turns = _ui.value.turns.filter { it.answer != null })
    }

    fun newConversation() {
        job?.cancel()
        _ui.value = _ui.value.copy(turns = emptyList(), busy = false)
    }

    suspend fun context(c: ResolvedCitation) = this.c.ask.context(c)

    private fun update(id: Long, f: (Turn) -> Turn) {
        _ui.value = _ui.value.copy(turns = _ui.value.turns.map { if (it.id == id) f(it) else it })
    }
}
