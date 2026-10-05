package com.dhruv.ares

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.widget.Toast

/**
 * Files the Mac sends to the phone ("send this PDF to my phone", a screenshot, the clipboard picture): the
 * notification's Open button downloads them through the paired connection (the pairing cookie goes with the
 * request, so the Mac only serves them to this phone) into Downloads, and opens them with the right app when
 * the download finishes. Nothing is ever fetched from a public link.
 */
object Files {
    private const val KEY = "pendingFiles" // download id → mime, kept so a finished download can be opened

    /** Start the download of a file button ({ api, name, mime, size }). */
    fun fetch(c: Context, api: String, name: String, mime: String) {
        if (!api.startsWith("/api/files/")) return
        val token = Ares.token(c) ?: return
        val url = Uri.parse(Ares.url(c).trimEnd('/') + api + "?download")
        val dm = c.getSystemService(DownloadManager::class.java)
        val safeName = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "file" }
        runCatching {
            val id = dm.enqueue(DownloadManager.Request(url)
                .addRequestHeader("Cookie", "ares_token=$token")
                .setTitle(safeName)
                .setMimeType(mime.ifBlank { "application/octet-stream" })
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeName))
            val p = Ares.prefs(c)
            p.edit().putString(KEY, (p.getString(KEY, "") ?: "") + "$id=$mime;").apply()
            Toast.makeText(c, "Getting $safeName from your Mac…", Toast.LENGTH_SHORT).show()
        }.onFailure { Toast.makeText(c, "Couldn't download it: ${it.message}", Toast.LENGTH_SHORT).show() }
    }

    /** A download finished: if it's one of ours, open it. */
    fun finished(c: Context, id: Long) {
        val p = Ares.prefs(c)
        val all = p.getString(KEY, "") ?: ""
        val entry = all.split(';').firstOrNull { it.startsWith("$id=") } ?: return
        p.edit().putString(KEY, all.replace("$entry;", "")).apply()
        val dm = c.getSystemService(DownloadManager::class.java)
        val uri = runCatching { dm.getUriForDownloadedFile(id) }.getOrNull() ?: return
        val mime = entry.substringAfter('=').ifBlank { dm.getMimeTypeForDownloadedFile(id) ?: "*/*" }
        runCatching {
            c.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        }.onFailure {
            Toast.makeText(c, "Saved to Downloads (no app opens this kind of file).", Toast.LENGTH_SHORT).show()
        }
    }
}

/** Opens a file from the Mac as soon as its download completes. */
class DownloadReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        if (i.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
        val id = i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
        if (id >= 0) Files.finished(c, id)
    }
}

/**
 * Requests made while the Mac was unreachable (asleep, Tailscale off, no signal): kept here and sent, in order,
 * when the live line comes back. Each answer arrives as a notification, so it works even if the app is closed.
 */
object Outbox {
    private const val KEY = "outbox"

    fun add(c: Context, text: String) {
        val p = Ares.prefs(c)
        val list = org.json.JSONArray(p.getString(KEY, "[]")).apply { put(org.json.JSONObject().put("text", text).put("at", System.currentTimeMillis())) }
        while (list.length() > 20) list.remove(0)
        p.edit().putString(KEY, list.toString()).apply()
    }

    fun count(c: Context): Int = org.json.JSONArray(Ares.prefs(c).getString(KEY, "[]")).length()

    /** Take everything queued (oldest first) and clear the queue. */
    fun drain(c: Context): List<String> {
        val p = Ares.prefs(c)
        val list = org.json.JSONArray(p.getString(KEY, "[]"))
        if (list.length() == 0) return emptyList()
        p.edit().remove(KEY).apply()
        return (0 until list.length()).map { list.getJSONObject(it).optString("text") }.filter { it.isNotBlank() }
    }
}
