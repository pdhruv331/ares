package com.dhruv.ares

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import kotlin.math.hypot

/**
 * The floating ARES bubble. Tap: talk (the reactor grows out of it over whatever you're doing: AskActivity). Hold: talk
 * while you hold. Drag: move it; let go and it keeps the throw's speed and springs to the nearest edge, rubber-banding at
 * the top and bottom (docs/phone-ui-prompt.md §3). Drag it onto the × at the bottom to put it away.
 * After a card opened an app, a small "back to ARES" arc with that card's icon sits on it for ~30 s (§5).
 */
@SuppressLint("ClickableViewAccessibility")
class Bubble(private val ctx: Context, private val dismissed: () -> Unit) {
    companion object {
        private var live: Bubble? = null
        private var onHome = false
        private var presence = false
        /** The ARES home screen came to the front (true) or left it (false). Main thread. */
        fun home(showing: Boolean) { onHome = showing; live?.update() }
        /** The reactor is up over an app (grown out of the bubble): the bubble steps aside until it condenses back. */
        fun presence(up: Boolean) { presence = up; live?.update() }
        /** Where the bubble is on screen right now (left, top, size), or null when it's not showing. */
        fun rect(): IntArray? = live?.takeIf { it.shown && it.view.visibility == View.VISIBLE }?.let { intArrayOf(it.params.x, it.params.y, it.size) }
        /** A card opened an app: carry a "back to ARES" arc with its icon for a while. */
        fun returnChip(icon: Bitmap?, ms: Long = 30_000) { live?.setReturn(icon, ms) }
        val returning: Boolean get() = live?.returnUntil?.let { it > System.currentTimeMillis() } == true
    }
    private val wm = ctx.getSystemService(WindowManager::class.java)
    private val dp = ctx.resources.displayMetrics.density
    private val size = (58 * dp).toInt()
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val prefs = Ares.prefs(ctx)
    private val main = Handler(Looper.getMainLooper())

