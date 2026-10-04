package com.flitfancy.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class BleProtocolTest {
    private val info = BleProtocol.info("""{"model":"FIREFLY-SENSE N16R8","ble_protocol":1,"board_id":"board-A"}""".toByteArray())
    private fun record(type: String, id: Long = 7, vararg values: Pair<String, Any>): String {
        val json = JSONObject().put("v", 1).put("type", type).put("request_id", id)
        values.forEach { json.put(it.first, it.second) }
        return json.toString() + "\n"
    }
    private fun begin(rows: Int = 1) = record("begin", 7, "rows" to rows, "uptime_ms" to 6000, "boot_id" to "boot-A")
    private fun heart(): String {
        val cells = MutableList(40) { "NA" }
        cells[0] = "1000"; cells[1] = "1"; cells[2] = "6"; cells[3] = "CH6 BLE-HR"; cells[4] = "1"
        cells[31] = "1.3.6"; cells[32] = "5"; cells[36] = "76"; cells[37] = "1"
        return "CSV," + cells.joinToString(",")
    }
    @Test fun `notification splits preserve complete snapshots and sampling time`() {
        val bytes = (begin() + record("row", 7, "csv" to heart()) + record("end", 7, "rows" to 1)).toByteArray()
        for (width in listOf(1, 20, 244, 512, bytes.size)) {
            val reader = BleProtocol.SnapshotReader(info, 7)
            var result: BleProtocol.Snapshot? = null
            for (offset in bytes.indices step width) result = reader.accept(bytes.copyOfRange(offset, minOf(offset + width, bytes.size)), 1700000000000) ?: result
            assertNotNull(result)
            val snapshot = result!!
            assertEquals(listOf(heart()), snapshot.rows)
            val frame = SampleCodec.parse(snapshot.rows.single(), snapshot.uptime, snapshot.receivedAt, "${snapshot.boardId}:${snapshot.bootId}", "FIREFLY-SENSE")!!
            assertEquals(1699999995000, frame.emittedAt)
            assertEquals(76, JSONObject(frame.payload).getInt("heart_rate_bpm"))
        }
    }
    @Test fun `partial responses are never returned and old request notifications are ignored`() {
        val reader = BleProtocol.SnapshotReader(info, 7)
        assertNull(reader.accept((record("begin", 6, "rows" to 0, "uptime_ms" to 1, "boot_id" to "old") + begin()).toByteArray(), 1000))
        assertNull(reader.accept(record("row", 7, "csv" to heart()).toByteArray(), 1000))
        assertNotNull(reader.accept(record("end", 7, "rows" to 1).toByteArray(), 1000))
    }
    @Test fun `bad order row counts versions and unbounded data are rejected`() {
        for (value in listOf(record("row", 7, "csv" to heart()), begin() + record("end", 7, "rows" to 1), begin(257), begin() + begin(), """{"v":2,"type":"begin","request_id":7}\n""".replace("\\n", "\n"))) {
            assertTrue(runCatching { BleProtocol.SnapshotReader(info, 7).accept(value.toByteArray(), 1000) }.isFailure)
        }
        assertTrue(runCatching { BleProtocol.SnapshotReader(info, 7).accept(ByteArray(4097) { 65 }, 1000) }.isFailure)
        assertTrue(runCatching { BleProtocol.SnapshotReader(info, 7).accept(byteArrayOf(0xc3.toByte(), 10), 1000) }.isFailure)
        assertTrue(runCatching { BleProtocol.info("""{"model":"other","ble_protocol":1,"board_id":"A"}""".toByteArray()) }.isFailure)
        assertTrue(runCatching { BleProtocol.info("""{"model":"FIREFLY-SENSE N16R8","ble_protocol":1.5,"board_id":"A"}""".toByteArray()) }.isFailure)
    }
    @Test fun `empty snapshots and uint32 request IDs fit the minimum ATT payload`() {
        assertEquals(0, BleProtocol.SnapshotReader(info, 7).accept((begin(0) + record("end", 7, "rows" to 0)).toByteArray(), 1000)!!.rows.size)
        val command = BleProtocol.request(0xffffffffL)
        assertEquals(5, command.size)
        assertEquals(1.toByte(), command[0])
        assertEquals(-1, ByteBuffer.wrap(command, 1, 4).order(ByteOrder.LITTLE_ENDIAN).int)
    }
    @Test fun `UTF8 split inside a code point is preserved until the record is complete`() {
        val csv = heart().replace("BLE-HR", "蓝牙心率")
        val reader = BleProtocol.SnapshotReader(info, 7)
        val bytes = (begin() + record("row", 7, "csv" to csv) + record("end", 7, "rows" to 1)).toByteArray()
        var result: BleProtocol.Snapshot? = null
        bytes.forEach { byte -> result = reader.accept(byteArrayOf(byte), 1000) ?: result }
        assertEquals(csv, result!!.rows.single())
    }
}
