package sa.zood.nearmosque.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.ln

val PackJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

@Serializable
data class TextPart(val docId: String, val lang: String, val text: String)

/** One JSON line of a book pack (see tools/build_quran_pack.py). Anchors are stable across versions. */
@Serializable
data class SourceChunk(
    val id: String,
    val seq: Long,
    val anchor: String,
    val section: JsonObject = JsonObject(emptyMap()),
    val original: TextPart,
    val translations: List<TextPart> = emptyList(),
    val url: String? = null,
) {
    val surah: Int? get() = section["surah"]?.jsonPrimitive?.int
    val ayah: Int? get() = section["ayah"]?.jsonPrimitive?.int
    fun sectionName(key: String): String? = section[key]?.jsonPrimitive?.content

    /** Normalized index text: original and every translation. */
    fun searchText(): String = TextNormalizer.searchText(original.text + " " + translations.joinToString(" ") { it.text })
}

@Serializable
data class SourceDocument(
    val id: String,
    val kind: String,
    val title: Map<String, String>,
    val edition: String? = null,
    val publisher: String? = null,
    val translator: String? = null,
    val year: Int? = null,
    val language: String,
    val url: String? = null,
    val retrievedAt: String? = null,
    val sourceSha256: String? = null,
    val translationOf: String? = null,
)

@Serializable
data class CommonQuestion(
    val id: String,
    val citations: List<String>,
    val reviewStatus: String,
    val reviewedBy: String? = null,
    val reviewedAt: String? = null,
    val question: Map<String, String>,
    val summary: Map<String, String>,
    val triggers: Map<String, List<String>> = emptyMap(),
    val expansion: List<String> = emptyList(),
) {
    val isReviewed: Boolean get() = reviewStatus == "reviewed" && !reviewedBy.isNullOrBlank()
}

@Serializable
data class CommonQuestionsFile(val schemaVersion: Int, val packId: String, val questions: List<CommonQuestion>)

/** Full-text candidates for retrieval. Implemented by Room FTS (app) and in memory (tests). */
interface ChunkStore {
    val totalChunks: Int
    val averageLength: Double
    fun documentFrequency(term: String): Int
    /** Every chunk containing at least one of [terms], as (id, seq, tokens). */
    fun candidates(terms: Collection<String>): List<CandidateChunk>
}

data class CandidateChunk(val id: String, val seq: Long, val tokens: List<String>)

class InMemoryChunkStore(chunks: List<Pair<SourceChunk, List<String>>>) : ChunkStore {
    private val items = chunks.map { (c, t) -> CandidateChunk(c.id, c.seq, t) }
    private val df = HashMap<String, Int>().apply { items.forEach { c -> c.tokens.toSet().forEach { merge(it, 1, Int::plus) } } }
    override val totalChunks = items.size
    override val averageLength = if (items.isEmpty()) 0.0 else items.sumOf { it.tokens.size }.toDouble() / items.size
    override fun documentFrequency(term: String) = df[term] ?: 0
    override fun candidates(terms: Collection<String>): List<CandidateChunk> {
        val set = terms.toSet()
        return items.filter { c -> c.tokens.any { it in set } }
    }
}

data class ScoredPassage(val chunkId: String, val score: Double, val coverage: Double)

enum class AnswerKind { COMMON, PASSAGES, INSUFFICIENT }

data class RetrievalResult(
    val kind: AnswerKind,
    val commonQuestion: CommonQuestion?,
    val passages: List<ScoredPassage>,
    val contentTerms: List<String>,
)

/**
 * Cited retrieval with evidence gates. Parameters and behaviour are fixed by
 * shared/fixtures/retrieval.json; the retriever never produces prose itself.
 */
