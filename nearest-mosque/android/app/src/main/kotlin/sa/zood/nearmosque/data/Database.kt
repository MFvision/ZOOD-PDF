package sa.zood.nearmosque.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RawQuery
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.sqlite.db.SupportSQLiteQuery
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "installed_pack")
data class InstalledPackEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val version: Int,
    val schemaVersion: Int,
    val manifestJson: String,
    val recordCount: Int,
    val bytes: Long,
    val installedAt: Long,
    val builtin: Boolean,
    /** Average token length of this pack's chunks (BM25), 0 for non-book packs. */
    val avgTokens: Double = 0.0,
)

@Entity(tableName = "mosque", indices = [Index("packId"), Index("lat", "lng")])
data class MosqueEntity(
    @PrimaryKey val sourceId: String,
    val packId: String,
    val category: String,
    val namesJson: String,
    val defaultName: String?,
    val lat: Double,
    val lng: Double,
    val address: String?,
    val phone: String?,
    val website: String?,
    val openingHoursRaw: String?,
    val sourceTimestamp: String?,
)

/** Favorites reference source ids only, so they survive pack updates and removal. */
@Entity(tableName = "favorite")
data class FavoriteEntity(@PrimaryKey val sourceId: String, val addedAt: Long)

@Entity(tableName = "source_document", indices = [Index("packId")])
data class SourceDocumentEntity(@PrimaryKey val id: String, val packId: String, val json: String)

@Entity(tableName = "source_chunk", indices = [Index("packId"), Index("seq")])
data class SourceChunkEntity(
    @PrimaryKey val id: String,
    val packId: String,
    val seq: Long,
    val anchor: String,
    /** The chunk exactly as shipped (original text verbatim). */
    val json: String,
    /** Normalized tokens, space separated; never displayed. */
    val searchText: String,
    val tokenCount: Int,
)

@Fts4(contentEntity = SourceChunkEntity::class)
@Entity(tableName = "source_chunk_fts")
data class SourceChunkFts(val searchText: String)

@Entity(tableName = "common_question", indices = [Index("packId")])
data class CommonQuestionEntity(@PrimaryKey val id: String, val packId: String, val position: Int, val json: String)

@Dao
interface PackDao {
    @Query("SELECT * FROM installed_pack ORDER BY kind, id")
    fun observeAll(): Flow<List<InstalledPackEntity>>

    @Query("SELECT * FROM installed_pack")
    suspend fun all(): List<InstalledPackEntity>

    @Query("SELECT * FROM installed_pack WHERE id = :id")
    suspend fun get(id: String): InstalledPackEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(p: InstalledPackEntity)

    @Query("DELETE FROM installed_pack WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface MosqueDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(items: List<MosqueEntity>)

    @Query("DELETE FROM mosque WHERE packId = :packId")
    suspend fun deleteForPack(packId: String)

    @Query("SELECT * FROM mosque WHERE lat BETWEEN :minLat AND :maxLat AND lng BETWEEN :minLng AND :maxLng")
    suspend fun inBox(minLat: Double, maxLat: Double, minLng: Double, maxLng: Double): List<MosqueEntity>

    @Query("SELECT * FROM mosque WHERE sourceId IN (:ids)")
    suspend fun byIds(ids: List<String>): List<MosqueEntity>

    @Query("SELECT * FROM favorite")
    fun observeFavorites(): Flow<List<FavoriteEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun addFavorite(f: FavoriteEntity)

    @Query("DELETE FROM favorite WHERE sourceId = :id")
    suspend fun removeFavorite(id: String)
}

@Dao
interface SourceDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertChunks(items: List<SourceChunkEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertDocuments(items: List<SourceDocumentEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertQuestions(items: List<CommonQuestionEntity>)

    @Query("DELETE FROM source_chunk WHERE packId = :packId")
    suspend fun deleteChunks(packId: String)

    @Query("DELETE FROM source_document WHERE packId = :packId")
    suspend fun deleteDocuments(packId: String)

    @Query("DELETE FROM common_question WHERE packId = :packId")
    suspend fun deleteQuestions(packId: String)

    @Query("SELECT COUNT(*) FROM source_chunk")
    fun countChunks(): Int

    @Query("SELECT COALESCE(AVG(tokenCount), 0) FROM source_chunk")
    fun averageTokens(): Double

    @Query("SELECT COUNT(*) FROM source_chunk_fts WHERE source_chunk_fts MATCH :query")
    fun ftsCount(query: String): Int

    @RawQuery
    fun candidates(query: SupportSQLiteQuery): List<CandidateRow>

    @Query("SELECT * FROM source_chunk WHERE id IN (:ids)")
    suspend fun chunks(ids: List<String>): List<SourceChunkEntity>

    @Query("SELECT * FROM source_chunk WHERE packId = :packId AND seq BETWEEN :from AND :to ORDER BY seq")
    suspend fun range(packId: String, from: Long, to: Long): List<SourceChunkEntity>

    @Query("SELECT * FROM source_document")
    suspend fun documents(): List<SourceDocumentEntity>

    @Query("SELECT * FROM common_question ORDER BY packId, position")
    suspend fun questions(): List<CommonQuestionEntity>
}

data class CandidateRow(val id: String, val seq: Long, val searchText: String)

fun candidatesQuery(terms: Collection<String>): SupportSQLiteQuery {
    // Tokens are normalized letters/digits only; quoting keeps FTS operators from being interpreted.
    val match = terms.joinToString(" OR ") { "\"" + it.replace("\"", "") + "\"" }
    return SimpleSQLiteQuery(
        "SELECT c.id AS id, c.seq AS seq, c.searchText AS searchText FROM source_chunk c " +
            "JOIN source_chunk_fts f ON f.rowid = c.rowid WHERE source_chunk_fts MATCH ?",
        arrayOf(match),
    )
}

@Database(
    entities = [
        InstalledPackEntity::class, MosqueEntity::class, FavoriteEntity::class,
        SourceDocumentEntity::class, SourceChunkEntity::class, SourceChunkFts::class, CommonQuestionEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun packs(): PackDao
    abstract fun mosques(): MosqueDao
    abstract fun sources(): SourceDao

    companion object {
        fun create(context: Context, inMemory: Boolean = false): AppDatabase {
            val builder = if (inMemory) {
                // In-memory databases are only used by tests, which query from the test thread.
                Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).allowMainThreadQueries()
            } else {
                Room.databaseBuilder(context, AppDatabase::class.java, "near-mosque.db")
            }
            // Schema v1. Future versions add explicit Migration objects; packs are re-installable, but
            // favorites must be migrated, so destructive fallback is deliberately NOT enabled.
            return builder.build()
        }
    }
}
