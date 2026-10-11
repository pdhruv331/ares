package com.dhruv.ares

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * The paged app drawer's views (the Samsung-style Apps screen): [DrawerPager] holds one [DrawerGrid] per page and swipes
 * between them with the motion kit (finger 1:1, the throw picks the page, rubber bands at the ends; a downward pull is handed
 * up to close the sheet); a [DrawerGrid] lays its items in cols × rows cells and glides them on springs when their slots change;
 * a [DrawerCell] is an app (icon + label) or a folder (a 2×2 preview + name); [DrawerDots] shows the pages with a sprung pill.
 */
class DrawerCell(ctx: Context) : LinearLayout(ctx) {
    val icon = ImageView(ctx)
    val preview = FolderPreview(ctx)
    val label = TextView(ctx).apply {
        textSize = 10f; setTextColor(ctx.getColor(R.color.text_user)); maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        gravity = Gravity.CENTER; typeface = android.graphics.Typeface.SANS_SERIF
    }
    var item: DrawerModel.Item? = null
        private set
    val id: String get() = item?.id ?: ""

    init {
        orientation = VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
        addView(icon); addView(preview); addView(label)
        isHapticFeedbackEnabled = false
    }

    fun bind(it0: DrawerModel.Item, iconPx: Int, textSp: Float) {
        item = it0
        val dp = resources.displayMetrics.density
        label.textSize = textSp
        label.setPadding((2 * dp).toInt(), (5 * dp).toInt(), (2 * dp).toInt(), 0)
        icon.layoutParams = LayoutParams(iconPx, iconPx); preview.layoutParams = LayoutParams(iconPx, iconPx)
        when (it0) {
            is DrawerModel.Item.App -> {
                val app = Apps.find(it0.key)
                icon.visibility = VISIBLE; preview.visibility = GONE
                label.text = app?.label ?: ""
                contentDescription = app?.label
                icon.tag = it0.key
                val now = app?.let { Icons.get(context, it, iconPx) { bmp -> if (icon.tag == it0.key) icon.setImageBitmap(bmp) } }
                if (now != null) icon.setImageBitmap(now) else icon.setImageDrawable(null)
            }
            is DrawerModel.Item.Folder -> {
                icon.visibility = GONE; preview.visibility = VISIBLE
                label.text = it0.name
                contentDescription = "${it0.name} folder"
                preview.set(it0.apps.take(4), iconPx)
            }
        }
    }
}

/** A folder's icon: the first four apps' icons on a dark rounded square. */
class FolderPreview(ctx: Context) : View(ctx) {
    private var keys: List<String> = emptyList()
    private var px = 0
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val r = RectF()
    fun set(apps: List<String>, iconPx: Int) { keys = apps; px = iconPx; invalidate() }
    override fun onDraw(canvas: Canvas) {
        val dp = resources.displayMetrics.density
        val w = width.toFloat(); val h = height.toFloat()
        r.set(dp, dp, w - dp, h - dp)
        fill.color = 0xFF08161F.toInt(); canvas.drawRoundRect(r, w * 0.26f, w * 0.26f, fill)
        stroke.color = Scheme.color; stroke.alpha = 90; stroke.strokeWidth = dp; canvas.drawRoundRect(r, w * 0.26f, w * 0.26f, stroke)
        val mini = (w * 0.36f).toInt().coerceAtLeast(1)
        val gap = (w - 2 * mini) / 3f
        keys.forEachIndexed { i, k ->
            val app = Apps.find(k) ?: return@forEachIndexed
            val bmp = Icons.get(context, app, mini) { invalidate() } ?: return@forEachIndexed
            val x = gap + (i % 2) * (mini + gap); val y = gap + (i / 2) * (mini + gap)
            r.set(x, y, x + mini, y + mini)
            canvas.drawBitmap(bmp, null, r, null)
        }
    }
}

/**
 * One page: `items` in cols × rows cells (rows = 0: as many rows as needed, for search results). Cells are kept by item id
 * across binds; a cell whose slot changed glides there on a spring. `slotAt` is the cell under a point (it may be past the
 * last item: "after the end"). Taps and holds go to `onTap` / `onHold` (a hold is ~0.4 s without moving).
 */
