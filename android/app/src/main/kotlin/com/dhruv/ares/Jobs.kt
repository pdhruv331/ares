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
        val kind: String = "", val error: String = "", val phase: String? = null, val progressDone: Int = 0, val progressTotal: Int = 0,
        val undoUntil: Long = 0L, val check: JSONObject? = null, val sentinel: JSONArray? = null,
    ) {
        val active get() = status == "queued" || status == "running" || status == "approval"
        val project get() = phase != null
        /** The latest step the Mac reported for this job (kept here from the live line), or null. */
        fun lastEvent(): String? = events(id).lastOrNull()?.optString("text")?.takeIf { it.isNotBlank() }
        /** One line on where it is: the project's phase, else progress, else the steps so far. */
        fun phaseLine(): String = when {
            phase != null -> phase.uppercase().let { p -> if (progressTotal > 0) "$p · $progressDone/$progressTotal" else p }
            progressTotal > 0 -> "Working · $progressDone of $progressTotal"
            steps > 0 -> "Working · $steps steps"
            else -> "Working"
        }
        /** The Live Update's segments (docs/phone-ui-prompt.md §7): projects by phase, plain jobs by progress. */
        fun segmentNames(): List<String> = if (project) listOf("plan", "build", "test", "verify", "done") else listOf("queued", "working", "done")
        fun segmentsDone(): Int = when (status) {
            "done" -> segmentNames().size
            "failed", "cancelled" -> 0
            "queued" -> 1
            else -> if (project) (listOf("plan", "build", "test", "verify", "report").indexOf(phase ?: "plan") + 1).coerceIn(1, 4) else 2
        }
        /** 0..100 for the progress bar. */
        fun percent(): Int = when {
            status == "done" -> 100
            status == "queued" -> 5
            project -> (segmentsDone() * 100 / segmentNames().size).coerceIn(5, 95)
            progressTotal > 0 -> (10 + progressDone * 85 / progressTotal).coerceIn(10, 95)
            else -> (10 + steps * 3).coerceAtMost(80)
        }
        val undoLeftMs get() = (undoUntil - System.currentTimeMillis()).coerceAtLeast(0L)
    }

    /** The last steps of each job, as the Mac's 'job-event' messages bring them (the receipt and the Live Update read them). */
    private val eventLog = LinkedHashMap<String, ArrayList<JSONObject>>()
    fun events(id: String): List<JSONObject> = synchronized(this) { eventLog[id]?.toList().orEmpty() }
    fun event(c: Context, id: String, evt: JSONObject) {
        synchronized(this) { val l = eventLog.getOrPut(id) { ArrayList() }; l += evt; while (l.size > 80) l.removeAt(0) }
        main.post { for (l in eventListeners) l(id) }
        LiveUpdates.sync(c)
    }
    private val eventListeners = CopyOnWriteArraySet<(String) -> Unit>()
    fun listenEvents(l: (String) -> Unit) { eventListeners += l }
    fun unlistenEvents(l: (String) -> Unit) { eventListeners -= l }

    private val jobs = LinkedHashMap<String, Job>()
    private val raw = LinkedHashMap<String, JSONObject>() // as the Mac sent them: the brain's orbs use these
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    /** "Send this to my phone" from the Mac: the Work screen opens it if it's up. */
    var onShow: ((String) -> Unit)? = null

    private fun parse(o: JSONObject): Job {
        val ap = o.optJSONObject("approval")
        val pr = o.optJSONObject("progress")
        return Job(
            o.optString("id"), o.optString("title", "Job"), o.optString("status"), o.optLong("created"), o.optInt("steps"),
            o.optBoolean("seen"), o.optBoolean("dismissed"), ap?.optLong("at") ?: 0L, ap?.optString("what"), o.optString("summary"),
            kind = o.optString("kind"), error = o.optString("error"), phase = o.optJSONObject("project")?.optString("phase")?.takeIf { it.isNotBlank() },
            progressDone = pr?.optInt("done") ?: 0, progressTotal = pr?.optInt("total") ?: 0,
            undoUntil = o.optJSONObject("undo")?.optLong("until") ?: 0L, check = ap?.optJSONObject("check"), sentinel = o.optJSONArray("checks"),
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
        LiveUpdates.sync(c)
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
