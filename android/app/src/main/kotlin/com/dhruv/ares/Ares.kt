package com.dhruv.ares

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/** App-wide settings and the little bits of state the widget, tile and notification share. */
object Ares {
    const val DEFAULT_URL = "https://your-mac.your-tailnet.ts.net"

    fun prefs(c: Context) = c.getSharedPreferences("ares", Context.MODE_PRIVATE)

    fun url(c: Context): String = prefs(c).getString("url", null) ?: DEFAULT_URL
    fun token(c: Context): String? = prefs(c).getString("token", null)
    fun paired(c: Context) = token(c) != null
    fun bubbleOn(c: Context) = prefs(c).getBoolean("bubble", true)

    /** "online", "offline" or "unpaired": shown on the widget, tile and notification. */
    fun status(c: Context): String = if (!paired(c)) "unpaired" else prefs(c).getString("status", "offline")!!

    fun setStatus(c: Context, s: String) {
        if (prefs(c).getString("status", null) == s) return
        prefs(c).edit().putString("status", s).apply()
        AresWidget.refresh(c)
        AresTile.refresh(c)
    }

    /** Remember the latest exchange for the widget. */
    fun saveLast(c: Context, said: String?, reply: String?) {
        prefs(c).edit().apply {
            if (said != null) putString("lastSaid", said)
            if (reply != null) putString("lastReply", reply)
            putLong("lastAt", System.currentTimeMillis())
        }.apply()
        AresWidget.refresh(c)
    }

