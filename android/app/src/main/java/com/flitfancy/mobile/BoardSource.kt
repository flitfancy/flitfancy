package com.flitfancy.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable

data class BoardRead(val rows: List<String>, val uptime: Long, val receivedAt: Long, val bootId: String)
interface BoardSource : Closeable { suspend fun read(): BoardRead }

class HttpBoardSource(private val settings: AppSettings) : BoardSource {
    override suspend fun read(): BoardRead {
        val base = SampleCodec.boardBase(settings.board)
        val rows = JSONArray(HttpTransport.json(base + "/data"))
        val device = JSONObject(HttpTransport.json(base + "/device"))
        require(device.optString("model") == "FIREFLY-SENSE N16R8") { "地址不是已支持的感知板" }
        val uptime = device.optLong("uptime_ms", -1)
        require(uptime in 0..0xffffffffL) { "感知板未提供有效运行时间" }
        val now = System.currentTimeMillis()
        return BoardRead((0 until rows.length()).map { rows.optString(it) }, uptime, now, settings.bootId(uptime, now))
    }
    override fun close() = Unit
}
