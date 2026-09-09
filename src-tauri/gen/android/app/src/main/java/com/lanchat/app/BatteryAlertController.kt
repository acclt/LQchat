package com.lanchat.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.UUID
import org.json.JSONObject
import kotlin.math.roundToInt

/** Event-driven 50%/100% battery alerts owned by the existing foreground service. */
class BatteryAlertController(
    context: Context,
    private val notificationManager: NotificationManager,
    private val handler: Handler,
    private val contentIntent: () -> PendingIntent,
) {
    companion object {
        internal const val CHANNEL_ID = "lanchat_battery_alerts_v1"
        internal const val REMINDER_INTERVAL_MS = 5_000L
        internal const val REMINDER_COUNT = 3
        internal const val STALE_SEQUENCE_MS = 60_000L
        private const val PREFS = "lanchat_battery_alert_state"
        private const val LAST_LEVEL = "last_level"
        private const val ACTIVE_THRESHOLD = "active_threshold"
        private const val SENT_COUNT = "sent_count"
        private const val STARTED_AT = "started_at"
        private const val NEXT_AT = "next_at"
        private val TARGET_LEVELS = setOf(50, 100)
        private val NOTIFICATION_IDS = intArrayOf(9_251, 9_252, 9_253)

        /** Returns the crossed display threshold; 100% wins if a large jump crosses both. */
        internal fun thresholdFor(previousLevel: Int, currentLevel: Int): Int? {
            if (currentLevel >= 100 && previousLevel < 100) return 100
            if (previousLevel < 0) return if (currentLevel == 50) 50 else null
            val crossedFifty =
                (previousLevel < 50 && currentLevel >= 50) ||
                    (previousLevel > 50 && currentLevel <= 50)
            return if (crossedFifty) 50 else null
        }

        internal fun shouldPush(settings: JSONObject): Boolean =
            settings.optBoolean("push_enabled") &&
                settings.optBoolean("lq_battery_push_enabled") &&
                (settings.optJSONArray("target_device_ids")?.length() ?: 0) > 0
    }

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var receiverRegistered = false
    private val reminderRunnable = Runnable { sendNextReminder() }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_BATTERY_CHANGED) handleBatteryChanged(intent)
        }
    }

    fun refresh() {
        if (!BackgroundRuntimeSettings.batteryAlertEnabled(appContext)) {
            stop(clearState = true)
            return
        }
        ensureNotificationChannel()
        if (!receiverRegistered) {
            runCatching {
                val sticky = ContextCompat.registerReceiver(
                    appContext,
                    receiver,
                    IntentFilter(Intent.ACTION_BATTERY_CHANGED),
                    ContextCompat.RECEIVER_EXPORTED,
                )
                receiverRegistered = true
                sticky?.let(::handleBatteryChanged)
            }.onFailure {
                receiverRegistered = false
                android.util.Log.e("BatteryAlert", "注册电量监听失败", it)
            }
        }
        resumePendingSequence()
    }

    fun stop(clearState: Boolean) {
        handler.removeCallbacks(reminderRunnable)
        if (receiverRegistered) {
            runCatching { appContext.unregisterReceiver(receiver) }
            receiverRegistered = false
        }
        if (clearState) {
            prefs.edit().clear().commit()
            cancelAlertNotifications()
        }
    }

    private fun handleBatteryChanged(intent: Intent) {
        if (!BackgroundRuntimeSettings.batteryAlertEnabled(appContext)) return
        val rawLevel = intent.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1)
        if (rawLevel < 0 || scale <= 0) return
        val currentLevel = (rawLevel * 100f / scale).roundToInt().coerceIn(0, 100)
        val previousLevel = prefs.getInt(LAST_LEVEL, -1)
        prefs.edit().putInt(LAST_LEVEL, currentLevel).commit()

        val threshold = thresholdFor(previousLevel, currentLevel) ?: return
        val activeThreshold = prefs.getInt(ACTIVE_THRESHOLD, 0)
        if (activeThreshold == threshold) return
        if (activeThreshold != 0 && threshold != 100) return
        beginSequence(threshold)
    }

    private fun beginSequence(threshold: Int) {
        if (threshold !in TARGET_LEVELS) return
        handler.removeCallbacks(reminderRunnable)
        cancelAlertNotifications()
        val now = System.currentTimeMillis()
        prefs.edit()
            .putInt(ACTIVE_THRESHOLD, threshold)
            .putInt(SENT_COUNT, 0)
            .putLong(STARTED_AT, now)
            .putLong(NEXT_AT, now)
            .commit()
        sendNextReminder()
    }

    private fun resumePendingSequence() {
        handler.removeCallbacks(reminderRunnable)
        val threshold = prefs.getInt(ACTIVE_THRESHOLD, 0)
        if (threshold !in TARGET_LEVELS) return
        val now = System.currentTimeMillis()
        val startedAt = prefs.getLong(STARTED_AT, 0L)
        if (startedAt <= 0L || now < startedAt || now - startedAt > STALE_SEQUENCE_MS) {
            clearSequence()
            return
        }
        val delay = (prefs.getLong(NEXT_AT, now) - now).coerceAtLeast(0L)
        handler.postDelayed(reminderRunnable, delay)
    }

    private fun sendNextReminder() {
        if (!BackgroundRuntimeSettings.batteryAlertEnabled(appContext)) {
            stop(clearState = true)
            return
        }
        val threshold = prefs.getInt(ACTIVE_THRESHOLD, 0)
        if (threshold !in TARGET_LEVELS) return
        val now = System.currentTimeMillis()
        val startedAt = prefs.getLong(STARTED_AT, 0L)
        if (startedAt <= 0L || now < startedAt || now - startedAt > STALE_SEQUENCE_MS) {
            clearSequence()
            return
        }

        val sentCount = prefs.getInt(SENT_COUNT, 0)
        if (sentCount >= REMINDER_COUNT) {
            clearSequence()
            return
        }
        postReminder(threshold, sentCount)
        val nextCount = sentCount + 1
        if (nextCount >= REMINDER_COUNT) {
            clearSequence()
            return
        }
        val nextAt = now + REMINDER_INTERVAL_MS
        prefs.edit().putInt(SENT_COUNT, nextCount).putLong(NEXT_AT, nextAt).commit()
        handler.postDelayed(reminderRunnable, REMINDER_INTERVAL_MS)
    }

    private fun postReminder(threshold: Int, reminderIndex: Int) {
        cancelAlertNotifications()
        val title = LocalDeviceIdentity.batteryNotificationTitle(LocalDeviceIdentity.read(appContext))
        val notification = NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText("$threshold%")
            .setContentIntent(contentIntent())
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        runCatching {
            notificationManager.notify(NOTIFICATION_IDS[reminderIndex], notification)
            pushReminder(threshold, reminderIndex)
        }.onFailure {
            android.util.Log.w("BatteryAlert", "发送电量提醒失败", it)
        }
    }

    /** LQChat-owned notifications bypass the app picker and can never be collected by the listener. */
    private fun pushReminder(threshold: Int, reminderIndex: Int) {
        if (!LanChatForegroundService.notificationSessionReady()) return
        val settings = NotificationSyncSettings.read(appContext)
        if (!shouldPush(settings)) return
        val startedAt = prefs.getLong(STARTED_AT, System.currentTimeMillis())
        val message = JSONObject()
            .put("msg_type", "notification")
            .put("event_id", UUID.randomUUID().toString())
            .put("source_device_id", "")
            .put("target_device_id", "")
            .put("package", appContext.packageName)
            .put("app_name", "LQChat")
            .put("title", "电量提醒")
            .put("text", "$threshold%")
            .put("notification_key", "lq-battery-$threshold-$startedAt-$reminderIndex")
            .put("post_time", System.currentTimeMillis())
        NotificationAppIcon.encode(appContext, appContext.packageName)?.let { message.put("app_icon", it) }
        NotificationSyncNative.send(
            JSONObject().put("notification", message).put("settings", settings).toString(),
        )
    }

    private fun clearSequence() {
        handler.removeCallbacks(reminderRunnable)
        prefs.edit()
            .remove(ACTIVE_THRESHOLD)
            .remove(SENT_COUNT)
            .remove(STARTED_AT)
            .remove(NEXT_AT)
            .commit()
    }

    private fun cancelAlertNotifications() {
        NOTIFICATION_IDS.forEach(notificationManager::cancel)
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        notificationManager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "电量提醒",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "手机电量达到 50% 或 100% 时提醒"
                enableVibration(true)
                setShowBadge(true)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
    }
}
