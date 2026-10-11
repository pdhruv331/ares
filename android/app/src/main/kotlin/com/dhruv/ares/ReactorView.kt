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
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

/**
 * ARES's arc reactor, alive: a scanner sweeping the tick ring, segmented rings turning against each other,
 * a coil ring that chases around the core, a waveform ring that moves with her voice (or yours), sparks
 * drifting out of the core, and a small orb for each background job circling the outside. Colour follows
 * her state: cyan at rest and listening, purple and quick while thinking, white-hot while speaking, amber offline.
 *
 * It also mirrors the Mac's POWER state (docs/ignition-prompt.md §4d): STANDBY winds the rings down to a cool blue with the
 * core breathing slowly; OFFLINE is the cold gold still; ASLEEP grey and still; CHARGING pulls streams of energy into the core
 * as the real charge grows, then a white bloom; SPINDOWN decelerates to gold. A hold ring fills around it while you hold.
 *
 * Her states are told apart by SHAPE, not only colour (docs/phone-ui-prompt.md §4), every parameter a spring the draw
 * loop reads: LISTENING opens the coils and the ring follows the mic; THINKING contracts the core and beats about once a
 * second; SPEAKING's ring follows her voice; DONE settles with one overshoot; an interruption collapses in under 100 ms.
 * Frame pacing: ~30 fps while idle, the panel's full rate during holds, state bursts and page swipes (adaptive refresh
 * where the panel has it, else a plain throttle); dead still with the system's animations off.
 */
