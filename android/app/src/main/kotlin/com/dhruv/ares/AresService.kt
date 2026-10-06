package com.dhruv.ares

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Keeps ARES with you: the persistent notification (Talk, and reply without opening anything), a live
 * line to the Mac so her notifications arrive, and the floating bubble.
 */
class AresService : Service() {
    companion object {
        private const val CH_STATUS = Notes.CH_STATUS
        private const val CH_ALERTS = Notes.CH_ALERTS
        private const val CH_REPLIES = Notes.CH_REPLIES
        private const val ID_STATUS = 1
        private const val ID_REPLY = 2
        private const val ACTION_REPLY = "com.dhruv.ares.REPLY"
        private const val ACTION_ASK = "com.dhruv.ares.ASK"
        private const val ACTION_BUBBLE = "com.dhruv.ares.BUBBLE"
        private const val ACTION_RECONNECT = "com.dhruv.ares.RECONNECT"
        private const val ACTION_API = "com.dhruv.ares.API"
        private const val ACTION_FILE = "com.dhruv.ares.FILE"
        private const val KEY_TEXT = "text"

        // Android can refuse to start it from the background; it's started again when you next open ARES
        fun start(c: Context) { if (Ares.paired(c)) runCatching { c.startForegroundService(Intent(c, AresService::class.java)) } }
        fun stop(c: Context) { c.stopService(Intent(c, AresService::class.java)) }
        /** A notification button that asks ARES something in the background. */
        fun askIntent(c: Context, text: String, id: Int): PendingIntent = PendingIntent.getService(
            c, Notes.nextId(), Intent(c, AresService::class.java).setAction(ACTION_ASK).putExtra(KEY_TEXT, text).putExtra("id", id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        /** A notification button that calls the Mac's job API (Yes / No / Send to Mac). */
        fun apiIntent(c: Context, api: String, body: String, id: Int): PendingIntent = PendingIntent.getService(
            c, Notes.nextId(), Intent(c, AresService::class.java).setAction(ACTION_API).putExtra("api", api).putExtra("body", body).putExtra("id", id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        /** A notification button you type into (Reply): the text goes to ARES after `prefix` ("Reply to the … session: "). */
        fun replyIntent(c: Context, prefix: String, id: Int): PendingIntent = PendingIntent.getService(
            c, Notes.nextId(), Intent(c, AresService::class.java).setAction(ACTION_REPLY).putExtra("prefix", prefix).putExtra("id", id),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun replyInput(label: String = "Reply…"): RemoteInput = RemoteInput.Builder(KEY_TEXT).setLabel(label).build()
        /** A notification button that downloads a file the Mac sent (through the paired connection) and opens it. */
        fun fileIntent(c: Context, api: String, name: String, mime: String, id: Int): PendingIntent = PendingIntent.getService(
            c, Notes.nextId(), Intent(c, AresService::class.java).setAction(ACTION_FILE).putExtra("api", api).putExtra("name", name).putExtra("mime", mime).putExtra("id", id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun restart(c: Context) { if (Ares.paired(c)) runCatching { c.startForegroundService(Intent(c, AresService::class.java).setAction(ACTION_RECONNECT)) } }
    }

    private val main = Handler(Looper.getMainLooper())
    private val stop = AtomicBoolean()
    private var line: AtomicBoolean? = null // stop flag for the current connection
    private val lock = Object()
    private val ids = AtomicInteger(100)
    private var bubble: Bubble? = null
    private var asking: String? = null
    private lateinit var nm: NotificationManager
    private val client by lazy { AresClient(this) }

    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(n: Network) = wake() // e.g. back on Wi-Fi, or Tailscale reconnected
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private var jobLine: String? = null
    private val jobsChanged: () -> Unit = {
        val line = JobStore.summary()
        if (line != jobLine) { jobLine = line; refresh() }
        bubble?.update()
    }

    override fun onCreate() {
        super.onCreate()
        JobStore.listen(jobsChanged)
        nm = getSystemService(NotificationManager::class.java)
        Notes.channels(this)
        startForeground(ID_STATUS, status(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network)
        thread(name = "ares-events", isDaemon = true) { listen() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Ares.paired(this)) { stopSelf(); return START_NOT_STICKY }
        when (intent?.action) {
            ACTION_REPLY -> RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_TEXT)?.toString()?.takeIf { it.isNotBlank() }?.let { text ->
                intent.getIntExtra("id", 0).takeIf { it != 0 }?.let(nm::cancel) // a Reply on an alert: that alert is answered
                askInBackground((intent.getStringExtra("prefix") ?: "") + text)
            }
            ACTION_ASK -> {
                nm.cancel(intent.getIntExtra("id", 0)) // the notification whose button this was
                intent.getStringExtra(KEY_TEXT)?.let(::askInBackground)
            }
            ACTION_API -> {
                nm.cancel(intent.getIntExtra("id", 0))
                callApi(intent.getStringExtra("api") ?: "", intent.getStringExtra("body") ?: "{}")
            }
            ACTION_FILE -> {
                nm.cancel(intent.getIntExtra("id", 0))
                Files.fetch(this, intent.getStringExtra("api") ?: "", intent.getStringExtra("name") ?: "file", intent.getStringExtra("mime") ?: "")
            }
            ACTION_BUBBLE -> Ares.prefs(this).edit().putBoolean("bubble", bubble == null).apply()
            ACTION_RECONNECT -> { line?.set(true); wake() }
        }
        syncBubble()
        refresh()
        return START_STICKY
    }

    override fun onDestroy() {
        JobStore.unlisten(jobsChanged)
        stop.set(true)
        line?.set(true)
        wake()
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network) }
        bubble?.hide()
        bubble = null
        super.onDestroy()
    }

    // ---- The live line to the Mac ------------------------------------------------------------------

    private fun listen() {
        var backoff = 2_000L
        while (!stop.get() && Ares.paired(this)) {
            val flag = AtomicBoolean().also { line = it }
            try {
                client.events(flag) { m ->
                    when (m.optString("type")) {
                        "hello" -> {
                            backoff = 2_000L; online("online"); Updater.offer(this, m.optJSONObject("app"))
                            PowerStore.fromHello(this, m)
                            // Firebase (for pushes with the Mac off): the Mac hands over the app config; the token goes back
                            Push.configure(this, m.optJSONObject("firebase"), resend = !m.optBoolean("fcm"))
                            thread { runCatching { JobStore.replaceAll(this, client.jobs()) } }
                            // Requests queued while the Mac was away: send them now, answers come as notifications
                            for (text in Outbox.drain(this)) askInBackground(text, queued = true)
                        }
                        "update" -> Updater.offer(this, m.optJSONObject("app"))
                        "notify" -> main.post { show(m) }
                        // Work: live job changes, notifications seen or answered elsewhere, "send this to my phone"
                        "job" -> m.optJSONObject("job")?.let { JobStore.update(this, it) }
                        "job-removed" -> JobStore.remove(this, m.optString("id"))
                        "clear" -> m.optJSONArray("tags")?.let { t -> main.post { for (i in 0 until t.length()) nm.cancel(t.getString(i).hashCode()) } }
                        "show-job" -> JobStore.show(m.optString("id"))
                        "calls" -> CallStore.changed()
                        // Power (docs/ignition-prompt.md §4d): the Mac's standby / wake / power down, and the charge's steps
                        "power" -> { PowerStore.fromPower(this, m); main.post { refresh() } }
                        "power-step" -> PowerStore.step(m)
                    }
                }
            } catch (e: NotPairedException) {
                Ares.prefs(this).edit().remove("token").apply()
                online("unpaired")
                main.post {
                    nm.notify(ID_REPLY, Notification.Builder(this, CH_ALERTS)
                        .setSmallIcon(R.drawable.ic_ares)
                        .setContentTitle("ARES: this phone was unpaired")
                        .setContentText("Tap to pair again with a new code from your Mac.")
                        .setAutoCancel(true)
                        .setContentIntent(pending(Intent(this, MainActivity::class.java)))
                        .build())
                    stopSelf()
                }
                return
            } catch (e: Exception) {
                // offline: Mac asleep, Tailscale off, or no signal
            }
            if (stop.get()) return
            online("offline")
            synchronized(lock) { lock.wait(backoff) }
            backoff = (backoff * 2).coerceAtMost(60_000L)
        }
    }

    private fun wake() = synchronized(lock) { lock.notifyAll() }

    private fun online(s: String) {
        Ares.setStatus(this, s)
        PowerStore.setReach(this, s == "online")
        main.post { refresh() }
    }

    private fun refresh() {
        if (stop.get()) return
        nm.notify(ID_STATUS, status())
        bubble?.update()
    }

    // ---- Notifications ------------------------------------------------------------------------------

    private fun pending(i: Intent) = PendingIntent.getActivity(this, ids.incrementAndGet(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun service(action: String, text: String? = null, mutable: Boolean = false, id: Int = 0) = PendingIntent.getService(
        this, ids.incrementAndGet(), Intent(this, AresService::class.java).setAction(action).putExtra(KEY_TEXT, text).putExtra("id", id),
        (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE) or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun replyAction(label: String) = Notification.Action.Builder(null, label, service(ACTION_REPLY, mutable = true))
        .addRemoteInput(RemoteInput.Builder(KEY_TEXT).setLabel("Ask ARES…").build())
        .setAllowGeneratedReplies(false)
        .build()

    private fun status(): Notification {
        val text = when {
            asking != null -> "Thinking about \"${asking!!.take(60)}\"…"
            Ares.status(this) == "online" && PowerStore.mode == PowerStore.Mode.STANDBY -> "Standing by · ${JobStore.summary() ?: "nothing running"}"
            Ares.status(this) == "online" && PowerStore.mode == PowerStore.Mode.OFFLINE -> "Powered down · hold the orb to wake"
            Ares.status(this) == "online" -> JobStore.summary() ?: "Connected to your Mac"
            else -> "Can't reach your Mac. Retrying (is Tailscale on?)"
        }
        // With jobs going, a tap goes to Work (where an OK might be waiting)
        val open = if (JobStore.summary() != null) WorkActivity.intent(this) else Intent(this, MainActivity::class.java)
        return Notification.Builder(this, CH_STATUS)
            .setSmallIcon(R.drawable.ic_ares)
            .setColor(Color.parseColor("#3EE6FF"))
            .setContentTitle("ARES")
            .setContentText(text)
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(pending(open))
            .addAction(Notification.Action.Builder(null, "Talk", pending(AskActivity.intent(this, listen = true))).build())
            .addAction(replyAction("Type"))
            .addAction(bubbleAction())
            .build()
    }

    private fun bubbleAction(): Notification.Action {
        val allowed = Settings.canDrawOverlays(this)
        val target = if (allowed) service(ACTION_BUBBLE)
            else pending(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return Notification.Action.Builder(null, if (bubble != null) "Hide bubble" else "Show bubble", target).build()
    }

    /** A notification the Mac sent (timers, reminders, "send that to my phone"). */
    private fun show(m: JSONObject) = Notes.show(this, m)

    /** A notification button that acts through the Mac's job API. Only a problem (or Send to Mac's answer) is shown. */
    private fun callApi(api: String, body: String) {
        if (!api.startsWith("/api/jobs/") && !api.startsWith("/api/claude/") && !api.startsWith("/api/power/")) return
        thread(name = "ares-job-api") {
            val r = runCatching { if (api.startsWith("/api/power/")) client.powerAct(api.removePrefix("/api/power/")) else client.post(api, JSONObject(body)) }.getOrElse { JSONObject().put("error", "Couldn't reach your Mac.") }
            val line = when {
                !r.optBoolean("ok") -> r.optString("error").ifBlank { r.optString("message").ifBlank { "That didn't work." } }
                api.startsWith("/api/power/") -> r.optString("message").ifBlank { null }
                api.endsWith("/send-to-mac") -> if (r.optBoolean("now")) "It's open on your Mac now." else "It'll open on your Mac when you're back at it."
                else -> null
            }
            line?.let { text ->
                main.post {
                    nm.notify(ID_REPLY, Notification.Builder(this, CH_REPLIES).setSmallIcon(R.drawable.ic_ares).setColor(Color.parseColor("#3EE6FF"))
                        .setContentTitle("ARES").setContentText(text).setAutoCancel(true).setTimeoutAfter(15_000).build())
                }
            }
        }
    }

    private fun safe(url: String) = Uri.parse(url).scheme in setOf("https", "http", "tel", "sms", "smsto", "mailto")

    /**
     * Asked from the notification: ARES answers as a notification, no screen needed. If the Mac can't be reached the
     * request is queued (Outbox) and goes when the live line is back; `queued` marks such a replay.
     */
    private fun askInBackground(text: String, queued: Boolean = false) {
        if (text.isBlank()) return
        asking = text
        refresh()
        Ares.saveLast(this, text, null)
        thread(name = "ares-bg-ask") {
            var reply = ""
            val links = mutableListOf<Pair<String, String>>()
            try {
                client.ask(text, voice = false, on = AresClient.Listener(
                    text = { reply = it },
                    action = { url, label -> links += url to label },
                    done = { reply = it },
                ))
                Ares.setStatus(this, "online")
            } catch (e: NotPairedException) {
                reply = "This phone isn't paired with the Mac any more."
            } catch (e: Exception) {
                Ares.setStatus(this, "offline")
                if (!queued) Outbox.add(this, text)
                reply = if (queued) "Your Mac went away again before I could answer; I'll try once more when it's back."
                else "Your Mac is offline right now, sir. I've kept this and will send it the moment it's back${Outbox.count(this).let { if (it > 1) " ($it waiting)" else "" }}."
            }
            Ares.saveLast(this, null, reply)
            main.post {
                asking = null
                refresh()
                val b = Notification.Builder(this, CH_REPLIES)
                    .setSmallIcon(R.drawable.ic_ares)
                    .setColor(Color.parseColor("#3EE6FF"))
                    .setContentTitle((if (queued) "While your Mac was away: " else "") + text.take(80))
                    .setContentText(reply)
                    .setStyle(Notification.BigTextStyle().bigText(reply))
                    .setAutoCancel(true)
                    .setContentIntent(pending(Intent(this, MainActivity::class.java)))
                for ((url, label) in links.filter { safe(it.first) }.take(2))
                    b.addAction(Notification.Action.Builder(null, label.take(30), pending(Intent(Intent.ACTION_VIEW, Uri.parse(url)))).build())
                b.addAction(replyAction("Reply"))
                nm.notify(ID_REPLY, b.build())
            }
        }
    }

    // ---- Bubble -------------------------------------------------------------------------------------

    private fun syncBubble() {
        val want = Ares.bubbleOn(this) && Settings.canDrawOverlays(this)
        if (want && bubble == null) bubble = Bubble(this) { Ares.prefs(this).edit().putBoolean("bubble", false).apply(); bubble = null; refresh() }.also { it.show() }
        if (!want && bubble != null) { bubble?.hide(); bubble = null }
    }
}
