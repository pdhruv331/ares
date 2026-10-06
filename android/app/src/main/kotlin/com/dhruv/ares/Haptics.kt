package com.dhruv.ares

import android.content.Context
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager

/** The phone's few haptics for the power gestures: the hold ring's ticks and its commit, a soft thunk for standby, a double for the wake. */
object Haptics {
    private fun vib(c: Context) = c.getSystemService(VibratorManager::class.java)?.defaultVibrator
    private val touch = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH)
    private fun play(c: Context, e: VibrationEffect) { runCatching { vib(c)?.takeIf { it.hasVibrator() }?.vibrate(e, touch) } }

    fun tick(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
    fun click(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
    fun heavy(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK))
    fun double(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK))
    fun soft(c: Context) = play(c, VibrationEffect.createOneShot(28, 120))
    fun error(c: Context) = play(c, VibrationEffect.createWaveform(longArrayOf(0, 60, 50, 60, 50, 120), intArrayOf(0, 220, 0, 220, 0, 255), -1))
}
