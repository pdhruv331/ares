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

    private fun size(v: View): Float {
        val lp = v.layoutParams as? ViewGroup.MarginLayoutParams
        return if (vertical) v.height + (lp?.topMargin ?: 0) + (lp?.bottomMargin ?: 0).toFloat() else v.width + (lp?.leftMargin ?: 0) + (lp?.rightMargin ?: 0).toFloat()
    }
    private fun centre(v: View) = if (vertical) v.top + v.height / 2f else v.left + v.width / 2f
    private fun shift(v: View, by: Float, animate: Boolean = true) {
        if (!animate) { if (vertical) v.translationY = by else v.translationX = by; return }
        v.animate().apply { if (vertical) translationY(by) else translationX(by) }.setDuration(160).start()
    }

    @SuppressLint("ClickableViewAccessibility")
    fun attach(handle: View, item: View = handle) {
        var x0 = 0f; var y0 = 0f; var lifted = false; var moved = false; var from = 0; var to = 0
        var centres = FloatArray(0)
        val dp = ctx.resources.displayMetrics.density
        val up = Runnable {
            lifted = true
            Haptics.click(ctx)
            box.parent?.requestDisallowInterceptTouchEvent(true) // the pager, the scroller: the finger is ours now
            item.animate().scaleX(lift).scaleY(lift).setDuration(120).start()
            item.translationZ = 8 * dp
        }
        fun settle() {
            item.animate().scaleX(1f).scaleY(1f).setDuration(140).start()
            item.translationZ = 0f
            box.parent?.requestDisallowInterceptTouchEvent(false)
        }
        fun drop() {
            // Once: rebuilding the row in onDrop removes the view under the finger, which sends it a CANCEL
            if (!moved) return
            moved = false; lifted = false
            dragging = false
            if (item.parent !== box) { settle(); return } // (the row was rebuilt under the finger: nothing to drop into)
            val wasAt = (if (vertical) item.top + item.translationY else item.left + item.translationX)
            for (i in 0 until box.childCount) { val c = box.getChildAt(i); c.animate().cancel(); if (c !== item) shift(c, 0f, animate = false) }
            if (to != from) { box.removeView(item); box.addView(item, to) }
            // From where the finger left it into its new place
            box.post {
                val now = if (vertical) item.top.toFloat() else item.left.toFloat()
                shift(item, wasAt - now, animate = false)
                shift(item, 0f)
            }
            settle()
            if (to != from) onDrop((0 until box.childCount).map(box::getChildAt))
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
                            shift(item, d, animate = false)
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
