package com.dhruv.ares

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The ARES relay (relay/worker.js), for the one thing the phone asks it directly: wake a fully quit ARES
 * (docs/ignition-prompt.md §4d). Every request is signed with this phone's own wake key (from the Mac's hello),
 * never the Mac's secret. Blocking: call off the main thread.
 */
class RelayClient(private val relay: PowerStore.Relay) {
    class Answer(val ok: Boolean, val helperAgeSec: Int?, val awake: Boolean, val pending: Boolean, val error: String?)

    private fun sign(time: String, body: String): String {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(relay.key.toByteArray(), "HmacSHA256")) }
        return mac.doFinal("$time.$body".toByteArray()).joinToString("") { "%02x".format(it) }
    }
    private fun post(path: String): Answer {
        val body = JSONObject().put("id", relay.id).toString()
        val time = System.currentTimeMillis().toString()
        val c = URL(relay.url.trimEnd('/') + path).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.connectTimeout = 8_000; c.readTimeout = 12_000; c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("x-ares-id", relay.id)
        c.setRequestProperty("x-ares-time", time)
        c.setRequestProperty("x-ares-sig", sign(time, body))
        try {
            c.outputStream.use { it.write(body.toByteArray()) }
            if (c.responseCode == 401) return Answer(false, null, false, false, "The relay doesn't know this phone's wake key. Open the app with the Mac on once.")
            if (c.responseCode !in 200..299) throw IOException("relay HTTP ${c.responseCode}")
            val o = JSONObject(c.inputStream.bufferedReader().readText())
            val age = if (o.isNull("helper")) null else o.optInt("helper")
            return Answer(o.optBoolean("ok"), age, o.optBoolean("awake", age != null && age < 360), o.optBoolean("pending"), null)
        } finally { c.disconnect() }
    }
    /** Ask for ARES to be started. `awake` false = the ignition helper hasn't polled for minutes: the Mac is asleep (or has no helper). */
    fun wake(): Answer = post("/wake")
    /** Is the ignition helper polling (Mac awake, ARES quit)? */
    fun status(): Answer = post("/wake/status")
}
