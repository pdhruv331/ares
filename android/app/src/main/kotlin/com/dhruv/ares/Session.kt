package com.dhruv.ares

import android.content.Context
import android.content.Intent
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

enum class State { IDLE, LISTENING, THINKING, SPEAKING, OFFLINE }

/**
 * One conversation with ARES on this screen: listening (the phone's own speech recogniser), asking the
 * Mac, showing her reply as it streams and playing her voice. Callbacks arrive on the main thread.
 */
class Session(private val ctx: Context, private val ui: Ui) {
    interface Ui {
        fun state(s: State)
        fun heard(text: String, final: Boolean) {}
        fun reply(text: String, final: Boolean)
        fun action(url: String, label: String) {}
        fun notPaired() {}
        fun offline(message: String)
        fun attached() {} // the pending attachment went with the question
    }

    /** Extra context for the next question: something shared from another app, or your screen. */
    class Attachment(val note: String, val images: List<Pair<String, String>>, val files: List<AresClient.Upload> = emptyList(), val link: String? = null)

    /** Goes with the next question, spoken or typed, then clears. */
    var attachment: Attachment? = null
    /** Asked for at the moment of asking, if there's no attachment (your screen: it may still be arriving). */
    var provider: (() -> Attachment?)? = null
    /** Said "…as a job" with something attached (your screen, something shared): it goes to a worker on the Mac, files and all. */
    var jobStarter: ((said: String, extra: Attachment) -> Unit)? = null
    private val jobPhrase = Regex("\\b(as an? (background )?job|in the background|make (it|this|that) an? job)\\b", RegexOption.IGNORE_CASE)

    private val main = Handler(Looper.getMainLooper())
    private val client = AresClient(ctx)
    @Volatile var level = 0f // 0..1, for the reactor: her voice, or your voice while listening
        private set
    var state = State.IDLE
        private set
    var busy = false
        private set
    private val speaker = Speaker(ctx,
        onSpeaking = { on -> main.post { if (on) set(State.SPEAKING) else if (!busy && state == State.SPEAKING) set(State.IDLE) } },
        onLevel = { level = it })
    private var recognizer: SpeechRecognizer? = null
    private var recorder: MediaRecorder? = null
    private var recording: File? = null
    private var heard = ""
    private var cancel = AtomicBoolean()

    private fun set(s: State) { state = s; ui.state(s) }

    /** Ask ARES something. `voice`: she answers out loud too (when you spoke to her). */
    fun ask(said: String, voice: Boolean) {
        if (said.isBlank() || busy) return
        busy = true
        val extra = attachment ?: provider?.invoke()
        attachment = null
        provider = null
        if (extra != null) ui.attached()
        val starter = jobStarter
        if (extra != null && starter != null && jobPhrase.containsMatchIn(said)) { busy = false; return starter(said, extra) }
        val text = if (extra != null) "$said\n\n${extra.note}" else said
        val images = extra?.images.orEmpty()
        speaker.stop()
        set(State.THINKING)
        val mine = AtomicBoolean().also { cancel = it }
        Ares.saveLast(ctx, said, null)
        thread(name = "ares-ask") {
            try {
                client.ask(text, voice, images, mine, AresClient.Listener(
                    text = { t -> main.post { if (!mine.get()) ui.reply(t, false) } },
                    audio = { pcm -> if (!mine.get()) speaker.play(pcm) },
                    action = { url, label -> main.post { if (!mine.get()) ui.action(url, label) } },
                    done = { t -> Ares.saveLast(ctx, null, t); main.post { if (!mine.get()) ui.reply(t, true) } },
                ))
                Ares.setStatus(ctx, "online")
            } catch (e: NotPairedException) {
                main.post { ui.notPaired() }
            } catch (e: Exception) {
                Ares.setStatus(ctx, "offline")
                main.post { ui.offline("I can't reach the Mac right now, sir. Is it awake, and is Tailscale on?") }
            } finally {
                main.post {
                    busy = false
                    if (state == State.THINKING) set(if (Ares.status(ctx) == "offline") State.OFFLINE else State.IDLE)
                }
            }
        }
    }

    // ---- Listening ---------------------------------------------------------------------------------

    val listening get() = recognizer != null || recorder != null

    fun toggleListening() = if (listening) stopListening() else startListening()

    fun startListening() {
        if (listening) return
        speaker.stop() // talking over her stops her, like on the Mac
        heard = ""
        stopAsked = false
        // First the phone's own default recogniser (as the Galaxy is set up), then each one explicitly
        candidates = listOf<android.content.ComponentName?>(null) + Speech.components(ctx)
        attempt = 0
        english = true
        next()
    }

    // If a recogniser fails, try again without the language, then the phone's next recogniser, and
    // finally record and let the Mac transcribe it: listening should never just give up.
    private var candidates = emptyList<android.content.ComponentName?>()
    private var attempt = 0
    private var english = true
    private var failures = mutableListOf<Int>()
    private var stopAsked = false // you tapped to finish: an error then isn't a reason to retry

