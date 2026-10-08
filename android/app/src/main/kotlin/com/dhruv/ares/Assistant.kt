package com.dhruv.ares

import android.app.assist.AssistStructure
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.util.Base64
import android.view.WindowManager
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * ARES as the phone's default digital assistant: long-press the side button (or swipe up from a bottom
 * corner) and she appears over whatever you're doing, listening. If you allow it, she also gets a look
 * at your screen, only at that moment, and only sent to your Mac.
 */
class AresAssistService : VoiceInteractionService()

class AresSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = AresSession(this)
}

class AresSession(ctx: Context) : VoiceInteractionSession(ctx) {
    private val main = Handler(Looper.getMainLooper())
    private var got = 0
    private var home = false // summoned from the home screen: nothing there worth sending
    private val sharing get() = Ares.prefs(context).getBoolean("screen", true)

    override fun onCreate() {
        super.onCreate()
        // The session's own window stays invisible and lets touches through to the ARES panel
        window.window?.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        got = 0
        home = false
        ScreenContext.clear()
        // Summoned (a Bud hold, the side key) while the ARES home screen is in front: she listens right there
        if (Ares.paired(context) && HomeActivity.listenHere()) { main.post { hide() }; return }
        startAssistantActivity(
            if (Ares.paired(context)) AskActivity.intent(context, listen = true).putExtra("assist", sharing)
            else Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        main.postDelayed({ hide() }, 3000) // screen context usually arrives well within this
    }

    override fun onHandleAssist(state: AssistState) {
        if (!sharing || !state.isFocused) return done()
        val s = state.assistStructure
        val pkg = s?.activityComponent?.packageName
        if (pkg != null && pkg == launcher()) { home = true; ScreenContext.ignore(); return done() }
        val app = pkg?.let(::label)
        val text = s?.let(::text).orEmpty()
        val url = state.assistContent?.webUri?.toString()
        ScreenContext.setText(app, url, text)
        done()
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        if (sharing && !home && screenshot != null) {
            val shot = screenshot.copy(Bitmap.Config.ARGB_8888, false)
            thread { ScreenContext.setImage(jpeg(shot)) }
        }
        done()
    }

    private fun done() { if (++got >= 2) main.post { hide() } }

    /** The home screen app (One UI Home on a Galaxy). */
    private fun launcher() = context.packageManager
        .resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName

    private fun label(pkg: String) = runCatching {
        context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    /** The readable text on screen (what the app exposes to assistants), capped. */
    private fun text(s: AssistStructure): String {
        val out = StringBuilder()
        fun walk(n: AssistStructure.ViewNode?) {
            if (n == null || out.length > 4000) return
            n.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { out.append(it).append('\n') }
            for (i in 0 until n.childCount) walk(n.getChildAt(i))
        }
        for (i in 0 until s.windowNodeCount) walk(s.getWindowNodeAt(i).rootViewNode)
        return out.toString().take(4000)
    }

    private fun jpeg(b: Bitmap): String {
        val scale = minOf(1f, 1568f / maxOf(b.width, b.height))
        val small = if (scale < 1f) Bitmap.createScaledBitmap(b, (b.width * scale).toInt(), (b.height * scale).toInt(), true) else b
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, 80, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}

/** What was on screen when you summoned ARES, until you ask (or it's a minute old). */
object ScreenContext {
    @Volatile var app: String? = null; private set
    @Volatile private var url: String? = null
    @Volatile private var text: String = ""
    @Volatile private var image: String? = null
    @Volatile private var at = 0L
    var onChange: (() -> Unit)? = null

    val available get() = System.currentTimeMillis() - at < 60_000 && (image != null || text.isNotBlank())

    fun clear() { app = null; url = null; text = ""; image = null; at = 0L }

    fun setText(app: String?, url: String?, text: String) {
        this.app = app; this.url = url; this.text = text
        at = System.currentTimeMillis()
        onChange?.let { cb -> Handler(Looper.getMainLooper()).post(cb) }
    }

    /** Nothing to share this time (the home screen): drop anything that arrived, and anything still coming. */
    fun ignore() { clear(); at = -1L; changed() }

    fun changed() { onChange?.let { cb -> Handler(Looper.getMainLooper()).post(cb) } }

    fun setImage(jpeg: String) {
        if (at == -1L) return // set aside: summoned from the home screen
        image = jpeg
        at = System.currentTimeMillis()
        onChange?.let { cb -> Handler(Looper.getMainLooper()).post(cb) }
    }

    /** Hand it over (once) as an attachment to the next question. */
    fun take(): Session.Attachment? {
        if (!available) return null
        val note = buildString {
            append("(ARES note: the user summoned you from their phone while using ${app ?: "an app"}. ")
            append(if (image != null) "Attached is a screenshot of their screen" else "Below is the text on their screen")
            append(". Use it only if their request is about what's on screen.)")
            url?.let { append("\nPage: $it") }
            if (text.isNotBlank()) append("\nText on screen:\n").append(text)
        }
        val images = listOfNotNull(image?.let { "image/jpeg" to it })
        clear()
        return Session.Attachment(note, images)
    }
}

/** Picks the phone's real speech recogniser (Google's or Samsung's), never ARES's own pass-through. */
object Speech {
    /** Every recogniser on the phone except ARES's own, best first. */
    fun components(c: Context): List<ComponentName> {
        val all = c.packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
            .map { ComponentName(it.serviceInfo.packageName, it.serviceInfo.name) }
            .filter { it.packageName != c.packageName }
        val prefer = listOf("com.google.android.googlequicksearchbox", "com.google.android.as", "com.google.android.tts", "com.samsung.android.bixby.agent")
        return all.sortedBy { prefer.indexOf(it.packageName).let { i -> if (i < 0) prefer.size else i } }
    }

    fun create(c: Context): SpeechRecognizer? = components(c).firstOrNull()?.let { SpeechRecognizer.createSpeechRecognizer(c, it) }
}

/**
 * Android asks the default assistant to also be the default speech recogniser. ARES passes those
 * requests straight to the phone's real recogniser, so voice typing in other apps keeps working.
 */
class AresRecognitionService : RecognitionService() {
    private var inner: SpeechRecognizer? = null

    override fun onStartListening(intent: Intent, cb: Callback) {
        inner?.destroy()
        val r = Speech.create(this) ?: return run { runCatching { cb.error(SpeechRecognizer.ERROR_CLIENT) } }
        inner = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { runCatching { cb.readyForSpeech(params ?: Bundle()) } }
            override fun onBeginningOfSpeech() { runCatching { cb.beginningOfSpeech() } }
            override fun onRmsChanged(rmsdB: Float) { runCatching { cb.rmsChanged(rmsdB) } }
            override fun onBufferReceived(buffer: ByteArray?) { buffer?.let { runCatching { cb.bufferReceived(it) } } }
            override fun onEndOfSpeech() { runCatching { cb.endOfSpeech() } }
            override fun onError(error: Int) { runCatching { cb.error(error) } }
            override fun onResults(results: Bundle?) { runCatching { cb.results(results ?: Bundle()) } }
            override fun onPartialResults(partial: Bundle?) { runCatching { cb.partialResults(partial ?: Bundle()) } }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(intent)
    }

    override fun onStopListening(cb: Callback) { inner?.stopListening() }
    override fun onCancel(cb: Callback) { inner?.cancel() }
    override fun onDestroy() { inner?.destroy(); inner = null; super.onDestroy() }
}
