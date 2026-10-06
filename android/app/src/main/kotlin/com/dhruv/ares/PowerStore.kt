package com.dhruv.ares

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The Mac's power state as this phone knows it (docs/ignition-prompt.md §4d, §4f): online, standby, offline (powered down,
 * the process dormant), charging (waking), spindown (powering down), and, when the Mac can't be reached at all, whether it's
 * merely quit (the ignition helper is polling the relay: a wake can reach it) or asleep (nothing answers anywhere).
 * Filled by the live line (AresService: hello, 'power', 'power-step') and by the relay's status; read by the screen.
 */
object PowerStore {
    /** What the screen shows. */
    enum class Mode { ONLINE, STANDBY, OFFLINE, CHARGING, SPINDOWN, QUIT, ASLEEP, UNREACHABLE, UNKNOWN }

    data class Schedule(val standby: String?, val wake: String?, val skipped: Boolean)
    /** How this phone may ask the relay to start a fully quit ARES: the relay's URL, this phone's id and its wake key. */
    data class Relay(val url: String, val id: String, val key: String)

    @Volatile var macMode = "unknown"   // the Mac's own word: online | standby | dormant | charging | spindown
        private set
    @Volatile var reach = false         // the live line is up
        private set
    @Volatile var helperAlive: Boolean? = null // from the relay while unreachable: the ignition helper polled lately
        private set
    @Volatile var jobs = 0
    @Volatile var link = false
    @Volatile var schedule: Schedule? = null
    @Volatile var relay: Relay? = null
    @Volatile var chargeK = 0f          // 0..1 while charging (steps done / total)
    @Volatile var why = ""
    /** Set by the screen while it waits for a wake it asked the relay for. */
    @Volatile var igniting = false

    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    val mode: Mode get() = when {
        reach -> when (macMode) {
            "online" -> Mode.ONLINE
            "standby" -> Mode.STANDBY
            "dormant", "offline" -> Mode.OFFLINE
            "charging" -> Mode.CHARGING
            "spindown" -> Mode.SPINDOWN
            else -> Mode.UNKNOWN
        }
        igniting -> Mode.CHARGING
        relay == null -> Mode.UNREACHABLE
        helperAlive == true -> Mode.QUIT
        helperAlive == false -> Mode.ASLEEP
        else -> Mode.UNREACHABLE
    }
    /** She's up and listening for the orb hold to mean standby. */
    val canStandby get() = mode == Mode.ONLINE
    /** A hold means wake: standby or dormant over the live line, or quit through the relay. */
    val canWake get() = mode == Mode.STANDBY || mode == Mode.OFFLINE || mode == Mode.QUIT
    val off get() = mode == Mode.OFFLINE || mode == Mode.QUIT || mode == Mode.ASLEEP || mode == Mode.UNREACHABLE

    fun listen(l: () -> Unit) { listeners += l; l() }
    fun unlisten(l: () -> Unit) { listeners -= l }
    private fun changed() = main.post { for (l in listeners) l() }

    /** The live line connected (hello) or dropped. */
    fun setReach(c: Context, up: Boolean) {
        val was = reach
        reach = up
        if (up) { igniting = false; helperAlive = null }
        if (was != up) { save(c); changed() }
    }
    fun fromHello(c: Context, m: JSONObject) {
        m.optJSONObject("power")?.let { apply(it) }
        relay = m.optJSONObject("relay")?.let { r -> r.optString("url").takeIf { it.isNotBlank() }?.let { Relay(it, r.optString("id"), r.optString("key")) } }
        relay?.let { c.getSharedPreferences("ares", Context.MODE_PRIVATE).edit().putString("relay", JSONObject().put("url", it.url).put("id", it.id).put("key", it.key).toString()).apply() }
        save(c); changed()
    }
    /** A 'power' message from the Mac: { mode, status: { jobs, link }, schedule, why }. */
    fun fromPower(c: Context, m: JSONObject) { apply(m); save(c); changed() }
    private fun apply(m: JSONObject) {
        val mode = m.optString("mode").ifBlank { return }
        if (mode != macMode) chargeK = if (mode == "charging") 0f else 1f
        macMode = mode
        why = m.optString("why")
        m.optJSONObject("status")?.let { jobs = it.optInt("jobs"); link = it.optBoolean("link") }
        schedule = m.optJSONObject("schedule")?.let { s -> Schedule(s.optString("standby").takeIf { it.isNotBlank() }, s.optString("wake").takeIf { it.isNotBlank() }, s.optBoolean("skipped")) }
        if (m.isNull("schedule") && m.has("schedule")) schedule = null
        m.optJSONArray("steps")?.let { steps -> // a charge in progress when we connected
            var done = 0; var total = 6
            for (i in 0 until steps.length()) { val s = steps.getJSONObject(i); total = s.optInt("total", total); if (s.optString("status") != "start") done++ }
            chargeK = (done.toFloat() / total).coerceIn(0f, 1f)
        }
    }
    /** A start-up step while she wakes: the charge ring follows the real steps. */
    fun step(m: JSONObject) {
        val s = m.optJSONObject("step") ?: return
        val total = s.optInt("total", 6).coerceAtLeast(1)
        if (s.optString("status") != "start") chargeK = (chargeK + 1f / total).coerceAtMost(1f)
        changed()
    }
    /** The relay's word while the Mac is unreachable: the helper polled within the last few minutes, or not. */
    fun setHelper(alive: Boolean?) { helperAlive = alive; changed() }
    fun markIgniting(on: Boolean) { igniting = on; if (on) chargeK = 0f; changed() }

    /** Remembered between launches, so the screen opens in the right colour before the line is back. */
    fun load(c: Context) {
        val p = c.getSharedPreferences("ares", Context.MODE_PRIVATE)
        macMode = p.getString("powerMode", "unknown") ?: "unknown"
        relay = p.getString("relay", null)?.let { runCatching { JSONObject(it) }.getOrNull() }?.let { Relay(it.optString("url"), it.optString("id"), it.optString("key")) }
    }
    private fun save(c: Context) = c.getSharedPreferences("ares", Context.MODE_PRIVATE).edit().putString("powerMode", macMode).apply()

    /** One word for the header. */
    fun header(): String = when (mode) {
        Mode.ONLINE -> "ONLINE"; Mode.STANDBY -> "STANDBY"; Mode.OFFLINE, Mode.QUIT -> "OFFLINE"; Mode.CHARGING -> "CHARGING"
        Mode.SPINDOWN -> "POWERING DOWN"; Mode.ASLEEP -> "MAC · ASLEEP"; Mode.UNREACHABLE -> "UNREACHABLE"; Mode.UNKNOWN -> "…"
    }
    /** The hint under the orb (what a tap and a hold do now). */
    fun hint(): String = when (mode) {
        Mode.ONLINE -> "tap to talk · hold for standby"
        Mode.STANDBY -> "standby · ${if (jobs == 0) "no jobs" else "$jobs job${if (jobs == 1) "" else "s"} running"} · ${if (link) "reachable" else "link down"}\nhold to wake"
        Mode.OFFLINE, Mode.QUIT -> "powered down · hold to wake"
        Mode.CHARGING -> "charging…"
        Mode.SPINDOWN -> "spinning down…"
        Mode.ASLEEP -> "Mac asleep · can't wake\nopen the lid or plug it in"
        Mode.UNREACHABLE -> "can't reach the Mac\nis Tailscale on?"
        Mode.UNKNOWN -> ""
    }
}
