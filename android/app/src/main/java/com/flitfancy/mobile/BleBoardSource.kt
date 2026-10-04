package com.flitfancy.mobile

import android.annotation.SuppressLint
import android.bluetooth.*
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** One GATT operation at a time; notifications are independently assembled into a complete snapshot. */
@SuppressLint("MissingPermission") // Every connection/read checks runtime permission; revocation closes the handle.
class BleBoardSource(private val context: Context, private val address: String) : BoardSource {
    private data class Operation(val kind: String, val uuid: UUID?, val result: CompletableDeferred<ByteArray>)
    private val serial = Mutex()
    private val lock = Any()
    private var gatt: BluetoothGatt? = null
    private var operation: Operation? = null
    private var info: BleProtocol.Info? = null
    private var control: BluetoothGattCharacteristic? = null
    private var reader: BleProtocol.SnapshotReader? = null
    private var snapshot: CompletableDeferred<BleProtocol.Snapshot>? = null
    private var requestId = System.currentTimeMillis() and 0xffffffffL
    private var mtu = 23
    private var closed = false

    private fun live(): BluetoothGatt = synchronized(lock) { gatt } ?: throw BleProblem("蓝牙连接已断开，正在准备重连")
    private fun current(value: BluetoothGatt): Boolean = synchronized(lock) { !closed && gatt === value }
    private fun finish(value: BluetoothGatt, kind: String, uuid: UUID?, status: Int, bytes: ByteArray = byteArrayOf()) {
        if (!current(value)) return
        val pending = synchronized(lock) { operation?.takeIf { it.kind == kind && it.uuid == uuid } } ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) pending.result.complete(bytes.copyOf())
        else disconnect(BleProblem(if (status == 5 || status == 15) "蓝牙加密配对未完成，请在系统中确认配对" else "蓝牙数据操作失败，正在准备重连"))
    }
    private val callbacks = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(value: BluetoothGatt, status: Int, newState: Int) {
            if (!current(value)) return
            if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) disconnect(BleProblem("板子蓝牙暂时断开，已有缓存继续补传"))
            else if (newState == BluetoothProfile.STATE_CONNECTED) finish(value, "connect", null, status)
        }
        override fun onServicesDiscovered(value: BluetoothGatt, status: Int) { finish(value, "discover", null, status) }
        override fun onMtuChanged(value: BluetoothGatt, negotiated: Int, status: Int) {
            if (!current(value)) return
            synchronized(lock) { mtu = if (status == BluetoothGatt.GATT_SUCCESS) negotiated else 23 }
            finish(value, "mtu", null, BluetoothGatt.GATT_SUCCESS)
        }
        override fun onCharacteristicRead(value: BluetoothGatt, characteristic: BluetoothGattCharacteristic, bytes: ByteArray, status: Int) {
            finish(value, "read", characteristic.uuid, status, bytes)
        }
        @Deprecated("Older Android callback")
        override fun onCharacteristicRead(value: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33) finish(value, "read", characteristic.uuid, status, characteristic.value ?: byteArrayOf())
        }
        override fun onDescriptorWrite(value: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) { finish(value, "descriptor", descriptor.uuid, status) }
        override fun onCharacteristicWrite(value: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) { finish(value, "write", characteristic.uuid, status) }
        override fun onCharacteristicChanged(value: BluetoothGatt, characteristic: BluetoothGattCharacteristic, bytes: ByteArray) {
            if (!current(value) || characteristic.uuid != BleProtocol.DATA) return
            try {
                synchronized(lock) { reader?.accept(bytes, System.currentTimeMillis())?.let { snapshot?.complete(it) } }
            } catch (_: Exception) { disconnect(BleProblem("蓝牙快照不完整或协议不匹配，已有缓存保留")) }
        }
        @Deprecated("Older Android callback")
        override fun onCharacteristicChanged(value: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < 33) onCharacteristicChanged(value, characteristic, characteristic.value?.copyOf() ?: byteArrayOf())
        }
    }

    private suspend fun operate(kind: String, uuid: UUID? = null, timeout: Long = 10000, allowRejected: Boolean = false, start: () -> Boolean): ByteArray {
        val pending = Operation(kind, uuid, CompletableDeferred())
        synchronized(lock) { check(operation == null); if (closed) throw CancellationException("Source closed"); operation = pending }
        try {
            if (!start()) {
                if (allowRejected) return byteArrayOf()
                throw BleProblem("蓝牙操作暂不可用，正在准备重连")
            }
            return withTimeout(timeout) { pending.result.await() }
        } catch (_: TimeoutCancellationException) { throw BleProblem("蓝牙响应超时，已有缓存保留并准备重连") }
        finally { synchronized(lock) { if (operation === pending) operation = null } }
    }
    private suspend fun bond(device: BluetoothDevice) {
        if (device.bondState == BluetoothDevice.BOND_BONDED) return
        if (device.bondState == BluetoothDevice.BOND_NONE && !device.createBond()) throw BleProblem("系统蓝牙配对无法开始，请打开 App 重试")
        try {
            withTimeout(35000) {
                var bonding = device.bondState == BluetoothDevice.BOND_BONDING
                while (device.bondState != BluetoothDevice.BOND_BONDED) {
                    delay(250)
                    val state = device.bondState
                    if (state == BluetoothDevice.BOND_BONDING) bonding = true
                    if (bonding && state == BluetoothDevice.BOND_NONE) throw BleProblem("系统蓝牙配对未完成，请确认配对后重试")
                }
            }
        } catch (_: TimeoutCancellationException) { throw BleProblem("请在手机上确认系统蓝牙配对，再开始采集") }
    }
    @Suppress("DEPRECATION")
    private suspend fun connect() {
        val adapter = BluetoothAccess.adapter(context)
        if (!adapter.isEnabled) throw BleProblem("手机蓝牙已关闭，已有缓存继续补传")
        val device = adapter.getRemoteDevice(address)
        operate("connect", timeout = 15000) {
            synchronized(lock) {
                gatt = device.connectGatt(context, false, callbacks, BluetoothDevice.TRANSPORT_LE, BluetoothDevice.PHY_LE_1M_MASK, Handler(Looper.getMainLooper()))
                gatt != null
            }
        }
        operate("mtu", allowRejected = true) { live().requestMtu(247) }
        operate("discover") { live().discoverServices() }
        val service = live().getService(BleProtocol.SERVICE) ?: throw BleProblem("这块板子尚未提供手机蓝牙数据服务，请升级固件；可继续用 Wi-Fi")
        val identity = service.getCharacteristic(BleProtocol.INFO) ?: throw BleProblem("板子蓝牙信息接口不兼容，请更新固件")
        val stream = service.getCharacteristic(BleProtocol.DATA) ?: throw BleProblem("板子蓝牙数据接口不兼容，请更新固件")
        val command = service.getCharacteristic(BleProtocol.CONTROL) ?: throw BleProblem("板子蓝牙请求接口不兼容，请更新固件")
        if (identity.properties and BluetoothGattCharacteristic.PROPERTY_READ == 0 || stream.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0 || command.properties and BluetoothGattCharacteristic.PROPERTY_WRITE == 0) throw BleProblem("板子蓝牙协议不兼容，请更新固件")
        val metadata = operate("read", identity.uuid) { live().readCharacteristic(identity) }
        val parsed = try { BleProtocol.info(metadata) } catch (_: Exception) { throw BleProblem("板子型号或蓝牙协议不匹配，请更新固件") }
        bond(device)
        val descriptor = stream.getDescriptor(BleProtocol.CCCD) ?: throw BleProblem("板子没有提供数据订阅接口，请更新固件")
        if (!live().setCharacteristicNotification(stream, true)) throw BleProblem("暂时无法订阅板子蓝牙数据")
        operate("descriptor", descriptor.uuid) {
            if (Build.VERSION.SDK_INT >= 33) live().writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
            else { descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; live().writeDescriptor(descriptor) }
        }
        synchronized(lock) { info = parsed; control = command }
    }
    @Suppress("DEPRECATION")
    override suspend fun read(): BoardRead = serial.withLock {
        try {
            BluetoothAccess.adapter(context)
            if (synchronized(lock) { info == null }) connect()
            val deferred = CompletableDeferred<BleProtocol.Snapshot>()
            val command = synchronized(lock) {
                requestId = if (requestId >= 0xffffffffL) 1 else requestId + 1
                reader = BleProtocol.SnapshotReader(info ?: throw BleProblem("蓝牙连接已断开"), requestId)
                snapshot = deferred
                control ?: throw BleProblem("蓝牙连接已断开")
            }
            val bytes = BleProtocol.request(requestId)
            operate("write", command.uuid) {
                if (Build.VERSION.SDK_INT >= 33) live().writeCharacteristic(command, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
                else { command.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT; command.value = bytes; live().writeCharacteristic(command) }
            }
            val result = try { withTimeout(if (mtu <= 23) 60000 else 30000) { deferred.await() } }
                catch (_: TimeoutCancellationException) { throw BleProblem("蓝牙快照接收超时，已有缓存保留并准备重连") }
            BoardRead(result.rows, result.uptime, result.receivedAt, "ble:${result.boardId}:${result.bootId}")
        } catch (cancel: CancellationException) { disconnect(BleProblem("采集已暂停，缓存保留")); throw cancel }
          catch (error: Exception) {
            val failure = if (error is BleProblem) error else BleProblem(if (error is SecurityException) "蓝牙权限已取消，请允许附近设备；已有缓存保留" else "蓝牙连接暂不可用，已有缓存继续补传")
            disconnect(failure); throw failure
        } finally { synchronized(lock) { reader = null; snapshot = null } }
    }
    private fun disconnect(error: BleProblem) {
        val previous: BluetoothGatt?
        synchronized(lock) {
            previous = gatt; gatt = null; info = null; control = null; reader = null; mtu = 23
            operation?.result?.completeExceptionally(error); operation = null
            snapshot?.completeExceptionally(error); snapshot = null
        }
        previous?.let { runCatching { it.disconnect() }; runCatching { it.close() } }
    }
    override fun close() { synchronized(lock) { closed = true }; disconnect(BleProblem("采集已暂停，缓存保留")) }
}
