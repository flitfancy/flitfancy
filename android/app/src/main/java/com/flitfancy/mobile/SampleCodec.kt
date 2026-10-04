package com.flitfancy.mobile

import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.time.Instant

object SampleCodec {
    val fields = listOf("uptime_ms", "cycle", "channel_index", "sensor", "ok", "temp_c",
        "rh_pct", "als_raw", "uv_raw", "f1_415", "f2_445", "f3_480", "f4_515",
        "f5_555", "f6_590", "f7_630", "f8_680", "clear_raw", "nir_raw", "voc_index",
        "nox_index", "sraw_voc", "sraw_nox", "co2_ppm", "pressure_pa", "as7341_atime",
        "as7341_astep", "as7341_gainx", "sample_age_ms", "sample_seq", "error_streak",
        "firmware_version", "schema_version", "scheduler", "flicker_hz", "rssi_dbm",
        "heart_rate_bpm", "hr_connected", "hr_contact", "hr_state")
    private val textFields = setOf("sensor", "firmware_version", "scheduler", "hr_state")
    data class Frame(val eventId: String, val payload: String, val emittedAt: Long)

    fun boardBase(input: String): String {
        val uri = URI(if (input.contains("://")) input.trim() else "http://${input.trim()}")
        require(uri.scheme == "http" && uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null)
        require(uri.path.isNullOrEmpty() || uri.path == "/")
        val parts = (uri.host ?: "").split('.').map { it.toIntOrNull() ?: -1 }
        require(parts.size == 4 && parts.all { it in 0..255 })
        require(parts[0] == 10 || parts[0] == 192 && parts[1] == 168 || parts[0] == 172 && parts[1] in 16..31)
        require(uri.port == -1 || uri.port in 1..65535)
        return "http://${uri.host}" + if (uri.port != -1) ":${uri.port}" else ""
    }

    fun trustedWebsite(input: String): Boolean = runCatching {
        val uri = URI(input)
        uri.scheme == "https" && uri.userInfo == null && (uri.port == -1 || uri.port == 443) &&
            uri.host in setOf("flitfancy.com", "www.flitfancy.com", "console.flitfancy.com")
    }.getOrDefault(false)

    fun parse(line: String, deviceUptime: Long, receivedAt: Long, bootId: String, board: String): Frame? {
        var parts = line.trim().split(',')
        if (parts.firstOrNull() == "CSV") parts = parts.drop(1)
        if (parts.size !in 24..40 || parts[0].toLongOrNull() == null) return null
        val uptime = parts[0].toLongOrNull() ?: return null
        val channel = parts.getOrNull(2)?.toIntOrNull() ?: return null
        if (uptime !in 0..0xffffffffL || channel !in 0..6) return null
        val age = (deviceUptime - uptime) and 0xffffffffL
        if (age > 24 * 60 * 60 * 1000L) return null
        val emitted = receivedAt - age
        val row = JSONObject().put("ts", Instant.ofEpochMilli(emitted).toString()).put("board", board).put("channel", "CH$channel")
        for (index in parts.indices) {
            val field = fields[index]
            val value = parts[index].trim()
            if (field in textFields) {
                if (value.length > 80) return null
                row.put(field, value)
            } else if (value in setOf("NA", "N/A", "", "null")) {
                row.put(field, JSONObject.NULL)
            } else {
                val number = value.toDoubleOrNull() ?: return null
                if (!number.isFinite()) return null
                row.put(field, number)
            }
        }
        if (row.optInt("ok", -1) !in 0..1 || row.optString("sensor").isEmpty()) return null
        val canonical = parts.joinToString(",")
        val id = sha256("$board\n$bootId\n$canonical")
        return Frame(id, row.toString(), emitted)
    }

    fun sha256(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
}
