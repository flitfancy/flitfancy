package com.flitfancy.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED || !AppSettings(context).enabled) return
        runCatching { ContextCompat.startForegroundService(context, Intent(context, CollectorService::class.java)) }
            .onFailure { AppSettings(context).status = "请打开 App 恢复后台采集" }
    }
}