class DrawerGrid(ctx: Context) : ViewGroup(ctx) {
    var cols = 4
    var rows = 6
    var items: List<DrawerModel.Item> = emptyList()
        private set
    private val cells = LinkedHashMap<String, DrawerCell>()
    private val slot = HashMap<String, Int>()
    var onTap: (DrawerModel.Item, DrawerCell) -> Unit = { _, _ -> }
    var onHold: (DrawerModel.Item, DrawerCell) -> Unit = { _, _ -> }
    var holdMs = 400L
    /** The id of the item whose cell is lifted (drawn invisible: the floater stands in for it). */
    var hole: String? = null
        set(v) { field = v; for ((id, c) in cells) c.visibility = if (id == v) INVISIBLE else VISIBLE }
    private val dp = resources.displayMetrics.density
    var cellW = 0f; var cellH = 0f
        private set

    init { clipChildren = false; clipToPadding = false }

    val iconPx: Int get() = (minOf(cellW * 0.62f, cellH * 0.52f)).toInt().coerceAtLeast((36 * dp).toInt())
    private val textSp: Float get() = if (cols >= 5) 9f else 10f

    fun cellOf(id: String): DrawerCell? = cells[id]
    fun indexOf(id: String): Int = items.indexOfFirst { it.id == id }

    /** Bring the cells in line with `items`; with `animate`, moved cells glide and new ones fade in. */
    fun bind(list: List<DrawerModel.Item>, animate: Boolean = true) {
        val old = HashMap(slot)
        items = list
        val want = list.map { it.id }.toHashSet()
        for (id in cells.keys.toList()) if (id !in want) { removeView(cells.remove(id)); slot.remove(id) }
        list.forEachIndexed { i, it0 ->
            val c = cells.getOrPut(it0.id) { DrawerCell(context).also { v -> addView(v); attachTouch(v); if (animate && Motion.enabled) { v.alpha = 0f; Motion.to(v, Motion.ALPHA, 1f, Motion.DefaultEffects) } } }
            c.bind(it0, iconPx.coerceAtLeast(1), textSp)
            c.visibility = if (it0.id == hole) INVISIBLE else VISIBLE
            slot[it0.id] = i
            val was = old[it0.id]
            if (animate && was != null && was != i && isLaidOut && Motion.enabled) {
                // Glide from the old slot: the layout pass puts it at the new one; the translation walks back and springs to 0
                val from = rectOf(was); val to = rectOf(i)
                c.translationX += (from.left - to.left).toFloat(); c.translationY += (from.top - to.top).toFloat()
                Motion.to(c, Motion.X, 0f, Motion.DefaultSpatial); Motion.to(c, Motion.Y, 0f, Motion.DefaultSpatial)
            }
        }
        requestLayout()
    }

    fun rectOf(index: Int): Rect {
        val col = index % cols; val row = index / cols
        val x = paddingLeft + (col * cellW).toInt(); val y = paddingTop + (row * cellH).toInt()
        return Rect(x, y, x + cellW.toInt(), y + cellH.toInt())
    }

    /** The slot under (x, y) in this grid, clamped to the grid's columns and rows (may be ≥ items.size). */
    fun slotAt(x: Float, y: Float): Int {
        if (cellW <= 0f || cellH <= 0f) return 0
        val col = ((x - paddingLeft) / cellW).toInt().coerceIn(0, cols - 1)
        val maxRow = if (rows > 0) rows - 1 else Int.MAX_VALUE
        val row = ((y - paddingTop) / cellH).toInt().coerceIn(0, maxRow)
        return row * cols + col
    }
    /** How central (0 at the edge .. 1 at the centre) the point is inside its cell: a drop onto an app needs the middle. */
    fun centrality(x: Float, y: Float): Float {
        if (cellW <= 0f) return 0f
        val fx = ((x - paddingLeft) / cellW) % 1f; val fy = ((y - paddingTop) / cellH) % 1f
        return 1f - maxOf(abs(fx - 0.5f), abs(fy - 0.5f)) * 2f
    }
    fun itemAt(x: Float, y: Float): DrawerModel.Item? = items.getOrNull(slotAt(x, y))

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val w = MeasureSpec.getSize(widthSpec)
        val availW = (w - paddingLeft - paddingRight).coerceAtLeast(1)
        cellW = availW / cols.toFloat()
        val h: Int
        if (rows > 0) {
            h = MeasureSpec.getSize(heightSpec)
            cellH = ((h - paddingTop - paddingBottom).coerceAtLeast(1) / rows.toFloat())
        } else {
            cellH = cellW * 1.22f
            h = (ceil(items.size / cols.toFloat()).toInt().coerceAtLeast(1) * cellH).toInt() + paddingTop + paddingBottom
        }
        val cw = MeasureSpec.makeMeasureSpec(cellW.toInt(), MeasureSpec.EXACTLY); val ch = MeasureSpec.makeMeasureSpec(cellH.toInt(), MeasureSpec.AT_MOST)
        for ((id, c) in cells) { c.bind(items.firstOrNull { it.id == id } ?: continue, iconPx, textSp); c.measure(cw, ch) }
        setMeasuredDimension(w, h)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for ((id, c) in cells) {
            val i = slot[id] ?: continue
            val rect = rectOf(i)
            val top = rect.top + ((cellH - c.measuredHeight) / 2f).toInt().coerceAtLeast(0)
            c.layout(rect.left, top, rect.left + c.measuredWidth, top + c.measuredHeight)
        }
    }

    // A cell's own touches: a tap, or a hold (~0.4 s still) that the drawer turns into a drag or a menu
    private val slopPx = ViewConfiguration.get(ctx).scaledTouchSlop
    private fun attachTouch(c: DrawerCell) {
        var x0 = 0f; var y0 = 0f; var held = false
        val hold = Runnable { held = true; c.item?.let { onHold(it, c) } }
        c.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { x0 = e.rawX; y0 = e.rawY; held = false; v.postDelayed(hold, holdMs); Motion.scale(v, 0.94f, Motion.FastSpatial) }
                MotionEvent.ACTION_MOVE -> if (!held && hypot(e.rawX - x0, e.rawY - y0) > slopPx) { v.removeCallbacks(hold); Motion.scale(v, 1f, Motion.DefaultSpatial) }
                MotionEvent.ACTION_UP -> { v.removeCallbacks(hold); if (!held) { Motion.scale(v, 1f, Motion.DefaultSpatial); if (hypot(e.rawX - x0, e.rawY - y0) <= slopPx) c.item?.let { onTap(it, c) } } }
                MotionEvent.ACTION_CANCEL -> { v.removeCallbacks(hold); if (!held) Motion.scale(v, 1f, Motion.DefaultSpatial) }
            }
            true
        }
    }
}

