package com.dhruv.ares

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.util.Base64
import android.view.View
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread
import kotlin.math.max

/**
 * The quick-ask panel that floats over whatever you're doing: opened from the bubble, the Quick
 * Settings tile, the widget, the notification, or "Share → ARES" from another app.
 */
class AskActivity : Activity(), Session.Ui {
    companion object {
        fun intent(c: Context, listen: Boolean = false, type: Boolean = false, ask: String? = null): Intent =
            Intent(c, AskActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("listen", listen).putExtra("type", type).putExtra("ask", ask)
    }

    private lateinit var session: Session
    private lateinit var reactor: ReactorView
    private lateinit var heard: TextView
    private lateinit var reply: TextView
    private lateinit var input: EditText
    private lateinit var mic: View
    private lateinit var actions: LinearLayout
    private lateinit var attachView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Ares.paired(this)) { startActivity(Intent(this, MainActivity::class.java)); finish(); return }
        setContentView(R.layout.activity_ask)
        findViewById<View>(R.id.root).apply {
            setOnClickListener { finish() } // tap outside the panel to dismiss
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
                WindowInsets.CONSUMED
            }
        }
        findViewById<View>(R.id.panel).setOnClickListener { }
        session = Session(this, this)
        reactor = findViewById(R.id.reactor)
        reactor.levelSource = { session.level }
        reactor.setOnClickListener { session.hush() }
        heard = findViewById(R.id.heard)
        reply = findViewById(R.id.reply)
        reply.movementMethod = ScrollingMovementMethod()
        input = findViewById(R.id.input)
        mic = findViewById(R.id.mic)
        actions = findViewById(R.id.actions)
        attachView = findViewById(R.id.attach)
        mic.setOnClickListener { if (needMic()) session.toggleListening() }
        findViewById<View>(R.id.send).setOnClickListener { send() }
        findViewById<View>(R.id.job).setOnClickListener { makeJob() }
        session.jobStarter = { said, extra -> startJob(said, extra) }
        input.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_SEND) { send(); true } else false }
        findViewById<View>(R.id.expand).setOnClickListener {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
        }
        attachView.setOnClickListener { session.attachment = null; session.provider = null; attached() } // ✕: don't send it
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(i: Intent) {
        when (i.action) {
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> return receiveShare(i)
            Intent.ACTION_ASSIST, Intent.ACTION_VOICE_COMMAND -> { if (needMic()) session.startListening(); return }
        }
        if (i.getBooleanExtra("assist", false)) watchScreen()
        i.getStringExtra("ask")?.let { heard.text = it; heard.visibility = View.VISIBLE; session.ask(it, voice = false); return }
        if (i.getBooleanExtra("type", false)) return showKeyboard()
        if (i.getBooleanExtra("listen", false) && needMic()) session.startListening()
    }

    /** Summoned as the assistant: your screen goes with the next question unless you tap ✕. */
    private fun watchScreen() {
        session.provider = { ScreenContext.take() }
        ScreenContext.onChange = {
            if (session.provider == null) Unit
            else if (!ScreenContext.available) attachView.visibility = View.GONE
            else {
                attachView.visibility = View.VISIBLE
                attachView.text = "📱 Your screen${ScreenContext.app?.let { " ($it)" } ?: ""} is attached  ✕"
            }
        }
        ScreenContext.onChange?.invoke()
    }

    override fun attached() {
        attachView.visibility = View.GONE
        input.hint = getString(R.string.type_hint)
    }

    override fun onDestroy() {
        ScreenContext.onChange = null
        if (::session.isInitialized) session.release()
        super.onDestroy()
    }

    private fun send() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        input.setText("")
        heard.text = text
        heard.visibility = View.VISIBLE
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(input.windowToken, 0)
        session.ask(text, voice = false)
    }

    private fun showKeyboard() {
        input.requestFocus()
        input.post { getSystemService(InputMethodManager::class.java).showSoftInput(input, 0) }
    }

    // ---- Make it a job: a worker on the Mac does it in the background, with what's shared or on screen ----

    /** The JOB button: what's typed (or was just said), plus anything shared or your screen. */
    private fun makeJob() {
        val typed = input.text.toString().trim()
        val extra = session.attachment ?: session.provider?.invoke()
        val said = typed.ifEmpty { if (extra != null) "Read this and give me the key points." else "" }
        if (said.isEmpty()) { input.hint = "What's the job? Type it, then tap JOB."; showKeyboard(); return }
        input.setText("")
        session.attachment = null
        session.provider = null
        attached()
        startJob(said, extra)
    }

    private fun startJob(said: String, extra: Session.Attachment?) {
        heard.text = said
        heard.visibility = View.VISIBLE
        reply.visibility = View.VISIBLE
        reply.text = "Handing it to your Mac…"
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(input.windowToken, 0)
        val files = extra?.let { a -> a.files.ifEmpty { a.images.mapIndexed { i, (type, data) -> AresClient.Upload(if (a.images.size > 1) "screen-${i + 1}.jpg" else "screen.jpg", type, data) } } }.orEmpty()
        // The note (what was on screen, or what was shared) goes with the brief; the worker treats it as data
        val note = extra?.note?.lines()?.filterNot { it.startsWith("(They also shared") }?.joinToString("\n")?.trim().orEmpty() // that line is for the chat
        val text = if (note.isNotBlank()) "$said\n\n$note" else said
        thread {
            val r = runCatching { AresClient(this).startJob(text, files, extra?.link) }
            runOnUiThread {
                r.onSuccess { job ->
                    JobStore.update(this, job)
                    reply.text = "On it: “${job.optString("title")}”. I'll let you know when it's ready."
                    val card = layoutInflater.inflate(R.layout.item_action, actions, false) as TextView
                    card.text = "↗  Open in Work"
                    card.setOnClickListener { startActivity(WorkActivity.intent(this, job.optString("id"))); finish() }
                    actions.addView(card)
                }.onFailure { reply.text = "I couldn't start that job: ${it.message ?: "your Mac didn't answer"}." }
            }
        }
    }

    override fun state(s: State) {
        reactor.state = s
        mic.isActivated = s == State.LISTENING
        if (s == State.LISTENING) { reply.text = ""; actions.removeAllViews(); heard.text = "Listening…"; heard.visibility = View.VISIBLE }
        if (s == State.THINKING && reply.text.isEmpty()) reply.text = "…"
    }

    override fun heard(text: String, final: Boolean) {
        heard.text = text
        heard.visibility = View.VISIBLE
    }

    override fun reply(text: String, final: Boolean) {
        reply.visibility = View.VISIBLE
        reply.text = text
    }

    override fun action(url: String, label: String) {
        val card = layoutInflater.inflate(R.layout.item_action, actions, false) as TextView
        card.text = "↗  $label"
        card.setOnClickListener { Ares.open(this, url); finish() }
        actions.addView(card)
        if (Ares.open(this, url)) finish()
    }

    override fun notPaired() {
        Ares.prefs(this).edit().remove("token").apply()
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    override fun offline(message: String) {
        reply.visibility = View.VISIBLE
        reply.text = message
        reactor.state = State.OFFLINE
    }

    private fun needMic(): Boolean {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 2)
        return false
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) session.startListening()
    }

    // ---- Share → ARES -------------------------------------------------------------------------------

    private fun receiveShare(i: Intent) {
        val title = i.getStringExtra(Intent.EXTRA_SUBJECT) ?: i.getStringExtra(Intent.EXTRA_TITLE)
        val text = i.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val uris = buildList {
            if (i.action == Intent.ACTION_SEND) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let(::add)
            else i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let(::addAll)
        }.take(5)
        attachView.visibility = View.VISIBLE
        attachView.text = "📎 Preparing…"
        thread {
            val pics = uris.filter { contentResolver.getType(it)?.startsWith("image/") == true }
            val images = pics.take(3).mapNotNull { runCatching { jpeg(it) }.getOrNull() }
            val files = Uploads.read(this, uris) // everything, as it is, in case it becomes a job (PDFs, documents…)
            val others = files.filterNot { it.type.startsWith("image/") }
            val note = listOfNotNull(title?.let { "Title: $it" }, text?.let { if (it.startsWith("http")) "Link: $it" else "Text: $it" },
                others.takeIf { it.isNotEmpty() }?.let { "(They also shared ${it.joinToString(", ") { f -> f.name }}, which can't be opened in chat: if they want it read, tell them to tap JOB.)" }).joinToString("\n")
            val missed = uris.size - files.size
            val summary = listOfNotNull(files.takeIf { it.isNotEmpty() }?.joinToString(", ") { it.name },
                missed.takeIf { it > 0 }?.let { "($it file${if (it > 1) "s" else ""} couldn't be read)" }, title, text).joinToString(" · ").take(120)
            runOnUiThread {
                session.attachment = Session.Attachment("(Shared from another app on the phone)\n$note".trimEnd(), images, files, Uploads.link(text))
                attachView.text = "📎 $summary   ✕"
                input.hint = "What should I do with this? (JOB: a worker does it)"
                showKeyboard()
            }
        }
    }

    /** A shared picture, shrunk to a sensible size for Claude and sent as JPEG. */
    private fun jpeg(uri: Uri): Pair<String, String> {
        val bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(contentResolver, uri)) { d, info, _ ->
            val scale = minOf(1f, 1568f / maxOf(info.size.width, info.size.height))
            d.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
        return "image/jpeg" to Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
