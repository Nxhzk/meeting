package com.jieshitong.meeting

import android.net.Uri

/** The app ships no sign-in screen, credentials, or web assets. */
object MeetingPage {
    val HOME = BuildConfig.MEETING_URL
    private val home = Uri.parse(HOME)
    val ORIGIN = "${home.scheme}://${home.host}" + if (home.port == -1) "" else ":${home.port}"
    private val basePath = home.path.orEmpty().trimEnd('/')
    const val BRIDGE_NAME = "JstApp"

    private fun effectivePort(uri: Uri) = if (uri.port != -1) uri.port else if (uri.scheme == "https") 443 else 80

    fun isOrigin(uri: Uri?) = uri != null && uri.scheme == home.scheme && uri.host == home.host &&
        effectivePort(uri) == effectivePort(home) && uri.encodedUserInfo == null

    /** Keep unrelated same-domain apps out of the meeting WebView too. */
    fun isPage(uri: Uri?): Boolean {
        if (uri == null || !isOrigin(uri)) return false
        val path = uri.path ?: "/"
        return path == basePath || path.startsWith("$basePath/")
    }

    val ACTIVE_PHASES = setOf("recording", "paused", "saving", "retry")
    val TRANSIENT_PHASES = setOf("opening", "restoring")
    val PHASES = ACTIVE_PHASES + TRANSIENT_PHASES + setOf("idle", "remote", "recover", "other")

    // Keep the web protocol compatible with APK 1.0 and the pre-React page.
    // React may mount after onPageFinished; watch for the control if necessary.
    const val BRIDGE_JS = """(function(){
        if (window.__jstApp || window.__jstWaiting) return;
        function connect(){
            var c = document.getElementById('meeting-control');
            if (!c) return false;
            window.__jstApp = 1;
            var last = '';
            function send(){
                var p = c.dataset.phase || 'idle';
                if (p === last) return;
                last = p;
                var k = document.getElementById('meeting-clock');
                try { JstApp.postMessage(p + '|' + (k ? k.textContent : '') + (window.__jstNativeActive ? '|n' : '')); } catch (e) {}
            }
            new MutationObserver(send).observe(c, { attributes: true, attributeFilter: ['data-phase'] });
            send();
            return true;
        }
        if (connect()) return;
        var root = document.getElementById('root');
        if (!root) return;
        window.__jstWaiting = new MutationObserver(function(){
            if (connect()) { window.__jstWaiting.disconnect(); delete window.__jstWaiting; }
        });
        window.__jstWaiting.observe(root, { childList: true, subtree: true });
    })();"""

    /** 页面加载前注入：这个 App 支持原生录音（协议版本 1）。 */
    const val NATIVE_FLAG_JS = "window.__jstNativeRecorder = 1;"

    const val END_JS = """(function(){
        var c = document.getElementById('meeting-control');
        var action = document.getElementById('meeting-action');
        if (!c || !action || c.dataset.phase !== 'recording') return false;
        action.click();
        return true;
    })();"""

    fun parseClock(clock: String): Long {
        val parts = clock.trim().split(":")
        if (parts.size !in 2..3 || parts.any { !it.matches(Regex("[0-9]{1,2}")) }) return 0
        return parts.fold(0L) { seconds, part -> seconds * 60 + part.toLong() }.coerceAtMost(3600) * 1000
    }

    fun offlineHtml(): String = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
        body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
          background:#f8f7f3;color:#26231e;font:16px/1.6 -apple-system,"PingFang SC",sans-serif;padding:0 24px}
        main{max-width:320px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#6b665c}
        a{display:inline-block;padding:10px 24px;border-radius:8px;background:#1e4e9c;color:#fff;text-decoration:none}
        </style></head><body><main><h1>暂时连不上会议服务</h1>
        <p>请检查网络后重试。上次未保存的录音可在联网后尝试恢复。</p>
        <a href="${android.text.TextUtils.htmlEncode(HOME)}">重新连接</a></main></body></html>"""
}
