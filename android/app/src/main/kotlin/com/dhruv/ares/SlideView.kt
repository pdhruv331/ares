package com.dhruv.ares

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.animation.OvershootInterpolator
import kotlin.math.abs

/**
 * SLIDE TO POWER DOWN (docs/ignition-prompt.md §4d): a track with a gold knob carrying the ⏻ glyph. Drag it to the end to
 * commit; let go early and it springs back. A detent tick at each step of the track, a heavy thunk at the end, a light tick
 * on the spring-back (haptics from the screen through the callbacks).
 */
class SlideView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    var onDetent: () -> Unit = {}
    var onComplete: () -> Unit = {}
    var onSpringBack: () -> Unit = {}
    var label = "SLIDE TO POWER DOWN"

    private val gold = Color.parseColor("#FAC458")
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#1AFAC458") }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f; color = Color.parseColor("#66FAC458") }
    private val knob = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = gold }
    private val icon = ctx.getDrawable(R.drawable.ic_power)!!.mutate().apply { setTint(Color.parseColor("#1A1206")) }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = gold; textAlign = Paint.Align.CENTER; typeface = Typeface.MONOSPACE; letterSpacing = 0.18f }
    private val rect = RectF()
    private var k = 0f        // 0 = at rest, 1 = the end
    private var downX = 0f
    private var startK = 0f
    private var dragging = false
    private var detent = 0
    private var done = false
    private var anim: ValueAnimator? = null
    private val steps = 8

    private val knobR get() = height / 2f - 4f * resources.displayMetrics.density
    private val travel get() = width - 2f * (knobR + 4f * resources.displayMetrics.density)

    fun reset() { anim?.cancel(); k = 0f; detent = 0; done = false; dragging = false; invalidate() }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (done) return true
        val dp = resources.displayMetrics.density
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val kx = knobR + 4f * dp + k * travel
                if (abs(e.x - kx) > knobR * 1.6f) return false
                anim?.cancel(); dragging = true; downX = e.x; startK = k
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> if (dragging) {
                k = (startK + (e.x - downX) / travel).coerceIn(0f, 1f)
                val d = (k * steps).toInt()
                if (d != detent) { detent = d; if (d > 0 && k < 0.98f) onDetent() }
                if (k >= 0.97f) { done = true; dragging = false; k = 1f; invalidate(); onComplete(); return true }
                invalidate()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (dragging) {
                dragging = false
                anim = ValueAnimator.ofFloat(k, 0f).apply { duration = 360; interpolator = OvershootInterpolator(1.4f); addUpdateListener { k = (it.animatedValue as Float).coerceAtLeast(0f); invalidate() }; start() }
                detent = 0
                onSpringBack()
            }
        }
        return true
    }

    override fun onDraw(canvas: Canvas) {
        val dp = resources.displayMetrics.density
        val r = height / 2f
        rect.set(0f, 0f, width.toFloat(), height.toFloat())
        canvas.drawRoundRect(rect, r, r, track)
        canvas.drawRoundRect(rect, r, r, edge)
        // The filled part behind the knob glows a little
        val kx = knobR + 4f * dp + k * travel
        track.color = Color.argb((40 + 60 * k).toInt(), 250, 196, 88)
        rect.set(0f, 0f, kx + knobR, height.toFloat())
        canvas.drawRoundRect(rect, r, r, track)
        track.color = Color.parseColor("#1AFAC458")
        text.textSize = 10f * dp
        text.alpha = (200 * (1f - k * 1.6f).coerceIn(0f, 1f)).toInt()
        canvas.drawText(label, width / 2f + knobR * 0.6f, height / 2f + 3.5f * dp, text)
        knob.alpha = 255
        canvas.drawCircle(kx, r, knobR, knob)
        val ir = (knobR * 0.62f).toInt()
        icon.setBounds((kx - ir).toInt(), (r - ir).toInt(), (kx + ir).toInt(), (r + ir).toInt())
        icon.draw(canvas)
    }
}
