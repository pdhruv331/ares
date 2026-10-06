package com.dhruv.ares

import android.content.Context
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager

/**
 * The phone's haptics for the power gestures (docs/ignition-prompt.md §4e). The transitions feel like the orb looks (the mockup
 * "ARES Phone Feel", 2026-10-06): the WAKE is "siphon" (fine ticks for the streams pulled into the core, thickening with the real
 * charge, then the bloom), STANDBY and POWER DOWN are "turbine" (the rings winding down, a thud at the end).
 * Built from the vibrator's tuned PRIMITIVES (click, thud, spin, rises and falls, ticks) where the phone has them: amplitude waveforms
 * feel mushy on a Galaxy, the primitives are crisp. Without them, a waveform of firm pulses stands in.
 * The ticks carry USAGE_TOUCH (the system's touch-feedback rule), the transitions USAGE_MEDIA (they go with the sound).
 */
object Haptics {
    private fun vib(c: Context) = c.getSystemService(VibratorManager::class.java)?.defaultVibrator
    private val touch = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH)
    private val media = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_MEDIA)
    private fun play(c: Context, e: VibrationEffect, attrs: VibrationAttributes = touch) { runCatching { vib(c)?.takeIf { it.hasVibrator() }?.vibrate(e, attrs) } }
    private fun primitives(c: Context, vararg ids: Int) = vib(c)?.areAllPrimitivesSupported(*ids) == true

    private const val CLICK = VibrationEffect.Composition.PRIMITIVE_CLICK
    private const val THUD = VibrationEffect.Composition.PRIMITIVE_THUD
    private const val SPIN = VibrationEffect.Composition.PRIMITIVE_SPIN
    private const val QUICK_RISE = VibrationEffect.Composition.PRIMITIVE_QUICK_RISE
    private const val SLOW_RISE = VibrationEffect.Composition.PRIMITIVE_SLOW_RISE
    private const val QUICK_FALL = VibrationEffect.Composition.PRIMITIVE_QUICK_FALL
    private const val TICK = VibrationEffect.Composition.PRIMITIVE_TICK
    private const val LOW_TICK = VibrationEffect.Composition.PRIMITIVE_LOW_TICK

    /** A light tick (each eighth of the hold ring, a slider detent, the spring-back). */
    fun tick(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
    /** A firmer tick (the last eighths of the hold ring). */
    fun click(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
    /** The commit: a heavy thunk. */
    fun heavy(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK))
    /** Standby committed on the Mac: one soft thunk. */
    fun soft(c: Context) = play(c, VibrationEffect.createOneShot(28, 120))
    /** Can't reach the Mac, or an error. */
    fun error(c: Context) = play(c, VibrationEffect.createWaveform(longArrayOf(0, 60, 50, 60, 50, 120), intArrayOf(0, 220, 0, 220, 0, 255), -1), media)

    /** The Mac's bloom: a rise into a thud, then a click (a double you can feel). */
    fun double(c: Context) {
        if (primitives(c, QUICK_RISE, THUD, CLICK)) play(c, VibrationEffect.startComposition().addPrimitive(QUICK_RISE, 1f).addPrimitive(THUD, 1f, 0).addPrimitive(CLICK, 1f, 90).compose(), media)
        else pattern(c, listOf(0L to 55, 110L to 75))
    }

    /** Pulses as (start ms, length ms) → one firm waveform (the fallback when the phone has no primitives). */
    fun pattern(c: Context, pulses: List<Pair<Long, Int>>) {
        val sorted = pulses.filter { it.second > 0 }.sortedBy { it.first }
        if (sorted.isEmpty()) return
        val timings = ArrayList<Long>(); val amps = ArrayList<Int>()
        var last = 0L
        for ((at, ms) in sorted) {
            timings += (at - last).coerceAtLeast(0); amps += 0
            timings += ms.toLong(); amps += (150 + (ms - 10) * 1.5f).toInt().coerceIn(150, 255)
            last = at + ms
        }
        play(c, VibrationEffect.createWaveform(timings.toLongArray(), amps.toIntArray(), -1), media)
    }
    private fun lerp(a: Float, b: Float, k: Float) = a + (b - a) * k.coerceIn(0f, 1f)

    /** TURBINE, winding down to cold over `T` ms: a click (the clunk), spins fading and spacing out as the rings slow, the thud. */
    fun turbineDown(c: Context, T: Long = 3900) {
        if (primitives(c, CLICK, SPIN, QUICK_FALL, THUD)) {
            val comp = VibrationEffect.startComposition().addPrimitive(CLICK, 1f)
            var t = 0f; var gap = 120f; var k = 0f
            while (t + gap < T - 400) { comp.addPrimitive(SPIN, lerp(1f, 0.25f, k), gap.toInt()); t += gap; k = t / T; gap = lerp(120f, 650f, k * k) }
            comp.addPrimitive(QUICK_FALL, 0.6f, 150).addPrimitive(THUD, 1f, (T - t - 150).toInt().coerceIn(0, 1500))
            play(c, comp.compose(), media); return
        }
        val p = ArrayList<Pair<Long, Int>>(); p += 0L to 55
        var t = 380f
        while (t < T - 150) { val k = t / T; p += t.toLong() to lerp(26f, 12f, k).toInt(); t += lerp(90f, 520f, k * k) }
        p += T to 85
        pattern(c, p)
    }
    /** TURBINE, to standby over `T` ms: a slow fall into lighter spins spacing out, a soft thud. */
    fun turbineStandby(c: Context, T: Long = 2500) {
        if (primitives(c, SPIN, QUICK_FALL, THUD)) {
            val comp = VibrationEffect.startComposition().addPrimitive(QUICK_FALL, 0.8f)
            var t = 0f; var gap = 140f; var k = 0f
            while (t + gap < T - 300) { comp.addPrimitive(SPIN, lerp(0.7f, 0.2f, k), gap.toInt()); t += gap; k = t / T; gap = lerp(140f, 600f, k * k) }
            comp.addPrimitive(THUD, 0.5f, (T - t).toInt().coerceIn(0, 1200))
            play(c, comp.compose(), media); return
        }
        val p = ArrayList<Pair<Long, Int>>()
        var t = 120f
        while (t < T - 200) { val k = t / T; p += t.toLong() to lerp(18f, 10f, k).toInt(); t += lerp(110f, 460f, k * k) }
        p += T to 38
        pattern(c, p)
    }
    /** Wake from standby: a slow rise that lands in a click and a thud. */
    fun turbineWake(c: Context) {
        if (primitives(c, SLOW_RISE, CLICK, THUD)) play(c, VibrationEffect.startComposition().addPrimitive(SLOW_RISE, 0.9f).addPrimitive(CLICK, 1f, 0).addPrimitive(THUD, 0.8f, 120).compose(), media)
        else pattern(c, listOf(0L to 12, 140L to 16, 250L to 22, 420L to 45, 530L to 60))
    }
    /** SIPHON: one start-up step done at charge `k` (0..1): a burst of ticks over ~500 ms, denser and firmer with the charge, a spin under it. */
    fun siphonStep(c: Context, k: Float) {
        var seed = (k * 1000).toInt() + 7
        val rnd = { seed = (seed * 16807) % 2147483647; seed / 2147483647f }
        if (primitives(c, LOW_TICK, TICK, SPIN)) {
            val comp = VibrationEffect.startComposition().addPrimitive(SPIN, lerp(0.3f, 1f, k))
            var t = 0f
            while (t < 500f) { val gap = lerp(140f, 40f, k) * (0.5f + rnd()); comp.addPrimitive(if (k < 0.5f) LOW_TICK else TICK, lerp(0.5f, 1f, k), gap.toInt()); t += gap }
            play(c, comp.compose(), media); return
        }
        val p = ArrayList<Pair<Long, Int>>()
        var t = 0f
        while (t < 500f) { p += t.toLong() to lerp(10f, 18f, k).toInt(); t += lerp(160f, 45f, k) * (0.5f + rnd()) }
        pattern(c, p)
    }
}
