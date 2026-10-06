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
import android.widget.Toast
import android.app.Dialog
import android.graphics.Color
import android.view.Gravity
import android.view.ViewGroup
import kotlin.concurrent.thread
import kotlin.math.abs
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
    private lateinit var drawer: View
    private lateinit var drawerPanel: View
    private lateinit var schematic: SchematicView
    private lateinit var inputRow: View
    private var statusPoll: Thread? = null
    private var lastState = State.IDLE
    private val fadeCaption = Runnable { caption.animate().alpha(0f).setDuration(600).start(); schematic.dimBottom = false }
    private val jobsChanged = { showJobs() }
    // Power from the phone (docs/ignition-prompt.md §4d-4f): the Mac's state mirrored on the orb, the orb hold, the ⏻ sheet
    private lateinit var powerBtn: TextView
    private lateinit var schedChip: TextView
    private lateinit var sounds: Sounds
    private var lastPower: PowerStore.Mode? = null
    private var powerSheet: Dialog? = null
    private var asked = false // this phone asked for the last change: toast it
    private val powerChanged = { showPower() }

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
        PowerStore.load(this)
        sounds = Sounds(this)
        // Tap the orb = talk (or hush her); hold it ~0.8 s = standby / wake, a ring filling around it meanwhile
        val hold = HoldDetector(this, onTap = { tapOrb() }, onHold = { holdOrb() }, onRing = { k, done -> fallback.holdK = if (done) 0f else k })
        fallback.setOnTouchListener { _, e -> hold.onTouch(e); true }
        powerBtn = findViewById(R.id.powerBtn)
        powerBtn.setOnClickListener { showPowerSheet() }
        schedChip = findViewById(R.id.schedChip)
        schedChip.setOnClickListener { scheduleMenu(it) }
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
        drawer = findViewById(R.id.drawer)
        drawerPanel = findViewById(R.id.drawerPanel)
        schematic = findViewById(R.id.schematic)
        inputRow = findViewById(R.id.inputRow)
        findViewById<View>(R.id.commsHandle).setOnClickListener { showHistory(true) }
        findViewById<View>(R.id.drawerClose).setOnClickListener { showHistory(false) }
        findViewById<View>(R.id.drawerScrim).setOnClickListener { showHistory(false) }
        findViewById<View>(R.id.drawerClear).setOnClickListener { log.removeAllViews() }
        // The drawer takes the lower part of the screen; the schematic centres on the reactor once laid out
        val stage = findViewById<View>(R.id.stage)
        stage.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
            val loc = IntArray(2).also { v.getLocationInWindow(it) }
            val sloc = IntArray(2).also { schematic.getLocationInWindow(it) }
            val inset = 36 * resources.displayMetrics.density
            val h = v.height - inset * 2
            schematic.center = floatArrayOf(loc[0] - sloc[0] + v.width / 2f, loc[1] - sloc[1] + v.height / 2f, kotlin.math.min(v.width.toFloat(), h) / 2f * 0.92f)
            drawerPanel.layoutParams = drawerPanel.layoutParams.apply { height = (drawer.height * 0.64f).toInt() }
        }
        findViewById<View>(R.id.kbBtn).setOnClickListener {
            val show = inputRow.visibility != View.VISIBLE
            inputRow.visibility = if (show) View.VISIBLE else View.GONE
            if (show) { input.requestFocus(); getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(input, 0) }
        }
        findViewById<View>(R.id.send).setOnClickListener { send() }
        input.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_SEND) { send(); true } else false }
        reactor.onTap = { session.hush() }
        reactor.onOrb = { id -> startActivity(WorkActivity.intent(this, id)) }
        val brainHold = HoldDetector(this, onTap = {}, onHold = { holdOrb() }, onRing = { _, _ -> })
        reactor.setOnTouchListener { _, e -> brainHold.onTouch(e); false } // the brain keeps its own taps
        findViewById<View>(R.id.menu).setOnClickListener(::showMenu)
        workBtn = findViewById(R.id.workBtn)
        workBtn.setOnClickListener { startActivity(WorkActivity.intent(this)) }
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
        pollStatus()
        refreshSetup()
        sounds.inFront = true
        PowerStore.listen(powerChanged)
        probeRelay()
        if (log.childCount == 0) loadHistory()
    }

    override fun onPause() {
        session.setHandsFree(false, "left") // listening from behind another screen is unreliable; tap or ask again when back
        sounds.inFront = false
        PowerStore.unlisten(powerChanged)
        statusPoll?.interrupt()
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
        showReadouts()
    }

    override fun onDestroy() {
        session.release()
        sounds.release()
        super.onDestroy()
    }

    // ---- Power (docs/ignition-prompt.md §4d, §4e, §4f) --------------------------------------------------------------

    /** The Mac's power state on the screen: the orb's colour and motion, the header, the ⏻ button, the hint, the chip. */
    private fun showPower() {
        val mode = PowerStore.mode
        fallback.power = when (mode) {
            PowerStore.Mode.ONLINE, PowerStore.Mode.UNKNOWN -> ReactorView.Power.ONLINE
            PowerStore.Mode.STANDBY -> ReactorView.Power.STANDBY
            PowerStore.Mode.OFFLINE, PowerStore.Mode.QUIT, PowerStore.Mode.UNREACHABLE -> ReactorView.Power.OFFLINE
            PowerStore.Mode.CHARGING -> ReactorView.Power.CHARGING
            PowerStore.Mode.SPINDOWN -> ReactorView.Power.SPINDOWN
            PowerStore.Mode.ASLEEP -> ReactorView.Power.ASLEEP
        }
        fallback.chargeK = PowerStore.chargeK
        fallback.holdColor = Color.parseColor(if (PowerStore.canStandby) "#6096FF" else "#3EE6FF")
        reactor.state = if (mode == PowerStore.Mode.ONLINE) session.state else State.OFFLINE // (the 3D brain only knows on/off)
        val colour = when (mode) {
            PowerStore.Mode.ONLINE -> R.color.cyan; PowerStore.Mode.STANDBY -> R.color.blue; PowerStore.Mode.ASLEEP -> R.color.grey
            PowerStore.Mode.UNKNOWN -> R.color.muted; else -> R.color.gold
        }
        status.text = PowerStore.header()
        status.setTextColor(getColor(colour))
        powerBtn.visibility = if (PowerStore.off || mode == PowerStore.Mode.UNKNOWN || mode == PowerStore.Mode.SPINDOWN) View.GONE else View.VISIBLE
        val sch = PowerStore.schedule
        schedChip.visibility = if (sch == null || !PowerStore.reach) View.GONE else View.VISIBLE
        if (sch != null) schedChip.text = listOfNotNull(sch.standby?.let { "☾ standby $it" }, sch.wake?.let { "☀ wake $it" }).joinToString(" · ") + if (sch.skipped) " · skipped tonight" else ""
        state(session.state) // the hint under the orb
        // Sounds and haptics for the change itself
        val was = lastPower
        lastPower = mode
        if (was != null && was != mode) {
            when {
                mode == PowerStore.Mode.STANDBY -> { sounds.play("standby-down"); Haptics.soft(this) }
                mode == PowerStore.Mode.ONLINE && was == PowerStore.Mode.CHARGING -> { sounds.play("bloom"); Haptics.double(this) }
                mode == PowerStore.Mode.ONLINE && was == PowerStore.Mode.STANDBY -> { sounds.play("wake-chime"); Haptics.double(this) }
                mode == PowerStore.Mode.SPINDOWN -> { sounds.play("clunk"); sounds.play("winddown", 0.3f) }
                mode == PowerStore.Mode.OFFLINE && was == PowerStore.Mode.SPINDOWN -> sounds.play("thud")
                mode == PowerStore.Mode.CHARGING -> sounds.play("charge-hum", 0.25f, loop = true)
            }
            if (was == PowerStore.Mode.CHARGING) sounds.stop("charge-hum")
            if (asked && mode in setOf(PowerStore.Mode.ONLINE, PowerStore.Mode.STANDBY, PowerStore.Mode.OFFLINE)) {
                asked = false
                Toast.makeText(this, "Mac ARES → ${PowerStore.header().lowercase()}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /** A tap on the orb: stop her talking, send what you're saying, or start listening. */
    private fun tapOrb() {
        when {
            session.state == State.SPEAKING -> session.hush()
            session.listening -> session.stopListening()
            PowerStore.mode == PowerStore.Mode.ONLINE -> if (needMic()) session.startListening()
            else -> { Haptics.tick(this); showCaption(PowerStore.hint().replace('\n', ' '), 3000) }
        }
    }

    /** The orb held to the end: online → standby, standby / powered down → wake, quit → wake through the relay. */
    private fun holdOrb() {
        val mode = PowerStore.mode
        when {
            mode == PowerStore.Mode.ONLINE -> powerAct("standby")
            mode == PowerStore.Mode.STANDBY || mode == PowerStore.Mode.OFFLINE -> powerAct("wake")
            mode == PowerStore.Mode.QUIT -> wakeThroughRelay()
            mode == PowerStore.Mode.ASLEEP -> { Haptics.error(this); sounds.play("nope"); showCaption("Mac asleep · can't wake. Open the lid or plug it in.", 4000) }
            mode == PowerStore.Mode.UNREACHABLE -> { Haptics.error(this); sounds.play("nope"); showCaption("I can't reach the Mac. Is Tailscale on?", 4000); probeRelay() }
            else -> Haptics.tick(this)
        }
    }

    /** Standby / wake / power down over the paired channel (works while she's dormant too). */
    private fun powerAct(action: String) {
        asked = true
        thread(name = "ares-power") {
            val r = runCatching { AresClient(this).powerAct(action) }
            runOnUiThread {
                val ok = r.getOrNull()?.optBoolean("ok") == true
                if (!ok) { asked = false; Haptics.error(this); sounds.play("nope"); showCaption(r.getOrNull()?.optString("message")?.ifBlank { null } ?: "I couldn't reach the Mac, sir.", 4000) }
                else r.getOrNull()?.let { PowerStore.fromPower(this, it) }
            }
        }
    }

    /** ARES is fully quit but the Mac is awake (the ignition helper polls the relay): a signed wake, then wait for her to come up. */
    private fun wakeThroughRelay() {
        val relay = PowerStore.relay ?: return
        asked = true
        PowerStore.markIgniting(true)
        thread(name = "ares-relay-wake") {
            val a = runCatching { RelayClient(relay).wake() }.getOrElse { RelayClient.Answer(false, null, false, false, "I couldn't reach the relay.") }
            if (!a.ok || !a.awake) {
                runOnUiThread {
                    PowerStore.markIgniting(false); asked = false
                    if (a.ok) PowerStore.setHelper(false)
                    Haptics.error(this); sounds.play("nope")
                    showCaption(a.error ?: "Mac asleep · can't wake. Open the lid or plug it in.", 5000)
                }
                return@thread
            }
            runOnUiThread { showCaption("Igniting…", 3000) }
            AresService.restart(this) // the live line reconnects as soon as she's up
            val until = System.currentTimeMillis() + 100_000
            while (System.currentTimeMillis() < until && PowerStore.igniting) {
                runCatching { AresClient(this).power() }.onSuccess { PowerStore.setReach(this, true); PowerStore.fromPower(this, it) }
                if (PowerStore.reach) return@thread
                Thread.sleep(3000)
            }
            if (PowerStore.igniting) runOnUiThread { PowerStore.markIgniting(false); asked = false; PowerStore.setHelper(null); Haptics.error(this); showCaption("The Mac didn't answer, sir. Is it asleep?", 5000) }
        }
    }

    /** The Mac can't be reached: ask the relay whether the ignition helper is polling (ARES quit, Mac awake) or not (asleep). */
    private fun probeRelay() {
        val relay = PowerStore.relay ?: return
        if (PowerStore.reach || PowerStore.igniting) return
        thread(name = "ares-relay-status") {
            val a = runCatching { RelayClient(relay).status() }.getOrNull() ?: return@thread
            if (!PowerStore.reach) PowerStore.setHelper(a.helperAgeSec != null && a.helperAgeSec < 360)
        }
    }

    /** ⏻: the bottom sheet with SLIDE TO POWER DOWN. */
    private fun showPowerSheet() {
        powerSheet?.dismiss()
        val d = Dialog(this, R.style.Theme_Ares_Sheet)
        d.setContentView(R.layout.dialog_power)
        d.window?.apply { setGravity(Gravity.BOTTOM); setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); setBackgroundDrawableResource(android.R.color.transparent) }
        val jobs = JobStore.working
        d.findViewById<TextView>(R.id.sheetSub).text = "${if (jobs > 0) "$jobs job${if (jobs == 1) "" else "s"} pause" else "Jobs pause"} · phone access stops"
        val slide = d.findViewById<SlideView>(R.id.slide)
        slide.onDetent = { Haptics.tick(this) }
        slide.onSpringBack = { Haptics.tick(this) }
        slide.onComplete = {
            Haptics.heavy(this); sounds.play("clunk")
            d.dismiss()
            powerAct("powerdown")
        }
        d.findViewById<View>(R.id.sheetCancel).setOnClickListener { d.dismiss() }
        d.setOnDismissListener { powerSheet = null }
        powerSheet = d
        d.show()
    }

    /** The schedule chip: skip tonight's standby. */
    private fun scheduleMenu(anchor: View) {
        val sch = PowerStore.schedule ?: return
        val menu = PopupMenu(this, anchor)
        if (sch.standby != null && !sch.skipped) menu.menu.add(0, 1, 0, "Skip tonight's standby")
        if (PowerStore.canStandby) menu.menu.add(0, 2, 1, "Standby now")
        menu.menu.add(0, 3, 2, "Change: tell ARES, e.g. \"stand by at midnight\"").isEnabled = false
        menu.setOnMenuItemClickListener { when (it.itemId) { 1 -> powerAct("skip"); 2 -> powerAct("standby") }; true }
        menu.show()
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
        stateText.text = when (s) { State.LISTENING -> "LISTENING"; State.THINKING -> "THINKING"; State.SPEAKING -> "SPEAKING"; else -> PowerStore.hint().lowercase() }
        stateText.setTextColor(getColor(when (PowerStore.mode) { PowerStore.Mode.ONLINE, PowerStore.Mode.UNKNOWN -> R.color.cyan; PowerStore.Mode.STANDBY -> R.color.blue; PowerStore.Mode.ASLEEP -> R.color.grey; else -> R.color.gold }))
        val hf = if (session.handsFree) "HF · " else ""
        talk.text = if (s == State.LISTENING) "◉   ${hf}TAP TO SEND" else if (session.handsFree) "◉   ${hf}TAP TO TALK" else "◉   TAP TO TALK"
        talk.isActivated = s == State.LISTENING || session.handsFree
        if (s == State.THINKING) replyView = null
    }

    /** Show words over the reactor now; they fade later (when she's done speaking, or after a while if typed). */
    private fun showCaption(text: String, fadeAfterMs: Long? = null) {
        caption.removeCallbacks(fadeCaption)
        caption.animate().cancel()
        caption.text = text.replace(Regex("\\s+"), " ").trim()
        schematic.dimBottom = true
        caption.alpha = 1f
        if (fadeAfterMs != null) caption.postDelayed(fadeCaption, fadeAfterMs)
    }

    override fun heard(text: String, final: Boolean) {
        val v = heardView ?: add("YOU", text, user = true).also { heardView = it }
        v.text = text
        // Your words as you say them: when they outgrow two lines, the start goes (at a word boundary), the newest stay
        val flat = text.replace(Regex("\\s+"), " ").trim()
        showCaption(if (flat.length <= 100) flat else "…" + flat.takeLast(100).substringAfter(' '))
        if (final) heardView = null
    }

    override fun caption(text: String) { showCaption(text, if (session.state == State.SPEAKING) null else 6000) }

    override fun reply(text: String, final: Boolean) {
        val v = replyView ?: add("ARES", "", user = false).also { replyView = it }
        v.text = text
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

    /** COMMS: the conversation slides up from the bottom, like the Mac's drawer. */
    private fun showHistory(open: Boolean) {
        if (open) {
            drawer.visibility = View.VISIBLE
            drawer.alpha = 0f; drawer.animate().alpha(1f).setDuration(180).start()
            drawerPanel.translationY = drawerPanel.height.toFloat().coerceAtLeast(400f)
            drawerPanel.animate().translationY(0f).setDuration(260).setInterpolator(android.view.animation.DecelerateInterpolator()).start()
            scrollDown()
        } else {
            drawerPanel.animate().translationY(drawerPanel.height.toFloat()).setDuration(220).start()
            drawer.animate().alpha(0f).setDuration(220).withEndAction { drawer.visibility = View.INVISIBLE }.start()
        }
    }

    /** The schematic's corner readouts: host and battery from the Mac, jobs from the live line, Claude windows. */
    private var macStatus: org.json.JSONObject? = null
    private fun showReadouts() {
        val st = macStatus
        val online = Ares.status(this) == "online"
        val host = st?.optString("host")?.takeIf { it.isNotBlank() }?.uppercase() ?: "MAC"
        val jobs = JobStore.summary()?.uppercase() ?: "NONE RUNNING"
        val claude = st?.optJSONObject("claude")?.let { c -> listOfNotNull(c.opt("fiveHour")?.takeIf { it != org.json.JSONObject.NULL }?.let { "5H ${it}%" }, c.opt("week")?.takeIf { it != org.json.JSONObject.NULL }?.let { "WEEK ${it}%" }).joinToString(" · ") }?.ifBlank { null } ?: "NO READING"
        val batt = st?.optJSONObject("battery")?.let { b -> "${b.optInt("pct")}% · ${if (b.optBoolean("charging")) "ON POWER" else "ON BATTERY"}" } ?: "—"
        schematic.readouts = listOf("HOST" to "$host · ${if (online) "ONLINE" else "OFFLINE"}", "JOBS" to jobs, "CLAUDE" to claude, "BATTERY" to batt)
    }
    private fun pollStatus() {
        statusPoll?.interrupt()
        statusPoll = thread(name = "ares-status", isDaemon = true) {
            while (!Thread.currentThread().isInterrupted) {
                runCatching { AresClient(this).status() }.onSuccess { macStatus = it }
                runOnUiThread { showReadouts() }
                try { Thread.sleep(45_000) } catch (e: InterruptedException) { return@thread }
            }
        }
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
        if (s == "unpaired") { status.text = "NOT PAIRED"; status.setTextColor(getColor(R.color.amber)) }
        else if (::powerBtn.isInitialized) showPower() // the header reads the Mac's power state
        if (::schematic.isInitialized) showReadouts()
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
        menu.menu.add(0, 10, 0, "Calls")
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
                10 -> startActivity(CallsActivity.intent(this))
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

/**
 * The orb hold (docs/ignition-prompt.md §4d, §4e): a ring fills over ~0.8 s with a light tick at each eighth (firmer near the end)
 * and a heavy thunk at the commit; letting go early cancels; a short press with no movement is a tap.
 */
class HoldDetector(private val ctx: android.content.Context, private val onTap: () -> Unit, private val onHold: () -> Unit, private val onRing: (Float, Boolean) -> Unit) {
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var downAt = 0L
    private var x0 = 0f; private var y0 = 0f
    private var active = false
    private var eighth = 0
    private val slop = ctx.resources.displayMetrics.density * 24f
    private val holdMs = 800L
    private val tick = object : Runnable {
        override fun run() {
            if (!active) return
            val k = ((System.currentTimeMillis() - downAt - 120) / (holdMs - 120).toFloat()).coerceIn(0f, 1f)
            onRing(k, false)
            val e = (k * 8).toInt()
            if (e != eighth) { eighth = e; if (e in 1..5) Haptics.tick(ctx) else if (e in 6..7) Haptics.click(ctx) }
            if (k >= 1f) { active = false; onRing(1f, true); Haptics.heavy(ctx); onHold(); return }
            main.postDelayed(this, 16)
        }
    }
    fun onTouch(e: MotionEvent) {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downAt = System.currentTimeMillis(); x0 = e.x; y0 = e.y; active = true; eighth = 0; main.postDelayed(tick, 120) }
            MotionEvent.ACTION_MOVE -> if (active && (abs(e.x - x0) > slop || abs(e.y - y0) > slop)) cancel()
            MotionEvent.ACTION_UP -> {
                val held = System.currentTimeMillis() - downAt
                if (active) { cancel(); if (held < 350) onTap() }
            }
            MotionEvent.ACTION_CANCEL -> cancel()
        }
    }
    private fun cancel() { if (!active) return; active = false; main.removeCallbacks(tick); onRing(0f, true) }
}
