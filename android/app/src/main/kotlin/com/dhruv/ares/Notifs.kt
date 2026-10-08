package com.dhruv.ares

import android.app.ActivityOptions
import android.app.Notification
import android.app.PendingIntent
import android.app.Person
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The phone's notifications for the home screen (docs/launcher-v2-prompt.md §5), with the user's Notification access.
 * Nothing here leaves the phone: the home screen shows them as orbs around the reactor, and only "Summarise" (a tap)
 * sends their text to ARES on the Mac.
 */
class AresNotifs : NotificationListenerService() {
    override fun onListenerConnected() { live = this; NotifStore.sync(this, null) }
    override fun onListenerDisconnected() { if (live === this) live = null; NotifStore.clear() }
    override fun onNotificationPosted(sbn: StatusBarNotification, rm: RankingMap) = NotifStore.sync(this, sbn.key)
    override fun onNotificationRemoved(sbn: StatusBarNotification, rm: RankingMap) = NotifStore.sync(this, null)

    companion object {
        @Volatile var live: AresNotifs? = null
            private set
        fun enabled(c: Context) = Settings.Secure.getString(c.contentResolver, "enabled_notification_listeners")
            ?.contains(ComponentName(c, AresNotifs::class.java).flattenToString()) == true
        /** The system page where Notification access for ARES is switched on. */
        fun settings(c: Context) = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(c, AresNotifs::class.java).flattenToString())
    }
}

object NotifStore {
    /** A notification worth an orb. `person` = someone is waiting (a message), drawn amber. */
    data class Item(
        val key: String, val pkg: String, val app: String, val title: String, val text: String, val time: Long,
        val person: Boolean, val content: PendingIntent?, val reply: Notification.Action?, val autoCancel: Boolean,
    )
    /** An incoming call (a ringing CATEGORY_CALL notification) and its own answer / decline. */
    data class Call(val key: String, val name: String, val answer: PendingIntent?, val decline: PendingIntent?, val content: PendingIntent?)

    @Volatile var items: List<Item> = emptyList()
        private set
    @Volatile var call: Call? = null
        private set
    private var seen = emptySet<String>()
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<(arrived: Item?) -> Unit>()
    fun listen(l: (Item?) -> Unit) { listeners += l }
    fun unlisten(l: (Item?) -> Unit) { listeners -= l }

    fun clear() { items = emptyList(); call = null; seen = emptySet(); main.post { for (l in listeners) l(null) } }

    /** Re-read what's showing; `posted` = the key that just arrived (a spark if it's new and makes an orb). */
    fun sync(svc: NotificationListenerService, posted: String?) {
        val active = runCatching { svc.activeNotifications }.getOrNull() ?: return
        val ranking = runCatching { svc.currentRanking }.getOrNull()
        val r = NotificationListenerService.Ranking()
        val list = active.mapNotNull { sbn ->
            val important = ranking == null || !ranking.getRanking(sbn.key, r) || r.importance >= android.app.NotificationManager.IMPORTANCE_DEFAULT
            if (important) parse(svc, sbn) else null
        }.sortedByDescending { it.time }.take(8)
        call = active.firstNotNullOfOrNull { parseCall(it) }
        val arrived = posted?.let { k -> list.firstOrNull { it.key == k && k !in seen } }
        items = list
        seen = list.map { it.key }.toSet()
        main.post { for (l in listeners) l(arrived) }
    }

    // Not worth an orb: calls (their own view), media, and the system's own chatter
    private val QUIET = setOf(Notification.CATEGORY_CALL, Notification.CATEGORY_TRANSPORT, Notification.CATEGORY_SYSTEM,
        Notification.CATEGORY_SERVICE, Notification.CATEGORY_PROGRESS, Notification.CATEGORY_STATUS)

    /** Development only (HomeActivity's TEST_CALL broadcast in debug builds): pretend a call is ringing, or stop. */
    fun testCall(name: String?) { call = name?.let { Call("test", it, null, null, null) }; main.post { for (l in listeners) l(null) } }

    private fun parse(c: Context, sbn: StatusBarNotification): Item? {
        val n = sbn.notification
        if (sbn.packageName == c.packageName) return null // (her own: the status line, job notices)
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return null
        if (sbn.isOngoing || n.category in QUIET) return null
        val x = n.extras
        val title = (x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE) ?: x.getCharSequence(Notification.EXTRA_TITLE))?.toString()?.trim().orEmpty()
        val text = (x.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: x.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return null
        val person = n.category == Notification.CATEGORY_MESSAGE || x.getString(Notification.EXTRA_TEMPLATE)?.contains("MessagingStyle") == true
        val reply = n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
        val app = runCatching { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
        return Item(sbn.key, sbn.packageName, app, title, text, sbn.postTime, person, n.contentIntent, reply, n.flags and Notification.FLAG_AUTO_CANCEL != 0)
    }

    private fun parseCall(sbn: StatusBarNotification): Call? {
        val n = sbn.notification
        if (n.category != Notification.CATEGORY_CALL) return null
        val x = n.extras
        val type = x.getInt(Notification.EXTRA_CALL_TYPE, -1)
        val actions = n.actions.orEmpty()
        fun action(vararg words: String) = actions.firstOrNull { a -> words.any { a.title?.toString()?.contains(it, ignoreCase = true) == true } }?.actionIntent
        val answer = x.getParcelable(Notification.EXTRA_ANSWER_INTENT, PendingIntent::class.java) ?: action("answer", "accept")
        val decline = x.getParcelable(Notification.EXTRA_DECLINE_INTENT, PendingIntent::class.java) ?: action("decline", "reject")
        // Ringing: CallStyle's incoming type, or (older dialers) a full-screen notification with an answer button
        if (type != 1 && !(type == -1 && n.fullScreenIntent != null && answer != null)) return null
        val name = x.getParcelable(Notification.EXTRA_CALL_PERSON, Person::class.java)?.name?.toString()
            ?: x.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: "Unknown caller"
        return Call(sbn.key, name, answer, decline, n.contentIntent)
    }

    /** Fire another app's PendingIntent from the home screen (in front, so it may start that app's screen). */
    fun fire(c: Context, pi: PendingIntent?, fill: Intent? = null): Boolean {
        pi ?: return false
        val opts = ActivityOptions.makeBasic().setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED).toBundle()
        return runCatching { pi.send(c, 0, fill, null, null, null, opts) }.isSuccess
    }

    fun open(c: Context, item: Item) {
        fire(c, item.content)
        if (item.autoCancel) dismiss(item)
    }

    fun dismiss(item: Item) { runCatching { AresNotifs.live?.cancelNotification(item.key) } }

    /** Answer through the notification's own reply action (what the app would get from its inline reply box). */
    fun reply(c: Context, item: Item, text: String): Boolean {
        val a = item.reply ?: return false
        val inputs = a.remoteInputs ?: return false
        val fill = Intent()
        RemoteInput.addResultsToIntent(inputs, fill, Bundle().apply { for (ri in inputs) putCharSequence(ri.resultKey, text) })
        RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT)
        return runCatching { a.actionIntent.send(c, 0, fill) }.isSuccess
    }
}
