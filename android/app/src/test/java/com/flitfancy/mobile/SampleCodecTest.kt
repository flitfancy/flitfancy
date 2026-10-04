package com.flitfancy.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SampleCodecTest {
    private fun line(bpm: String = "76", state: String = "streaming"): String {
        val cells = MutableList(40) { "NA" }
        cells[0] = "1000"; cells[1] = "1"; cells[2] = "6"; cells[3] = "CH6 BLE-HR"; cells[4] = "1"
        cells[28] = "250"; cells[29] = "3"; cells[30] = "0"; cells[31] = "1.3.5"; cells[32] = "5"
        cells[33] = "independent-v1"; cells[35] = "-58"; cells[36] = bpm; cells[37] = "1"; cells[39] = state
        return "CSV," + cells.joinToString(",")
    }
    @Test fun `schema five preserves heart rate and real sampling time`() {
        val result = SampleCodec.parse(line(), 6000, 1700000000000, "boot-A", "FIREFLY-SENSE")!!
        val row = JSONObject(result.payload)
        assertEquals("CH6", row.getString("channel"))
        assertEquals(76, row.getInt("heart_rate_bpm"))
        assertTrue(row.isNull("hr_contact"))
        assertEquals(1699999995000, result.emittedAt)
        assertEquals(result.eventId, SampleCodec.parse(line(), 8000, 1700000002000, "boot-A", "FIREFLY-SENSE")!!.eventId)
        assertNotEquals(result.eventId, SampleCodec.parse(line(), 6000, 1700000000000, "boot-B", "FIREFLY-SENSE")!!.eventId)
    }
    @Test fun `missing values and corrupt frames remain missing`() {
        assertTrue(JSONObject(SampleCodec.parse(line("NA", "scanning"), 1000, 1700000000000, "boot", "board")!!.payload).isNull("heart_rate_bpm"))
        assertNull(SampleCodec.parse(line("NaN"), 1000, 1700000000000, "boot", "board"))
        assertNull(SampleCodec.parse("uptime_ms,cycle,channel", 1000, 1700000000000, "boot", "board"))
        assertNull(SampleCodec.parse(line(), 90000000, 1700000000000, "boot", "board"))
    }
    @Test fun `board endpoints remain LAN literal addresses and web origins exact`() {
        assertEquals("http://192.168.1.33", SampleCodec.boardBase("192.168.1.33"))
        assertEquals("http://10.0.2.2:8080", SampleCodec.boardBase("http://10.0.2.2:8080"))
        for (bad in listOf("http://example.com", "http://127.0.0.1", "http://192.168.1.33@evil.com", "https://192.168.1.33", "http://10.0.0.1/path")) {
            assertTrue(runCatching { SampleCodec.boardBase(bad) }.isFailure)
        }
        assertTrue(SampleCodec.trustedWebsite("https://flitfancy.com/presence.html"))
        assertFalse(SampleCodec.trustedWebsite("https://flitfancy.com.evil.com/"))
        assertFalse(SampleCodec.trustedWebsite("https://flitfancy.com@evil.com/"))
        assertFalse(SampleCodec.trustedWebsite("javascript:alert(1)"))
    }
}