    fun deviceName(c: Context): String =
        (Settings.Global.getString(c.contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL) + " (app)"

    /** Open something ARES asked the phone to open: web links, calls, texts, email. */
    fun open(c: Context, url: String): Boolean {
        val uri = Uri.parse(url)
        if (uri.scheme !in setOf("https", "http", "tel", "sms", "smsto", "mailto")) return false
        return try {
            c.startActivity(Intent(if (uri.scheme == "tel") Intent.ACTION_DIAL else Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: Exception) { false }
    }
}

class NotPairedException : IOException("not paired")

/**
 * Talks to the ARES phone server on the Mac (phone.js), over Tailscale. Every call blocks: run it off
 * the main thread. The pairing key is the same cookie the web app gets, kept in private app storage.
 */
class AresClient(private val ctx: Context) {
    private fun open(path: String, method: String = "GET", readTimeout: Int = 30_000): HttpURLConnection {
        val c = URL(Ares.url(ctx).trimEnd('/') + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10_000
        c.readTimeout = readTimeout
        c.useCaches = false
        Ares.token(ctx)?.let { c.setRequestProperty("Cookie", "ares_token=$it") }
        return c
    }

    private fun HttpURLConnection.sendJson(body: JSONObject) {
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
        outputStream.use { it.write(body.toString().toByteArray()) }
    }

    private fun HttpURLConnection.check(): HttpURLConnection {
        if (responseCode == 401) { disconnect(); throw NotPairedException() }
        if (responseCode !in 200..299) { disconnect(); throw IOException("HTTP $responseCode") }
        return this
    }

    private fun HttpURLConnection.json(): JSONObject = inputStream.bufferedReader().use { JSONObject(it.readText()) }

    /** Pair with the six-digit code shown on the Mac. Returns an error message, or null on success. */
    fun pair(code: String): String? {
        val c = open("/api/pair", "POST")
        c.sendJson(JSONObject().put("code", code).put("name", Ares.deviceName(ctx)))
        if (c.responseCode != 200) {
            val err = runCatching { JSONObject(c.errorStream.bufferedReader().readText()).optString("error") }.getOrNull()
            return err?.takeIf { it.isNotBlank() } ?: "Pairing failed (HTTP ${c.responseCode})."
        }
        val token = c.headerFields.filterKeys { it.equals("Set-Cookie", true) }.values.flatten()
            .firstNotNullOfOrNull { Regex("ares_token=([a-f0-9]{64})").find(it)?.groupValues?.get(1) }
            ?: return "The Mac didn't send a key back."
        Ares.prefs(ctx).edit().putString("token", token).apply()
        return null
    }

    /** Throws NotPairedException if the Mac no longer knows this phone. */
    fun me(): JSONObject = open("/api/me").check().json()
    /** Host, battery and Claude usage, for the schematic's corner readouts. */
    fun status(): JSONObject = open("/api/status").check().json()

    data class Line(val who: String, val text: String, val source: String?)

    fun history(): List<Line> {
        val arr = open("/api/history").check().json().optJSONArray("history") ?: JSONArray()
        return (0 until arr.length()).map { arr.getJSONObject(it) }
            .map { Line(it.optString("who"), it.optString("text"), it.optString("source").ifBlank { null }) }
    }

    class Listener(
        val text: (String) -> Unit = {},
        val audio: (pcm: ByteArray, clip: Int) -> Unit = { _, _ -> },
        val action: (url: String, label: String) -> Unit = { _, _ -> },
        val done: (String) -> Unit = {},
    )

    /** Ask ARES. Her reply streams back: text as she writes it, then her voice sentence by sentence. */
    fun ask(text: String, voice: Boolean, images: List<Pair<String, String>> = emptyList(), cancel: AtomicBoolean = AtomicBoolean(), on: Listener) {
        val body = JSONObject().put("text", text).put("voice", voice)
        if (images.isNotEmpty()) body.put("images", JSONArray(images.map { (type, data) -> JSONObject().put("media_type", type).put("data", data) }))
        val c = open("/api/ask", "POST", readTimeout = 300_000) // she may be using tools for a while
        try { c.sendJson(body); c.check(); stream(c, cancel, on) } finally { c.disconnect() }
    }
    /** The app was opened: her greeting, text then voice, the same stream shape as a reply. */
    fun greet(cancel: AtomicBoolean, on: Listener) {
        val c = open("/api/greet", "POST", readTimeout = 30_000)
        try { c.sendJson(JSONObject()); c.check(); stream(c, cancel, on) } finally { c.disconnect() }
    }
    private fun stream(c: HttpURLConnection, cancel: AtomicBoolean, on: Listener) {
        var reply = ""
        c.inputStream.bufferedReader().useLines { lines ->
            for (line in lines) {
                if (cancel.get()) break
                if (line.isBlank()) continue
                val m = JSONObject(line)
                when (m.optString("type")) {
                    "text" -> { reply += m.optString("delta"); on.text(reply) }
                    "audio" -> on.audio(android.util.Base64.decode(m.optString("pcm"), android.util.Base64.DEFAULT), m.optInt("clip", -1))
                    "action" -> on.action(m.optString("url"), m.optString("label"))
                    "done" -> { reply = m.optString("text", reply); on.done(reply) }
                }
            }
        }
    }

    // ---- Work: the Mac's background jobs ---------------------------------------------------------------

    /** A file going to the Mac with a job (shared PDFs, screenshots…), base64. */
    class Upload(val name: String, val type: String, val data: String)

    /** Every job on the Mac (the Mac is the source of truth). */
    fun jobs(): JSONArray = open("/api/jobs").check().json().optJSONArray("jobs") ?: JSONArray()

    /** POST to the Mac's job API. Returns its answer, errors included ({ ok: false, error }). */
    fun post(path: String, body: JSONObject = JSONObject(), readTimeout: Int = 60_000): JSONObject {
        require(path.startsWith("/api/jobs")) { "not a job call" }
        val c = open(path, "POST", readTimeout)
        try {
            c.sendJson(body)
            if (c.responseCode == 401) throw NotPairedException()
            val stream = if (c.responseCode in 200..299) c.inputStream else c.errorStream
            return runCatching { JSONObject(stream.bufferedReader().readText()) }.getOrElse { JSONObject().put("ok", false).put("error", "HTTP ${c.responseCode}") }
        } finally { c.disconnect() }
    }

    /** Start a job on the Mac. Returns the new job, or throws with the Mac's reason. */
    fun startJob(text: String, files: List<Upload> = emptyList(), link: String? = null): JSONObject {
        val body = JSONObject().put("text", text).put("link", link ?: "")
            .put("files", JSONArray(files.map { JSONObject().put("name", it.name).put("type", it.type).put("data", it.data) }))
        val r = post("/api/jobs", body, readTimeout = 120_000)
        if (!r.optBoolean("ok")) throw IOException(r.optString("error").ifBlank { "The Mac couldn't start it." })
        return r.getJSONObject("job")
    }

    // ---- Calls: the ARES phone line ----------------------------------------------------------------------

    private fun postJson(path: String, body: JSONObject, readTimeout: Int = 30_000): JSONObject {
        val c = open(path, "POST", readTimeout)
        try {
            c.sendJson(body)
            if (c.responseCode == 401) throw NotPairedException()
            val stream = if (c.responseCode in 200..299) c.inputStream else c.errorStream
            return runCatching { JSONObject(stream.bufferedReader().readText()) }.getOrElse { JSONObject().put("ok", false).put("error", "HTTP ${c.responseCode}") }
        } finally { c.disconnect() }
    }

    /** The kill switch: pause every job, hold goals and routines (the Work view's STOP ALL). */
    fun stopAll(): JSONObject = postJson("/api/autonomy/stop", JSONObject())

    /** Give the Mac this phone's Firebase push token (it registers it with the relay). */
    fun pushToken(token: String) {
        if (!postJson("/api/push/fcm", JSONObject().put("token", token)).optBoolean("ok")) throw IOException("token not accepted")
    }

    /** The Mac's call log ({ calls, messages }). */
    fun calls(): JSONObject = open("/api/calls").check().json()

    /** One call with its transcript. */
    fun call(id: String): JSONObject = open("/api/calls/" + Uri.encode(id)).check().json().getJSONObject("call")

    /** Have ARES place a call (or schedule it with `at`). Returns the Mac's answer, errors included. */
    fun placeCall(to: String, name: String, purpose: String, brief: String, at: String?): JSONObject =
        postJson("/api/calls", JSONObject().put("to", to).put("name", name).put("purpose", purpose).put("brief", brief).put("at", at ?: ""), readTimeout = 60_000)

    fun cancelCall(id: String): JSONObject = postJson("/api/calls/cancel", JSONObject().put("id", id))

    /** The Mac's power state (docs/ignition-prompt.md §4d): { mode, status: { jobs, link }, schedule }. Answers while she's dormant too. */
    fun power(): JSONObject = open("/api/power").check().json()
    /** standby | wake | powerdown | toggle | skip. The Mac's answer carries the new state. */
    fun powerAct(action: String): JSONObject = postJson("/api/power/$action", JSONObject(), readTimeout = 20_000)

    /** The latest Android build on the Mac, or null. */
    fun appInfo(): JSONObject? = open("/api/app").check().json().optJSONObject("app")

    fun downloadApk(to: java.io.File) {
        val c = open("/api/app/apk", readTimeout = 60_000).check()
        try { c.inputStream.use { input -> to.outputStream().use { input.copyTo(it) } } } finally { c.disconnect() }
    }

    /** Hand recorded audio to the Mac to transcribe (used when the phone has no speech recogniser). */
    fun stt(audio: ByteArray, type: String): String {
        val c = open("/api/stt", "POST", readTimeout = 60_000)
        c.doOutput = true
        c.setRequestProperty("Content-Type", type)
        c.outputStream.use { it.write(audio) }
        return c.check().json().optString("text")
    }

    /** The live line to the Mac: blocks, calling `on` for each event, until the connection drops. */
    fun events(stop: AtomicBoolean, on: (JSONObject) -> Unit) {
        val c = open("/api/events", readTimeout = 70_000) // the Mac pings every 25s
        try {
            c.check()
            c.inputStream.bufferedReader().useLines { lines ->
                for (line in lines) {
                    if (stop.get()) break
                    if (line.isNotBlank()) on(JSONObject(line))
                }
            }
        } finally { c.disconnect() }
    }
}
