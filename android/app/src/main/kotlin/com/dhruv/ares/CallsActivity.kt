package com.dhruv.ares

import android.app.Activity
import android.app.AlertDialog
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.text.TextUtils
import android.text.format.DateUtils
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.util.Calendar
import kotlin.concurrent.thread
import kotlin.math.max

/**
 * Calls: messages ARES took on the phone line and the calls she made for you (from the Mac's log, plus
 * calls pushed by the relay while the Mac was away), each with its transcript; and a form to have her call
 * someone. Placing a call always goes through a confirm step first: that tap is your yes.
 */
class CallsActivity : Activity() {
    companion object {
        fun intent(c: Context, call: String? = null): Intent =
            Intent(c, CallsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("call", call)
        private const val PICK_CONTACT = 1
    }

    private lateinit var list: LinearLayout
    private lateinit var detail: LinearLayout
    private lateinit var detailPane: View
    private lateinit var form: View
    private val client by lazy { AresClient(this) }
    private val dp by lazy { resources.displayMetrics.density }
    private var calls = listOf<CallStore.Call>()
    private var at: Calendar? = null // null = call now
    private val reload = { load() }
    private val back = OnBackInvokedCallback { closeDetail() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Ares.paired(this)) { startActivity(Intent(this, MainActivity::class.java)); finish(); return }
        setContentView(R.layout.activity_calls)
        findViewById<View>(R.id.root).setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            WindowInsets.CONSUMED
        }
        list = findViewById(R.id.calls)
        detail = findViewById(R.id.detail)
        detailPane = findViewById(R.id.detailPane)
        form = findViewById(R.id.form)
        findViewById<View>(R.id.back).setOnClickListener { finish() }
        findViewById<View>(R.id.newCall).setOnClickListener { form.visibility = if (form.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        findViewById<View>(R.id.pick).setOnClickListener {
            runCatching { startActivityForResult(Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI), PICK_CONTACT) }
        }
        val whenView = findViewById<TextView>(R.id.`when`)
        whenView.setOnClickListener { pickTime(whenView) }
        whenView.setOnLongClickListener { at = null; whenView.text = "NOW"; true }
        findViewById<View>(R.id.place).setOnClickListener { confirm() }
        CallStore.listen(reload)
        render()
        load()
        intent.getStringExtra("call")?.let(::openCall)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        load()
        intent.getStringExtra("call")?.let(::openCall)
    }

    override fun onDestroy() { CallStore.unlisten(reload); super.onDestroy() }

    // ---- The list ----------------------------------------------------------------------------------------

    private fun load() {
        thread(name = "ares-calls") {
            val r = runCatching { client.calls() }
            val mac = r.getOrNull()?.optJSONArray("calls")?.let { a -> (0 until a.length()).map { CallStore.fromMac(a.getJSONObject(it)) } }
            val msgs = r.getOrNull()?.optJSONArray("messages")
            runOnUiThread {
                calls = CallStore.merge(mac, CallStore.cached(this))
                findViewById<View>(R.id.offline).visibility = if (mac == null) View.VISIBLE else View.GONE
                val m = findViewById<TextView>(R.id.messages)
                if (msgs != null && msgs.length() > 0) {
                    m.text = "PASSING ON\n" + (0 until msgs.length()).map { msgs.getJSONObject(it) }.joinToString("\n") { "If ${it.optString("for")} calls: \"${it.optString("message")}\"" }
                    m.visibility = View.VISIBLE
                } else m.visibility = View.GONE
                render()
            }
        }
    }

    private fun render() {
        list.removeAllViews()
        if (calls.isEmpty()) {
            list.addView(TextView(this).apply {
                text = "No calls yet. Missed calls forwarded to the ARES line show up here, and so do calls she makes for you (tap + NEW CALL, or just ask her)."
                setTextColor(getColor(R.color.muted)); textSize = 12f; setPadding(4, (16 * dp).toInt(), 4, 0)
            })
            return
        }
        for (c in calls) list.addView(row(c))
    }

    private fun dotColor(c: CallStore.Call) = getColor(when {
        c.urgent -> R.color.amber
        c.spam -> R.color.muted
        c.direction == "outbound" -> R.color.purple
        else -> R.color.cyan
    })

