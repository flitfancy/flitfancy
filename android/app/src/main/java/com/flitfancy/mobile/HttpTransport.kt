package com.flitfancy.mobile

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayOutputStream

class HttpFailure(val status: Int, message: String) : Exception(message)

object HttpTransport {
    fun json(url: String, body: JSONObject? = null, token: String = ""): String {
        if (token.isNotEmpty()) require(url.startsWith(BuildConfig.UPLOAD_BASE + "/api/collectors/"))
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 6000; connection.readTimeout = 10000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        if (token.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer $token")
        try {
            if (body != null) {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                val bytes = body.toString().toByteArray()
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use {
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = it.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= 512 * 1024) { "设备响应过大" }
                    output.write(buffer, 0, count)
                }
                String(output.toByteArray(), Charsets.UTF_8)
            } ?: ""
            if (status !in 200..299) {
                val message = runCatching { JSONObject(text).optString("error") }.getOrDefault("").take(160)
                throw HttpFailure(status, message.ifEmpty { "连接失败（$status）" })
            }
            return text
        } finally { connection.disconnect() }
    }
}
