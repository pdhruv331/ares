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
        private const val CALENDAR = 7
        private const val MIC = 8
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
    private val fadeCaption = Runnable { caption.animate().alpha(0f).setDuration(600).start(); schematic.dimBottom = false }
    private val jobsChanged = { showJobs() }
    private val powerChanged = { showPower() }
    private val appsChanged = { showDock(); drawer.refresh() }
    private val powerSave = object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) = showPowerSave() }

    private data class Event(val id: Long, val title: String, val begin: Long, val end: Long, val allDay: Boolean, val where: String)

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
            schematic.alpha = 1f - 0.65f * k.coerceIn(0f, 1f)
            dots.text = if (k < 0.5f) "● ○" else "○ ●"
        }
        pager.onPage = { p -> if (p == 1) { if (!askedCalendar()) askCalendar(); loadEvents(); renderCards() } }
        pager.onSwipeUp = { openDrawer() }
        pager.canSwipeUp = { _, _ -> pager.page == 0 || !page1.canScrollVertically(1) }
        findViewById<HomePager>(R.id.bottom).apply { pages = false; onSwipeUp = { openDrawer() } }
        findViewById<View>(R.id.handle).setOnClickListener { openDrawer() }
        page0.setOnLongClickListener { homeMenu(hint); true }
        page0.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> placeReactor() }

        drawer = AppDrawer(this, drawerView,
            onAsk = { q -> pager.go(0); ask(q) },
            onDock = { app -> addToDock(app) },
            onPick = { app -> if (pickSlot >= 0) setSlot(pickSlot, app.key); pickSlot = -1 })

        holdToTalk()
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
        Apps.listen(appsChanged)
        Apps.load(this)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        Bubble.home(true)
        if (Ares.paired(this)) AresService.start(this)
        JobStore.listen(jobsChanged)
        PowerStore.listen(powerChanged)
        registerReceiver(powerSave, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
        showPowerSave()
        showJobs()
        showDock()
        loadEvents()
        pollStatus()
        reactor.invalidate(); schematic.invalidate()
    }

    override fun onPause() {
        resumed = false
        Bubble.home(false)
        session.setHandsFree(false, "left")
        JobStore.unlisten(jobsChanged)
        PowerStore.unlisten(powerChanged)
        runCatching { unregisterReceiver(powerSave) }
        statusPoll?.interrupt()
        super.onPause()
    }

    override fun onDestroy() {
        Apps.unlisten(appsChanged)
        session.release()
        super.onDestroy()
    }

    /** Home pressed: back to the reactor page with the drawer shut. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Home always comes back to the reactor: gliding if you're here already, straight there coming back from elsewhere
        if (intent.hasCategory(Intent.CATEGORY_HOME)) {
            if (drawer.isOpen) drawer.close(animate = resumed)
            pager.go(0, animate = resumed)
        }
    }

    private fun back() {
        when {
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
            talking = true
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
                    if (talking) { talking = false; if (session.listening) session.stopListening() }
                    else if (System.currentTimeMillis() - downAt < 320) tapReactor(e.x, e.y)
                }
                MotionEvent.ACTION_CANCEL -> { v.removeCallbacks(start); if (talking) { talking = false; session.cancelListening() } }
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
        reactor.still = save; schematic.still = save
    }

    private fun showJobs() {
        reactor.jobs(JobStore.list())
        if (pager.page == 1) renderCards()
    }

    /** The bottom two callouts: NEXT (the next event) and CLAUDE (5-hour usage); each hides with nothing to say. */
    private fun showReadouts() {
        val on = Ares.prefs(this).getBoolean("homeCallouts", true)
        val now = System.currentTimeMillis()
        val next = events.firstOrNull { !it.allDay && it.end > now }?.let { "${time(it.begin)} ${it.title}".take(24) }
        val five = macStatus?.takeIf { PowerStore.reach }?.optJSONObject("claude")?.opt("fiveHour")?.takeIf { it != JSONObject.NULL }
        val claude = if (Ares.paired(this) && five != null) "5H $five%" else null
        val empty = "" to ""
        schematic.readouts = listOf(empty, empty, if (on && next != null) "NEXT" to next else empty, if (on && claude != null) "CLAUDE" to claude else empty)
    }

    private fun pollStatus() {
        statusPoll?.interrupt()
        if (!Ares.paired(this)) return
        statusPoll = thread(name = "ares-home-status", isDaemon = true) {
            while (!Thread.currentThread().isInterrupted) {
                runCatching { AresClient(this).status() }.onSuccess { macStatus = it }
                runOnUiThread { showReadouts(); if (pager.page == 1) renderCards() }
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
            s == State.LISTENING -> "LISTENING · LET GO TO SEND"
            s == State.THINKING -> "THINKING"
            s == State.SPEAKING -> "SPEAKING · TAP TO STOP"
            !Ares.paired(this) -> "TAP TO SET UP ARES"
            PowerStore.mode == PowerStore.Mode.ONLINE -> "HOLD · TALK     TAP · OPEN"
            else -> PowerStore.header()
        }
        hint.setTextColor(getColor(when (PowerStore.mode) {
            PowerStore.Mode.ONLINE, PowerStore.Mode.UNKNOWN -> R.color.cyan; PowerStore.Mode.STANDBY -> R.color.blue
            PowerStore.Mode.ASLEEP -> R.color.grey; else -> R.color.gold
        }))
    }

    private fun showCaption(text: String, fadeAfterMs: Long? = null) {
        caption.removeCallbacks(fadeCaption)
        caption.animate().cancel()
        caption.text = text.replace(Regex("\\s+"), " ").trim()
        schematic.dimBottom = true
        caption.alpha = 1f
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
        m.menu.add(1, 4, 2, "Original icons").apply { isCheckable = true; isChecked = Icons.original(this@HomeActivity) }
        m.menu.add(1, 5, 3, "Readouts on the reactor").apply { isCheckable = true; isChecked = p.getBoolean("homeCallouts", true) }
        m.menu.add(1, 6, 4, "Home screen app…")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> startActivity(Intent(this, MainActivity::class.java))
                2 -> powerAct("standby")
                3 -> powerAct("wake")
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

    private fun showDock() {
        val slots = Apps.dock(this)
        val px = (52 * dp).toInt()
        dockRow.removeAllViews()
        for ((i, key) in slots.withIndex()) {
            val app = key?.let(Apps::find)
            val cell = FrameLayout(this).apply { layoutParams = LinearLayout.LayoutParams(0, (60 * dp).toInt(), 1f) }
            if (app == null) {
                cell.addView(TextView(this).apply {
                    text = "+"; gravity = Gravity.CENTER; textSize = 18f; setTextColor(getColor(R.color.cyan)); alpha = 0.35f
                    background = getDrawable(R.drawable.bg_round); contentDescription = "Add an app to the dock"
                    layoutParams = FrameLayout.LayoutParams((44 * dp).toInt(), (44 * dp).toInt(), Gravity.CENTER)
                    setOnClickListener { pickSlot = i; drawer.open(pick = true) }
                })
            } else {
                val icon = ImageView(this).apply {
                    layoutParams = FrameLayout.LayoutParams(px, px, Gravity.CENTER); contentDescription = app.label; tag = app.key
                    setOnClickListener { Apps.open(this@HomeActivity, app, it) }
                    setOnLongClickListener { dockMenu(it, i, app); true }
                }
                Icons.get(this, app, px) { bmp -> if (icon.tag == app.key) icon.setImageBitmap(bmp) }?.let(icon::setImageBitmap)
                cell.addView(icon)
            }
            dockRow.addView(cell)
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
                CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION)
            val list = runCatching {
                contentResolver.query(uri, cols, "${CalendarContract.Instances.VISIBLE} = 1", null, "${CalendarContract.Instances.BEGIN} ASC")?.use { c ->
                    buildList { while (c.moveToNext()) add(Event(c.getLong(0), c.getString(1).orEmpty().ifBlank { "(no title)" }, c.getLong(2), c.getLong(3), c.getInt(4) == 1, c.getString(5).orEmpty())) }
                }.orEmpty()
            }.getOrDefault(emptyList()).filter { it.end > now }
            runOnUiThread { events = list; showReadouts(); if (pager.page == 1) renderCards() }
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

    /** NEXT, WORK, SYSTEMS: each only when it has something to say. */
    private fun renderCards() {
        cards.removeAllViews()
        // NEXT
        if (!hasCalendar()) {
            card("NEXT", "CALENDAR").also { c -> c.addView(row("Show your calendar here ›", null, R.color.cyan) { askCalendar() }) }
        } else if (events.isNotEmpty()) {
            val c = card("NEXT", "CALENDAR")
            for (e in events.take(4)) c.addView(row(if (e.allDay) "All day · ${e.title}" else "${time(e.begin)} ${e.title}", whenLabel(e), R.color.text) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, e.id))
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, e.begin).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, e.end)) }
            })
        }
        // WORK
        val active = JobStore.list().filter { it.active }
        if (active.isNotEmpty()) {
            val c = card("WORK", "${JobStore.working} RUNNING")
            for (j in active.take(5)) {
                if (j.status == "approval") {
                    c.addView(row(j.approvalWhat?.ifBlank { null } ?: j.title, null, R.color.amber) { startActivity(WorkActivity.intent(this, j.id)) })
                    c.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
                        setPadding(0, (2 * dp).toInt(), 0, (6 * dp).toInt())
                        addView(pill("REVIEW", R.color.cyan, R.drawable.bg_chip) { startActivity(WorkActivity.intent(this@HomeActivity, j.id)) })
                        addView(pill("OK", R.color.amber, R.drawable.bg_amber) { approve(j) })
                    })
                } else c.addView(row(j.title, if (j.status == "queued") "queued" else if (j.steps > 0) "${j.steps} steps" else "working", R.color.text) {
                    startActivity(WorkActivity.intent(this, j.id))
                })
            }
            c.addView(LinearLayout(this).apply {
                gravity = Gravity.END; setPadding(0, (6 * dp).toInt(), 0, 0)
                addView(pill("STOP ALL", R.color.amber, R.drawable.bg_amber) { stopAll() })
            })
        }
        if (cards.childCount == 0) cards.addView(TextView(this).apply {
            text = "All quiet."; textSize = 13f; setTextColor(getColor(R.color.muted)); gravity = Gravity.CENTER
            setPadding(0, (28 * dp).toInt(), 0, (28 * dp).toInt())
        })
        // SYSTEMS
        val c = card("SYSTEMS", null)
        if (Ares.paired(this)) {
            val st = macStatus?.takeIf { PowerStore.reach } // (no stale readings while she can't be reached)
            val host = st?.optString("host")?.takeIf { it.isNotBlank() } ?: "Mac"
            val batt = st?.optJSONObject("battery")?.let { b -> "${b.optInt("pct")}% · ${if (b.optBoolean("charging")) "on power" else "battery"}" }
            c.addView(row(host, listOfNotNull(PowerStore.header().lowercase(), batt).joinToString(" · "), R.color.text) { startActivity(Intent(this, MainActivity::class.java)) })
            val claude = st?.optJSONObject("claude")?.let { cl -> listOfNotNull(cl.opt("fiveHour")?.takeIf { it != JSONObject.NULL }?.let { "5H $it%" }, cl.opt("week")?.takeIf { it != JSONObject.NULL }?.let { "WEEK $it%" }).joinToString(" · ") }?.ifBlank { null }
            if (claude != null) c.addView(row("Claude", claude, R.color.text, null))
        }
        val phone = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val pct = phone?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) }
        val plugged = (phone?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        if (pct != null && pct >= 0) c.addView(row("This phone", "$pct%${if (plugged) " · charging" else ""}", R.color.text, null))
    }

    private fun card(title: String, right: String?): LinearLayout {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; background = getDrawable(R.drawable.bg_card)
            setPadding((14 * dp).toInt(), (12 * dp).toInt(), (14 * dp).toInt(), (10 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = (10 * dp).toInt() }
        }
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(0, 0, 0, (6 * dp).toInt())
            addView(TextView(this@HomeActivity).apply { text = title; textSize = 9f; letterSpacing = 0.3f; setTextColor(getColor(R.color.cyan)); layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f) })
            if (right != null) addView(TextView(this@HomeActivity).apply { text = right; textSize = 9f; letterSpacing = 0.2f; setTextColor(getColor(R.color.cyan_dim)) })
        })
        cards.addView(c)
        return c
    }

    private fun row(left: String, right: String?, colour: Int, onClick: (() -> Unit)?) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(0, (6 * dp).toInt(), 0, (6 * dp).toInt())
        addView(TextView(this@HomeActivity).apply {
            text = left; textSize = 13f; setTextColor(getColor(colour)); maxLines = 2; ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        if (right != null) addView(TextView(this@HomeActivity).apply {
            text = right; textSize = 10f; setTextColor(getColor(R.color.text_user)); maxLines = 1; setPadding((10 * dp).toInt(), 0, 0, 0)
        })
        if (onClick != null) setOnClickListener { onClick() }
    }

    private fun pill(label: String, colour: Int, bg: Int, onClick: () -> Unit) = TextView(this).apply {
        text = label; textSize = 10f; letterSpacing = 0.2f; setTextColor(getColor(colour)); background = getDrawable(bg); gravity = Gravity.CENTER
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
