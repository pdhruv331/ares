package com.dhruv.ares

import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * ARES's arc reactor, alive: a scanner sweeping the tick ring, segmented rings turning against each other,
 * a coil ring that chases around the core, a waveform ring that moves with her voice (or yours), sparks
 * drifting out of the core, and a small orb for each background job circling the outside. Colour follows
 * her state: cyan at rest and listening, purple and quick while thinking, white-hot while speaking, amber offline.
 * Draws itself ~60 times a second while shown; scales down to a 64dp button without the extras.
 */
class ReactorView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    var state = State.IDLE
        set(v) { if (field != v) { field = v; if (v == State.THINKING) burst(14); invalidate() } }
    var levelSource: () -> Float = { 0f }

    private val cyan = Color.parseColor("#3EE6FF")
    private val purple = Color.parseColor("#9D8CFF")
    private val amber = Color.parseColor("#FFB547")
    private val white = Color.parseColor("#F2FBFF")
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { maskFilter = BlurMaskFilter(36f, BlurMaskFilter.Blur.NORMAL) }
    private val softGlow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; maskFilter = BlurMaskFilter(14f, BlurMaskFilter.Blur.NORMAL) }
    private val arc = RectF()
    private val wave = Path()
    private val coreMatrix = Matrix()
    private var coreShader: RadialGradient? = null
    private var coreColor = 0
    private var level = 0f
    private var spin = 0f      // the main rings
    private var scan = 0f      // the scanner on the tick ring
    private var chase = 0f     // the lit coil travelling around the core
    private var energy = 0f    // 0 at rest → 1 fully alive (smooth state changes)
    private var hue = cyan     // current colour, eased towards the state's colour
    private var last = 0L
    private val rnd = Random(7)

    // Segmented rings: radius (of r), dashes (on, off in degrees), turn speed (deg/s at rest), direction
    private class Ring(val rad: Float, val on: Float, val off: Float, val speed: Float, val width: Float, val alpha: Int)
    private val rings = listOf(
        Ring(0.86f, 28f, 14f, 9f, 0.028f, 190), Ring(0.78f, 7f, 7f, -16f, 0.012f, 120),
        Ring(0.66f, 52f, 30f, 24f, 0.034f, 220), Ring(0.56f, 12f, 24f, -38f, 0.016f, 150),
    )
    private val dashes = HashMap<Ring, DashPathEffect>()

    // Sparks: drift out from the core and fade
    private class Spark(var x: Float, var y: Float, var vx: Float, var vy: Float, var life: Float, var size: Float)
    private val sparks = ArrayList<Spark>(60)
    private var spawn = 0f

    // Job orbs around the outside: id → (angle, waiting)
    private var orbs: List<Pair<Float, Boolean>> = emptyList()
    private var orbSpin = 0f

    /** The Mac's jobs: one orb each, amber for ones waiting on you. */
    fun jobs(list: List<JobStore.Job>) {
        val active = list.filter { it.active }
        orbs = active.mapIndexed { i, j -> (i * 360f / active.size) to (j.status == "approval") }
        invalidate()
    }

    private val target get() = when (state) { State.THINKING -> purple; State.OFFLINE -> amber; State.SPEAKING -> white; else -> cyan }
    private fun mix(a: Int, b: Int, t: Float): Int {
        val k = t.coerceIn(0f, 1f)
        return Color.argb(255, (Color.red(a) + (Color.red(b) - Color.red(a)) * k).toInt(), (Color.green(a) + (Color.green(b) - Color.green(a)) * k).toInt(), (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * k).toInt())
    }

    private fun burst(n: Int) {
        val cx = width / 2f; val cy = height / 2f; val r = min(width, height) / 2f * 0.9f
        repeat(n) {
            val a = rnd.nextFloat() * 2f * PI.toFloat()
            val sp = r * (0.25f + rnd.nextFloat() * 0.45f)
            sparks += Spark(cx + cos(a) * r * 0.3f, cy + sin(a) * r * 0.3f, cos(a) * sp, sin(a) * sp, 1f, r * (0.008f + rnd.nextFloat() * 0.012f))
        }
        while (sparks.size > 90) sparks.removeAt(0)
    }

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (last == 0L) 0f else ((now - last) / 1e9f).coerceAtMost(0.05f)
        last = now
        val t = now / 1e9f
        val wantLevel = if (state == State.SPEAKING || state == State.LISTENING) levelSource() else 0f
        level += (wantLevel - level) * (dt * 16f).coerceAtMost(1f)
        val wantEnergy = when (state) { State.IDLE -> 0f; State.OFFLINE -> 0f; State.LISTENING -> 0.55f; State.SPEAKING -> 0.8f; State.THINKING -> 1f }
        energy += (wantEnergy - energy) * (dt * 3f).coerceAtMost(1f)
        hue = mix(hue, target, (dt * 4f).coerceAtMost(1f))
        val pace = 1f + energy * (if (state == State.THINKING) 6f else 2.2f)
        spin += dt * 10f * pace
        scan += dt * (40f + energy * 160f)
        chase += dt * (90f + energy * 420f + level * 300f)
        orbSpin += dt * 12f

        val cx = width / 2f
        val cy = height / 2f
        val r = min(width, height) / 2f * 0.92f
        val small = r < 120f // the little reactor on the ask panel: no sparks, no orbs, no scanner
        val c = hue
        val dim = state == State.OFFLINE

        // Outer tick ring with the scanner: a bright wedge sweeping round, ticks ahead of it lit
        stroke.strokeWidth = r * 0.01f
        for (i in 0 until 90) {
            val deg = i * 4f
            val a = Math.toRadians(deg.toDouble())
            val behind = ((scan - deg) % 360f + 360f) % 360f // how far past this tick the scanner is
            val lit = if (small) 0f else (1f - behind / 70f).coerceIn(0f, 1f)
            val inner = if (i % 9 == 0) r * 0.9f else r * 0.945f
            stroke.color = c; stroke.alpha = (45 + lit * 190).toInt().coerceAtMost(255)
            canvas.drawLine(cx + cos(a).toFloat() * inner, cy + sin(a).toFloat() * inner, cx + cos(a).toFloat() * r, cy + sin(a).toFloat() * r, stroke)
        }
        if (!small) { // the scanner's glow trail
            softGlow.color = c; softGlow.alpha = (60 + energy * 90).toInt(); softGlow.strokeWidth = r * 0.05f
            arc.set(cx - r * 0.95f, cy - r * 0.95f, cx + r * 0.95f, cy + r * 0.95f)
            canvas.drawArc(arc, scan - 40f, 40f, false, softGlow)
        }

        // Segmented rings turning against each other
        stroke.pathEffect = null
        for (ring in rings) {
            val rad = r * ring.rad
            val circ = (2 * PI * rad).toFloat()
            val eff = dashes.getOrPut(ring) { DashPathEffect(floatArrayOf(circ * ring.on / 360f, circ * ring.off / 360f), 0f) }
            stroke.pathEffect = eff
            stroke.strokeWidth = r * ring.width
            stroke.color = c; stroke.alpha = if (dim) ring.alpha / 2 else (ring.alpha * (0.7f + energy * 0.3f)).toInt()
            arc.set(cx - rad, cy - rad, cx + rad, cy + rad)
            canvas.save()
            canvas.rotate(spin * ring.speed / 10f, cx, cy)
            canvas.drawArc(arc, 0f, 360f, false, stroke)
            canvas.restore()
        }
        stroke.pathEffect = null

        // The waveform ring: her voice (or yours) ripples it
        val wr = r * 0.47f
        if (level > 0.02f || energy > 0.05f) {
            wave.reset()
            val amp = wr * (0.02f + level * 0.16f + energy * 0.015f)
            for (i in 0..120) {
                val a = i / 120f * 2f * PI.toFloat()
                val wob = sin(a * 7f + t * 9f) * 0.5f + sin(a * 11f - t * 13f) * 0.3f + sin(a * 3f + t * 4f) * 0.2f
                val rr = wr + amp * wob
                val x = cx + cos(a) * rr; val y = cy + sin(a) * rr
                if (i == 0) wave.moveTo(x, y) else wave.lineTo(x, y)
            }
            wave.close()
            stroke.strokeWidth = r * 0.012f; stroke.color = c; stroke.alpha = (90 + level * 160).toInt().coerceAtMost(255)
            canvas.drawPath(wave, stroke)
        }

        // Coils around the core, lit in a chase
        val coils = 10
        val coilR = r * 0.4f
        for (i in 0 until coils) {
            val deg = i * 360f / coils
            val a = Math.toRadians(deg.toDouble())
            val d = ((chase - deg) % 360f + 360f) % 360f
            val lit = (1f - d / 110f).coerceIn(0f, 1f)
            stroke.strokeWidth = r * 0.045f; stroke.color = c
            stroke.alpha = (50 + lit * 200 * (0.4f + energy * 0.6f + level * 0.5f)).toInt().coerceAtMost(255)
            val x1 = cx + cos(a).toFloat() * (coilR - r * 0.035f); val y1 = cy + sin(a).toFloat() * (coilR - r * 0.035f)
            val x2 = cx + cos(a).toFloat() * (coilR + r * 0.035f); val y2 = cy + sin(a).toFloat() * (coilR + r * 0.035f)
            canvas.drawLine(x1, y1, x2, y2, stroke)
        }

        // Core: breathes at rest, swells with the voice, flares while thinking
        val breathe = (sin(t * 1.4f) + 1f) * 0.025f
        val flicker = if (state == State.THINKING) (sin(t * 23f) * 0.5f + sin(t * 37f) * 0.5f) * 0.02f else 0f
        val core = r * (0.24f + breathe + level * 0.13f + energy * 0.03f + flicker)
        glow.color = c; glow.alpha = (70 + energy * 90 + level * 120).toInt().coerceAtMost(255)
        canvas.drawCircle(cx, cy, core * 1.35f, glow)
        if (coreShader == null || coreColor != c) {
            coreColor = c
            coreShader = RadialGradient(0f, 0f, 1f, intArrayOf(Color.WHITE, c, Color.argb(0, Color.red(c), Color.green(c), Color.blue(c))), floatArrayOf(0f, 0.42f, 1f), Shader.TileMode.CLAMP)
        }
        coreMatrix.setScale(core, core)
        coreMatrix.postTranslate(cx, cy)
        coreShader!!.setLocalMatrix(coreMatrix)
        fill.shader = coreShader
        fill.alpha = if (dim) 150 else 255
        canvas.drawCircle(cx, cy, core, fill)
        fill.shader = null

        if (!small) {
            // Sparks: a trickle at rest, a stream while she works or speaks
            spawn += dt * (2f + energy * 22f + level * 30f)
            while (spawn >= 1f) { spawn -= 1f; burst(1) }
            fill.color = c
            val it = sparks.iterator()
            while (it.hasNext()) {
                val s = it.next()
                s.life -= dt * 0.9f
                if (s.life <= 0f) { it.remove(); continue }
                s.x += s.vx * dt; s.y += s.vy * dt
                s.vx *= 1f - dt * 0.6f; s.vy *= 1f - dt * 0.6f
                fill.alpha = (s.life * 220).toInt()
                canvas.drawCircle(s.x, s.y, s.size * (0.5f + s.life * 0.5f), fill)
            }
            fill.alpha = 255

            // Job orbs circling outside the ring
            for ((angle, waiting) in orbs) {
                val a = Math.toRadians((angle + orbSpin).toDouble())
                val ox = cx + cos(a).toFloat() * r * 1.0f; val oy = cy + sin(a).toFloat() * r * 1.0f
                val oc = if (waiting) amber else c
                glow.color = oc; glow.alpha = 120
                canvas.drawCircle(ox, oy, r * 0.03f, glow)
                fill.color = oc
                canvas.drawCircle(ox, oy, r * 0.022f, fill)
            }
        }

        if (isShown) postInvalidateOnAnimation()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        last = 0L
        if (visibility == VISIBLE) invalidate()
    }
}
