package com.flitfancy.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AppSettings(context: Context) {
    private val preferences = context.getSharedPreferences("collector", Context.MODE_PRIVATE)
    var enabled: Boolean
        get() = preferences.getBoolean("enabled", false)
        set(value) { preferences.edit().putBoolean("enabled", value).commit() }
    var board: String
        get() = preferences.getString("board", "http://192.168.1.33")!!
        set(value) {
            check(!enabled)
            val normalized = SampleCodec.boardBase(value)
            val change = preferences.edit().putString("board", normalized)
            if (normalized != board) change.putLong("last_board_read_wifi", 0).remove("board_boot_id").remove("board_boot_epoch")
                .putString("status", "已保存 Wi-Fi 地址，采集尚未开始；缓存保留")
            change.commit()
        }
    var transport: String
        get() = preferences.getString("transport", "wifi")!!
        set(value) {
            check(!enabled); require(value in setOf("wifi", "ble"))
            val change = preferences.edit().putString("transport", value)
            if (value != transport) change.putString("status", "已选择${if (value == "ble") "蓝牙" else "Wi-Fi"}，采集尚未开始；缓存保留")
            change.commit()
        }
    val bleAddress: String get() = preferences.getString("ble_address", "")!!
    val bleName: String get() = preferences.getString("ble_name", "尚未选择蓝牙感知板")!!
    fun selectBle(candidate: BleCandidate) {
        check(!enabled)
        require(candidate.address.matches(Regex("[0-9A-F]{2}(:[0-9A-F]{2}){5}")))
        val change = preferences.edit().putString("ble_address", candidate.address).putString("ble_name", candidate.name.take(40))
        if (candidate.address != bleAddress) change.putLong("last_board_read_ble", 0).putString("status", "已选择蓝牙感知板，采集尚未开始；缓存保留")
        change.commit()
    }
    val deviceId: String get() = preferences.getString("device_id", "")!!
    val name: String get() = preferences.getString("name", "尚未配对")!!
    var status: String
        get() = preferences.getString("status", "采集已暂停")!!
        set(value) { preferences.edit().putString("status", value).apply() }
    var lastUpload: Long
        get() = preferences.getLong("last_upload", 0)
        set(value) { preferences.edit().putLong("last_upload", value).apply() }
    var lastBoardRead: Long
        get() = preferences.getLong("last_board_read_$transport", 0)
        set(value) { preferences.edit().putLong("last_board_read_$transport", value).apply() }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("flit-collector-token", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("flit-collector-token", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    fun token(): String {
        val stored = preferences.getString("encrypted_token", null) ?: return ""
        return runCatching {
        val pieces = stored.split('.')
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(pieces[0], Base64.NO_WRAP)))
        String(cipher.doFinal(Base64.decode(pieces[1], Base64.NO_WRAP)))
        }.getOrDefault("")
    }

    fun pair(response: JSONObject) {
        require(response.optInt("protocol") == 1)
        val uid = response.getString("device_id")
        val token = response.getString("collector_token")
        require(uid.matches(Regex("[a-f0-9]{32}")) && token.startsWith("$uid."))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." + Base64.encodeToString(cipher.doFinal(token.toByteArray()), Base64.NO_WRAP)
        preferences.edit().putString("device_id", uid).putString("name", response.getString("name"))
            .putString("encrypted_token", encrypted).commit()
    }

    @Synchronized fun bootId(uptime: Long, now: Long): String {
        val previousEpoch = preferences.getLong("board_boot_epoch", 0)
        var id = preferences.getString("board_boot_id", "")!!
        if (id.isEmpty() || kotlin.math.abs((now - uptime) - previousEpoch) > 30000) {
            id = UUID.randomUUID().toString()
            preferences.edit().putString("board_boot_id", id).putLong("board_boot_epoch", now - uptime).commit()
        }
        return id
    }
}
