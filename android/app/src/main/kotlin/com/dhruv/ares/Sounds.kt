package com.dhruv.ares

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool

/**
 * Three short sounds (≤ 150 ms) from the Mac's own set (renderer/sounds, copied in by Gradle): the listening open/close
 * clicks and a tick. Quiet, on the assistant stream, and only while ARES is in front (`front`); each pairs with a haptic
 * and a shape change in the same frame (docs/phone-ui-prompt.md §9). Off with the "Sounds" switch in the home menu.
 */
object Sounds {
    private var pool: SoundPool? = null
    private val ids = HashMap<String, Int>()
    private val loaded = HashSet<Int>()
    @Volatile var front = false

    private fun pool(c: Context): SoundPool = pool ?: SoundPool.Builder().setMaxStreams(2)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .build().also { p ->
            pool = p
            p.setOnLoadCompleteListener { _, id, status -> if (status == 0) loaded += id }
            val app = c.applicationContext
            ids["tick"] = p.load(app, R.raw.tick, 1)
            ids["on"] = p.load(app, R.raw.ptt_on, 1)
            ids["off"] = p.load(app, R.raw.ptt_off, 1)
        }

    fun enabled(c: Context) = Ares.prefs(c).getBoolean("sounds", true)
    fun warm(c: Context) { pool(c) }

    private fun play(c: Context, name: String, gain: Float) {
        if (!front || !enabled(c)) return
        val id = ids[name] ?: return
        if (id !in loaded) return
        pool(c).play(id, gain, gain, 1, 0, 1f)
    }
    fun tick(c: Context) = play(c, "tick", 0.25f)
    fun listenOn(c: Context) = play(c, "on", 0.35f)
    fun listenOff(c: Context) = play(c, "off", 0.35f)
}
