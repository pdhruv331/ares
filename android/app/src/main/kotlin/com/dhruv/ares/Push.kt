package com.dhruv.ares

import android.app.Application
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import kotlin.concurrent.thread

/** Starts before anything else in the process, including a Firebase message that wakes the app up. */
class AresApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notes.channels(this)
        Scheme.load(this)
        Push.init(this)
    }
}

/**
 * Firebase Cloud Messaging, used only to receive pushes (no analytics, nothing else). The app has no
 * google-services.json: the Mac hands over the Firebase app config (from its support folder) when the app
 * connects, and the phone's push token goes back to the Mac, which registers it with the relay.
 */
object Push {
    private fun options(c: Context): FirebaseOptions? {
        val o = Ares.prefs(c).getString("firebase", null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        if (o.optString("appId").isBlank() || o.optString("apiKey").isBlank()) return null
        return FirebaseOptions.Builder()
            .setApplicationId(o.optString("appId"))
            .setApiKey(o.optString("apiKey"))
            .setProjectId(o.optString("projectId"))
            .setGcmSenderId(o.optString("senderId"))
            .build()
    }

    /** Firebase is ready (configured and started in this process). */
    fun init(c: Context): Boolean {
        if (FirebaseApp.getApps(c).isNotEmpty()) return true
        val opts = options(c) ?: return false
        return runCatching { FirebaseApp.initializeApp(c, opts); FirebaseMessaging.getInstance().isAutoInitEnabled = true; true }.getOrDefault(false)
    }

    /** From the Mac's hello: save the config (a change needs the app restarted), start Firebase, send the token. */
    fun configure(c: Context, fb: JSONObject?, resend: Boolean) {
        if (fb == null) return
        val prefs = Ares.prefs(c)
        if (prefs.getString("firebase", null) != fb.toString()) prefs.edit().putString("firebase", fb.toString()).remove("fcmSent").apply()
        if (resend) prefs.edit().remove("fcmSent").apply()
        if (init(c)) register(c)
    }

    /** Hand the current push token to the Mac, if it doesn't have it yet. */
    fun register(c: Context) {
        if (FirebaseApp.getApps(c).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (token.isNullOrBlank() || Ares.prefs(c).getString("fcmSent", null) == token) return@addOnSuccessListener
            thread(name = "ares-fcm") {
                runCatching { AresClient(c).pushToken(token) }
                    .onSuccess { Ares.prefs(c).edit().putString("fcmSent", token).apply() }
            }
        }
    }
}

/** Pushes from the relay: calls to the ARES line, and the Mac's own notifications. */
class AresPush : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Ares.prefs(this).edit().remove("fcmSent").apply()
        Push.register(this) // reaches the Mac next time it's reachable (hello re-sends it if not)
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        if (!Ares.paired(this)) return
        when (d["type"]) {
            "call" -> CallStore.fromPush(d)?.let { call -> CallStore.add(this, call); Notes.call(this, call) }
            "note" -> Notes.show(this, JSONObject(d as Map<*, *>))
        }
    }
}