/**
 * The pages side by side. A sideways drag moves them 1:1 and the release keeps the finger's speed; past the first or last
 * page they rubber-band. A downward drag is the sheet's (`onPull` / `onPullRelease`): the drawer follows the finger down.
 */
class DrawerPager(ctx: Context) : ViewGroup(ctx) {
    var page = 0
        private set
    var onPage: (Int) -> Unit = {}
    var onScroll: (Float) -> Unit = {}
    var onPull: (Float) -> Unit = {}
    var onPullRelease: (Float) -> Unit = {}
    var onMoving: (Boolean) -> Unit = {}
    var pullEnabled = true
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val minFling = ViewConfiguration.get(ctx).scaledMinimumFlingVelocity * 6f
    private var x0 = 0f; private var y0 = 0f
    private var mode = NONE
    private var vt: VelocityTracker? = null
    private var moving = false
        set(v) { if (field != v) { field = v; onMoving(v) } }
    private val offset = Motion.Value(0f, Motion.DefaultSpatial) { place() }

    init { clipChildren = false }

    val grids: List<DrawerGrid> get() = (0 until childCount).map { getChildAt(it) as DrawerGrid }
    val current: DrawerGrid? get() = getChildAt(page.coerceIn(0, childCount - 1)) as? DrawerGrid

