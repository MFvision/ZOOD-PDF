package sa.zood.nearmosque.core

import kotlinx.serialization.Serializable
import java.io.InputStream
import java.security.MessageDigest

@Serializable
data class PackFile(val path: String, val bytes: Long, val sha256: String)

@Serializable
data class PackLicense(val id: String, val name: String, val url: String, val attribution: String, val attributionUrl: String? = null)

@Serializable
data class PackSource(val name: String, val url: String, val snapshot: String? = null, val builtAt: String? = null)

@Serializable
data class PackBBox(val minLat: Double, val minLng: Double, val maxLat: Double, val maxLng: Double)

@Serializable
data class PackCoverage(val name: String, val bbox: PackBBox)

@Serializable
data class PackManifest(
    val id: String,
    val kind: String,
    val schemaVersion: Int,
    val version: Int,
    val title: Map<String, String>,
    val coverage: PackCoverage? = null,
    val languages: List<String> = emptyList(),
    val recordCount: Int = 0,
    val source: PackSource,
    val license: PackLicense,
    val files: List<PackFile>,
) {
    fun title(lang: String): String = title[lang] ?: title["en"] ?: id
}

sealed class PackError(message: String) : Exception(message) {
    class Format(message: String) : PackError(message)
    class Checksum(val path: String) : PackError("checksum mismatch: $path")
    class NewerSchema(val schema: Int) : PackError("schema $schema not supported")
}

object PackVerifier {
    const val SUPPORTED_SCHEMA = 1
    val KINDS = setOf("mosques", "sources", "cities")

    fun parseManifest(json: String): PackManifest {
        val m = try {
            PackJson.decodeFromString(PackManifest.serializer(), json)
        } catch (e: Exception) {
            throw PackError.Format("manifest: ${e.message}")
        }
        if (m.kind !in KINDS) throw PackError.Format("unknown kind ${m.kind}")
        if (m.schemaVersion > SUPPORTED_SCHEMA) throw PackError.NewerSchema(m.schemaVersion)
        if (m.files.any { it.path.contains("..") || it.path.startsWith("/") }) throw PackError.Format("unsafe path")
        return m
    }

    /** Hash every listed file; throws before anything is installed if one differs. */
    fun verify(manifest: PackManifest, open: (String) -> InputStream?) {
        for (f in manifest.files) {
            val stream = open(f.path) ?: throw PackError.Format("missing ${f.path}")
            val digest = stream.use { sha256(it) }
            if (!digest.equals(f.sha256, ignoreCase = true)) throw PackError.Checksum(f.path)
        }
    }

    fun sha256(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
