package com.dhruv.ares

import android.annotation.SuppressLint
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.LinearLayout
import kotlin.math.hypot

/**
 * Hold-and-drag rearranging for a row (the dock) or a column (the home cards) of views in a LinearLayout
 * (docs/launcher-v2-prompt.md §8): hold an item and it lifts; drag it and the others slide out of its way; let go and it
 * drops into place (`onDrop` gets the new order). A hold without a drag is the item's menu, a quick tap is its tap.
 * `handle` is where the finger goes (a card's header), `item` what moves (the whole card).
 * Fluid (docs/phone-ui-prompt.md §3): the others move on retargeted springs as the drag hovers; the drop springs the item
 * into its slot and the row is only rebuilt once the springs have settled (nothing is re-parented under a finger).
 */
class Reorder(private val box: LinearLayout, private val vertical: Boolean, private val onDrop: (List<View>) -> Unit) {
    var onTap: (View) -> Unit = {}
    var onMenu: (View) -> Unit = {}
    var dragging = false
        private set
    private val ctx = box.context
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val holdMs = ViewConfiguration.getLongPressTimeout().toLong()
    /** How much a held item grows: a dock icon a lot, a full-width card only a touch (it would be clipped). */
    var lift = if (vertical) 1.02f else 1.12f
    private val prop get() = if (vertical) Motion.Y else Motion.X

    private fun size(v: View): Float {
        val lp = v.layoutParams as? ViewGroup.MarginLayoutParams
        return if (vertical) v.height + (lp?.topMargin ?: 0) + (lp?.bottomMargin ?: 0).toFloat() else v.width + (lp?.leftMargin ?: 0) + (lp?.rightMargin ?: 0).toFloat()
    }
    private fun centre(v: View) = if (vertical) v.top + v.height / 2f else v.left + v.width / 2f
    private fun set(v: View, by: Float) { if (vertical) v.translationY = by else v.translationX = by }
    private fun shift(v: View, by: Float, onSettle: (() -> Unit)? = null) = Motion.to(v, prop, by, Motion.DefaultSpatial, null, onSettle)

    @SuppressLint("ClickableViewAccessibility")
    fun attach(handle: View, item: View = handle) {
        var x0 = 0f; var y0 = 0f; var lifted = false; var moved = false; var from = 0; var to = 0
        var centres = FloatArray(0)
        val dp = ctx.resources.displayMetrics.density
        val up = Runnable {
            lifted = true
            Haptics.click(ctx)
            box.parent?.requestDisallowInterceptTouchEvent(true) // the pager, the scroller: the finger is ours now
            Motion.scale(item, lift, Motion.FastSpatial)
            item.translationZ = 8 * dp
        }
        fun settle() {
            Motion.scale(item, 1f, Motion.DefaultSpatial)
            item.translationZ = 0f
            box.parent?.requestDisallowInterceptTouchEvent(false)
        }
        fun drop() {
            if (!moved) return
            moved = false; lifted = false
            if (item.parent !== box) { dragging = false; settle(); return } // (the row was rebuilt under the finger: nothing to drop into)
            // The item springs into its new slot (the others are already in theirs); the row is rebuilt once it lands
            val gap = size(item)
            val target = if (to == from) 0f else (if (to > from) gap * (to - from) else -gap * (from - to))
            settle()
            val order = (0 until box.childCount).map(box::getChildAt).toMutableList().also { it.remove(item); it.add(to, item) }
            shift(item, target) {
                Haptics.settle(ctx)
                if (item.parent === box) {
                    for (i in 0 until box.childCount) { val c = box.getChildAt(i); Motion.cancel(c, prop); set(c, 0f) }
                    if (to != from) { box.removeView(item); box.addView(item, to) }
                }
                dragging = false
                if (to != from) onDrop(order)
            }
            if (!Motion.enabled) { for (i in 0 until box.childCount) set(box.getChildAt(i), 0f); if (to != from) { box.removeView(item); box.addView(item, to) }; dragging = false; if (to != from) onDrop(order) }
        }
        handle.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { x0 = e.rawX; y0 = e.rawY; lifted = false; moved = false; handle.postDelayed(up, holdMs) }
                MotionEvent.ACTION_MOVE -> {
                    val d = if (vertical) e.rawY - y0 else e.rawX - x0
                    val dist = hypot(e.rawX - x0, e.rawY - y0)
                    if (!lifted) { if (dist > slop) handle.removeCallbacks(up) }
                    else {
                        if (!moved && dist > slop) {
                            moved = true; dragging = true
                            from = box.indexOfChild(item); to = from
                            centres = FloatArray(box.childCount) { centre(box.getChildAt(it)) }
                        }
                        if (moved) {
                            Motion.cancel(item, prop); set(item, d)
                            // The new place: how many of the others sit before the dragged item's centre
                            val c = centres[from] + d
                            var t = 0
                            for (i in centres.indices) if (i != from && centres[i] < c) t++
                            if (t != to) {
                                to = t
                                Haptics.tick(ctx)
                                val gap = size(item)
                                for (i in 0 until box.childCount) {
                                    if (i == from) continue
                                    shift(box.getChildAt(i), when {
                                        from < to && i in (from + 1)..to -> -gap
                                        from > to && i in to until from -> gap
                                        else -> 0f
                                    })
                                }
                            }
                        }
                    }
                }
                MotionEvent.ACTION_UP -> {
                    handle.removeCallbacks(up)
                    when {
                        moved -> drop()
                        lifted -> { settle(); onMenu(item) }
                        hypot(e.rawX - x0, e.rawY - y0) <= slop -> onTap(item)
                    }
                }
                MotionEvent.ACTION_CANCEL -> { handle.removeCallbacks(up); if (moved) drop() else if (lifted) settle() }
            }
            true
        }
    }
}
