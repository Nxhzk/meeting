package com.jieshitong.meeting

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.util.Log
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebSettings
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.hjq.permissions.OnPermissionCallback
import com.hjq.permissions.Permission
import com.hjq.permissions.XXPermissions
import com.jieshitong.meeting.databinding.ActivityMainBinding

/**
 * Hosts the meeting page in a WebView. The page records with MediaRecorder
 * as it does in a browser; [RecordingService] keeps that recording alive in
 * the background and shows the notification and floating window.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        const val ACTION_END_MEETING = "com.jieshitong.meeting.END_MEETING"
        /** 点小助理通知：打开小助理页面。 */
        const val ACTION_OPEN_ASSISTANT = "com.jieshitong.meeting.OPEN_ASSISTANT"
        /** App 是否在前台（后台拉取小助理消息时用；进程被系统拉起时默认 false）。 */
        @Volatile var inForeground = false
        const val EXTRA_END_TOKEN = "endToken"

        /**
         * This activity is exported (it is the launcher), so any app could
         * send it ACTION_END_MEETING. Only our own notification knows this
         * per-process random token, so only it can end a meeting.
         */
        val END_TOKEN: String = java.util.UUID.randomUUID().toString()
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var web: WebView
    private lateinit var setup: SetupSheet
    private var phase = "idle"
    private var pendingEnd = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        web = binding.web
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.updatePadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        configureWebView(web)
        applySystemBars()
        ContextCompat.registerReceiver(this, recorderStatus, IntentFilter(NativeRecordingService.ACTION_STATUS), ContextCompat.RECEIVER_NOT_EXPORTED)
        CompanionWorker.schedule(this)
        setup = SetupSheet(this)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 先问网页：开着面板、菜单、拉出的删除按钮时，返回键只关它（录音中也可以关）；
                // 网页说没有可关的，才做页面后退或退到后台。旧版网页没有 __jstBack，按原来的逻辑走。
                web.evaluateJavascript("(window.__jstBack && window.__jstBack()) ? 1 : 0") { handled ->
                    if (handled == "1") return@evaluateJavascript
                    if (!recordingBusy() && web.canGoBack()) web.goBack()
                    else moveTaskToBack(true) // Never close the page mid-meeting.
                }
            }
        })

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(MeetingPage.HOME)
        }
        handleIntent(intent)
    }

    /** 状态栏、手势条区域与网页底色一致，并随系统深浅色切换（uiMode 变化不重建 Activity）。 */
    private fun applySystemBars() {
        val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val color = if (dark) 0xFF000000.toInt() else 0xFFF2F2F7.toInt()
        binding.root.setBackgroundColor(color)
        web.setBackgroundColor(color)
        window.decorView.setBackgroundColor(color)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBars()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(web: WebView) {
        // Debug builds only: lets Chrome DevTools inspect the page.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        web.settings.apply {
            // The meeting page never needs the phone's files.
            allowFileAccess = false
            allowContentAccess = false
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT // Honor no-store HTML and hashed assets.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString JstMeetingApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }
        // 告诉页面：这个 App 能原生录音（页面加载前注入，页面模块初始化时就能看到）
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, MeetingPage.NATIVE_FLAG_JS, setOf(MeetingPage.ORIGIN))
        }
        // Only the meeting origin in the main frame may control recording UI.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, MeetingPage.BRIDGE_NAME, setOf(MeetingPage.ORIGIN)) { view, message, origin, isMainFrame, _ ->
                if (!isMainFrame || !MeetingPage.isOrigin(origin) || !MeetingPage.isPage(view.url?.let(Uri::parse))) return@addWebMessageListener
                val data = message.data ?: return@addWebMessageListener
                if (data.startsWith("{")) return@addWebMessageListener onRecorderCommand(data)
                val parts = data.split('|', limit = 3)
                if (parts[0] in MeetingPage.PHASES) onPhase(parts[0], parts.getOrElse(1) { "" }, native = parts.getOrNull(2) == "n")
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (MeetingPage.isPage(uri)) return false
                // Avoid opening custom intent:// or file:// URLs from the web.
                if (request.isForMainFrame && uri.scheme in setOf("https", "http")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: ActivityNotFoundException) { }
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!MeetingPage.isPage(url?.let(Uri::parse))) return
                view.evaluateJavascript(MeetingPage.BRIDGE_JS, null)
                if (pendingEnd && phase == "recording") endFromNotification()
                queryRecorder()
            }

            /**
             * 网页渲染进程被系统回收或崩溃：默认会连带整个 App 一起退出。
             * 这里接住它，重建 WebView 重新打开会议页。原生录音在服务进程里，不受影响；
             * 网页录音的会议回来后会从手机上和服务器上找回已录的部分。
             */
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w("MainActivity", "WebView renderer gone (crash=${detail.didCrash()}), rebuilding")
                if (view !== web) return true
                rebuildWebView()
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && MeetingPage.isPage(request.url)) showConnectionError(view)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 500 && MeetingPage.isPage(request.url)) showConnectionError(view)
            }

            private fun showConnectionError(view: WebView) {
                view.loadDataWithBaseURL(null, MeetingPage.offlineHtml(), "text/html", "utf-8", null)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { answerPermission(request) }
            }
        }
    }

    /** The page asks for the microphone: grant it once Android has granted the app. */
    private fun answerPermission(request: PermissionRequest) {
        val audio = PermissionRequest.RESOURCE_AUDIO_CAPTURE
        if (!MeetingPage.isOrigin(request.origin) || !MeetingPage.isPage(web.url?.let(Uri::parse)) || audio !in request.resources) {
            request.deny()
            return
        }
        XXPermissions.with(this)
            .permission(Permission.RECORD_AUDIO)
            .request(object : OnPermissionCallback {
                override fun onGranted(permissions: MutableList<String>, allGranted: Boolean) {
                    if (allGranted && MeetingPage.isPage(web.url?.let(Uri::parse))) request.grant(arrayOf(audio)) else request.deny()
                }

                override fun onDenied(permissions: MutableList<String>, doNotAskAgain: Boolean) {
                    request.deny()
                    if (doNotAskAgain) setup.explainMicrophoneBlocked()
                }
            })
    }

    private fun rebuildWebView() {
        val old = web
        val parent = old.parent as ViewGroup
        val index = parent.indexOfChild(old)
        parent.removeView(old)
        old.destroy()
        val fresh = WebView(this)
        fresh.id = old.id
        parent.addView(fresh, index, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        web = fresh
        configureWebView(fresh)
        applySystemBars()
        phase = "idle"
        fresh.loadUrl(MeetingPage.HOME)
    }

    // ---------------------------------------------------------------- 原生录音
    private fun recorderFile() = java.io.File(filesDir, "recorder/state.json")

    /** 服务进程里有会议（录音中、待上传、待确认）时，向它要一次最新状态。 */
    private fun queryRecorder() {
        if (recorderFile().exists()) NativeRecordingService.send(this, NativeRecordingService.ACTION_QUERY)
        else deliverToPage(org.json.JSONObject().put("type", "status").put("state", "idle").toString())
    }

    private val recorderStatus = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            intent.getStringExtra(NativeRecordingService.EXTRA_JSON)?.let(::deliverToPage)
        }
    }

    private fun deliverToPage(json: String) {
        if (!MeetingPage.isPage(web.url?.let(Uri::parse))) return
        web.evaluateJavascript("window.__jstRecorder&&window.__jstRecorder($json)", null)
    }

    private fun cookie() = CookieManager.getInstance().getCookie(MeetingPage.HOME).orEmpty()

    /** 页面发来的录音命令（JSON）。 */
    private fun onRecorderCommand(data: String) {
        val command = try { org.json.JSONObject(data) } catch (_: Exception) { return }
        when (command.optString("cmd")) {
            "rec.start" -> withMicrophone(
                granted = {
                    val base = command.optString("base")
                    if (!MeetingPage.isPage(Uri.parse(base))) return@withMicrophone
                    NativeRecordingService.send(this, NativeRecordingService.ACTION_START, foreground = true) {
                        putExtra("session", command.optString("session"))
                        putExtra("base", base)
                        putExtra("cookie", cookie())
                        putExtra("csrf", command.optString("csrf"))
                        putExtra("startedAt", command.optLong("startedAt"))
                        putExtra("endsAt", command.optLong("endsAt"))
                        putExtra("nextIndex", command.optInt("nextIndex", 1))
                    }
                },
                denied = { deliverToPage(org.json.JSONObject().put("type", "error").put("error", "permission").toString()) },
            )
            "rec.resume" -> withMicrophone(
                granted = {
                    NativeRecordingService.send(this, NativeRecordingService.ACTION_RESUME, foreground = true) {
                        putExtra("cookie", cookie()); putExtra("csrf", command.optString("csrf"))
                    }
                },
                denied = { deliverToPage(org.json.JSONObject().put("type", "error").put("error", "permission").toString()) },
            )
            "rec.stop" -> NativeRecordingService.send(this, NativeRecordingService.ACTION_STOP)
            "rec.auth" -> if (recorderFile().exists()) NativeRecordingService.send(this, NativeRecordingService.ACTION_AUTH) {
                putExtra("cookie", cookie()); putExtra("csrf", command.optString("csrf"))
            }
            "rec.ack" -> NativeRecordingService.send(this, NativeRecordingService.ACTION_ACK) { putExtra("session", command.optString("session")) }
            "rec.status" -> queryRecorder()
        }
    }

    private fun withMicrophone(granted: () -> Unit, denied: () -> Unit) {
        XXPermissions.with(this)
            .permission(Permission.RECORD_AUDIO)
            .request(object : OnPermissionCallback {
                override fun onGranted(permissions: MutableList<String>, allGranted: Boolean) = if (allGranted) granted() else denied()
                override fun onDenied(permissions: MutableList<String>, doNotAskAgain: Boolean) {
                    denied()
                    if (doNotAskAgain) setup.explainMicrophoneBlocked()
                }
            })
    }

    private fun recordingBusy() = phase in MeetingPage.ACTIVE_PHASES || phase == "opening"

    private fun endFromNotification() {
        if (!MeetingPage.isPage(web.url?.let(Uri::parse))) return
        pendingEnd = false
        web.evaluateJavascript(MeetingPage.END_JS, null)
    }

    /** Called from the page whenever the meeting control changes phase. */
    private fun onPhase(newPhase: String, clock: String, native: Boolean) {
        phase = newPhase
        // 原生录音：录音、通知、悬浮窗都由 NativeRecordingService 管，页面的阶段变化不需要通知旧服务
        if (native) return
        if (pendingEnd && newPhase == "recording") endFromNotification()
        when (newPhase) {
            in MeetingPage.ACTIVE_PHASES ->
                RecordingService.update(this, newPhase, System.currentTimeMillis() - MeetingPage.parseClock(clock))
            in MeetingPage.TRANSIENT_PHASES -> Unit
            else -> RecordingService.stop(this)
        }
    }

    private fun handleIntent(intent: Intent?) {
        if (BuildConfig.DEBUG && intent?.action == "com.jieshitong.meeting.DEBUG_POLL") {
            intent.action = Intent.ACTION_MAIN
            CompanionWorker.runSoon(this)
            return
        }
        if (intent?.action == ACTION_OPEN_ASSISTANT) {
            intent.action = Intent.ACTION_MAIN
            if (!recordingBusy()) web.loadUrl(MeetingPage.HOME.trimEnd('/') + "/#assistant")
            return
        }
        if (intent?.action != ACTION_END_MEETING) return
        intent.action = Intent.ACTION_MAIN
        val token = intent.getStringExtra(EXTRA_END_TOKEN)
        intent.removeExtra(EXTRA_END_TOKEN)
        if (token != END_TOKEN) return // Not from our notification.
        if (phase == "recording") endFromNotification()
        else if (phase in MeetingPage.TRANSIENT_PHASES) pendingEnd = true
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        inForeground = true
        RecordingService.setAppVisible(true)
        if (recorderFile().exists()) NativeRecordingService.send(this, NativeRecordingService.ACTION_APP_VISIBLE) { putExtra("visible", true) }
    }

    override fun onResume() {
        super.onResume()
        // The WebView is deliberately never paused: pausing it would stop
        // the recording when the screen locks.
        setup.showIfNeeded()
    }

    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
        RecordingService.setAppVisible(false)
        if (recorderFile().exists()) NativeRecordingService.send(this, NativeRecordingService.ACTION_APP_VISIBLE) { putExtra("visible", false) }
        inForeground = false
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        // 网页录音：界面真的关掉时停掉旧服务；原生录音在自己的进程里继续
        RecordingService.setAppVisible(false)
        if (isFinishing) RecordingService.stop(this)
        try { unregisterReceiver(recorderStatus) } catch (_: IllegalArgumentException) { }
        web.destroy()
        super.onDestroy()
    }
}
