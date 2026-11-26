package com.jieshitong.meeting

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * 原生会议录音的前台服务（类型：麦克风），运行在独立进程「:recorder」里。
 *
 * 录音、切片、上传、保存都在这里（见 [NativeRecorder]）：界面被划掉、网页渲染进程崩溃、
 * 整个主进程被系统回收，都不影响录音。网页录音（浏览器、旧版页面）仍由 [RecordingService]
 * 在主进程里负责保活，两者互不干扰。
 *
 * 和界面（主进程）之间只用 Intent 通信：界面发命令（ACTION_*），这里发广播（[ACTION_STATUS]）。
 */
class NativeRecordingService : Service() {
    companion object {
        private const val TAG = "RecordingService"
        private const val CHANNEL = "meeting"
        private const val ALERT_CHANNEL = "meeting-alert"
        private const val NOTIFICATION_ID = 1
        private const val MAX_WAKE_MS = 2 * 60 * 60 * 1000L

        const val ACTION_START = "com.jieshitong.meeting.recorder.START"
        const val ACTION_STOP = "com.jieshitong.meeting.recorder.STOP"
        const val ACTION_RESUME = "com.jieshitong.meeting.recorder.RESUME"
        const val ACTION_AUTH = "com.jieshitong.meeting.recorder.AUTH"
        const val ACTION_ACK = "com.jieshitong.meeting.recorder.ACK"
        const val ACTION_QUERY = "com.jieshitong.meeting.recorder.QUERY"
        const val ACTION_APP_VISIBLE = "com.jieshitong.meeting.recorder.APP_VISIBLE"
        /** 服务发出的状态广播（只发给本应用）。 */
        const val ACTION_STATUS = "com.jieshitong.meeting.recorder.STATUS"
        const val EXTRA_JSON = "json"

        fun send(context: Context, action: String, foreground: Boolean = false, build: Intent.() -> Unit = {}) {
            val intent = Intent(context, NativeRecordingService::class.java).setAction(action).apply(build)
            try {
                if (foreground) ContextCompat.startForegroundService(context, intent) else context.startService(intent)
            } catch (e: RuntimeException) {
                // Android 12+ 不允许从后台启动前台服务；服务没在运行时，后台的命令也没有意义
                Log.w(TAG, "Could not deliver $action: ${e.message}")
            }
        }
    }

