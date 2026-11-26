package com.jieshitong.meeting

import android.content.Context
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.max
import kotlin.math.min

/**
 * 原生会议录音：在独立进程的前台服务里录音、切片、上传、收尾。
 *
 * 为什么不用网页录音：WebView 跟着界面走——界面被划掉（Android 15 会连进程一起杀）、
 * 网页渲染进程被系统回收时，网页录音就停了。这里的录音只依赖前台服务：
 *
 * - MediaRecorder 录 AAC（ADTS 格式，每一帧自带帧头，可以直接拼接），
 *   每 5 秒按完整帧切出一段，存成文件（chunk-N.aac），再按顺序上传；
 * - 麦克风出错或文件长时间不长，自动重开（新的一段直接接在后面，服务器拼起来仍是合法音频）；
 * - 通话、别的 App 占用麦克风时系统会把我们静音：实时检测，告诉网页和通知栏，并记下空白时长；
 * - 断网时分段留在手机上，网络恢复立即续传；进程重启后从状态文件接着来；
 * - 结束后自己完成保存（finalize），不依赖网页是否还开着。
 *
 * 所有状态变更都在 [handler] 线程里进行；上传在单独的线程里，只读写分段文件和少量原子字段。
 */
class NativeRecorder(private val context: Context, private val onStatus: (JSONObject) -> Unit) {
    companion object {
        private const val TAG = "NativeRecorder"
        const val MIME = "audio/aac"
        private const val CHUNK_MS = 5_000L
        private const val STALL_MS = 15_000L          // 文件这么久没长：认为录音卡住了，重开
        private val REOPEN_DELAYS = longArrayOf(800, 1_500, 3_000, 5_000, 10_000)
        private const val LEVEL_MS = 250L
        private const val SAMPLE_RATE = 32_000
        private const val BIT_RATE = 48_000
        private const val MAX_BATCH = 24              // 积压时一次最多传 24 段（2 分钟录音，约 700KB）
        private const val CONTINUE_MIN_CHUNKS = 6     // 服务器那边已关、手机上还剩这么多（30 秒）以上：另存一条
    }

    // ---------------------------------------------------------------- 持久化的状态
    private data class RecState(
        val session: String,
        val base: String,            // 会议服务地址，以 / 结尾
        var cookie: String,
        var csrf: String,
        val startedAt: Long,
        val endsAt: Long,
        var nextIndex: Int,          // 下一段的编号
        var ended: Boolean = false,  // 用户结束（或到点、服务器已关闭）
        var automatic: Boolean = false,
        var interrupted: Boolean = false,
        var gapMs: Long = 0,
        var recordingId: Long? = null,
        var finished: Boolean = false,
        var failure: String? = null,
        // 手机上的分段编号（chunk-N）和服务器上的编号分开记：积压时几段合成一次上传
        var remote: String = session,  // 服务器上的会议编号（续存时换成新的）
        var serverNext: Int = 0,       // 服务器期待的下一段编号；0 = 不知道，先问服务器
        var serverBytes: Long = -1,    // 服务器已收到的字节数；-1 = 不知道
        var firstRecordingId: Long? = null, // 续存时：前半段已经保存成的会议
    ) {
        fun toJson() = JSONObject().apply {
            put("session", session); put("base", base); put("cookie", cookie); put("csrf", csrf)
            put("startedAt", startedAt); put("endsAt", endsAt); put("nextIndex", nextIndex)
            put("ended", ended); put("automatic", automatic); put("interrupted", interrupted); put("gapMs", gapMs)
            recordingId?.let { put("recordingId", it) }
            put("finished", finished); failure?.let { put("failure", it) }
            put("remote", remote); put("serverNext", serverNext); put("serverBytes", serverBytes)
            firstRecordingId?.let { put("firstRecordingId", it) }
        }

        companion object {
            fun from(json: JSONObject) = RecState(
                json.getString("session"), json.getString("base"), json.optString("cookie"), json.optString("csrf"),
                json.getLong("startedAt"), json.getLong("endsAt"), json.getInt("nextIndex"),
                json.optBoolean("ended"), json.optBoolean("automatic"), json.optBoolean("interrupted"),
                json.optLong("gapMs"), if (json.has("recordingId")) json.getLong("recordingId") else null,
                json.optBoolean("finished"), json.optString("failure").ifEmpty { null },
                json.optString("remote").ifEmpty { json.getString("session") },
                json.optInt("serverNext", 0), json.optLong("serverBytes", -1),
                if (json.has("firstRecordingId")) json.getLong("firstRecordingId") else null,
            )
        }
    }

