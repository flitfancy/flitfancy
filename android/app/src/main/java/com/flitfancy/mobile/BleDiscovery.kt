package com.flitfancy.mobile

import android.annotation.SuppressLint
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withTimeoutOrNull

data class BleCandidate(val address: String, val name: String)

object BleDiscovery {
    /** User-initiated foreground scan only. Background reconnects use the saved bound address. */
    @SuppressLint("MissingPermission")
    suspend fun scan(context: Context): List<BleCandidate> {
        val adapter = BluetoothAccess.adapter(context, true)
        if (!adapter.isEnabled) throw BleProblem("请先打开手机蓝牙")
        if (!BluetoothAccess.locationReady(context)) throw BleProblem("Android 11 及更早系统需要打开定位开关才能扫描；App 不采集位置")
        val scanner = adapter.bluetoothLeScanner ?: throw BleProblem("蓝牙扫描暂不可用，请重新打开蓝牙")
        val found = linkedMapOf<String, BleCandidate>()
        val results = callbackFlow {
            val callback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) { trySend(result) }
                override fun onBatchScanResults(results: MutableList<ScanResult>) { results.forEach { trySend(it) } }
                override fun onScanFailed(errorCode: Int) { close(BleProblem("蓝牙扫描失败，请稍后重试")) }
            }
            try {
                scanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(BleProtocol.SERVICE)).build()),
                    ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
            } catch (_: SecurityException) { close(BleProblem("蓝牙权限已取消，请重新允许附近设备")) }
            awaitClose { runCatching { scanner.stopScan(callback) } }
        }
        withTimeoutOrNull(12000) {
            results.collect { result ->
                if (found.size < 32 || found.containsKey(result.device.address)) {
                    val name = result.scanRecord?.deviceName?.filter { !it.isISOControl() }?.take(40).orEmpty().ifEmpty { "FIREFLY-SENSE" }
                    found[result.device.address] = BleCandidate(result.device.address, name)
                }
            }
        }
        return found.values.toList()
    }
}