class Retriever(
    private val store: ChunkStore,
    commonQuestions: List<CommonQuestion>,
    stopwords: Map<String, List<String>>,
) {
    private class PreparedQuestion(val q: CommonQuestion, val triggers: List<List<String>>, val questions: List<Set<String>>, val expansion: List<String>)

    private val prepared = commonQuestions.map { q ->
        PreparedQuestion(
            q,
            q.triggers.values.flatten().map { TextNormalizer.tokens(it) }.filter { it.isNotEmpty() },
            q.question.values.map { TextNormalizer.tokens(it).toSet() },
            q.expansion.flatMap { TextNormalizer.tokens(it) },
        )
    }
    private val stop: Set<String> = stopwords.filterKeys { !it.startsWith("_") }.values.flatten()
        .flatMap { TextNormalizer.tokens(it) }.toSet()

    fun retrieve(question: String, context: List<String> = emptyList()): RetrievalResult {
        val tokens = TextNormalizer.tokens(question)
        val content = tokens.distinct().filter { it !in stop }
        val faq = matchQuestion(tokens)
        val weights = LinkedHashMap<String, Double>()
        content.forEach { weights[it] = 1.0 }
        faq?.expansion?.forEach { weights.putIfAbsent(it, EXPANSION_WEIGHT) }
        if (content.size < 4) {
            context.forEach { prev -> TextNormalizer.tokens(prev).filter { it !in stop }.forEach { weights.putIfAbsent(it, CONTEXT_WEIGHT) } }
        }
        val passages = if (weights.isEmpty()) emptyList() else score(weights, content)
        val kind = when {
            faq != null -> AnswerKind.COMMON
            passages.isNotEmpty() -> AnswerKind.PASSAGES
            else -> AnswerKind.INSUFFICIENT
        }
        return RetrievalResult(kind, faq?.q, passages, content)
    }

    private fun score(weights: Map<String, Double>, content: List<String>): List<ScoredPassage> {
        val n = store.totalChunks
        if (n == 0) return emptyList()
        val avgdl = store.averageLength
        val idf = weights.keys.associateWith { t ->
            val df = store.documentFrequency(t)
            ln(1 + (n - df + 0.5) / (df + 0.5))
        }
        data class S(val id: String, val seq: Long, val score: Double, val coverage: Double, val matched: Int)
        val scored = store.candidates(weights.keys).mapNotNull { c ->
            val tf = HashMap<String, Int>()
            for (t in c.tokens) if (t in weights) tf.merge(t, 1, Int::plus)
            if (tf.isEmpty()) return@mapNotNull null
            val dl = c.tokens.size
            var s = 0.0
            for ((t, f) in tf) s += weights.getValue(t) * idf.getValue(t) * f * (K1 + 1) / (f + K1 * (1 - B + B * dl / avgdl))
            val matched = content.count { it in tf }
            val coverage = if (content.isEmpty()) 0.0 else matched.toDouble() / content.size
            // Coordination factor: passages containing more of the question's own words rank higher.
            if (content.isNotEmpty()) s *= COORD_BASE + (1 - COORD_BASE) * coverage
            S(c.id, c.seq, s, coverage, matched)
        }.sortedWith(compareByDescending<S> { it.score }.thenBy { it.seq })
        return scored.filter { it.score >= MIN_SCORE && (it.coverage >= MIN_COVERAGE || it.matched >= 2) }
            .take(MAX_PASSAGES)
            .map { ScoredPassage(it.id, it.score, it.coverage) }
    }

    private fun matchQuestion(tokens: List<String>): PreparedQuestion? {
        val qset = tokens.toSet()
        var best: PreparedQuestion? = null
        var bestHits = 0
        var bestJac = 0.0
        for (p in prepared) {
            val hits = p.triggers.count { containsPhrase(tokens, it) }
            val jac = p.questions.maxOfOrNull { s ->
                val union = (qset + s).size
                if (union == 0) 0.0 else (qset intersect s).size.toDouble() / union
            } ?: 0.0
            if (hits == 0 && jac < 0.6) continue
            if (hits > bestHits || (hits == bestHits && jac > bestJac)) {
                best = p; bestHits = hits; bestJac = jac
            }
        }
        return best
    }

    private fun containsPhrase(tokens: List<String>, phrase: List<String>): Boolean {
        if (phrase.size == 1) {
            val p = phrase[0]
            if (TextNormalizer.containsArabicLetter(p) && p.length >= 4) return tokens.any { it.contains(p) }
            return p in tokens
        }
        if (tokens.size < phrase.size) return false
        for (i in 0..tokens.size - phrase.size) if (tokens.subList(i, i + phrase.size) == phrase) return true
        return false
    }

    companion object {
        const val K1 = 1.2
        const val B = 0.75
        const val EXPANSION_WEIGHT = 0.5
        const val CONTEXT_WEIGHT = 0.3
        const val MAX_PASSAGES = 5
        const val MIN_SCORE = 3.0
        const val MIN_COVERAGE = 0.5
        const val COORD_BASE = 0.0
    }
}

/** A composed answer: only references to stored passages, plus an optional editorial summary. */
data class Answer(
    val question: String,
    val kind: AnswerKind,
    val commonQuestion: CommonQuestion?,
    /** Primary citations, in order (common question citations, or top passages). */
    val citations: List<String>,
    /** Further passages that matched but are not primary citations. */
    val related: List<String>,
    /** Prose written on-device from the cited passages, when a local model produced a valid answer. */
    val generated: String? = null,
)

object AnswerComposer {
    fun compose(question: String, r: RetrievalResult): Answer = when (r.kind) {
        AnswerKind.COMMON -> {
            val cites = r.commonQuestion!!.citations
            Answer(question, r.kind, r.commonQuestion, cites, r.passages.map { it.chunkId }.filter { it !in cites }.take(3))
        }
        AnswerKind.PASSAGES -> Answer(question, r.kind, null, r.passages.map { it.chunkId }.take(3), r.passages.map { it.chunkId }.drop(3))
        AnswerKind.INSUFFICIENT -> Answer(question, r.kind, null, emptyList(), emptyList())
    }
}