    private val root = File(context.filesDir, "recorder").apply { mkdirs() }
    private val stateFile = File(root, "state.json")
    private val thread = HandlerThread("meeting-recorder").apply { start() }
    private val handler = Handler(thread.looper)
    private val audio = context.getSystemService(AudioManager::class.java)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    private var state: RecState? = null
    private var media: MediaRecorder? = null
    private var segment: File? = null
    private var segmentOffset = 0L
    private var lastGrowth = 0L
    private var reopenTries = 0
    private var phase = "idle"              // recording | paused | saving | done | failed | idle
    private var pauseReason: String? = null // mic | permission
    private var silenced = false
    private var silencedReason: String? = null
    private var silencedSince = 0L
    private var lastLevelAt = 0L
    private var notice: String? = null

    @Volatile private var uploaded = 0      // 已确认上传的最大编号
    @Volatile private var uploadProblem: String? = null
    private val uploader = Uploader()

    /** 有没有原生录音的会议（包括已完成、等界面确认的）：有的话网页录音模式的命令不起作用。 */
    val active: Boolean get() = state != null

    init {
        // 进程被系统重启：接着上传已录下的分段；录音本身等用户回到会议再继续（后台不能重新打开麦克风）。
        // 同步读取：服务要马上知道有没有进行中的会议，决定要不要进入前台。
        loadState()?.let { saved ->
            state = saved
            uploaded = saved.nextIndex - 1 - pendingChunks().size
            if (!saved.finished) {
                phase = if (saved.ended) "saving" else "paused"
                if (!saved.ended) {
                    pauseReason = "restart"
                    saved.interrupted = true
                    // 中断从服务最后一次存状态（每 5 秒一次）的时间算起，比「现在」更接近真实
                    if (silencedSince == 0L) silencedSince = stateFile.lastModified().takeIf { it > 0 }?.coerceAtMost(System.currentTimeMillis())
                        ?: System.currentTimeMillis()
                    saveState()
                }
            } else {
                phase = if (saved.recordingId != null) "done" else "failed"
                // 已经完成、界面却一直没来确认（比如结束时界面被划掉了）：保留 3 天供页面核对，之后清掉
                if (System.currentTimeMillis() - stateFile.lastModified() > 3L * 24 * 3600 * 1000) {
                    stateFile.delete()
                    dir(saved.session).deleteRecursively()
                    state = null
                    phase = "idle"
                }
            }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            audio.registerAudioRecordingCallback(object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    handler.post { checkSilenced() }
                }
            }, handler)
        }
        connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = uploader.wake()
        })
        uploader.start()
        if (state != null) handler.post { publish() }
    }

    /** 有没有需要服务待在前台的会议（录音中、暂停、保存中）。 */
    val busy: Boolean get() = state?.let { !it.finished } ?: false

    // ---------------------------------------------------------------- 命令（来自前台服务）

    /** 开始（或接着）录一个会议。同一个会议再调一次 = 接着录。 */
    fun start(session: String, base: String, cookie: String, csrf: String, startedAt: Long, endsAt: Long, nextIndex: Int) =
        handler.post {
            val current = state
            if (current != null && current.session == session && !current.finished) {
                current.cookie = cookie.ifEmpty { current.cookie }
                current.csrf = csrf.ifEmpty { current.csrf }
                if (current.ended) return@post publish()
                saveState()
                if (media == null) openSegment(resumed = true)
                return@post publish()
            }
            if (current != null && !current.finished) {
                // 还有一个没收尾的会议：先结束它（不会丢已录的分段），再开新的
                Log.w(TAG, "Starting ${session.take(8)} while ${current.session.take(8)} is unfinished")
                endInternal(automatic = false)
            } else if (current != null) {
                dir(current.session).deleteRecursively()
            }
            dir(session).mkdirs()
            state = RecState(session, base, cookie, csrf, startedAt, endsAt, max(1, nextIndex)).apply {
                if (nextIndex <= 1) { serverNext = 1; serverBytes = 0 }
            }
            uploaded = max(1, nextIndex) - 1
            uploadProblem = null
            notice = null
            reopenTries = 0
            saveState()
            openSegment(resumed = nextIndex > 1)
            uploader.wake()
            publish()
        }

    /** 用户结束会议：停止录音，把剩下的传完，然后保存。 */
    fun stop(automatic: Boolean = false) = handler.post { endInternal(automatic) }

    /** 暂停后手动「继续录音」。 */
    fun resume(cookie: String?, csrf: String?) = handler.post {
        val s = state ?: return@post publish()
        if (s.finished || s.ended) return@post publish()
        cookie?.takeIf { it.isNotEmpty() }?.let { s.cookie = it }
        csrf?.takeIf { it.isNotEmpty() }?.let { s.csrf = it }
        reopenTries = 0
        if (media == null) openSegment(resumed = true)
        publish()
    }

    fun refreshAuth(cookie: String?, csrf: String?) = handler.post {
        val s = state ?: return@post
        cookie?.takeIf { it.isNotEmpty() }?.let { s.cookie = it }
        csrf?.takeIf { it.isNotEmpty() }?.let { s.csrf = it }
        saveState()
        uploader.wake()
    }

    fun requestStatus() = handler.post { publish() }

    /** 页面已经知道结果：清掉已完成的会议。 */
    fun acknowledge(session: String) = handler.post {
        val s = state ?: return@post
        if (s.session == session && s.finished) {
            state = null
            stateFile.delete()
            dir(session).deleteRecursively()
            phase = "idle"
            publish()
        }
    }

    // ---------------------------------------------------------------- 录音
    private fun dir(session: String) = File(root, session)

    private fun openSegment(resumed: Boolean) {
        val s = state ?: return
        if (s.ended) return
        if (System.currentTimeMillis() >= s.endsAt) return endInternal(automatic = true)
        val file = File(dir(s.session), "seg-${SystemClock.elapsedRealtime()}.aac")
        val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioChannels(1)
            recorder.setAudioSamplingRate(SAMPLE_RATE)
            recorder.setAudioEncodingBitRate(BIT_RATE)
            recorder.setOutputFile(file.path)
            recorder.setOnErrorListener { r, what, extra -> handler.post { if (media === r) segmentFailed("error $what/$extra") } }
            recorder.prepare()
            recorder.start()
        } catch (e: Exception) {
            Log.w(TAG, "MediaRecorder could not start", e)
            try { recorder.release() } catch (_: Exception) { }
            file.delete()
            val denied = e is SecurityException
            pauseReason = if (denied) "permission" else "mic"
            if (phase != "paused") markGapStart()
            phase = "paused"
            notice = if (denied) "没有麦克风权限，请在系统设置里允许后点「继续录音」。" else "麦克风暂时不能使用，正在重试…"
            if (!denied) scheduleReopen()
            publish()
            return
        }
        media = recorder
        segment = file
        segmentOffset = 0
        lastGrowth = SystemClock.elapsedRealtime()
        notice = null
        if (phase == "paused" || resumed) closeGap()
        phase = "recording"
        pauseReason = null
        reopenTries = 0
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, CHUNK_MS)
        handler.removeCallbacks(level)
        handler.post(level)
        checkSilenced()
        publish()
    }

    private val tick = object : Runnable {
        override fun run() {
            val s = state ?: return
            if (media == null) return
            if (System.currentTimeMillis() >= s.endsAt) return endInternal(automatic = true)
            cut(final = false)
            // 文件长时间不长（个别手机的录音会无声无息地停掉）：重开
            if (SystemClock.elapsedRealtime() - lastGrowth > STALL_MS && !silenced) segmentFailed("stalled")
            else handler.postDelayed(this, CHUNK_MS)
        }
    }

    private val level = object : Runnable {
        override fun run() {
            val recorder = media ?: return
            val amplitude = try { recorder.maxAmplitude } catch (_: Exception) { 0 }
            val now = SystemClock.elapsedRealtime()
            if (now - lastLevelAt >= LEVEL_MS) {
                lastLevelAt = now
                onStatus(JSONObject().put("type", "level").put("session", state?.session)
                    .put("level", min(1.0, Math.sqrt(amplitude / 32767.0) * 1.4)))
            }
            handler.postDelayed(this, LEVEL_MS)
        }
    }

    /** 把录音文件里新写入的完整帧切成一段。 */
    private fun cut(final: Boolean) {
        val s = state ?: return
        val file = segment ?: return
        val length = file.length()
        if (length <= segmentOffset) return
        lastGrowth = SystemClock.elapsedRealtime()
        val bytes = try {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(segmentOffset)
                ByteArray((length - segmentOffset).coerceAtMost(8L * 1024 * 1024).toInt()).also { raf.readFully(it) }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Could not read segment", e)
            return
        }
        val (from, to) = AdtsFrames.range(bytes)
        if (to <= from) {
            // 很长一段都找不到合法的帧：丢掉这部分，从文件末尾重新开始找，免得一直卡在这里
            if (AdtsFrames.hopeless(bytes)) segmentOffset += bytes.size - 64 * 1024
            return
        }
        val usable = to
        val index = s.nextIndex
        val part = File(dir(s.session), "chunk-$index.part")
        try {
            part.writeBytes(if (from == 0 && usable == bytes.size) bytes else bytes.copyOfRange(from, usable))
            if (!part.renameTo(File(dir(s.session), "chunk-$index.aac"))) throw IOException("rename failed")
        } catch (e: IOException) {
            Log.w(TAG, "Could not write chunk $index", e)
            part.delete()
            notice = "手机存储空间不足，录音可能保存不全。"
            return publish()
        }
        segmentOffset += usable
        s.nextIndex = index + 1
        saveState()
        uploader.wake()
        if (final) publish()
    }

    private fun closeRecorder() {
        handler.removeCallbacks(tick)
        handler.removeCallbacks(level)
        val recorder = media ?: return
        media = null
        try { recorder.stop() } catch (_: Exception) { /* 没录到数据时 stop 会抛异常 */ }
        try { recorder.release() } catch (_: Exception) { }
        cut(final = true)
        segment?.delete()
        segment = null
    }

    private fun segmentFailed(why: String) {
        Log.w(TAG, "Recording segment failed: $why")
        val s = state ?: return
        closeRecorder()
        if (s.ended) return
        markGapStart()
        phase = "paused"
        pauseReason = "mic"
        notice = "麦克风被打断了，正在自动接着录…"
        publish()
        scheduleReopen()
    }

    private fun scheduleReopen() {
        val delay = REOPEN_DELAYS[min(reopenTries, REOPEN_DELAYS.size - 1)]
        reopenTries += 1
        handler.removeCallbacks(reopen)
        handler.postDelayed(reopen, delay)
    }

    private val reopen = Runnable {
        val s = state
        if (s != null && !s.ended && media == null && pauseReason in setOf("mic", "restart")) openSegment(resumed = true)
    }

    private fun markGapStart() {
        if (silencedSince == 0L) silencedSince = System.currentTimeMillis()
        state?.interrupted = true
    }

    private fun closeGap() {
        if (silencedSince > 0) {
            val gap = System.currentTimeMillis() - silencedSince
            state?.let { it.gapMs += gap; saveState() }
            if (gap >= 2_000) {
                val text = "已接着录音，中间约 ${seconds(gap)}没录到。"
                notice = text
                // 一次性的提示：20 秒后自己消失，不要一直挂在录音界面上
                handler.postDelayed({ if (notice == text) { notice = null; publish() } }, 20_000)
            }
            silencedSince = 0
        }
    }

    /** 系统是否把我们静音了（通话、别的 App 在录音）。 */
    private fun checkSilenced() {
        val recorder = media ?: return
        if (Build.VERSION.SDK_INT < 29) return
        val config = try { recorder.activeRecordingConfiguration } catch (_: Exception) { null } ?: return
        val now = config.isClientSilenced
        if (now == silenced) return
        silenced = now
        if (now) {
            silencedReason = when (audio.mode) {
                AudioManager.MODE_IN_CALL, AudioManager.MODE_RINGTONE -> "call"
                AudioManager.MODE_IN_COMMUNICATION -> "voip"
                else -> if (Build.VERSION.SDK_INT >= 30 && audio.mode == AudioManager.MODE_CALL_SCREENING) "call" else "other"
            }
            markGapStart()
            notice = when (silencedReason) {
                "call" -> "正在通话，暂时录不到会议的声音。挂断后会自动接着录。"
                "voip" -> "正在语音/视频通话，暂时录不到会议的声音。结束后会自动接着录。"
                else -> "麦克风被其他应用占用，暂时录不到声音。关掉那个应用后会自动接着录。"
            }
        } else {
            silencedReason = null
            notice = null
            closeGap()
            lastGrowth = SystemClock.elapsedRealtime()
        }
        saveState()
        publish()
    }

    private fun endInternal(automatic: Boolean) {
        val s = state ?: return publish()
        if (s.finished) return publish()
        handler.removeCallbacks(reopen)
        if (!s.ended) {
            s.ended = true
            s.automatic = s.automatic || automatic
        }
        closeRecorder()
        if (silencedSince > 0) closeGap()
        silenced = false
        phase = "saving"
        notice = null
        saveState()
        uploader.wake()
        publish()
    }

    // ---------------------------------------------------------------- 状态
    private fun pendingChunks(session: String? = state?.session): List<Pair<Int, File>> {
        val folder = session?.let(::dir) ?: return emptyList()
        return folder.listFiles { f -> f.name.startsWith("chunk-") && f.name.endsWith(".aac") }.orEmpty()
            .mapNotNull { f -> f.name.removePrefix("chunk-").removeSuffix(".aac").toIntOrNull()?.let { it to f } }
            .sortedBy { it.first }
    }

    @Synchronized
    private fun saveState() {
        val s = state ?: return
        try {
            val tmp = File(root, "state.json.tmp")
            tmp.writeText(s.toJson().toString())
            tmp.renameTo(stateFile)
        } catch (e: IOException) {
            Log.w(TAG, "Could not save recorder state", e)
        }
    }

    private fun loadState(): RecState? = try {
        if (stateFile.exists()) RecState.from(JSONObject(stateFile.readText())) else null
    } catch (e: Exception) {
        Log.w(TAG, "Recorder state unreadable", e)
        null
    }

    private fun seconds(ms: Long): String {
        val total = max(1, Math.round(ms / 1000.0)).toLong()
        return if (total < 60) "$total 秒" else "${total / 60} 分${if (total % 60 > 0) " ${total % 60} 秒" else "钟"}"
    }

    /** 当前状态（给网页、通知栏、悬浮窗）。 */
    fun snapshot(): JSONObject {
        val s = state
        return JSONObject().apply {
            put("type", "status")
            put("state", if (s == null) "idle" else phase)
            if (s != null) {
                put("session", s.session); put("startedAt", s.startedAt); put("endsAt", s.endsAt)
                put("ended", s.ended); put("automatic", s.automatic); put("interrupted", s.interrupted)
                put("gapMs", s.gapMs + if (silencedSince > 0) System.currentTimeMillis() - silencedSince else 0)
                put("chunks", s.nextIndex - 1); put("uploaded", uploaded); put("pending", pendingChunks().size)
                s.recordingId?.let { put("recordingId", it) }
                s.failure?.let { put("failure", it) }
            }
            put("silenced", silenced); silencedReason?.let { put("silencedReason", it) }
            pauseReason?.let { put("pauseReason", it) }
            (uploadProblem ?: notice)?.let { put("notice", it) }
        }
    }

    private fun publish() {
        try { onStatus(snapshot()) } catch (e: Exception) { Log.w(TAG, "Status listener failed", e) }
    }

    // ---------------------------------------------------------------- 上传与收尾
    private inner class Uploader : Runnable {
        private val lock = Object()
        private var woken = false
        private var failures = 0

        fun start() = Thread(this, "meeting-uploader").apply { isDaemon = true }.start()

        fun wake() = synchronized(lock) { woken = true; lock.notifyAll() }

        private fun sleep(ms: Long) = synchronized(lock) {
            if (!woken) lock.wait(ms)
            woken = false
        }

        override fun run() {
            while (true) {
                val s = state
                val next = s?.let { pendingChunks(it.session) }.orEmpty()
                try {
                    when {
                        s == null || s.finished -> sleep(60_000)
                        s.serverNext <= 0 || s.serverBytes < 0 -> reconcile(s)
                        next.isNotEmpty() -> upload(s, next)
                        s.ended && media == null -> finalize(s)
                        else -> sleep(30_000)
                    }
                    if (uploadProblem != null) {
                        uploadProblem = null
                        handler.post { publish() }
                    }
                    failures = 0
                } catch (e: StopUploading) {
                    sleep(60_000)
                } catch (e: Exception) {
                    failures += 1
                    // 没收到回复：服务器可能已经收下了这一批。下次先问清楚，再决定传什么
                    if (s != null && !(e is HttpError && e.code in setOf(401, 403))) s.serverBytes = -1
                    batch = max(1, batch / 2)
                    val login = e is HttpError && (e.code == 401 || e.code == 403)
                    val problem = if (login) "登录已失效。录音都保存在手机上，重新登录后会自动上传。"
                    else "网络不稳，录音保存在手机上，联网后会自动上传。"
                    if (problem != uploadProblem) {
                        uploadProblem = problem
                        handler.post { publish() }
                    }
                    Log.w(TAG, "Upload failed (${failures}): ${e.message}")
                    sleep(if (login) 15_000 else min(15_000L, 1_000L shl min(failures - 1, 4)))
                }
            }
        }

        /** 一次传几段：网络好时逐渐加大（积压能很快追上），失败就减半。 */
        private var batch = 4

        private fun upload(s: RecState, pending: List<Pair<Int, File>>) {
            // 只取编号连续的一串（正常总是连续的）
            val picked = ArrayList<Pair<Int, File>>()
            for (item in pending) {
                if (picked.size >= batch || (picked.isNotEmpty() && item.first != picked.last().first + 1)) break
                picked += item
            }
            val bytes = java.io.ByteArrayOutputStream().apply { picked.forEach { write(it.second.readBytes()) } }.toByteArray()
            val index = s.serverNext
            val (code, body) = request(s, "POST", "upload/session/${s.remote}/chunks/$index", bytes, "application/octet-stream")
            when {
                code in 200..299 -> {
                    acked(s, picked, index + 1, s.serverBytes + bytes.size)
                    batch = min(MAX_BATCH, batch * 2)
                }
                code == 409 && body.optBoolean("meeting_closed") -> closed(s, body)
                code == 409 && body.has("expected_chunk_index") -> reconcile(s)
                else -> throw HttpError(code, body.optString("error"))
            }
        }

        private fun acked(s: RecState, files: List<Pair<Int, File>>, serverNext: Int, serverBytes: Long) {
            files.forEach { it.second.delete() }
            files.lastOrNull()?.let { uploaded = max(uploaded, it.first) }
            s.serverNext = serverNext
            s.serverBytes = serverBytes
            saveState()
            handler.post { if (state === s && (s.ended || phase != "recording")) publish() }
        }

        /**
         * 和服务器对一下账：它收到了几段、多少字节。上一批「发出去但没收到回复」时，
         * 按字节数认出它收下的是哪几段，删掉，接着传后面的——不重复、不漏。
         */
        private fun reconcile(s: RecState) {
            val (code, status) = request(s, "GET", "upload/session/${s.remote}", null, null)
            if (code == 404) return finished(s, s.firstRecordingId, "这场会议已不在服务器上。")
            if (code !in 200..299) throw HttpError(code, status.optString("error"))
            if (status.optString("status") != "recording") return closed(s, status)
            val count = status.optInt("chunk_count")
            val bytes = status.optLong("bytes_received")
            val pending = pendingChunks(s.session)
            if (s.serverNext > 0 && count >= s.serverNext) {
                // 服务器比我们以为的多收了：找出总字节数正好对得上的前几段
                var sum = 0L
                var taken = 0
                if (s.serverBytes >= 0) {
                    val extra = bytes - s.serverBytes
                    while (taken < pending.size && sum < extra) { sum += pending[taken].second.length(); taken++ }
                    if (sum != extra) taken = -1
                } else taken = -1
                if (taken < 0) {
                    // 对不上（老版本留下的状态等）：按一段对一段处理
                    taken = min(pending.size, count - s.serverNext + 1)
                    Log.w(TAG, "Reconcile by count: server has $count, expected ${s.serverNext - 1}")
                }
                acked(s, pending.take(taken), count + 1, bytes)
            } else {
                if (s.serverNext > 0 && count < s.serverNext - 1) {
                    Log.w(TAG, "Server has fewer chunks ($count) than acknowledged (${s.serverNext - 1})")
                    handler.post { s.interrupted = true }
                }
                s.serverNext = count + 1
                s.serverBytes = bytes
                saveState()
            }
        }

        /** 服务器不再收这场会议（被别处结束、到了最长时长、或已删除）。 */
        private fun closed(s: RecState, body: JSONObject) {
            val status = body.optString("status")
            val leftover = pendingChunks(s.session)
            Log.w(TAG, "Server closed meeting ${s.remote.take(8)}: $status, ${leftover.size} chunks left on the phone")
            handler.post {
                s.automatic = s.automatic || body.optBoolean("meeting_limit_reached")
                if (!s.ended) endInternal(automatic = body.optBoolean("meeting_limit_reached"))
            }
            if (status in setOf("finalizing", "finalized") && leftover.size >= CONTINUE_MIN_CHUNKS) {
                // 手机上还有没传上去的录音：不丢，另开一场接着存（会议列表里会多一条「续」）
                val (_, old) = request(s, "GET", "upload/session/${s.remote}", null, null)
                val (code, created) = request(s, "POST", "upload/session",
                    """{"mime_type":"$MIME","meeting_mode":true}""".toByteArray(), "application/json")
                val id = created.optString("session_id")
                if (code !in 200..299 || id.isEmpty()) throw HttpError(code, created.optString("error"))
                if (s.firstRecordingId == null && old.optLong("finalized_recording_id", -1) > 0)
                    s.firstRecordingId = old.getLong("finalized_recording_id")
                s.remote = id
                s.serverNext = 1
                s.serverBytes = 0
                handler.post { s.interrupted = true }
                saveState()
                Log.w(TAG, "Continuing ${leftover.size} chunks in ${id.take(8)}")
                return
            }
            // 会议被删除/放弃，或只剩零头：服务器上已有的照样保存，手机上的丢弃
            if (leftover.isNotEmpty()) handler.post { s.interrupted = true }
            for ((_, f) in leftover) f.delete()
            if (status in setOf("finalizing", "finalized")) {
                val (_, old) = request(s, "GET", "upload/session/${s.remote}", null, null)
                val id = old.optLong("finalized_recording_id", -1)
                return finished(s, s.firstRecordingId ?: id.takeIf { it > 0 }, null)
            }
            if (s.firstRecordingId != null) return finished(s, s.firstRecordingId, null)
            return finished(s, null, "这场会议已经结束，没有可保存的录音。")
        }

        private fun finalize(s: RecState) {
            if (s.serverNext <= 1 && pendingChunks(s.session).isEmpty()) {
                if (s.firstRecordingId != null) return finished(s, s.firstRecordingId, null)
                // 一段都没有：结束服务器上的会议，没有可保存的录音
                request(s, "POST", "api/meetings/live/${s.remote}/end", "{}".toByteArray(), "application/json")
                return finished(s, null, "没有收到会议声音，请重新开始会议。")
            }
            val (code, body) = request(s, "POST", "upload/session/${s.remote}/finalize",
                """{"meeting_mode":true}""".toByteArray(), "application/json")
            // 续存的会议：界面打开前半段那条（两条都在会议列表里）
            if (code in 200..299 && body.has("recording_id")) return finished(s, s.firstRecordingId ?: body.getLong("recording_id"), null)
            if (code == 409) {
                val (_, status) = request(s, "GET", "upload/session/${s.remote}", null, null)
                val id = status.optLong("finalized_recording_id", -1)
                if (id > 0 && status.optString("status") in setOf("finalized", "failed")) return finished(s, s.firstRecordingId ?: id, null)
                if (status.optString("status") in setOf("aborted", "expired"))
                    return finished(s, s.firstRecordingId, if (s.firstRecordingId == null) "这场会议已经结束，没有可保存的录音。" else null)
            }
            if (code == 404) return finished(s, s.firstRecordingId, if (s.firstRecordingId == null) "这场会议已不在服务器上。" else null)
            throw HttpError(code, body.optString("error"))
        }

        private fun finished(s: RecState, recordingId: Long?, failure: String?) {
            handler.post {
                s.recordingId = recordingId
                s.failure = failure
                s.finished = true
                phase = if (recordingId != null) "done" else "failed"
                saveState()
                for ((_, f) in pendingChunks(s.session)) f.delete()
                publish()
            }
            throw StopUploading()
        }
    }

    private class StopUploading : RuntimeException()
    private class HttpError(val code: Int, message: String) : IOException("HTTP $code $message")

    /** 带登录 Cookie 和 CSRF 的请求。返回 (状态码, JSON)。网络错误抛 IOException。 */
    private fun request(s: RecState, method: String, path: String, body: ByteArray?, type: String?): Pair<Int, JSONObject> {
        val first = send(s, method, path, body, type)
        // CSRF 令牌过期（一场会议加上保存可能超过一小时）：换一个新的再试一次，和网页的做法一样
        if (first.first == 400 && first.second.optBoolean("csrf_retryable") && path != "api/csrf-token") {
            val (code, json) = send(s, "GET", "api/csrf-token", null, null)
            val token = json.optString("csrf_token")
            if (code == 200 && token.isNotEmpty()) {
                s.csrf = token
                saveState()
                return send(s, method, path, body, type)
            }
        }
        return first
    }

    /** 服务器刷新了会话 Cookie（滚动有效期、闲置计时）：跟浏览器一样收下，下一次请求带新的。 */
    private fun mergeCookies(s: RecState, headers: List<String>?) {
        if (headers.isNullOrEmpty()) return
        val jar = LinkedHashMap<String, String>()
        s.cookie.split(';').map { it.trim() }.filter { '=' in it }.forEach { jar[it.substringBefore('=')] = it.substringAfter('=') }
        var changed = false
        for (header in headers) {
            val pair = header.substringBefore(';').trim()
            if ('=' !in pair) continue
            val name = pair.substringBefore('=')
            val value = pair.substringAfter('=')
            val expired = header.contains("Max-Age=0", ignoreCase = true) || value.isEmpty()
            if (expired) { if (jar.remove(name) != null) changed = true; continue }
            if (jar[name] != value) { jar[name] = value; changed = true }
        }
        if (changed) {
            s.cookie = jar.entries.joinToString("; ") { "${it.key}=${it.value}" }
            saveState()
        }
    }

    private fun send(s: RecState, method: String, path: String, body: ByteArray?, type: String?): Pair<Int, JSONObject> {
        val connection = URL(s.base + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cookie", s.cookie)
            connection.setRequestProperty("Referer", s.base) // HTTPS 下 CSRF 校验要求同源 Referer
            if (method != "GET") connection.setRequestProperty("X-CSRFToken", s.csrf)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", type ?: "application/octet-stream")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val code = connection.responseCode
            mergeCookies(s, connection.headerFields["Set-Cookie"])
            if (code in 300..399) return 401 to JSONObject() // 被重定向到登录页
            val text = (if (code >= 400) connection.errorStream else connection.inputStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            // 读完回复后不断开：连接留着给下一次用，省掉每次重新握手（信号差时握手最慢）
            return code to json
        } catch (e: IOException) {
            connection.disconnect()
            throw e
        }
    }
}
