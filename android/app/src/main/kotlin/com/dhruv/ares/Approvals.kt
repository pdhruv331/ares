package com.dhruv.ares

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.widget.EditText
import android.widget.Toast
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Approvals on the phone (docs/phone-ui-prompt.md §7): every job approval is tier 3 (control.js), so APPROVE asks for the
 * owner's fingerprint (or the screen lock) on the phone itself before the yes goes to the Mac; EDIT sends a change for the
 * worker to apply before it asks again; NOT NOW declines. After a yes the Mac holds the action for ~10 s, and UNDO withdraws it.
 */
object Approvals {
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    private fun answer(c: Context, id: String, body: JSONObject, done: (JSONObject?) -> Unit) {
        thread(name = "ares-approval") {
            val r = runCatching { AresClient(c).post("/api/jobs/$id/answer", body) }.getOrNull()
            main.post { done(r) }
        }
    }

    private fun toast(c: Context, r: JSONObject?, ok: String) {
        val err = if (r == null) "I couldn't reach the Mac, sir." else if (!r.optBoolean("ok")) r.optString("error").ifBlank { "That didn't work." } else null
        Toast.makeText(c, err ?: ok, Toast.LENGTH_SHORT).show()
    }

    /** APPROVE: the fingerprint first (tier 3 on the phone itself), then the yes for exactly the request that's waiting. */
    fun approve(act: Activity, id: String, onDone: (Boolean) -> Unit = {}) {
        val job = JobStore.get(id) ?: return
        val send = {
            Haptics.commit(act)
            answer(act, id, JSONObject().put("yes", true).put("at", job.approvalAt).put("from", "phone")) { r ->
                toast(act, r, "Approved: ${job.title}. Undo for 10 s in the receipt.")
                onDone(r?.optBoolean("ok") == true)
            }
        }
        val bm = act.getSystemService(BiometricManager::class.java)
        val auth = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val can = runCatching { bm.canAuthenticate(auth) }.getOrDefault(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE)
        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
            // No fingerprint or screen lock on this phone: say so, and still ask for a deliberate yes
            AlertDialog.Builder(act).setTitle("Approve: ${job.title}")
                .setMessage("${job.approvalWhat ?: "The job is asking for your OK."}\n\nThis phone has no fingerprint or screen lock set, so ARES can't check it's you. Approve anyway?")
                .setPositiveButton("Approve") { _, _ -> send() }.setNegativeButton("Cancel", null).show()
            return
        }
        val prompt = BiometricPrompt.Builder(act)
            .setTitle("Approve: ${job.title.take(40)}")
            .setSubtitle(job.approvalWhat?.take(120) ?: "The job is asking for your OK")
            .setDescription(job.check?.let { ch -> if (ch.optBoolean("ok")) "Outgoing check: passed." else "OUTGOING CHECK FAILED: ${ch.optString("reason")}" } ?: "")
            .setAllowedAuthenticators(auth)
            .setConfirmationRequired(false)
            .build()
        prompt.authenticate(CancellationSignal(), act.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = send()
            override fun onAuthenticationError(code: Int, msg: CharSequence) { if (code != BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED && code != 13 /* negative button */ && code != BiometricPrompt.BIOMETRIC_ERROR_CANCELED) Toast.makeText(act, msg, Toast.LENGTH_SHORT).show() }
        })
    }

    /** EDIT: what should change before it runs; the worker applies it and asks again. */
    fun edit(act: Activity, id: String, onDone: (Boolean) -> Unit = {}) {
        val job = JobStore.get(id) ?: return
        val dp = act.resources.displayMetrics.density
        val field = EditText(act).apply {
            hint = "What should change? e.g. \"send it to work, not personal\""
            setText(""); minLines = 2; setPadding((20 * dp).toInt(), (12 * dp).toInt(), (20 * dp).toInt(), (12 * dp).toInt())
        }
        AlertDialog.Builder(act).setTitle("Before it runs").setMessage(job.approvalWhat ?: job.title).setView(field)
            .setPositiveButton("Send change") { _, _ ->
                val text = field.text.toString().trim()
                if (text.isEmpty()) return@setPositiveButton
                answer(act, id, JSONObject().put("yes", false).put("at", job.approvalAt).put("edit", text).put("from", "phone")) { r -> toast(act, r, "Sent. It'll ask again with the change."); onDone(r?.optBoolean("ok") == true) }
            }.setNegativeButton("Cancel", null).show()
    }

    /** NOT NOW: a plain no. */
    fun notNow(c: Context, id: String, onDone: (Boolean) -> Unit = {}) {
        val job = JobStore.get(id) ?: return
        answer(c, id, JSONObject().put("yes", false).put("at", job.approvalAt).put("from", "phone")) { r -> toast(c, r, "Declined."); onDone(r?.optBoolean("ok") == true) }
    }

    /** UNDO within the window after a yes: the action hasn't run yet; it's withdrawn. */
    fun undo(c: Context, id: String, onDone: (Boolean) -> Unit = {}) {
        thread(name = "ares-undo") {
            val r = runCatching { AresClient(c).post("/api/jobs/$id/undo", JSONObject()) }.getOrNull()
            main.post { toast(c, r, "Withdrawn."); onDone(r?.optBoolean("ok") == true) }
        }
    }
}
