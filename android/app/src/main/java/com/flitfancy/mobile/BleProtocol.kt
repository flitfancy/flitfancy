package com.flitfancy.mobile

import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import java.util.UUID

/** The board side is specified in BLE_PROTOCOL.md; upload credentials never use this link. */
object BleProtocol {
    val SERVICE: UUID = UUID.fromString("9f8d0001-7b6a-4b61-8d0f-0ac49f8a0001")
    val INFO: UUID = UUID.fromString("9f8d0002-7b6a-4b61-8d0f-0ac49f8a0001")
    val DATA: UUID = UUID.fromString("9f8d0003-7b6a-4b61-8d0f-0ac49f8a0001")
    val CONTROL: UUID = UUID.fromString("9f8d0004-7b6a-4b61-8d0f-0ac49f8a0001")
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val MAX_ROWS = 256
    const val MAX_RECORD_BYTES = 4096
    data class Info(val boardId: String)
    data class Snapshot(val boardId: String, val bootId: String, val uptime: Long, val receivedAt: Long, val rows: List<String>)

    private fun number(json: JSONObject, key: String, max: Long): Long {
        val value = json.opt(key) as? Number ?: error("Invalid $key")
        val numeric = value.toDouble()
        require(numeric.isFinite() && numeric >= 0 && numeric <= max && numeric == value.toLong().toDouble())
        return value.toLong()
    }
    private fun identifier(json: JSONObject, key: String): String {
        val value = json.opt(key) as? String ?: error("Missing $key")
        require(value.matches(Regex("[A-Za-z0-9_.-]{1,64}")))
        return value
    }
    private fun json(bytes: ByteArray, limit: Int): JSONObject {
        require(bytes.size in 1..limit)
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        val tokener = JSONTokener(decoder.decode(ByteBuffer.wrap(bytes)).toString())
        val value = tokener.nextValue() as? JSONObject ?: error("Expected object")
        require(tokener.nextClean() == '\u0000')
        return value
    }
    fun info(bytes: ByteArray): Info {
        val value = json(bytes, 512)
        require(value.opt("model") == "FIREFLY-SENSE N16R8" && number(value, "ble_protocol", 1) == 1L)
        return Info(identifier(value, "board_id"))
    }
    fun request(id: Long): ByteArray {
        require(id in 1..0xffffffffL)
        return ByteBuffer.allocate(5).order(ByteOrder.LITTLE_ENDIAN).put(1).putInt(id.toInt()).array()
    }

    /** Notifications may split a UTF-8 record anywhere, including inside a code point. */
    class SnapshotReader(private val info: Info, private val requestId: Long) {
        private val pending = ByteArrayOutputStream()
        private val rows = mutableListOf<String>()
        private var count: Int? = null
        private var uptime = 0L
        private var bootId = ""
        private var receivedAt = 0L
        private var finished = false
        fun accept(bytes: ByteArray, now: Long): Snapshot? {
            var completed: Snapshot? = null
            for (byte in bytes) {
                if (byte != 10.toByte()) {
                    require(pending.size() < MAX_RECORD_BYTES) { "BLE record too large" }
                    pending.write(byte.toInt())
                    continue
                }
                val record = pending.toByteArray(); pending.reset()
                if (record.isEmpty()) continue
                val value = json(record, MAX_RECORD_BYTES)
                require(number(value, "v", 1) == 1L)
                if (number(value, "request_id", 0xffffffffL) != requestId) continue
                require(!finished) { "Data after snapshot end" }
                when (value.opt("type")) {
                    "begin" -> {
                        require(count == null)
                        count = number(value, "rows", MAX_ROWS.toLong()).toInt()
                        uptime = number(value, "uptime_ms", 0xffffffffL)
                        bootId = identifier(value, "boot_id")
                        receivedAt = now
                    }
                    "row" -> {
                        require(count != null && rows.size < count!!)
                        val line = value.opt("csv") as? String ?: error("Missing CSV")
                        require(line.length in 1..2048 && !line.contains('\n') && !line.contains('\r'))
                        rows.add(line)
                    }
                    "end" -> {
                        require(count != null && number(value, "rows", MAX_ROWS.toLong()).toInt() == count && rows.size == count)
                        finished = true
                        completed = Snapshot(info.boardId, bootId, uptime, receivedAt, rows.toList())
                    }
                    else -> error("Unexpected BLE record")
                }
            }
            require(completed == null || pending.size() == 0) { "Partial data after snapshot end" }
            return completed
        }
    }
}
