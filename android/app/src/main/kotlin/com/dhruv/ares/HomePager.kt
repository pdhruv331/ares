package com.dhruv.ares

import android.animation.ValueAnimator
import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The home screen's pages side by side (docs/launcher-prompt.md §1): a sideways drag moves between them and snaps,
 * an upward swipe opens the app drawer. Children keep their own taps and holds; the pager only takes a gesture once
 * it's clearly a swipe. A child that must keep the finger (the reactor while you hold to talk) calls
 * requestDisallowInterceptTouchEvent. With `pages = false` it's just the upward swipe (the dock).
 */
class HomePager @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : FrameLayout(ctx, attrs) {
    var pages = true
    var page = 0
        private set
    /** Where the pages are, 0 = the first one showing, 1 = the second (fractional while dragging). */
    var onScroll: (Float) -> Unit = {}
    var onPage: (Int) -> Unit = {}
    var onSwipeUp: () -> Unit = {}
    /** Whether an upward swipe that starts at (x, y) should open the drawer (not while a list there can still scroll). */
    var canSwipeUp: (Float, Float) -> Boolean = { _, _ -> true }

    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val fling = ViewConfiguration.get(ctx).scaledMinimumFlingVelocity * 6f
    private var offset = 0f
    private var x0 = 0f
    private var y0 = 0f
    private var mode = NONE
    private var vt: VelocityTracker? = null
    private var anim: ValueAnimator? = null

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        super.onLayout(changed, l, t, r, b)
        place()
    }

    private fun place() {
        if (!pages) return
        for (i in 0 until childCount) getChildAt(i).translationX = (i - offset) * width
        onScroll(offset)
    }

    private fun track(e: MotionEvent) {
        if (e.actionMasked == MotionEvent.ACTION_DOWN) { vt?.recycle(); vt = VelocityTracker.obtain() }
        vt?.addMovement(e)
    }

    /** Decide what a moving finger is doing, once it's moved far enough to tell. */
    private fun decide(e: MotionEvent) {
        if (mode != NONE) return
        val dx = e.x - x0; val dy = e.y - y0
        if (pages && abs(dx) > slop && abs(dx) > abs(dy) * 1.2f) mode = SIDEWAYS
        else if (-dy > slop && abs(dy) > abs(dx) * 1.2f && canSwipeUp(x0, y0)) mode = UP
    }

    override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
        track(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { x0 = e.x; y0 = e.y; mode = NONE; anim?.cancel() }
            MotionEvent.ACTION_MOVE -> { decide(e); return mode != NONE }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> mode = NONE
        }
        return false
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        track(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { x0 = e.x; y0 = e.y; mode = NONE; anim?.cancel() }
            MotionEvent.ACTION_MOVE -> {
                decide(e)
                if (mode == SIDEWAYS && width > 0) {
                    // A little give past either end, then it stops
                    offset = (page - (e.x - x0) / width).coerceIn(-0.12f, childCount - 1 + 0.12f)
                    place()
                }
            }
            MotionEvent.ACTION_UP -> {
                vt?.computeCurrentVelocity(1000)
                val vx = vt?.xVelocity ?: 0f
                val vy = vt?.yVelocity ?: 0f
                when (mode) {
                    SIDEWAYS -> go(when { vx < -fling -> page + 1; vx > fling -> page - 1; else -> offset.roundToInt() })
                    UP -> if (y0 - e.y > height * 0.08f || vy < -fling) onSwipeUp()
                }
                mode = NONE
            }
            MotionEvent.ACTION_CANCEL -> { if (mode == SIDEWAYS) go(page); mode = NONE }
        }
        return true
    }

    /** Glide to a page. */
    fun go(to: Int, animate: Boolean = true) {
        val target = to.coerceIn(0, (childCount - 1).coerceAtLeast(0))
        val changed = target != page
        page = target
        anim?.cancel()
        if (!animate || !ValueAnimator.areAnimatorsEnabled()) { offset = target.toFloat(); place() }
        else anim = ValueAnimator.ofFloat(offset, target.toFloat()).apply {
            duration = 280; interpolator = DecelerateInterpolator(1.6f)
            addUpdateListener { offset = it.animatedValue as Float; place() }
            start()
        }
        if (changed) onPage(target)
    }

    private companion object { const val NONE = 0; const val SIDEWAYS = 1; const val UP = 2 }
}
