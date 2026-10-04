package com.flitfancy.mobile

import android.content.Context
import androidx.room.*

@Entity(tableName = "pending")
data class PendingSample(@PrimaryKey val eventId: String, val deviceId: String, val payload: String, val capturedAt: Long)
@Entity(tableName = "seen")
data class SeenSample(@PrimaryKey val eventId: String, val seenAt: Long)

@Dao
abstract class QueueDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE) abstract fun markSeen(row: SeenSample): Long
    @Insert(onConflict = OnConflictStrategy.ABORT) abstract fun insert(row: PendingSample)
    @Query("SELECT * FROM pending WHERE deviceId=:deviceId ORDER BY capturedAt,eventId LIMIT :limit")
    abstract fun batch(deviceId: String, limit: Int = 100): List<PendingSample>
    @Query("SELECT COUNT(*) FROM pending") abstract fun count(): Int
    @Query("DELETE FROM pending WHERE eventId IN (:ids) AND deviceId=:deviceId") abstract fun acknowledge(deviceId: String, ids: List<String>)
    @Query("DELETE FROM seen WHERE seenAt < :before AND eventId NOT IN (SELECT eventId FROM pending)") abstract fun pruneSeen(before: Long)
    @Transaction open fun enqueue(row: PendingSample, now: Long): Boolean {
        if (markSeen(SeenSample(row.eventId, now)) == -1L) return false
        insert(row)
        return true
    }
}

@Database(entities = [PendingSample::class, SeenSample::class], version = 1, exportSchema = false)
abstract class QueueStore : RoomDatabase() {
    abstract fun queue(): QueueDao
    companion object {
        @Volatile private var instance: QueueStore? = null
        fun get(context: Context): QueueStore = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, QueueStore::class.java, "collector-queue.db").build().also { instance = it }
        }
    }
}
