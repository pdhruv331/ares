package com.dhruv.ares

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Bundle
import android.os.PowerManager
import android.provider.CalendarContract
import android.provider.Settings
import android.text.TextUtils
import android.text.format.DateFormat
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.util.Calendar
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * The ARES launcher (docs/launcher-prompt.md): the phone's home screen when you choose it. Page 0 is the reactor (clock,
 * the job orbs, NEXT and CLAUDE readouts; tap = open ARES, hold = talk), page 1 the cards (calendar, work with approvals and
 * STOP ALL, systems), the dock below, the drawer on an upward swipe. Everything a launcher needs works with the Mac
 * unreachable; only ARES's parts show her state.
 */
class HomeActivity : Activity(), Session.Ui {
    companion object {
        /** The system's Home app picker: to make ARES the home screen, or to switch back. */
        fun chooseHome(c: Context) {
            runCatching { c.startActivity(Intent(Settings.ACTION_HOME_SETTINGS)) }.onFailure { c.startActivity(Intent(Settings.ACTION_SETTINGS)) }
        }
        /** The home screen while it's in front (the assistant summon listens there instead of opening the panel). */
        private var front: java.lang.ref.WeakReference<HomeActivity>? = null
        /** Called by the assistant session: true if the home screen took the summon. */
        fun listenHere(): Boolean = front?.get()?.takeIf { it.resumed }?.summoned() ?: false
        private val EARBUDS = setOf(android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, android.media.AudioDeviceInfo.TYPE_BLE_HEADSET,
            android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO, android.media.AudioDeviceInfo.TYPE_HEARING_AID)
        private const val CALENDAR = 7
        private const val MIC = 8
        private const val REPLY = 9
        private val GREEN = android.graphics.Color.parseColor("#4ADE80")
    }

