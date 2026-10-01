package com.dhruv.ares

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Updates from the Mac: `android/build.sh` hands a new build to the phone server, the app hears about
 * it over its live line (or when it next connects) and offers it. One tap downloads it from your Mac,
 * over Tailscale, checks it, and installs it over the old one (your pairing and settings stay).
 */
object Updater {
    private const val CHANNEL = "updates"
    private const val ID = 3

    fun installed(c: Context): Long = c.packageManager.getPackageInfo(c.packageName, 0).longVersionCode
    fun version(c: Context): String = c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: "?"

    fun newer(c: Context, app: JSONObject?) = app != null && app.optLong("versionCode") > installed(c)

    /** A build is on the Mac: offer it (once per version) as a notification. */
    fun offer(c: Context, app: JSONObject?) {
        if (!newer(c, app)) return
        val code = app!!.optLong("versionCode")
        val p = Ares.prefs(c)
        if (p.getLong("offered", 0L) == code) return
        p.edit().putLong("offered", code).apply()
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "When a new build of the ARES app is ready on your Mac."
        })
        nm.notify(ID, Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_ares)
            .setColor(Color.parseColor("#3EE6FF"))
            .setContentTitle("ARES update ready")
            .setContentText("Version ${app.optString("versionName")} is on your Mac. Tap to install.")
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(c, ID, Intent(c, UpdateActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build())
    }

    fun clearOffer(c: Context) = c.getSystemService(NotificationManager::class.java).cancel(ID)

    /** After an update that needed Auto Blocker off: a nudge to switch it back on. */
    fun remindAutoBlocker(c: Context) {
        val p = Ares.prefs(c)
        if (!p.getBoolean("autoBlockerReminder", false)) return
        p.edit().remove("autoBlockerReminder").apply()
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
        nm.notify(6, Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_ares)
            .setColor(Color.parseColor("#3EE6FF"))
            .setContentTitle("ARES updated to ${version(c)}")
            .setContentText("Remember to switch Auto Blocker back on. Tap to open Security and privacy.")
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(c, 6, Intent(Settings.ACTION_SECURITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE))
            .build())
    }

    /** Samsung refused ARES updating herself once: from then on, hand updates to Android's installer. */
    fun handoff(c: Context) = Ares.prefs(c).getBoolean("handoff", false)

    fun blocked(message: String?) = message != null && Regex("self.?update|unknown source|blocked", RegexOption.IGNORE_CASE).containsMatchIn(message)

    /** Download, verify and install (or hand to Android's installer). Blocks: run it off the main thread. */
    fun install(c: Context, progress: (String) -> Unit) {
        val client = AresClient(c)
        val app = client.appInfo() ?: throw IllegalStateException("There's no build on the Mac.")
        if (!newer(c, app)) throw IllegalStateException("You already have the latest version (${version(c)}).")
        progress("Downloading version ${app.optString("versionName")} from your Mac…")
        val file = File(c.cacheDir, "update.apk")
        client.downloadApk(file)
        val sum = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
        if (sum != app.optString("sha256")) { file.delete(); throw IllegalStateException("The download didn't check out. Try again.") }
        if (handoff(c)) return handOver(c, file, app.optString("versionName"), progress)
        progress("Installing…")
        val installer = c.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(c.packageName)
            setSize(file.length())
            // Once ARES has installed itself once, Android can let later updates through without asking
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("ares.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            val done = PendingIntent.getBroadcast(c, id, Intent(c, UpdateReceiver::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            s.commit(done.intentSender)
        }
        file.delete()
        clearOffer(c)
    }

    /**
     * The route Samsung allows: save the update to Downloads and open it with Android's own installer
     * (like tapping an APK in My Files). You tap Update once. The copy in Downloads is a backup.
     */
    private fun handOver(c: Context, file: File, version: String, progress: (String) -> Unit) {
        val downloads = android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val r = c.contentResolver
        // Tidy up older updates ARES saved
        runCatching { r.delete(downloads, "${android.provider.MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?", arrayOf("ARES-%.apk")) }
        val uri = r.insert(downloads, android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, "ARES-$version.apk")
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/vnd.android.package-archive")
            put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
        }) ?: throw IllegalStateException("Couldn't save the update to Downloads.")
        r.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
        r.update(uri, android.content.ContentValues().apply { put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        file.delete()
        clearOffer(c)
        progress("Saved to Downloads as ARES-$version.apk. Tap Update on the next screen.")
        c.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/** Android's answer to an install: ask you to confirm, or report a problem. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return
                try {
                    c.startActivity(confirm) // the update screen is still open, so this is allowed
                } catch (e: Exception) {
                    notify(c, "Tap to finish updating ARES", PendingIntent.getActivity(c, 4, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
                }
            }
            PackageInstaller.STATUS_SUCCESS -> {} // the new version starts itself (BootReceiver)
            else -> {
                Ares.prefs(c).edit().remove("offered").apply() // offer it again next time ARES connects
                val why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "error $status"
                if (Updater.blocked(why)) {
                    // Samsung won't let a sideloaded app update itself: switch to Android's installer, now and from now on
                    Ares.prefs(c).edit().putBoolean("handoff", true).apply()
                    UpdateActivity.retry?.invoke() ?: c.startActivity(Intent(c, UpdateActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    return
                }
                UpdateActivity.failed?.invoke(why)
                if (UpdateActivity.failed == null && status != PackageInstaller.STATUS_FAILURE_ABORTED)
                    notify(c, "ARES update didn't install: $why", null)
            }
        }
    }

    private fun notify(c: Context, text: String, tap: PendingIntent?) {
        c.getSystemService(NotificationManager::class.java).notify(5, Notification.Builder(c, "updates")
            .setSmallIcon(R.drawable.ic_ares).setContentTitle("ARES").setContentText(text).setAutoCancel(true)
            .apply { tap?.let(::setContentIntent) }.build())
    }
}

/** The little "Updating ARES" panel: stays up while the update downloads and installs. */
class UpdateActivity : Activity() {
    companion object {
        @Volatile var failed: ((String) -> Unit)? = null
        @Volatile var retry: (() -> Unit)? = null
    }

    private lateinit var status: TextView
    private var started = false // onResume runs again after Android's confirm screen: install only once
    private var ready = false   // you've seen the Auto Blocker steps and tapped Install

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_update)
        status = findViewById(R.id.status)
        findViewById<ReactorView>(R.id.reactor).state = State.THINKING
        findViewById<View>(R.id.root).setOnClickListener { finish() }
        failed = { why -> runOnUiThread { show("The update didn't install: $why") } }
        retry = { runOnUiThread { started = false; onResume() } }
    }

    override fun onResume() {
        super.onResume()
        if (!packageManager.canRequestPackageInstalls()) {
            Ares.prefs(this).edit().remove("offered").apply() // if you leave it here, it's offered again later
            show("One-time step: allow ARES to install updates. Switch it on, then come back.")
            status.setOnClickListener { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
            status.postDelayed({ status.performClick() }, 1200)
            return
        }
        status.setOnClickListener(null)
        if (started) return
        if (Updater.handoff(this) && !ready) return autoBlocker()
        started = true
        thread {
            try {
                Updater.install(this) { runOnUiThread { show(it) } }
            } catch (e: Exception) {
                runOnUiThread { show(e.message ?: "Couldn't reach the Mac. Is Tailscale on?") }
            }
        }
    }

    /** Samsung's Auto Blocker stops every install that isn't from a store: switch it off briefly. */
    private fun autoBlocker() {
        show("Samsung's Auto Blocker is stopping this update. Switch it off in Security and privacy → Auto Blocker, come back and tap Install. I'll remind you to switch it back on afterwards.")
        findViewById<View>(R.id.buttons).visibility = View.VISIBLE
        findViewById<View>(R.id.openSettings).setOnClickListener { startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) }
        findViewById<View>(R.id.installNow).setOnClickListener {
            ready = true
            Ares.prefs(this).edit().putBoolean("autoBlockerReminder", true).apply()
            findViewById<View>(R.id.buttons).visibility = View.GONE
            onResume()
        }
    }

    override fun onDestroy() {
        failed = null
        retry = null
        super.onDestroy()
    }

    private fun show(text: String) {
        status.text = text
        findViewById<ReactorView>(R.id.reactor).state = if (text.endsWith("…")) State.THINKING else State.IDLE
    }
}
