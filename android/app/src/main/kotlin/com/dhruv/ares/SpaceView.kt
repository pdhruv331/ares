package com.dhruv.ares

import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import kotlin.math.sin
import kotlin.random.Random

/**
 * The backdrop behind the reactor: deep space, slowly drifting stars in two layers that twinkle, two faint
 * nebula glows wandering about, and a thin grid fading out towards the edges. Cheap to draw, and still when
 * the screen isn't shown.
 */
class SpaceView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    private class Star(val x: Float, val y: Float, val size: Float, val phase: Float, val speed: Float, val layer: Int)
    private val stars: List<Star>
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1f }
    private val nebula = Paint(Paint.ANTI_ALIAS_FLAG).apply { maskFilter = BlurMaskFilter(160f, BlurMaskFilter.Blur.NORMAL) }
    private var sky: LinearGradient? = null
    private var drift = 0f
    private var last = 0L
    private val cyan = Color.parseColor("#3EE6FF")
    private val purple = Color.parseColor("#9D8CFF")

    init {
        val rnd = Random(11)
        stars = List(150) { i -> Star(rnd.nextFloat(), rnd.nextFloat(), 0.6f + rnd.nextFloat() * (if (i % 7 == 0) 2.2f else 1.1f), rnd.nextFloat() * 6.28f, 0.6f + rnd.nextFloat() * 1.6f, if (i % 3 == 0) 1 else 0) }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        sky = LinearGradient(0f, 0f, 0f, h.toFloat(), intArrayOf(Color.parseColor("#06101A"), Color.parseColor("#040A10"), Color.parseColor("#02060A")), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
    }

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (last == 0L) 0f else ((now - last) / 1e9f).coerceAtMost(0.05f)
        last = now
        val t = now / 1e9f
        drift += dt * 1.6f
        val w = width.toFloat(); val h = height.toFloat()

        fill.shader = sky; fill.alpha = 255
        canvas.drawRect(0f, 0f, w, h, fill)
        fill.shader = null

        // Nebulae: two soft glows wandering slowly
        nebula.color = cyan; nebula.alpha = 22
        canvas.drawCircle(w * (0.3f + sin(t * 0.05f) * 0.12f), h * (0.32f + sin(t * 0.041f + 1f) * 0.08f), w * 0.34f, nebula)
        nebula.color = purple; nebula.alpha = 18
        canvas.drawCircle(w * (0.72f + sin(t * 0.037f + 2f) * 0.1f), h * (0.6f + sin(t * 0.03f) * 0.1f), w * 0.3f, nebula)

        // A thin grid, strongest in the middle, gone at the edges
        val step = w / 9f
        var x = (drift * 2f) % step
        while (x < w) { line.color = cyan; line.alpha = 10; canvas.drawLine(x, 0f, x, h, line); x += step }
        var y = 0f
        while (y < h) { line.color = cyan; line.alpha = (10 * (1f - kotlin.math.abs(y / h - 0.45f) * 1.6f).coerceIn(0f, 1f)).toInt(); canvas.drawLine(0f, y, w, y, line); y += step }

        // Stars: the near layer drifts a little faster and twinkles more
        for (s in stars) {
            val speed = if (s.layer == 1) 2.4f else 1f
            val sx = ((s.x * w + drift * speed * 4f) % (w + 20f)) - 10f
            val sy = s.y * h
            val tw = 0.55f + 0.45f * sin(t * s.speed + s.phase)
            fill.color = if (s.layer == 1) cyan else Color.WHITE
            fill.alpha = (tw * (if (s.layer == 1) 150 else 110)).toInt()
            canvas.drawCircle(sx, sy, s.size * (0.8f + tw * 0.4f), fill)
        }
        fill.alpha = 255
        if (isShown) postInvalidateOnAnimation()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        last = 0L
        if (visibility == VISIBLE) invalidate()
    }
}
