package com.dhruv.ares

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * What the reactor page draws around the reactor (docs/launcher-v2-prompt.md §5–7), over it and under the cards:
 * notification orbs on an arc above it (tap = read, drag into the core = dismiss), the spark of a new notification, the
 * green ripples of an incoming call, the amber countdown before a meeting, the dashed link to the Mac, and the Buds' earpieces.
 * Only touches that land on an orb are taken; everything else goes through to the reactor and the page.
 */
class HomeOverlay @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    private val dp = resources.displayMetrics.density
    private var cx = 0f; private var cy = 0f; private var r = 0f
    fun place(x: Float, y: Float, radius: Float) { cx = x; cy = y; r = radius; invalidate() }

    var notes: List<NotifStore.Item> = emptyList()
        set(v) { field = v; invalidate() }
    var onTap: (NotifStore.Item) -> Unit = {}
    var onDismiss: (NotifStore.Item) -> Unit = {}
    var ringing = false
        set(v) { field = v; t0Ring = System.nanoTime(); invalidate() }
    /** 0..1 of the last 15 minutes before a meeting (null = none). */
    var countdown: Float? = null
        set(v) { field = v; invalidate() }
    var deskLink = false
        set(v) { field = v; invalidate() }
    var buds: String? = null // the earbuds' name while connected
        set(v) { field = v; invalidate() }
    var still = false
        set(v) { field = v; invalidate() }

    private val amber = Color.parseColor("#FFB547")
    private val green = Color.parseColor("#4ADE80")
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = android.graphics.Typeface.MONOSPACE; textAlign = Paint.Align.CENTER; letterSpacing = 0.2f }
    private val dash = DashPathEffect(floatArrayOf(4 * dp, 5 * dp), 0f)
    private val arc = RectF()
    private val pos = HashMap<String, PointF>()
    private var t0Ring = 0L
    private val t0 = System.nanoTime()
    private val orbPx = (34 * dp).toInt()

    // Touch: an orb under the finger is held; dragged into the core, it's dismissed
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private var held: NotifStore.Item? = null
    private var moved = false
    private var dx0 = 0f; private var dy0 = 0f
    private val absorbing = ArrayList<Triple<NotifStore.Item, PointF, Long>>()
    private var spark: Pair<Long, () -> Unit>? = null

    /** A new notification: a spark from the top of the screen into the core; `land` when it gets there. */
    fun spark(land: () -> Unit) { spark = System.nanoTime() to land; invalidate() }

    private fun slot(i: Int, n: Int): PointF {
        val a = -PI + 0.42 + i * (PI - 0.84) / max(1, n - 1)
        val rr = r * 1.55f
        return PointF(cx + cos(a).toFloat() * rr, cy + sin(a).toFloat() * rr)
    }

    private fun secs(since: Long) = (System.nanoTime() - since) / 1e9f

    override fun onDraw(canvas: Canvas) {
        if (r <= 0f) return
        val t = secs(t0)
        val c = Scheme.color
        var animate = false

        // Incoming call: green ripples rolling out from the reactor
        if (ringing) {
            stroke.color = green; stroke.strokeWidth = 2 * dp; stroke.pathEffect = null
            val k = secs(t0Ring)
            for (i in 0 until 3) {
                val p = ((k * 0.7f + i / 3f) % 1f)
                stroke.alpha = ((1 - p) * 150).toInt()
                canvas.drawCircle(cx, cy, r * (1 + p * 1.4f), stroke)
            }
            animate = true
        }

        // A meeting soon: the last 15 minutes as an amber ring filling round the reactor
        countdown?.let { k ->
            stroke.color = amber; stroke.strokeWidth = 3 * dp; stroke.pathEffect = null
            arc.set(cx - r * 1.12f, cy - r * 1.12f, cx + r * 1.12f, cy + r * 1.12f)
            stroke.alpha = 60; canvas.drawArc(arc, 0f, 360f, false, stroke)
            stroke.alpha = 230; canvas.drawArc(arc, -90f, 360f * k.coerceIn(0f, 1f), false, stroke)
        }

        // At the Mac: a dashed link to it, with a pulse travelling along
        if (deskLink) {
            val sx = cx + r * 0.72f; val sy = cy - r * 0.72f
            val ex = width - 34 * dp; val ey = max(cy - r * 1.75f, 40 * dp)
            stroke.color = c; stroke.strokeWidth = dp; stroke.pathEffect = dash; stroke.alpha = 150
            canvas.drawLine(sx, sy, ex, ey + 14 * dp, stroke)
            stroke.pathEffect = null
            val d = (t * 0.6f) % 1f
            fill.color = c; fill.alpha = 230
            canvas.drawCircle(sx + (ex - sx) * d, sy + (ey + 14 * dp - sy) * d, 2.5f * dp, fill)
            // A small laptop: the screen and the base
            stroke.alpha = 230; stroke.strokeWidth = 1.5f * dp
            arc.set(ex - 13 * dp, ey - 9 * dp, ex + 13 * dp, ey + 7 * dp); canvas.drawRoundRect(arc, 2 * dp, 2 * dp, stroke)
            canvas.drawLine(ex - 17 * dp, ey + 10 * dp, ex + 17 * dp, ey + 10 * dp, stroke)
            text.color = c; text.alpha = 200; text.textSize = 9 * dp
            canvas.drawText("MAC", ex, ey + 24 * dp, text)
            animate = true
        }

        // Buds: two earpieces either side of the reactor, breathing
        buds?.let { name ->
            stroke.color = c; stroke.strokeWidth = 3 * dp; stroke.pathEffect = null
            stroke.alpha = (140 + 90 * sin(t * 2.5f)).toInt().coerceIn(0, 255)
            arc.set(cx - r * 1.18f, cy - r * 1.18f, cx + r * 1.18f, cy + r * 1.18f)
            canvas.drawArc(arc, 148f, 64f, false, stroke)
            canvas.drawArc(arc, -32f, 64f, false, stroke)
            for (s in listOf(-1f, 1f)) {
                val x = cx + s * r * 1.18f
                arc.set(x - 6 * dp, cy - 11 * dp, x + 6 * dp, cy + 11 * dp)
                fill.color = Color.parseColor("#06121B"); fill.alpha = 255; canvas.drawRoundRect(arc, 6 * dp, 6 * dp, fill)
                stroke.alpha = 255; stroke.strokeWidth = 1.5f * dp; canvas.drawRoundRect(arc, 6 * dp, 6 * dp, stroke)
            }
            text.color = c; text.alpha = 210; text.textSize = 9 * dp
            canvas.drawText(name.uppercase().take(26), cx, cy - r * 1.42f, text)
            animate = true
        }

        // Notification orbs on the arc above the reactor
        val live = notes.filter { n -> absorbing.none { it.first.key == n.key } }
        val keep = live.map { it.key }.toHashSet()
        pos.keys.retainAll(keep)
        val dragging = held?.takeIf { moved }
        live.forEachIndexed { i, n ->
            val target = slot(i, live.size)
            val p = pos.getOrPut(n.key) { PointF(target.x, target.y) }
            if (n !== dragging) {
                val k = 0.18f
                p.x += (target.x - p.x) * k; p.y += (target.y - p.y) * k
                if (hypot(target.x - p.x, target.y - p.y) > 0.5f) animate = true
            }
            drawOrb(canvas, n, p.x, p.y, if (n === dragging) 1.15f else 1f, t)
            if (n.person) animate = true
        }
        // The core lights up as a dragged orb comes close
        if (dragging != null) {
            val p = pos[dragging.key]
            if (p != null) {
                val hot = (1 - hypot(p.x - cx, p.y - cy) / (r * 2)).coerceIn(0f, 1f)
                stroke.color = c; stroke.strokeWidth = 2 * dp; stroke.pathEffect = dash; stroke.alpha = (60 + hot * 180).toInt()
                canvas.save(); canvas.rotate(t * 40, cx, cy); canvas.drawCircle(cx, cy, r * 0.6f, stroke); canvas.restore()
                stroke.pathEffect = null
            }
            animate = true
        }
        // Dismissed orbs shrink into the core
        val iter = absorbing.iterator()
        while (iter.hasNext()) {
            val (n, p, at) = iter.next()
            val k = secs(at) / 0.4f
            if (k >= 1f) { iter.remove(); continue }
            drawOrb(canvas, n, p.x + (cx - p.x) * k, p.y + (cy - p.y) * k, 1 - k, t)
            animate = true
        }

        // A new notification's spark, from the top right corner into the core
        spark?.let { (at, land) ->
            val k = secs(at) / 0.9f
            if (k >= 1f) { spark = null; land() }
            else {
                val e = k * k * (3 - 2 * k)
                val x0 = width - 24 * dp; val y0 = 0f; val x1 = width - 40 * dp; val y1 = cy - r * 1.6f
                val x = (1 - e) * (1 - e) * x0 + 2 * (1 - e) * e * x1 + e * e * cx
                val y = (1 - e) * (1 - e) * y0 + 2 * (1 - e) * e * y1 + e * e * cy
                fill.color = c; fill.alpha = 90; canvas.drawCircle(x, y, 9 * dp, fill)
                fill.color = Color.WHITE; fill.alpha = 255; canvas.drawCircle(x, y, 3 * dp, fill)
                animate = true
            }
        }

        if (animate && !still && isShown) nextFrame(30)
    }

    private fun drawOrb(canvas: Canvas, n: NotifStore.Item, x: Float, y: Float, scale: Float, t: Float) {
        if (scale <= 0f) return
        val half = orbPx / 2f * scale
        if (n.person) {
            stroke.color = amber; stroke.pathEffect = null; stroke.strokeWidth = 1.5f * dp
            stroke.alpha = (90 + 90 * sin(t * 4)).toInt().coerceIn(0, 255)
            canvas.drawCircle(x, y, half + 5 * dp, stroke)
        }
        val app = Apps.all.firstOrNull { it.component.packageName == n.pkg && it.user == android.os.Process.myUserHandle() }
        val bmp = app?.let { Icons.get(context, it, orbPx) { invalidate() } }
        if (bmp != null) {
            arc.set(x - half, y - half, x + half, y + half)
            canvas.drawBitmap(bmp, null, arc, null)
        } else {
            fill.color = Color.parseColor("#06121B"); fill.alpha = 255; canvas.drawCircle(x, y, half, fill)
            stroke.color = Scheme.color; stroke.strokeWidth = dp; stroke.alpha = 120; canvas.drawCircle(x, y, half, stroke)
            text.color = Scheme.color; text.alpha = 230; text.textSize = 13 * dp * scale
            canvas.drawText(n.app.take(1).uppercase(), x, y + 4.5f * dp * scale, text)
        }
        if (n.person) { stroke.color = amber; stroke.alpha = 255; stroke.strokeWidth = 2 * dp; canvas.drawCircle(x, y, half, stroke) }
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val hit = notes.firstOrNull { n -> pos[n.key]?.let { hypot(it.x - e.x, it.y - e.y) < orbPx * 0.75f } == true } ?: return false
                held = hit; moved = false
                parent?.requestDisallowInterceptTouchEvent(true) // a finger on an orb is the orb's (no page swipe)
                val p = pos.getValue(hit.key); dx0 = e.x - p.x; dy0 = e.y - p.y
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val n = held ?: return false
                val p = pos[n.key] ?: return false
                if (!moved && hypot(e.x - dx0 - p.x, e.y - dy0 - p.y) > slop) moved = true
                if (moved) { p.x = e.x - dx0; p.y = e.y - dy0; invalidate() }
            }
            MotionEvent.ACTION_UP -> {
                val n = held ?: return false
                held = null
                parent?.requestDisallowInterceptTouchEvent(false)
                val p = pos[n.key]
                if (!moved) onTap(n)
                else if (p != null && hypot(p.x - cx, p.y - cy) < r * 0.6f) {
                    absorbing += Triple(n, PointF(p.x, p.y), System.nanoTime())
                    Haptics.click(context)
                    onDismiss(n)
                }
                invalidate() // (anything else floats back to its place)
            }
            MotionEvent.ACTION_CANCEL -> { held = null; parent?.requestDisallowInterceptTouchEvent(false); invalidate() }
        }
        return true
    }
}
