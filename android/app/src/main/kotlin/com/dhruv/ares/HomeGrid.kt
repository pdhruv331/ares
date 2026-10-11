package com.dhruv.ares

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.ScrollView
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * The home screen's second page (docs/launcher-v2-prompt.md §9): apps, Android widgets and ARES's own cards, four columns
 * wide, packed in your order (each item goes where its columns are lowest, then leftmost; nothing overlaps, nothing has to
 * be placed by hand). Hold an item to lift it, drag it among the others, let go to drop it; a hold without a drag is its menu.
 * Hold empty space to add something. A child's span is its [Span] (rows = 0: as tall as it wants to be, like the ARES cards).
 * Fluid (docs/phone-ui-prompt.md §3): the others glide to their new places on retargeted springs as the held item hovers;
 * the drop springs it into its slot and ticks when it settles.
 */
class HomeGrid @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : ViewGroup(ctx, attrs) {
    class Span(val cols: Int, val rows: Int) : ViewGroup.LayoutParams(MATCH_PARENT, WRAP_CONTENT)

    val columns = 4
    private val dp = resources.displayMetrics.density
    private val gap = (10 * dp).toInt()
    /** One column's width and one row's height (a row is a little taller than wide, like an app with its label). */
    var cell = 0f
        private set
    var unit = 0f
        private set
    var onOrder: (List<View>) -> Unit = {}
    var onMenu: (View) -> Unit = {}
    var onEmptyHold: () -> Unit = {}
    var emptyHint = ""
    private val placed = HashMap<View, Rect>()
    private var height0 = 0

    init { setWillNotDraw(false); clipChildren = false; clipToPadding = false }

    override fun generateLayoutParams(attrs: AttributeSet?) = Span(columns, 0)
    override fun generateDefaultLayoutParams() = Span(columns, 0)
    override fun checkLayoutParams(p: LayoutParams?) = p is Span

