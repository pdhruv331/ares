package com.dhruv.ares

import android.content.Context
import android.graphics.Color
import java.util.Calendar

/**
 * The colour scheme (docs/launcher-v2-prompt.md §2): the one colour the reactor, the schematic, the themed icons and the home
 * screen's text use while ARES is online. The power states keep their own fixed colours (standby blue, powered down gold).
 * "time" follows the time of day: night blue, dawn amber, day cyan, evening orange, violet.
 */
object Scheme {
    val names = linkedMapOf(
        "arc" to "Arc reactor", "mark3" to "Mark III", "hulk" to "Hulkbuster", "stealth" to "Stealth",
        "warmachine" to "War Machine", "time" to "Follow the time of day",
    )
    private val fixed = mapOf(
        "arc" to Color.rgb(62, 230, 255), "mark3" to Color.rgb(255, 190, 80), "hulk" to Color.rgb(255, 96, 80),
        "stealth" to Color.rgb(215, 228, 240), "warmachine" to Color.rgb(170, 190, 205),
    )
    private val hours = listOf(0f to Color.rgb(96, 120, 255), 6f to Color.rgb(255, 170, 110), 10f to Color.rgb(62, 230, 255),
        17f to Color.rgb(255, 130, 90), 20f to Color.rgb(160, 120, 255), 24f to Color.rgb(96, 120, 255))
    private val listeners = java.util.concurrent.CopyOnWriteArraySet<() -> Unit>()

    @Volatile private var id = "arc"
    @Volatile private var cached = fixed.getValue("arc")
    @Volatile private var at = 0L

    fun load(c: Context) { id = Ares.prefs(c).getString("scheme", "arc")?.takeIf { it in names } ?: "arc"; at = 0L }
    fun id() = id

    fun set(c: Context, newId: String) {
        id = newId; at = 0L
        Ares.prefs(c).edit().putString("scheme", newId).apply()
        Icons.clear()
        for (l in listeners) l()
    }

    fun listen(l: () -> Unit) { listeners += l }
    fun unlisten(l: () -> Unit) { listeners -= l }

    /** The colour now (the time-of-day scheme is recomputed at most once a minute). */
    val color: Int get() {
        val now = System.currentTimeMillis()
        if (now - at > 60_000) {
            cached = if (id == "time") Calendar.getInstance().let { byHour(it.get(Calendar.HOUR_OF_DAY) + it.get(Calendar.MINUTE) / 60f) } else fixed[id] ?: fixed.getValue("arc")
            at = now
        }
        return cached
    }

    /** The scheme colour at this alpha (0..255). */
    fun alpha(a: Int) = Color.argb(a, Color.red(color), Color.green(color), Color.blue(color))

    private fun byHour(h: Float): Int {
        for (i in 0 until hours.size - 1) {
            val (a, ca) = hours[i]; val (b, cb) = hours[i + 1]
            if (h in a..b) return mix(ca, cb, (h - a) / (b - a))
        }
        return fixed.getValue("arc")
    }

    fun mix(a: Int, b: Int, t: Float): Int {
        val k = t.coerceIn(0f, 1f)
        return Color.rgb((Color.red(a) + (Color.red(b) - Color.red(a)) * k).toInt(), (Color.green(a) + (Color.green(b) - Color.green(a)) * k).toInt(), (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * k).toInt())
    }
}
