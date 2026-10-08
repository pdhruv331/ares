package com.dhruv.ares

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.SweepGradient
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.sin

/**
 * The holographic schematic behind the reactor: construction rings running off the screen, crosshairs and
 * diagonals, angle marks with labels at the quarters, a slow radar sweep on the outer ring, and four live
 * readouts on callout lines in the corners (host, jobs, Claude usage, battery). Centred on the reactor,
 * which the screen tells it about (`center`), so the two always line up.
 */
class SchematicView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    /** The reactor's centre and radius in this view's pixels (set by the screen once it's laid out). */
    var center = floatArrayOf(0f, 0f, 150f)
        set(v) { field = v; invalidate() }
    /** Readouts: label → value, in the order top-left, top-right, bottom-left, bottom-right. */
    var readouts = listOf("HOST" to "…", "JOBS" to "…", "CLAUDE" to "…", "BATTERY" to "…")
        set(v) { field = v; invalidate() }

    private val cyan = Color.parseColor("#3EE6FF")
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = cyan; strokeWidth = 1.5f }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = cyan }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = cyan; typeface = Typeface.MONOSPACE }
    private val dashes = listOf(DashPathEffect(floatArrayOf(4f, 12f), 0f), DashPathEffect(floatArrayOf(2f, 10f), 0f), null, DashPathEffect(floatArrayOf(12f, 20f), 0f), null, DashPathEffect(floatArrayOf(8f, 8f), 0f))
    private val ringR = floatArrayOf(1.14f, 1.3f, 1.62f, 1.95f, 2.4f, 0.5f)
    private val ringA = intArrayOf(70, 50, 36, 26, 18, 50)
    /** While a caption shows, the bottom callouts step back so the words have the floor. */
    var dimBottom = false
    /** As ReactorView: a lower frame rate where it's ambient, or held still. */
    var maxFps = 0
    var still = false
        set(v) { field = v; last = 0L; invalidate() }
    private var bottomAlpha = 1f
    private var sweep = 0f
    private var last = 0L
    private var glow: RadialGradient? = null
    private var glowKey = 0f
    private val dp = resources.displayMetrics.density

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (last == 0L) 0f else ((now - last) / 1e9f).coerceAtMost(0.05f)
        last = now
        sweep += dt * 28f
        bottomAlpha += ((if (dimBottom) 0.15f else 1f) - bottomAlpha) * (dt * 6f).coerceAtMost(1f)
        val (cx, cy, r) = center.let { Triple(it[0], it[1], it[2]) }
        if (r <= 0f) return
        val sc = Scheme.color // (the colour scheme: the paints follow it, alphas are set before each draw)
        if (line.color or (0xFF shl 24) != sc or (0xFF shl 24)) { line.color = sc; fill.color = sc; text.color = sc; glow = null }

        // A soft glow in the middle of the sheet
        if (glow == null || glowKey != r) { glowKey = r; glow = RadialGradient(0f, 0f, r * 3.1f, Scheme.alpha(30), Color.TRANSPARENT, Shader.TileMode.CLAMP) }
        canvas.save(); canvas.translate(cx, cy); fill.shader = glow; canvas.drawCircle(0f, 0f, r * 3.1f, fill); fill.shader = null; canvas.restore()

        // Construction rings
        for (i in ringR.indices) {
            line.pathEffect = dashes[i]; line.alpha = ringA[i]; line.strokeWidth = 1.5f
            canvas.drawCircle(cx, cy, r * ringR[i], line)
        }
        line.pathEffect = null
        // Crosshairs and diagonals
        line.alpha = 70
        canvas.drawLine(cx, cy - r * 2.6f, cx, cy + r * 2.6f, line)
        canvas.drawLine(cx - r * 2.6f, cy, cx + r * 2.6f, cy, line)
        line.alpha = 34
        canvas.drawLine(cx - r * 2.6f, cy - r * 2.6f, cx + r * 2.6f, cy + r * 2.6f, line)
        canvas.drawLine(cx + r * 2.6f, cy - r * 2.6f, cx - r * 2.6f, cy + r * 2.6f, line)
        // Angle marks on the 1.3 ring
        text.textSize = 8f * dp; text.textAlign = Paint.Align.CENTER
        for (i in 0 until 72) {
            val a = Math.toRadians(i * 5.0)
            val len = (if (i % 18 == 0) 14f else if (i % 6 == 0) 8f else 4f) * dp
            line.alpha = if (i % 18 == 0) 150 else if (i % 6 == 0) 90 else 50
            val r0 = r * 1.3f
            canvas.drawLine(cx + cos(a).toFloat() * r0, cy + sin(a).toFloat() * r0, cx + cos(a).toFloat() * (r0 + len), cy + sin(a).toFloat() * (r0 + len), line)
            if (i % 18 == 0) { text.alpha = 150; canvas.drawText("${i * 5}°", cx + cos(a).toFloat() * (r0 + 26 * dp), cy + sin(a).toFloat() * (r0 + 26 * dp) + 3 * dp, text) }
        }
        // The radar sweep between the 1.3 and 1.62 rings
        val sg = SweepGradient(cx, cy, intArrayOf(Scheme.alpha(60), Color.TRANSPARENT, Color.TRANSPARENT), floatArrayOf(0f, 0.14f, 1f))
        canvas.save(); canvas.rotate(sweep, cx, cy)
        fill.shader = sg; line.pathEffect = null
        val ring = Paint(fill).apply { style = Paint.Style.STROKE; strokeWidth = r * 0.32f }
        canvas.drawCircle(cx, cy, r * 1.46f, ring)
        fill.shader = null; canvas.restore()

        // Readouts on callouts: anchors on the reactor's rings, boxes in the corners
        val w = width.toFloat(); val h = height.toFloat()
        val m = 14f * dp
        val spots = listOf(
            Triple(floatArrayOf(cx - r * 0.62f, cy - r * 0.62f), floatArrayOf(m, cy - r * 1.62f), Paint.Align.LEFT),
            Triple(floatArrayOf(cx + r * 0.6f, cy - r * 0.72f), floatArrayOf(w - m, cy - r * 1.62f), Paint.Align.RIGHT),
            Triple(floatArrayOf(cx - r * 0.3f, cy + r * 0.9f), floatArrayOf(m, cy + r * 1.72f), Paint.Align.LEFT),
            Triple(floatArrayOf(cx + r * 0.55f, cy + r * 0.75f), floatArrayOf(w - m, cy + r * 1.72f), Paint.Align.RIGHT),
        )
        for ((i, spot) in spots.withIndex()) {
            val (anchor, box, align) = spot
            val (label, value) = readouts.getOrNull(i) ?: continue
            if (label.isEmpty()) continue // (the home screen shows only the bottom two)
            val bx = box[0]; val by = box[1].coerceIn(60f * dp, h - 20f * dp)
            val dir = if (align == Paint.Align.LEFT) 1f else -1f
            val k = if (i >= 2) bottomAlpha else 1f
            line.alpha = (90 * k).toInt(); line.strokeWidth = 1f
            canvas.drawLine(anchor[0], anchor[1], bx + dir * 6f * dp, by, line)
            canvas.drawLine(bx + dir * 6f * dp, by, bx + dir * 70f * dp, by, line)
            fill.alpha = (230 * k).toInt(); canvas.drawCircle(anchor[0], anchor[1], 2.5f * dp, fill)
            text.textAlign = align
            text.textSize = 8f * dp; text.alpha = (220 * k).toInt(); canvas.drawText(label, bx, by - 5f * dp, text)
            text.textSize = 8f * dp; text.alpha = (130 * k).toInt(); canvas.drawText(value, bx, by + 10f * dp, text)
        }
        fill.alpha = 255
        if (isShown && !still) nextFrame(maxFps)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        last = 0L
        if (visibility == VISIBLE) invalidate()
    }
}