    private lateinit var session: Session
    private lateinit var pager: HomePager
    private lateinit var page0: FrameLayout
    private lateinit var page1: ScrollView
    private lateinit var reactor: ReactorView
    private lateinit var schematic: SchematicView
    private lateinit var caption: TextView
    private lateinit var hint: TextView
    private lateinit var cards: LinearLayout
    private lateinit var dots: TextView
    private lateinit var dockRow: LinearLayout
    private lateinit var drawer: AppDrawer
    private val dp by lazy { resources.displayMetrics.density }
    private var resumed = false
    private var macStatus: JSONObject? = null
    private var statusPoll: Thread? = null
    private var events: List<Event> = emptyList()
    private var pickSlot = -1
    private var lastState = State.IDLE
    // Readouts that open in place (docs/launcher-v2-prompt.md §4): two tap targets over the callouts, and the open card
    private val readTaps = arrayOfNulls<View>(2)
    private var readCard: View? = null
    private var readScrim: View? = null
    // Notifications (docs/launcher-v2-prompt.md §5)
    private lateinit var overlay: HomeOverlay
    private lateinit var summarise: TextView
    private var callBox: View? = null
    private var replyTo: NotifStore.Item? = null
    private val notesChanged: (NotifStore.Item?) -> Unit = { arrived -> showNotes(arrived) }
    private val fadeCaption = Runnable { caption.animate().alpha(0f).setDuration(600).start(); schematic.dimBottom = readCard != null || callBox != null; showNotes(null) }
    private val jobsChanged = { showJobs() }
    private val powerChanged = { showPower() }
    private val appsChanged = { showDock(); drawer.refresh() }
    private val schemeChanged = { applyScheme() }
    private val powerSave = object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) = showPowerSave() }
    private val testCall = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.action == "com.dhruv.ares.TEST_BUDS") { testBuds = i.getStringExtra("name"); checkBuds(testBuds != null); return }
            if (i.action == "com.dhruv.ares.TEST_MODE") { testMode = i.getStringExtra("mode")?.let { m -> Mode.entries.firstOrNull { it.name.equals(m, true) } }; updateMode() }
            else NotifStore.testCall(i.getStringExtra("name"))
        }
    }

    private data class Event(val id: Long, val title: String, val begin: Long, val end: Long, val allDay: Boolean, val where: String, val about: String = "")

    // Modes (docs/launcher-v2-prompt.md §6)
    private enum class Mode { NONE, MORNING, MEETING, NIGHT, DESK }
    private var mode = Mode.NONE
    private var modeBox: View? = null
    private lateinit var nightLine: TextView
    // Buds (docs/launcher-v2-prompt.md §7): earbuds connected → the earpiece ring and "HOLD A BUD · TALK"
    private var buds: String? = null
    private var holding = false // the reactor is held (push to talk), not a summon
    private val audioDevices = object : android.media.AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out android.media.AudioDeviceInfo>) = checkBuds(added.any { it.type in EARBUDS })
        override fun onAudioDevicesRemoved(removed: Array<out android.media.AudioDeviceInfo>) = checkBuds(false)
    }
    private var testMode: Mode? = null // (debug builds: adb shell am broadcast -a com.dhruv.ares.TEST_MODE --es mode night|morning|meeting|desk|none)
    private val modeTick = object : Runnable { override fun run() { updateMode(); page0.postDelayed(this, 30_000) } }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_home)
        pager = findViewById(R.id.pager)
        page0 = findViewById(R.id.page0)
        page1 = findViewById(R.id.page1)
        reactor = findViewById(R.id.reactor)
        schematic = findViewById(R.id.schematic)
        caption = findViewById(R.id.caption)
        hint = findViewById(R.id.hint)
        cards = findViewById(R.id.cards)
        dots = findViewById(R.id.dots)
        dockRow = findViewById(R.id.dock)
        val content = findViewById<View>(R.id.content)
        val drawerView = findViewById<View>(R.id.drawer)
        findViewById<View>(R.id.root).setOnApplyWindowInsetsListener { _, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            content.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            drawerView.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            WindowInsets.CONSUMED
        }

        session = Session(this, this)
        PowerStore.load(this)
        reactor.levelSource = { session.level }
        // Ambient on the home screen: a calmer frame rate than the app (docs/launcher-prompt.md, battery)
        reactor.maxFps = 30
        schematic.maxFps = 20

        pager.onScroll = { k ->
            schematic.translationX = -k * pager.width * 0.35f
            schematic.alpha = (1f - 0.65f * k.coerceIn(0f, 1f)) * (if (mode == Mode.NIGHT) 0.35f else 1f)
            dots.text = if (k < 0.5f) "● ○" else "○ ●"
        }
        pager.onPage = { p -> closeReadout(); if (p == 1) { if (!askedCalendar()) askCalendar(); loadEvents(); renderCards() } }
        pager.onSwipeUp = { openDrawer() }
        pager.canSwipeUp = { _, _ -> pager.page == 0 || !page1.canScrollVertically(1) }
        findViewById<HomePager>(R.id.bottom).apply { pages = false; onSwipeUp = { openDrawer() } }
        findViewById<View>(R.id.handle).setOnClickListener { openDrawer() }
        page0.setOnLongClickListener { homeMenu(hint); true }
        page0.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> placeReactor() }
        nightLine = TextView(this).apply {
            textSize = 10f; letterSpacing = 0.25f; gravity = Gravity.CENTER; visibility = View.GONE; setPadding(0, (10 * dp).toInt(), 0, 0)
            (this@HomeActivity.findViewById<View>(R.id.clock).parent as LinearLayout).addView(this)
        }
        overlay = findViewById(R.id.overlay)
        overlay.onTap = { openNote(it) }
        overlay.onDismiss = { NotifStore.dismiss(it); showCaption("Dismissed · ${it.app}", 1800) }
        summarise = TextView(this).apply {
            text = "SUMMARISE"; textSize = 9f; letterSpacing = 0.3f; gravity = Gravity.CENTER; visibility = View.GONE
            setPadding((12 * dp).toInt(), (6 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
            layoutParams = FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
            setOnClickListener { summariseNotes() }
            page0.addView(this)
        }
        for (i in 0..1) readTaps[i] = View(this).apply {
            contentDescription = if (i == 0) "Next events" else "Server"
            layoutParams = FrameLayout.LayoutParams((140 * dp).toInt(), (48 * dp).toInt(), Gravity.TOP or Gravity.START)
            setOnClickListener { openReadout(i) }
            page0.addView(this)
        }

        drawer = AppDrawer(this, drawerView,
            onAsk = { q -> pager.go(0); ask(q) },
            onDock = { app -> addToDock(app) },
            onPick = { app -> if (pickSlot >= 0) setSlot(pickSlot, app.key); pickSlot = -1 })

        holdToTalk()
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
        Apps.listen(appsChanged)
        Apps.load(this)
        Scheme.listen(schemeChanged)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        front = java.lang.ref.WeakReference(this)
        Bubble.home(true)
        getSystemService(android.media.AudioManager::class.java).registerAudioDeviceCallback(audioDevices, null)
        checkBuds(false)
        if (Ares.paired(this)) AresService.start(this)
        JobStore.listen(jobsChanged)
        PowerStore.listen(powerChanged)
        NotifStore.listen(notesChanged)
        if (AresNotifs.enabled(this) && AresNotifs.live == null) runCatching { android.service.notification.NotificationListenerService.requestRebind(android.content.ComponentName(this, AresNotifs::class.java)) }
        showNotes(null)
        page0.removeCallbacks(modeTick); page0.post(modeTick)
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) // (a ringing call on the emulator: adb shell am broadcast -a com.dhruv.ares.TEST_CALL [--es name Mom])
            registerReceiver(testCall, IntentFilter("com.dhruv.ares.TEST_CALL").apply { addAction("com.dhruv.ares.TEST_MODE"); addAction("com.dhruv.ares.TEST_BUDS") }, Context.RECEIVER_EXPORTED)
        registerReceiver(powerSave, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
        showPowerSave()
        showJobs()
        applyScheme()
        loadEvents()
        pollStatus()
        reactor.invalidate(); schematic.invalidate()
    }

    override fun onPause() {
        resumed = false
        Bubble.home(false)
        getSystemService(android.media.AudioManager::class.java).unregisterAudioDeviceCallback(audioDevices)
        session.setHandsFree(false, "left")
        JobStore.unlisten(jobsChanged)
        PowerStore.unlisten(powerChanged)
        NotifStore.unlisten(notesChanged)
        page0.removeCallbacks(modeTick)
        runCatching { unregisterReceiver(powerSave) }
        runCatching { unregisterReceiver(testCall) }
        statusPoll?.interrupt()
        super.onPause()
    }

    override fun onDestroy() {
        Apps.unlisten(appsChanged)
        Scheme.unlisten(schemeChanged)
        session.release()
        super.onDestroy()
    }

    /** Home pressed: back to the reactor page with the drawer shut. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Home always comes back to the reactor: gliding if you're here already, straight there coming back from elsewhere
        if (intent.hasCategory(Intent.CATEGORY_HOME)) {
            closeReadout()
            if (drawer.isOpen) drawer.close(animate = resumed)
            pager.go(0, animate = resumed)
        }
    }

    private fun back() {
        when {
            readCard != null -> closeReadout()
            drawer.isOpen -> drawer.close()
            pager.page != 0 -> pager.go(0)
        }
    }

    // ---- Page 0: the reactor ----------------------------------------------------------------------------------------

    /** Size the reactor to the room between the clock and the hint, and centre the schematic on it. */
    private fun placeReactor() {
        val clock = findViewById<View>(R.id.clock).parent as View
        val top = clock.bottom + 8 * dp
        val bottom = hint.top - 4 * dp
        val avail = bottom - top
        if (avail <= 0 || page0.width == 0) return
        val r = min(page0.width * 0.29f, avail * 0.25f)
        val size = (r * 2 / 0.92f).toInt()
        val cy = top + avail * 0.44f
        val lp = reactor.layoutParams as FrameLayout.LayoutParams
        val topMargin = (cy - size / 2f).toInt()
        if (lp.width != size || lp.topMargin != topMargin) {
            lp.width = size; lp.height = size; lp.topMargin = topMargin
            reactor.layoutParams = lp
            (caption.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = (cy + r * 1.18f).toInt(); caption.layoutParams = it }
        }
        reactor.post {
            val rl = IntArray(2).also(reactor::getLocationInWindow)
            val sl = IntArray(2).also(schematic::getLocationInWindow)
            val x = rl[0] - page0.translationX - (sl[0] - schematic.translationX) + reactor.width / 2f
            val y = (rl[1] - sl[1]) + reactor.height / 2f
            schematic.center = floatArrayOf(x, y, reactor.width / 2f * 0.92f)
            // The callouts' text boxes, as SchematicView draws them (14dp in from the edges, 1.72 r below the centre), in page coordinates
            val r = reactor.width / 2f * 0.92f
            val by = (y + r * 1.72f).coerceIn(60 * dp, schematic.height - 20 * dp)
            val pl = IntArray(2).also(page0::getLocationInWindow)
            val ox = sl[0] - schematic.translationX - (pl[0] - page0.translationX); val oy = (sl[1] - pl[1]).toFloat()
            readTaps[0]?.apply { translationX = ox + 6 * dp; translationY = oy + by - 26 * dp }
            readTaps[1]?.apply { translationX = ox + schematic.width - 146 * dp; translationY = oy + by - 26 * dp }
            val pcx = reactor.left + reactor.width / 2f; val pcy = reactor.top + reactor.height / 2f
            overlay.place(pcx, pcy, r)
            summarise.translationY = pcy + r * 1.2f
        }
    }

    /** Tap = open ARES (or an orb's job, or hush her); hold ~0.3 s = talk until you let go. */
    @SuppressLint("ClickableViewAccessibility")
    private fun holdToTalk() {
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        var x0 = 0f; var y0 = 0f; var downAt = 0L; var talking = false
        val start = Runnable {
            if (!Ares.paired(this) || PowerStore.mode != PowerStore.Mode.ONLINE) { Haptics.error(this); showCaption(notReady(), 3500); return@Runnable }
            if (!needMic()) return@Runnable
            talking = true; holding = true
            reactor.parent.requestDisallowInterceptTouchEvent(true) // keep the finger: no page swipe while talking
            Haptics.click(this)
            if (session.state == State.SPEAKING) session.hush()
            if (!session.listening) session.startListening()
        }
        reactor.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    // Only the circle (and the orbs just outside it) is hers; the view's corners belong to the page (long-press menu)
                    val r = min(v.width, v.height) / 2f
                    if (Math.hypot((e.x - v.width / 2f).toDouble(), (e.y - v.height / 2f).toDouble()) > r) return@setOnTouchListener false
                    x0 = e.x; y0 = e.y; downAt = System.currentTimeMillis(); talking = false; v.postDelayed(start, 320)
                }
                MotionEvent.ACTION_MOVE -> if (!talking && (abs(e.x - x0) > slop || abs(e.y - y0) > slop)) v.removeCallbacks(start)
                MotionEvent.ACTION_UP -> {
                    v.removeCallbacks(start)
                    if (talking) { talking = false; holding = false; if (session.listening) session.stopListening() }
                    else if (System.currentTimeMillis() - downAt < 320) tapReactor(e.x, e.y)
                }
                MotionEvent.ACTION_CANCEL -> { v.removeCallbacks(start); if (talking) { talking = false; holding = false; session.cancelListening() } }
            }
            true
        }
    }

    private fun tapReactor(x: Float, y: Float) {
        reactor.orbAt(x, y)?.let { startActivity(WorkActivity.intent(this, it)); return }
        when {
            session.state == State.SPEAKING -> session.hush()
            session.listening -> session.stopListening()
            else -> {
                val opts = android.app.ActivityOptions.makeScaleUpAnimation(reactor, 0, 0, reactor.width, reactor.height).toBundle()
                startActivity(Intent(this, MainActivity::class.java), opts)
            }
        }
    }

    private fun notReady() = if (!Ares.paired(this)) "Tap to set up ARES." else PowerStore.hint().replace('\n', ' ').ifBlank { "Connecting to the Mac…" }

    private fun ask(q: String) {
        if (!Ares.paired(this) || PowerStore.mode != PowerStore.Mode.ONLINE) { Haptics.error(this); showCaption(notReady(), 3500); return }
        showCaption(q, 2500)
        session.ask(q, voice = false)
    }

    /** The reactor shows the Mac's state; the hint says what tapping and holding do now. */
    private fun showPower() {
        reactor.power = PowerStore.reactorPower
        reactor.chargeK = PowerStore.chargeK
        state(session.state)
        showReadouts()
        if (pager.page == 1) renderCards()
    }

    private fun showPowerSave() {
        val save = getSystemService(PowerManager::class.java).isPowerSaveMode
        reactor.still = save; schematic.still = save; overlay.still = save
    }

    private fun showJobs() {
        reactor.jobs(JobStore.list())
        showReadouts()
        if (pager.page == 1) renderCards()
    }

    /** The bottom two callouts: NEXT (the next event) and SERVER (the Mac's state and jobs); each hides with nothing to say. */
    private fun showReadouts() {
        val on = Ares.prefs(this).getBoolean("homeCallouts", true)
        val now = System.currentTimeMillis()
        val next = events.firstOrNull { !it.allDay && it.end > now }?.let { "${time(it.begin)} ${it.title}".take(24) }
        val jobs = JobStore.working + JobStore.waiting
        val server = if (!Ares.paired(this)) null else if (PowerStore.mode == PowerStore.Mode.ONLINE && jobs > 0) "ONLINE · $jobs JOB${if (jobs == 1) "" else "S"}" else PowerStore.header()
        val empty = "" to ""
        schematic.readouts = listOf(empty, empty, if (on && next != null) "NEXT" to next else empty, if (on && server != null) "SERVER" to server else empty)
        readTaps[0]?.visibility = if (on && next != null) View.VISIBLE else View.GONE
        readTaps[1]?.visibility = if (on && server != null) View.VISIBLE else View.GONE
    }

    /** A readout grows into a card where it is (left = NEXT, right = SERVER); a tap anywhere else folds it back. */
    private fun openReadout(which: Int) {
        if (readCard != null) return closeReadout()
        Haptics.tick(this)
        val c = card(if (which == 0) "NEXT" else "SERVER", if (which == 0) "CALENDAR" else macStatus?.optString("host")?.takeIf { it.isNotBlank() && PowerStore.reach }?.uppercase(), add = false)
        if (which == 0) {
            val now = System.currentTimeMillis()
            val list = events.filter { it.end > now }.take(3)
            if (!hasCalendar()) c.addView(row("Show your calendar here ›", null, Scheme.color) { closeReadout(); askCalendar() })
            else if (list.isEmpty()) c.addView(row("Nothing coming up.", null, getColor(R.color.muted), null))
            for (e in list) c.addView(row(if (e.allDay) "All day · ${e.title}" else "${time(e.begin)} ${e.title}", whenLabel(e), getColor(R.color.text)) { openEvent(e) })
        } else {
            val st = macStatus?.takeIf { PowerStore.reach }
            val batt = st?.optJSONObject("battery")?.let { b -> "${b.optInt("pct")}% · ${if (b.optBoolean("charging")) "on power" else "battery"}" }
            c.addView(row("Status", listOfNotNull(PowerStore.header().lowercase(), batt).joinToString(" · "), getColor(R.color.text)) { closeReadout(); startActivity(Intent(this, MainActivity::class.java)) })
            val jobs = listOfNotNull(JobStore.working.takeIf { it > 0 }?.let { "$it running" }, JobStore.waiting.takeIf { it > 0 }?.let { "$it need${if (it == 1) "s" else ""} OK" }).joinToString(" · ").ifBlank { "none" }
            c.addView(row("Jobs", jobs, getColor(R.color.text)) { closeReadout(); startActivity(WorkActivity.intent(this)) })
            val claude = st?.optJSONObject("claude")?.let { cl -> listOfNotNull(cl.opt("fiveHour")?.takeIf { it != JSONObject.NULL }?.let { "5H $it%" }, cl.opt("week")?.takeIf { it != JSONObject.NULL }?.let { "week $it%" }).joinToString(" · ") }?.ifBlank { null }
            if (claude != null) c.addView(row("Claude", claude, getColor(R.color.text), null))
        }
        showCard(c, if (which == 0) 0 else 1)
    }

    /** A card over the bottom of the reactor page (a readout, a notification), growing out of the left or right readout or the middle (2). */
    private fun showCard(c: LinearLayout, from: Int) {
        if (readCard != null) closeReadout()
        val tap = readTaps[0] ?: return
        val scrim = View(this).apply { setOnClickListener { closeReadout() }; layoutParams = FrameLayout.LayoutParams(-1, -1) }
        page0.addView(scrim)
        // The card's bottom sits just under the readouts' text
        c.layoutParams = FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply {
            leftMargin = (16 * dp).toInt(); rightMargin = (16 * dp).toInt()
            bottomMargin = (page0.height - (tap.translationY + tap.height)).toInt().coerceAtLeast(0)
        }
        page0.addView(c)
        readCard = c; readScrim = scrim
        schematic.dimBottom = true
        summarise.visibility = View.GONE
        c.alpha = 0f
        c.post {
            c.pivotX = when (from) { 0 -> 0f; 1 -> c.width.toFloat(); else -> c.width / 2f }; c.pivotY = if (from == 2) 0f else c.height.toFloat()
            c.scaleX = 0.15f; c.scaleY = 0.15f
            c.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(android.view.animation.DecelerateInterpolator(1.6f)).start()
        }
    }

    private fun closeReadout() {
        val c = readCard ?: return
        val s = readScrim
        readCard = null; readScrim = null
        schematic.dimBottom = false
        showNotes(null)
        c.animate().alpha(0f).scaleX(0.15f).scaleY(0.15f).setDuration(200).withEndAction { page0.removeView(c) }.start()
        s?.let(page0::removeView)
    }

    // ---- Notifications (docs/launcher-v2-prompt.md §5) -------------------------------------------------------------------

    private fun showNotes(arrived: NotifStore.Item?) {
        val items = NotifStore.items
        overlay.notes = items
        summarise.visibility = if (items.size >= 2 && readCard == null && callBox == null && Ares.paired(this)) View.VISIBLE else View.GONE
        summarise.setTextColor(Scheme.color)
        summarise.background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = 14 * dp; setColor(Scheme.alpha(18)); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(90)) }
        summarise.text = "SUMMARISE · ${items.size}"
        showCall(NotifStore.call)
        if (arrived != null && resumed && pager.page == 0) overlay.spark {
            reactor.pulse()
            showCaption("${arrived.app} · ${arrived.title}", 2600)
        }
    }

    /** A notification orb tapped: what it says, and reply by voice / open / dismiss. */
    private fun openNote(n: NotifStore.Item) {
        Haptics.tick(this)
        val accent = if (n.person) getColor(R.color.amber) else Scheme.color
        val c = card(n.app.uppercase(), DateFormat.getTimeFormat(this).format(java.util.Date(n.time)), add = false)
        if (n.title.isNotEmpty()) c.addView(TextView(this).apply { text = n.title; textSize = 14f; setTextColor(getColor(R.color.text)); setPadding(0, (2 * dp).toInt(), 0, (4 * dp).toInt()) })
        if (n.text.isNotEmpty()) c.addView(TextView(this).apply { text = n.text; textSize = 12f; setTextColor(getColor(R.color.text_user)); maxLines = 5; ellipsize = TextUtils.TruncateAt.END })
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END; setPadding(0, (10 * dp).toInt(), 0, 0)
            addView(pill("DISMISS", Scheme.color, null) { closeReadout(); NotifStore.dismiss(n) })
            addView(pill("OPEN", Scheme.color, null) { closeReadout(); NotifStore.open(this@HomeActivity, n) })
            if (n.reply != null) addView(pill("REPLY BY VOICE", accent, if (n.person) R.drawable.bg_amber else null) { closeReadout(); startReply(n) })
        })
        showCard(c, 2)
    }

    private fun startReply(n: NotifStore.Item) {
        replyTo = n
        runCatching {
            startActivityForResult(Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Reply to ${n.title.ifBlank { n.app }}"), REPLY)
        }.onFailure { Toast.makeText(this, "No speech recogniser on this phone.", Toast.LENGTH_SHORT).show() }
    }

    @Deprecated("Activity result for the voice reply")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REPLY) return
        val n = replyTo ?: return
        val said = data?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
        if (resultCode != RESULT_OK || said.isNullOrEmpty()) return
        // The words are shown before anything is sent
        val c = card("REPLY", n.title.ifBlank { n.app }.uppercase().take(24), add = false)
        c.addView(TextView(this).apply { text = "“$said”"; textSize = 14f; setTextColor(getColor(R.color.text)) })
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END; setPadding(0, (10 * dp).toInt(), 0, 0)
            addView(pill("CANCEL", Scheme.color, null) { closeReadout() })
            addView(pill("SEND", getColor(R.color.amber), R.drawable.bg_amber) {
                closeReadout()
                val ok = NotifStore.reply(this@HomeActivity, n, said)
                showCaption(if (ok) "Sent to ${n.title.ifBlank { n.app }}." else "That reply didn't go through.", 2500)
            })
        })
        showCard(c, 2)
    }

    /** SUMMARISE: the only path that sends the notifications' text to ARES (on the Mac), and only on a tap. */
    private fun summariseNotes() {
        val items = NotifStore.items
        if (items.isEmpty()) return
        val lines = items.take(12).joinToString("\n") { "- ${it.app}: ${it.title}${if (it.text.isNotBlank()) " — " + it.text.take(200) else ""}" }
        if (!Ares.paired(this) || PowerStore.mode != PowerStore.Mode.ONLINE) { Haptics.error(this); showCaption(notReady(), 3500); return }
        Haptics.tick(this)
        session.ask("Summarise my phone's notifications in a sentence or two, and tell me if anyone is waiting for an answer:\n$lines", voice = true)
    }

    /** A ringing call: the rings go green and ripple out; ANSWER / DECLINE are the call's own buttons. */
    private fun showCall(call: NotifStore.Call?) {
        val modeTint = if (mode == Mode.NIGHT) getColor(R.color.blue) else null
        reactor.tintOverride = if (call != null) GREEN else modeTint
        schematic.tintOverride = if (call != null) GREEN else modeTint
        overlay.ringing = call != null
        callBox?.let(page0::removeView); callBox = null
        if (call == null) { schematic.dimBottom = readCard != null || modeBox != null; return }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { bottomMargin = (40 * dp).toInt() }
            addView(TextView(this@HomeActivity).apply { text = "INCOMING · ${call.name.uppercase()}"; textSize = 12f; letterSpacing = 0.3f; setTextColor(GREEN); gravity = Gravity.CENTER })
            addView(LinearLayout(this@HomeActivity).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(0, (14 * dp).toInt(), 0, 0)
                addView(pill("DECLINE", android.graphics.Color.parseColor("#FF6050"), null) { NotifStore.fire(this@HomeActivity, call.decline) })
                addView(pill("ANSWER", GREEN, null) { NotifStore.fire(this@HomeActivity, call.answer ?: call.content) })
            })
        }
        page0.addView(box)
        callBox = box
        schematic.dimBottom = true
        summarise.visibility = View.GONE
    }

    // ---- Buds (docs/launcher-v2-prompt.md §7) -----------------------------------------------------------------------------

    /** Which earbuds are connected now (by their name), shown as the earpiece ring; `arrived` = they just connected. */
    private fun checkBuds(arrived: Boolean) {
        val am = getSystemService(android.media.AudioManager::class.java)
        val dev = am.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.type in EARBUDS }
        val was = buds
        buds = testBuds ?: dev?.productName?.toString()?.ifBlank { "Earbuds" }
        overlay.buds = buds?.let { "$it · connected" }
        if (buds != null && was == null && arrived) { Haptics.soft(this); reactor.pulse(); showCaption("$buds connected", 2500) }
        state(session.state)
    }
    private var testBuds: String? = null // (debug builds: adb shell am broadcast -a com.dhruv.ares.TEST_BUDS [--es name 'Galaxy Buds Pro 4'])

    /** The assistant was summoned while the home screen is in front: listen here, on the home screen's own session. */
    private fun summoned(): Boolean {
        if (PowerStore.mode != PowerStore.Mode.ONLINE) return false // (the panel explains what's wrong)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
        pager.go(0); closeReadout(); if (drawer.isOpen) drawer.close()
        Haptics.click(this)
        if (session.state == State.SPEAKING) session.hush()
        if (!session.listening) session.startListening()
        return true
    }

    // ---- Modes (docs/launcher-v2-prompt.md §6) ----------------------------------------------------------------------------

    private val meetingLink = Regex("(https?://)?[\\w.-]*(zoom\\.us|meet\\.google\\.com|teams\\.microsoft\\.com|teams\\.live\\.com|webex\\.com)/[^\\s<>\"]*", RegexOption.IGNORE_CASE)

    /** Which mode the home screen is in now: a meeting soon, night, the morning brief, at the Mac, or none. */
    private fun updateMode() {
        if (!::nightLine.isInitialized) return
        val now = System.currentTimeMillis()
        val cal = Calendar.getInstance()
        val minute = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        val today = "${cal.get(Calendar.YEAR)}-${cal.get(Calendar.DAY_OF_YEAR)}"
        val soon = events.firstOrNull { !it.allDay && it.begin > now && it.begin - now <= 15 * 60_000 }
        val st = macStatus?.takeIf { PowerStore.reach }
        val atMac = PowerStore.mode == PowerStore.Mode.ONLINE && st != null && st.has("idle") && st.optInt("idle", 9999) < 120 && !st.optBoolean("locked")
        val next = testMode ?: when {
            soon != null -> Mode.MEETING
            minute >= 22 * 60 + 30 || minute < 6 * 60 -> Mode.NIGHT
            minute in 5 * 60 until 12 * 60 && Ares.prefs(this).getString("homeMorning", null) != today -> Mode.MORNING
            atMac -> Mode.DESK
            else -> Mode.NONE
        }
        showMode(next, soon, today)
    }

    private fun showMode(m: Mode, soon: Event?, today: String) {
        val was = mode
        mode = m
        // Night: dim blue, the reactor almost still, a quiet clock with the next alarm, the dock stepped back
        val night = m == Mode.NIGHT
        if (NotifStore.call == null) { reactor.tintOverride = if (night) getColor(R.color.blue) else null; schematic.tintOverride = if (night) getColor(R.color.blue) else null }
        reactor.ambient = if (night) 0.12f else 1f
        schematic.alpha = (1f - 0.65f * pager.page) * (if (night) 0.35f else 1f)
        findViewById<View>(R.id.clock).alpha = if (night) 0.5f else 1f
        findViewById<View>(R.id.date).visibility = if (night) View.GONE else View.VISIBLE
        nightLine.visibility = if (night) View.VISIBLE else View.GONE
        if (night) {
            val alarm = getSystemService(android.app.AlarmManager::class.java).nextAlarmClock?.triggerTime
            nightLine.setTextColor(getColor(R.color.blue))
            nightLine.text = if (alarm == null || alarm - System.currentTimeMillis() > 20 * 3600_000L) "NO ALARM SET"
                else ((alarm - System.currentTimeMillis()) / 60_000).let { mins -> "ALARM ${time(alarm)} · ${mins / 60}H ${mins % 60}M OF SLEEP".uppercase() }
        }
        findViewById<View>(R.id.bottom).alpha = if (night) 0.4f else 1f
        overlay.alpha = if (night) 0.45f else 1f; summarise.alpha = if (night) 0.45f else 1f
        overlay.deskLink = m == Mode.DESK
        overlay.countdown = soon?.let { 1f - ((it.begin - System.currentTimeMillis()) / (15 * 60_000f)) }
        if (was != m || m == Mode.MEETING) {
            modeBox?.let(page0::removeView); modeBox = null
            when (m) {
                Mode.MEETING -> soon?.let { e ->
                    val mins = ((e.begin - System.currentTimeMillis()) / 60_000).coerceAtLeast(1)
                    val link = meetingLink.find(e.where + " " + e.about + " " + e.title)?.value?.let { if (it.startsWith("http")) it else "https://$it" }
                    modeBox = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
                        layoutParams = FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { bottomMargin = (40 * dp).toInt() }
                        addView(TextView(this@HomeActivity).apply { text = "${e.title.uppercase().take(22)} · IN $mins MIN"; textSize = 12f; letterSpacing = 0.25f; setTextColor(getColor(R.color.amber)); gravity = Gravity.CENTER })
                        addView(LinearLayout(this@HomeActivity).apply {
                            gravity = Gravity.CENTER; setPadding(0, (12 * dp).toInt(), 0, 0)
                            addView(pill(if (link != null) "JOIN" else "OPEN", getColor(R.color.amber), R.drawable.bg_amber) { if (link != null) Ares.open(this@HomeActivity, link) else openEvent(e) })
                        })
                    }
                }
                Mode.MORNING -> {
                    val c = card("GOOD MORNING", null, add = false)
                    val todays = events.filter { !it.allDay && android.text.format.DateUtils.isToday(it.begin) }
                    c.addView(row(if (todays.isEmpty()) "Nothing on the calendar today" else "${todays.size} event${if (todays.size == 1) "" else "s"} · first at ${time(todays.first().begin)}", null, getColor(R.color.text), null))
                    val done = JobStore.list().count { it.status == "done" && !it.seen }
                    if (done > 0) c.addView(row("$done job${if (done == 1) "" else "s"} finished overnight", null, getColor(R.color.text)) { startActivity(WorkActivity.intent(this)) })
                    if (Ares.paired(this)) c.addView(row("Server ${PowerStore.header().lowercase()}", null, getColor(R.color.text_user), null))
                    c.layoutParams = FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { leftMargin = (16 * dp).toInt(); rightMargin = (16 * dp).toInt(); bottomMargin = (34 * dp).toInt() }
                    c.setOnClickListener { Ares.prefs(this).edit().putString("homeMorning", today).apply(); updateMode() }
                    modeBox = c
                }
                else -> {}
            }
            modeBox?.let(page0::addView)
        }
        schematic.dimBottom = readCard != null || callBox != null || modeBox != null
        readTaps.forEach { it?.isEnabled = modeBox == null }
        if (was != m) state(session.state)
    }

    private fun notificationsMenu() {
        val on = AresNotifs.enabled(this)
        val b = AlertDialog.Builder(this).setTitle("Notifications on the home screen")
            .setMessage(if (on) "On: your notifications gather around the reactor. They stay on the phone; only Summarise sends their text to ARES on your Mac.\n\nIf one doesn't show as an orb, \"What ARES sees\" says why.\n\nTo turn it off, switch ARES off on the next screen."
                else "Your notifications can gather as orbs around the reactor: tap one to read it and reply by voice, drag it into the core to dismiss it. Calls make the rings pulse green.\n\nThey stay on the phone; only Summarise (when you tap it) sends their text to ARES on your Mac.\n\nOn the next screen, allow Notification access for ARES.\n\nIf the switch is greyed out (\"Restricted setting\"): ARES wasn't installed from the Play Store, so Android asks once. Tap App info, then ⋮ at the top right → Allow restricted settings, and come back here.")
            .setPositiveButton("Open settings") { _, _ -> runCatching { startActivity(AresNotifs.settings(this)) }.onFailure { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } }
        if (on) b.setNeutralButton("What ARES sees") { _, _ -> notificationCheck() }
        else b.setNeutralButton("App info") { _, _ -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))) }
        b.setNegativeButton("Close", null).show()
    }

    /** What the listener sees (apps, categories, buttons; never the words), and why each did or didn't become an orb. */
    private fun notificationCheck() {
        if (AresNotifs.enabled(this) && AresNotifs.live == null) runCatching { android.service.notification.NotificationListenerService.requestRebind(android.content.ComponentName(this, AresNotifs::class.java)) }
        val report = NotifStore.explain(this)
        val text = TextView(this).apply {
            this.text = report; textSize = 11f; typeface = android.graphics.Typeface.MONOSPACE; setTextColor(getColor(R.color.text)); setTextIsSelectable(true)
            setPadding((20 * dp).toInt(), (12 * dp).toInt(), (20 * dp).toInt(), (12 * dp).toInt())
        }
        AlertDialog.Builder(this).setTitle("What ARES sees").setView(ScrollView(this).apply { addView(text) })
            .setPositiveButton("Copy") { _, _ ->
                getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("What ARES sees", report))
                Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Close", null).show()
    }

    private fun openEvent(e: Event) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, e.id))
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, e.begin).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, e.end)) }
    }

    private fun pollStatus() {
        statusPoll?.interrupt()
        if (!Ares.paired(this)) return
        statusPoll = thread(name = "ares-home-status", isDaemon = true) {
            while (!Thread.currentThread().isInterrupted) {
                runCatching { AresClient(this).status() }.onSuccess { macStatus = it }
                runOnUiThread { showReadouts(); updateMode(); if (pager.page == 1) renderCards() }
                try { Thread.sleep(60_000) } catch (e: InterruptedException) { return@thread }
                runOnUiThread { loadEvents() }
            }
        }
    }

    // ---- Session.Ui: talking from the home screen ---------------------------------------------------------------------

    override fun state(s: State) {
        reactor.state = s
        if (s == State.IDLE && lastState == State.SPEAKING) caption.postDelayed(fadeCaption, 1200)
        if (s == State.THINKING) { caption.removeCallbacks(fadeCaption); caption.postDelayed(fadeCaption, 2500) }
        lastState = s
        hint.text = when {
            s == State.LISTENING -> if (holding) "LISTENING · LET GO TO SEND" else "LISTENING"
            s == State.THINKING -> "THINKING"
            s == State.SPEAKING -> "SPEAKING · TAP TO STOP"
            !Ares.paired(this) -> "TAP TO SET UP ARES"
            mode == Mode.NIGHT -> "GOOD NIGHT"
            buds != null && PowerStore.mode == PowerStore.Mode.ONLINE && mode != Mode.DESK -> "HOLD A BUD · TALK"
            mode == Mode.DESK && PowerStore.mode == PowerStore.Mode.ONLINE -> "LINKED TO THE MAC"
            PowerStore.mode == PowerStore.Mode.ONLINE -> "HOLD · TALK     TAP · OPEN"
            else -> PowerStore.header()
        }
        hint.setTextColor(when (PowerStore.mode) {
            PowerStore.Mode.ONLINE, PowerStore.Mode.UNKNOWN -> if (mode == Mode.NIGHT) getColor(R.color.blue) else Scheme.color; PowerStore.Mode.STANDBY -> getColor(R.color.blue)
            PowerStore.Mode.ASLEEP -> getColor(R.color.grey); else -> getColor(R.color.gold)
        })
    }

    private fun showCaption(text: String, fadeAfterMs: Long? = null) {
        caption.removeCallbacks(fadeCaption)
        caption.animate().cancel()
        caption.text = text.replace(Regex("\\s+"), " ").trim()
        schematic.dimBottom = true
        caption.alpha = 0.75f // (subtle: small, muted, never at full strength)
        summarise.visibility = View.GONE
        if (fadeAfterMs != null) caption.postDelayed(fadeCaption, fadeAfterMs)
    }

    override fun heard(text: String, final: Boolean) {
        val flat = text.replace(Regex("\\s+"), " ").trim()
        showCaption(if (flat.length <= 100) flat else "…" + flat.takeLast(100).substringAfter(' '))
    }
    override fun caption(text: String) = showCaption(text, if (session.state == State.SPEAKING) null else 6000)
    override fun reply(text: String, final: Boolean) {}
    override fun action(url: String, label: String) { Ares.open(this, url) }
    override fun offline(message: String) = showCaption(message, 5000)

    private fun needMic(): Boolean {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC)
        return false
    }

    // ---- The long-press menu ------------------------------------------------------------------------------------------

    private fun homeMenu(anchor: View) {
        Haptics.click(this)
        val p = Ares.prefs(this)
        val m = PopupMenu(this, anchor, Gravity.CENTER)
        m.menu.add(0, 1, 0, "Open ARES")
        if (Ares.paired(this) && PowerStore.canStandby) m.menu.add(0, 2, 1, "Standby")
        if (Ares.paired(this) && (PowerStore.mode == PowerStore.Mode.STANDBY || PowerStore.mode == PowerStore.Mode.OFFLINE)) m.menu.add(0, 3, 1, "Wake ARES")
        if (Ares.paired(this) && (PowerStore.mode == PowerStore.Mode.ONLINE || PowerStore.mode == PowerStore.Mode.STANDBY)) m.menu.add(0, 7, 1, "Power down…")
        m.menu.add(1, 8, 2, "Colour scheme…")
        m.menu.add(1, 9, 2, "Notifications on the home screen…" + if (AresNotifs.enabled(this)) "" else " (off)")
        m.menu.add(1, 4, 2, "Original icons").apply { isCheckable = true; isChecked = Icons.original(this@HomeActivity) }
        m.menu.add(1, 5, 3, "Readouts on the reactor").apply { isCheckable = true; isChecked = p.getBoolean("homeCallouts", true) }
        m.menu.add(1, 6, 4, "Home screen app…")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> startActivity(Intent(this, MainActivity::class.java))
                2 -> powerAct("standby")
                3 -> powerAct("wake")
                7 -> PowerSheet.show(this) { powerAct("powerdown") }
                8 -> chooseScheme()
                9 -> notificationsMenu()
                4 -> { p.edit().putBoolean("homeOriginalIcons", !Icons.original(this)).apply(); Icons.clear(); showDock(); drawer.refresh() }
                5 -> { p.edit().putBoolean("homeCallouts", !p.getBoolean("homeCallouts", true)).apply(); showReadouts() }
                6 -> AlertDialog.Builder(this).setTitle("Home screen app")
                    .setMessage("Choose ARES to keep this home screen, or One UI Home to go back to Samsung's. You can change it any time here or in Settings → Apps → Default apps → Home app.")
                    .setPositiveButton("Open") { _, _ -> chooseHome(this) }.setNegativeButton("Cancel", null).show()
            }
            true
        }
        m.show()
    }

    /** The colour scheme (docs/launcher-v2-prompt.md §2); the power states keep their fixed colours. */
    private fun chooseScheme() {
        val ids = Scheme.names.keys.toList()
        AlertDialog.Builder(this).setTitle("Colour scheme")
            .setSingleChoiceItems(Scheme.names.values.toTypedArray(), ids.indexOf(Scheme.id())) { d, i -> Scheme.set(this, ids[i]); d.dismiss() }
            .setNegativeButton("Cancel", null).show()
    }

    /** Everything on the home screen that wears the scheme's colour. */
    private fun applyScheme() {
        val c = Scheme.color
        findViewById<TextView>(R.id.date).setTextColor(Scheme.alpha(179))
        dots.setTextColor(c)
        findViewById<TextView>(R.id.handle).setTextColor(Scheme.alpha(153))
        state(session.state)
        showDock(); drawer.refresh()
        if (pager.page == 1) renderCards()
        reactor.invalidate(); schematic.invalidate()
    }

    private fun powerAct(action: String) {
        thread(name = "ares-home-power") {
            val r = runCatching { AresClient(this).powerAct(action) }
            runOnUiThread {
                val ok = r.getOrNull()?.optBoolean("ok") == true
                if (ok) r.getOrNull()?.let { PowerStore.fromPower(this, it) }
                else { Haptics.error(this); showCaption(r.getOrNull()?.optString("message")?.ifBlank { null } ?: "I couldn't reach the Mac, sir.", 4000) }
            }
        }
    }

    // ---- The dock ------------------------------------------------------------------------------------------------------

    /** The dock: hold an app and drag it sideways to move it (the others slide over); hold without dragging = its menu. */
    private var dockReorder: Reorder? = null
    private fun showDock() {
        if (dockReorder?.dragging == true) { dockRow.postDelayed({ showDock() }, 400); return } // (not under the finger)
        val slots = Apps.dock(this)
        val px = (52 * dp).toInt()
        dockRow.removeAllViews()
        val reorder = Reorder(dockRow, vertical = false) { cells -> Apps.setDock(this, cells.map { it.tag as String? }); showDock(); drawer.refresh() }
        dockReorder = reorder
        reorder.onTap = { cell ->
            val app = (cell.tag as String?)?.let(Apps::find)
            if (app != null) Apps.open(this, app, (cell as FrameLayout).getChildAt(0)) else { pickSlot = dockRow.indexOfChild(cell); drawer.open(pick = true) }
        }
        reorder.onMenu = { cell -> (cell.tag as String?)?.let(Apps::find)?.let { dockMenu(cell, dockRow.indexOfChild(cell), it) } }
        for (key in slots) {
            val app = key?.let(Apps::find)
            val cell = FrameLayout(this).apply { layoutParams = LinearLayout.LayoutParams(0, (60 * dp).toInt(), 1f); tag = app?.key }
            if (app == null) {
                cell.addView(TextView(this).apply {
                    text = "+"; gravity = Gravity.CENTER; textSize = 18f; setTextColor(Scheme.color); alpha = 0.35f
                    background = getDrawable(R.drawable.bg_round); contentDescription = "Add an app to the dock"
                    layoutParams = FrameLayout.LayoutParams((44 * dp).toInt(), (44 * dp).toInt(), Gravity.CENTER)
                })
            } else {
                val icon = ImageView(this).apply { layoutParams = FrameLayout.LayoutParams(px, px, Gravity.CENTER); contentDescription = app.label; tag = app.key }
                Icons.get(this, app, px) { bmp -> if (icon.tag == app.key) icon.setImageBitmap(bmp) }?.let(icon::setImageBitmap)
                cell.addView(icon)
            }
            dockRow.addView(cell)
            reorder.attach(cell)
        }
    }

    private fun dockMenu(anchor: View, slot: Int, app: Apps.App) {
        Haptics.click(this)
        val m = PopupMenu(this, anchor)
        m.menu.add(0, 1, 0, "Replace…")
        m.menu.add(0, 2, 1, "Remove from dock")
        m.menu.add(0, 3, 2, "App info")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> { pickSlot = slot; drawer.open(pick = true) }
                2 -> setSlot(slot, null)
                3 -> runCatching { getSystemService(android.content.pm.LauncherApps::class.java).startAppDetailsActivity(app.component, app.user, null, null) }
            }
            true
        }
        m.show()
    }

    private fun setSlot(slot: Int, key: String?) {
        Apps.setDock(this, Apps.dock(this).toMutableList().also { it[slot] = key })
        showDock(); drawer.refresh()
    }

    /** "Add to dock" from the drawer: the first empty slot, or ask which one to replace. */
    private fun addToDock(app: Apps.App) {
        val slots = Apps.dock(this)
        val empty = slots.indexOfFirst { it == null || Apps.find(it) == null }
        if (empty >= 0) return setSlot(empty, app.key)
        val names = slots.map { k -> k?.let(Apps::find)?.label ?: "(empty)" }.toTypedArray()
        AlertDialog.Builder(this).setTitle("Replace which?").setItems(names) { _, i -> setSlot(i, app.key) }.setNegativeButton("Cancel", null).show()
    }

    private fun openDrawer() { Haptics.tick(this); drawer.open() }

    // ---- Page 1: the cards ----------------------------------------------------------------------------------------------

    private fun hasCalendar() = checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
    private fun askedCalendar() = hasCalendar() || Ares.prefs(this).getBoolean("homeCalendarAsked", false)
    private fun askCalendar() {
        Ares.prefs(this).edit().putBoolean("homeCalendarAsked", true).apply()
        requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), CALENDAR)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CALENDAR) loadEvents()
    }

    /** Today's and tomorrow's events, read on the phone (works with the Mac off). */
    private fun loadEvents() {
        if (!hasCalendar()) { events = emptyList(); showReadouts(); if (pager.page == 1) renderCards(); return }
        thread(name = "ares-home-calendar") {
            val now = System.currentTimeMillis()
            val end = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, 2); set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0) }.timeInMillis
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it, now - 6 * 3600_000L); ContentUris.appendId(it, end) }.build()
            val cols = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN,
                CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.DESCRIPTION)
            val list = runCatching {
                contentResolver.query(uri, cols, "${CalendarContract.Instances.VISIBLE} = 1", null, "${CalendarContract.Instances.BEGIN} ASC")?.use { c ->
                    buildList { while (c.moveToNext()) add(Event(c.getLong(0), c.getString(1).orEmpty().ifBlank { "(no title)" }, c.getLong(2), c.getLong(3), c.getInt(4) == 1, c.getString(5).orEmpty(), c.getString(6).orEmpty())) }
                }.orEmpty()
            }.getOrDefault(emptyList()).filter { it.end > now }
            runOnUiThread { events = list; showReadouts(); updateMode(); if (pager.page == 1) renderCards() }
        }
    }

    private fun time(ms: Long) = DateFormat.getTimeFormat(this).format(java.util.Date(ms))

    private fun whenLabel(e: Event): String {
        val now = System.currentTimeMillis()
        val today = Calendar.getInstance().apply { set(Calendar.HOUR_OF_DAY, 23); set(Calendar.MINUTE, 59) }.timeInMillis
        return when {
            e.begin <= now -> "now"
            e.allDay -> if (e.begin <= today) "today" else "tomorrow"
            e.begin > today -> "tomorrow"
            e.begin - now < 90 * 60_000 -> "in ${((e.begin - now) / 60_000).coerceAtLeast(1)} min"
            else -> e.where.ifBlank { "today" }
        }
    }

    /** NEXT, WORK, SYSTEMS: each only when it has something to say, in the order you've put them (hold a header and drag). */
    private fun renderCards() {
        if (cardsReorder.dragging) return // (rebuilt once it's dropped)
        cards.removeAllViews()
        val built = mapOf("next" to nextCard(), "work" to workCard(), "systems" to systemsCard())
        if (built["next"] == null && built["work"] == null) cards.addView(TextView(this).apply {
            text = "All quiet."; textSize = 13f; setTextColor(getColor(R.color.muted)); gravity = Gravity.CENTER
            setPadding(0, (28 * dp).toInt(), 0, (28 * dp).toInt())
        })
        for (id in cardOrder()) built[id]?.let { c -> c.tag = id; cards.addView(c); cardsReorder.attach(c.getChildAt(0), c) }
    }

    private val cardsReorder by lazy {
        Reorder(cards, vertical = true) { views ->
            val order = views.mapNotNull { it.tag as? String }
            Ares.prefs(this).edit().putString("homeCards", (order + cardOrder().filter { it !in order }).joinToString(",")).apply()
        }
    }

    private fun cardOrder() = (Ares.prefs(this).getString("homeCards", null)?.split(',') ?: emptyList()).filter { it in setOf("next", "work", "systems") }
        .let { saved -> saved + listOf("next", "work", "systems").filter { it !in saved } }

    private fun nextCard(): LinearLayout? {
        if (!hasCalendar()) return card("NEXT", "CALENDAR", add = false).also { c -> c.addView(row("Show your calendar here ›", null, Scheme.color) { askCalendar() }) }
        if (events.isEmpty()) return null
        val c = card("NEXT", "CALENDAR", add = false)
        for (e in events.take(4)) c.addView(row(if (e.allDay) "All day · ${e.title}" else "${time(e.begin)} ${e.title}", whenLabel(e), getColor(R.color.text)) { openEvent(e) })
        return c
    }

    private fun workCard(): LinearLayout? {
        val active = JobStore.list().filter { it.active }
        if (active.isEmpty()) return null
        val c = card("WORK", "${JobStore.working} RUNNING", add = false)
        for (j in active.take(5)) {
            if (j.status == "approval") {
                c.addView(row(j.approvalWhat?.ifBlank { null } ?: j.title, null, getColor(R.color.amber)) { startActivity(WorkActivity.intent(this, j.id)) })
                c.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
                    setPadding(0, (2 * dp).toInt(), 0, (6 * dp).toInt())
                    addView(pill("REVIEW", Scheme.color, null) { startActivity(WorkActivity.intent(this@HomeActivity, j.id)) })
                    addView(pill("OK", getColor(R.color.amber), R.drawable.bg_amber) { approve(j) })
                })
            } else c.addView(row(j.title, if (j.status == "queued") "queued" else if (j.steps > 0) "${j.steps} steps" else "working", getColor(R.color.text)) {
                startActivity(WorkActivity.intent(this, j.id))
            })
        }
        c.addView(LinearLayout(this).apply {
            gravity = Gravity.END; setPadding(0, (6 * dp).toInt(), 0, 0)
            addView(pill("STOP ALL", getColor(R.color.amber), R.drawable.bg_amber) { stopAll() })
        })
        return c
    }

    private fun systemsCard(): LinearLayout {
        val c = card("SYSTEMS", null, add = false)
        if (Ares.paired(this)) {
            val st = macStatus?.takeIf { PowerStore.reach } // (no stale readings while she can't be reached)
            val host = st?.optString("host")?.takeIf { it.isNotBlank() } ?: "Mac"
            val batt = st?.optJSONObject("battery")?.let { b -> "${b.optInt("pct")}% · ${if (b.optBoolean("charging")) "on power" else "battery"}" }
            c.addView(row(host, listOfNotNull(PowerStore.header().lowercase(), batt).joinToString(" · "), getColor(R.color.text)) { startActivity(Intent(this, MainActivity::class.java)) })
            val claude = st?.optJSONObject("claude")?.let { cl -> listOfNotNull(cl.opt("fiveHour")?.takeIf { it != JSONObject.NULL }?.let { "5H $it%" }, cl.opt("week")?.takeIf { it != JSONObject.NULL }?.let { "WEEK $it%" }).joinToString(" · ") }?.ifBlank { null }
            if (claude != null) c.addView(row("Claude", claude, getColor(R.color.text), null))
        }
        val phone = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val pct = phone?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) }
        val plugged = (phone?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        if (pct != null && pct >= 0) c.addView(row("This phone", "$pct%${if (plugged) " · charging" else ""}", getColor(R.color.text), null))
        return c
    }

    private fun card(title: String, right: String?, add: Boolean = true): LinearLayout {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; background = cardBg()
            setPadding((14 * dp).toInt(), (12 * dp).toInt(), (14 * dp).toInt(), (10 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = (10 * dp).toInt() }
        }
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(0, 0, 0, (6 * dp).toInt())
            addView(TextView(this@HomeActivity).apply { text = title; textSize = 9f; letterSpacing = 0.3f; setTextColor(Scheme.color); layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f) })
            if (right != null) addView(TextView(this@HomeActivity).apply { text = right; textSize = 9f; letterSpacing = 0.2f; setTextColor(Scheme.alpha(89)) })
        })
        if (add) cards.addView(c)
        return c
    }

    private fun row(left: String, right: String?, colour: Int, onClick: (() -> Unit)?) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(0, (6 * dp).toInt(), 0, (6 * dp).toInt())
        addView(TextView(this@HomeActivity).apply {
            text = left; textSize = 13f; setTextColor(colour); maxLines = 2; ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        if (right != null) addView(TextView(this@HomeActivity).apply {
            text = right; textSize = 10f; setTextColor(getColor(R.color.text_user)); maxLines = 1; setPadding((10 * dp).toInt(), 0, 0, 0)
        })
        if (onClick != null) setOnClickListener { onClick() }
    }

    /** A card's background: dark glass with a hairline in the scheme's colour. */
    private fun cardBg() = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = 12 * dp; setColor(0xD906121B.toInt()); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(77))
    }

    private fun pill(label: String, colour: Int, bg: Int?, onClick: () -> Unit) = TextView(this).apply {
        text = label; textSize = 10f; letterSpacing = 0.2f; setTextColor(colour); gravity = Gravity.CENTER
        background = if (bg != null) getDrawable(bg) else android.graphics.drawable.GradientDrawable().apply { cornerRadius = 14 * dp; setColor(Scheme.alpha(20)); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(89)) }
        setPadding((14 * dp).toInt(), (7 * dp).toInt(), (14 * dp).toInt(), (7 * dp).toInt())
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (8 * dp).toInt() }
        setOnClickListener { onClick() }
    }

    /** OK on an approval: the same answer the Work screen and the notification send. */
    private fun approve(j: JobStore.Job) {
        Haptics.click(this)
        thread(name = "ares-home-approve") {
            val r = runCatching { AresClient(this).post("/api/jobs/${j.id}/answer", JSONObject().put("yes", true).put("at", j.approvalAt)) }
            runOnUiThread {
                val err = r.exceptionOrNull()?.let { "I couldn't reach the Mac, sir." } ?: r.getOrNull()?.takeIf { !it.optBoolean("ok") }?.optString("error")
                Toast.makeText(this, err?.ifBlank { null } ?: "Approved: ${j.title}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /** STOP ALL: the kill switch, after a yes. */
    private fun stopAll() {
        AlertDialog.Builder(this).setTitle("Stop all autonomous work?")
            .setMessage("Running jobs pause, goals and routines hold. Resume from the Work screen or the notification.")
            .setPositiveButton("Stop all") { _, _ ->
                Haptics.heavy(this)
                thread(name = "ares-home-stop") {
                    val r = runCatching { AresClient(this).stopAll() }
                    runOnUiThread { Toast.makeText(this, r.getOrNull()?.optString("message")?.ifBlank { null } ?: if (r.getOrNull()?.optBoolean("ok") == true) "Everything's paused." else "I couldn't reach the Mac, sir.", Toast.LENGTH_SHORT).show() }
                }
            }
            .setNegativeButton("Cancel", null).show()
    }
}
