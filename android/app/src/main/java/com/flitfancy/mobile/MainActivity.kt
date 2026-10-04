package com.flitfancy.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.*
import androidx.core.content.ContextCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.*
import kotlinx.coroutines.*
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var settings: AppSettings
    private lateinit var collectorStatus: TextView
    private lateinit var collectorPanel: LinearLayout
    private lateinit var boardInput: EditText
    private lateinit var transportGroup: RadioGroup
    private lateinit var wifiPanel: LinearLayout
    private lateinit var blePanel: LinearLayout
    private lateinit var blePeer: TextView
    private lateinit var scanButton: Button
    private lateinit var saveBoardButton: Button
    private val wifiModeId = View.generateViewId()
    private val bleModeId = View.generateViewId()
    private var scanJob: Job? = null
    private var pendingBluetoothAction: (() -> Unit)? = null
    private var pendingBluetoothScan = false
    private var pendingEnableAction: (() -> Unit)? = null
    private val nearbyPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val action = pendingBluetoothAction; pendingBluetoothAction = null
        if (BluetoothAccess.granted(this, pendingBluetoothScan)) action?.invoke()
        else message("未获得蓝牙权限；可以在系统设置允许附近设备，或继续使用 Wi-Fi")
    }
    private val enableBluetooth = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val action = pendingEnableAction; pendingEnableAction = null
        if (result.resultCode == RESULT_OK) action?.invoke() else message("手机蓝牙仍未开启，已有缓存保留")
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var panelVisible = false
    private var lastVersionCheck = 0L
    private var websiteVersion = ""
    private val gold = Color.rgb(245, 184, 75)
    private fun button(label: String, action: () -> Unit): Button = Button(this).apply { text = label; setTextColor(gold); setOnClickListener { action() } }
    private fun text(label: String): TextView = TextView(this).apply { text = label; setTextColor(Color.LTGRAY); setPadding(12, 10, 12, 10) }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        settings = AppSettings(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(12,16,24)) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom); insets
        }
        val navigation = LinearLayout(this)
        for ((label, action) in listOf<Pair<String, () -> Unit>>(
            "网站" to { showWebsite() }, "采集" to { showCollector() }, "刷新" to { web.loadUrl(freshUrl(web.url ?: BuildConfig.WEBSITE_URL)) })) {
            navigation.addView(button(label, action), LinearLayout.LayoutParams(0, 48.dp, 1f))
        }
        root.addView(navigation)
        web = WebView(this)
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val scroll = ScrollView(this)
        collectorPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(14.dp, 12.dp, 14.dp, 12.dp) }
        scroll.addView(collectorPanel)
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        scroll.tag = "collector"; scroll.visibility = View.GONE
        setContentView(root)
        configureWeb()
        configureCollector()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (panelVisible) showWebsite()
                else if (web.canGoBack()) web.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
            }
        })
        if (state == null || web.restoreState(state) == null) web.loadUrl(freshUrl(BuildConfig.WEBSITE_URL))
        scope.launch {
            while (isActive) { updateStatus(); delay(2000) }
        }
    }

    private val Int.dp: Int get() = (this * resources.displayMetrics.density).toInt()
    private fun panelContainer(): View = collectorPanel.parent as View
    private fun showWebsite() { panelVisible = false; panelContainer().visibility = View.GONE; web.visibility = View.VISIBLE }
    private fun showCollector() { panelVisible = true; web.visibility = View.GONE; panelContainer().visibility = View.VISIBLE; updateStatus() }

    private fun configureCollector() {
        collectorPanel.addView(text("手机采集 · ${BuildConfig.VERSION_NAME}"))
        collectorStatus = text(""); collectorPanel.addView(collectorStatus)
        collectorPanel.addView(text("连接感知板的方式"))
        transportGroup = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        transportGroup.addView(RadioButton(this).apply { id = bleModeId; text = "蓝牙"; setTextColor(gold) })
        transportGroup.addView(RadioButton(this).apply { id = wifiModeId; text = "Wi-Fi"; setTextColor(gold) })
        collectorPanel.addView(transportGroup)
        transportGroup.check(if (settings.transport == "ble") bleModeId else wifiModeId)
        transportGroup.setOnCheckedChangeListener { _, id ->
            val transport = if (id == bleModeId) "ble" else "wifi"
            if (settings.transport != transport) {
                if (settings.enabled) { message("请先暂停采集再切换连接方式，缓存会保留"); updateConnectionControls() }
                else { settings.transport = transport; updateConnectionControls() }
            }
        }
        blePanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        blePanel.addView(text("手机通过蓝牙读板子，使用自己的 Wi-Fi 或流量上传。"))
        blePeer = text(""); blePanel.addView(blePeer)
        scanButton = button("扫描并选择感知板") { withBluetooth(true) { scanBoards() } }
        blePanel.addView(scanButton)
        blePanel.addView(text("需要支持手机数据服务的板子固件；1.3.5 尚不支持。第一次连接时请确认系统蓝牙配对。"))
        collectorPanel.addView(blePanel)
        wifiPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        wifiPanel.addView(text("感知板地址（手机须与感知板在同一局域网）"))
        boardInput = EditText(this).apply { setText(settings.board); setTextColor(Color.WHITE); inputType = 17; isSingleLine = true }
        wifiPanel.addView(boardInput)
        saveBoardButton = button("保存感知板地址") {
            if (settings.enabled) { message("请先暂停采集再修改地址，缓存会保留"); return@button }
            runCatching { settings.board = boardInput.text.toString(); Toast.makeText(this, "地址已保存", Toast.LENGTH_SHORT).show() }
                .onFailure { message("请输入有效的局域网 IPv4 地址，例如 192.168.1.33") }
        }
        wifiPanel.addView(saveBoardButton)
        collectorPanel.addView(wifiPanel)
        updateConnectionControls()
        collectorPanel.addView(text("手机上报配对用于连接网站；蓝牙设备选择用于连接感知板。"))
        collectorPanel.addView(button("打开管理页生成手机上报码") { showWebsite(); web.loadUrl(freshUrl("${BuildConfig.UPLOAD_BASE}/console.html")) })
        collectorPanel.addView(button("输入手机上报配对码") { pair() })
        collectorPanel.addView(button("开始采集") { startCollector() })
        collectorPanel.addView(button("暂停采集") {
            settings.enabled = false; settings.status = "采集已暂停，缓存保留"; stopService(Intent(this, CollectorService::class.java)); updateStatus()
        })
        collectorPanel.addView(button("导出待上传缓存") {
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                type = "application/x-ndjson"; addCategory(Intent.CATEGORY_OPENABLE); putExtra(Intent.EXTRA_TITLE, "flitfancy-pending.jsonl")
            }, 43)
        })
        collectorPanel.addView(text("采集每 5 秒读取一次感知板；断网数据保留，主机确认完整保存后才移出队列。请允许自启动，并检查系统的省电限制。"))
        collectorPanel.addView(button("打开本 App 系统设置") {
            startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        })
        collectorPanel.addView(button("允许锁屏持续采集") {
            val power = getSystemService(PowerManager::class.java)
            if (power.isIgnoringBatteryOptimizations(packageName)) message("系统已允许本 App 不受电池优化限制")
            else runCatching { startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"))) }.onFailure { message("请在系统设置中允许本 App 持续后台运行") }
        })
        collectorPanel.addView(text("持续采集会增加耗电，可随时暂停。小米系统的自启动和省电设置仍需检查。"))
    }

    private fun updateConnectionControls() {
        if (!::blePanel.isInitialized) return
        val bluetooth = settings.transport == "ble"
        blePanel.visibility = if (bluetooth) View.VISIBLE else View.GONE
        wifiPanel.visibility = if (bluetooth) View.GONE else View.VISIBLE
        blePeer.text = "感知板：${settings.bleName}"
        transportGroup.check(if (bluetooth) bleModeId else wifiModeId)
        for (index in 0 until transportGroup.childCount) transportGroup.getChildAt(index).isEnabled = !settings.enabled && scanJob?.isActive != true
        boardInput.isEnabled = !settings.enabled
        saveBoardButton.isEnabled = !settings.enabled
        scanButton.isEnabled = !settings.enabled && scanJob?.isActive != true
    }

    @SuppressLint("MissingPermission") // Permissions are requested before using BluetoothAdapter.
    private fun withBluetooth(scan: Boolean, action: () -> Unit) {
        if (settings.enabled) { message("请先暂停采集，再选择或重新连接蓝牙感知板"); return }
        if (!BluetoothAccess.granted(this, scan)) {
            pendingBluetoothScan = scan
            pendingBluetoothAction = { withBluetooth(scan, action) }
            nearbyPermission.launch(BluetoothAccess.permissions(scan)); return
        }
        try {
            val adapter = BluetoothAccess.adapter(this, scan)
            if (!adapter.isEnabled) {
                pendingEnableAction = { withBluetooth(scan, action) }
                enableBluetooth.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
            } else action()
        } catch (_: SecurityException) { message("蓝牙权限已取消，请重新允许附近设备") }
          catch (error: BleProblem) { message(error.message ?: "蓝牙暂不可用") }
    }

    private fun scanBoards() {
        if (settings.enabled || scanJob?.isActive == true) return
        val dialog = AlertDialog.Builder(this).setTitle("扫描感知板")
            .setMessage("正在查找附近的兼容感知板，约 12 秒。请让板子靠近手机。")
            .setNegativeButton("取消") { _, _ -> scanJob?.cancel() }.create()
        dialog.setOnCancelListener { scanJob?.cancel() }
        dialog.show()
        scanJob = scope.launch {
            try {
                val candidates = BleDiscovery.scan(this@MainActivity)
                if (isFinishing || isDestroyed || settings.enabled) return@launch
                dialog.dismiss()
                if (candidates.isEmpty()) message("没有找到兼容感知板。请确认板子已升级手机蓝牙数据固件、已经上电并靠近手机；固件 1.3.5 仍需使用 Wi-Fi。")
                else AlertDialog.Builder(this@MainActivity).setTitle("选择感知板")
                    .setItems(candidates.map { "${it.name} · ${it.address.takeLast(5)}" }.toTypedArray()) { _, index ->
                        if (!settings.enabled) {
                            settings.selectBle(candidates[index]); settings.transport = "ble"; updateConnectionControls()
                            message("已选择感知板。手机配对完成后点击“开始采集”；首次蓝牙连接时请确认系统配对。")
                        }
                    }.setNegativeButton("取消", null).show()
            } catch (cancel: CancellationException) { throw cancel }
              catch (error: Exception) { message((error as? BleProblem)?.message ?: "暂时无法扫描，请检查蓝牙权限后重试") }
            finally { dialog.dismiss(); scanJob = null; updateConnectionControls() }
        }
        updateConnectionControls()
    }

    private fun pair() {
        if (settings.enabled) { message("请先暂停采集再更换配对，缓存会保留"); return }
        val input = EditText(this).apply { hint = "例如 ABCD-EF12-3456"; isSingleLine = true; inputType = 4097 }
        AlertDialog.Builder(this).setTitle("手机与网站配对").setView(input).setNegativeButton("取消", null)
            .setPositiveButton("配对") { _, _ -> scope.launch {
                try {
                    val response = withContext(Dispatchers.IO) { JSONObject(HttpTransport.json(BuildConfig.UPLOAD_BASE + "/api/collectors/claim",
                        JSONObject().put("pairing_code", input.text.toString()))) }
                    val pending = withContext(Dispatchers.IO) { QueueStore.get(this@MainActivity).queue().count() }
                    if (pending > 0 && settings.deviceId.isNotEmpty() && settings.deviceId != response.getString("device_id")) {
                        message("旧配对还有待上传数据。请在网站对原设备选择“重新配对”，缓存已保留。")
                    } else { settings.pair(response); message("已配对为「${settings.name}」"); updateStatus() }
                } catch (cancel: CancellationException) { throw cancel }
                  catch (error: Exception) { message(if (error is HttpFailure) error.message ?: "配对失败" else "暂时无法配对，请检查主机和网络") }
            } }.show()
    }

    private fun startCollector() {
        if (settings.deviceId.isEmpty() || settings.token().isEmpty()) { message("请先配对手机"); return }
        // enabled is persisted intent, not proof the service survived an APK update or OS kill.
        if (settings.enabled) { launchCollector(); return }
        if (scanJob?.isActive == true) { message("请先完成扫描并选择感知板"); return }
        if (settings.transport == "ble") {
            if (settings.bleAddress.isEmpty()) { showCollector(); message("请先扫描并选择蓝牙感知板"); return }
            withBluetooth(false) { launchCollector() }
        } else launchCollector()
    }

    private fun launchCollector() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 44)
        }
        runCatching {
            if (settings.transport == "wifi" && !settings.enabled) settings.board = boardInput.text.toString()
            settings.enabled = true
            ContextCompat.startForegroundService(this, Intent(this, CollectorService::class.java))
            showCollector()
        }.onFailure { settings.enabled = false; updateConnectionControls(); message("暂时无法开始，请检查连接设置与后台运行权限") }
    }

    private fun updateStatus() {
        if (!::collectorStatus.isInitialized) return
        updateConnectionControls()
        scope.launch {
            val count = withContext(Dispatchers.IO) { QueueStore.get(this@MainActivity).queue().count() }
            val uploaded = settings.lastUpload.takeIf { it > 0 }?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) } ?: "尚未成功上传"
            val received = settings.lastBoardRead.takeIf { it > 0 }?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) } ?: "尚未收到感知板数据"
            collectorStatus.text = "来源：${settings.name}\n连接：${if (settings.transport == "ble") "蓝牙" else "Wi-Fi"}\n${settings.status}\n待上传：$count 条\n最近读板：$received\n最近上传：$uploaded"
        }
    }

    private fun configureWeb() {
        web.setBackgroundColor(Color.rgb(12,16,24))
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; allowFileAccess = false
            allowContentAccess = true; mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true; userAgentString += " FlitFancyMobile/${BuildConfig.VERSION_NAME}"
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (SampleCodec.trustedWebsite(request.url.toString())) return false
                if (request.isForMainFrame && request.url.scheme in setOf("http", "https", "mailto", "tel")) {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                }
                return true
            }
            override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) { handler.cancel() }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = callback
                return runCatching { startActivityForResult(params.createIntent(), 42); true }.getOrElse { callback.onReceiveValue(null); fileCallback = null; false }
            }
        }
        web.setDownloadListener { url, _, _, _, _ -> if (SampleCodec.trustedWebsite(url)) runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "FlitFancyNative", setOf("https://flitfancy.com", "https://console.flitfancy.com")) { _, message, _, mainFrame, reply ->
                if (mainFrame && (message.data?.length ?: 0) <= 1024) runCatching {
                    val action = JSONObject(message.data ?: "{}").optString("action")
                    when (action) {
                        "start" -> startCollector()
                        "stop" -> { settings.enabled = false; settings.status = "采集已暂停，缓存保留"; stopService(Intent(this, CollectorService::class.java)) }
                    }
                    scope.launch {
                        val pending = withContext(Dispatchers.IO) { QueueStore.get(this@MainActivity).queue().count() }
                        reply.postMessage(JSONObject().put("protocol", 1).put("name", settings.name).put("enabled", settings.enabled)
                            .put("pending", pending).put("status", settings.status).toString())
                    }
                }
            }
        }
    }

    private fun freshUrl(url: String): String {
        if (!SampleCodec.trustedWebsite(url)) return BuildConfig.WEBSITE_URL
        val parsed = Uri.parse(url)
        val builder = parsed.buildUpon().clearQuery()
        for (key in parsed.queryParameterNames) if (key != "app_refresh") for (value in parsed.getQueryParameters(key)) builder.appendQueryParameter(key, value)
        return builder.appendQueryParameter("app_refresh", System.currentTimeMillis().toString()).build().toString()
    }
    private fun message(text: String) { if (!isFinishing && !isDestroyed) AlertDialog.Builder(this).setMessage(text).setPositiveButton("好", null).show() }
    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) web.onResume()
        if (System.currentTimeMillis() - lastVersionCheck > 60000) {
            lastVersionCheck = System.currentTimeMillis()
            scope.launch {
                val version = withContext(Dispatchers.IO) { runCatching { JSONObject(HttpTransport.json("https://flitfancy.com/mobile-version.json?check=${System.currentTimeMillis()}"))
                    .optString("website_version") }.getOrDefault("") }
                if (version.isNotEmpty() && websiteVersion.isNotEmpty() && version != websiteVersion) {
                    Toast.makeText(this@MainActivity, "网站已有新版，点“刷新”更新；未保存内容可先完成", Toast.LENGTH_LONG).show()
                }
                if (version.isNotEmpty()) websiteVersion = version
            }
        }
    }
    override fun onPause() { scanJob?.cancel(); if (::web.isInitialized) web.onPause(); super.onPause() }
    override fun onSaveInstanceState(out: Bundle) { web.saveState(out); super.onSaveInstanceState(out) }
    @Deprecated("Compatibility with older Android") override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 42) { fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); fileCallback = null }
        if (requestCode == 43 && resultCode == RESULT_OK && data?.data != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) {
                val rows = QueueStore.get(this@MainActivity).queue().batch(settings.deviceId, 100000)
                contentResolver.openOutputStream(data.data!!)?.bufferedWriter()?.use { output ->
                    rows.forEach { output.write(JSONObject().put("device_id", it.deviceId).put("event_id", it.eventId).put("row", JSONObject(it.payload)).toString() + "\n") }
                } ?: error("无法打开保存位置")
            } }.onSuccess { message("缓存已导出，上传队列继续保留") }.onFailure { message("暂时无法导出，缓存仍保留") }
        }
    }
    override fun onDestroy() { pendingBluetoothAction = null; pendingEnableAction = null; scope.cancel(); fileCallback?.onReceiveValue(null); web.destroy(); super.onDestroy() }
}
