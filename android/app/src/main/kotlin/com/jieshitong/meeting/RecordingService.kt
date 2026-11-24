package com.jieshitong.meeting

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service (type microphone) that lets the WebView keep recording
 * while the screen is locked or another app is in front. It shows an ongoing
 * notification with the meeting time and, while the app is in the
 * background, the floating window.
 */
class RecordingService : Service() {
    companion object {
        private const val CHANNEL = "meeting"
        private const val NOTIFICATION_ID = 1
        private const val MAX_WAKE_MS = 2 * 60 * 60 * 1000L
        private const val EXTRA_PHASE = "phase"
        private const val EXTRA_STARTED_AT = "startedAt"

        private var instance: RecordingService? = null
        private var appVisible = true

        fun update(context: Context, phase: String, startedAt: Long) {
            val intent = Intent(context, RecordingService::class.java)
                .putExtra(EXTRA_PHASE, phase)
                .putExtra(EXTRA_STARTED_AT, startedAt)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: RuntimeException) {
                // Android 12+ refuses a start from the background; the page
                // keeps recording on its own while the app stays in front.
            }
        }

        fun stop(context: Context) {
            if (instance != null) context.stopService(Intent(context, RecordingService::class.java))
        }

        fun setAppVisible(visible: Boolean) {
            appVisible = visible
            instance?.refreshFloating()
        }
    }

    private var phase = "recording"
    private var startedAt = System.currentTimeMillis()
    private lateinit var wakeLock: PowerManager.WakeLock
    private lateinit var floating: FloatingWindow

    override fun onCreate() {
        super.onCreate()
        instance = this
        floating = FloatingWindow(this) { startActivity(appIntent(Intent.ACTION_MAIN)) }
        NotificationManagerCompat.from(this).createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName("会议录音")
                .setDescription("开会时显示录音状态")
                .setShowBadge(false)
                .build()
        )
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jst:meeting")
            .apply { setReferenceCounted(false); acquire(MAX_WAKE_MS) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getStringExtra(EXTRA_PHASE)?.let { phase = it }
        val started = intent?.getLongExtra(EXTRA_STARTED_AT, 0) ?: 0
        // Keep one stable start time so the timer does not jump on every phase change.
        if (started > 0 && kotlin.math.abs(started - startedAt) > 3000) startedAt = started
        try {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } catch (_: RuntimeException) {
            // No microphone permission, or started while in the background.
            stopSelf()
            return START_NOT_STICKY
        }
        refreshFloating()
        return START_NOT_STICKY
    }

    private fun refreshFloating() = floating.refresh(!appVisible, phase, startedAt)

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_mic)
        .setColor(ContextCompat.getColor(this, R.color.brand_blue))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(pendingApp(Intent.ACTION_MAIN, 0))
        .apply {
            when (phase) {
                "recording" -> setContentTitle("会议录音中")
                    .setContentText("锁屏或切到其他 App 也会继续录音")
                    .setWhen(startedAt)
                    .setShowWhen(true)
                    .setUsesChronometer(true)
                    .addAction(0, "结束会议", pendingApp(MainActivity.ACTION_END_MEETING, 1))

                "paused" -> setContentTitle("收音已暂停")
                    .setContentText("点这里回到会议，会自动接着录")

                else -> setContentTitle("正在保存会议")
                    .setContentText("请保持网络连接，保存完会自动关闭")
            }
        }
        .build()

    private fun appIntent(action: String) = Intent(this, MainActivity::class.java)
        .setAction(action)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .apply { if (action == MainActivity.ACTION_END_MEETING) putExtra(MainActivity.EXTRA_END_TOKEN, MainActivity.END_TOKEN) }

    private fun pendingApp(action: String, requestCode: Int): PendingIntent = PendingIntent.getActivity(
        this, requestCode, appIntent(action),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    override fun onDestroy() {
        instance = null
        floating.refresh(false, phase, startedAt)
        if (wakeLock.isHeld) wakeLock.release()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
