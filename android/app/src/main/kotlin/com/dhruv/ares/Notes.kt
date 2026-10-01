package com.dhruv.ares

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * Every notification ARES puts on the phone, whichever way it arrived: the live line to the Mac
 * (AresService), or Firebase through the relay (AresPush), which works with the Mac off. A note that
 * arrives both ways has the same tag, so it shows once (and only alerts once).
 */
object Notes {
    const val CH_STATUS = "status"
    const val CH_ALERTS = "alerts"
    const val CH_REPLIES = "replies"
    const val CH_CALLS = "calls"
    const val CH_URGENT = "calls_urgent"
    const val CH_SPAM = "calls_spam"
    private val ids = AtomicInteger(1000)
    private val cyan = Color.parseColor("#3EE6FF")

    fun channels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Always on", NotificationManager.IMPORTANCE_LOW).apply {
            description = "The persistent ARES notification: talk or reply from here."
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "From ARES", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Timers, reminders and anything ARES sends to your phone."
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 80, 40, 80)
        })
        nm.createNotificationChannel(NotificationChannel(CH_REPLIES, "Replies", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "ARES's answers when you ask from the notification."
        })
        nm.createNotificationChannel(NotificationChannel("updates", "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "When a new build of the ARES app is ready on your Mac."
        })
        nm.createNotificationChannel(NotificationChannel(CH_CALLS, "Calls", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Messages ARES took on your phone line, and results of calls she made for you."
        })
        nm.createNotificationChannel(NotificationChannel(CH_URGENT, "Urgent calls", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Calls that sounded urgent. Loud on purpose."
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 250, 120, 250, 120, 250)
        })
        nm.createNotificationChannel(NotificationChannel(CH_SPAM, "Spam calls", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Sales calls and robocalls ARES dealt with. Silent."
        })
    }

    fun nextId() = ids.incrementAndGet()
    private fun activity(c: Context, i: Intent) = PendingIntent.getActivity(c, nextId(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun safe(url: String) = Uri.parse(url).scheme in setOf("https", "http", "tel", "sms", "smsto", "mailto")
    private fun idFor(tag: String?) = tag?.takeIf { it.isNotBlank() }?.hashCode() ?: nextId()

    /** A notification the Mac sent (timers, reminders, jobs, "send that to my phone"). */
    fun show(c: Context, m: JSONObject) {
        val tag = m.optString("tag").takeIf { it.isNotBlank() }
        val id = idFor(tag)
        val isCall = tag?.startsWith("call-") == true
        val b = Notification.Builder(c, if (isCall) CH_CALLS else CH_ALERTS)
            .setSmallIcon(R.drawable.ic_ares)
            .setColor(cyan)
            .setContentTitle(m.optString("title", "ARES").ifBlank { "ARES" })
            .setContentText(m.optString("body"))
            .setStyle(Notification.BigTextStyle().bigText(m.optString("body")))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(if (isCall) Notification.CATEGORY_MISSED_CALL else Notification.CATEGORY_REMINDER)
        val job = m.optString("job").takeIf { it.isNotBlank() }
        b.setContentIntent(activity(c, when {
            job != null -> WorkActivity.intent(c, job)
            isCall -> CallsActivity.intent(c, tag!!.removePrefix("call-"))
            tag == "calls-digest" -> CallsActivity.intent(c)
            else -> Intent(c, MainActivity::class.java)
        }))
        // Buttons arrive as an array (live line) or as a JSON string (Firebase data messages are all strings)
        val buttons = m.optJSONArray("buttons") ?: m.optString("buttons").takeIf { it.startsWith("[") }?.let { runCatching { JSONArray(it) }.getOrNull() }
        for (i in 0 until (buttons?.length() ?: 0).coerceAtMost(2)) {
            val btn = buttons!!.getJSONObject(i)
            val title = btn.optString("title", "Open")
            val url = btn.optString("url")
            val ask = btn.optString("ask")
            val openJob = btn.optString("job")
            val api = btn.optString("api")
            when {
                // Open: the job in the app. Yes / No, Send to Mac: straight to the Mac's job API, no brain turn;
                // tapping it is the answer (the Mac only accepts it for the exact request that's waiting)
                openJob.isNotBlank() -> b.addAction(Notification.Action.Builder(null, title, activity(c, WorkActivity.intent(c, openJob))).build())
                api.startsWith("/api/jobs/") -> b.addAction(Notification.Action.Builder(null, title, AresService.apiIntent(c, api, btn.optJSONObject("body")?.toString() ?: "{}", id)).build())
                url.isNotBlank() && safe(url) -> b.addAction(Notification.Action.Builder(null, title,
                    activity(c, Intent(if (url.startsWith("tel:")) Intent.ACTION_DIAL else Intent.ACTION_VIEW, Uri.parse(url)))).build())
                ask.isNotBlank() -> b.addAction(Notification.Action.Builder(null, title, AresService.askIntent(c, ask, id)).build())
            }
        }
        c.getSystemService(NotificationManager::class.java).notify(id, b.build())
    }

    /**
     * A call to the ARES line, straight from the relay (works with the Mac off): who, what, and buttons to call
     * back, text back (the composer opens pre-filled; nothing is sent), or read it in the app.
     */
    fun call(c: Context, d: CallStore.Call) {
        val id = idFor("call-${d.id}")
        val cb = d.callback.ifBlank { d.from }
        val b = Notification.Builder(c, when { d.spam -> CH_SPAM; d.urgent -> CH_URGENT; else -> CH_CALLS })
            .setSmallIcon(R.drawable.ic_ares)
            .setColor(if (d.urgent) Color.parseColor("#FFB547") else cyan)
            .setContentTitle(d.title)
            .setContentText(d.body)
            .setStyle(Notification.BigTextStyle().bigText(d.body))
            .setWhen(d.at)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_MISSED_CALL)
            .setContentIntent(activity(c, CallsActivity.intent(c, d.id)))
        if (cb.isNotBlank() && !d.spam) {
            b.addAction(Notification.Action.Builder(null, "Call back", activity(c, Intent(Intent.ACTION_DIAL, Uri.parse("tel:$cb")))).build())
            val hi = if (d.caller.isNotBlank()) "Hi ${d.caller.substringBefore(' ')}, " else "Hi, "
            b.addAction(Notification.Action.Builder(null, "Text reply", activity(c, Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$cb"))
                .putExtra("sms_body", "${hi}sorry I missed your call. "))).build())
        }
        b.addAction(Notification.Action.Builder(null, "Open", activity(c, CallsActivity.intent(c, d.id))).build())
        c.getSystemService(NotificationManager::class.java).notify(id, b.build())
    }
}
