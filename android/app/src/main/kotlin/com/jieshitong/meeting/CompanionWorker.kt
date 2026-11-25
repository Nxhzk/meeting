package com.jieshitong.meeting

import android.Manifest
import android.app.ActivityManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.webkit.CookieManager
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * 小助理主动发的消息（提醒、今日简报）：App 不在前台时，后台约每 15 分钟拉一次，
 * 有新消息就弹系统通知。不依赖 Firebase 推送（国内大多数手机收不到）。
 *
 * 用 WebView 登录后的 Cookie 访问 /api/assistant/notifications；没登录时什么都不做。
 */
class CompanionWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (MainActivity.inForeground) return Result.success() // 前台时页面自己会显示
        nudgeUnsavedMeeting()
        val base = MeetingPage.HOME.trimEnd('/')
        val cookie = CookieManager.getInstance().getCookie(MeetingPage.HOME) ?: return Result.success()
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getLong(KEY_LAST, -1L)
        val body = try {
            val connection = (URL("$base/api/assistant/notifications?since=${maxOf(since, 0L)}").openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 15_000
                instanceFollowRedirects = false
                setRequestProperty("Cookie", cookie)
                setRequestProperty("Accept", "application/json")
            }
            try {
                if (connection.responseCode != 200) return Result.success()
                connection.inputStream.bufferedReader().use { it.readText() }
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            return Result.retry()
        }
        val json = JSONObject(body)
        val messages = json.optJSONArray("messages")
        var last = since
        if (since < 0) {
            // 第一次运行：只记下当前位置，不把历史消息全弹出来
            prefs.edit().putLong(KEY_LAST, json.optLong("latest_id", 0L)).apply()
            return Result.success()
        }
        if (messages != null) {
            for (i in 0 until messages.length()) {
                val message = messages.getJSONObject(i)
                val id = message.getLong("id")
                if (!message.optBoolean("read")) notify(id, message.optString("text"))
                last = maxOf(last, id)
            }
        }
        prefs.edit().putLong(KEY_LAST, last).apply()
        return Result.success()
    }

    /**
     * 手机上有一场会议没保存完（没电关机、录音进程被系统杀掉后用户一直没回来……），
     * 而录音进程已经不在了：提醒用户打开 App，录下的内容还在手机上，打开后会继续上传。
     * 每 3 小时最多提醒一次。
     */
    private fun nudgeUnsavedMeeting() {
        val context = applicationContext
        val file = File(context.filesDir, "recorder/state.json")
        if (!file.exists()) return
        val finished = try { JSONObject(file.readText()).optBoolean("finished") } catch (_: Exception) { return }
        if (finished) return
        val alive = context.getSystemService(ActivityManager::class.java).runningAppProcesses
            ?.any { it.processName.endsWith(":recorder") } == true
        android.util.Log.i("CompanionWorker", "unsaved meeting found, recorder alive=$alive")
        if (alive) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong(KEY_NUDGE, 0L) < 3 * 3600 * 1000L) return
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder("recording-recovery", NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName("会议录音未保存").setDescription("有会议录音还在手机上、没有保存完时提醒").build()
        )
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val notification = NotificationCompat.Builder(context, "recording-recovery")
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setContentTitle("有一场会议还没保存完")
            .setContentText("录音还在手机上，点这里打开，会自动继续保存。")
            .setContentIntent(PendingIntent.getActivity(context, 77, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .build()
        try {
            manager.notify(NOTIFY_BASE + 999, notification)
            prefs.edit().putLong(KEY_NUDGE, now).apply()
        } catch (_: SecurityException) { }
    }

    private fun notify(id: Long, text: String) {
        val context = applicationContext
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName("小助理").setDescription("提醒和今日简报").build()
        )
        val open = Intent(context, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_ASSISTANT
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(context, id.toInt(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setContentTitle("小助理")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .build()
        try {
            manager.notify(NOTIFY_BASE + (id % 1000).toInt(), notification)
        } catch (_: SecurityException) { }
    }

    companion object {
        private const val CHANNEL = "companion"
        private const val PREFS = "companion"
        private const val KEY_LAST = "last_message_id"
        private const val KEY_NUDGE = "unsaved_meeting_nudge_at"
        private const val NOTIFY_BASE = 5000
        private const val WORK = "companion-poll"

        /** 仅测试包：过几秒拉一次（周期任务不能被强制提前执行）。 */
        fun runSoon(context: Context, delaySeconds: Long = 10) {
            if (!BuildConfig.DEBUG) return
            WorkManager.getInstance(context).enqueue(
                OneTimeWorkRequestBuilder<CompanionWorker>().setInitialDelay(delaySeconds, TimeUnit.SECONDS).build()
            )
        }

        /** App 启动时登记；已登记过就保持原计划。 */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<CompanionWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
