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
 */
class AppDrawer(
    private val act: Activity,
    private val root: View,
    private val onAsk: (String) -> Unit,
    private val onDock: (Apps.App) -> Unit,
    private val onPick: (Apps.App) -> Unit,
) {
    private val list: ListView = root.findViewById(R.id.apps)
    private val search: EditText = root.findViewById(R.id.search)
    private val rail: LinearLayout = root.findViewById(R.id.rail)
    private val scan: View = root.findViewById(R.id.scan)
    private val dp = act.resources.displayMetrics.density
    private val iconPx = (52 * dp).toInt()
    private var picking = false

    val isOpen get() = root.visibility == View.VISIBLE

    private sealed class Row {
        class Header(val text: String) : Row()
        class Line(val apps: List<Apps.App>) : Row()
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
            is Row.Line -> ((convert as? LinearLayout) ?: line()).also { bind(it, r.apps) }
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

    fun open(pick: Boolean = false) {
        picking = pick
        search.setText("")
        search.hint = if (pick) "PICK AN APP FOR THE DOCK" else "SEARCH OR ASK"
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
            if (pinned.isNotEmpty() && !picking) { out += Row.Header("— PINNED"); pinned.chunked(4).forEach { out += Row.Line(it) } }
            for ((letter, apps) in all.groupBy { it.letter }) {
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
        rail.visibility = if (q.isEmpty()) View.VISIBLE else View.GONE
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

    private fun bind(row: LinearLayout, apps: List<Apps.App>) {
        for (i in 0 until 4) {
            val cell = row.getChildAt(i) as LinearLayout
            val app = apps.getOrNull(i)
            cell.visibility = if (app == null) View.INVISIBLE else View.VISIBLE
            if (app == null) { cell.setOnClickListener(null); cell.setOnLongClickListener(null); continue }
            val icon = cell.getChildAt(0) as ImageView
            (cell.getChildAt(1) as TextView).text = app.label
            cell.contentDescription = app.label
            icon.tag = app.key
            val now = Icons.get(act, app, iconPx) { bmp -> if (icon.tag == app.key) icon.setImageBitmap(bmp) }
            if (now != null) icon.setImageBitmap(now) else icon.setImageDrawable(null)
            cell.setOnClickListener { if (picking) { onPick(app); close() } else launch(app, icon) }
            cell.setOnLongClickListener { menu(it, app); true }
        }
    }

    private fun launch(app: Apps.App, from: View?) {
        Apps.open(act, app, from)
        root.postDelayed({ close(animate = false) }, 350) // gone by the time you come back home
    }

    private fun askNow(q: String) { close(); onAsk(q) }

    /** Long-press: the app's shortcuts, then Add to dock, App info, Uninstall. */
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
        m.menu.add(1, 2, 11, "App info")
        m.menu.add(1, 3, 12, "Uninstall")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> onDock(app)
                2 -> runCatching { la.startAppDetailsActivity(app.component, app.user, null, null) }
                3 -> act.startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:${app.component.packageName}")))
                else -> shortcuts.getOrNull(it.itemId - 100)?.let { s -> runCatching { la.startShortcut(s, null, null) }; root.postDelayed({ close(false) }, 350) }
            }
            true
        }
        m.show()
    }
}
