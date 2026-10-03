package sa.zood.nearmosque.data

import android.content.Context
import android.net.Uri
import androidx.room.withTransaction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import sa.zood.nearmosque.core.CommonQuestionsFile
import sa.zood.nearmosque.core.MosqueRecord
import sa.zood.nearmosque.core.PackError
import sa.zood.nearmosque.core.PackJson
import sa.zood.nearmosque.core.PackManifest
import sa.zood.nearmosque.core.PackVerifier
import sa.zood.nearmosque.core.SourceChunk
import sa.zood.nearmosque.core.SourceDocument
import sa.zood.nearmosque.core.TextNormalizer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import java.io.File
import java.io.InputStream
import java.util.zip.ZipInputStream

/**
 * Installs data packs atomically: every file is hash-verified first, then the pack's rows are
 * replaced inside one SQLite transaction. A failure at any point leaves the previous version intact.
 */
class PackManager(
    private val context: Context,
    private val db: AppDatabase,
    private val assetRoot: String = "",
) {
    private val prefs = context.getSharedPreferences("packs", Context.MODE_PRIVATE)
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    val installed: Flow<List<InstalledPackEntity>> = db.packs().observeAll()

    /** Bundled manifests found in the APK assets (the mosques and sources folders). */
    fun bundledManifests(): List<Pair<String, PackManifest>> =
        listOf("mosques", "sources").flatMap { kind ->
            // Directory names; some asset managers (Robolectric) list nested paths instead.
            context.assets.list(path(kind)).orEmpty().map { it.substringBefore('/') }.distinct().mapNotNull { dir ->
                val p = path("$kind/$dir")
                try {
                    p to PackVerifier.parseManifest(readAsset("$p/manifest.json"))
                } catch (e: Exception) {
                    android.util.Log.w("PackManager", "unreadable bundled manifest $p: ${e.message}")
                    null
                }
            }
        }

    fun citiesManifest(): PackManifest? = runCatching { PackVerifier.parseManifest(readAsset(path("cities/manifest.json"))) }.getOrNull()

    /**
     * First launch and app updates: install bundled packs that are missing or older, unless the user
     * removed them. Returns the ids that failed (the previous version, if any, stays installed).
     */
    suspend fun ensureBuiltins(): List<String> = withContext(Dispatchers.IO) {
        val removed = prefs.getStringSet(KEY_REMOVED, emptySet()).orEmpty()
        val current = db.packs().all().associateBy { it.id }
        val failed = ArrayList<String>()
        for ((dir, manifest) in bundledManifests()) {
            if (manifest.id in removed) continue
            val have = current[manifest.id]
            if (have != null && have.version >= manifest.version) continue
            try {
                install(manifest, builtin = true) { name -> openAsset("$dir/$name") }
            } catch (e: Exception) {
                android.util.Log.w("PackManager", "built-in pack ${manifest.id} failed: ${e.message}")
                failed += manifest.id
            }
        }
        failed
    }

    suspend fun restoreBuiltins() {
        prefs.edit().remove(KEY_REMOVED).apply()
        ensureBuiltins()
    }

    suspend fun remove(id: String) = withContext(Dispatchers.IO) {
        db.withTransaction {
            db.mosques().deleteForPack(id)
            db.sources().deleteChunks(id)
            db.sources().deleteDocuments(id)
            db.sources().deleteQuestions(id)
            db.packs().delete(id)
        }
        if (bundledManifests().any { it.second.id == id }) {
            prefs.edit().putStringSet(KEY_REMOVED, prefs.getStringSet(KEY_REMOVED, emptySet()).orEmpty() + id).apply()
        }
    }

    /** Import a `.nmpack` (zip with manifest.json at its root) chosen by the user. */
    suspend fun importZip(uri: Uri): PackManifest = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "import-${System.nanoTime()}")
        dir.mkdirs()
        try {
            val stream = context.contentResolver.openInputStream(uri) ?: throw PackError.Format("unreadable")
            ZipInputStream(stream.buffered()).use { zip ->
                var total = 0L
                while (true) {
                    val e = zip.nextEntry ?: break
                    if (e.isDirectory) continue
                    val name = e.name.substringAfterLast('/')
                    if (name.isEmpty() || name.startsWith(".") || e.name.contains("..")) continue
                    val out = File(dir, name)
                    out.outputStream().use { o ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = zip.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > MAX_IMPORT_BYTES) throw PackError.Format("too large")
                            o.write(buf, 0, n)
                        }
                    }
                }
            }
            val manifestFile = File(dir, "manifest.json")
            if (!manifestFile.exists()) throw PackError.Format("no manifest")
            val manifest = PackVerifier.parseManifest(manifestFile.readText())
            if (manifest.kind == "cities") throw PackError.Format("cities are built in")
            install(manifest, builtin = false) { name -> File(dir, name).takeIf { it.exists() }?.inputStream() }
            prefs.edit().putStringSet(KEY_REMOVED, prefs.getStringSet(KEY_REMOVED, emptySet()).orEmpty() - manifest.id).apply()
            manifest
        } finally {
            dir.deleteRecursively()
        }
    }

    suspend fun install(manifest: PackManifest, builtin: Boolean, open: (String) -> InputStream?) = withContext(Dispatchers.IO) {
        _busy.value = true
        try {
            PackVerifier.verify(manifest, open)
            val bytes = manifest.files.sumOf { it.bytes }
            val now = System.currentTimeMillis()
            when (manifest.kind) {
                "mosques" -> {
                    val file = manifest.files.firstOrNull { it.path.endsWith(".jsonl") } ?: throw PackError.Format("no data")
                    val rows = readLines(open(file.path)!!).mapNotNull { line ->
                        val r = runCatching { PackJson.decodeFromString(MosqueRecord.serializer(), line) }.getOrNull() ?: return@mapNotNull null
                        val m = r.toMosque(manifest.id) ?: return@mapNotNull null
                        MosqueEntity(
                            m.sourceId, manifest.id, r.category, PackJson.encodeToString(namesSerializer, m.names), m.names["default"],
                            m.location.latitude, m.location.longitude, m.address, m.phone, m.website, m.openingHoursRaw, m.sourceTimestamp,
                        )
                    }
                    db.withTransaction {
                        db.mosques().deleteForPack(manifest.id)
                        rows.chunked(500).forEach { db.mosques().insertAll(it) }
                        db.packs().upsert(entity(manifest, rows.size, bytes, now, builtin, 0.0))
                    }
                }
                "sources" -> {
                    val chunks = readLines(open("chunks.jsonl") ?: throw PackError.Format("no chunks")).map { line ->
                        val c = PackJson.decodeFromString(SourceChunk.serializer(), line)
                        val text = c.searchText()
                        SourceChunkEntity(c.id, manifest.id, c.seq, c.anchor, line, text, if (text.isEmpty()) 0 else text.count { it == ' ' } + 1)
                    }
                    val docs = open("documents.json")?.use { s ->
                        PackJson.decodeFromString(ListSerializer(SourceDocument.serializer()), s.readBytes().decodeToString())
                    }.orEmpty()
                    val questions = open("common-questions.json")?.use { s ->
                        PackJson.decodeFromString(CommonQuestionsFile.serializer(), s.readBytes().decodeToString()).questions
                    }.orEmpty()
                    val ids = chunks.map { it.id }.toSet()
                    val validQuestions = questions.filter { q -> q.citations.all { it in ids } }
                    db.withTransaction {
                        db.sources().deleteChunks(manifest.id)
                        db.sources().deleteDocuments(manifest.id)
                        db.sources().deleteQuestions(manifest.id)
                        chunks.chunked(500).forEach { db.sources().insertChunks(it) }
                        db.sources().insertDocuments(docs.map { SourceDocumentEntity(it.id, manifest.id, PackJson.encodeToString(SourceDocument.serializer(), it)) })
                        db.sources().insertQuestions(validQuestions.mapIndexed { i, q ->
                            CommonQuestionEntity(q.id, manifest.id, i, PackJson.encodeToString(sa.zood.nearmosque.core.CommonQuestion.serializer(), q))
                        })
                        val avg = if (chunks.isEmpty()) 0.0 else chunks.sumOf { it.tokenCount }.toDouble() / chunks.size
                        db.packs().upsert(entity(manifest, chunks.size, bytes, now, builtin, avg))
                    }
                }
                else -> throw PackError.Format("unsupported kind ${manifest.kind}")
            }
        } finally {
            _busy.value = false
        }
    }

    private fun entity(m: PackManifest, count: Int, bytes: Long, now: Long, builtin: Boolean, avg: Double) = InstalledPackEntity(
        m.id, m.kind, m.version, m.schemaVersion, PackJson.encodeToString(PackManifest.serializer(), m), count, bytes, now, builtin, avg,
    )

    private fun readLines(s: InputStream): List<String> = s.bufferedReader().useLines { seq -> seq.filter { it.isNotBlank() }.toList() }

    private fun path(p: String) = if (assetRoot.isEmpty()) p else "$assetRoot/$p"
    fun openAsset(p: String): InputStream? = runCatching { context.assets.open(p) }.getOrNull()
    fun readAsset(p: String): String = context.assets.open(p).use { it.readBytes().decodeToString() }

    companion object {
        private const val KEY_REMOVED = "removed_builtins"
        private const val MAX_IMPORT_BYTES = 512L * 1024 * 1024
        val namesSerializer = MapSerializer(String.serializer(), String.serializer())
    }
}
