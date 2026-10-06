package com.dhruv.ares

import android.content.Context
import android.os.VibrationEffect
import android.os.VibratorManager
import android.provider.Settings

/** The phone's haptics for the power gestures (docs/ignition-prompt.md §4e); quiet when the system's haptic feedback is off. */
object Haptics {
    private fun vib(c: Context) = c.getSystemService(VibratorManager::class.java)?.defaultVibrator
    private fun allowed(c: Context) = Settings.System.getInt(c.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0
    private fun play(c: Context, e: VibrationEffect) { if (allowed(c)) runCatching { vib(c)?.vibrate(e) } }

    /** A light tick (each eighth of the hold ring, a slider detent, the spring-back). */
    fun tick(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
    /** A firmer tick (the last eighths of the hold ring). */
    fun click(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
    /** The commit: a heavy thunk. */
    fun heavy(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK))
    /** The Mac's bloom: a double tap. */
    fun double(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK))
    /** Standby committed on the Mac: one soft thunk. */
    fun soft(c: Context) = play(c, VibrationEffect.createOneShot(28, 120))
    /** Can't reach the Mac, or an error. */
    fun error(c: Context) = play(c, VibrationEffect.createWaveform(longArrayOf(0, 60, 50, 60, 50, 120), intArrayOf(0, 200, 0, 200, 0, 255), -1))
}
