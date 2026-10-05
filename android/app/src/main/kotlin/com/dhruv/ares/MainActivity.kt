package com.dhruv.ares

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread
import kotlin.math.max

class MainActivity : Activity(), Session.Ui {
    private lateinit var session: Session
    private lateinit var reactor: BrainView
    private lateinit var fallback: ReactorView
    private lateinit var log: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var input: EditText
    private lateinit var talk: TextView
    private lateinit var status: TextView
    private lateinit var stateText: TextView
    private lateinit var setup: TextView
    private var replyView: TextView? = null
    private var heardView: TextView? = null
    private var pressedAt = 0L
    private lateinit var workBtn: TextView
    private lateinit var caption: TextView
    private lateinit var history: View
    private lateinit var inputRow: View
    private var lastState = State.IDLE
    private val fadeCaption = Runnable { caption.animate().alpha(0f).setDuration(600).start() }
    private val jobsChanged = { showJobs() }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            WindowInsets.CONSUMED
        }
        session = Session(this, this)
        reactor = findViewById(R.id.reactor)
        reactor.levelSource = { session.level }
        // The arc reactor is the face of the app; the 3D brain is a menu option. If the brain is chosen and hasn't
        // drawn within a few seconds (no WebGL, a script problem), the reactor takes over.
        fallback = findViewById(R.id.reactorFallback)
        fallback.levelSource = { session.level }
        fallback.setOnClickListener { session.hush() }
        val fallBack = Runnable { if (!reactor.ready) { fallback.visibility = View.VISIBLE; reactor.visibility = View.INVISIBLE } }
        if (Ares.prefs(this).getBoolean("brain3d", false)) {
            reactor.postDelayed(fallBack, 6000)
            reactor.onReady = { reactor.removeCallbacks(fallBack); fallback.visibility = View.GONE; reactor.visibility = View.VISIBLE }
            reactor.onError = { fallBack.run() }
        } else {
            fallback.visibility = View.VISIBLE
            reactor.visibility = View.GONE
        }
        log = findViewById(R.id.log)
        scroll = findViewById(R.id.scroll)
        input = findViewById(R.id.input)
        talk = findViewById(R.id.talk)
        status = findViewById(R.id.status)
        stateText = findViewById(R.id.stateText)
        setup = findViewById(R.id.setup)

        caption = findViewById(R.id.caption)
        history = findViewById(R.id.history)
        inputRow = findViewById(R.id.inputRow)
        findViewById<View>(R.id.commsBtn).setOnClickListener { showHistory(history.visibility != View.VISIBLE) }
        findViewById<View>(R.id.historyClose).setOnClickListener { showHistory(false) }
        findViewById<View>(R.id.kbBtn).setOnClickListener {
            val show = inputRow.visibility != View.VISIBLE
            inputRow.visibility = if (show) View.VISIBLE else View.GONE
            if (show) { input.requestFocus(); getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(input, 0) }
        }
        findViewById<View>(R.id.send).setOnClickListener { send() }
        input.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_SEND) { send(); true } else false }
        reactor.onTap = { session.hush() }
        reactor.onOrb = { id -> startActivity(WorkActivity.intent(this, id)) }
        findViewById<View>(R.id.menu).setOnClickListener(::showMenu)
        workBtn = findViewById(R.id.workBtn)
        workBtn.setOnClickListener { startActivity(WorkActivity.intent(this)) }
        findViewById<View>(R.id.callsBtn).setOnClickListener { startActivity(CallsActivity.intent(this)) }
        setup.setOnClickListener { nextSetupStep() }

        // Tap to talk (she stops listening when you pause), or hold it like a walkie-talkie
        talk.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    pressedAt = System.currentTimeMillis()
                    if (session.listening) session.stopListening() else if (needMic()) session.startListening()
                }
                MotionEvent.ACTION_UP -> if (System.currentTimeMillis() - pressedAt > 600 && session.listening) session.stopListening()
            }
            true
        }

        findViewById<TextView>(R.id.url).text = Ares.url(this)
        findViewById<View>(R.id.pairBtn).setOnClickListener { pair() }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        // "Hey Google, open ARES" / "Hi Bixby, open ARES": the assistant opened her, so listen straight away
        val fromAssistant = referrer?.host in setOf("com.google.android.googlequicksearchbox", "com.samsung.android.bixby.agent")
        if ((intent?.getBooleanExtra("listen", false) == true || fromAssistant) && Ares.paired(this) && needMic()) session.startListening()
        if (intent?.getBooleanExtra("handsfree", false) == true && Ares.paired(this) && needMic()) session.setHandsFree(true, "asked")
    }

    /** Hands-free conversation on or off: keep the screen awake while it's on, and say so. */
    override fun handsFree(on: Boolean, why: String) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        state(session.state)
        if (why == "asked" || why == "quiet") add("ARES", if (on) "Hands-free on. I'll keep listening after each answer; say \"that's all\" when you're done." else if (why == "quiet") "It's gone quiet, so I've stopped listening. Tap when you need me." else "Hands-free off.", user = false)
    }

    override fun onResume() {
        super.onResume()
        if (!Ares.paired(this)) return showPair()
        findViewById<View>(R.id.pair).visibility = View.GONE
        findViewById<View>(R.id.app).visibility = View.VISIBLE
        AresService.start(this)
        reactor.onResume()
        reactor.land()
        JobStore.listen(jobsChanged)
        showJobs()
        refreshSetup()
        if (log.childCount == 0) loadHistory()
    }

    override fun onPause() {
        session.setHandsFree(false, "left") // listening from behind another screen is unreliable; tap or ask again when back
        reactor.onPause() // no drawing while you're elsewhere
        JobStore.unlisten(jobsChanged)
        super.onPause()
    }

    /** WORK · 2 (jobs going), amber when one needs your OK. */
    private fun showJobs() {
        val n = JobStore.working + JobStore.waiting
        val badge = if (n > 0) n else JobStore.unseen
        workBtn.text = if (badge > 0) "WORK · $badge" else "WORK"
        workBtn.setTextColor(getColor(if (JobStore.waiting > 0) R.color.amber else R.color.cyan))
        reactor.jobs(JobStore.json())
        fallback.jobs(JobStore.list())
    }

    override fun onDestroy() {
        session.release()
        super.onDestroy()
    }

    // ---- Talking ------------------------------------------------------------------------------------

    private fun send() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        input.setText("")
        heardView = null
        add("YOU", text, user = true)
        session.ask(text, voice = false)
    }

    override fun state(s: State) {
        reactor.state = s
        fallback.state = s
        // Captions: her words stay while she speaks, then fade; a listened-to question fades once she starts answering
        if (s == State.IDLE && lastState == State.SPEAKING) caption.postDelayed(fadeCaption, 1200)
        if (s == State.THINKING) { caption.removeCallbacks(fadeCaption); caption.postDelayed(fadeCaption, 2500) }
        lastState = s
        stateText.text = when (s) { State.LISTENING -> "LISTENING"; State.THINKING -> "THINKING"; State.SPEAKING -> "SPEAKING"; State.OFFLINE -> "OFFLINE"; else -> "" }
        val hf = if (session.handsFree) "HANDS-FREE · " else ""
        talk.text = if (s == State.LISTENING) "${hf}LISTENING… TAP TO SEND" else if (session.handsFree) "HANDS-FREE · TAP TO TALK NOW" else "TAP TO TALK"
        talk.isActivated = s == State.LISTENING || session.handsFree
        if (s == State.THINKING) replyView = null
    }

    /** Show words over the reactor now; they fade later (when she's done speaking, or after a while if typed). */
    private fun showCaption(text: String, fadeAfterMs: Long? = null) {
        caption.removeCallbacks(fadeCaption)
        caption.animate().cancel()
        caption.text = text
        caption.alpha = 1f
        if (fadeAfterMs != null) caption.postDelayed(fadeCaption, fadeAfterMs)
    }

    override fun heard(text: String, final: Boolean) {
        val v = heardView ?: add("YOU", text, user = true).also { heardView = it }
        v.text = text
        showCaption(text)
        if (final) heardView = null
    }

    override fun reply(text: String, final: Boolean) {
        val v = replyView ?: add("ARES", "", user = false).also { replyView = it }
        v.text = text
        showCaption(text, if (final && session.state != State.SPEAKING) 7000 else null) // typed (no voice): read it, then it goes
        if (final) replyView = null
        scrollDown()
        setStatus("online")
    }

    override fun action(url: String, label: String) {
        val card = layoutInflater.inflate(R.layout.item_action, log, false) as TextView
        card.text = "↗  $label"
        card.setOnClickListener { Ares.open(this, url) }
        log.addView(card)
        scrollDown()
        Ares.open(this, url) // you just asked for it: open it straight away
    }

    /** COMMS: the whole conversation over the reactor. */
    private fun showHistory(open: Boolean) {
        history.visibility = if (open) View.VISIBLE else View.GONE
        if (open) scrollDown()
    }

    override fun notPaired() {
        Ares.prefs(this).edit().remove("token").apply()
        showPair()
    }

    override fun offline(message: String) {
        add("ARES", message, user = false)
        setStatus("offline")
    }

    private fun add(who: String, text: String, user: Boolean, source: String? = null, quiet: Boolean = false): TextView {
        val item = layoutInflater.inflate(R.layout.item_message, log, false)
        item.findViewById<TextView>(R.id.who).apply {
            this.text = if (source != null && source != "phone" && user) "$who · ${source.uppercase()}" else who
            isActivated = !user
        }
        val body = item.findViewById<TextView>(R.id.text)
        body.text = text
        body.isActivated = !user
        log.addView(item)
        if (!user && !quiet && text.isNotEmpty()) showCaption(text, 7000) // a note from the app itself (offline, hands-free…): read it, then it goes
        while (log.childCount > 80) log.removeViewAt(0)
        scrollDown()
        return body
    }

    private fun scrollDown() = scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }

    private fun setStatus(s: String) {
        status.text = when (s) { "online" -> "CONNECTED"; "offline" -> "OFFLINE"; else -> "NOT PAIRED" }
        status.isActivated = s == "online"
    }

    private fun loadHistory() {
        thread {
            try {
                val lines = AresClient(this).history()
                Ares.setStatus(this, "online")
                runOnUiThread {
                    log.removeAllViews()
                    for (l in lines) add(if (l.who == "ares") "ARES" else "YOU", l.text, l.who != "ares", l.source, quiet = true)
                    if (lines.isEmpty()) add("ARES", "At your service, sir. Tap the button and talk, or type below.", false)
                    setStatus("online")
                    state(State.IDLE)
                }
            } catch (e: NotPairedException) {
                runOnUiThread { notPaired() }
            } catch (e: Exception) {
                Ares.setStatus(this, "offline")
                runOnUiThread {
                    setStatus("offline")
                    state(State.OFFLINE)
                    if (log.childCount == 0) add("ARES", "I can't reach the Mac, sir. Check it's awake and Tailscale is on.", false)
                }
            }
        }
    }

    // ---- Pairing ------------------------------------------------------------------------------------

    private fun showPair() {
        setStatus("unpaired")
        findViewById<View>(R.id.app).visibility = View.GONE
        findViewById<View>(R.id.pair).visibility = View.VISIBLE
        AresService.stop(this)
    }

    private fun pair() {
        val url = findViewById<EditText>(R.id.url).text.toString().trim().trimEnd('/')
        val code = findViewById<EditText>(R.id.code).text.toString().filter(Char::isDigit)
        val err = findViewById<TextView>(R.id.pairErr)
        val debuggable = applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (!url.startsWith("https://") && !(debuggable && url.startsWith("http://10.0.2.2"))) { err.text = "The address should start with https://"; return }
        if (code.length != 6) { err.text = "The code is six digits: Pair a Phone… in the ARES menu on your Mac."; return }
        Ares.prefs(this).edit().putString("url", url).apply()
        err.text = "Pairing…"
        thread {
            val problem = try { AresClient(this).pair(code) } catch (e: Exception) { "Couldn't reach the Mac at that address. Is Tailscale on?" }
            runOnUiThread {
                if (problem != null) { err.text = problem; return@runOnUiThread }
                err.text = ""
                log.removeAllViews()
                onResume()
            }
        }
    }

    // ---- Menu & setup -------------------------------------------------------------------------------

    private fun showMenu(anchor: View) {
        val menu = PopupMenu(this, anchor)
        menu.menu.add(0, 7, 0, "Hands-free conversation").apply { isCheckable = true; isChecked = session.handsFree }
        menu.menu.add(0, 1, 0, "Floating bubble").apply { isCheckable = true; isChecked = Ares.bubbleOn(this@MainActivity) }
        menu.menu.add(0, 4, 1, "Share my screen when summoned").apply { isCheckable = true; isChecked = Ares.prefs(this@MainActivity).getBoolean("screen", true) }
        menu.menu.add(0, 5, 2, "Make ARES your assistant…")
        menu.menu.add(0, 6, 3, "Check for updates (v${Updater.version(this)})")
        menu.menu.add(0, 9, 3, "3D brain instead of the reactor").apply { isCheckable = true; isChecked = Ares.prefs(this@MainActivity).getBoolean("brain3d", false) }
        if (Ares.prefs(this).getBoolean("brain3d", false)) menu.menu.add(0, 8, 3, "Brain diagnostics")
        menu.menu.add(0, 2, 4, "Mac address…")
        menu.menu.add(0, 3, 5, "Unpair this phone")
        menu.setOnMenuItemClickListener {
            when (it.itemId) {
                7 -> if (needMic()) session.setHandsFree(!session.handsFree, "asked")
                1 -> {
                    val on = !Ares.bubbleOn(this)
                    Ares.prefs(this).edit().putBoolean("bubble", on).apply()
                    if (on && !Settings.canDrawOverlays(this)) askOverlay() else AresService.start(this)
                }
                2 -> editUrl()
                4 -> Ares.prefs(this).edit().putBoolean("screen", !Ares.prefs(this).getBoolean("screen", true)).apply()
                5 -> makeAssistant()
                6 -> checkUpdates()
                9 -> { Ares.prefs(this).edit().putBoolean("brain3d", !Ares.prefs(this).getBoolean("brain3d", false)).apply(); recreate() }
                8 -> reactor.diagnose { AlertDialog.Builder(this).setTitle("Brain diagnostics").setMessage(it).setPositiveButton("OK", null).show() }
                3 -> AlertDialog.Builder(this).setTitle("Unpair this phone?")
                    .setMessage("You'll need a new code from the Mac to pair again. To revoke the key on the Mac too, use Unpair All Phones in its menu.")
                    .setPositiveButton("Unpair") { _, _ -> notPaired() }
                    .setNegativeButton("Cancel", null).show()
            }
            true
        }
        menu.show()
    }

    private fun editUrl() {
        val field = EditText(this).apply { setText(Ares.url(this@MainActivity)); setSingleLine() }
        AlertDialog.Builder(this).setTitle("Mac address (Tailscale)").setView(field)
            .setPositiveButton("Save") { _, _ ->
                val u = field.text.toString().trim().trimEnd('/')
                if (u.startsWith("https://")) { Ares.prefs(this).edit().putString("url", u).apply(); AresService.restart(this); loadHistory() }
            }
            .setNegativeButton("Cancel", null).show()
    }

    private fun isAssistant() = getSystemService(android.app.role.RoleManager::class.java).isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT)

    private fun makeAssistant() {
        if (isAssistant()) {
            AlertDialog.Builder(this).setTitle("ARES is your assistant")
                .setMessage("Long-press the side button, or swipe up from a bottom corner, to summon her.\n\nFor the side button on a Galaxy: Settings → Advanced features → Side button → Press and hold → Digital assistant.")
                .setPositiveButton("Side button settings") { _, _ -> runCatching { startActivity(Intent("com.samsung.settings.SIDE_KEY_SETTINGS")) }.onFailure { startActivity(Intent(Settings.ACTION_SETTINGS)) } }
                .setNegativeButton("OK", null).show()
            return
        }
        AlertDialog.Builder(this).setTitle("Make ARES your assistant")
            .setMessage("On the next screen, choose ARES as the Digital assistant app. Gemini stays installed; you can switch back there any time.\n\nTip: also turn on \"Use screenshot\" there if you want ARES to see what's on screen when you summon her.")
            .setPositiveButton("Open settings") { _, _ -> startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)) }
            .setNegativeButton("Not now", null).show()
    }

    private fun checkUpdates() {
        thread {
            val app = runCatching { AresClient(this).appInfo() }
            runOnUiThread {
                when {
                    app.isFailure -> add("ARES", "I couldn't reach the Mac to check, sir.", false)
                    Updater.newer(this, app.getOrNull()) -> startActivity(Intent(this, UpdateActivity::class.java))
                    else -> add("ARES", "You're on the latest version (${Updater.version(this)}), sir.", false)
                }
            }
        }
    }

    /** What still needs allowing for the full experience, in the order we ask. */
    private fun missingSetup(): List<Pair<String, () -> Unit>> = buildList {
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            add("allow notifications" to { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) })
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            add("allow the microphone" to { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 2) })
        if (Ares.bubbleOn(this@MainActivity) && !Settings.canDrawOverlays(this@MainActivity))
            add("allow the floating bubble" to ::askOverlay)
        if (!getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName))
            add("let ARES run in the background" to ::askBattery)
        if (!isAssistant() && !Ares.prefs(this@MainActivity).getBoolean("assistantAsked", false))
            add("make ARES your assistant (optional)" to { Ares.prefs(this@MainActivity).edit().putBoolean("assistantAsked", true).apply(); makeAssistant() })
    }

    private fun refreshSetup() {
        val missing = missingSetup()
        setup.visibility = if (missing.isEmpty()) View.GONE else View.VISIBLE
        if (missing.isNotEmpty()) setup.text = "Finish setup: ${missing.first().first} ›"
    }

    private fun nextSetupStep() { missingSetup().firstOrNull()?.second?.invoke() }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshSetup()
        AresService.start(this) // the notification can show now
    }

    private fun needMic(): Boolean {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 2)
        return false
    }

    private fun askOverlay() {
        AlertDialog.Builder(this).setTitle("Floating bubble")
            .setMessage("To float over other apps, ARES needs \"Appear on top\". Find ARES on the next screen and switch it on.")
            .setPositiveButton("Open settings") { _, _ -> startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) }
            .setNegativeButton("Not now", null).show()
    }

    @SuppressLint("BatteryLife")
    private fun askBattery() {
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }
}
