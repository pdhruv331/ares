package com.dhruv.ares

import android.app.Activity
import android.util.Log
import android.view.View
import androidx.metrics.performance.JankStats
import androidx.metrics.performance.PerformanceMetricsState
import java.util.WeakHashMap

/**
 * Frame measurement (docs/phone-ui-prompt.md §10): JankStats on each activity's window, with named states ("HomePager:
 * Swiping", "Drawer: Dragging", "Reactor: Summon") so a janky frame says what was going on. Every frame over its budget is
 * logged (tag ARES.jank), not only the ones JankStats calls jank (> 2× the refresh period), because at 120 Hz a single
 * missed frame is still visible. `adb logcat -s ARES.jank` or scripts/phone-jank.sh reads them off the real phone.
 */
object Perf {
    private const val TAG = "ARES.jank"
    private val stats = WeakHashMap<Activity, JankStats>()
    private val holders = WeakHashMap<Activity, PerformanceMetricsState.Holder>()
    @Volatile private var frames = 0L
    @Volatile private var over = 0L
    @Volatile private var jank = 0L
    @Volatile private var worstNs = 0L
    private var lastSummary = 0L

    fun track(a: Activity) {
        if (stats.containsKey(a)) return
        runCatching {
            val root: View = a.window.decorView
            holders[a] = PerformanceMetricsState.getHolderForHierarchy(root)
            stats[a] = JankStats.createAndTrack(a.window) { f ->
                frames++
                val overrun = runCatching { (f as? androidx.metrics.performance.FrameDataApi31)?.frameOverrunNanos ?: 0L }.getOrDefault(0L)
                if (overrun > 0) over++
                if (overrun > worstNs) worstNs = overrun
                if (f.isJank) {
                    jank++
                    val states = f.states.joinToString(" ") { "${it.key}=${it.value}" }
                    Log.w(TAG, "jank ${f.frameDurationUiNanos / 1_000_000}ms ui, overrun ${overrun / 1_000_000}ms $states")
                } else if (overrun > 2_000_000L) { // a single missed frame at 120 Hz is still visible; smaller overruns only count in the summary
                    val states = f.states.joinToString(" ") { "${it.key}=${it.value}" }
                    Log.d(TAG, "over ${overrun / 1_000_000}ms $states")
                }
                val now = System.currentTimeMillis()
                if (now - lastSummary > 30_000 && frames > 0) {
                    lastSummary = now
                    Log.i(TAG, "summary frames=$frames jank=$jank over=$over worst=${worstNs / 1_000_000}ms")
                }
            }.also { it.jankHeuristicMultiplier = 2f }
        }.onFailure { Log.w(TAG, "JankStats unavailable: ${it.message}") }
    }

    /** Name what the screen is doing while it lasts (null clears it): shows up on every logged frame. */
    fun state(key: String, value: String?) {
        for (h in holders.values) {
            val st = h.state ?: continue
            if (value == null) st.removeState(key) else st.putState(key, value)
        }
    }

    fun summary(): String = "frames $frames · jank $jank · over budget $over · worst ${worstNs / 1_000_000} ms"
}