class ReactorView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    enum class Power { ONLINE, STANDBY, OFFLINE, ASLEEP, CHARGING, SPINDOWN }

    var state = State.IDLE
        set(v) {
            if (field == v) return
            val was = field
            field = v
            if (v == State.THINKING && power == Power.ONLINE) burst(14)
            shape(v, was)
            announce(v)
            invalidate()
        }
    var levelSource: () -> Float = { 0f }
    /** The Mac's power state; transitions animate from wherever the rings are. */
    var power = Power.ONLINE
        set(v) {
            if (field == v) return
            val from = field
            field = v
            if (v == Power.ONLINE && (from == Power.CHARGING || from == Power.STANDBY || from == Power.OFFLINE)) { bloom = if (from == Power.CHARGING) 1f else 0.55f; shock = 0f; burst(if (from == Power.CHARGING) 40 else 16) }
            if (v == Power.CHARGING) { chargeK = 0f; streams.clear() }
            if (v == Power.SPINDOWN || v == Power.OFFLINE) flickerAt = 0f
            invalidate()
        }
    /** 0..1 while CHARGING: the real start-up progress from the Mac. */
    var chargeK = 0f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    /** 0..1 while the user holds the orb: a ring fills around the reactor in `holdColor`. */
    var holdK = 0f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    var holdColor = Color.parseColor("#6096FF")

    private val purple = Color.parseColor("#9D8CFF")
    private val amber = Color.parseColor("#FFB547")
    private val white = Color.parseColor("#F2FBFF")
    private val blue = Color.parseColor("#6096FF")
    private val gold = Color.parseColor("#FAC458")
    private val grey = Color.parseColor("#6B7A86")
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
    private var alive = 1f     // 1 online → 0 cold: the rings' pace and brightness (power transitions)
    private var hue = Scheme.color     // current colour, eased towards the target
    private var bloom = 0f     // the wake's white bloom, fading
    private var shock = -1f    // the wake's shockwave radius (of r), -1 = none
    private var flickerAt = -1f
    private var last = 0L
    private var t0 = 0L
    private val rnd = Random(7)

    // Segmented rings: radius (of r), dashes (on, off in degrees), turn speed (deg/s at rest), direction
    private class Ring(val rad: Float, val on: Float, val off: Float, val speed: Float, val width: Float, val alpha: Int, val inertia: Float)
    private val rings = listOf(
        Ring(0.86f, 28f, 14f, 9f, 0.028f, 190, 1.0f), Ring(0.78f, 7f, 7f, -16f, 0.012f, 120, 1.6f),
        Ring(0.66f, 52f, 30f, 24f, 0.034f, 220, 1.25f), Ring(0.56f, 12f, 24f, -38f, 0.016f, 150, 2.0f),
    )
    private val ringAngle = FloatArray(rings.size)
    private val dashes = HashMap<Ring, DashPathEffect>()

    // Sparks: drift out from the core and fade
    private class Spark(var x: Float, var y: Float, var vx: Float, var vy: Float, var life: Float, var size: Float)
    private val sparks = ArrayList<Spark>(60)
    private var spawn = 0f
    // Streams of energy pulled into the core while charging: angle, radius (of r), speed, brightness
    private class Stream(var a: Float, var rr: Float, var sp: Float, var w: Float)
    private val streams = ArrayList<Stream>(80)
    private var streamSpawn = 0f

    // Job orbs around the outside: id → (angle, waiting)
    private var orbs: List<Pair<Float, Boolean>> = emptyList()
    private var orbIds: List<String> = emptyList()
    private var orbSpin = 0f
    /** A colour that wins over the state and power colours while set (the home screen: green for an incoming call). */
    var tintOverride: Int? = null
        set(v) { field = v; invalidate() }
    /** How alive she is while online (1 = fully; the home screen's night mode winds her nearly still). */
    var ambient = 1f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    /** A brief flare of the core (a notification landing). */
    fun pulse() { bloom = max(bloom, 0.35f); burst(10); invalidate() }
    /** Frames per second to aim for: 0 = every vsync (the app), lower where she's ambient (the home screen). */
    var maxFps = 0
    /** Draw once and hold still (Power Saving on the home screen). */
    var still = false
        set(v) { field = v; last = 0L; invalidate() }

    // ---- The state's shape (sprung; the draw loop reads the values) ------------------------------------------------------
    private val coilOpen = Motion.Value(0f, Motion.DefaultSpatial) { invalidate() }   // 0 closed → 1 spread (listening)
    private val coreK = Motion.Value(1f, Motion.DefaultSpatial) { invalidate() }      // the core's scale (thinking contracts it)
    private val beat = Motion.Value(0f, Motion.DefaultEffects) { invalidate() }       // the heartbeat while thinking
    private val ringK = Motion.Value(0f, Motion.DefaultEffects) { invalidate() }      // how far the waveform ring follows the voice
    private var beatAt = 0L
    private val hotKeys = HashSet<String>()
    private var lastHot = 0L

    private fun shape(s: State, was: State) {
        val online = power == Power.ONLINE
        when {
            !online -> { coilOpen.to(0f); coreK.to(1f); ringK.to(0f) }
            s == State.LISTENING -> { coilOpen.to(1f, Motion.DefaultSpatial); coreK.to(1f, Motion.DefaultSpatial); ringK.to(1f) }
            s == State.THINKING -> { coilOpen.to(0f, Motion.DefaultSpatial); coreK.to(0.82f, Motion.DefaultSpatial); ringK.to(0.35f); beatAt = 0L }
            s == State.SPEAKING -> { coilOpen.to(0.25f, Motion.DefaultSpatial); coreK.to(1f, Motion.DefaultSpatial); ringK.to(1f) }
            else -> { // IDLE after a turn: one spatial settle with a single overshoot
                coilOpen.to(0f, Motion.DefaultSpatial); ringK.to(0f)
                if (was == State.SPEAKING || was == State.THINKING) { coreK.set(1.08f); coreK.to(1f, Motion.FastSpatial) } else coreK.to(1f)
            }
        }
    }

    /** Interrupted (a tap or a new hold while she speaks or thinks): everything collapses to rest in under 100 ms. */
    fun interrupt() {
        coilOpen.to(0f, Motion.FastEffects); coreK.to(1f, Motion.FastEffects); ringK.to(0f, Motion.FastEffects); beat.to(0f, Motion.FastEffects)
        energy = min(energy, 0.15f); level = 0f
        invalidate()
    }

    /** Something wants the full frame rate for a while (a page swipe, a summon): `on` while it lasts. */
    fun hot(key: String, on: Boolean) { if (on) hotKeys += key else hotKeys -= key; if (on) invalidate() }
    private val isHot: Boolean get() = hotKeys.isNotEmpty() || (power == Power.ONLINE && state != State.IDLE) || holdK > 0f || bloom > 0f || shock >= 0f ||
        power == Power.CHARGING || abs(wantAlive - alive) > 0.01f || System.nanoTime() - lastHot < 600_000_000L ||
        coilOpen.moving || coreK.moving || beat.moving

    @Suppress("DEPRECATION")
    private fun announce(s: State) {
        val label = when (s) { State.LISTENING -> "Listening"; State.THINKING -> "Thinking"; State.SPEAKING -> "Speaking"; State.OFFLINE -> "Offline"; State.IDLE -> "Ready" }
        stateDescription = label
        if (isShown && isAttachedToWindow && resources.displayMetrics.widthPixels > 0) announceForAccessibility("ARES $label")
    }

    /** The Mac's jobs: one orb each, amber for ones waiting on you. */
    fun jobs(list: List<JobStore.Job>) {
        val active = list.filter { it.active }
        orbs = active.mapIndexed { i, j -> (i * 360f / active.size) to (j.status == "approval") }
        orbIds = active.map { it.id }
        invalidate()
    }

    /** The job whose orb is under (x, y) in this view, if any (a finger-sized target). */
    fun orbAt(x: Float, y: Float): String? {
        val cx = width / 2f; val cy = height / 2f; val r = min(width, height) / 2f * 0.92f
        val reach = 22f * resources.displayMetrics.density
        for ((i, o) in orbs.withIndex()) {
            val a = Math.toRadians((o.first + orbSpin).toDouble())
            val ox = cx + cos(a).toFloat() * r; val oy = cy + sin(a).toFloat() * r
            if ((x - ox) * (x - ox) + (y - oy) * (y - oy) < reach * reach) return orbIds.getOrNull(i)
        }
        return null
    }

    private val stateHue get() = when (state) { State.THINKING -> purple; State.OFFLINE -> amber; State.SPEAKING -> white; else -> Scheme.color }
    private val target: Int get() = tintOverride ?: when (power) {
        Power.ONLINE -> stateHue
        Power.STANDBY -> blue
        Power.OFFLINE, Power.SPINDOWN -> gold
        Power.ASLEEP -> grey
        Power.CHARGING -> mix(gold, white, chargeK * chargeK)
    }
    private val wantAlive get() = when (power) { Power.ONLINE -> ambient; Power.STANDBY -> 0.08f; Power.CHARGING -> 0.15f + 0.85f * chargeK; else -> 0f }
    private fun mix(a: Int, b: Int, t: Float): Int {
        val k = t.coerceIn(0f, 1f)
        return Color.argb(255, (Color.red(a) + (Color.red(b) - Color.red(a)) * k).toInt(), (Color.green(a) + (Color.green(b) - Color.green(a)) * k).toInt(), (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * k).toInt())
    }

    private fun burst(n: Int) {
        lastHot = System.nanoTime()
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
        if (t0 == 0L) t0 = now
        val dt = if (last == 0L) 0f else ((now - last) / 1e9f).coerceAtMost(0.05f)
        last = now
        val t = (now - t0) / 1e9f
        val online = power == Power.ONLINE
        val wantLevel = if (online && (state == State.SPEAKING || state == State.LISTENING)) levelSource() else 0f
        level += (wantLevel - level) * (dt * 16f).coerceAtMost(1f)
        val wantEnergy = if (!online) 0f else when (state) { State.IDLE -> 0f; State.OFFLINE -> 0f; State.LISTENING -> 0.55f; State.SPEAKING -> 0.8f; State.THINKING -> 1f }
        energy += (wantEnergy - energy) * (dt * 3f).coerceAtMost(1f)
        // The heartbeat while thinking: a quick swell about once a second, decaying between beats
        if (online && state == State.THINKING && now - beatAt > 1_000_000_000L) { beatAt = now; beat.set(1f); beat.to(0f, Motion.DefaultEffects) }
        // Power: the rings wind down slowly (standby ~2.5 s, the spin-down ~3.5 s) and come up quickly
        val wa = wantAlive
        val rate = if (wa < alive) (if (power == Power.SPINDOWN) 0.75f else 1.3f) else 2.4f
        alive += (wa - alive) * (dt * rate).coerceAtMost(1f)
        if (power == Power.ASLEEP) alive = 0f
        hue = mix(hue, target, (dt * (if (power == Power.CHARGING) 2f else 4f)).coerceAtMost(1f))
        bloom = max(0f, bloom - dt * 1.1f)
        if (shock >= 0f) { shock += dt * 2.2f; if (shock > 2.6f) shock = -1f }
        val pace = (1f + energy * (if (state == State.THINKING) 6f else 2.2f)) * alive
        spin += dt * 10f * pace
        for (i in rings.indices) ringAngle[i] += dt * rings[i].speed * (if (alive < 0.999f) alive.pow(rings[i].inertia) else 1f) * (1f + energy * (if (state == State.THINKING) 6f else 2.2f))
        scan += dt * (40f + energy * 160f) * alive
        chase += dt * (90f + energy * 420f + level * 300f) * alive
        orbSpin += dt * 12f * (0.25f + 0.75f * alive)

        val cx = width / 2f
        val cy = height / 2f
        val r = min(width, height) / 2f * 0.92f
        val small = r < 120f // the little reactor on the ask panel: no sparks, no orbs, no scanner
        val c = hue
        val dim = state == State.OFFLINE && online
        val cold = 1f - alive  // how far towards the still
        val coilsLit = when (power) { Power.CHARGING -> chargeK; Power.ONLINE -> 1f; else -> alive }

        // The wake's shockwave: a ring rolling out across the sheet
        if (shock >= 0f && !small) {
            softGlow.color = white; softGlow.alpha = (160 * (1f - shock / 2.6f)).toInt().coerceIn(0, 255); softGlow.strokeWidth = r * 0.06f
            canvas.drawCircle(cx, cy, r * (0.3f + shock), softGlow)
        }

        // Outer tick ring with the scanner: a bright wedge sweeping round, ticks ahead of it lit
        stroke.strokeWidth = r * 0.01f
        for (i in 0 until 90) {
            val deg = i * 4f
            val a = Math.toRadians(deg.toDouble())
            val behind = ((scan - deg) % 360f + 360f) % 360f // how far past this tick the scanner is
            val lit = if (small) 0f else (1f - behind / 70f).coerceIn(0f, 1f) * alive
            val inner = if (i % 9 == 0) r * 0.9f else r * 0.945f
            stroke.color = c; stroke.alpha = (45 * (0.5f + 0.5f * alive) + 20 * cold + lit * 190).toInt().coerceAtMost(255)
            canvas.drawLine(cx + cos(a).toFloat() * inner, cy + sin(a).toFloat() * inner, cx + cos(a).toFloat() * r, cy + sin(a).toFloat() * r, stroke)
        }
        if (!small && alive > 0.05f) { // the scanner's glow trail
            softGlow.color = c; softGlow.alpha = ((60 + energy * 90) * alive).toInt(); softGlow.strokeWidth = r * 0.05f
            arc.set(cx - r * 0.95f, cy - r * 0.95f, cx + r * 0.95f, cy + r * 0.95f)
            canvas.drawArc(arc, scan - 40f, 40f, false, softGlow)
        }

        // Segmented rings turning against each other (each on its own inertia while winding down)
        stroke.pathEffect = null
        for ((i, ring) in rings.withIndex()) {
            val rad = r * ring.rad
            val circ = (2 * PI * rad).toFloat()
            val eff = dashes.getOrPut(ring) { DashPathEffect(floatArrayOf(circ * ring.on / 360f, circ * ring.off / 360f), 0f) }
            stroke.pathEffect = eff
            stroke.strokeWidth = r * ring.width
            stroke.color = c; stroke.alpha = if (dim) ring.alpha / 2 else (ring.alpha * (0.7f + energy * 0.3f) * (0.55f + 0.45f * alive)).toInt()
            arc.set(cx - rad, cy - rad, cx + rad, cy + rad)
            canvas.save()
            canvas.rotate(ringAngle[i], cx, cy)
            canvas.drawArc(arc, 0f, 360f, false, stroke)
            canvas.restore()
        }
        stroke.pathEffect = null

        // The waveform ring: her voice (or yours) ripples it
        val wr = r * 0.47f
        val follow = ringK.value
        if (online && (level > 0.02f || energy > 0.05f || follow > 0.02f)) {
            wave.reset()
            val amp = wr * (0.02f + level * (0.1f + 0.12f * follow) + energy * 0.015f + follow * 0.015f)
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

        // Coils around the core, lit in a chase (while charging: one per 10%, going out one by one on the way down)
        val coils = 10
        val open = coilOpen.value
        val coilR = r * (0.4f + 0.09f * open) // listening: the coils spread outward from the core
        for (i in 0 until coils) {
            val deg = i * 360f / coils
            val a = Math.toRadians(deg.toDouble())
            val d = ((chase - deg) % 360f + 360f) % 360f
            val on = if (power == Power.CHARGING) (if (i < (coilsLit * coils).toInt()) 1f else 0f) else (if (i < (coilsLit * coils + 0.999f).toInt()) 1f else 0f)
            val lit = (1f - d / 110f).coerceIn(0f, 1f) * alive
            stroke.strokeWidth = r * 0.045f; stroke.color = c
            stroke.alpha = (30 + 20 * on + lit * 200 * (0.4f + energy * 0.6f + level * 0.5f) + (if (power == Power.CHARGING) on * 120 else 0f)).toInt().coerceAtMost(255)
            val half = r * (0.035f + 0.02f * open)
            val x1 = cx + cos(a).toFloat() * (coilR - half); val y1 = cy + sin(a).toFloat() * (coilR - half)
            val x2 = cx + cos(a).toFloat() * (coilR + half); val y2 = cy + sin(a).toFloat() * (coilR + half)
            canvas.drawLine(x1, y1, x2, y2, stroke)
        }

        // Core: breathes at rest (slowly in standby), swells with the voice, flares while thinking, flickers faster as the charge builds
        val breathe = (sin(t * (if (power == Power.STANDBY) 0.6f else 1.4f)) + 1f) * (if (power == Power.STANDBY) 0.03f else 0.025f) * (if (power == Power.ASLEEP) 0f else 1f)
        val flicker = when {
            state == State.THINKING && online -> (sin(t * 23f) * 0.5f + sin(t * 37f) * 0.5f) * 0.02f
            power == Power.CHARGING -> (sin(t * (10f + 40f * chargeK)) * 0.5f + sin(t * 31f * (0.5f + chargeK)) * 0.5f) * 0.015f * chargeK
            else -> 0f
        }
        val held = if (power == Power.CHARGING && chargeK >= 0.995f) -0.03f else 0f // the held breath before the bloom
        val pulse = beat.value
        val core = r * (0.24f + breathe + level * 0.13f + energy * 0.03f + flicker + held + bloom * 0.12f + pulse * 0.05f) * (if (power == Power.ASLEEP) 0.9f else 1f) * coreK.value
        glow.color = if (bloom > 0f) mix(c, white, bloom) else c
        glow.alpha = ((70 + energy * 90 + level * 120 + pulse * 70) * (0.45f + 0.55f * alive) + bloom * 150).toInt().coerceAtMost(255)
        canvas.drawCircle(cx, cy, core * (1.35f + bloom * 0.8f), glow)
        if (coreShader == null || coreColor != c) {
            coreColor = c
            coreShader = RadialGradient(0f, 0f, 1f, intArrayOf(Color.WHITE, c, Color.argb(0, Color.red(c), Color.green(c), Color.blue(c))), floatArrayOf(0f, 0.42f, 1f), Shader.TileMode.CLAMP)
        }
        coreMatrix.setScale(core, core)
        coreMatrix.postTranslate(cx, cy)
        coreShader!!.setLocalMatrix(coreMatrix)
        fill.shader = coreShader
        fill.alpha = if (dim) 150 else (255 * (0.6f + 0.4f * alive) + (if (power == Power.ASLEEP) -60f else 0f)).toInt().coerceIn(0, 255)
        canvas.drawCircle(cx, cy, core, fill)
        fill.shader = null
        if (bloom > 0f) { fill.color = white; fill.alpha = (200 * bloom).toInt(); canvas.drawCircle(cx, cy, core * (1f + (1f - bloom) * 1.2f), fill); fill.alpha = 255 }

        if (!small) {
            // Streams pulled into the core while charging (denser as the charge builds)
            if (power == Power.CHARGING) {
                streamSpawn += dt * (6f + 40f * chargeK)
                while (streamSpawn >= 1f) { streamSpawn -= 1f; streams += Stream(rnd.nextFloat() * 2f * PI.toFloat(), 1.5f + rnd.nextFloat() * 1.1f, 0.9f + rnd.nextFloat() * 0.8f, 0.5f + rnd.nextFloat() * 0.5f) }
                while (streams.size > 120) streams.removeAt(0)
            }
            stroke.strokeWidth = r * 0.008f
            val it0 = streams.iterator()
            while (it0.hasNext()) {
                val s = it0.next()
                s.rr -= dt * s.sp * (0.6f + s.rr * 0.5f)
                s.a += dt * 1.6f / max(0.2f, s.rr)
                if (s.rr <= 0.26f) { it0.remove(); continue }
                val x = cx + cos(s.a) * r * s.rr; val y = cy + sin(s.a) * r * s.rr
                val tail = 0.09f
                val x2 = cx + cos(s.a - tail / max(0.3f, s.rr)) * r * (s.rr + tail); val y2 = cy + sin(s.a - tail / max(0.3f, s.rr)) * r * (s.rr + tail)
                stroke.color = c; stroke.alpha = (200 * s.w * (1f - (s.rr - 0.26f) / 2.4f).coerceIn(0.15f, 1f)).toInt()
                canvas.drawLine(x, y, x2, y2, stroke)
            }

            // Sparks: a trickle at rest, a stream while she works or speaks (none while cold)
            spawn += dt * (2f + energy * 22f + level * 30f) * alive
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

            // Job orbs circling outside the ring (dimmed while standing by)
            for ((angle, waiting) in orbs) {
                val a = Math.toRadians((angle + orbSpin).toDouble())
                val ox = cx + cos(a).toFloat() * r * 1.0f; val oy = cy + sin(a).toFloat() * r * 1.0f
                val oc = if (waiting) amber else c
                glow.color = oc; glow.alpha = (120 * (0.4f + 0.6f * alive)).toInt()
                canvas.drawCircle(ox, oy, r * 0.03f, glow)
                fill.color = oc; fill.alpha = (255 * (0.5f + 0.5f * alive)).toInt()
                canvas.drawCircle(ox, oy, r * 0.022f, fill)
            }
            fill.alpha = 255

            // The charge ring while waking (segmented, filling with the real steps), and the hold ring while you hold
            if (power == Power.CHARGING) {
                stroke.strokeWidth = r * 0.025f; stroke.pathEffect = null
                arc.set(cx - r * 1.05f, cy - r * 1.05f, cx + r * 1.05f, cy + r * 1.05f)
                for (i in 0 until 24) {
                    val on = i < (chargeK * 24f).toInt() || (i == (chargeK * 24f).toInt() && chargeK * 24f - i > 0.5f)
                    stroke.color = if (on) mix(gold, white, chargeK) else gold; stroke.alpha = if (on) 230 else 50
                    canvas.drawArc(arc, -90f + i * 15f + 1.5f, 12f, false, stroke)
                }
            }
            if (holdK > 0f) {
                stroke.strokeWidth = r * 0.03f; stroke.pathEffect = null
                arc.set(cx - r * 1.05f, cy - r * 1.05f, cx + r * 1.05f, cy + r * 1.05f)
                stroke.color = holdColor; stroke.alpha = 60
                canvas.drawArc(arc, 0f, 360f, false, stroke)
                softGlow.color = holdColor; softGlow.alpha = 120; softGlow.strokeWidth = r * 0.05f
                canvas.drawArc(arc, -90f, 360f * holdK, false, softGlow)
                stroke.alpha = 240
                canvas.drawArc(arc, -90f, 360f * holdK, false, stroke)
            }
        }

        // A dead-still grey needs no redraws beyond the first; with the system's animations off she's still unless something's happening
        val dead = power == Power.ASLEEP && alive == 0f && sparks.isEmpty() && holdK == 0f && abs(Color.red(hue) - Color.red(target)) < 2
        val quiet = still || (!Motion.enabled && !isHot)
        if (isShown && !quiet && !dead) pace()
    }

    private val arr: Boolean by lazy { android.os.Build.VERSION.SDK_INT >= 35 && runCatching { display?.hasArrSupport() == true }.getOrDefault(false) }
    /** The next frame: the panel's full rate while hot, ~30 fps idle (adaptive refresh votes where the panel supports them, else a plain throttle). */
    private fun pace() {
        val hot = isHot
        if (arr) {
            requestedFrameRate = if (hot) REQUESTED_FRAME_RATE_CATEGORY_HIGH else (if (maxFps in 1..59) maxFps.toFloat() else REQUESTED_FRAME_RATE_CATEGORY_NORMAL)
            postInvalidateOnAnimation()
        } else nextFrame(if (hot) 0 else maxFps)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        last = 0L
        if (visibility == VISIBLE) invalidate()
    }
}

/** The next frame: on the next vsync, or after 1/fps s when a view is held to a lower rate (a delayed invalidate on a hidden window draws nothing, so the loop stops by itself). */
internal fun View.nextFrame(fps: Int) = if (fps in 1..59) postInvalidateDelayed(1000L / fps) else postInvalidateOnAnimation()
