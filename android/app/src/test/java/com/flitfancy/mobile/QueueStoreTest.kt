package com.flitfancy.mobile

import androidx.room.Room
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class QueueStoreTest {
    @Test fun `acknowledgement preserves other devices and uploaded frames are not requeued`() {
        val context = RuntimeEnvironment.getApplication()
        val store = Room.inMemoryDatabaseBuilder(context, QueueStore::class.java).allowMainThreadQueries().build()
        try {
            val dao = store.queue()
            assertTrue(dao.enqueue(PendingSample("id-a", "device-a", "{}", 1000), 1000))
            assertTrue(dao.enqueue(PendingSample("id-b", "device-b", "{}", 2000), 2000))
            assertFalse(dao.enqueue(PendingSample("id-a", "device-a", "changed", 3000), 3000))
            assertEquals(1, dao.batch("device-a").size)
            dao.acknowledge("device-b", listOf("id-a"))
            assertEquals(2, dao.count())
            dao.acknowledge("device-a", listOf("id-a"))
            assertEquals(1, dao.count())
            assertFalse(dao.enqueue(PendingSample("id-a", "device-a", "{}", 1000), 4000))
            dao.pruneSeen(5000)
            assertFalse("Queued events keep dedup state", dao.enqueue(PendingSample("id-b", "device-b", "{}", 2000), 6000))
        } finally { store.close() }
    }
}
