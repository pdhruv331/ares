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
        val list = active.mapNotNull { sbn -> check(svc, sbn, importance(ranking, r, sbn)).first }.sortedByDescending { it.time }.take(8)
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

    private fun importance(ranking: NotificationListenerService.RankingMap?, r: NotificationListenerService.Ranking, sbn: StatusBarNotification) =
        if (ranking != null && ranking.getRanking(sbn.key, r)) r.importance else -1

    /** An orb for this notification, or why not (the reason is what "What ARES sees" shows). */
    private fun check(c: Context, sbn: StatusBarNotification, importance: Int): Pair<Item?, String> {
        val n = sbn.notification
        if (sbn.packageName == c.packageName) return null to "ARES's own"
        if (sbn.packageName == "android" || sbn.packageName == "com.android.systemui") return null to "the system's own"
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return null to "group summary (its messages are separate)"
        if (sbn.isOngoing) return null to "ongoing"
        if (n.category in QUIET) return null to "category ${n.category}"
        if (importance in 0 until android.app.NotificationManager.IMPORTANCE_DEFAULT) return null to "silent (importance $importance)"
        val x = n.extras
        val title = (x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE) ?: x.getCharSequence(Notification.EXTRA_TITLE))?.toString()?.trim().orEmpty()
        val text = (x.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: x.getCharSequence(Notification.EXTRA_TEXT)
            ?: lastMessage(x))?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return null to "no title or text"
        val person = n.category == Notification.CATEGORY_MESSAGE || x.getString(Notification.EXTRA_TEMPLATE)?.contains("MessagingStyle") == true
        val reply = n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
        val app = runCatching { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
        return Item(sbn.key, sbn.packageName, app, title, text, sbn.postTime, person, n.contentIntent, reply, n.flags and Notification.FLAG_AUTO_CANCEL != 0) to "orb"
    }

    /** MessagingStyle's newest message, for notifications that keep their text only there. */
    private fun lastMessage(x: Bundle): CharSequence? = runCatching {
        @Suppress("DEPRECATION") val ms = x.getParcelableArray(Notification.EXTRA_MESSAGES)
        (ms?.lastOrNull() as? Bundle)?.getCharSequence("text")
    }.getOrNull()

    /**
     * What the listener sees right now, for the home menu's check: per notification only the app, category, style, flags,
     * importance and button labels, never its words; and whether it made an orb (or a call), or why not.
     */
    fun explain(c: Context): String {
        val svc = AresNotifs.live
        val head = "Access: ${if (AresNotifs.enabled(c)) "allowed" else "NOT allowed"} · listener: ${if (svc != null) "connected" else "NOT connected"}"
        if (svc == null) return head
        val active = runCatching { svc.activeNotifications }.getOrNull() ?: return "$head\n(couldn't read the notifications)"
        val ranking = runCatching { svc.currentRanking }.getOrNull()
        val r = NotificationListenerService.Ranking()
        val lines = active.filter { it.packageName != c.packageName }.sortedByDescending { it.postTime }.take(20).map { sbn ->
            val n = sbn.notification; val x = n.extras
            val app = runCatching { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
            val style = x.getString(Notification.EXTRA_TEMPLATE)?.substringAfterLast('$')?.removeSuffix("Style") ?: "plain"
            val flags = listOfNotNull("ongoing".takeIf { sbn.isOngoing }, "summary".takeIf { n.flags and Notification.FLAG_GROUP_SUMMARY != 0 },
                "fullscreen".takeIf { n.fullScreenIntent != null }, x.getInt(Notification.EXTRA_CALL_TYPE, -1).takeIf { it >= 0 }?.let { "calltype $it" })
            val buttons = n.actions.orEmpty().mapNotNull { it.title?.toString() }.joinToString(", ")
            val result = if (parseCall(sbn) != null) "INCOMING CALL" else check(c, sbn, importance(ranking, r, sbn)).second.let { if (it == "orb") "ORB" else "no orb: $it" }
            "• $app · ${n.category ?: "no category"} · $style · imp ${importance(ranking, r, sbn)}${if (flags.isEmpty()) "" else " · " + flags.joinToString(" ")}" +
                (if (buttons.isEmpty()) "" else "\n   buttons: $buttons") + "\n   → $result"
        }
        return head + "\n\n" + (if (lines.isEmpty()) "(no notifications from other apps)" else lines.joinToString("\n"))
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
        // Ringing: CallStyle's incoming type, or any call notification with an answer button (Samsung's dialer may not use CallStyle;
        // an ongoing call's notification has hang-up, not answer)
        if (type != 1 && !(type == -1 && answer != null)) return null
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
