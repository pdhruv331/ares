package com.dhruv.ares

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.text.format.DateUtils
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews

/**
 * Home-screen widget, resizable from a single orb up to a whole empty home page. Android picks the
 * richest layout that fits: orb → bar → card → full page (with the conversation and quick asks).
 */
class AresWidget : AppWidgetProvider() {
    companion object {
        /** Quick asks on the full-page widget: label to question. */
        private val QUICK = listOf(
            "Brief me" to "Give me a quick brief: what's on my calendar today, and anything important in my inbox?",
            "What's next?" to "What's next on my calendar?",
            "10-min timer" to "Set a 10 minute timer on my phone.",
        )

        fun refresh(c: Context) {
            val m = AppWidgetManager.getInstance(c)
            val ids = m.getAppWidgetIds(ComponentName(c, AresWidget::class.java))
            if (ids.isNotEmpty()) m.updateAppWidget(ids, views(c))
        }

        fun views(c: Context) = RemoteViews(mapOf(
            SizeF(40f, 40f) to build(c, R.layout.widget_orb),
            SizeF(170f, 40f) to build(c, R.layout.widget_bar),
            SizeF(170f, 120f) to build(c, R.layout.widget_card),
            SizeF(260f, 330f) to build(c, R.layout.widget_page),
        ))

        private fun open(c: Context, code: Int, i: Intent) =
            PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        private fun build(c: Context, layout: Int): RemoteViews {
            val v = RemoteViews(c.packageName, layout)
            val p = Ares.prefs(c)
            val status = Ares.status(c)
            val talk = open(c, 10, if (Ares.paired(c)) AskActivity.intent(c, listen = true) else Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            v.setOnClickPendingIntent(R.id.w_orb, talk)
            v.setInt(R.id.w_orb, "setImageAlpha", if (status == "online") 255 else 130)
            if (layout == R.layout.widget_orb) return v

            v.setOnClickPendingIntent(R.id.w_talk, talk)
            v.setOnClickPendingIntent(R.id.w_reply, open(c, 12, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)))
            val reply = p.getString("lastReply", null)
            v.setTextViewText(R.id.w_reply, when {
                status == "unpaired" -> "Tap to pair with your Mac."
                reply.isNullOrBlank() -> "At your service, sir."
                else -> reply
            })
            if (layout == R.layout.widget_bar) return v

            v.setOnClickPendingIntent(R.id.w_type, open(c, 11, AskActivity.intent(c, type = true)))
            // Jobs on the Mac: "2 WORKING · 1 NEEDS OK", and a tap opens Work
            val jobs = p.getString("jobs", null)?.uppercase()?.replace(Regex("JOBS? "), "")?.replace("NEEDS YOUR OK", "NEEDS OK")?.replace("NEED YOUR OK", "NEED OK")
            v.setTextViewText(R.id.w_status, when (status) { "online" -> jobs ?: "ONLINE"; "offline" -> "MAC OFFLINE"; else -> "NOT PAIRED" })
            v.setInt(R.id.w_status, "setTextColor", if (status == "online" && jobs?.contains("OK") != true) 0xFF3EE6FF.toInt() else 0xFFFFB547.toInt())
            if (Ares.paired(c)) v.setOnClickPendingIntent(R.id.w_status, open(c, 13, WorkActivity.intent(c)))
            if (layout == R.layout.widget_card) return v

            val said = p.getString("lastSaid", null)
            v.setTextViewText(R.id.w_said, said ?: "")
            v.setViewVisibility(R.id.w_said, if (said.isNullOrBlank()) View.GONE else View.VISIBLE)
            val at = p.getLong("lastAt", 0L)
            v.setTextViewText(R.id.w_when, if (at > 0) DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS) else "")
            val chips = listOf(R.id.w_q1, R.id.w_q2, R.id.w_q3)
            QUICK.forEachIndexed { i, (label, question) ->
                v.setTextViewText(chips[i], label)
                v.setOnClickPendingIntent(chips[i], open(c, 20 + i, AskActivity.intent(c, ask = question)))
            }
            return v
        }
    }

    override fun onUpdate(c: Context, m: AppWidgetManager, ids: IntArray) {
        m.updateAppWidget(ids, views(c))
        AresService.start(c) // keeps her status fresh
    }
}
