package com.dhruv.ares

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool

/**
 * Quieter versions of the Mac's power sounds (the same WAVs, renderer/sounds, bundled by Gradle into res/raw), played only while
 * the app is in front and the phone isn't on silent or vibrate (docs/ignition-prompt.md §4e).
 */
class Sounds(private val ctx: Context) {
    private val pool = SoundPool.Builder().setMaxStreams(3)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()).build()
    private val ids = HashMap<String, Int>()
    private val streams = HashMap<String, Int>()
    private val loaded = HashSet<Int>()
    var inFront = false

    init {
        pool.setOnLoadCompleteListener { _, id, status -> if (status == 0) loaded += id }
        // R.raw constants, not a name lookup: the release build's resource shrinker keeps only what the code references
        val res = mapOf("tick" to R.raw.tick, "hold_rise" to R.raw.hold_rise, "clunk" to R.raw.clunk, "standby_down" to R.raw.standby_down, "wake_chime" to R.raw.wake_chime,
            "bloom" to R.raw.bloom, "winddown" to R.raw.winddown, "thud" to R.raw.thud, "nope" to R.raw.nope, "charge_hum" to R.raw.charge_hum)
        for ((name, id) in res) ids[name] = pool.load(ctx, id, 1)
    }
    private fun allowed(): Boolean = inFront && ctx.getSystemService(AudioManager::class.java).ringerMode == AudioManager.RINGER_MODE_NORMAL

    /** Play one (names as on the Mac: "hold-rise", "standby-down", …). `loop` keeps it going until stop(). */
    fun play(name: String, volume: Float = 0.35f, loop: Boolean = false) {
        val id = ids[name.replace('-', '_')] ?: return
        if (!allowed() || id !in loaded) return
        stop(name)
        streams[name] = pool.play(id, volume, volume, 1, if (loop) -1 else 0, 1f)
    }
    fun stop(name: String) { streams.remove(name.replace('-', '_'))?.let { pool.stop(it) } }
    fun release() = pool.release()
}