    private fun next() {
        if (attempt == 0) failures.clear()
        if (attempt >= candidates.size) return recordForMac()
        val c = candidates[attempt]
        val r = runCatching { if (c == null) SpeechRecognizer.createSpeechRecognizer(ctx) else SpeechRecognizer.createSpeechRecognizer(ctx, c) }.getOrNull()
            ?: return retry(SpeechRecognizer.ERROR_CLIENT)
        listenOnPhone(r)
    }

    private fun retry(error: Int) {
        failures += error
        val language = error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
        if (language && english) english = false else { attempt++; english = true }
        set(State.LISTENING)
        main.postDelayed({ if (recognizer == null && recorder == null && state == State.LISTENING) next() }, 350)
    }

    /** Finish now and send what was heard (the recogniser also stops by itself when you pause). */
    fun stopListening() {
        stopAsked = true
        recognizer?.stopListening()
        recorder?.let { finishRecording() }
    }

    fun cancelListening() {
        recognizer?.destroy(); recognizer = null
        recorder?.let { runCatching { it.stop() }; it.release() }; recorder = null
        if (state == State.LISTENING) set(State.IDLE)
    }

    private fun listenOnPhone(r: SpeechRecognizer) {
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { started = true; set(State.LISTENING) }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) { level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { level = 0f }
            override fun onPartialResults(partial: Bundle?) {
                best(partial)?.let { heard = it; ui.heard(it, false) }
            }
            override fun onResults(results: Bundle?) {
                val text = best(results) ?: heard
                done()
                if (text.isNotBlank()) { ui.heard(text, true); ask(text, voice = true) } else set(State.IDLE)
            }
            override fun onError(error: Int) {
                done()
                val soft = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                if (heard.isNotBlank()) { ui.heard(heard, true); ask(heard, voice = true) }
                else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) { set(State.IDLE); ui.offline("I need microphone access on the phone, sir.") }
                else if ((soft && started) || stopAsked) set(State.IDLE) // you didn't say anything
                else retry(error) // the recogniser itself failed: try another way
            }
            private var started = false
            override fun onEvent(eventType: Int, params: Bundle?) {}
            private fun best(b: Bundle?) = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }
            private fun done() { level = 0f; r.destroy(); if (recognizer === r) recognizer = null }
        })
        set(State.LISTENING)
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .apply { if (english) putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-GB") }
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1400L))
    }

    /** No speech recogniser on the phone: record, and let the Mac transcribe it. */
    private fun recordForMac() {
        val file = File(ctx.cacheDir, "ask.m4a")
        try {
            recorder = MediaRecorder(ctx).apply {
                setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(16_000)
                setOutputFile(file)
                prepare()
                start()
            }
            recording = file
            set(State.LISTENING)
            watchSilence()
        } catch (e: Exception) {
            recorder = null
            ui.offline("I need microphone access on the phone, sir.")
        }
    }

    /** Stop recording by itself once you've spoken and paused, like the phone's recogniser does. */
    private fun watchSilence() {
        val r = recorder ?: return
        val start = System.currentTimeMillis()
        var spoke = false
        var quietSince = 0L
        val tick = object : Runnable {
            override fun run() {
                if (recorder !== r) return
                val now = System.currentTimeMillis()
                val amp = runCatching { r.maxAmplitude }.getOrDefault(0)
                level = (amp / 12000f).coerceIn(0f, 1f)
                if (amp > 1800) { spoke = true; quietSince = 0L }
                else if (spoke && quietSince == 0L) quietSince = now
                when {
                    spoke && quietSince > 0 && now - quietSince > 1500 -> finishRecording()
                    !spoke && now - start > 8000 -> { cancelListening(); ui.heard("(I didn't hear anything)", true) }
                    now - start > 30_000 -> finishRecording()
                    else -> main.postDelayed(this, 100)
                }
            }
        }
        main.postDelayed(tick, 300)
    }

    private fun finishRecording() {
        val r = recorder ?: return
        recorder = null
        runCatching { r.stop() }
        r.release()
        val file = recording ?: return
        set(State.THINKING)
        thread {
            val text = try { client.stt(file.readBytes(), "audio/mp4") } catch (e: IOException) { "" }
            main.post {
                if (text.isNotBlank()) { ui.heard(text, true); ask(text, voice = true); return@post }
                set(State.IDLE)
                ui.heard("(I didn't catch that${if (failures.isNotEmpty()) " · codes ${failures.joinToString(",")}" else ""})", true)
            }
        }
    }

    /** Stop her talking (a tap on the reactor, or the screen closing). */
    fun hush() = speaker.stop()

    fun release() {
        cancelListening()
        cancel.set(true)
        speaker.release()
    }
}
