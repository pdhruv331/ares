package com.dhruv.ares

import android.content.Context
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.View

/**
 * The phone's haptic vocabulary (docs/phone-ui-prompt.md §9): crisp, discrete, tied to something that happened, never a
 * buzz. Built from the vibrator's primitives where it has them (≥ 50 ms between primitives, intensity steps ≥ 1.4×), with
 * the predefined effects (or a view's HapticFeedbackConstants) as the fallback.
 *
 *   listening starts   PRIMITIVE_CLICK, the same frame the coils open   → [listen]
 *   hold progress      LOW_TICK each eighth                              → [tick]
 *   commit             THUD (a heavy click)                              → [commit] / [heavy]
 *   answer arrives     one soft tick as the card lands                   → [land]
 *   needs approval     two ticks 80 ms apart                             → [approval]
 *   card docks / drop  a tick when the spring SETTLES                    → [settle]
 *   error              a low two-primitive composition                   → [error]
 */
object Haptics {
    private fun vib(c: Context): Vibrator? = c.getSystemService(VibratorManager::class.java)?.defaultVibrator?.takeIf { it.hasVibrator() }
    private val touch = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH)
    private fun play(c: Context, e: VibrationEffect) { runCatching { vib(c)?.vibrate(e, touch) } }
    private fun primitives(c: Context, vararg ids: Int) = vib(c)?.areAllPrimitivesSupported(*ids) == true

    /** A composition of primitives, or `fallback` where the phone can't do them. */
    private fun compose(c: Context, fallback: VibrationEffect, vararg steps: Triple<Int, Float, Int>) {
        if (!primitives(c, *steps.map { it.first }.toIntArray())) return play(c, fallback)
        val comp = VibrationEffect.startComposition()
        for ((id, scale, delay) in steps) comp.addPrimitive(id, scale, delay)
        play(c, comp.compose())
    }

    fun tick(c: Context) = compose(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK), Triple(VibrationEffect.Composition.PRIMITIVE_LOW_TICK, 0.6f, 0))
    fun click(c: Context) = compose(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK), Triple(VibrationEffect.Composition.PRIMITIVE_CLICK, 0.8f, 0))
    fun heavy(c: Context) = compose(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK), Triple(VibrationEffect.Composition.PRIMITIVE_THUD, 1f, 0))
    fun double(c: Context) = compose(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK),
        Triple(VibrationEffect.Composition.PRIMITIVE_CLICK, 0.7f, 0), Triple(VibrationEffect.Composition.PRIMITIVE_CLICK, 1f, 70))
    fun soft(c: Context) = compose(c, VibrationEffect.createOneShot(28, 120), Triple(VibrationEffect.Composition.PRIMITIVE_LOW_TICK, 0.4f, 0))

    /** Listening starts: a single crisp click. */
    fun listen(c: Context) = click(c)
    /** The hold committed. */
    fun commit(c: Context) = heavy(c)
    /** An answer landed as a card: one soft tick. */
    fun land(c: Context) = compose(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK), Triple(VibrationEffect.Composition.PRIMITIVE_TICK, 0.5f, 0))
    /** Something needs the owner: two ticks 80 ms apart. */
    fun approval(c: Context) = compose(c, VibrationEffect.createWaveform(longArrayOf(0, 20, 60, 20), intArrayOf(0, 160, 0, 160), -1),
        Triple(VibrationEffect.Composition.PRIMITIVE_TICK, 0.7f, 0), Triple(VibrationEffect.Composition.PRIMITIVE_TICK, 1f, 80))
    /** A spring settled (a card docked, a drop landed). */
    fun settle(c: Context) = compose(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK), Triple(VibrationEffect.Composition.PRIMITIVE_TICK, 0.6f, 0))
    /** Something didn't work: low and short, two primitives, never a buzz. */
    fun error(c: Context) = compose(c, VibrationEffect.createWaveform(longArrayOf(0, 30, 70, 45), intArrayOf(0, 110, 0, 150), -1),
        Triple(VibrationEffect.Composition.PRIMITIVE_LOW_TICK, 0.5f, 0), Triple(VibrationEffect.Composition.PRIMITIVE_THUD, 0.45f, 70))

    /** The view-based fallback where there's a view to hand (TalkBack-aware, follows the system's haptic setting). */
    fun view(v: View, kind: Int = HapticFeedbackConstants.CONTEXT_CLICK) { v.performHapticFeedback(kind) }
}
