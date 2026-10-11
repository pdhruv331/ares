package com.dhruv.ares

import android.app.Activity
import android.content.Intent
import android.content.pm.LauncherApps
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.hypot

/**
 * The home screen's app drawer, PAGED like One UI's Apps screen (DrawerPages.kt, DrawerModel.kt): a grid of 4×6 (or 5×6)
 * per page, swiped sideways with the motion kit, page dots below, the search field on top (results replace the pages while
 * you type, and ask ARES when nothing matches). ⋮ = Custom order / A–Z, and the grid size.
 * Rearranging (custom): hold ~0.4 s to lift an app, the others slide out of its way on springs, hold at an edge to flip pages
 * (a new page after the last), drop onto an app and hold to make a folder (Samsung-style: a 2×2 preview; tap opens it as a
 * sprung sheet that pages too; drag apps in and out; one app left dissolves it; tap the title to rename).
 * The sheet itself follows the finger up from the dock (`track` / `release`) and down from the grid, opens and closes from
 * wherever it is with the finger's own speed; the grid's bottom rides the keyboard frame by frame. `pick` mode fills an
 * empty dock slot instead of opening.
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
    private val search: EditText = root.findViewById(R.id.search)
    private val menuBtn: TextView = root.findViewById(R.id.drawerMenu)
    private val scan: View = root.findViewById(R.id.scan)
    private val frame: DragFrame = root.findViewById(R.id.dragFrame)
    private val pagesBox: FrameLayout = root.findViewById(R.id.pagesBox)
    private val searchScroll: ScrollView = root.findViewById(R.id.searchScroll)
    private val searchBox: LinearLayout = root.findViewById(R.id.searchBox)
    private val edgeLeft: View = root.findViewById(R.id.edgeLeft)
    private val edgeRight: View = root.findViewById(R.id.edgeRight)
    private val prefs = Ares.prefs(act)
    private val dp = act.resources.displayMetrics.density
    private val slop = android.view.ViewConfiguration.get(act).scaledTouchSlop
    private val minFling = android.view.ViewConfiguration.get(act).scaledMinimumFlingVelocity * 6f
    private val model = DrawerModel(act)
    private val pager = DrawerPager(act)
    private val dots = DrawerDots(act)
    private val searchGrid = DrawerGrid(act).apply { rows = 0 }
    private val askRow = TextView(act).apply {
        textSize = 14f; setTextColor(act.getColor(R.color.text)); background = act.getDrawable(R.drawable.bg_chip)
        setPadding((16 * dp).toInt(), (14 * dp).toInt(), (16 * dp).toInt(), (14 * dp).toInt())
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = (10 * dp).toInt() }
    }
    private var picking = false
    private var pageBeforeSearch = 0
    /** The sheet's position: 0 = open, height = closed (below the screen). */
    private val pos = Motion.Value(0f, Motion.SlowSpatial) { y -> root.translationY = y }
    private var opening = false // the finger is dragging it up from the dock
    private var lastOpenMs = 0L
    var onOpenChanged: (Boolean) -> Unit = {}
    private var closingSheet = false
    private val h get() = root.height.toFloat().coerceAtLeast(1f)

    val isOpen get() = root.visibility == View.VISIBLE && !opening && pos.value < root.height * 0.5f && !closingSheet

    init {
        pagesBox.addView(pager, FrameLayout.LayoutParams(-1, -1))
        pager.setPadding((10 * dp).toInt(), 0, (10 * dp).toInt(), 0)
        root.findViewById<FrameLayout>(R.id.dotsBox).addView(dots, FrameLayout.LayoutParams(-1, -1))
        pager.onGrid = { g -> g.onTap = { item, cell -> tap(item, cell) }; g.onHold = { item, cell -> hold(item, cell, inFolder = null) } }
        pager.onScroll = { k -> dots.set(k) }
        pager.onPage = { Haptics.tick(act) }
        pager.onMoving = { on -> Perf.state("Drawer", if (on) "Paging" else null) }
        // A downward pull on the grid: the sheet follows the finger down, and the release decides open or closed
        pager.onPull = { dy -> pos.set(dy) }
        pager.onPullRelease = { vy -> release(vy) }
        searchBox.addView(searchGrid, LinearLayout.LayoutParams(-1, -2))
        searchBox.addView(askRow)
        searchGrid.onTap = { item, cell -> tap(item, cell) }
        searchGrid.onHold = { item, cell -> (item as? DrawerModel.Item.App)?.let { a -> Apps.find(a.key)?.let { app -> Motion.scale(cell, 1f, Motion.DefaultSpatial); menu(cell, app) } } }
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) { build(s?.toString().orEmpty()) }
        })
        search.setOnEditorActionListener { _, id, _ ->
            if (id != EditorInfo.IME_ACTION_GO) return@setOnEditorActionListener false
            val q = search.text.toString().trim()
            val first = (searchGrid.items.firstOrNull() as? DrawerModel.Item.App)?.let { Apps.find(it.key) }
            if (first != null && !picking) launch(first, null) else if (q.isNotEmpty() && !picking) askNow(q)
            true
        }
        root.findViewById<View>(R.id.drawerHome).setOnClickListener { close() }
        menuBtn.setOnClickListener { optionsMenu() }
        // The grid's bottom follows the keyboard frame by frame, not in one jump
        root.setWindowInsetsAnimationCallback(object : WindowInsetsAnimation.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
            override fun onProgress(insets: WindowInsets, running: MutableList<WindowInsetsAnimation>): WindowInsets {
                if (running.none { it.typeMask and WindowInsets.Type.ime() != 0 }) return insets
                val bars = insets.getInsets(WindowInsets.Type.systemBars()); val ime = insets.getInsets(WindowInsets.Type.ime())
                root.setPadding(root.paddingLeft, root.paddingTop, root.paddingRight, kotlin.math.max(bars.bottom, ime.bottom))
                return insets
            }
        })
    }

    // ---- The sheet: open, close, follow the finger ------------------------------------------------------------------

    private fun prepare(pick: Boolean, forHome: Boolean) {
        picking = pick
        menuBtn.visibility = if (pick) View.INVISIBLE else View.VISIBLE
        search.setText("")
        search.hint = if (!pick) "SEARCH OR ASK" else if (forHome) "PICK AN APP FOR HOME" else "PICK AN APP FOR THE DOCK"
        closeFolder(animate = false)
        build("", animate = false)
        pager.go(0, animate = false)
    }

    /** Open it (a tap on the handle, a pick): from below, critically damped. */
    fun open(pick: Boolean = false, forHome: Boolean = false) {
        if (isOpen && !pick) return
        prepare(pick, forHome)
        closingSheet = false
        if (root.visibility != View.VISIBLE) { root.visibility = View.VISIBLE; pos.set(h) }
        settle(open = true, velocity = null, tapped = true)
    }

    /** The finger is dragging the sheet up from the dock: it follows, `dy` px above where the drag started. */
    fun track(dy: Float) {
        if (!opening) {
            opening = true; closingSheet = false
            if (root.visibility != View.VISIBLE || !isOpen) prepare(false, false)
            root.visibility = View.VISIBLE
            if (pos.value <= 0f) pos.set(h)
        }
        pos.set(Motion.band(h - dy, 0f, h, h, 0.4f))
    }

    /** ...and let go: open or closed, whichever the throw lands nearer, with the finger's speed. */
    fun release(vy: Float) {
        opening = false
        val open = Motion.pick(pos.value, vy, h, 0f, minFling) == 0f
        settle(open, vy, tapped = false)
    }

    private fun settle(open: Boolean, velocity: Float?, tapped: Boolean) {
        val wasOpen = isOpen
        if (!open) { closingSheet = true; hideKeyboard(); closeFolder(animate = false) }
        val spec = if (tapped) Motion.TapSlow else Motion.SlowSpatial
        val target = if (open) 0f else h
        if (open && !wasOpen && System.currentTimeMillis() - lastOpenMs > 400) { lastOpenMs = System.currentTimeMillis(); staggerCells(); sweep() }
        pos.to(target, spec, velocity) { if (!open) { root.visibility = View.GONE; closingSheet = false } }
        if (!Motion.enabled && !open) { root.visibility = View.GONE; closingSheet = false }
        onOpenChanged(open)
    }

    /** The current page's cells enter 15 ms apart, from a little below. */
    private fun staggerCells() {
        if (!Motion.enabled) return
        pager.post { pager.current?.let { g -> Motion.stagger((0 until g.childCount).map(g::getChildAt).filter { it.visibility == View.VISIBLE }, 16 * dp, 15) } }
    }

    private fun sweep() {
        if (!Motion.enabled) return
        scan.alpha = 0.8f; scan.translationY = 0f
        scan.post { scan.animate().translationY((scan.parent as View).height.toFloat()).alpha(0f).setDuration(420).start() }
    }

    private fun hideKeyboard() {
        act.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(search.windowToken, 0)
        search.clearFocus()
    }

    fun close(animate: Boolean = true) {
        if (root.visibility != View.VISIBLE || closingSheet) return
        hideKeyboard()
        if (!animate || !Motion.enabled) { pos.cancel(); root.visibility = View.GONE; opening = false; closeFolder(false); onOpenChanged(false); return }
        settle(open = false, velocity = null, tapped = true)
    }

    /** Something inside the drawer that Back should close first (a folder sheet, a search): true if it took the press. */
    fun backInside(): Boolean {
        if (folderSheet != null) { closeFolder(true); return true }
        if (search.text.isNotBlank()) { search.setText(""); hideKeyboard(); return true }
        return false
    }

    /** Predictive back: the sheet steps down with the gesture (k = 0..1), then commits (`close`) or springs back (`settleBack`). */
    fun peek(k: Float) { if (root.visibility == View.VISIBLE) pos.set(h * 0.35f * k) }
    fun settleBack() { if (root.visibility == View.VISIBLE) pos.to(0f, Motion.TapSlow) }

    /** The app list changed (installs, removals, the dock, icon style). */
    fun refresh() { if (root.visibility == View.VISIBLE && drag == null) build(search.text.toString(), animate = true) }

    // ---- The pages and the search --------------------------------------------------------------------------------------

    private fun build(query: String, animate: Boolean = true) {
        val q = query.trim()
        if (q.isEmpty()) {
            if (searchScroll.visibility == View.VISIBLE) { searchScroll.visibility = View.GONE; pagesBox.visibility = View.VISIBLE; pager.go(pageBeforeSearch, animate = false) }
            dots.visibility = View.VISIBLE
            model.reconcile()
            showPages(animate)
            return
        }
        if (searchScroll.visibility != View.VISIBLE) { pageBeforeSearch = pager.page; searchScroll.visibility = View.VISIBLE; pagesBox.visibility = View.GONE; dots.visibility = View.INVISIBLE }
        val hits = Apps.all.filter { it.label.contains(q, ignoreCase = true) }.sortedBy { if (it.label.startsWith(q, ignoreCase = true)) 0 else 1 }
        searchGrid.cols = model.cols
        searchGrid.bind(hits.map { DrawerModel.Item.App(it.key) }, animate = false)
        askRow.visibility = if (picking) View.GONE else View.VISIBLE
        askRow.text = "◉   Ask ARES: $q"
        askRow.setOnClickListener { askNow(q) }
        searchBox.removeView(askRow); searchBox.addView(askRow, if (hits.isEmpty()) 0 else 1)
        searchScroll.scrollTo(0, 0)
    }

    private fun showPages(animate: Boolean) {
        pager.setPages(model.arranged(), model.cols, model.rows, animate, drag?.id)
        dots.count = pager.childCount
    }

    private fun tap(item: DrawerModel.Item, cell: DrawerCell) {
        when (item) {
            is DrawerModel.Item.App -> Apps.find(item.key)?.let { app -> if (picking) { onPick(app); close() } else launch(app, cell.icon) }
            is DrawerModel.Item.Folder -> if (!picking) openFolder(item, cell) else {}
        }
    }

    private fun launch(app: Apps.App, from: View?) {
        Apps.open(act, app, from)
        root.postDelayed({ close(animate = false) }, 350) // gone by the time you come back home
    }

    private fun askNow(q: String) { close(); onAsk(q) }

    /** ⋮: the order (custom / A–Z) and the grid. */
    private fun optionsMenu() {
        val m = PopupMenu(act, menuBtn)
        m.menu.add(0, 1, 0, "Custom order").apply { isCheckable = true; isChecked = !model.az }
        m.menu.add(0, 2, 1, "A–Z").apply { isCheckable = true; isChecked = model.az }
        m.menu.setGroupCheckable(0, true, true)
        m.menu.add(1, 3, 2, "Grid 4 × 6").apply { isCheckable = true; isChecked = model.cols == 4 }
        m.menu.add(1, 4, 3, "Grid 5 × 6").apply { isCheckable = true; isChecked = model.cols == 5 }
        m.menu.setGroupCheckable(1, true, true)
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> { model.az = false; showPages(true) }
                2 -> { model.az = true; showPages(true); pager.go(0) }
                3 -> { model.setGrid("4x6"); showPages(false) }
                4 -> { model.setGrid("5x6"); showPages(false) }
            }
            true
        }
        m.show()
    }

    // ---- Rearranging: hold, lift, hover, flip pages, fold, drop ---------------------------------------------------------

    private class Drag(val item: DrawerModel.Item, val cell: DrawerCell, val floater: View, var inFolder: DrawerModel.Item.Folder?) {
        val id get() = item.id
        var moved = false
        var lastX = 0f; var lastY = 0f
        var stillX = 0f; var stillY = 0f
        var foldTarget: DrawerCell? = null
        var edgeDir = 0
        var armPending = false
        var armX = 0f; var armY = 0f
    }
    private var drag: Drag? = null
    private val edgePx get() = 40 * dp
    private val foldArm = Runnable { armFold() }
    private val edgeFlip = Runnable { flipEdge() }

    /** A held app or folder: lift it; moving drags it, letting go without moving is its menu. */
    private fun hold(item: DrawerModel.Item, cell: DrawerCell, inFolder: DrawerModel.Item.Folder?) {
        val app = (item as? DrawerModel.Item.App)?.let { Apps.find(it.key) }
        if (picking || search.text.isNotBlank()) { Motion.scale(cell, 1f, Motion.DefaultSpatial); if (app != null) menu(cell, app); return }
        if (model.az) { model.adoptAz(); showPages(false) } // (dragging in A–Z: the A–Z order becomes yours)
        Haptics.tick(act)
        Motion.scale(cell, 1.12f, Motion.FastSpatial)
        cell.translationZ = 12 * dp
        val x0 = frame.downX; val y0 = frame.downY
        val d = Drag(item, cell, makeFloater(item), inFolder).also { it.lastX = x0; it.lastY = y0; it.stillX = x0; it.stillY = y0 }
        frame.grab = { e ->
            d.lastX = e.x; d.lastY = e.y
            when (e.actionMasked) {
                MotionEvent.ACTION_MOVE -> {
                    if (!d.moved && hypot(e.x - x0, e.y - y0) > slop) startDrag(d)
                    if (d.moved) { d.floater.translationX = e.x - d.floater.width / 2f; d.floater.translationY = e.y - d.floater.height / 2f; hover(d) }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    frame.grab = null
                    if (d.moved) drop(d) else { Motion.scale(cell, 1f, Motion.DefaultSpatial); cell.translationZ = 0f; if (e.actionMasked == MotionEvent.ACTION_UP && app != null) menu(cell, app) }
                }
            }
        }
    }

    private fun makeFloater(item: DrawerModel.Item): View {
        val px = (pager.current?.iconPx ?: (52 * dp).toInt())
        return when (item) {
            is DrawerModel.Item.App -> ImageView(act).apply { Apps.find(item.key)?.let { a -> Icons.get(act, a, px) { setImageBitmap(it) }?.let(::setImageBitmap) } }
            is DrawerModel.Item.Folder -> FolderPreview(act).apply { set(item.apps.take(4), px) }
        }.apply { layoutParams = FrameLayout.LayoutParams(px, px); scaleX = 1.15f; scaleY = 1.15f; translationZ = 14 * dp; visibility = View.INVISIBLE }
    }

    private fun startDrag(d: Drag) {
        d.moved = true
        drag = d
        frame.addView(d.floater)
        val loc = IntArray(2).also(d.cell::getLocationInWindow); val fl = IntArray(2).also(frame::getLocationInWindow)
        d.floater.translationX = (loc[0] - fl[0] + (d.cell.width - d.floater.layoutParams.width) / 2f); d.floater.translationY = (loc[1] - fl[1]).toFloat()
        d.floater.visibility = View.VISIBLE
        Motion.scale(d.cell, 1f, Motion.FastEffects); d.cell.translationZ = 0f
        pager.pullEnabled = false
        if (d.inFolder != null) folderPager?.grids?.forEach { it.hole = d.id } else pager.grids.forEach { it.hole = d.id }
        Perf.state("Drawer", "Dragging")
    }

    /** Where the finger is: over an edge (arming a page flip), over another app (arming a folder), or a new slot (the others slide). */
    private fun hover(d: Drag) {
        val inFolder = d.inFolder
        if (inFolder != null) return hoverInFolder(d, inFolder)
        val x = d.lastX - pager.left; val y = d.lastY - pager.top
        val grid = pager.current ?: return
        // Edges: hold ~0.6 s to flip (the glow says it's armed)
        val dir = when { x < edgePx -> -1; x > pager.width - edgePx -> 1; else -> 0 }
        if (dir != d.edgeDir) {
            d.edgeDir = dir
            frame.removeCallbacks(edgeFlip)
            Motion.to(edgeLeft, Motion.ALPHA, if (dir < 0) 1f else 0f, Motion.DefaultEffects); Motion.to(edgeRight, Motion.ALPHA, if (dir > 0) 1f else 0f, Motion.DefaultEffects)
            if (dir != 0) frame.postDelayed(edgeFlip, 600)
        }
        if (dir != 0) { disarmFold(d); return }
        // The middle of another item is the folder zone (hold ~0.5 s still to make or join one); the gaps between items reorder
        val over = grid.itemAt(x, y)
        val still = hypot(d.lastX - d.stillX, d.lastY - d.stillY) <= slop
        if (!still) { d.stillX = d.lastX; d.stillY = d.lastY; disarmFold(d) }
        val central = over != null && over.id != d.id && grid.centrality(x, y) > 0.42f
        if (central) {
            // The timer starts on entering the middle and fires only if the finger is still there ~0.5 s later
            if (d.item is DrawerModel.Item.App && d.foldTarget == null && !d.armPending) { d.armPending = true; d.armX = d.lastX; d.armY = d.lastY; frame.postDelayed(foldArm, 500) }
            return
        }
        frame.removeCallbacks(foldArm); d.armPending = false
        // A new slot: the hole moves there, the others glide
        val idx = grid.slotAt(x, y).coerceAtMost((grid.items.size - 1).coerceAtLeast(0))
        if (grid.indexOf(d.id) != idx && grid.indexOf(d.id) >= 0) {
            model.move(d.id, pager.page, idx)
            showPages(true)
            Haptics.tick(act)
        } else if (grid.indexOf(d.id) < 0) { model.insert(pager.page, idx, model.remove(d.id) ?: return); showPages(true) }
    }

    private fun armFold() {
        val d = drag ?: return
        d.armPending = false
        if (hypot(d.lastX - d.armX, d.lastY - d.armY) > slop * 2) return // (moved on since)
        val grid = pager.current ?: return
        val over = grid.itemAt(d.lastX - pager.left, d.lastY - pager.top) ?: return
        if (over.id == d.id) return
        val cell = grid.cellOf(over.id) ?: return
        d.foldTarget = cell
        Motion.scale(cell, 1.18f, Motion.FastSpatial)
        ringOf(cell).background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Scheme.alpha(30)); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(160)) }
        Haptics.click(act)
    }
    private fun disarmFold(d: Drag) {
        frame.removeCallbacks(foldArm); d.armPending = false
        d.foldTarget?.let { Motion.scale(it, 1f, Motion.DefaultSpatial); ringOf(it).background = null }
        d.foldTarget = null
    }
    /** The round part of a cell (its icon or folder preview), where the folder ring is drawn. */
    private fun ringOf(cell: DrawerCell): View = if (cell.preview.visibility == View.VISIBLE) cell.preview else cell.icon

    /** Held at an edge: the hole goes onto the next or previous page (a new page after the last), and the pager flips. */
    private fun flipEdge() {
        val d = drag ?: return
        val dir = d.edgeDir
        if (dir == 0) return
        val p = pager.page
        val item = model.remove(d.id) ?: return
        if (dir > 0) {
            if (p + 1 >= model.pages.size && model.pages[p].isEmpty()) { model.insert(p, 0, item); return } // (alone on the last page: nowhere further)
            model.insert(p + 1, 0, item)
        } else {
            if (p == 0) { model.insert(0, 0, item); return }
            model.insert(p - 1, model.pages[p - 1].size, item)
        }
        showPages(true)
        pager.go(p + dir, animate = true)
        Haptics.click(act)
        frame.postDelayed(edgeFlip, 900) // keep flipping while the finger stays at the edge
    }

    private fun drop(d: Drag) {
        frame.removeCallbacks(foldArm); frame.removeCallbacks(edgeFlip)
        Motion.to(edgeLeft, Motion.ALPHA, 0f, Motion.DefaultEffects); Motion.to(edgeRight, Motion.ALPHA, 0f, Motion.DefaultEffects)
        pager.pullEnabled = true
        drag = null
        Perf.state("Drawer", null)
        val inFolder = d.inFolder
        if (inFolder != null) { dropInFolder(d, inFolder); return }
        val target = d.foldTarget?.item
        var landed: String = d.id // the cell the floater settles into
        if (target != null && d.item is DrawerModel.Item.App) {
            d.foldTarget?.let { ringOf(it).background = null; Motion.scale(it, 1f, Motion.DefaultSpatial) }
            when (target) {
                is DrawerModel.Item.App -> landed = model.makeFolder(target, d.item).id
                is DrawerModel.Item.Folder -> { model.addToFolder(target, d.item); landed = target.id }
            }
            Haptics.commit(act)
        }
        model.trim(); model.save()
        pager.grids.forEach { it.hole = null }
        showPages(true)
        // The floater springs into its cell (or shrinks into the folder it joined)
        val cell = pager.current?.cellOf(landed)
        val f = d.floater
        if (cell != null && Motion.enabled) {
            cell.post {
                val loc = IntArray(2).also(cell::getLocationInWindow); val fl = IntArray(2).also(frame::getLocationInWindow)
                val tx = loc[0] - fl[0] + (cell.width - f.width) / 2f; val ty = (loc[1] - fl[1]).toFloat()
                if (landed == d.id) cell.visibility = View.INVISIBLE
                Motion.to(f, Motion.X, tx, Motion.DefaultSpatial); Motion.to(f, Motion.Y, ty, Motion.DefaultSpatial)
                Motion.scale(f, if (landed == d.id) 1f else 0.3f, Motion.DefaultSpatial) { frame.removeView(f); cell.visibility = View.VISIBLE; Haptics.settle(act) }
                if (landed != d.id) Motion.to(f, Motion.ALPHA, 0f, Motion.DefaultEffects)
            }
        } else frame.removeView(f)
    }

    // ---- Folders --------------------------------------------------------------------------------------------------------

    private var folderSheet: View? = null
    private var folderPager: DrawerPager? = null
    private var folderOpen: DrawerModel.Item.Folder? = null
    private var folderFrom: DrawerCell? = null

    /** A folder opens as a sheet over the pages: its name (tap to rename), its apps on pages of 12. */
    private fun openFolder(folder: DrawerModel.Item.Folder, from: DrawerCell) {
        closeFolder(animate = false)
        folderOpen = folder; folderFrom = from
        val scrim = View(act).apply { setBackgroundColor(0x99020609.toInt()); setOnClickListener { closeFolder(true) } }
        val card = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = 22 * dp; setColor(0xF2081520.toInt()); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(90)) }
            setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
            setOnClickListener { }
        }
        val title = EditText(act).apply {
            setText(folder.name); textSize = 15f; setTextColor(act.getColor(R.color.text)); background = null; gravity = Gravity.CENTER
            isSingleLine = true; imeOptions = EditorInfo.IME_ACTION_DONE; typeface = android.graphics.Typeface.SANS_SERIF
            setOnEditorActionListener { v, _, _ -> folder.name = v.text.toString().trim().ifBlank { "Folder" }; model.save(); showPages(false); hideKeyboardFor(v); v.clearFocus(); true }
            setOnFocusChangeListener { v, has -> if (!has) { folder.name = (v as EditText).text.toString().trim().ifBlank { "Folder" }; model.save(); showPages(false) } }
        }
        val fp = DrawerPager(act).apply { setPadding((4 * dp).toInt(), 0, (4 * dp).toInt(), 0); pullEnabled = false }
        val fdots = DrawerDots(act)
        fp.onGrid = { g -> g.onTap = { item, cell -> tap(item, cell) }; g.onHold = { item, cell -> hold(item, cell, inFolder = folder) } }
        fp.onScroll = { k -> fdots.set(k) }
        card.addView(title, LinearLayout.LayoutParams(-1, -2))
        val cardW = (frame.width * 0.86f).toInt()
        val rowsNeeded = ((folder.apps.size + 3) / 4).coerceIn(1, 3)
        card.addView(fp, LinearLayout.LayoutParams(-1, (rowsNeeded * ((cardW - 32 * dp) / 4f) * 1.2f).toInt()))
        card.addView(fdots, LinearLayout.LayoutParams(-1, (18 * dp).toInt()))
        val sheet = FrameLayout(act).apply { addView(scrim, FrameLayout.LayoutParams(-1, -1)); addView(card, FrameLayout.LayoutParams(cardW, -2, Gravity.CENTER)) }
        frame.addView(sheet, FrameLayout.LayoutParams(-1, -1))
        folderSheet = sheet; folderPager = fp
        showFolderPages(folder, animate = false)
        fdots.count = fp.childCount
        if (Motion.enabled) {
            scrim.alpha = 0f; Motion.to(scrim, Motion.ALPHA, 1f, Motion.DefaultEffects)
            card.post {
                val loc = IntArray(2).also(from::getLocationInWindow); val cl = IntArray(2).also(card::getLocationInWindow)
                card.pivotX = card.width / 2f; card.pivotY = card.height / 2f
                card.translationX = (loc[0] + from.width / 2f) - (cl[0] + card.width / 2f); card.translationY = (loc[1] + from.height / 2f) - (cl[1] + card.height / 2f)
                card.scaleX = 0.25f; card.scaleY = 0.25f; card.alpha = 0.4f
                Motion.to(card, Motion.X, 0f, Motion.DefaultSpatial); Motion.to(card, Motion.Y, 0f, Motion.DefaultSpatial)
                Motion.scale(card, 1f, Motion.DefaultSpatial); Motion.to(card, Motion.ALPHA, 1f, Motion.DefaultEffects)
            }
        }
        Haptics.tick(act)
    }

    private fun hideKeyboardFor(v: View) = act.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(v.windowToken, 0)

    private fun showFolderPages(folder: DrawerModel.Item.Folder, animate: Boolean) {
        val fp = folderPager ?: return
        val pages = folder.apps.map<String, DrawerModel.Item> { DrawerModel.Item.App(it) }.chunked(12).ifEmpty { listOf(emptyList()) }
        fp.setPages(pages, 4, ((folder.apps.size + 3) / 4).coerceIn(1, 3), animate, drag?.takeIf { it.inFolder != null }?.id)
        ((folderSheet as? FrameLayout)?.getChildAt(1) as? LinearLayout)?.getChildAt(2)?.let { (it as DrawerDots).count = fp.childCount }
    }

    private fun closeFolder(animate: Boolean) {
        val sheet = folderSheet ?: return
        val from = folderFrom
        folderSheet = null; folderPager = null; folderOpen = null; folderFrom = null
        hideKeyboard()
        val card = (sheet as FrameLayout).getChildAt(1)
        if (!animate || !Motion.enabled || from == null) { frame.removeView(sheet); return }
        val loc = IntArray(2).also(from::getLocationInWindow); val cl = IntArray(2).also(card::getLocationInWindow)
        Motion.to(sheet.getChildAt(0), Motion.ALPHA, 0f, Motion.DefaultEffects)
        Motion.to(card, Motion.X, (loc[0] + from.width / 2f) - (cl[0] - card.translationX + card.width / 2f), Motion.TapSpatial)
        Motion.to(card, Motion.Y, (loc[1] + from.height / 2f) - (cl[1] - card.translationY + card.height / 2f), Motion.TapSpatial)
        Motion.to(card, Motion.ALPHA, 0f, Motion.DefaultEffects)
        Motion.scale(card, 0.25f, Motion.TapSpatial) { frame.removeView(sheet) }
    }

    /** Dragging inside the folder's sheet: reorder among its apps; leaving the card takes the app out onto the page below. */
    private fun hoverInFolder(d: Drag, folder: DrawerModel.Item.Folder) {
        val fp = folderPager ?: return
        val card = (folderSheet as? FrameLayout)?.getChildAt(1) ?: return
        val inside = d.lastX >= card.left && d.lastX <= card.right && d.lastY >= card.top && d.lastY <= card.bottom
        if (!inside) {
            // Out it comes: the folder loses it (dissolving if one is left), the page below gets the hole, and the drag carries on there
            val item = model.takeOut(folder, (d.item as DrawerModel.Item.App).key)
            d.inFolder = null
            closeFolder(animate = true)
            val grid = pager.current
            val idx = grid?.slotAt(d.lastX - pager.left, d.lastY - pager.top)?.coerceAtMost(grid.items.size) ?: 0
            model.insert(pager.page, idx, item)
            pager.grids.forEach { it.hole = d.id }
            showPages(true)
            Haptics.click(act)
            return
        }
        val grid = fp.current ?: return
        val x = d.lastX - card.left - fp.left; val y = d.lastY - card.top - fp.top
        val idx = grid.slotAt(x, y).coerceAtMost((grid.items.size - 1).coerceAtLeast(0))
        val page = fp.page
        val flat = folder.apps.indexOf((d.item as DrawerModel.Item.App).key)
        val want = page * 12 + idx
        if (flat >= 0 && flat != want && want < folder.apps.size) {
            folder.apps.add(want, folder.apps.removeAt(flat))
            showFolderPages(folder, true)
            Haptics.tick(act)
        }
    }

    private fun dropInFolder(d: Drag, folder: DrawerModel.Item.Folder) {
        model.save()
        folderPager?.grids?.forEach { it.hole = null }
        showFolderPages(folder, true)
        val cell = folderPager?.current?.cellOf(d.id)
        val f = d.floater
        if (cell != null && Motion.enabled) cell.post {
            val loc = IntArray(2).also(cell::getLocationInWindow); val fl = IntArray(2).also(frame::getLocationInWindow)
            cell.visibility = View.INVISIBLE
            Motion.to(f, Motion.X, loc[0] - fl[0] + (cell.width - f.width) / 2f, Motion.DefaultSpatial); Motion.to(f, Motion.Y, (loc[1] - fl[1]).toFloat(), Motion.DefaultSpatial)
            Motion.scale(f, 1f, Motion.DefaultSpatial) { frame.removeView(f); cell.visibility = View.VISIBLE; Haptics.settle(act) }
        } else frame.removeView(f)
    }

    // ---- The long-press menu ---------------------------------------------------------------------------------------------

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