    private val badge = TextView(ctx).apply {
        textSize = 10f
        setTextColor(0xFF040A10.toInt())
        gravity = Gravity.CENTER
        typeface = android.graphics.Typeface.DEFAULT_BOLD
        visibility = View.GONE
    }
    /** The "back to ARES" arc with the card's icon, drawn over the bubble while it lasts. */
    private inner class ReturnArc(c: Context) : View(c) {
        var icon: Bitmap? = null
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2.5f * dp; strokeCap = Paint.Cap.ROUND }
        private val arc = RectF()
        override fun onDraw(canvas: Canvas) {
            val until = returnUntil ?: return
            val left = ((until - System.currentTimeMillis()) / 30_000f).coerceIn(0f, 1f)
            if (left <= 0f) return
            stroke.color = Scheme.color; stroke.alpha = 230
            arc.set(2 * dp, 2 * dp, width - 2 * dp, height - 2 * dp)
            canvas.drawArc(arc, -90f, 360f * left, false, stroke)
            icon?.let { b -> val s = 20 * dp; arc.set(width - s, height - s, width.toFloat(), height.toFloat()); canvas.drawBitmap(b, null, arc, null) }
            postInvalidateDelayed(500)
        }
    }
    private val returnArc = ReturnArc(ctx)
    internal var returnUntil: Long? = null
    private val view = FrameLayout(ctx).apply {
        addView(ImageView(ctx).apply { setImageResource(R.drawable.bubble) }, FrameLayout.LayoutParams(-1, -1))
        addView(returnArc, FrameLayout.LayoutParams(-1, -1))
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
    private var layoutPending = false
    // The window's position, sprung: a throw keeps its speed and lands on the nearest edge
    private val sx = Motion.Value(params.x.toFloat(), Motion.DefaultSpatial) { params.x = it.toInt(); relayout() }
    private val sy = Motion.Value(params.y.toFloat(), Motion.DefaultSpatial) { params.y = it.toInt(); relayout() }

    private fun overlay(w: Int, h: Int) = WindowManager.LayoutParams(
        w, h, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )

    /** One window update per frame, however many springs moved. */
    private fun relayout() {
        if (layoutPending || !shown) return
        layoutPending = true
        view.postOnAnimation { layoutPending = false; if (shown) runCatching { wm.updateViewLayout(view, params) } }
    }

    private val minY get() = (40 * dp).toInt()
    private val maxY get() = wm.currentWindowMetrics.bounds.height() - size - (80 * dp).toInt()

    init {
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragging = false; var holding = false
        var vt: VelocityTracker? = null
        val hold = Runnable { holding = true; Haptics.listen(ctx); open(listen = true, hold = true) }
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = params.x; startY = params.y; dragging = false; holding = false
                    sx.cancel(); sy.cancel()
                    vt?.recycle(); vt = VelocityTracker.obtain(); vt?.addMovement(e)
                    Motion.scale(view, 0.9f, Motion.FastSpatial)
                    view.postDelayed(hold, ViewConfiguration.getLongPressTimeout().toLong())
                }
                MotionEvent.ACTION_MOVE -> {
                    vt?.addMovement(e)
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!dragging && !holding && hypot(dx, dy) > slop) { dragging = true; view.removeCallbacks(hold); showTrash(true) }
                    if (dragging) {
                        // 1:1 under the finger; past the top or bottom it rubber-bands
                        params.x = (startX + dx).toInt()
                        params.y = Motion.band(startY + dy, minY.toFloat(), maxY.toFloat(), 240 * dp, 0.5f).toInt()
                        sx.set(params.x.toFloat()); sy.set(params.y.toFloat())
                        trash.scaleX = if (overTrash()) 1.25f else 1f; trash.scaleY = trash.scaleX
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    view.removeCallbacks(hold)
                    Motion.scale(view, 1f, Motion.DefaultSpatial)
                    if (holding) { /* the presence took over */ }
                    else if (!dragging) {
                        if (e.actionMasked == MotionEvent.ACTION_UP) open(listen = true, hold = false)
                    } else if (overTrash()) {
                        showTrash(false); hide(); dismissed()
                        Toast.makeText(ctx, "Bubble hidden. Bring it back from the ARES notification.", Toast.LENGTH_SHORT).show()
                    } else {
                        showTrash(false)
                        vt?.computeCurrentVelocity(1000)
                        snap(vt?.xVelocity ?: 0f, vt?.yVelocity ?: 0f)
                    }
                }
            }
            true
        }
    }

    /** Tap or hold: the reactor grows out of the bubble over the current app (AskActivity), restoring the last card if its chip is up. */
    private fun open(listen: Boolean, hold: Boolean) {
        val restore = returning
        if (restore) setReturn(null, 0)
        ctx.startActivity(AskActivity.intent(ctx, listen = listen && !restore, hold = hold, from = intArrayOf(params.x, params.y, size), restore = restore))
    }

    fun show() {
        if (shown) return
        wm.addView(view, params)
        shown = true
        live = this
        update()
    }

    fun hide() {
        if (live === this) live = null
        if (!shown) return
        runCatching { wm.removeView(view) }
        runCatching { if (trash.isAttachedToWindow) wm.removeView(trash) }
        shown = false
    }

    /** Dim the bubble when the Mac can't be reached; out of the way while the ARES home screen or the reactor is in front. */
    fun update() {
        view.visibility = if (onHome || presence) View.GONE else View.VISIBLE
        view.alpha = if (Ares.status(ctx) == "online") 1f else 0.55f
        val n = JobStore.working + JobStore.waiting
        badge.visibility = if (n > 0) View.VISIBLE else View.GONE
        badge.text = n.toString()
        badge.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (JobStore.waiting > 0) 0xFFFFB547.toInt() else 0xFFA78BFA.toInt()) }
        view.contentDescription = JobStore.summary()?.let { "ARES. $it" } ?: if (returning) "ARES. Back to the card" else "ARES"
    }

    internal fun setReturn(icon: Bitmap?, ms: Long) {
        returnUntil = if (ms > 0) System.currentTimeMillis() + ms else null
        returnArc.icon = icon
        returnArc.invalidate()
        main.removeCallbacksAndMessages("return")
        if (ms > 0) main.postAtTime({ returnUntil = null; returnArc.invalidate(); update() }, "return", android.os.SystemClock.uptimeMillis() + ms)
        update()
    }

    private fun showTrash(on: Boolean) {
        if (on && !trash.isAttachedToWindow) wm.addView(trash, trashParams)
        Motion.to(trash, Motion.ALPHA, if (on) 1f else 0f, Motion.DefaultEffects) {
            if (!on && trash.isAttachedToWindow) runCatching { wm.removeView(trash) }
        }
        if (!Motion.enabled && !on && trash.isAttachedToWindow) runCatching { wm.removeView(trash) }
    }

    private fun overTrash(): Boolean {
        val screen = wm.currentWindowMetrics.bounds
        val tx = screen.width() / 2f
        val ty = screen.height() - trashParams.y - 32 * dp
        return hypot(params.x + size / 2f - tx, params.y + size / 2f - ty) < 90 * dp
    }

    /** Let go: where the throw would land picks the edge; the springs start with the finger's speed, and y springs back inside its band. */
    private fun snap(vx: Float, vy: Float) {
        val screen = wm.currentWindowMetrics.bounds
        val landX = params.x + Motion.project(vx)
        val toX = if (landX + size / 2 < screen.width() / 2) 0 else screen.width() - size
        val toY = (params.y + Motion.project(vy, 0.2f)).coerceIn(minY.toFloat(), maxY.toFloat())
        sx.to(toX.toFloat(), Motion.DefaultSpatial, vx)
        sy.to(toY, Motion.DefaultSpatial, vy) { Haptics.settle(ctx) }
        prefs.edit().putInt("bubbleX", toX).putInt("bubbleY", toY.toInt()).apply()
    }
}
