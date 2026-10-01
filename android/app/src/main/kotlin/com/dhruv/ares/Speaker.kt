package com.dhruv.ares

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Plays ARES's voice: raw 24kHz 16-bit mono PCM, streamed a chunk at a time, gapless. Music ducks
 * while she speaks. `onSpeaking` and `onLevel` are called from the audio thread.
 */
class Speaker(ctx: Context, private val onSpeaking: (Boolean) -> Unit = {}, private val onLevel: (Float) -> Unit = {}) {
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
    // Made when she first speaks, not up front: just after the phone starts, the audio system may not be
    // ready yet, and that must never stop ARES from opening. If it fails, the next sentence tries again.
    private var created: AudioTrack? = null
    private fun track(): AudioTrack? = created ?: runCatching {
        AudioTrack.Builder()
            .setAudioAttributes(attrs)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(24_000).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(AudioTrack.getMinBufferSize(24_000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT) * 4)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }.getOrNull().also { created = it }
    private val queue = LinkedBlockingQueue<ByteArray>()
    @Volatile private var stopping = false
    @Volatile private var alive = true
    @Volatile var speaking = false
        private set
    private var written = 0L // frames written since the last reset

    init {
        thread(name = "ares-voice", isDaemon = true) {
            while (alive) {
                val chunk = queue.poll(80, TimeUnit.MILLISECONDS)
                if (stopping) { reset(); continue }
                val track = if (chunk != null) track() else created
                if (chunk != null) {
                    if (track == null) continue // no audio output right now: skip this bit of her voice
                    if (!speaking) setSpeaking(true)
                    if (runCatching { track.play(); track.write(chunk, 0, chunk.size) }.isFailure) { created = null; runCatching { track.release() }; continue }
                    written += chunk.size / 2
                    onLevel(level(chunk))
                    if (stopping) reset()
                } else if (speaking && track != null && (track.playbackHeadPosition.toLong() and 0xffffffffL) >= written) {
                    reset()
                }
            }
            created?.release()
        }
    }

    fun play(pcm: ByteArray) { if (pcm.size >= 2) queue.offer(pcm) }

    /** Stop talking now (the user interrupted, or the screen closed). */
    fun stop() {
        queue.clear()
        stopping = true
        runCatching { created?.pause() } // releases a blocked write straight away
    }

    fun release() { stop(); alive = false }

    private fun reset() {
        queue.clear()
        runCatching { created?.pause(); created?.flush() }
        written = 0
        stopping = false
        if (speaking) setSpeaking(false)
        onLevel(0f)
    }

    private fun setSpeaking(on: Boolean) {
        speaking = on
        if (on) audio.requestAudioFocus(focus) else audio.abandonAudioFocusRequest(focus)
        onSpeaking(on)
    }

    private fun level(pcm: ByteArray): Float {
        var sum = 0.0
        var i = 0
        while (i + 1 < pcm.size) {
            val s = ((pcm[i].toInt() and 0xff) or (pcm[i + 1].toInt() shl 8)).toShort() / 32768.0
            sum += s * s
            i += 2
        }
        return (sqrt(sum / (pcm.size / 2)) * 3.2).toFloat().coerceIn(0f, 1f)
    }
}
