package com.dhruv.ares

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.widget.FrameLayout
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The home screen's pages side by side (docs/launcher-prompt.md §1), fluid (docs/phone-ui-prompt.md §2): a sideways drag
 * moves the pages 1:1 under the finger, a release keeps the flick's momentum and springs to the page the throw would land
 * on, and both ends rubber-band instead of stopping dead. An upward swipe hands the finger to the app drawer, which follows
 * it (`onSheetDrag` / `onSheetRelease`). Children keep their own taps and holds; the pager only takes a gesture once it's
 * clearly a swipe. A child that must keep the finger (the reactor while you hold to talk) calls requestDisallowInterceptTouchEvent.
 * With `pages = false` it's just the upward swipe (the dock).
 */
class HomePager @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : FrameLayout(ctx, attrs) {
    var pages = true
    var page = 0
        private set
    /** Where the pages are, 0 = the first one showing, 1 = the second (fractional while dragging or in flight). */
    var onScroll: (Float) -> Unit = {}
    var onPage: (Int) -> Unit = {}
    /** The finger is dragging something up from this pager: how far (px, ≥ 0) so far. */
    var onSheetDrag: (Float) -> Unit = {}
    /** ...and let go, with its vertical velocity (px/s, negative = upward). */
    var onSheetRelease: (Float) -> Unit = {}
    /** Whether an upward swipe that starts at (x, y) should open the drawer (not while a list there can still scroll). */
    var canSwipeUp: (Float, Float) -> Boolean = { _, _ -> true }
    /** True while a finger drags the pages or they're in flight (the reactor votes for a high frame rate then). */
    var moving = false
        private set(v) { if (field != v) { field = v; onMoving(v) } }
    var onMoving: (Boolean) -> Unit = {}

    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val minFling = ViewConfiguration.get(ctx).scaledMinimumFlingVelocity * 6f
    private var x0 = 0f
    private var y0 = 0f
    private var mode = NONE
    private var vt: VelocityTracker? = null
    private val offset = Motion.Value(0f, Motion.DefaultSpatial) { place() }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        super.onLayout(changed, l, t, r, b)
        if (width > 0) offset.minimumVisibleChange = 0.5f / width
        place()
    }

    private fun place() {
        if (!pages) return
        val k = offset.value
        for (i in 0 until childCount) getChildAt(i).translationX = (i - k) * width
        onScroll(k)
        if (!offset.moving && mode != SIDEWAYS) moving = false
    }

    private fun track(e: MotionEvent) {
        if (e.actionMasked == MotionEvent.ACTION_DOWN) { vt?.recycle(); vt = VelocityTracker.obtain() }
        vt?.addMovement(e)
    }

    /** Decide what a moving finger is doing, once it's moved far enough to tell. */
    private fun decide(e: MotionEvent) {
        if (mode != NONE) return
        val dx = e.x - x0; val dy = e.y - y0
        if (pages && abs(dx) > slop && abs(dx) > abs(dy) * 1.2f) { mode = SIDEWAYS; moving = true }
        else if (-dy > slop && abs(dy) > abs(dx) * 1.2f && canSwipeUp(x0, y0)) mode = UP
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
                if (mode == SIDEWAYS && width > 0) {
                    // 1:1 under the finger; past either end the pages rubber-band
                    val raw = page - (e.x - x0) / width
                    offset.set(Motion.band(raw, 0f, (childCount - 1).toFloat(), 1f, 0.5f))
                } else if (mode == UP) onSheetDrag((y0 - e.y).coerceAtLeast(0f))
            }
            MotionEvent.ACTION_UP -> {
                vt?.computeCurrentVelocity(1000)
                val vx = vt?.xVelocity ?: 0f
                val vy = vt?.yVelocity ?: 0f
                when (mode) {
                    SIDEWAYS -> release(vx)
                    UP -> onSheetRelease(vy)
                }
                mode = NONE
            }
            MotionEvent.ACTION_CANCEL -> { if (mode == SIDEWAYS) go(page) else if (mode == UP) onSheetRelease(0f); mode = NONE }
        }
        return true
    }

    /** Let go: the throw picks the page, and the spring starts with the finger's own speed. */
    private fun release(vx: Float) {
        if (width <= 0) return go(page)
        val v = -vx / width // pages per second (a leftward flick moves to the next page)
        val landing = offset.value + Motion.project(v)
        val target = when {
            abs(vx) > minFling -> if (v > 0) page + 1 else page - 1
            else -> landing.roundToInt()
        }.coerceIn((page - 1).coerceAtLeast(0), (page + 1).coerceAtMost(childCount - 1))
        go(target, velocity = v)
    }

    /** Glide to a page (a tap or Back: critically damped; a release keeps the finger's velocity and a little bounce). */
    fun go(to: Int, animate: Boolean = true, velocity: Float? = null) {
        val target = to.coerceIn(0, (childCount - 1).coerceAtLeast(0))
        val changed = target != page
        page = target
        if (!animate) { offset.set(target.toFloat()); moving = false }
        else { moving = true; offset.to(target.toFloat(), if (velocity != null) Motion.DefaultSpatial else Motion.TapSpatial, velocity) { moving = false } }
        if (changed) onPage(target)
    }

    /** Predictive back is scrubbing towards page 0: show it (k = 0..1 of the gesture). */
    fun peek(k: Float) { if (page > 0) { moving = true; offset.set(page - 0.3f * k) } }

    private companion object { const val NONE = 0; const val SIDEWAYS = 1; const val UP = 2 }
}
