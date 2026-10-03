package sa.zood.nearmosque.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File

/** Locates the repository's nearest-mosque/ directory holding shared/ and packs/. */
object Fixtures {
    val root: File by lazy {
        System.getProperty("nm.root")?.let(::File)
            ?: generateSequence(File("").absoluteFile) { it.parentFile }.first { File(it, "shared/fixtures").isDirectory }
    }

    val json = Json { ignoreUnknownKeys = true }

    fun file(path: String) = File(root, path)

    fun read(path: String): JsonElement = json.parseToJsonElement(file(path).readText())

    fun quranChunks(): List<SourceChunk> =
        file("packs/sources/quran-tanzil-pickthall/chunks.jsonl").readLines().filter { it.isNotBlank() }
            .map { PackJson.decodeFromString(SourceChunk.serializer(), it) }

    fun retriever(): Retriever {
        val chunks = quranChunks().map { it to TextNormalizer.tokens(it.original.text + " " + it.translations.joinToString(" ") { t -> t.text }) }
        val questions = PackJson.decodeFromString(
            CommonQuestionsFile.serializer(),
            file("packs/sources/quran-tanzil-pickthall/common-questions.json").readText(),
        ).questions
        val stop = PackJson.decodeFromString<Map<String, kotlinx.serialization.json.JsonElement>>(file("shared/content/stopwords.json").readText())
            .filterKeys { !it.startsWith("_") }
            .mapValues { (_, v) -> (v as kotlinx.serialization.json.JsonArray).map { (it as kotlinx.serialization.json.JsonPrimitive).content } }
        return Retriever(InMemoryChunkStore(chunks), questions, stop)
    }
}
