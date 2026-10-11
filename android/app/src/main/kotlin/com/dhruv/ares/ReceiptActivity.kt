package com.dhruv.ares

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.TextUtils
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The task receipt (docs/phone-ui-prompt.md §7, Muse's "task lineage"): one Mac job, every step with its time and outcome
 * (the job's events and the audit log's entries for it), the files it touched, the independent outgoing check's verdict,
 * the approval box (APPROVE with a fingerprint · EDIT · NOT NOW) with its UNDO window after a yes, "Ideas · try next", and
 * Stop / Open on Mac. A bottom sheet over whatever was there; Back scrubs it down.
 */
class ReceiptActivity : Activity() {
    companion object {
        fun intent(c: Context, job: String, approve: Boolean = false): Intent =
            Intent(c, ReceiptActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("job", job).putExtra("approve", approve)
    }

    private lateinit var sheet: LinearLayout
    private lateinit var body: LinearLayout
    private lateinit var root: FrameLayout
    private var jobId = ""
    private var receipt: JSONObject? = null
    private val dp by lazy { resources.displayMetrics.density }
    private val jobsChanged = { render() }
    private val eventsChanged: (String) -> Unit = { id -> if (id == jobId) render() }
    private val tick = object : Runnable { override fun run() { val j = JobStore.get(jobId); if (j != null && j.undoLeftMs > 0) { render(); body.postDelayed(this, 1000) } } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0)
        overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        jobId = intent.getStringExtra("job") ?: return finish()
        root = FrameLayout(this).apply { setOnClickListener { close() } }
        sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadii = floatArrayOf(22 * dp, 22 * dp, 22 * dp, 22 * dp, 0f, 0f, 0f, 0f); setColor(0xF2071119.toInt()); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(70)) }
            setOnClickListener { }
            layoutParams = FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM)
        }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding((18 * dp).toInt(), (10 * dp).toInt(), (18 * dp).toInt(), (18 * dp).toInt()) }
        sheet.addView(View(this).apply { background = GradientDrawable().apply { cornerRadius = 2 * dp; setColor(Scheme.alpha(120)) }; layoutParams = LinearLayout.LayoutParams((36 * dp).toInt(), (4 * dp).toInt()).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = (10 * dp).toInt() } })
        sheet.addView(ScrollView(this).apply { addView(body); isVerticalScrollBarEnabled = false }, LinearLayout.LayoutParams(-1, 0).apply { height = (resources.displayMetrics.heightPixels * 0.78f).toInt() })
        root.addView(sheet)
        setContentView(root)
        root.setOnApplyWindowInsetsListener { v, insets -> val bars = insets.getInsets(WindowInsets.Type.systemBars()); v.setPadding(0, bars.top, 0, bars.bottom); WindowInsets.CONSUMED }
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backScrub)
        root.post {
            if (Motion.enabled) { sheet.translationY = sheet.height.toFloat(); Motion.to(sheet, Motion.Y, 0f, Motion.TapSlow) }
        }
        render()
        load()
        if (intent.getBooleanExtra("approve", false)) body.postDelayed({ JobStore.get(jobId)?.takeIf { it.status == "approval" }?.let { Approvals.approve(this, jobId) } }, 400)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); jobId = intent.getStringExtra("job") ?: jobId; receipt = null; render(); load() }

    override fun onResume() {
        super.onResume()
        JobStore.listen(jobsChanged); JobStore.listenEvents(eventsChanged)
        body.removeCallbacks(tick); body.post(tick)
    }
    override fun onPause() { JobStore.unlisten(jobsChanged); JobStore.unlistenEvents(eventsChanged); body.removeCallbacks(tick); super.onPause() }

    private val backScrub = object : android.window.OnBackAnimationCallback {
        override fun onBackStarted(e: android.window.BackEvent) {}
        override fun onBackProgressed(e: android.window.BackEvent) { sheet.translationY = sheet.height * 0.35f * e.progress }
        override fun onBackInvoked() = close()
        override fun onBackCancelled() { Motion.to(sheet, Motion.Y, 0f, Motion.TapSlow) }
    }

    private fun close() {
        if (!Motion.enabled) return finish()
        Motion.to(sheet, Motion.Y, sheet.height.toFloat(), Motion.TapSlow) { finish() }
    }

    /** The receipt from the Mac: events, files, audit entries, checks. */
    private fun load() {
        thread(name = "ares-receipt") {
            val r = runCatching { AresClient(this).receipt(jobId) }.getOrNull()
            val ideas = runCatching { AresClient(this).ideas(jobId) }.getOrNull()
            runOnUiThread { receipt = r?.also { if (ideas != null) it.put("ideas", ideas) }; r?.optJSONObject("job")?.let { JobStore.update(this, it) }; render() }
        }
    }

    // ---- Drawing ------------------------------------------------------------------------------------------------------------

    private fun label(t: String, colour: Int = Scheme.color) = TextView(this).apply { text = t; textSize = 9f; letterSpacing = 0.3f; setTextColor(colour); setPadding(0, (14 * dp).toInt(), 0, (6 * dp).toInt()) }
    private fun line(t: String, colour: Int = getColor(R.color.text), size: Float = 13f, lines: Int = 3) = TextView(this).apply {
        text = t; textSize = size; setTextColor(colour); maxLines = lines; ellipsize = TextUtils.TruncateAt.END; typeface = android.graphics.Typeface.SANS_SERIF; setPadding(0, (3 * dp).toInt(), 0, (3 * dp).toInt())
    }
    private fun time(ms: Long) = DateFormat.getTimeFormat(this).format(java.util.Date(ms))

    private fun render() {
        val j = JobStore.get(jobId)
        body.removeAllViews()
        if (j == null) { body.addView(line("That job isn't here any more.", getColor(R.color.muted))); return }
        val statusColour = when (j.status) { "approval" -> getColor(R.color.amber); "done" -> 0xFF4ADE80.toInt(); "failed", "cancelled" -> 0xFFF87171.toInt(); else -> getColor(R.color.purple) }
        body.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            addView(TextView(this@ReceiptActivity).apply { text = "RECEIPT"; textSize = 9f; letterSpacing = 0.3f; setTextColor(Scheme.color); layoutParams = LinearLayout.LayoutParams(0, -2, 1f) })
            addView(TextView(this@ReceiptActivity).apply { text = when (j.status) { "approval" -> "NEEDS YOU"; "running" -> j.phaseLine().uppercase(); else -> j.status.uppercase() }; textSize = 9f; letterSpacing = 0.25f; setTextColor(statusColour) })
        })
        body.addView(line(j.title, getColor(R.color.text), 17f, 2).apply { typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) })
        if (j.summary.isNotBlank() && !j.active) body.addView(line(j.summary, getColor(R.color.text_user), 13f, 6))

        // The undo window after a yes
        if (j.undoLeftMs > 0) body.addView(box(getColor(R.color.amber)).apply {
            addView(line("Approved. It runs in ${(j.undoLeftMs / 1000) + 1} s unless you undo.", getColor(R.color.text)))
            addView(LinearLayout(this@ReceiptActivity).apply { gravity = Gravity.END; addView(Cards.pill(this@ReceiptActivity, "UNDO", getColor(R.color.amber), true) { Approvals.undo(this@ReceiptActivity, j.id) }) })
        })
        // The approval box: the exact action in one line, the check's verdict, and the three choices
        if (j.status == "approval") body.addView(box(getColor(R.color.amber)).apply {
            addView(label("NEEDS YOUR OK", getColor(R.color.amber)).apply { setPadding(0, 0, 0, (4 * dp).toInt()) })
            addView(line(j.approvalWhat ?: "The job is asking for your OK.", getColor(R.color.text), 14f, 4))
            j.check?.let { ch ->
                val ok = ch.optBoolean("ok")
                addView(line((if (ok) "✓ Outgoing check passed" else "✕ OUTGOING CHECK FAILED") + ch.optString("reason").takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty(), if (ok) 0xFF4ADE80.toInt() else 0xFFF87171.toInt(), 12f, 4))
            }
            addView(LinearLayout(this@ReceiptActivity).apply {
                gravity = Gravity.END; setPadding(0, (8 * dp).toInt(), 0, 0)
                addView(Cards.pill(this@ReceiptActivity, "NOT NOW", Scheme.color, false) { Approvals.notNow(this@ReceiptActivity, j.id) })
                addView(Cards.pill(this@ReceiptActivity, "EDIT", Scheme.color, false) { Approvals.edit(this@ReceiptActivity, j.id) })
                addView(Cards.pill(this@ReceiptActivity, "APPROVE", getColor(R.color.amber), true) { Approvals.approve(this@ReceiptActivity, j.id) })
            })
        })

        // Steps: the job's events (live from the Mac) merged with the audit log's entries for it
        body.addView(label("STEPS"))
        val events = ArrayList<JSONObject>()
        receipt?.optJSONArray("events")?.let { a -> for (i in 0 until a.length()) events += a.getJSONObject(i) }
        if (events.isEmpty()) events += JobStore.events(j.id)
        receipt?.optJSONArray("audit")?.let { a -> for (i in 0 until a.length()) { val e = a.getJSONObject(i); events += JSONObject().put("at", runCatching { java.time.Instant.parse(e.optString("at")).toEpochMilli() }.getOrDefault(0L)).put("type", "audit").put("ok", e.optBoolean("ok", true)).put("text", "${e.optString("what")} · tier ${e.optInt("tier")}${e.optString("approval").takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()}") } }
        receipt?.optJSONArray("checks")?.let { a -> for (i in 0 until a.length()) { val e = a.getJSONObject(i); events += JSONObject().put("at", e.optLong("at")).put("type", if (e.optBoolean("ok")) "check-ok" else "check-failed").put("text", "Outgoing check ${if (e.optBoolean("ok")) "passed" else "FAILED"}: ${e.optString("what")}${e.optString("reason").takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()}") } }
        events.sortBy { it.optLong("at") }
        if (events.isEmpty()) body.addView(line("Nothing yet.", getColor(R.color.muted)))
        for (e in events.takeLast(60)) body.addView(step(e))

        // Files it touched
        receipt?.optJSONArray("files")?.takeIf { it.length() > 0 }?.let { a ->
            body.addView(label("FILES"))
            for (i in 0 until minOf(a.length(), 12)) {
                val f = a.optJSONObject(i)
                val name = f?.optString("path")?.ifBlank { f.optString("name") } ?: a.optString(i)
                body.addView(line(name, getColor(R.color.text), 12f, 1).apply { typeface = android.graphics.Typeface.MONOSPACE })
            }
        }
        // Ideas · try next
        receipt?.optJSONArray("ideas")?.takeIf { it.length() > 0 }?.let { a ->
            body.addView(label("IDEAS · TRY NEXT"))
            body.addView(Ideas.row(this, a) { q -> startActivity(AskActivity.intent(this, ask = q)); close() })
        }
        // Stop / Open on Mac
        body.addView(LinearLayout(this).apply {
            gravity = Gravity.END; setPadding(0, (16 * dp).toInt(), 0, 0)
            if (j.active) addView(Cards.pill(this@ReceiptActivity, "STOP", 0xFFF87171.toInt(), false) { api("/api/jobs/${j.id}/cancel", "Stopped.") })
            addView(Cards.pill(this@ReceiptActivity, "OPEN ON MAC", Scheme.color, false) { api("/api/jobs/${j.id}/send-to-mac", "It'll open on your Mac.") })
            addView(Cards.pill(this@ReceiptActivity, "FULL VIEW", Scheme.color, false) { startActivity(WorkActivity.intent(this@ReceiptActivity, j.id)) })
        })
    }

    private fun box(colour: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply { cornerRadius = 12 * dp; setColor(android.graphics.Color.argb(22, android.graphics.Color.red(colour), android.graphics.Color.green(colour), android.graphics.Color.blue(colour))); setStroke(dp.toInt().coerceAtLeast(1), android.graphics.Color.argb(140, android.graphics.Color.red(colour), android.graphics.Color.green(colour), android.graphics.Color.blue(colour))) }
        setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = (10 * dp).toInt() }
    }

    /** One step: its time, a mark for its outcome, and what happened. */
    private fun step(e: JSONObject): View {
        val type = e.optString("type"); val kind = e.optString("kind")
        val mark = when {
            type == "done" || kind == "ok" || type == "check-ok" -> "✓" to 0xFF4ADE80.toInt()
            type == "failed" || kind == "refused" || type == "check-failed" || (type == "audit" && !e.optBoolean("ok", true)) -> "✕" to 0xFFF87171.toInt()
            type == "approval" -> "?" to getColor(R.color.amber)
            type == "audit" -> "§" to getColor(R.color.purple)
            type == "note" -> "·" to getColor(R.color.muted)
            else -> "›" to Scheme.color
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
            addView(TextView(this@ReceiptActivity).apply { text = e.optLong("at").takeIf { it > 0 }?.let(::time) ?: ""; textSize = 10f; setTextColor(getColor(R.color.muted)); typeface = android.graphics.Typeface.MONOSPACE; layoutParams = LinearLayout.LayoutParams((56 * dp).toInt(), -2) })
            addView(TextView(this@ReceiptActivity).apply { text = mark.first; textSize = 12f; setTextColor(mark.second); layoutParams = LinearLayout.LayoutParams((18 * dp).toInt(), -2) })
            addView(line(e.optString("text"), if (type == "note") getColor(R.color.text_user) else getColor(R.color.text), 12f, 3).apply { layoutParams = LinearLayout.LayoutParams(0, -2, 1f); setPadding(0, 0, 0, 0) })
        }
    }

    private fun api(path: String, ok: String) {
        thread { val r = runCatching { AresClient(this).post(path, JSONObject()) }.getOrNull(); runOnUiThread { Toast.makeText(this, if (r?.optBoolean("ok") == true) ok else r?.optString("error")?.ifBlank { null } ?: "I couldn't reach the Mac, sir.", Toast.LENGTH_SHORT).show() } }
    }
}

