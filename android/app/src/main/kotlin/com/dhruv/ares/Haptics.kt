package com.dhruv.ares

import android.content.Context
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager

/**
 * The phone's haptics for the power gestures (docs/ignition-prompt.md §4e); quiet when the system's haptic feedback is off.
 * The transitions feel like the orb looks (chosen from the mockup "ARES Phone Feel", 2026-10-06): the WAKE is "siphon" (fine irregular
 * ticks for the streams pulled into the core, thickening with the real charge, then the bloom's double thunk); STANDBY and POWER DOWN
 * are "turbine" (pulses riding the rings as they wind down: closer at first, stretching out, a thud at the end).
 * Android has no strength control beyond amplitude, so a firmer tick is a longer one with a higher amplitude.
 * The ticks carry USAGE_TOUCH (they follow the system's touch-feedback setting); the transitions USAGE_MEDIA (they play like the sound
 * does). No reading of Settings.System.HAPTIC_FEEDBACK_ENABLED: Samsung keeps its own keys, and that check silenced everything.
 */
object Haptics {
    private fun vib(c: Context) = c.getSystemService(VibratorManager::class.java)?.defaultVibrator
    private val touch = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH)
    private val media = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_MEDIA)
    private fun play(c: Context, e: VibrationEffect, attrs: VibrationAttributes = touch) { runCatching { vib(c)?.takeIf { it.hasVibrator() }?.vibrate(e, attrs) } }

    /** A light tick (each eighth of the hold ring, a slider detent, the spring-back). */
    fun tick(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
    /** A firmer tick (the last eighths of the hold ring). */
    fun click(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
    /** The commit: a heavy thunk. */
    fun heavy(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK))
    /** The Mac's bloom: a double thunk. */
    fun double(c: Context) = pattern(c, listOf(0L to 55, 110L to 75))
    /** Standby committed on the Mac: one soft thunk. */
    fun soft(c: Context) = play(c, VibrationEffect.createOneShot(28, 120))
    /** Can't reach the Mac, or an error. */
    fun error(c: Context) = play(c, VibrationEffect.createWaveform(longArrayOf(0, 60, 50, 60, 50, 120), intArrayOf(0, 200, 0, 200, 0, 255), -1), media)

    /** Pulses as (start ms, length ms) → one waveform; amplitude follows the length (10 ms ≈ 90, 85 ms = 255). */
    fun pattern(c: Context, pulses: List<Pair<Long, Int>>) {
        val sorted = pulses.filter { it.second > 0 }.sortedBy { it.first }
        if (sorted.isEmpty()) return
        val timings = ArrayList<Long>(); val amps = ArrayList<Int>()
        var last = 0L
        for ((at, ms) in sorted) {
            timings += (at - last).coerceAtLeast(0); amps += 0
            timings += ms.toLong(); amps += (90 + (ms - 10) * 2.2f).toInt().coerceIn(60, 255)
            last = at + ms
        }
        play(c, VibrationEffect.createWaveform(timings.toLongArray(), amps.toIntArray(), -1), media)
    }
    private fun lerp(a: Float, b: Float, k: Float) = a + (b - a) * k.coerceIn(0f, 1f)

    /** TURBINE, winding down to cold over `T` ms: a clunk, pulses stretching out as the rings slow, the cold thud. */
    fun turbineDown(c: Context, T: Long = 3900) {
        val p = ArrayList<Pair<Long, Int>>(); p += 0L to 55
        var t = 380f
        while (t < T - 150) { val k = t / T; p += t.toLong() to lerp(22f, 10f, k).toInt(); t += lerp(90f, 520f, k * k) }
        p += T to 85
        pattern(c, p)
    }
    /** TURBINE, to standby over `T` ms: lighter pulses stretching out, a soft thunk at the end. */
    fun turbineStandby(c: Context, T: Long = 2500) {
        val p = ArrayList<Pair<Long, Int>>()
        var t = 120f
        while (t < T - 200) { val k = t / T; p += t.toLong() to lerp(16f, 8f, k).toInt(); t += lerp(110f, 460f, k * k) }
        p += T to 38
        pattern(c, p)
    }
    /** Wake from standby: a short rising cluster, then the double. */
    fun turbineWake(c: Context) = pattern(c, listOf(0L to 12, 140L to 16, 250L to 22, 420L to 45, 530L to 60))
    /** SIPHON: one start-up step done at charge `k` (0..1): a burst of fine irregular ticks over ~500 ms, denser and firmer with the charge. */
    fun siphonStep(c: Context, k: Float) {
        val p = ArrayList<Pair<Long, Int>>()
        var seed = (k * 1000).toInt() + 7
        val rnd = { seed = (seed * 16807) % 2147483647; seed / 2147483647f }
        var t = 0f
        val span = 500f
        while (t < span) { p += t.toLong() to lerp(8f, 16f, k).toInt(); t += lerp(160f, 45f, k) * (0.5f + rnd()) }
        pattern(c, p)
    }
}
