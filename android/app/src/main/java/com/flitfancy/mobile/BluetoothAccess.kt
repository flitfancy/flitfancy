package com.flitfancy.mobile

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.io.IOException

class BleProblem(message: String) : IOException(message)

object BluetoothAccess {
    fun permissions(scan: Boolean, sdk: Int = Build.VERSION.SDK_INT): Array<String> = when {
        sdk >= 31 -> if (scan) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT) else arrayOf(Manifest.permission.BLUETOOTH_CONNECT)
        scan -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        else -> emptyArray()
    }
    fun granted(context: Context, scan: Boolean): Boolean = permissions(scan).all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
    fun adapter(context: Context, scan: Boolean = false): BluetoothAdapter {
        if (!granted(context, scan)) throw BleProblem("请允许蓝牙附近设备权限；已有缓存保留")
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) throw BleProblem("这台手机不支持低功耗蓝牙，请使用 Wi-Fi 采集")
        return context.getSystemService(BluetoothManager::class.java)?.adapter ?: throw BleProblem("手机蓝牙暂不可用")
    }
    fun locationReady(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 31) return true
        val manager = context.getSystemService(LocationManager::class.java)
        return if (Build.VERSION.SDK_INT >= 28) manager.isLocationEnabled
        else manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }
}
