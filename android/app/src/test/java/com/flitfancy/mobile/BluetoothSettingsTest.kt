package com.flitfancy.mobile

import android.Manifest
import android.content.Context
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BluetoothSettingsTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    @Before fun reset() { context.getSharedPreferences("collector", Context.MODE_PRIVATE).edit().clear().commit() }
    @Test fun `upgrading a paired wifi installation keeps identity cache settings and selected endpoint`() {
        val prefs = context.getSharedPreferences("collector", Context.MODE_PRIVATE)
        prefs.edit().putString("device_id", "previous-device").putString("encrypted_token", "existing-encrypted-value")
            .putString("board", "http://10.0.0.8").putString("board_boot_id", "old-boot").putLong("board_boot_epoch", 1000).commit()
        val settings = AppSettings(context)
        assertEquals("wifi", settings.transport)
        assertEquals("previous-device", settings.deviceId)
        assertEquals("http://10.0.0.8", settings.board)
        settings.selectBle(BleCandidate("AA:BB:CC:DD:EE:FF", "My board"))
        settings.transport = "ble"
        val restarted = AppSettings(context)
        assertEquals("ble", restarted.transport)
        assertEquals("AA:BB:CC:DD:EE:FF", restarted.bleAddress)
        assertEquals("My board", restarted.bleName)
        assertEquals("http://10.0.0.8", restarted.board)
        assertEquals("existing-encrypted-value", prefs.getString("encrypted_token", null))
        assertEquals("old-boot", prefs.getString("board_boot_id", null))
    }
    @Test fun `an active collector cannot switch transport or replace its board`() {
        val settings = AppSettings(context)
        settings.enabled = true
        assertTrue(runCatching { settings.transport = "ble" }.isFailure)
        assertTrue(runCatching { settings.selectBle(BleCandidate("AA:BB:CC:DD:EE:FF", "other")) }.isFailure)
        assertEquals("wifi", settings.transport)
        assertEquals("", settings.bleAddress)
    }
    @Test fun `modern BLE never requests location and reconnect does not request scanning`() {
        assertArrayEquals(arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT), BluetoothAccess.permissions(true, 36))
        assertArrayEquals(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), BluetoothAccess.permissions(false, 31))
        assertArrayEquals(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), BluetoothAccess.permissions(true, 30))
        assertTrue(BluetoothAccess.permissions(false, 30).isEmpty())
    }
    @Test fun `switching transport does not pretend the previous link already received data`() {
        val settings = AppSettings(context)
        settings.lastBoardRead = 1000
        settings.lastUpload = 900
        settings.selectBle(BleCandidate("AA:BB:CC:DD:EE:FF", "first"))
        settings.transport = "ble"
        assertEquals(0, settings.lastBoardRead)
        assertTrue(settings.status.contains("尚未开始"))
        settings.lastBoardRead = 2000
        settings.transport = "wifi"
        assertEquals(1000, settings.lastBoardRead)
        settings.transport = "ble"
        settings.selectBle(BleCandidate("11:22:33:44:55:66", "second"))
        assertEquals(0, settings.lastBoardRead)
        assertEquals(900, settings.lastUpload)
    }
}
