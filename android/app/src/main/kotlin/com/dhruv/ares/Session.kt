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
        fun handsFree(on: Boolean, why: String) {} // hands-free conversation switched on or off
        fun caption(text: String) {} // what to show over the reactor right now (her sentence as she says it, your words as you say them)
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
        onSpeaking = { on -> main.post { if (on) set(State.SPEAKING) else if (!busy && state == State.SPEAKING) { set(State.IDLE); relisten() } } },
        onLevel = { level = it },
        onClip = { n -> main.post { captionClip(n) } })

    // ---- Captions ---------------------------------------------------------------------------------------------------
    // The Mac speaks her reply one sentence per audio clip, split exactly like `segments` below. When clip n starts
    // playing, sentence n goes on screen; a sentence too long for two lines is shown clause by clause, paced by its
    // words. Typed replies (no voice) are paged the same way. Nothing is ever cut short.
    private var replyText = ""
    private var voiceTurn = false
    private val captionQueue = ArrayList<Runnable>()
    private val MAX_CAPTION = 96 // about two lines at the caption's size

    /** The Mac's sentence split (phoneAsk in main.js): the same boundaries, so clip n is sentence n. */
    private fun segments(text: String, final: Boolean): List<String> {
        val out = ArrayList<String>()
        var consumed = 0
        for (m in Regex("[.!?…]+[\"')\\]]*\\s+").findAll(text)) {
            val end = m.range.last + 1
            if (text.substring(consumed, end).trim().length < 6) continue
            out += text.substring(consumed, end).trim()
            consumed = end
        }
        if (final && text.length > consumed && text.substring(consumed).isNotBlank()) out += text.substring(consumed).trim()
        else if (!final && text.length > consumed) out += text.substring(consumed).trim() // the sentence still arriving
        return out.filter { it.isNotBlank() }
    }

    /** Break a long sentence at clauses (commas, colons, dashes), then at words, into pieces that fit two lines. */
    private fun clauses(s: String): List<String> {
        if (s.length <= MAX_CAPTION) return listOf(s)
        val out = ArrayList<String>()
        var cur = StringBuilder()
        for (piece in s.split(Regex("(?<=[,;:—–])\\s+"))) {
            if (cur.isNotEmpty() && cur.length + 1 + piece.length > MAX_CAPTION) { out += cur.toString(); cur = StringBuilder() }
            if (piece.length > MAX_CAPTION) { // one clause still too long: by words
                for (w in piece.split(' ')) {
                    if (cur.isNotEmpty() && cur.length + 1 + w.length > MAX_CAPTION) { out += cur.toString(); cur = StringBuilder() }
                    if (cur.isNotEmpty()) cur.append(' ')
                    cur.append(w)
                }
            } else { if (cur.isNotEmpty()) cur.append(' '); cur.append(piece) }
        }
        if (cur.isNotEmpty()) out += cur.toString()
        return out
    }

    private fun clearCaptions() { for (r in captionQueue) main.removeCallbacks(r); captionQueue.clear() }

    /** Show a sentence: its clauses one after another, each for as long as its words take to say. */
    private fun showSentence(s: String, secondsPerWord: Double = 0.36) {
        clearCaptions()
        var at = 0L
        for (c in clauses(s)) {
            val r = Runnable { ui.caption(c) }
            captionQueue += r
            main.postDelayed(r, at)
            at += (c.split(' ').size * secondsPerWord * 1000).toLong().coerceAtLeast(900)
        }
    }

    private fun captionClip(n: Int) {
        if (n < 0) return
        val segs = segments(replyText, final = !busy)
        segs.getOrNull(n)?.let { showSentence(it) }
    }

    // ---- Hands-free conversation: she listens again by herself after each answer ----------------------------------
    // On until you say "that's all" (or similar), switch it off, leave the screen, or say nothing for a few minutes.
    var handsFree = false
        private set
    private var lastSpokeAt = 0L
    private val HANDS_FREE_IDLE_MS = 3 * 60_000L
    private val handsFreeOn = Regex("^(hands[- ]?free( mode)?( on)?|keep listening|stay listening|conversation mode( on)?|let'?s talk)[.!]?$", RegexOption.IGNORE_CASE)
    private val handsFreeOff = Regex("^(that'?s (all|it)( for now)?|go to sleep|stop listening|hands[- ]?free( mode)? off|we'?re done|i'?m done|(good)?bye( for now)?|good ?night|dismissed)[.!]?$", RegexOption.IGNORE_CASE)

    fun setHandsFree(on: Boolean, why: String = "") {
        if (handsFree == on) return
        handsFree = on
        lastSpokeAt = System.currentTimeMillis()
        ui.handsFree(on, why)
        if (on) relisten() else if (listening && !busy) cancelListening()
    }

    /** After she's answered (or heard nothing): listen again, once her voice has stopped. */
    private fun relisten() {
        if (!handsFree) return
        main.postDelayed({
            if (handsFree && !listening && !busy && !speaker.speaking && state != State.THINKING) startListening()
        }, 450)
    }
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
        clearCaptions()
        replyText = ""
        voiceTurn = voice
        set(State.THINKING)
        val mine = AtomicBoolean().also { cancel = it }
        Ares.saveLast(ctx, said, null)
        thread(name = "ares-ask") {
            try {
                client.ask(text, voice, images, mine, AresClient.Listener(
                    text = { t -> main.post { if (!mine.get()) { replyText = t; ui.reply(t, false) } } },
                    audio = { pcm, clip -> if (!mine.get()) speaker.play(pcm, clip) },
                    action = { url, label -> main.post { if (!mine.get()) ui.action(url, label) } },
                    done = { t -> Ares.saveLast(ctx, null, t); main.post { if (!mine.get()) {
                        replyText = t
                        ui.reply(t, true)
                        if (!voiceTurn || !speaker.speaking) { // nothing being said aloud: page the whole reply at reading pace
                            clearCaptions()
                            var at = 0L
                            for (s in segments(t, true)) for (c in clauses(s)) {
                                val r = Runnable { ui.caption(c) }; captionQueue += r; main.postDelayed(r, at)
                                at += (c.split(' ').size * 0.42 * 1000).toLong().coerceAtLeast(1500)
                            }
                        }
                    } } },
                ))
                Ares.setStatus(ctx, "online")
            } catch (e: NotPairedException) {
                main.post { ui.notPaired() }
            } catch (e: Exception) {
                Ares.setStatus(ctx, "offline")
                // Keep it: the service sends it when the Mac is back, and the answer arrives as a notification
                Outbox.add(ctx, text)
                val n = Outbox.count(ctx)
                main.post { ui.offline("I can't reach the Mac right now, sir. I've kept that and will send it the moment it's back${if (n > 1) " ($n waiting)" else ""}; the answer will come as a notification.") }
            } finally {
                main.post {
                    busy = false
                    if (state == State.THINKING) set(if (Ares.status(ctx) == "offline") State.OFFLINE else State.IDLE)
                    if (state != State.SPEAKING) relisten() // nothing to say aloud (or offline): her turn is over
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
        transcript = ""
        continuing = false
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

    // The phone's recogniser stops at the first pause it hears, which cuts people off mid-sentence. So a result
    // isn't the end: it's kept as a segment and listening starts again straight away; only a real pause (nothing
    // more for GRACE_MS after the restart) or a tap finishes and sends everything heard, joined.
    private var transcript = ""
    private var continuing = false
    private var finishTimer: Runnable? = null
    private val GRACE_MS = 2200L

    private fun armFinish(r: SpeechRecognizer) {
        finishTimer?.let(main::removeCallbacks)
        val t = Runnable { if (recognizer === r && state == State.LISTENING) finish() }
        finishTimer = t
        main.postDelayed(t, GRACE_MS)
    }
    private fun heardMore() { finishTimer?.let(main::removeCallbacks); finishTimer = null }

    /** A recogniser result: one more segment. Keep listening unless you tapped to send. */
    private fun segment(text: String) {
        transcript = listOf(transcript, text.trim()).filter { it.isNotBlank() }.joinToString(" ")
        heard = ""
        if (transcript.isNotBlank()) ui.heard(transcript, false)
        if (stopAsked || transcript.isBlank()) return finish()
        continuing = true
        set(State.LISTENING)
        next() // the same recogniser again; a long pause now ends it
    }

    /** Send everything heard so far (or go idle if nothing was). */
    private fun finish() {
        heardMore()
        recognizer?.destroy(); recognizer = null
        continuing = false
        level = 0f
        val text = listOf(transcript, heard.trim()).filter { it.isNotBlank() }.joinToString(" ")
        transcript = ""; heard = ""
        if (text.isBlank()) {
            set(State.IDLE)
            // Hands-free and quiet: keep listening, until it's been quiet for a few minutes
            if (handsFree && System.currentTimeMillis() - lastSpokeAt > HANDS_FREE_IDLE_MS) setHandsFree(false, "quiet") else relisten()
            return
        }
        lastSpokeAt = System.currentTimeMillis()
        ui.heard(text, true)
        if (handsFreeOn.matches(text.trim())) { // handled here: no Mac needed to start a conversation
            set(State.IDLE)
            if (handsFree) relisten() else setHandsFree(true, "asked")
            return
        }
        if (handsFree && handsFreeOff.matches(text.trim())) setHandsFree(false, "asked") // she still answers the goodbye
        ask(text, voice = true)
    }

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
        if (recognizer != null) recognizer?.stopListening() else if (transcript.isNotBlank()) finish() // between segments: send now
        recorder?.let { finishRecording() }
    }

    fun cancelListening() {
        heardMore()
        transcript = ""; continuing = false
        recognizer?.destroy(); recognizer = null
        recorder?.let { runCatching { it.stop() }; it.release() }; recorder = null
        if (state == State.LISTENING) set(State.IDLE)
    }

    private fun listenOnPhone(r: SpeechRecognizer) {
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { started = true; set(State.LISTENING); if (continuing) armFinish(r) }
            override fun onBeginningOfSpeech() { heardMore() }
            override fun onRmsChanged(rmsdB: Float) { level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f); if (rmsdB > 4f) heardMore() }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { level = 0f }
            override fun onPartialResults(partial: Bundle?) {
                best(partial)?.let { heardMore(); heard = it; ui.heard(listOf(transcript, it).filter { s -> s.isNotBlank() }.joinToString(" "), false) }
            }
            override fun onResults(results: Bundle?) {
                val text = best(results) ?: heard
                done()
                segment(text)
            }
            override fun onError(error: Int) {
                done()
                val soft = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                if (heard.isNotBlank()) segment(heard) // it heard words but gave up on them: keep them, keep listening
                else if (continuing && soft) finish() // a real pause after what you said: send it
                else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) { set(State.IDLE); ui.offline("I need microphone access on the phone, sir.") }
                else if ((soft && started) || stopAsked) finish() // you didn't say anything (or tapped to send)
                else if (transcript.isNotBlank()) finish() // the recogniser broke mid-way: send what there is
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
            // Longer pauses before it decides you're done (recognisers may ignore these; the segment loop above covers that)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15_000L))
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
                    spoke && quietSince > 0 && now - quietSince > 2200 -> finishRecording() // a real pause, not a breath
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
