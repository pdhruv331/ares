package com.dhruv.ares

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.Intent
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.os.Process
import android.text.TextUtils
import android.util.SizeF
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.math.ceil

/**
 * What's on the home screen's second page (docs/launcher-v2-prompt.md §9): apps, Android widgets and the ARES cards,
 * in the order you've arranged them (prefs `homeBoard`). Widgets are hosted the way a home screen hosts them
 * (AppWidgetHost: allowed once by you, then configured by their own app if they need it). The ARES cards' contents come
 * from the home screen (`aresCard`), rebuilt whenever their data changes; a card with nothing to say steps out of the grid.
 */
class HomeBoard(
    private val act: Activity,
    private val grid: HomeGrid,
    private val aresCard: (String) -> View?,
    private val pickApp: () -> Unit,
    private val toDock: (Apps.App) -> Unit,
) {
    data class Item(val type: String, val key: String, var cols: Int, var rows: Int)

    companion object {
        const val REQ_BIND = 21
        const val REQ_CONFIG = 22
        private const val HOST_ID = 0x4A12
        val CARDS = linkedMapOf("next" to "NEXT · calendar", "work" to "WORK · jobs and approvals", "systems" to "SYSTEMS · the server and this phone")
    }

    private val prefs = Ares.prefs(act)
    private val dp = act.resources.displayMetrics.density
    private val awm = AppWidgetManager.getInstance(act)
    val host = AppWidgetHost(act.applicationContext, HOST_ID)
    private val views = HashMap<String, View>() // item id → its view in the grid (kept, so widgets aren't recreated)
    private var items = load()
    private var pending: Pair<Int, AppWidgetProviderInfo>? = null // a widget being bound / configured
    private val work = Executors.newSingleThreadExecutor { Thread(it, "ares-widgets").apply { isDaemon = true } }

    private fun id(i: Item) = "${i.type}:${i.key}"

    init {
        grid.emptyHint = "Hold here to add apps and widgets"
        grid.onOrder = { order ->
            val byView = views.entries.associate { (k, v) -> v to k }
            val ids = order.mapNotNull { byView[it] }
            // Hidden ARES cards keep their place among the rest
            items = (ids.mapNotNull { k -> items.firstOrNull { id(it) == k } } + items.filter { id(it) !in ids }).toMutableList()
            save()
        }
        grid.onMenu = { v -> views.entries.firstOrNull { it.value === v }?.key?.let { k -> items.firstOrNull { id(it) == k } }?.let { menu(v, it) } }
        grid.onEmptyHold = { addMenu() }
    }

    // ---- The saved layout ----------------------------------------------------------------------------------------------

    private fun load(): MutableList<Item> {
        val saved = prefs.getString("homeBoard", null)
        if (saved != null) return runCatching {
            val a = JSONArray(saved)
            (0 until a.length()).map { a.getJSONObject(it).let { o -> Item(o.getString("type"), o.getString("key"), o.optInt("cols", 4), o.optInt("rows", 0)) } }.toMutableList()
        }.getOrDefault(mutableListOf())
        // First time: the ARES cards as they were, in the order you'd given them
        val order = (prefs.getString("homeCards", null)?.split(',').orEmpty().filter { it in CARDS } + CARDS.keys).distinct()
        return order.map { Item("ares", it, 4, 0) }.toMutableList()
    }

    private fun save() = prefs.edit().putString("homeBoard", JSONArray(items.map { JSONObject().put("type", it.type).put("key", it.key).put("cols", it.cols).put("rows", it.rows) }).toString()).apply()

    // ---- Building the page ---------------------------------------------------------------------------------------------

    /** Bring the grid in line with the items (views reused), and refill the ARES cards. */
    fun render() {
        if (grid.busy) return // (not under the finger; the drop re-renders)
        val wanted = items.map(::id)
        for (k in views.keys.toList()) if (k !in wanted) { grid.removeView(views[k]); views.remove(k) }
        items.forEachIndexed { i, item ->
            val v = views.getOrPut(id(item)) { build(item) }
            v.layoutParams = HomeGrid.Span(item.cols, item.rows)
            if (item.type == "ares") fill(v as FrameLayout, item.key)
            if (item.type == "app") (v as ViewGroup).let { refreshApp(it, item) }
            if (grid.indexOfChild(v) != i) { if (v.parent != null) grid.removeView(v); grid.addView(v, i.coerceAtMost(grid.childCount)) }
        }
        grid.requestLayout(); grid.invalidate()
    }

    private fun build(item: Item): View = when (item.type) {
        "widget" -> widgetView(item)
        "app" -> appView()
        else -> FrameLayout(act)
    }

    private fun fill(box: FrameLayout, which: String) {
        box.removeAllViews()
        val card = aresCard(which)
        box.visibility = if (card == null) View.GONE else View.VISIBLE
        if (card != null) { (card.parent as? ViewGroup)?.removeView(card); box.addView(card, FrameLayout.LayoutParams(-1, -2)) }
    }

    private fun appView() = LinearLayout(act).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
        addView(ImageView(act).apply { layoutParams = LinearLayout.LayoutParams((52 * dp).toInt(), (52 * dp).toInt()) })
        addView(TextView(act).apply {
            textSize = 10f; setTextColor(act.getColor(R.color.text)); maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER
            setPadding((2 * dp).toInt(), (6 * dp).toInt(), (2 * dp).toInt(), 0); typeface = android.graphics.Typeface.SANS_SERIF
            setShadowLayer(6 * dp, 0f, 0f, 0xFF02060A.toInt())
        })
    }

    private fun refreshApp(v: ViewGroup, item: Item) {
        val app = Apps.find(item.key)
        v.visibility = if (app == null) View.GONE else View.VISIBLE // (uninstalled, or not listed yet)
        app ?: return
        val icon = v.getChildAt(0) as ImageView
        (v.getChildAt(1) as TextView).text = app.label
        v.contentDescription = app.label
        icon.tag = app.key
        Icons.get(act, app, (52 * dp).toInt()) { bmp -> if (icon.tag == app.key) icon.setImageBitmap(bmp) }?.let(icon::setImageBitmap)
        v.setOnClickListener { Apps.open(act, app, icon) }
    }

    private fun widgetView(item: Item): View {
        val wid = item.key.toInt()
        val info = awm.getAppWidgetInfo(wid)
        if (info == null) return TextView(act).apply { // (its app was uninstalled)
            text = "Widget unavailable · hold to remove"; textSize = 11f; setTextColor(act.getColor(R.color.muted)); gravity = Gravity.CENTER
            background = act.getDrawable(R.drawable.bg_card)
        }
        val hv: AppWidgetHostView = host.createView(act, wid, info)
        hv.setPadding(0, 0, 0, 0)
        // Tell the widget its size whenever the grid gives it one, so it lays itself out for it
        hv.addOnLayoutChangeListener { v, l, t, r, b, ol, ot, or_, ob ->
            if (r - l != or_ - ol || b - t != ob - ot) (v as AppWidgetHostView).updateAppWidgetSize(Bundle(), listOf(SizeF((r - l) / dp, (b - t) / dp)))
        }
        return FrameLayout(act).apply { addView(hv, FrameLayout.LayoutParams(-1, -1)) }
    }

    // ---- Menus -----------------------------------------------------------------------------------------------------------

    /** Held empty space: what can be added. */
    fun addMenu() {
        val hidden = CARDS.keys.filter { k -> items.none { it.type == "ares" && it.key == k } }
        val labels = listOf("Add an app", "Add a widget") + hidden.map { "Add the ${CARDS[it]!!.substringBefore(' ')} card" }
        AlertDialog.Builder(act).setTitle("Add to home").setItems(labels.toTypedArray()) { _, i ->
            when (i) {
                0 -> pickApp()
                1 -> pickWidget()
                else -> { items.add(0, Item("ares", hidden[i - 2], 4, 0)); save(); render() }
            }
        }.setNegativeButton("Cancel", null).show()
    }

    private fun menu(v: View, item: Item) {
        val opts = ArrayList<Pair<String, () -> Unit>>()
        when (item.type) {
            "app" -> Apps.find(item.key)?.let { app ->
                if (!Apps.dock(act).contains(app.key)) opts += "Add to dock" to { toDock(app) }
                opts += "App info" to { runCatching { act.getSystemService(android.content.pm.LauncherApps::class.java).startAppDetailsActivity(app.component, app.user, null, null) } }
            }
            "widget" -> awm.getAppWidgetInfo(item.key.toInt())?.let { info -> if (info.resizeMode != AppWidgetProviderInfo.RESIZE_NONE) opts += "Resize…" to { resize(item, info) } }
        }
        opts += (if (item.type == "ares") "Remove this card" else "Remove from home") to { remove(item) }
        AlertDialog.Builder(act).setItems(opts.map { it.first }.toTypedArray()) { _, i -> opts[i].second() }.show()
    }

    private fun remove(item: Item) {
        items.remove(item)
        if (item.type == "widget") runCatching { host.deleteAppWidgetId(item.key.toInt()) }
        save(); render()
    }

    private fun resize(item: Item, info: AppWidgetProviderInfo) {
        val (minC, minR) = cellsFor(info.minResizeWidth.takeIf { it > 0 } ?: info.minWidth, info.minResizeHeight.takeIf { it > 0 } ?: info.minHeight)
        val h = info.resizeMode and AppWidgetProviderInfo.RESIZE_HORIZONTAL != 0
        val v = info.resizeMode and AppWidgetProviderInfo.RESIZE_VERTICAL != 0
        val sizes = (if (h) (minC..4) else listOf(item.cols)).flatMap { c -> (if (v) (minR..5) else listOf(item.rows)).map { r -> c to r } }.distinct()
        AlertDialog.Builder(act).setTitle("Size (columns × rows)")
            .setSingleChoiceItems(sizes.map { "${it.first} × ${it.second}" }.toTypedArray(), sizes.indexOf(item.cols to item.rows)) { d, i ->
                item.cols = sizes[i].first; item.rows = sizes[i].second; save(); render(); d.dismiss()
            }.setNegativeButton("Cancel", null).show()
    }

    // ---- Apps --------------------------------------------------------------------------------------------------------------

    fun addApp(app: Apps.App) {
        if (items.any { it.type == "app" && it.key == app.key }) return
        items.add(Item("app", app.key, 1, 1)); save(); render()
        grid.post { (grid.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN) }
    }

    fun has(app: Apps.App) = items.any { it.type == "app" && it.key == app.key }

    // ---- Widgets: pick, allow, configure, place ----------------------------------------------------------------------------

    /** Widgets from your apps (with their previews), grouped by app. */
    private fun pickWidget() {
        val infos = runCatching { awm.getInstalledProvidersForProfile(Process.myUserHandle()) }.getOrDefault(emptyList())
            .sortedWith(compareBy({ it.loadLabel(act.packageManager).toString().lowercase() }))
        val pm = act.packageManager
        val byApp = infos.groupBy { it.provider.packageName }.toSortedMap(compareBy { runCatching { pm.getApplicationLabel(pm.getApplicationInfo(it, 0)).toString().lowercase() }.getOrDefault(it) })
        val list = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding((16 * dp).toInt(), (8 * dp).toInt(), (16 * dp).toInt(), (8 * dp).toInt()) }
        lateinit var dialog: AlertDialog
        for ((pkg, group) in byApp) {
            val appLabel = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
            list.addView(TextView(act).apply { text = appLabel.uppercase(); textSize = 9f; letterSpacing = 0.3f; setTextColor(Scheme.color); setPadding(0, (14 * dp).toInt(), 0, (6 * dp).toInt()) })
            for (info in group) {
                val (c, r) = defaultSpan(info)
                val preview = ImageView(act).apply { layoutParams = LinearLayout.LayoutParams((64 * dp).toInt(), (64 * dp).toInt()); scaleType = ImageView.ScaleType.FIT_CENTER }
                work.execute {
                    val d: Drawable? = runCatching { info.loadPreviewImage(act, 0) ?: info.loadIcon(act, 0) }.getOrNull()
                    act.runOnUiThread { preview.setImageDrawable(d) }
                }
                list.addView(LinearLayout(act).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, (6 * dp).toInt(), 0, (6 * dp).toInt())
                    addView(preview)
                    addView(LinearLayout(act).apply {
                        orientation = LinearLayout.VERTICAL; setPadding((14 * dp).toInt(), 0, 0, 0)
                        addView(TextView(act).apply { text = info.loadLabel(pm); textSize = 14f; setTextColor(act.getColor(R.color.text)) })
                        addView(TextView(act).apply { text = "$c × $r"; textSize = 11f; setTextColor(act.getColor(R.color.muted)) })
                    })
                    setOnClickListener { dialog.dismiss(); bind(info) }
                })
            }
        }
        if (infos.isEmpty()) list.addView(TextView(act).apply { text = "None of your apps offer widgets."; setTextColor(act.getColor(R.color.muted)) })
        dialog = AlertDialog.Builder(act).setTitle("Add a widget").setView(ScrollView(act).apply { addView(list) }).setNegativeButton("Cancel", null).show()
    }

    private fun bind(info: AppWidgetProviderInfo) {
        val wid = host.allocateAppWidgetId()
        pending = wid to info
        if (awm.bindAppWidgetIdIfAllowed(wid, info.profile, info.provider, null)) configure()
        else act.startActivityForResult(Intent(AppWidgetManager.ACTION_APPWIDGET_BIND)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, wid)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER, info.provider)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER_PROFILE, info.profile), REQ_BIND)
    }

    /** Some widgets ask what to show first (a contact, a city, a playlist): their own screen does that. */
    private fun configure() {
        val (wid, info) = pending ?: return
        val optional = info.widgetFeatures and AppWidgetProviderInfo.WIDGET_FEATURE_CONFIGURATION_OPTIONAL != 0
        if (info.configure != null && !optional) runCatching { host.startAppWidgetConfigureActivityForResult(act, wid, 0, REQ_CONFIG, null) }.onFailure { place() }
        else place()
    }

    private fun place() {
        val (wid, info) = pending ?: return
        pending = null
        val (c, r) = defaultSpan(info)
        items.add(Item("widget", wid.toString(), c, r)); save(); render()
        grid.post { (grid.parent as? ScrollView)?.fullScroll(View.FOCUS_DOWN) }
    }

    /** The bind and configure screens' answers (HomeActivity passes them on). True if it was one of ours. */
    fun onResult(requestCode: Int, resultCode: Int): Boolean {
        if (requestCode != REQ_BIND && requestCode != REQ_CONFIG) return false
        val p = pending ?: return true
        if (resultCode != Activity.RESULT_OK) { runCatching { host.deleteAppWidgetId(p.first) }; pending = null; return true }
        if (requestCode == REQ_BIND) configure() else place()
        return true
    }

    private fun defaultSpan(info: AppWidgetProviderInfo): Pair<Int, Int> {
        if (info.targetCellWidth > 0 && info.targetCellHeight > 0) return info.targetCellWidth.coerceIn(1, 4) to info.targetCellHeight.coerceIn(1, 5)
        return cellsFor(info.minWidth, info.minHeight)
    }

    /** Android's sizing rule of thumb for widgets: cells = (dp + 30) / 70. */
    private fun cellsFor(wPx: Int, hPx: Int): Pair<Int, Int> =
        ceil((wPx / dp + 30) / 70f - 0.01f).toInt().coerceIn(1, 4) to ceil((hPx / dp + 30) / 70f - 0.01f).toInt().coerceIn(1, 5)
}
