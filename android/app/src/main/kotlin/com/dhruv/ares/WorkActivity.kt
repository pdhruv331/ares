package com.dhruv.ares

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.OpenableColumns
import android.speech.RecognizerIntent
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import java.io.ByteArrayInputStream
import kotlin.concurrent.thread
import kotlin.math.max

/**
 * Work: the Mac's background jobs. A native list (live, from JobStore) with a box to start a new one, and
 * each job's result in a WebView of the Mac's own mobile renderer. The WebView only ever shows pages from
 * the Mac (over Tailscale, with this phone's pairing key); web links open in the browser, and there's no
 * bridge from the page into the app.
 */
class WorkActivity : Activity() {
    companion object {
        fun intent(c: Context, job: String? = null, gallery: Boolean = false): Intent =
            Intent(c, WorkActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("job", job).putExtra("gallery", gallery)

        private const val PICK_FILES = 1
        private const val DICTATE = 2
        private const val MAX_BYTES = 30_000_000
    }

    private lateinit var web: WebView
    private lateinit var list: LinearLayout
    private lateinit var newText: EditText
    private lateinit var filesView: TextView
    private val client by lazy { AresClient(this) }
    private var picked = listOf<AresClient.Upload>()
    private val dp by lazy { resources.displayMetrics.density }
    private val refresh = { render() }
    private val base get() = Ares.url(this).trimEnd('/')

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Ares.paired(this)) { startActivity(Intent(this, MainActivity::class.java)); finish(); return }
        setContentView(R.layout.activity_work)
        findViewById<View>(R.id.root).setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            WindowInsets.CONSUMED
        }
        list = findViewById(R.id.jobs)
        newText = findViewById(R.id.newText)
        filesView = findViewById(R.id.files)
        web = findViewById(R.id.web)
        setUpWeb()
        findViewById<View>(R.id.back).setOnClickListener { finish() }
        findViewById<View>(R.id.gallery).setOnClickListener { showWeb("$base/?work=gallery&app=1") }
        findViewById<View>(R.id.more).setOnClickListener { showWeb("$base/?work=routines&app=1") }
        findViewById<View>(R.id.attach).setOnClickListener {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), PICK_FILES)
        }
        findViewById<View>(R.id.mic).setOnClickListener {
            runCatching {
                startActivityForResult(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_PROMPT, "What's the job?"), DICTATE)
            }.onFailure { Toast.makeText(this, "No speech recogniser on this phone.", Toast.LENGTH_SHORT).show() }
        }
        findViewById<View>(R.id.start).setOnClickListener { startJob() }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(i: Intent?) {
        i?.getStringExtra("job")?.let { return openJob(it) }
        if (i?.getBooleanExtra("gallery", false) == true) showWeb("$base/?work=gallery&app=1")
    }

    override fun onResume() {
        super.onResume()
        JobStore.listen(refresh)
        JobStore.onShow = { id -> openJob(id) }
        render()
        AresService.start(this)
        thread { runCatching { JobStore.replaceAll(this, client.jobs()) } } // fresh from the Mac
    }

    override fun onPause() {
        JobStore.unlisten(refresh)
        JobStore.onShow = null
        super.onPause()
    }

    // In a job, Back steps back inside it (a preview, a full-screen app…) until the page hands back to the list
    private val backInJob = OnBackInvokedCallback { web.evaluateJavascript("window.Work ? Work.back() : (location.hash = 'closed')", null) }
    private var backHooked = false
    private fun hookBack(on: Boolean) {
        if (on == backHooked) return
        backHooked = on
        if (on) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backInJob)
        else onBackInvokedDispatcher.unregisterOnBackInvokedCallback(backInJob)
    }

    // ---- The list ------------------------------------------------------------------------------------

    private val STATUS = mapOf("queued" to "QUEUED", "running" to "WORKING", "approval" to "NEEDS YOUR OK", "done" to "DONE", "failed" to "FAILED", "cancelled" to "CANCELLED")
    private fun color(status: String) = when (status) {
        "approval" -> 0xFFFFB547.toInt(); "done" -> 0xFF4ADE80.toInt(); "failed", "cancelled" -> 0xFFF87171.toInt(); else -> 0xFFA78BFA.toInt()
    }

    private fun render() {
        val jobs = JobStore.list()
        list.removeAllViews()
        if (jobs.isEmpty()) {
            list.addView(TextView(this).apply {
                text = "No jobs yet. Type one above, say \"do this as a job\" to ARES, or share something to ARES and tap JOB."
                setTextColor(getColor(R.color.muted)); textSize = 12f; setPadding(4, (16 * dp).toInt(), 4, 0)
            })
            return
        }
        for (j in jobs) list.addView(row(j))
    }

    private fun row(j: JobStore.Job): View {
        val when_ = android.text.format.DateUtils.getRelativeTimeSpanString(j.created, System.currentTimeMillis(), android.text.format.DateUtils.MINUTE_IN_MILLIS)
        val meta = when (j.status) {
            "approval" -> "NEEDS YOUR OK: ${j.approvalWhat ?: ""}"
            "running" -> "WORKING · ${j.steps} steps · $when_"
            else -> "${STATUS[j.status] ?: j.status.uppercase()} · $when_"
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = getDrawable(R.drawable.bg_input)
            setPadding((12 * dp).toInt(), (11 * dp).toInt(), (12 * dp).toInt(), (11 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = (6 * dp).toInt() }
            addView(View(context).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color(j.status)) }
                layoutParams = LinearLayout.LayoutParams((9 * dp).toInt(), (9 * dp).toInt()).apply { marginEnd = (12 * dp).toInt() }
                alpha = if (j.dismissed) 0.5f else 1f
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                addView(TextView(context).apply {
                    text = j.title; textSize = 14f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                    setTextColor(getColor(R.color.text)); typeface = android.graphics.Typeface.create("sans-serif", if (!j.seen && !j.active) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
                })
                addView(TextView(context).apply {
                    text = meta; textSize = 10f; maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END
                    setTextColor(if (j.status == "approval") getColor(R.color.amber) else getColor(R.color.muted))
                })
            })
            setOnClickListener { openJob(j.id) }
        }
    }

    // ---- A new job -------------------------------------------------------------------------------------

    private fun startJob() {
        val text = newText.text.toString().trim()
        if (text.isEmpty()) { newText.requestFocus(); return }
        val start = findViewById<TextView>(R.id.start)
        start.isEnabled = false
        filesView.text = "Sending to your Mac…"
        val files = picked
        thread {
            val result = runCatching { client.startJob(text, files) }
            runOnUiThread {
                start.isEnabled = true
                result.onSuccess { job ->
                    newText.setText("")
                    picked = emptyList()
                    filesView.text = ""
                    JobStore.update(this, job)
                    openJob(job.optString("id"))
                }.onFailure { filesView.text = it.message ?: "Couldn't reach your Mac." }
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) return
        if (requestCode == DICTATE) {
            val said = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: return
            newText.setText(listOf(newText.text.toString().trim(), said).filter { it.isNotBlank() }.joinToString(" "))
            newText.setSelection(newText.text.length)
        }
        if (requestCode == PICK_FILES) {
            val uris = data.clipData?.let { c -> (0 until c.itemCount).map { c.getItemAt(it).uri } } ?: listOfNotNull(data.data)
            filesView.text = "Reading…"
            thread {
                val files = Uploads.read(this, uris.take(5))
                runOnUiThread {
                    picked = files
                    filesView.text = if (files.isEmpty()) "Couldn't read those files." else "📎 " + files.joinToString(", ") { it.name }
                }
            }
        }
    }

    // ---- One job, rendered by the Mac --------------------------------------------------------------------

    private fun openJob(id: String) = showWeb("$base/?job=${Uri.encode(id)}&app=1")

    private fun showWeb(url: String) {
        CookieManager.getInstance().setCookie(base, "ares_token=${Ares.token(this)}; Path=/; HttpOnly" + if (base.startsWith("https://")) "; Secure" else "")
        newText.clearFocus() // no keyboard over the result
        getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(newText.windowToken, 0)
        web.visibility = View.VISIBLE
        hookBack(true)
        web.loadUrl(url)
    }

    private fun hideWeb() {
        web.visibility = View.GONE
        hookBack(false)
        web.loadUrl("about:blank")
        render()
    }

    private fun sameOrigin(u: Uri): Boolean {
        val b = Uri.parse(base)
        return u.scheme == b.scheme && u.host == b.host && u.port == b.port
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWeb() {
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true) // test builds only
        web.setBackgroundColor(getColor(R.color.bg))
        web.settings.apply {
            javaScriptEnabled = true // the renderer (charts, diagrams) needs it; there is no bridge into the app
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            // Only the Mac's own pages load here; web links go to the browser; nothing else goes anywhere
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (sameOrigin(req.url)) return false
                if (req.isForMainFrame) Ares.open(this@WorkActivity, req.url.toString())
                return true
            }
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                if (sameOrigin(req.url) || req.url.scheme == "about") return null
                return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
            // The page's Back / close hands the screen back to the list
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (url?.endsWith("#closed") == true) hideWeb()
            }
        }
        web.setDownloadListener { url, _, disposition, mime, _ ->
            val u = Uri.parse(url)
            if (!sameOrigin(u)) return@setDownloadListener
            val name = URLUtil.guessFileName(url, disposition, mime)
            runCatching {
                getSystemService(DownloadManager::class.java).enqueue(DownloadManager.Request(u)
                    .addRequestHeader("Cookie", "ares_token=${Ares.token(this)}")
                    .setTitle(name).setMimeType(mime)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name))
                Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
            }.onFailure { Toast.makeText(this, "Couldn't download it: ${it.message}", Toast.LENGTH_SHORT).show() }
        }
    }
}

/** Files picked or shared on the phone, read for sending to the Mac with a job. */
object Uploads {
    private const val MAX_BYTES = 30_000_000

    fun read(c: Context, uris: List<Uri>): List<AresClient.Upload> {
        var total = 0L
        return uris.mapNotNull { uri ->
            runCatching {
                val name = c.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "file"
                val bytes = c.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                if (total + bytes.size > MAX_BYTES) return@runCatching null
                total += bytes.size
                AresClient.Upload(name, c.contentResolver.getType(uri) ?: "application/octet-stream", Base64.encodeToString(bytes, Base64.NO_WRAP))
            }.getOrNull()
        }
    }

    /** The first web link in some shared text, if any. */
    fun link(text: String?): String? = text?.let { Regex("https?://\\S+").find(it)?.value }
}
