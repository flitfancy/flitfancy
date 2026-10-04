package com.flitfancy.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

class CollectorService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private lateinit var settings: AppSettings
    private lateinit var dao: QueueDao
    private lateinit var wakeLock: PowerManager.WakeLock
    private var wakeRenewedAt = 0L
    override fun onCreate() {
        super.onCreate()
        settings = AppSettings(this); dao = QueueStore.get(this).queue()
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FlitFancy:collector")
        wakeLock.setReferenceCounted(false)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("collector", "感知板采集", NotificationManager.IMPORTANCE_LOW))
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, CollectorService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, "collector").setSmallIcon(R.drawable.ic_flitfancy)
            .setContentTitle("FlitFancy · ${settings.name}").setContentText(text).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).addAction(0, "暂停采集", stop).build()
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            settings.enabled = false; settings.status = "采集已暂停，缓存保留"; stopSelf()
            return START_NOT_STICKY
        }
        if (settings.deviceId.isEmpty() || settings.token().isEmpty() || !settings.enabled) {
            settings.enabled = false; stopSelf(); return START_NOT_STICKY
        }
        val initial = notification("正在连接感知板")
        if (Build.VERSION.SDK_INT >= 29) startForeground(7, initial, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(7, initial)
        if (job?.isActive != true) job = scope.launch {
            try { collect() }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { settings.enabled = false; settings.status = "后台缓存暂时不可用，请检查手机存储；已有数据保留"; stopSelf() }
        }
        return START_STICKY
    }

    private suspend fun collect() {
        while (currentCoroutineContext().isActive && settings.enabled) {
            if (!wakeLock.isHeld || SystemClock.elapsedRealtime() - wakeRenewedAt > 9 * 60000) {
                wakeLock.acquire(10 * 60000L); wakeRenewedAt = SystemClock.elapsedRealtime()
            }
            var boardMessage = ""
            try {
                if (dao.count() >= 100000) boardMessage = "缓存已满，采集暂停；正在尝试补传"
                else {
                    val base = SampleCodec.boardBase(settings.board)
                    val data = JSONArray(HttpTransport.json(base + "/data"))
                    val device = JSONObject(HttpTransport.json(base + "/device"))
                    require(device.optString("model") == "FIREFLY-SENSE N16R8") { "地址不是已支持的感知板" }
                    val uptime = device.optLong("uptime_ms", -1)
                    require(uptime in 0..0xffffffffL) { "感知板未提供有效运行时间" }
                    val now = System.currentTimeMillis()
                    val boot = settings.bootId(uptime, now)
                    var added = 0
                    currentCoroutineContext().ensureActive()
                    for (index in 0 until data.length()) {
                        currentCoroutineContext().ensureActive()
                        if (!settings.enabled) break
                        if (dao.count() >= 100000) break
                        val frame = SampleCodec.parse(data.optString(index), uptime, now, boot, "FIREFLY-SENSE") ?: continue
                        if (dao.enqueue(PendingSample(frame.eventId, settings.deviceId, frame.payload, frame.emittedAt), now)) added++
                    }
                    dao.pruneSeen(now - 7 * 86400000L)
                    boardMessage = "感知板已连接，本轮新增 $added 条"
                }
            } catch (cancel: CancellationException) { throw cancel }
              catch (_: Exception) { boardMessage = "感知板暂不可用，已有缓存继续补传" }
            currentCoroutineContext().ensureActive()
            try {
                val batch = dao.batch(settings.deviceId)
                if (batch.isNotEmpty()) {
                    val events = JSONArray()
                    batch.forEach { events.put(JSONObject().put("event_id", it.eventId).put("row", JSONObject(it.payload))) }
                    val result = JSONObject(HttpTransport.json(BuildConfig.UPLOAD_BASE + "/api/collectors/ingest",
                        JSONObject().put("protocol", 1).put("events", events), settings.token()))
                    require(result.optBoolean("ok")) { "主机尚未确认保存" }
                    val ids = result.getJSONArray("acknowledged")
                    val received = (0 until ids.length()).map { ids.getString(it) }
                    require(received.size == batch.size && received.toSet() == batch.map { it.eventId }.toSet()) { "主机确认不完整，缓存保留" }
                    dao.acknowledge(settings.deviceId, received)
                    settings.lastUpload = System.currentTimeMillis()
                }
                settings.status = "$boardMessage · 待上传 ${dao.count()} 条"
            } catch (failure: HttpFailure) {
                if (failure.status == 401) {
                    settings.enabled = false
                    settings.status = "上传凭证已失效，请重新配对；缓存保留"
                } else settings.status = "$boardMessage · 上传暂不可用，待补传 ${dao.count()} 条"
            } catch (cancel: CancellationException) { throw cancel }
              catch (_: Exception) { settings.status = "$boardMessage · 上传暂不可用，待补传 ${dao.count()} 条" }
            currentCoroutineContext().ensureActive()
            getSystemService(NotificationManager::class.java).notify(7, notification(settings.status))
            delay(5000)
        }
        if (!settings.enabled) stopSelf()
    }
    override fun onDestroy() {
        scope.cancel()
        if (wakeLock.isHeld) wakeLock.release()
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object { const val STOP = "com.flitfancy.mobile.STOP" }
}