/** "Ideas" chips (docs/phone-ui-prompt.md §8): two or three starters from the Mac for right now; a tap sends one as a request. */
object Ideas {
    fun row(act: Activity, ideas: JSONArray, onTap: (String) -> Unit): View {
        val dp = act.resources.displayMetrics.density
        val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        for (i in 0 until minOf(ideas.length(), 3)) {
            val o = ideas.optJSONObject(i) ?: continue
            val label = o.optString("label").ifBlank { continue }; val ask = o.optString("ask").ifBlank { label }
            row.addView(TextView(act).apply {
                text = label; textSize = 11f; setTextColor(act.getColor(R.color.text)); maxLines = 1; ellipsize = TextUtils.TruncateAt.END; typeface = android.graphics.Typeface.SANS_SERIF
                background = GradientDrawable().apply { cornerRadius = 16 * dp; setColor(Scheme.alpha(18)); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(80)) }
                setPadding((14 * dp).toInt(), (8 * dp).toInt(), (14 * dp).toInt(), (8 * dp).toInt())
                layoutParams = LinearLayout.LayoutParams(-2, -2).apply { if (i > 0) marginStart = (8 * dp).toInt() }
                setOnClickListener { Haptics.tick(act); onTap(ask) }
            })
        }
        return android.widget.HorizontalScrollView(act).apply { isHorizontalScrollBarEnabled = false; addView(row); layoutParams = ViewGroup.LayoutParams(-1, -2) }
    }

    /** Fetch from the Mac (off the main thread), then `done` on it. */
    fun fetch(c: Context, job: String? = null, done: (JSONArray) -> Unit) {
        if (!Ares.paired(c)) return
        thread(name = "ares-ideas") { val r = runCatching { AresClient(c).ideas(job) }.getOrNull() ?: return@thread; android.os.Handler(android.os.Looper.getMainLooper()).post { done(r) } }
    }
}
