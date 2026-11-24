package com.jieshitong.meeting

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.PermissionRequest
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
import androidx.core.view.ViewCompat
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
        const val EXTRA_END_TOKEN = "endToken"

        /**
         * This activity is exported (it is the launcher), so any app could
         * send it ACTION_END_MEETING. Only our own notification knows this
         * per-process random token, so only it can end a meeting.
         */
        val END_TOKEN: String = java.util.UUID.randomUUID().toString()
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var setup: SetupSheet
    private var phase = "idle"
    private var pendingEnd = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.updatePadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        configureWebView(binding.web)
        setup = SetupSheet(this)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!recordingBusy() && binding.web.canGoBack()) binding.web.goBack()
                else moveTaskToBack(true) // Never close the page mid-meeting.
            }
        })

        if (savedInstanceState == null || binding.web.restoreState(savedInstanceState) == null) {
            binding.web.loadUrl(MeetingPage.HOME)
        }
        handleIntent(intent)
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
        // Only the meeting origin in the main frame may control recording UI.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, MeetingPage.BRIDGE_NAME, setOf(MeetingPage.ORIGIN)) { view, message, origin, isMainFrame, _ ->
                if (!isMainFrame || !MeetingPage.isOrigin(origin) || !MeetingPage.isPage(view.url?.let(Uri::parse))) return@addWebMessageListener
                val parts = message.data?.split('|', limit = 2) ?: return@addWebMessageListener
                if (parts[0] in MeetingPage.PHASES) onPhase(parts[0], parts.getOrElse(1) { "" })
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
        if (!MeetingPage.isOrigin(request.origin) || !MeetingPage.isPage(binding.web.url?.let(Uri::parse)) || audio !in request.resources) {
            request.deny()
            return
        }
        XXPermissions.with(this)
            .permission(Permission.RECORD_AUDIO)
            .request(object : OnPermissionCallback {
                override fun onGranted(permissions: MutableList<String>, allGranted: Boolean) {
                    if (allGranted && MeetingPage.isPage(binding.web.url?.let(Uri::parse))) request.grant(arrayOf(audio)) else request.deny()
                }

                override fun onDenied(permissions: MutableList<String>, doNotAskAgain: Boolean) {
                    request.deny()
                    if (doNotAskAgain) setup.explainMicrophoneBlocked()
                }
            })
    }

    private fun recordingBusy() = phase in MeetingPage.ACTIVE_PHASES || phase == "opening"

    private fun endFromNotification() {
        if (!MeetingPage.isPage(binding.web.url?.let(Uri::parse))) return
        pendingEnd = false
        binding.web.evaluateJavascript(MeetingPage.END_JS, null)
    }

    /** Called from the page whenever the meeting control changes phase. */
    private fun onPhase(newPhase: String, clock: String) {
        phase = newPhase
        if (pendingEnd && newPhase == "recording") endFromNotification()
        when (newPhase) {
            in MeetingPage.ACTIVE_PHASES ->
                RecordingService.update(this, newPhase, System.currentTimeMillis() - MeetingPage.parseClock(clock))
            in MeetingPage.TRANSIENT_PHASES -> Unit
            else -> RecordingService.stop(this)
        }
    }

    private fun handleIntent(intent: Intent?) {
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
        RecordingService.setAppVisible(true)
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
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.web.saveState(outState)
    }

    override fun onDestroy() {
        RecordingService.setAppVisible(false)
        if (isFinishing) RecordingService.stop(this)
        binding.web.destroy()
        super.onDestroy()
    }
}