    private fun whenText(c: CallStore.Call) =
        if (c.status == "scheduled") "SCHEDULED · " + DateUtils.formatDateTime(this, c.at, DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_WEEKDAY)
        else DateUtils.getRelativeTimeSpanString(c.at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()

    private fun row(c: CallStore.Call): View {
        val live = c.direction == "outbound" && c.status in setOf("initiated", "in-progress", "processing", "dialing")
        val meta = listOfNotNull(
            if (c.urgent) "URGENT" else null,
            if (c.spam) "SPAM" else null,
            if (live) "CALLING…" else null,
            whenText(c),
        ).joinToString(" · ")
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = getDrawable(R.drawable.bg_input)
            setPadding((12 * dp).toInt(), (11 * dp).toInt(), (12 * dp).toInt(), (11 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = (6 * dp).toInt() }
            addView(View(context).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(dotColor(c)) }
                layoutParams = LinearLayout.LayoutParams((9 * dp).toInt(), (9 * dp).toInt()).apply { marginEnd = (12 * dp).toInt() }
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                addView(TextView(context).apply {
                    text = c.title.ifBlank { c.who }; textSize = 14f; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
                    setTextColor(getColor(if (c.spam) R.color.muted else R.color.text))
                })
                if (c.body.isNotBlank()) addView(TextView(context).apply {
                    text = c.body; textSize = 12f; maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setTextColor(getColor(R.color.text_user))
                })
                addView(TextView(context).apply {
                    text = meta; textSize = 10f; maxLines = 1; setTextColor(getColor(if (c.urgent) R.color.amber else R.color.muted))
                })
            })
            setOnClickListener { openCall(c.id) }
        }
    }

    // ---- One call ----------------------------------------------------------------------------------------

    private fun openCall(id: String) {
        val known = (calls + CallStore.cached(this)).firstOrNull { it.id == id }
        showDetail(known, null, loading = true)
        thread(name = "ares-call") {
            val full = runCatching { client.call(id) }.getOrNull()
            runOnUiThread { if (detailPane.visibility == View.VISIBLE) showDetail(full?.let(CallStore::fromMac) ?: known, full, loading = false) }
        }
    }

    private fun text(s: String, size: Float, color: Int, bold: Boolean = false, top: Int = 0) = TextView(this).apply {
        text = s; textSize = size; setTextColor(getColor(color)); setLineSpacing(0f, 1.25f)
        if (bold) typeface = Typeface.create(typeface, Typeface.BOLD)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = (top * dp).toInt() }
    }

    private fun chip(label: String, onClick: () -> Unit) = TextView(this).apply {
        text = label; textSize = 11f; letterSpacing = 0.12f; gravity = Gravity.CENTER; setTextColor(getColor(R.color.cyan))
        background = getDrawable(R.drawable.bg_chip); setPadding((14 * dp).toInt(), 0, (14 * dp).toInt(), 0)
        layoutParams = LinearLayout.LayoutParams(-2, (40 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() }
        setOnClickListener { onClick() }
    }

    private fun showDetail(c: CallStore.Call?, full: JSONObject?, loading: Boolean) {
        detail.removeAllViews()
        detailPane.visibility = View.VISIBLE
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, back)
        detail.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(-1, (52 * dp).toInt())
            addView(TextView(context).apply {
                text = "‹"; textSize = 24f; gravity = Gravity.CENTER; setTextColor(getColor(R.color.cyan))
                layoutParams = LinearLayout.LayoutParams((40 * dp).toInt(), (40 * dp).toInt())
                setOnClickListener { closeDetail() }
            })
            addView(TextView(context).apply {
                text = if (c?.direction == "outbound") "CALL MADE" else "CALL"; textSize = 14f; letterSpacing = 0.3f
                setTextColor(getColor(R.color.cyan)); typeface = Typeface.create(typeface, Typeface.BOLD)
            })
        })
        if (c == null) { detail.addView(text(if (loading) "Loading…" else "That call isn't on this phone, and the Mac can't be reached.", 13f, R.color.muted)); return }
        val outbound = c.direction == "outbound"
        detail.addView(text(if (outbound) "You → ${c.who}" else c.who.ifBlank { "Unknown caller" }, 18f, R.color.text, bold = true))
        val facts = listOfNotNull(
            c.from.takeIf { it.isNotBlank() },
            DateUtils.formatDateTime(this, c.at, DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_ALL),
            if (c.secs > 0) "${c.secs / 60}m ${c.secs % 60}s" else null,
            if (c.urgent) "URGENT" else null, if (c.spam) "SPAM" else null,
            if (outbound && c.status !in setOf("done", "failed")) c.status.uppercase() else null,
        )
        detail.addView(text(facts.joinToString(" · "), 11f, if (c.urgent) R.color.amber else R.color.muted, top = 4))
        if (outbound && c.purpose.isNotBlank()) detail.addView(text("Asked: ${c.purpose}", 13f, R.color.text_user, top = 14))
        val main = if (outbound) c.result.ifBlank { when (c.status) { "scheduled" -> "Not called yet."; "done", "failed" -> c.body; else -> "On the call now…" } } else c.body
        if (main.isNotBlank()) detail.addView(text(main, 15f, R.color.text, top = 12))
        full?.optString("summary")?.takeIf { it.isNotBlank() && it != main }?.let { detail.addView(text(it, 12f, R.color.muted, top = 10)) }

        val cb = c.callback.ifBlank { c.from }
        detail.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = (16 * dp).toInt() }
            if (cb.isNotBlank()) {
                addView(chip("CALL BACK") { Ares.open(this@CallsActivity, "tel:$cb") })
                addView(chip("TEXT") { runCatching { startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$cb"))) } })
            }
            if (c.status == "scheduled") addView(chip("CANCEL CALL") {
                thread { val r = runCatching { client.cancelCall(c.id) }.getOrNull(); runOnUiThread { closeDetail(); load(); r?.let { toast(it.optString("message")) } } }
            })
        })

        val lines = full?.optJSONArray("transcript")
        when {
            lines != null && lines.length() > 0 -> {
                detail.addView(text("TRANSCRIPT", 10f, R.color.muted, top = 22).apply { letterSpacing = 0.2f })
                for (i in 0 until lines.length()) {
                    val l = lines.getJSONObject(i)
                    val ares = l.optString("role") == "agent"
                    detail.addView(text(l.optString("text").replace(Regex("\\[[a-z ]+\\]\\s*"), ""), 13f, if (ares) R.color.cyan else R.color.text, top = 8).apply {
                        background = getDrawable(R.drawable.bg_input)
                        setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
                        // Chat-style: ARES on the left, the other person on the right, each as wide as what was said
                        layoutParams = LinearLayout.LayoutParams(-2, -2).apply {
                            topMargin = (8 * dp).toInt(); gravity = if (ares) Gravity.START else Gravity.END
                            if (ares) marginEnd = (40 * dp).toInt() else marginStart = (40 * dp).toInt()
                        }
                    })
                }
            }
            loading -> detail.addView(text("Getting the transcript from your Mac…", 12f, R.color.muted, top = 22))
            full == null -> detail.addView(text("The transcript is on your Mac; it'll show here when the Mac is reachable.", 12f, R.color.muted, top = 22))
        }
    }

    private fun closeDetail() {
        detailPane.visibility = View.GONE
        runCatching { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(back) }
    }

    // ---- A new call --------------------------------------------------------------------------------------

    private fun pickTime(view: TextView) {
        val now = Calendar.getInstance()
        TimePickerDialog(this, android.R.style.Theme_Material_Dialog_Alert, { _, h, m ->
            val c = Calendar.getInstance().apply { set(Calendar.HOUR_OF_DAY, h); set(Calendar.MINUTE, m); set(Calendar.SECOND, 0) }
            if (c.before(now)) c.add(Calendar.DAY_OF_MONTH, 1) // a time already gone today means tomorrow
            at = c
            view.text = DateUtils.formatDateTime(this, c.timeInMillis, DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_WEEKDAY).uppercase()
        }, now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE), false).show()
    }

    private fun field(id: Int) = findViewById<EditText>(id).text.toString().trim()

    private fun confirm() {
        val note = findViewById<TextView>(R.id.formNote)
        val to = field(R.id.to)
        val name = field(R.id.name).ifBlank { to }
        val purpose = field(R.id.purpose)
        val brief = field(R.id.brief)
        if (to.count { it.isDigit() } < 7) { note.text = "Add the number."; return }
        if (purpose.isBlank()) { note.text = "Say what the call is for."; return }
        note.text = ""
        val whenText = at?.let { "at " + DateUtils.formatDateTime(this, it.timeInMillis, DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_WEEKDAY) } ?: "now"
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Call $name?")
            .setMessage("ARES will call $name ($to) $whenText, say she's your AI assistant, and ${purpose.replaceFirstChar { it.lowercase() }.removePrefix("to ")}.${if (brief.isNotBlank()) "\n\n$brief" else ""}")
            .setPositiveButton("Call") { _, _ -> place(to, name, purpose, brief) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun place(to: String, name: String, purpose: String, brief: String) {
        val btn = findViewById<TextView>(R.id.place)
        val note = findViewById<TextView>(R.id.formNote)
        btn.isEnabled = false
        note.text = "Sending to your Mac…"
        val iso = at?.let { String.format("%tFT%<tH:%<tM:00", it) }
        thread(name = "ares-place-call") {
            val r = runCatching { client.placeCall(to, name, purpose, brief.ifBlank { purpose }, iso) }
                .getOrElse { JSONObject().put("ok", false).put("error", if (it is NotPairedException) "This phone isn't paired any more." else "Can't reach your Mac (it has to be on to place calls).") }
            runOnUiThread {
                btn.isEnabled = true
                if (r.optBoolean("ok")) {
                    note.text = ""
                    toast(r.optString("message"))
                    for (id in listOf(R.id.to, R.id.name, R.id.purpose, R.id.brief)) findViewById<EditText>(id).setText("")
                    at = null; findViewById<TextView>(R.id.`when`).text = "NOW"
                    form.visibility = View.GONE
                    load()
                } else note.text = r.optString("error").ifBlank { "That didn't work." }
            }
        }
    }

    private fun toast(s: String) { if (s.isNotBlank()) android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_LONG).show() }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != PICK_CONTACT || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        runCatching {
            contentResolver.query(uri, arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME), null, null, null)?.use { cur ->
                if (cur.moveToFirst()) {
                    findViewById<EditText>(R.id.to).setText(cur.getString(0))
                    if (field(R.id.name).isBlank()) findViewById<EditText>(R.id.name).setText(cur.getString(1))
                }
            }
        }
    }
}