    /** One grid per page, reused; `cols`/`rows` for each. */
    fun setPages(pages: List<List<DrawerModel.Item>>, cols: Int, rows: Int, animate: Boolean, hole: String? = null) {
        while (childCount > pages.size) removeViewAt(childCount - 1)
        while (childCount < pages.size) addView(DrawerGrid(context).also { it.setPadding(paddingLeft, 0, paddingRight, 0); onGrid(it) })
        pages.forEachIndexed { i, items -> (getChildAt(i) as DrawerGrid).apply { this.cols = cols; this.rows = rows; this.hole = hole; bind(items, animate) } }
        if (page >= childCount) go(childCount - 1, animate = false)
        place()
    }
    /** Wiring for every grid made here (taps and holds). */
    var onGrid: (DrawerGrid) -> Unit = {}

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val w = MeasureSpec.getSize(widthSpec); val h = MeasureSpec.getSize(heightSpec)
        for (i in 0 until childCount) getChildAt(i).measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
        setMeasuredDimension(w, h)
    }
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for (i in 0 until childCount) getChildAt(i).layout(0, 0, r - l, b - t)
        if (width > 0) offset.minimumVisibleChange = 0.5f / width
        place()
    }
    private fun place() {
        val k = offset.value
        for (i in 0 until childCount) getChildAt(i).translationX = (i - k) * width
        onScroll(k)
        if (!offset.moving && mode != SIDEWAYS) moving = false
    }

    private fun track(e: MotionEvent) { if (e.actionMasked == MotionEvent.ACTION_DOWN) { vt?.recycle(); vt = VelocityTracker.obtain() }; vt?.addMovement(e) }
    private fun decide(e: MotionEvent) {
        if (mode != NONE) return
        val dx = e.x - x0; val dy = e.y - y0
        if (abs(dx) > slop && abs(dx) > abs(dy) * 1.2f && childCount > 1) { mode = SIDEWAYS; moving = true }
        else if (dy > slop && abs(dy) > abs(dx) * 1.2f && pullEnabled) mode = DOWN
        else if (abs(dx) > slop && childCount <= 1) mode = SIDEWAYS.also { moving = true } // (one page: it still rubber-bands)
    }
    override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
        track(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { x0 = e.x; y0 = e.y; mode = NONE; if (offset.moving) { offset.set(offset.value); mode = SIDEWAYS; moving = true; x0 = e.x + (offset.value - page) * width; return true } }
            MotionEvent.ACTION_MOVE -> { decide(e); return mode != NONE }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> mode = NONE
        }
        return false
    }
    override fun onTouchEvent(e: MotionEvent): Boolean {
        track(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { x0 = e.x; y0 = e.y; mode = NONE; if (offset.moving) { offset.set(offset.value); mode = SIDEWAYS; moving = true; x0 = e.x + (offset.value - page) * width } }
            MotionEvent.ACTION_MOVE -> {
                decide(e)
                if (mode == SIDEWAYS && width > 0) offset.set(Motion.band(page - (e.x - x0) / width, 0f, (childCount - 1).coerceAtLeast(0).toFloat(), 1f, 0.5f))
                else if (mode == DOWN) onPull((e.y - y0 - slop).coerceAtLeast(0f))
            }
            MotionEvent.ACTION_UP -> {
                vt?.computeCurrentVelocity(1000)
                when (mode) { SIDEWAYS -> release(vt?.xVelocity ?: 0f); DOWN -> onPullRelease(vt?.yVelocity ?: 0f) }
                mode = NONE
            }
            MotionEvent.ACTION_CANCEL -> { if (mode == SIDEWAYS) go(page) else if (mode == DOWN) onPullRelease(0f); mode = NONE }
        }
        return true
    }
    private fun release(vx: Float) {
        if (width <= 0) return go(page)
        val v = -vx / width
        val target = when { abs(vx) > minFling -> if (v > 0) page + 1 else page - 1; else -> (offset.value + Motion.project(v)).roundToInt() }
            .coerceIn((page - 1).coerceAtLeast(0), (page + 1).coerceAtMost((childCount - 1).coerceAtLeast(0)))
        go(target, velocity = v)
    }
    fun go(to: Int, animate: Boolean = true, velocity: Float? = null) {
        val target = to.coerceIn(0, (childCount - 1).coerceAtLeast(0))
        val changed = target != page
        page = target
        if (!animate) { offset.set(target.toFloat()); moving = false }
        else { moving = true; offset.to(target.toFloat(), if (velocity != null) Motion.DefaultSpatial else Motion.TapSpatial, velocity) { moving = false } }
        if (changed) onPage(target)
    }
    private companion object { const val NONE = 0; const val SIDEWAYS = 1; const val DOWN = 2 }
}

/** The page dots: a sprung pill on the current page, small dots for the rest. */
class DrawerDots(ctx: Context) : View(ctx) {
    var count = 1
        set(v) { field = v.coerceAtLeast(1); invalidate() }
    private val at = Motion.Value(0f, Motion.DefaultSpatial) { invalidate() }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val r = RectF()
    fun set(k: Float) { at.set(k) }
    override fun onDraw(canvas: Canvas) {
        val dp = resources.displayMetrics.density
        val dot = 5 * dp; val pill = 14 * dp; val step = 14 * dp
        val total = (count - 1) * step + pill
        val x0 = (width - total) / 2f + (pill - dot) / 2f // dot centres, with room for the pill around whichever is current
        val k = at.value.coerceIn(0f, (count - 1).toFloat())
        val cy = height / 2f
        paint.color = Scheme.color
        for (i in 0 until count) { paint.alpha = 70; canvas.drawCircle(x0 + i * step, cy, dot / 2, paint) }
        // The pill slides between dots with the pages
        val cx = x0 + k * step
        paint.alpha = 230
        r.set(cx - pill / 2, cy - dot / 2, cx + pill / 2, cy + dot / 2)
        canvas.drawRoundRect(r, dot / 2, dot / 2, paint)
    }
}