    private fun spanOf(v: View) = (v.layoutParams as? Span) ?: Span(columns, 0)

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val width = MeasureSpec.getSize(widthSpec)
        val avail = width - paddingLeft - paddingRight
        cell = (avail - gap * (columns - 1)) / columns.toFloat()
        unit = max(cell * 1.12f, 84 * dp)
        // The skyline: each column's lowest free y; an item takes the start column where it sits highest, then the leftmost
        val tops = IntArray(columns)
        placed.clear()
        for (i in 0 until childCount) {
            val v = getChildAt(i)
            if (v.visibility == GONE) continue
            val s = spanOf(v)
            val cols = s.cols.coerceIn(1, columns)
            val w = (cell * cols + gap * (cols - 1)).toInt()
            if (s.rows > 0) v.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec((unit * s.rows + gap * (s.rows - 1)).toInt(), MeasureSpec.EXACTLY))
            else v.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            var best = 0; var bestY = Int.MAX_VALUE
            for (c in 0..columns - cols) {
                val y = (c until c + cols).maxOf { tops[it] }
                if (y < bestY) { bestY = y; best = c }
            }
            val x = paddingLeft + (best * (cell + gap)).toInt()
            val r = Rect(x, paddingTop + bestY, x + v.measuredWidth, paddingTop + bestY + v.measuredHeight)
            placed[v] = r
            // Auto-height items take whole rows' worth of room only when they share a row with something; alone, just their height
            for (c in best until best + cols) tops[c] = bestY + v.measuredHeight + gap
        }
        height0 = (tops.maxOrNull() ?: 0) + paddingTop + paddingBottom
        val minH = if (MeasureSpec.getMode(heightSpec) == MeasureSpec.UNSPECIFIED) 0 else MeasureSpec.getSize(heightSpec)
        setMeasuredDimension(width, max(height0, max(minH, suggestedMinimumHeight)))
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for (i in 0 until childCount) {
            val v = getChildAt(i)
            val rect = placed[v] ?: continue
            val oldX = v.left; val oldY = v.top
            val moved = v.isLaidOut && (oldX != rect.left || oldY != rect.top)
            v.layout(rect.left, rect.top, rect.right, rect.bottom)
            if (v === held) { follow(); continue }
            // Glide from where it was to where it now goes (a spring, retargeted if it's already on its way)
            if (moved && dragging) {
                v.translationX += (oldX - rect.left).toFloat(); v.translationY += (oldY - rect.top).toFloat()
                Motion.to(v, Motion.X, 0f, Motion.DefaultSpatial); Motion.to(v, Motion.Y, 0f, Motion.DefaultSpatial)
            }
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if ((0 until childCount).none { getChildAt(it).visibility != GONE } && emptyHint.isNotEmpty()) {
            val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12 * dp; color = context.getColor(R.color.muted); textAlign = Paint.Align.CENTER }
            canvas.drawText(emptyHint, width / 2f, paddingTop + 60 * dp, p)
        }
    }

    // ---- Hold, drag, drop ---------------------------------------------------------------------------------------------

    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val holdMs = ViewConfiguration.getLongPressTimeout().toLong()
    private var x0 = 0f; private var y0 = 0f
    private var lastX = 0f; private var lastY = 0f
    private var under: View? = null // the item the finger went down on (null = empty space)
    private var lifted = false
    private var dragging = false
    private var held: View? = null
    private var grabX = 0f; private var grabY = 0f // where on the item the finger holds it
    val busy get() = held != null

    private val hold = Runnable {
        lifted = true
        Haptics.click(context)
        parent?.requestDisallowInterceptTouchEvent(true) // the scroller and the pager leave the finger to us now
        val v = under
        if (v == null) { onEmptyHold(); return@Runnable }
        held = v
        grabX = x0 - v.left; grabY = y0 - v.top
        Motion.cancel(v, Motion.X); Motion.cancel(v, Motion.Y)
        Motion.scale(v, 1.06f, Motion.FastSpatial)
        v.translationZ = 10 * dp
    }

    private fun childAt(x: Float, y: Float, skip: View? = null): View? {
        for (i in childCount - 1 downTo 0) {
            val v = getChildAt(i)
            if (v === skip || v.visibility == GONE) continue
            if (x >= v.left && x < v.right && y >= v.top && y < v.bottom) return v
        }
        return null
    }

    override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> start(e)
            MotionEvent.ACTION_MOVE -> { if (lifted) { move(e); return true }; if (kotlin.math.hypot(e.x - x0, e.y - y0) > slop) removeCallbacks(hold) }
            // A hold that ends where it started: the item's menu (the item itself gets a CANCEL, so no tap fires)
            MotionEvent.ACTION_UP -> { removeCallbacks(hold); if (lifted) { end(); return true } }
            MotionEvent.ACTION_CANCEL -> { removeCallbacks(hold); if (lifted) end(cancel = true) }
        }
        return lifted
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> start(e) // (empty space: keep the events coming so a hold can be noticed)
            MotionEvent.ACTION_MOVE -> if (lifted) move(e) else if (kotlin.math.hypot(e.x - x0, e.y - y0) > slop) removeCallbacks(hold)
            MotionEvent.ACTION_UP -> { removeCallbacks(hold); if (lifted) end() }
            MotionEvent.ACTION_CANCEL -> { removeCallbacks(hold); if (lifted) end(cancel = true) }
        }
        return true
    }

    private fun start(e: MotionEvent) {
        if (lifted) return
        x0 = e.x; y0 = e.y; lastX = e.x; lastY = e.y
        under = childAt(e.x, e.y)
        removeCallbacks(hold); postDelayed(hold, holdMs)
    }

    private fun move(e: MotionEvent) {
        lastX = e.x; lastY = e.y
        val v = held ?: return
        if (!dragging && kotlin.math.hypot(e.x - x0, e.y - y0) > slop) dragging = true
        if (!dragging) return
        follow()
        // The item under the finger gives up its place: the held one goes there and the rest move along
        val target = childAt(e.x, e.y, skip = v)
        if (target != null) {
            val to = indexOfChild(target)
            if (to != indexOfChild(v)) { detachViewFromParent(v); attachViewToParent(v, to, v.layoutParams); Haptics.tick(context); requestLayout() }
        }
        edgeScroll()
    }

    private fun follow() {
        val v = held ?: return
        v.translationX = lastX - grabX - v.left
        v.translationY = lastY - grabY - v.top
    }

    /** Near the top or bottom of the visible part, the page scrolls with the held item. */
    private fun edgeScroll() {
        val sv = parent as? ScrollView ?: return
        val yIn = lastY - sv.scrollY
        val zone = 70 * dp
        val dy = when { yIn < zone -> -((zone - yIn) / 4).toInt(); yIn > sv.height - zone -> ((yIn - (sv.height - zone)) / 4).toInt(); else -> 0 }
        if (dy == 0) return
        val before = sv.scrollY
        sv.scrollBy(0, dy)
        val did = sv.scrollY - before
        if (did != 0) { lastY += did; follow(); postOnAnimation { if (held != null) edgeScroll() } }
    }

    private fun end(cancel: Boolean = false) {
        val v = held
        val wasDrag = dragging
        lifted = false; dragging = false; held = null; under = null
        parent?.requestDisallowInterceptTouchEvent(false)
        if (v == null) return
        v.translationZ = 0f
        Motion.scale(v, 1f, Motion.DefaultSpatial)
        Motion.to(v, Motion.X, 0f, Motion.DefaultSpatial)
        Motion.to(v, Motion.Y, 0f, Motion.DefaultSpatial) { if (wasDrag) Haptics.settle(context) }
        if (wasDrag) onOrder((0 until childCount).map(::getChildAt))
        else if (!cancel) onMenu(v)
    }
}
