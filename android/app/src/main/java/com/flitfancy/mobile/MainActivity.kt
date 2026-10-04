package com.flitfancy.mobile

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
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
        collectorPanel.addView(text("感知板地址（手机须与感知板在同一局域网）"))
        boardInput = EditText(this).apply { setText(settings.board); setTextColor(Color.WHITE); inputType = 17; isSingleLine = true }
        collectorPanel.addView(boardInput)
        collectorPanel.addView(button("保存感知板地址") {
            runCatching { settings.board = boardInput.text.toString(); Toast.makeText(this, "地址已保存", Toast.LENGTH_SHORT).show() }
                .onFailure { message("请输入有效的局域网 IPv4 地址，例如 192.168.1.33") }
        })
        collectorPanel.addView(button("打开网站管理页生成配对码") { showWebsite(); web.loadUrl(freshUrl("${BuildConfig.UPLOAD_BASE}/console.html")) })
        collectorPanel.addView(button("输入配对码") { pair() })
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

    private fun pair() {
        if (settings.enabled) { message("请先暂停采集再更换配对，缓存会保留"); return }
        val input = EditText(this).apply { hint = "例如 ABCD-EF12-3456"; isSingleLine = true; inputType = 4097 }
        AlertDialog.Builder(this).setTitle("配对手机采集").setView(input).setNegativeButton("取消", null)
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
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 44)
        }
        runCatching {
            settings.board = boardInput.text.toString()
            settings.enabled = true
            ContextCompat.startForegroundService(this, Intent(this, CollectorService::class.java))
            showCollector()
        }.onFailure { settings.enabled = false; message("暂时无法开始，请检查地址与后台运行权限") }
    }

    private fun updateStatus() {
        if (!::collectorStatus.isInitialized) return
        scope.launch {
            val count = withContext(Dispatchers.IO) { QueueStore.get(this@MainActivity).queue().count() }
            val uploaded = settings.lastUpload.takeIf { it > 0 }?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) } ?: "尚未成功上传"
            collectorStatus.text = "来源：${settings.name}\n${settings.status}\n待上传：$count 条\n最近成功：$uploaded"
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
    override fun onPause() { if (::web.isInitialized) web.onPause(); super.onPause() }
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
    override fun onDestroy() { scope.cancel(); fileCallback?.onReceiveValue(null); web.destroy(); super.onDestroy() }
}
