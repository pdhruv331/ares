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
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * ARES's presence over whatever you're doing (docs/phone-ui-prompt.md §5): summoned from the bubble, the side key, the tile
 * or "Share → ARES", the reactor grows out of the bubble's spot (SlowSpatial), listens, thinks and speaks there with small
 * captions and result cards under it, and condenses back into the bubble when done or dismissed. Nothing here is a new
 * screen: the app behind stays visible, a tap outside or Back condenses her. Opening something from a card launches it from
 * the card's bounds and leaves a "back to ARES" chip on the bubble; coming back, the card settles where it left from.
 */
class AskActivity : Activity(), Session.Ui {
    companion object {
        /** `from` = the bubble's (x, y, size) on screen to grow out of; `restore` = bring the last card back. */
        fun intent(c: Context, listen: Boolean = false, type: Boolean = false, ask: String? = null, hold: Boolean = false, from: IntArray? = null, restore: Boolean = false): Intent =
            Intent(c, AskActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("listen", listen).putExtra("type", type).putExtra("ask", ask).putExtra("hold", hold).putExtra("from", from).putExtra("restore", restore)
    }

    private lateinit var session: Session
    private lateinit var root: FrameLayout
    private lateinit var reactor: ReactorView
    private lateinit var column: LinearLayout
    private lateinit var heard: TextView
    private lateinit var reply: TextView
    private lateinit var input: EditText
    private lateinit var mic: View
    private lateinit var panel: View
    private lateinit var actions: LinearLayout
    private lateinit var cards: LinearLayout
    private lateinit var chips: LinearLayout
    private lateinit var attachView: TextView
    private lateinit var hint: TextView
    private lateinit var keyboardChip: TextView
    private val dp by lazy { resources.displayMetrics.density }
    private var from: IntArray? = null   // the bubble's spot: (x, y, size)
    private var restX = 0f; private var restY = 0f // where the reactor rests (its top-left)
    private var closing = false
    private var voiceTurn = false
    private var cardsShown = 0
    private val autoClose = Runnable { if (cardsShown == 0 && !input.hasFocus() && session.state == State.IDLE && !session.listening) condense() }
    private var holding = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Ares.paired(this)) { startActivity(Intent(this, MainActivity::class.java)); finish(); return }
        overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0)
        overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        setContentView(R.layout.activity_ask)
        root = findViewById(R.id.root)
        root.setOnClickListener { condense() } // tap outside: she condenses back
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            WindowInsets.CONSUMED
        }
        session = Session(this, this)
        reactor = findViewById(R.id.reactor)
        reactor.levelSource = { session.level }
        reactor.maxFps = 0
        column = findViewById(R.id.column)
        heard = findViewById(R.id.heard)
        reply = findViewById(R.id.reply)
        input = findViewById(R.id.input)
        mic = findViewById(R.id.mic)
        panel = findViewById(R.id.panel)
        actions = findViewById(R.id.actions)
        cards = findViewById(R.id.cards)
        chips = findViewById(R.id.chips)
        attachView = findViewById(R.id.attach)
        hint = findViewById(R.id.hint)
        keyboardChip = findViewById(R.id.keyboardChip)
        column.setOnClickListener { } // (taps on the cards aren't taps outside)
        panel.setOnClickListener { }
        mic.setOnClickListener { if (needMic()) toggleListen() }
        findViewById<View>(R.id.send).setOnClickListener { send() }
        findViewById<View>(R.id.job).setOnClickListener { makeJob() }
        keyboardChip.setOnClickListener { showKeyboard() }
        session.jobStarter = { said, extra -> startJob(said, extra) }
        input.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_SEND) { send(); true } else false }
        attachView.setOnClickListener { session.attachment = null; session.provider = null; attached() } // ✕: don't send it
        holdToTalk()
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backScrub)
        Perf.track(this)
        Perf.state("Reactor", "Summon")
        from = intent.getIntArrayExtra("from") ?: Bubble.rect() ?: Ares.prefs(this).let { p -> if (Ares.bubbleOn(this)) intArrayOf(p.getInt("bubbleX", -1), p.getInt("bubbleY", -1), (58 * dp).toInt()).takeIf { it[0] >= 0 } else null }
        Bubble.presence(true)
        // Positioned before the first frame is drawn (the margins need a layout pass), then grown on the frame after
        reactor.visibility = View.INVISIBLE
        root.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
            private var placed = false; private var started = false
            override fun onPreDraw(): Boolean {
                if (root.width == 0) return true
                if (!placed) { placed = true; place(); return false }
                if (!started) { started = true; grow() }
                return true
            }
        })
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(i: Intent) {
        when (i.action) {
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> return receiveShare(i)
            Intent.ACTION_ASSIST, Intent.ACTION_VOICE_COMMAND -> { if (needMic()) soon { listen() }; return }
        }
        if (i.getBooleanExtra("assist", false)) watchScreen()
        if (i.getBooleanExtra("restore", false)) restoreCard()
        i.getStringExtra("ask")?.let { heard.text = it; heard.visibility = View.VISIBLE; session.ask(it, voice = false); return }
        if (i.getBooleanExtra("type", false)) return showKeyboard()
        if (i.getBooleanExtra("listen", false) && needMic()) soon { listen(i.getBooleanExtra("hold", false)) }
    }

    /** After the grow has had its first frames (opening the recogniser stalls the main thread for a moment, which would eat the spring). */
    private fun soon(f: () -> Unit) { if (Motion.enabled && !grown) root.postDelayed(f, 380) else f() }
    private var grown = false

    // ---- Growing out of the bubble, condensing back -----------------------------------------------------------------------

    private fun place() {
        val w = root.width; val h = root.height
        val size = reactor.layoutParams.width
        val f = from
        val bubbleCy = f?.let { it[1] + it[2] / 2f } ?: (h * 0.4f)
        restX = (w - size) / 2f
        restY = (bubbleCy - size / 2f).coerceIn(h * 0.1f, h * 0.36f)
        (reactor.layoutParams as FrameLayout.LayoutParams).let { it.leftMargin = restX.toInt(); it.topMargin = restY.toInt(); reactor.layoutParams = it }
        (column.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = (restY + size + 34 * dp).toInt(); column.layoutParams = it }
        (hint.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = (restY + size + 10 * dp).toInt(); hint.layoutParams = it }
        (findViewById<View>(R.id.cardsScroll).layoutParams as LinearLayout.LayoutParams).let { it.height = -2; }
        findViewById<View>(R.id.cardsScroll).layoutParams.height = (h - (restY + size + 10 * dp) - 140 * dp).toInt().coerceAtLeast((160 * dp).toInt())
    }

    /** The reactor grows out of the bubble's spot (SlowSpatial) to its resting place; the column fades in under it. */
    private fun grow() {
        reactor.visibility = View.VISIBLE
        val size = reactor.layoutParams.width.toFloat()
        val f = from
        reactor.pivotX = size / 2; reactor.pivotY = size / 2
        if (Motion.enabled) {
            if (f != null) {
                val sx = f[2] / size
                reactor.scaleX = sx; reactor.scaleY = sx
                reactor.translationX = f[0] + f[2] / 2f - (restX + size / 2); reactor.translationY = f[1] + f[2] / 2f - (restY + size / 2) - root.paddingTop
            } else { reactor.scaleX = 0.2f; reactor.scaleY = 0.2f; reactor.translationY = root.height * 0.5f }
            reactor.hot("summon", true)
            Motion.to(reactor, Motion.X, 0f, Motion.SlowSpatial)
            Motion.to(reactor, Motion.Y, 0f, Motion.SlowSpatial)
            Motion.scale(reactor, 1f, Motion.SlowSpatial) { grown = true; reactor.hot("summon", false); Perf.state("Reactor", null) }
            column.alpha = 0f; hint.alpha = 0f; keyboardChip.alpha = 0f
            column.postDelayed({ Motion.to(column, Motion.ALPHA, 1f, Motion.DefaultEffects); Motion.to(hint, Motion.ALPHA, 1f, Motion.DefaultEffects); Motion.to(keyboardChip, Motion.ALPHA, 1f, Motion.DefaultEffects) }, 120)
        } else { column.alpha = 1f; hint.alpha = 1f; keyboardChip.alpha = 1f }
    }

    /** Done or dismissed: everything fades, the reactor condenses back into the bubble, then the bubble shows and this closes. */
    private fun condense() {
        if (closing) return
        closing = true
        session.hush(); if (session.listening) session.cancelListening()
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(input.windowToken, 0)
        val size = reactor.layoutParams.width.toFloat()
        val f = from
        val end = { Bubble.presence(false); finish(); overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0) }
        if (!Motion.enabled) return end()
        Motion.to(column, Motion.ALPHA, 0f, Motion.FastEffects); Motion.to(hint, Motion.ALPHA, 0f, Motion.FastEffects); Motion.to(keyboardChip, Motion.ALPHA, 0f, Motion.FastEffects); Motion.to(panel, Motion.ALPHA, 0f, Motion.FastEffects)
        reactor.hot("summon", true)
        if (f != null) {
            Motion.to(reactor, Motion.X, f[0] + f[2] / 2f - (restX + size / 2), Motion.TapSlow)
            Motion.to(reactor, Motion.Y, f[1] + f[2] / 2f - (restY + size / 2) - root.paddingTop, Motion.TapSlow)
            Motion.scale(reactor, f[2] / size, Motion.TapSlow) { end() }
        } else {
            Motion.to(reactor, Motion.Y, root.height * 0.5f, Motion.TapSlow)
            Motion.scale(reactor, 0.1f, Motion.TapSlow) { end() }
        }
        root.postDelayed({ if (!isFinishing) end() }, 900) // (a spring that never settles mustn't trap the screen)
    }

    /** Predictive back scrubs her towards the bubble; commit condenses, cancel springs back to rest. */
    private val backScrub = object : android.window.OnBackAnimationCallback {
        override fun onBackStarted(e: android.window.BackEvent) {}
        override fun onBackProgressed(e: android.window.BackEvent) {
            val k = e.progress * 0.5f
            reactor.scaleX = 1f - 0.4f * k; reactor.scaleY = reactor.scaleX
            column.alpha = 1f - k; hint.alpha = 1f - k
        }
        override fun onBackInvoked() = condense()
        override fun onBackCancelled() { Motion.scale(reactor, 1f, Motion.TapSpatial); Motion.to(column, Motion.ALPHA, 1f, Motion.DefaultEffects); Motion.to(hint, Motion.ALPHA, 1f, Motion.DefaultEffects) }
    }

    override fun onResume() { super.onResume(); Sounds.front = true; Sounds.warm(this); Bubble.presence(true) }
    override fun onPause() { Sounds.front = false; super.onPause() }

    override fun onDestroy() {
        ScreenContext.onChange = null
        if (::session.isInitialized) session.release()
        Bubble.presence(false)
        super.onDestroy()
    }

    // ---- Talking ---------------------------------------------------------------------------------------------------------

    private fun listen(hold: Boolean = false) {
        if (session.listening) return
        if (session.state == State.SPEAKING || session.state == State.THINKING) { reactor.interrupt(); session.hush() }
        voiceTurn = true
        root.removeCallbacks(autoClose)
        Haptics.listen(this); Sounds.listenOn(this)
        session.startListening()
    }

    private fun toggleListen() {
        when {
            session.state == State.SPEAKING || session.state == State.THINKING -> { reactor.interrupt(); Haptics.tick(this); session.hush() }
            session.listening -> { Haptics.commit(this); Sounds.listenOff(this); session.stopListening() }
            else -> listen()
        }
    }

    /** Hold the reactor to talk until you let go; a tap stops her or sends what you're saying. */
    private fun holdToTalk() {
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        var x0 = 0f; var y0 = 0f; var downAt = 0L; var talking = false
        val start = Runnable { if (needMic()) { talking = true; holding = true; listen(hold = true) } }
        reactor.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val r = min(v.width, v.height) / 2f
                    if (Math.hypot((e.x - v.width / 2f).toDouble(), (e.y - v.height / 2f).toDouble()) > r) return@setOnTouchListener false
                    x0 = e.x; y0 = e.y; downAt = System.currentTimeMillis(); talking = false; v.postDelayed(start, 320)
                }
                MotionEvent.ACTION_MOVE -> if (!talking && (abs(e.x - x0) > slop || abs(e.y - y0) > slop)) v.removeCallbacks(start)
                MotionEvent.ACTION_UP -> {
                    v.removeCallbacks(start)
                    if (talking) { talking = false; holding = false; if (session.listening) { Haptics.commit(this); Sounds.listenOff(this); session.stopListening() } }
                    else if (System.currentTimeMillis() - downAt < 320) toggleListen()
                }
                MotionEvent.ACTION_CANCEL -> { v.removeCallbacks(start); if (talking) { talking = false; holding = false; session.cancelListening() } }
            }
            true
        }
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

    private fun send() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        input.setText("")
        heard.text = text
        heard.visibility = View.VISIBLE
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(input.windowToken, 0)
        voiceTurn = false
        root.removeCallbacks(autoClose)
        session.ask(text, voice = false)
    }

    private fun showKeyboard() {
        panel.visibility = View.VISIBLE; panel.alpha = 1f
        keyboardChip.visibility = View.GONE
        root.removeCallbacks(autoClose)
        input.requestFocus()
        input.post { getSystemService(InputMethodManager::class.java).showSoftInput(input, 0) }
    }

    // ---- Make it a job: a worker on the Mac does it in the background, with what's shared or on screen ----

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
        val note = extra?.note?.lines()?.filterNot { it.startsWith("(They also shared") }?.joinToString("\n")?.trim().orEmpty()
        val text = if (note.isNotBlank()) "$said\n\n$note" else said
        thread {
            val r = runCatching { AresClient(this).startJob(text, files, extra?.link) }
            runOnUiThread {
                r.onSuccess { job ->
                    JobStore.update(this, job)
                    reply.text = "On it: “${job.optString("title")}”. I'll let you know when it's ready."
                    showCard(JSONObject().put("kind", "progress").put("job", job.optString("id")))
                }.onFailure { reply.text = "I couldn't start that job: ${it.message ?: "your Mac didn't answer"}." }
            }
        }
    }

    // ---- Session.Ui ---------------------------------------------------------------------------------------------------------

    override fun state(s: State) {
        reactor.state = s
        mic.isActivated = s == State.LISTENING
        hint.text = when (s) {
            State.LISTENING -> if (holding) "LISTENING · LET GO TO SEND" else "LISTENING · TAP TO SEND"
            State.THINKING -> "THINKING"
            State.SPEAKING -> "SPEAKING · TAP TO STOP"
            else -> "HOLD · TALK     TAP · TALK"
        }
        if (s == State.LISTENING) { reply.visibility = View.GONE; heard.text = "Listening…"; heard.visibility = View.VISIBLE }
        if (s == State.IDLE && voiceTurn && !closing) { root.removeCallbacks(autoClose); root.postDelayed(autoClose, 3500) } // a spoken turn with nothing to keep: she condenses by herself
    }

    override fun heard(text: String, final: Boolean) {
        heard.text = text
        heard.visibility = View.VISIBLE
    }

    override fun caption(text: String) {
        reply.visibility = View.VISIBLE
        reply.text = text.replace(Regex("\\s+"), " ").trim()
    }

    override fun reply(text: String, final: Boolean) {
        if (!voiceTurn) { reply.visibility = View.VISIBLE; reply.text = text; reply.maxLines = 8 }
    }

    override fun card(spec: JSONObject) { showCard(spec) }

    override fun showJob(id: String?) {
        if (id == null) { startActivity(WorkActivity.intent(this)); return }
        val job = JobStore.get(id)
        showCard(JSONObject().put("kind", if (job?.status == "approval") "approval" else "progress").put("job", id))
    }

    private fun showCard(spec: JSONObject, from: android.graphics.Rect? = null) {
        val clean = Cards.parse(spec) ?: return
        root.removeCallbacks(autoClose)
        cardsShown++
        Cards.last = clean
        val v = Cards.view(Cards.Host(this, ask = { q -> heard.text = q; heard.visibility = View.VISIBLE; voiceTurn = false; session.ask(q, voice = true) }, opened = { card, icon -> opened(card, icon) }), clean)
        Cards.land(this, cards, v, from)
    }

    /** A card opened an app: the bubble carries the way back for ~30 s; she condenses behind the app. */
    private fun opened(card: View, icon: Bitmap?) {
        Bubble.returnChip(icon, 30_000)
        root.postDelayed({ condense() }, 250)
    }

    /** Back from that app: the last card springs in from where it left. */
    private fun restoreCard() {
        val spec = Cards.last ?: return
        val rect = Cards.lastRect
        root.post { showCard(spec, rect) }
    }

    override fun action(url: String, label: String) {
        val card = layoutInflater.inflate(R.layout.item_action, actions, false) as TextView
        card.text = "↗  $label"
        card.setOnClickListener { if (Ares.open(this, url, card)) opened(card, null) }
        actions.addView(card)
        if (Ares.open(this, url, reactor)) opened(reactor, null)
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
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) listen()
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
