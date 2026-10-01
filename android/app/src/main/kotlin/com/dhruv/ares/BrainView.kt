package com.dhruv.ares

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.provider.Settings
import android.util.AttributeSet
import android.view.Choreographer
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * ARES's 3D brain, the same one as on the Mac (renderer/brain3d.mjs, bundled into the app by Gradle), with
 * the job orbs around it. It runs offline from the app's own files, served at a private address that only
 * this view knows; nothing else loads. The app drives it; a tapped orb comes back as a navigation to
 * /open/<id> (no JavaScript bridge).
 */
@SuppressLint("SetJavaScriptEnabled")
class BrainView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : WebView(ctx, attrs) {
    companion object {
        private const val HOST = "brain.ares"
        private val TYPES = mapOf("html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript", "css" to "text/css")
    }

    var state = State.IDLE
        set(v) { field = v; send("ares.state(${JSONObject.quote(web(v))})") }
    var levelSource: () -> Float = { 0f }
    var onTap: () -> Unit = {}
    var onOrb: (String) -> Unit = {}
    private var loaded = false
    private var jobs = "[]"
    private var lastLevel = -1f

    init {
        setBackgroundColor(Color.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = OVER_SCROLL_NEVER
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            domStorageEnabled = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
        }
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse {
                val u = req.url
                val path = u.path?.trimStart('/') ?: ""
                if (u.host != HOST || path.split('/').any { it == ".." || it.isEmpty() }) return blocked()
                return runCatching {
                    val ext = path.substringAfterLast('.', "")
                    WebResourceResponse(TYPES[ext] ?: "application/octet-stream", "utf-8", context.assets.open("brain/$path"))
                }.getOrElse { blocked() }
            }
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.host == HOST) when {
                    u.path?.startsWith("/open/") == true -> u.lastPathSegment?.let { id -> post { onOrb(Uri.decode(id)) } }
                    u.path == "/tap" -> post { onTap() }
                }
                return true // it never navigates away from the brain
            }
            override fun onPageFinished(view: WebView, url: String) {
                loaded = true
                val reduce = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
                send("ares.motion($reduce)")
                send("ares.state(${JSONObject.quote(web(state))})")
                send("ares.jobs($jobs)")
            }
        }
        loadUrl("https://$HOST/index.html")
    }

    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    private fun web(s: State) = when (s) { State.LISTENING -> "listening"; State.THINKING -> "thinking"; State.SPEAKING -> "speaking"; else -> "idle" }
    private fun send(js: String) { if (loaded) evaluateJavascript(js, null) }

    /** Back from a job: any orb that flew out drifts home. */
    fun land() = send("ares.land()")

    /** The Mac's jobs, as orbs (the same data the Mac's brain gets). */
    fun jobs(list: JSONArray) {
        jobs = list.toString()
        send("ares.jobs($jobs)")
    }

    // Her voice (or yours) moves the brain: sent about 30 times a second while it's changing
    private val tick = object : Choreographer.FrameCallback {
        var frame = 0
        override fun doFrame(t: Long) {
            if (!isAttachedToWindow) return
            if (frame++ % 2 == 0) {
                val v = if (state == State.SPEAKING || state == State.LISTENING) levelSource() else 0f
                if (kotlin.math.abs(v - lastLevel) > 0.01f) { lastLevel = v; send("ares.level($v)") }
            }
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        Choreographer.getInstance().postFrameCallback(tick)
    }

    override fun onDetachedFromWindow() {
        Choreographer.getInstance().removeFrameCallback(tick)
        super.onDetachedFromWindow()
    }
}