    private var phase = "idle"              // 通知和悬浮窗显示的阶段：recording | paused | saving
    private var startedAt = System.currentTimeMillis()
    private var appVisible = true
    private var nativeStatus: JSONObject? = null
    private var foreground = false
    private lateinit var wakeLock: PowerManager.WakeLock
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeRenewedAt = 0L
    private lateinit var floating: FloatingWindow
    private lateinit var recorder: NativeRecorder
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
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
        wakeRenewedAt = SystemClock.elapsedRealtime()
        // 锁屏后 Wi-Fi 会进省电模式，上传变得很慢、经常超时：开会期间让它保持全速
        wifiLock = try {
            @Suppress("DEPRECATION")
            applicationContext.getSystemService(WifiManager::class.java)
                ?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "jst:meeting-upload")
                ?.apply { setReferenceCounted(false) }
        } catch (e: RuntimeException) { null }
        recorder = NativeRecorder(this) { status -> main.post { onRecorderStatus(status) } }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        // 开始录音、网页录音模式、有进行中的会议时要待在前台（startForegroundService 之后 5 秒内必须进入前台）
        val needsForeground = action in setOf(ACTION_START, ACTION_RESUME) || recorder.busy
        if (needsForeground && !ensureForeground()) {
            // 系统把录音进程杀了又在后台拉起来：安卓不允许后台重新打开麦克风，只能响铃提醒用户回来
            if (recorder.busy && action == null) notifyInterrupted()
            stopSelf()
            return START_NOT_STICKY
        }
        when (action) {
            ACTION_START -> recorder.start(
                intent!!.getStringExtra("session").orEmpty(), intent.getStringExtra("base").orEmpty(),
                intent.getStringExtra("cookie").orEmpty(), intent.getStringExtra("csrf").orEmpty(),
                intent.getLongExtra("startedAt", System.currentTimeMillis()),
                intent.getLongExtra("endsAt", System.currentTimeMillis() + 3_600_000),
                intent.getIntExtra("nextIndex", 1),
                // 新版页面不先建服务器会议，传空的 remote；旧版页面不传，沿用 session
                if (intent.hasExtra("remote")) intent.getStringExtra("remote").orEmpty() else null,
            )
            ACTION_STOP -> recorder.stop()
            ACTION_RESUME -> recorder.resume(intent!!.getStringExtra("cookie"), intent.getStringExtra("csrf"))
            ACTION_AUTH -> recorder.refreshAuth(intent!!.getStringExtra("cookie"), intent.getStringExtra("csrf"))
            ACTION_ACK -> recorder.acknowledge(intent!!.getStringExtra("session").orEmpty())
            ACTION_QUERY -> recorder.requestStatus()
            ACTION_APP_VISIBLE -> {
                appVisible = intent!!.getBooleanExtra("visible", true)
                refreshFloating()
                recorder.requestStatus()
            }
            null -> {
                // 系统重启了服务（START_STICKY）：录音进程被杀过。先试着自己接着录，不行就响铃叫人
                recorder.requestStatus()
                recorder.resumeAfterRestart { main.post { notifyInterrupted() } }
            }
        }
        // 只是来查询、确认的，又没有进行中的会议：查完就走，不挂通知
        if (!foreground && !recorder.busy) main.postDelayed({ if (!foreground && !recorder.busy) stopSelf() }, 3_000)
        // 开始/继续的命令是异步交给录音线程的，这里 busy 还没来得及变成 true，所以这两种命令一律要粘住：
        // 进程被系统杀掉后，系统会把服务重新拉起来，接着上传、提示用户回来继续录
        return if (action == ACTION_START || action == ACTION_RESUME || recorder.busy) START_STICKY else START_NOT_STICKY
    }

    private fun ensureForeground(): Boolean {
        if (foreground) return true
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            foreground = true
            true
        } catch (e: RuntimeException) {
            // 没有麦克风权限，或在后台被系统重启时不允许前台服务
            Log.w(TAG, "Could not enter the foreground: ${e.message}")
            false
        }
    }

    private fun onRecorderStatus(status: JSONObject) {
        // 状态转发给界面（音量只在界面可见时发，省电）
        if (status.optString("type") == "level" && !appVisible) return
        sendBroadcast(Intent(ACTION_STATUS).setPackage(packageName).putExtra(EXTRA_JSON, status.toString()))
        if (status.optString("type") != "status") return
        nativeStatus = status
        when (val state = status.optString("state")) {
            "recording", "paused", "saving" -> {
                keepAwake()
                phase = state
                startedAt = status.optLong("startedAt", startedAt)
                render()
            }
            "done", "failed" -> if (foreground) {
                // 界面开着时由它确认；界面不在时，留一条结果通知再退出
                try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: RuntimeException) { }
                if (!appVisible) notifyResult(status)
                main.postDelayed({ if (!recorder.busy) stopNow() }, 1_500)
            }
            "idle" -> if (foreground && !recorder.active) stopNow()
        }
    }

    /** 会议不限时长：唤醒锁每次只拿 2 小时（防止意外一直不放），开会期间隔一阵续一次。 */
    private fun keepAwake() {
        val now = SystemClock.elapsedRealtime()
        if (now - wakeRenewedAt > 10 * 60 * 1000L || !wakeLock.isHeld) {
            wakeLock.acquire(MAX_WAKE_MS)
            wakeRenewedAt = now
        }
        try { wifiLock?.takeIf { !it.isHeld }?.acquire() } catch (_: RuntimeException) { }
    }

    private fun render() {
        if (!foreground) return
        NotificationManagerCompat.from(this).let {
            try { it.notify(NOTIFICATION_ID, buildNotification()) } catch (_: SecurityException) { }
        }
        refreshFloating()
    }

    private fun refreshFloating() = floating.refresh(!appVisible, phase, startedAt)

    private fun stopNow() {
        floating.refresh(false, phase, startedAt)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground = false
        stopSelf()
    }

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_mic)
        .setColor(ContextCompat.getColor(this, R.color.brand_blue))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(pendingApp(Intent.ACTION_MAIN, 0))
        .apply {
            val status = nativeStatus
            val silenced = status?.optBoolean("silenced") == true
            val notice = status?.optString("notice").orEmpty()
            when (phase) {
                "recording" -> setContentTitle(if (silenced) "会议录音 · 暂时录不到声音" else "会议录音中")
                    .setContentText(if (silenced) notice else "锁屏、切到其他 App、划掉界面都会继续录音")
                    .setWhen(startedAt)
                    .setShowWhen(true)
                    .setUsesChronometer(true)
                    .addAction(0, "结束会议", if (recorder.active) pendingStop() else pendingApp(MainActivity.ACTION_END_MEETING, 1))

                "paused" -> setContentTitle("收音已暂停")
                    .setContentText(notice.ifEmpty { "点这里回到会议，会自动接着录" })

                else -> setContentTitle("正在保存会议")
                    .setContentText(notice.ifEmpty {
                        val pending = status?.optInt("pending") ?: 0
                        if (pending > 0) "还有 $pending 段录音在上传，请保持网络连接" else "请保持网络连接，保存完会自动关闭"
                    })
            }
        }
        .build()

    private fun notifyInterrupted() {
        NotificationManagerCompat.from(this).createNotificationChannel(
            NotificationChannelCompat.Builder(ALERT_CHANNEL, NotificationManagerCompat.IMPORTANCE_HIGH)
                .setName("录音中断提醒")
                .setDescription("会议录音被系统打断时提醒你回来继续")
                .build()
        )
        val notification = NotificationCompat.Builder(this, ALERT_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setColor(ContextCompat.getColor(this, R.color.brand_blue))
            .setContentTitle("会议录音被系统中断了")
            .setContentText("已录的部分都在手机上。点这里回到会议，会自动接着录。")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setContentIntent(pendingApp(Intent.ACTION_MAIN, 4))
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(this).notify(NOTIFICATION_ID + 2, notification) } catch (_: SecurityException) { }
    }

    private fun notifyResult(status: JSONObject) {
        val ok = status.optString("state") == "done"
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setColor(ContextCompat.getColor(this, R.color.brand_blue))
            .setContentTitle(if (ok) "会议已保存" else "会议没有保存")
            .setContentText(if (ok) "正在生成会议摘要，点这里查看" else status.optString("failure").ifEmpty { "没有可保存的录音" })
            .setContentIntent(pendingApp(Intent.ACTION_MAIN, 2))
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(this).notify(NOTIFICATION_ID + 1, notification) } catch (_: SecurityException) { }
    }

    private fun appIntent(action: String) = Intent(this, MainActivity::class.java)
        .setAction(action)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .apply { if (action == MainActivity.ACTION_END_MEETING) putExtra(MainActivity.EXTRA_END_TOKEN, MainActivity.END_TOKEN) }

    private fun pendingApp(action: String, requestCode: Int): PendingIntent = PendingIntent.getActivity(
        this, requestCode, appIntent(action),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** 原生录音：通知栏「结束会议」直接交给服务，不需要打开界面。 */
    private fun pendingStop(): PendingIntent = PendingIntent.getService(
        this, 3, Intent(this, NativeRecordingService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** 界面被划掉：服务在自己的进程里，录音照常继续。 */
    override fun onTaskRemoved(rootIntent: Intent?) {
        appVisible = false
        refreshFloating()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        floating.refresh(false, phase, startedAt)
        if (wakeLock.isHeld) wakeLock.release()
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: RuntimeException) { }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
