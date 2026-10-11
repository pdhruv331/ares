package com.dhruv.ares

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build

/**
 * Mac jobs in the system strip (docs/phone-ui-prompt.md §7): each running job or project, and a Mac wake-up, is an Android 16
 * Live Update (Notification.ProgressStyle with segments: planning · running · tests · verifying · done, or queued · working ·
 * done) promoted to a status-bar chip. These are SILENT: they only ever change in place; NEEDS YOU, FAILED and DONE alert
 * through the Mac's own pushes (Notes.show), never from here. Tapping one opens the task receipt. While an approval's
 * undo window is open, the chip carries Undo.
 */
object LiveUpdates {
    const val CH_WORK = "work"
    private const val BASE = 40_000
    private const val WAKE_ID = 39_999
    private val purple = Color.parseColor("#A78BFA")
    private val amber = Color.parseColor("#FFB547")
    private val green = Color.parseColor("#4ADE80")
    private val shown = HashSet<Int>()

    fun channel(c: Context) {
        c.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CH_WORK, "Work in progress", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Live progress of the Mac's jobs and wake-ups: silent, in the status bar."
            setShowBadge(false)
        })
    }

    private fun idFor(job: String) = BASE + (job.hashCode() and 0x7FFF)
    private fun activity(c: Context, i: Intent) = PendingIntent.getActivity(c, Notes.nextId(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /** Bring the strip in line with JobStore: one Live Update per active job, gone when it finishes. */
    fun sync(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        runCatching { channel(c) }
        val active = JobStore.list().filter { it.active || it.undoLeftMs > 0 }
        val want = active.map { idFor(it.id) }.toSet()
        for (id in shown.toList()) if (id !in want) { nm.cancel(id); shown.remove(id) }
        for (j in active) {
            runCatching { nm.notify(idFor(j.id), build(c, j)) }.onSuccess { shown += idFor(j.id) }
        }
    }

    private fun build(c: Context, j: JobStore.Job): Notification {
        val names = j.segmentNames()
        val lit = j.segmentsDone()
        val colour = when (j.status) { "approval" -> amber; "done" -> green; else -> purple }
        val style = Notification.ProgressStyle()
            .setProgressSegments(names.indices.map { i -> Notification.ProgressStyle.Segment(100 / names.size).setColor(if (i < lit) colour else Color.argb(90, 120, 140, 160)) })
            .setProgress(j.percent())
            .setStyledByProgress(false)
        val status = when (j.status) {
            "approval" -> "Needs your OK: ${j.approvalWhat ?: ""}".trim()
            "queued" -> "Queued"
            "running" -> j.lastEvent() ?: j.phaseLine()
            "done" -> "Done"
            "failed" -> "Failed: ${j.error}"
            else -> j.status
        }
        val chip = when { j.undoLeftMs > 0 -> "UNDO ${(j.undoLeftMs / 1000) + 1}s"; j.status == "approval" -> "NEEDS YOU"; j.project -> (j.phase ?: "WORK").uppercase().take(8); else -> "${j.percent()}%" }
        val b = Notification.Builder(c, CH_WORK)
            .setSmallIcon(R.drawable.ic_ares)
            .setColor(colour)
            .setContentTitle(j.title)
            .setContentText(status)
            .setStyle(style)
            .setOngoing(j.active)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setContentIntent(activity(c, ReceiptActivity.intent(c, j.id)))
        promote(b, chip)
        if (j.undoLeftMs > 0) b.addAction(Notification.Action.Builder(null, "Undo", AresService.apiIntent(c, "/api/jobs/${j.id}/undo", "{}", 0)).build())
        else if (j.status == "approval") {
            b.addAction(Notification.Action.Builder(null, "Approve", activity(c, ReceiptActivity.intent(c, j.id, approve = true))).build())
            b.addAction(Notification.Action.Builder(null, "Not now", AresService.apiIntent(c, "/api/jobs/${j.id}/answer", org.json.JSONObject().put("yes", false).put("at", j.approvalAt).put("from", "phone").toString(), 0)).build())
        } else if (j.active) b.addAction(Notification.Action.Builder(null, "Stop", AresService.apiIntent(c, "/api/jobs/${j.id}/cancel", "{}", 0)).build())
        return b.build()
    }

    /** The Mac waking up: a Live Update that fills with the real start-up steps, gone when she's online. */
    fun wake(c: Context, chargeK: Float?, label: String) {
        val nm = c.getSystemService(NotificationManager::class.java)
        if (chargeK == null) { nm.cancel(WAKE_ID); return }
        runCatching { channel(c) }
        val style = Notification.ProgressStyle().setProgress((chargeK * 100).toInt().coerceIn(2, 100)).setStyledByProgress(true)
            .setProgressSegments(listOf(Notification.ProgressStyle.Segment(100).setColor(Color.parseColor("#FAC458"))))
        val b = Notification.Builder(c, CH_WORK).setSmallIcon(R.drawable.ic_ares).setColor(Color.parseColor("#FAC458"))
            .setContentTitle("ARES waking").setContentText(label).setStyle(style).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
            .setCategory(Notification.CATEGORY_PROGRESS).setContentIntent(activity(c, Intent(c, MainActivity::class.java)))
        promote(b, "${(chargeK * 100).toInt()}%")
        runCatching { nm.notify(WAKE_ID, b.build()) }
    }

    /**
     * Ask for the status-bar chip. The request (setRequestPromotedOngoing) arrived in Android 16 QPR1, after the API 36 jar
     * this builds against, so it's called by name; phones without it just keep the ongoing progress notification.
     */
    private fun promote(b: Notification.Builder, chip: String) {
        if (Build.VERSION.SDK_INT < 36) return
        runCatching { b.setShortCriticalText(chip.take(7)) }
        runCatching { Notification.Builder::class.java.getMethod("setRequestPromotedOngoing", java.lang.Boolean.TYPE).invoke(b, true) }
    }

    /** Whether this phone lets ARES post Live Updates (Android 16's per-app "Allow live updates"). */
    fun allowed(c: Context): Boolean = Build.VERSION.SDK_INT >= 36 && runCatching { c.getSystemService(NotificationManager::class.java).canPostPromotedNotifications() }.getOrDefault(false)
}
