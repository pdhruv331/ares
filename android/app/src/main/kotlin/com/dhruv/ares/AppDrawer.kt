package com.dhruv.ares

import android.animation.ValueAnimator
import android.app.Activity
import android.content.Intent
import android.content.pm.LauncherApps
import android.net.Uri
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.PopupMenu
import android.widget.TextView

/**
 * The home screen's app drawer (docs/launcher-prompt.md §4): a search field that falls back to asking ARES, the
 * pinned (dock) apps, then every app A–Z in rows of four under letter headers, with a letter rail to jump. Long-press
 * an app for its shortcuts, Add to dock, App info and Uninstall. `pick` mode fills an empty dock slot instead of opening.
 * YOUR ORDER (docs/launcher-v2-prompt.md §8): hold an app and drag it; the first drag starts from the A–Z order, new apps
 * join at the end, and the A–Z chip goes back (the order is kept for next time).
 */
class AppDrawer(
    private val act: Activity,
    private val root: View,
    private val onAsk: (String) -> Unit,
    private val onDock: (Apps.App) -> Unit,
    private val onPick: (Apps.App) -> Unit,
    private val onHome: (Apps.App) -> Unit = {},
    private val onHomeHas: (Apps.App) -> Boolean = { false },
) {
    private val list: ListView = root.findViewById(R.id.apps)
    private val search: EditText = root.findViewById(R.id.search)
    private val rail: LinearLayout = root.findViewById(R.id.rail)
    private val scan: View = root.findViewById(R.id.scan)
    private val frame: DragFrame = root.findViewById(R.id.dragFrame)
    private val sortAz: TextView = root.findViewById(R.id.sortAz)
    private val sortMine: TextView = root.findViewById(R.id.sortMine)
    private val prefs = Ares.prefs(act)
    private val slop = android.view.ViewConfiguration.get(act).scaledTouchSlop
    private var mine: Boolean
        get() = prefs.getString("drawerSort", "az") == "mine"
        set(v) { prefs.edit().putString("drawerSort", if (v) "mine" else "az").apply() }
    // While an app is being dragged: the order as it's being rearranged, the dragged app, its floating icon
    private var dragOrder: MutableList<Apps.App>? = null
    private var dragKey: String? = null
    private var floater: ImageView? = null
    private val dp = act.resources.displayMetrics.density
    private val iconPx = (52 * dp).toInt()
    private var picking = false

    val isOpen get() = root.visibility == View.VISIBLE

    private sealed class Row {
        class Header(val text: String) : Row()
        class Line(val apps: List<Apps.App>, val pinned: Boolean = false) : Row()
        class Ask(val text: String) : Row()
    }
    private var rows: List<Row> = emptyList()
    private val letterRow = LinkedHashMap<String, Int>()

    private val adapter = object : BaseAdapter() {
        override fun getCount() = rows.size
        override fun getItem(i: Int) = rows[i]
        override fun getItemId(i: Int) = i.toLong()
        override fun getViewTypeCount() = 3
        override fun getItemViewType(i: Int) = when (rows[i]) { is Row.Header -> 0; is Row.Line -> 1; is Row.Ask -> 2 }
        override fun areAllItemsEnabled() = false
        override fun isEnabled(i: Int) = false // (cells take their own taps)
        override fun getView(i: Int, convert: View?, parent: ViewGroup): View = when (val r = rows[i]) {
            is Row.Header -> ((convert as? TextView) ?: header()).apply { text = r.text; setTextColor(Scheme.color) }
            is Row.Line -> ((convert as? LinearLayout) ?: line()).also { bind(it, r.apps, r.pinned) }
            is Row.Ask -> ((convert as? TextView) ?: ask()).apply { text = "◉   Ask ARES: ${r.text}"; setOnClickListener { askNow(r.text) } }
        }
    }

    init {
        list.adapter = adapter
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) { build(s?.toString().orEmpty()) }
        })
        search.setOnEditorActionListener { _, id, _ ->
            if (id != EditorInfo.IME_ACTION_GO) return@setOnEditorActionListener false
            val q = search.text.toString().trim()
            val first = (rows.firstOrNull { it is Row.Line } as? Row.Line)?.apps?.firstOrNull()
            if (first != null && !picking) launch(first, null) else if (q.isNotEmpty() && !picking) askNow(q)
            true
        }
        root.findViewById<View>(R.id.drawerHome).setOnClickListener { close() }
        // Pull down from the top of the list to close
        var y0 = 0f
        list.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> y0 = e.rawY
                MotionEvent.ACTION_MOVE -> if (!list.canScrollVertically(-1) && e.rawY - y0 > 90 * dp) { y0 = Float.MAX_VALUE; close() }
            }
            false
        }
        sortAz.setOnClickListener { if (mine) { mine = false; build(search.text.toString()); list.setSelection(0) } }
        sortMine.setOnClickListener { if (!mine) { mine = true; build(search.text.toString()); list.setSelection(0) } }
        rail.setOnTouchListener { v, e ->
            if (e.actionMasked == MotionEvent.ACTION_DOWN || e.actionMasked == MotionEvent.ACTION_MOVE) {
                val letters = letterRow.keys.toList()
                if (letters.isNotEmpty()) {
                    val k = ((e.y - v.paddingTop) / (v.height - v.paddingTop - v.paddingBottom).coerceAtLeast(1)).coerceIn(0f, 0.999f)
                    val letter = letters[(k * letters.size).toInt()]
                    letterRow[letter]?.let { row -> if (list.firstVisiblePosition != row) { list.setSelection(row); Haptics.tick(act) } }
                }
            }
            true
        }
    }

    fun open(pick: Boolean = false, forHome: Boolean = false) {
        picking = pick
        search.setText("")
        search.hint = if (!pick) "SEARCH OR ASK" else if (forHome) "PICK AN APP FOR HOME" else "PICK AN APP FOR THE DOCK"
        build("")
        list.setSelection(0)
        root.visibility = View.VISIBLE
        if (!ValueAnimator.areAnimatorsEnabled()) { root.alpha = 1f; root.translationY = 0f; return }
        root.alpha = 0f; root.translationY = 40 * dp
        root.animate().alpha(1f).translationY(0f).setDuration(220).setInterpolator(android.view.animation.DecelerateInterpolator()).start()
        // The scan line sweeps down the list as it opens
        scan.alpha = 0.8f; scan.translationY = 0f
        scan.post { scan.animate().translationY((scan.parent as View).height.toFloat()).alpha(0f).setDuration(420).start() }
    }

    fun close(animate: Boolean = true) {
        if (!isOpen) return
        act.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(search.windowToken, 0)
        search.clearFocus()
        if (!animate || !ValueAnimator.areAnimatorsEnabled()) { root.visibility = View.GONE; return }
        root.animate().alpha(0f).translationY(24 * dp).setDuration(160).withEndAction { root.visibility = View.GONE }.start()
    }

    /** The app list changed (installs, removals, the dock, icon style). */
    fun refresh() { if (isOpen) build(search.text.toString()) }

    private fun build(query: String) {
        val q = query.trim()
        val out = ArrayList<Row>()
        letterRow.clear()
        val all = Apps.all
        if (q.isEmpty()) {
            val pinned = Apps.dock(act).mapNotNull { it?.let(Apps::find) }
            if (pinned.isNotEmpty() && !picking) { out += Row.Header("— PINNED"); pinned.chunked(4).forEach { out += Row.Line(it, pinned = true) } }
            if (mine && !picking) {
                out += Row.Header("— YOUR ORDER")
                (dragOrder ?: customOrder()).chunked(4).forEach { out += Row.Line(it) }
            } else for ((letter, apps) in all.groupBy { it.letter }) {
                letterRow[letter] = out.size
                out += Row.Header("— $letter")
                apps.chunked(4).forEach { out += Row.Line(it) }
            }
        } else {
            val hits = all.filter { it.label.contains(q, ignoreCase = true) }
                .sortedBy { if (it.label.startsWith(q, ignoreCase = true)) 0 else 1 }
            hits.chunked(4).forEach { out += Row.Line(it) }
            if (!picking) { if (hits.isEmpty()) out.add(0, Row.Ask(q)) else out += Row.Ask(q) }
        }
        rows = out
        adapter.notifyDataSetChanged()
        rail.removeAllViews()
        rail.visibility = if (q.isEmpty() && letterRow.isNotEmpty()) View.VISIBLE else View.GONE
        (sortAz.parent as View).visibility = if (q.isEmpty() && !picking) View.VISIBLE else View.GONE
        for ((chip, on) in listOf(sortAz to !mine, sortMine to mine)) {
            chip.setTextColor(if (on) Scheme.color else act.getColor(R.color.muted))
            chip.background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = 14 * dp; setColor(if (on) Scheme.alpha(26) else 0); setStroke(dp.toInt().coerceAtLeast(1), if (on) Scheme.alpha(110) else Scheme.alpha(40)) }
        }
        for (l in letterRow.keys) rail.addView(TextView(act).apply {
            text = l; textSize = 9f; gravity = Gravity.CENTER; setTextColor(Scheme.color); alpha = 0.7f
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        })
    }

    // ---- Rows ------------------------------------------------------------------------------------------------------

    private fun header() = TextView(act).apply {
        textSize = 9f; letterSpacing = 0.3f; setTextColor(Scheme.color); alpha = 0.8f
        setPadding((8 * dp).toInt(), (16 * dp).toInt(), 0, (6 * dp).toInt())
    }

    private fun ask() = TextView(act).apply {
        textSize = 14f; setTextColor(act.getColor(R.color.text)); background = act.getDrawable(R.drawable.bg_chip)
        setPadding((16 * dp).toInt(), (14 * dp).toInt(), (16 * dp).toInt(), (14 * dp).toInt())
        layoutParams = ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun line() = LinearLayout(act).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, (8 * dp).toInt(), 0, (8 * dp).toInt())
        repeat(4) {
            addView(LinearLayout(act).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                addView(ImageView(act).apply { layoutParams = LinearLayout.LayoutParams(iconPx, iconPx) })
                addView(TextView(act).apply {
                    textSize = 10f; setTextColor(act.getColor(R.color.text_user)); maxLines = 1; ellipsize = TextUtils.TruncateAt.END
                    gravity = Gravity.CENTER; setPadding((4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt(), 0)
                    typeface = android.graphics.Typeface.SANS_SERIF
                })
            })
        }
    }

    private fun bind(row: LinearLayout, apps: List<Apps.App>, pinned: Boolean) {
        for (i in 0 until 4) {
            val cell = row.getChildAt(i) as LinearLayout
            val app = apps.getOrNull(i)
            cell.visibility = if (app == null || app.key == dragKey) View.INVISIBLE else View.VISIBLE // (the dragged app's place stays open)
            if (app == null) { cell.setOnClickListener(null); cell.setOnLongClickListener(null); continue }
            val icon = cell.getChildAt(0) as ImageView
            (cell.getChildAt(1) as TextView).text = app.label
            cell.contentDescription = app.label
            icon.tag = app.key
            val now = Icons.get(act, app, iconPx) { bmp -> if (icon.tag == app.key) icon.setImageBitmap(bmp) }
            if (now != null) icon.setImageBitmap(now) else icon.setImageDrawable(null)
            cell.setOnClickListener { if (picking) { onPick(app); close() } else launch(app, icon) }
            cell.setOnLongClickListener { hold(it, app, pinned); true }
        }
    }

    // ---- YOUR ORDER: hold and drag ----------------------------------------------------------------------------------

    /** Every app in your order: the saved order, then apps installed since (A–Z among themselves). */
    private fun customOrder(): MutableList<Apps.App> {
        val saved = prefs.getString("drawerOrder", null)?.split('\n').orEmpty()
        val byKey = Apps.all.associateBy { it.key }
        val out = saved.mapNotNull(byKey::get).toMutableList()
        val known = saved.toHashSet()
        Apps.all.filter { it.key !in known }.forEach(out::add)
        return out
    }

    private fun rebuildKeepingScroll() {
        val first = list.firstVisiblePosition
        val top = list.getChildAt(0)?.top ?: 0
        build(search.text.toString())
        list.setSelectionFromTop(first, top)
    }

    /** A held app: drag it to rearrange (not in search, the pinned row or picking), or let go for its menu. */
    private fun hold(cell: View, app: Apps.App, pinned: Boolean) {
        if (picking || pinned || search.text.isNotBlank()) return menu(cell, app)
        Haptics.click(act)
        cell.animate().scaleX(1.12f).scaleY(1.12f).setDuration(120).start()
        val x0 = frame.downX; val y0 = frame.downY
        var moved = false; var lastX = x0; var lastY = y0
        val edge = object : Runnable {
            override fun run() {
                val zone = 64 * dp
                val dy = when { lastY < zone -> -(zone - lastY) / 3; lastY > frame.height - zone -> (lastY - (frame.height - zone)) / 3; else -> 0f }
                if (dy != 0f && floater != null) { list.scrollListBy(dy.toInt()); retarget(lastX, lastY); frame.postOnAnimation(this) }
            }
        }
        frame.grab = { e ->
            lastX = e.x; lastY = e.y
            when (e.actionMasked) {
                MotionEvent.ACTION_MOVE -> {
                    if (!moved && kotlin.math.hypot(e.x - x0, e.y - y0) > slop) { moved = true; startDrag(cell, app) }
                    if (moved) {
                        floater?.apply { translationX = e.x - width / 2f; translationY = e.y - height / 2f }
                        retarget(e.x, e.y)
                        frame.removeCallbacks(edge); frame.postOnAnimation(edge)
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    frame.grab = null
                    frame.removeCallbacks(edge)
                    cell.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
                    if (moved) finishDrag() else if (e.actionMasked == MotionEvent.ACTION_UP) menu(cell, app)
                }
            }
        }
    }

    private fun startDrag(cell: View, app: Apps.App) {
        if (!mine) mine = true // (the first drag turns A–Z into your order, starting from A–Z)
        dragOrder = customOrder()
        dragKey = app.key
        floater = ImageView(act).apply {
            layoutParams = android.widget.FrameLayout.LayoutParams(iconPx, iconPx)
            Icons.get(act, app, iconPx) { setImageBitmap(it) }?.let(::setImageBitmap)
            scaleX = 1.15f; scaleY = 1.15f; translationZ = 12 * dp
        }
        frame.addView(floater)
        val loc = IntArray(2).also(cell::getLocationInWindow); val fl = IntArray(2).also(frame::getLocationInWindow)
        floater?.translationX = (loc[0] - fl[0] + (cell.width - iconPx) / 2).toFloat(); floater?.translationY = (loc[1] - fl[1]).toFloat()
        rebuildKeepingScroll()
    }

    /** The app under the finger takes the dragged app's place in the order; the rest move along by one. */
    private fun retarget(x: Float, y: Float) {
        val order = dragOrder ?: return
        val pos = list.pointToPosition((x - list.left).toInt(), (y - list.top).toInt())
        val row = rows.getOrNull(pos) as? Row.Line ?: return
        if (row.pinned) return
        val w = (list.width - list.paddingLeft - list.paddingRight).coerceAtLeast(1)
        val col = ((x - list.left - list.paddingLeft) / (w / 4f)).toInt().coerceIn(0, 3)
        val target = row.apps.getOrNull(col) ?: row.apps.last()
        if (target.key == dragKey) return
        val from = order.indexOfFirst { it.key == dragKey }
        val to = order.indexOf(target)
        if (from < 0 || to < 0) return
        order.add(to, order.removeAt(from))
        Haptics.tick(act)
        rebuildKeepingScroll()
    }

    private fun finishDrag() {
        dragOrder?.let { order -> prefs.edit().putString("drawerOrder", order.joinToString("\n") { it.key }).apply() }
        dragOrder = null; dragKey = null
        floater?.let(frame::removeView); floater = null
        rebuildKeepingScroll()
    }

    private fun launch(app: Apps.App, from: View?) {
        Apps.open(act, app, from)
        root.postDelayed({ close(animate = false) }, 350) // gone by the time you come back home
    }

    private fun askNow(q: String) { close(); onAsk(q) }

    /** Long-press: the app's shortcuts, then Add to dock / home, App info, Uninstall. */
    private fun menu(anchor: View, app: Apps.App) {
        Haptics.click(act)
        val la = act.getSystemService(LauncherApps::class.java)
        val shortcuts = runCatching {
            if (!la.hasShortcutHostPermission()) emptyList()
            else la.getShortcuts(LauncherApps.ShortcutQuery().setPackage(app.component.packageName).setQueryFlags(
                LauncherApps.ShortcutQuery.FLAG_MATCH_DYNAMIC or LauncherApps.ShortcutQuery.FLAG_MATCH_MANIFEST or LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED
            ), app.user).orEmpty().filter { it.isEnabled }.sortedBy { it.rank }.take(4)
        }.getOrDefault(emptyList())
        val m = PopupMenu(act, anchor)
        shortcuts.forEachIndexed { i, s -> m.menu.add(0, 100 + i, i, s.shortLabel ?: s.longLabel ?: s.id) }
        val inDock = Apps.dock(act).contains(app.key)
        if (!inDock) m.menu.add(1, 1, 10, "Add to dock")
        if (!onHomeHas(app)) m.menu.add(1, 4, 10, "Add to home")
        m.menu.add(1, 2, 11, "App info")
        m.menu.add(1, 3, 12, "Uninstall")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> onDock(app)
                4 -> onHome(app)
                2 -> runCatching { la.startAppDetailsActivity(app.component, app.user, null, null) }
                3 -> act.startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:${app.component.packageName}")))
                else -> shortcuts.getOrNull(it.itemId - 100)?.let { s -> runCatching { la.startShortcut(s, null, null) }; root.postDelayed({ close(false) }, 350) }
            }
            true
        }
        m.show()
    }
}
