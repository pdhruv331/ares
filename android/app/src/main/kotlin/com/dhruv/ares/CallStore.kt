package com.dhruv.ares

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject

/**
 * The calls the phone knows about. The Mac's call log is the full record (with transcripts); calls pushed by
 * the relay are also kept here (the last 50, just what the notification said), so they can be opened with
 * the Mac off or out of reach.
 */
object CallStore {
    data class Call(
        val id: String, val direction: String, val who: String, val caller: String, val from: String, val callback: String,
        val topic: String, val title: String, val body: String, val message: String, val result: String, val purpose: String,
        val status: String, val at: Long, val secs: Int, val urgent: Boolean, val spam: Boolean, val local: Boolean,
    )

    private val listeners = mutableSetOf<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    fun listen(fn: () -> Unit) { listeners += fn }
    fun unlisten(fn: () -> Unit) { listeners -= fn }
    /** The Mac's log changed (a call ended, a result came in): open screens reload. */
    fun changed() = main.post { listeners.toList().forEach { it() } }

    fun fromPush(d: Map<String, String>): Call? {
        val id = d["id"]?.takeIf { it.isNotBlank() } ?: return null
        val caller = d["caller"].orEmpty()
        return Call(id, "inbound", caller.ifBlank { d["from"].orEmpty() }, caller, d["from"].orEmpty(), d["callback"].orEmpty(),
            d["topic"].orEmpty(), d["title"].orEmpty(), d["body"].orEmpty(), d["body"].orEmpty(), "", "", "done",
            d["at"]?.toLongOrNull() ?: System.currentTimeMillis(), d["secs"]?.toIntOrNull() ?: 0,
            d["urgent"] == "true", d["spam"] == "true", local = true)
    }

    /** One call from the Mac's /api/calls. */
    fun fromMac(o: JSONObject): Call {
        val inbound = o.optString("direction") != "outbound"
        val who = o.optString("who")
        val topic = o.optString("topic")
        val title = if (inbound) "$who${if (topic.isNotBlank()) " · $topic" else ""}" else "→ $who"
        val body = if (inbound) o.optString("message").ifBlank { o.optString("summary") } else o.optString("result").ifBlank { o.optString("purpose") }.ifBlank { o.optString("summary") }
        return Call(o.optString("id"), o.optString("direction"), who, "", o.optString("number"), o.optString("callback"), topic, title, body,
            o.optString("message"), o.optString("result"), o.optString("purpose"), o.optString("status"), o.optLong("at"), o.optInt("secs"),
            o.optBoolean("urgent"), o.optBoolean("spam"), local = false)
    }

    private fun toJson(c: Call) = JSONObject().put("id", c.id).put("who", c.who).put("caller", c.caller).put("from", c.from).put("callback", c.callback)
        .put("topic", c.topic).put("title", c.title).put("body", c.body).put("at", c.at).put("secs", c.secs).put("urgent", c.urgent).put("spam", c.spam)

    fun cached(c: Context): List<Call> {
        val arr = runCatching { JSONArray(Ares.prefs(c).getString("calls", "[]")) }.getOrElse { JSONArray() }
        return (0 until arr.length()).map { arr.getJSONObject(it) }.map { o ->
            Call(o.optString("id"), "inbound", o.optString("who"), o.optString("caller"), o.optString("from"), o.optString("callback"),
                o.optString("topic"), o.optString("title"), o.optString("body"), o.optString("body"), "", "", "done", o.optLong("at"),
                o.optInt("secs"), o.optBoolean("urgent"), o.optBoolean("spam"), local = true)
        }
    }

    fun add(c: Context, call: Call) {
        val list = (listOf(call) + cached(c).filter { it.id != call.id }).take(50)
        Ares.prefs(c).edit().putString("calls", JSONArray(list.map(::toJson)).toString()).apply()
        changed()
    }

    /** The Mac's list when it's reachable, plus any pushed calls it doesn't have; newest first. */
    fun merge(mac: List<Call>?, local: List<Call>): List<Call> {
        if (mac == null) return local.sortedByDescending { it.at }
        val ids = mac.map { it.id }.toSet()
        return (mac + local.filter { it.id !in ids }).sortedByDescending { it.at }
    }
}
