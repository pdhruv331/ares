package com.dhruv.ares

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The Mac's background jobs as this phone knows them: loaded when the live line connects, then kept up to
 * date by its 'job' messages. The notification, widget, bubble and Work screen all read it.
 */
object JobStore {
    data class Job(
        val id: String, val title: String, val status: String, val created: Long, val steps: Int,
        val seen: Boolean, val dismissed: Boolean, val approvalAt: Long, val approvalWhat: String?, val summary: String,
    ) {
        val active get() = status == "queued" || status == "running" || status == "approval"
    }

    private val jobs = LinkedHashMap<String, Job>()
    private val raw = LinkedHashMap<String, JSONObject>() // as the Mac sent them: the brain's orbs use these
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    /** "Send this to my phone" from the Mac: the Work screen opens it if it's up. */
    var onShow: ((String) -> Unit)? = null

    private fun parse(o: JSONObject): Job {
        val ap = o.optJSONObject("approval")
        return Job(
            o.optString("id"), o.optString("title", "Job"), o.optString("status"), o.optLong("created"), o.optInt("steps"),
            o.optBoolean("seen"), o.optBoolean("dismissed"), ap?.optLong("at") ?: 0L, ap?.optString("what"), o.optString("summary"),
        )
    }

    fun replaceAll(c: Context, arr: JSONArray) {
        synchronized(this) {
            jobs.clear()
            raw.clear()
            for (i in 0 until arr.length()) arr.getJSONObject(i).let { o -> parse(o).let { jobs[it.id] = it }; raw[o.optString("id")] = o }
        }
        changed(c)
    }

    fun update(c: Context, o: JSONObject) {
        synchronized(this) { parse(o).let { jobs[it.id] = it }; raw[o.optString("id")] = o }
        changed(c)
    }

    fun remove(c: Context, id: String) {
        synchronized(this) { jobs.remove(id); raw.remove(id) }
        changed(c)
    }

    fun get(id: String): Job? = synchronized(this) { jobs[id] }
    fun json(): JSONArray = synchronized(this) { JSONArray(raw.values.toList()) }

    /** Newest first. */
    fun list(): List<Job> = synchronized(this) { jobs.values.sortedByDescending { it.created } }

    val working get() = list().count { it.status == "queued" || it.status == "running" }
    val waiting get() = list().count { it.status == "approval" }
    val unseen get() = list().count { !it.active && !it.seen && it.status != "cancelled" }

    /** "2 jobs working · 1 needs your OK", or null when nothing's going on. */
    fun summary(): String? {
        val w = working; val a = waiting
        return listOfNotNull(
            w.takeIf { it > 0 }?.let { "$it job${if (it > 1) "s" else ""} working" },
            a.takeIf { it > 0 }?.let { "$it need${if (it == 1) "s" else ""} your OK" },
        ).joinToString(" · ").ifBlank { null }
    }

    fun listen(l: () -> Unit) { listeners += l }
    fun unlisten(l: () -> Unit) { listeners -= l }

    private fun changed(c: Context) {
        val s = summary()
        val p = Ares.prefs(c)
        if (p.getString("jobs", null) != s) {
            p.edit().putString("jobs", s).apply()
            AresWidget.refresh(c) // the widget reads the saved line (it may draw while the app is asleep)
        }
        main.post { for (l in listeners) l() }
    }

    fun show(id: String) = main.post { onShow?.invoke(id) }
}
