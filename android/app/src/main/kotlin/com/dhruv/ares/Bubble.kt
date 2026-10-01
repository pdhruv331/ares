package com.dhruv.ares

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.graphics.drawable.GradientDrawable
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The floating ARES bubble. Tap: talk. Drag: move it (it snaps to the nearest edge). Drag it onto the
 * × at the bottom to put it away (bring it back from the notification or the app menu).
 */
@SuppressLint("ClickableViewAccessibility")
class Bubble(private val ctx: Context, private val dismissed: () -> Unit) {
    private val wm = ctx.getSystemService(WindowManager::class.java)
    private val dp = ctx.resources.displayMetrics.density
    private val size = (58 * dp).toInt()
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val prefs = Ares.prefs(ctx)

    private val badge = TextView(ctx).apply {
        textSize = 10f
        setTextColor(0xFF040A10.toInt())
        gravity = Gravity.CENTER
        typeface = android.graphics.Typeface.DEFAULT_BOLD
        visibility = View.GONE
    }
    private val view = FrameLayout(ctx).apply {
        addView(ImageView(ctx).apply { setImageResource(R.drawable.bubble) }, FrameLayout.LayoutParams(-1, -1))
        addView(badge, FrameLayout.LayoutParams((18 * dp).toInt(), (18 * dp).toInt(), Gravity.TOP or Gravity.END))
        contentDescription = "ARES"
        elevation = 8 * dp
    }
    private val trash = ImageView(ctx).apply {
        setImageResource(R.drawable.bubble_close)
        alpha = 0f
    }
    private val params = overlay(size, size).apply {
        gravity = Gravity.TOP or Gravity.START
        val screen = wm.currentWindowMetrics.bounds
        x = prefs.getInt("bubbleX", screen.width() - size)
        y = prefs.getInt("bubbleY", (screen.height() * 0.4).toInt())
    }
    private val trashParams = overlay((64 * dp).toInt(), (64 * dp).toInt()).apply {
        gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        y = (72 * dp).toInt()
    }
    private var shown = false

    private fun overlay(w: Int, h: Int) = WindowManager.LayoutParams(
        w, h, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )

    init {
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragging = false
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = params.x; startY = params.y; dragging = false
                    view.animate().scaleX(0.9f).scaleY(0.9f).setDuration(80).start()
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!dragging && hypot(dx, dy) > slop) { dragging = true; showTrash(true) }
                    if (dragging) {
                        params.x = (startX + dx).toInt(); params.y = (startY + dy).toInt()
                        wm.updateViewLayout(view, params)
                        trash.scaleX = if (overTrash()) 1.25f else 1f; trash.scaleY = trash.scaleX
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    view.animate().scaleX(1f).scaleY(1f).setDuration(80).start()
                    if (!dragging) {
                        if (e.actionMasked == MotionEvent.ACTION_UP) ctx.startActivity(AskActivity.intent(ctx, listen = true))
                    } else if (overTrash()) {
                        showTrash(false); hide(); dismissed()
                        Toast.makeText(ctx, "Bubble hidden. Bring it back from the ARES notification.", Toast.LENGTH_SHORT).show()
                    } else {
                        showTrash(false); snap()
                    }
                }
            }
            true
        }
    }

    fun show() {
        if (shown) return
        wm.addView(view, params)
        shown = true
        update()
    }

    fun hide() {
        if (!shown) return
        runCatching { wm.removeView(view) }
        runCatching { if (trash.isAttachedToWindow) wm.removeView(trash) }
        shown = false
    }

    /** Dim the bubble when the Mac can't be reached. */
    fun update() {
        view.alpha = if (Ares.status(ctx) == "online") 1f else 0.55f
        val n = JobStore.working + JobStore.waiting
        badge.visibility = if (n > 0) View.VISIBLE else View.GONE
        badge.text = n.toString()
        badge.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (JobStore.waiting > 0) 0xFFFFB547.toInt() else 0xFFA78BFA.toInt()) }
        view.contentDescription = JobStore.summary()?.let { "ARES. $it" } ?: "ARES"
    }

    private fun showTrash(on: Boolean) {
        if (on && !trash.isAttachedToWindow) wm.addView(trash, trashParams)
        trash.animate().alpha(if (on) 1f else 0f).setDuration(150).withEndAction {
            if (!on && trash.isAttachedToWindow) runCatching { wm.removeView(trash) }
        }.start()
    }

    private fun overTrash(): Boolean {
        val screen = wm.currentWindowMetrics.bounds
        val tx = screen.width() / 2f
        val ty = screen.height() - trashParams.y - 32 * dp
        return hypot(params.x + size / 2f - tx, params.y + size / 2f - ty) < 90 * dp
    }

    private fun snap() {
        val screen = wm.currentWindowMetrics.bounds
        val toX = if (params.x + size / 2 < screen.width() / 2) 0 else screen.width() - size
        params.y = params.y.coerceIn((40 * dp).toInt(), screen.height() - size - (80 * dp).toInt())
        ValueAnimator.ofInt(params.x, toX).apply {
            duration = (180 + abs(toX - params.x) / 6).toLong().coerceAtMost(320)
            interpolator = DecelerateInterpolator()
            addUpdateListener { if (shown) { params.x = it.animatedValue as Int; wm.updateViewLayout(view, params) } }
            start()
        }
        prefs.edit().putInt("bubbleX", toX).putInt("bubbleY", params.y).apply()
    }
}
