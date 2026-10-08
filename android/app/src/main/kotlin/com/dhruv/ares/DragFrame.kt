package com.dhruv.ares

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.widget.FrameLayout

/**
 * The drawer's list frame (docs/launcher-v2-prompt.md §8): while `grab` is set (an app was held), the finger is the
 * frame's, not the list's (no scrolling, no taps underneath), and every event goes to `grab`. `downX/downY` remember where
 * the last touch started, in this frame's coordinates (a long-press listener doesn't get them).
 */
class DragFrame @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : FrameLayout(ctx, attrs) {
    var grab: ((MotionEvent) -> Unit)? = null
    var downX = 0f
        private set
    var downY = 0f
        private set

    override fun dispatchTouchEvent(e: MotionEvent): Boolean {
        if (e.actionMasked == MotionEvent.ACTION_DOWN) { downX = e.x; downY = e.y }
        return super.dispatchTouchEvent(e)
    }

    // The event that's intercepted isn't passed to onTouchEvent, so `grab` sees it here (it may be the UP)
    override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
        val g = grab ?: return false
        g(e)
        return true
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        val g = grab ?: return super.onTouchEvent(e)
        g(e)
        return true
    }
}
