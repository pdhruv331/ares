package com.dhruv.ares

import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/** ARES's arc reactor: rings, turning arcs and a core that breathes with her voice (or yours). */
class ReactorView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    var state = State.IDLE
        set(v) { field = v; invalidate() }
    var levelSource: () -> Float = { 0f }

    private val cyan = Color.parseColor("#3EE6FF")
    private val purple = Color.parseColor("#9D8CFF")
    private val amber = Color.parseColor("#FFB547")
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { maskFilter = BlurMaskFilter(40f, BlurMaskFilter.Blur.NORMAL) }
    private val arc = RectF()
    private val arcs = listOf(Arc(0, 0.8f, 80f, 1f), Arc(1, 0.8f, 30f, 1f), Arc(2, 0.68f, 120f, -1.4f), Arc(3, 0.56f, 50f, 2f))
    private val coreMatrix = Matrix()
    private var coreShader: RadialGradient? = null
    private var coreColor = 0
    private var level = 0f
    private var spin = 0f
    private var last = 0L

    private val color get() = when (state) { State.THINKING -> purple; State.OFFLINE -> amber; else -> cyan }

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (last == 0L) 0f else ((now - last) / 1e9f).coerceAtMost(0.05f)
        last = now
        val target = if (state == State.SPEAKING || state == State.LISTENING) levelSource() else 0f
        level += (target - level) * (dt * 14f).coerceAtMost(1f)
        spin += dt * when (state) { State.THINKING -> 220f; State.LISTENING -> 70f; State.SPEAKING -> 45f; else -> 16f }
        val t = now / 1e9f

        val cx = width / 2f
        val cy = height / 2f
        val r = min(width, height) / 2f * 0.92f
        val c = color
        val bright = state != State.IDLE && state != State.OFFLINE

        // Tick ring
        stroke.color = c; stroke.alpha = 70; stroke.strokeWidth = r * 0.012f
        for (i in 0 until 72) {
            val a = Math.toRadians(i * 5.0 + spin * 0.15)
            val inner = if (i % 6 == 0) r * 0.9f else r * 0.94f
            canvas.drawLine(cx + cos(a).toFloat() * inner, cy + sin(a).toFloat() * inner, cx + cos(a).toFloat() * r, cy + sin(a).toFloat() * r, stroke)
        }
        // Turning arcs
        stroke.strokeWidth = r * 0.03f
        for ((k, rad, sweep, dir) in arcs) {
            stroke.alpha = if (bright) 210 else 120
            arc.set(cx - r * rad, cy - r * rad, cx + r * rad, cy + r * rad)
            canvas.drawArc(arc, spin * dir + k * 97f, sweep, false, stroke)
        }
        stroke.strokeWidth = r * 0.008f; stroke.alpha = 90
        canvas.drawCircle(cx, cy, r * 0.74f, stroke)
        canvas.drawCircle(cx, cy, r * 0.62f, stroke)

        // Core
        val breathe = if (bright) 0f else (sin(t * 1.6f) + 1f) * 0.03f
        val core = r * (0.3f + breathe + level * 0.14f)
        glow.color = c; glow.alpha = (90 + level * 150).toInt().coerceAtMost(255)
        canvas.drawCircle(cx, cy, core * 1.25f, glow)
        if (coreShader == null || coreColor != c) { // a unit gradient per colour, scaled into place each frame
            coreColor = c
            coreShader = RadialGradient(0f, 0f, 1f, intArrayOf(Color.WHITE, c, Color.argb(0, Color.red(c), Color.green(c), Color.blue(c))), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
        }
        coreMatrix.setScale(core, core)
        coreMatrix.postTranslate(cx, cy)
        coreShader!!.setLocalMatrix(coreMatrix)
        fill.shader = coreShader
        canvas.drawCircle(cx, cy, core, fill)

        if (isShown) postInvalidateOnAnimation()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        last = 0L
        if (visibility == VISIBLE) invalidate()
    }

    private data class Arc(val k: Int, val r: Float, val sweep: Float, val dir: Float)
}
