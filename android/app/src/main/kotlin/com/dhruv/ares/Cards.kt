package com.dhruv.ares

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Result cards (docs/phone-ui-prompt.md §6): the Mac's brain attaches a card spec to an answer (show_card → the ask stream's
 * `card` message, A2UI-style JSON: kind + data + up to three follow-up actions) and the phone draws ONLY the kinds it knows,
 * with its own scheme-coloured views; anything else falls back to a text card. A card is a headline of a few words, two or
 * three facts, and two or three verbs. She speaks the full answer; the card's key lines stay after the speech ends.
 *
 * Kinds: summary (lines), list (items), event (when, where), place (address, hours, phone), file (name, size, a Mac link),
 * image (a Mac link), progress (a job), approval (a job waiting for a yes). Actions: { label, url | ask | api+body | share }.
 */
object Cards {
    val KINDS = setOf("summary", "list", "event", "place", "file", "image", "progress", "approval", "text")

    /** The last card shown over an app, and where it was on screen when it opened one (the "back to ARES" return, §5). */
    @Volatile var last: JSONObject? = null
    @Volatile var lastRect: Rect? = null

    class Host(val act: Activity, val ask: (String) -> Unit, val opened: (card: View, icon: Bitmap?) -> Unit = { _, _ -> })

    /** Clean a spec from the Mac: known kind (else text), capped lengths; null when it has nothing to show. */
    fun parse(o: JSONObject?): JSONObject? {
        o ?: return null
        val kind = o.optString("kind").lowercase().takeIf { it in KINDS } ?: "text"
        val out = JSONObject().put("kind", kind)
        out.put("title", o.optString("title").trim().take(80))
        o.optString("text").trim().takeIf { it.isNotBlank() }?.let { out.put("text", it.take(600)) }
        o.optJSONArray("lines")?.let { a -> out.put("lines", JSONArray((0 until minOf(a.length(), 3)).map { a.optString(it).take(140) })) }
        o.optJSONArray("items")?.let { a ->
            out.put("items", JSONArray((0 until minOf(a.length(), 6)).mapNotNull { i ->
                a.optJSONObject(i)?.let { it0 -> JSONObject().put("text", it0.optString("text").take(120)).put("sub", it0.optString("sub").take(80)).put("url", it0.optString("url")) }
                    ?: a.optString(i).takeIf { it.isNotBlank() }?.let { JSONObject().put("text", it.take(120)) }
            }))
        }
        for (k in listOf("when", "where", "address", "hours", "phone", "name", "size", "mime", "url", "job", "what", "icon")) o.optString(k).takeIf { it.isNotBlank() }?.let { out.put(k, it.take(300)) }
        o.optJSONArray("actions")?.let { a ->
            out.put("actions", JSONArray((0 until minOf(a.length(), 3)).mapNotNull { i ->
                val x = a.optJSONObject(i) ?: return@mapNotNull null
                val label = x.optString("label").trim().take(24).ifBlank { return@mapNotNull null }
                JSONObject().put("label", label).put("url", x.optString("url")).put("ask", x.optString("ask")).put("api", x.optString("api")).put("share", x.optString("share"))
                    .also { b -> x.optJSONObject("body")?.let { b.put("body", it) } }
            }))
        }
        val hasBody = out.has("lines") || out.has("items") || out.has("text") || out.has("when") || out.has("address") || out.has("name") || out.has("url") || out.has("job")
        return if (out.optString("title").isBlank() && !hasBody) null else out
    }

    // ---- Drawing -----------------------------------------------------------------------------------------------------

    fun view(host: Host, spec: JSONObject): View {
        val act = host.act
        val dp = act.resources.displayMetrics.density
        val kind = spec.optString("kind")
        val amber = kind == "approval"
        val accent = if (amber) act.getColor(R.color.amber) else Scheme.color
        val c = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = 14 * dp; setColor(0xE606121B.toInt()); setStroke(dp.toInt().coerceAtLeast(1), if (amber) 0x99FFB547.toInt() else Scheme.alpha(90)) }
            setPadding((14 * dp).toInt(), (12 * dp).toInt(), (14 * dp).toInt(), (10 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = (8 * dp).toInt() }
            tag = spec
        }
        fun label(t: String, size: Float = 9f, colour: Int = accent, spacing: Float = 0.3f) = TextView(act).apply { text = t; textSize = size; letterSpacing = spacing; setTextColor(colour) }
        fun body(t: String, size: Float = 14f, colour: Int = act.getColor(R.color.text), lines: Int = 3) = TextView(act).apply {
            text = t; textSize = size; setTextColor(colour); maxLines = lines; ellipsize = TextUtils.TruncateAt.END; typeface = android.graphics.Typeface.SANS_SERIF; setPadding(0, (3 * dp).toInt(), 0, (3 * dp).toInt())
        }
        fun fact(l: String, v: String) = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, (3 * dp).toInt(), 0, (3 * dp).toInt())
            addView(label(l.uppercase(), 9f, act.getColor(R.color.muted), 0.2f).apply { layoutParams = LinearLayout.LayoutParams((64 * dp).toInt(), -2) })
            addView(body(v, 13f, act.getColor(R.color.text), 2).apply { layoutParams = LinearLayout.LayoutParams(0, -2, 1f); setPadding(0, 0, 0, 0) })
        }
        val head = when (kind) { "event" -> "EVENT"; "place" -> "PLACE"; "file" -> "FILE"; "image" -> "IMAGE"; "progress" -> "WORK"; "approval" -> "NEEDS YOUR OK"; "list" -> "LIST"; else -> "ARES" }
        c.addView(LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(0, 0, 0, (4 * dp).toInt())
            addView(label(head).apply { layoutParams = LinearLayout.LayoutParams(0, -2, 1f) })
        })
        spec.optString("title").takeIf { it.isNotBlank() }?.let { c.addView(body(it, 15f, act.getColor(R.color.text), 2).apply { typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) }) }
        when (kind) {
            "summary", "text" -> {
                spec.optJSONArray("lines")?.let { a -> for (i in 0 until a.length()) c.addView(body("• " + a.optString(i), 13f, act.getColor(R.color.text), 2)) }
                spec.optString("text").takeIf { it.isNotBlank() }?.let { c.addView(body(it, 13f, act.getColor(R.color.text_user), 6)) }
            }
            "list" -> spec.optJSONArray("items")?.let { a ->
                for (i in 0 until a.length()) {
                    val it0 = a.getJSONObject(i)
                    val row = LinearLayout(act).apply {
                        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
                        addView(body(it0.optString("text"), 13f, act.getColor(R.color.text), 2).apply { layoutParams = LinearLayout.LayoutParams(0, -2, 1f); setPadding(0, 0, 0, 0) })
                        it0.optString("sub").takeIf { it.isNotBlank() }?.let { addView(label(it, 10f, act.getColor(R.color.text_user), 0f).apply { setPadding((10 * dp).toInt(), 0, 0, 0) }) }
                    }
                    it0.optString("url").takeIf { it.isNotBlank() }?.let { u -> row.setOnClickListener { openUrl(host, c, u) } }
                    c.addView(row)
                }
            }
            "event" -> {
                spec.optString("when").takeIf { it.isNotBlank() }?.let { c.addView(fact("When", it)) }
                spec.optString("where").takeIf { it.isNotBlank() }?.let { c.addView(fact("Where", it)) }
                spec.optJSONArray("lines")?.let { a -> for (i in 0 until a.length()) c.addView(body(a.optString(i), 13f, act.getColor(R.color.text_user), 2)) }
            }
            "place" -> {
                spec.optString("address").takeIf { it.isNotBlank() }?.let { c.addView(fact("Where", it)) }
                spec.optString("hours").takeIf { it.isNotBlank() }?.let { c.addView(fact("Hours", it)) }
                spec.optString("phone").takeIf { it.isNotBlank() }?.let { c.addView(fact("Phone", it)) }
                spec.optJSONArray("lines")?.let { a -> for (i in 0 until a.length()) c.addView(body(a.optString(i), 13f, act.getColor(R.color.text_user), 2)) }
            }
            "file" -> {
                c.addView(fact("Name", spec.optString("name").ifBlank { spec.optString("title") }))
                listOfNotNull(spec.optString("size").takeIf { it.isNotBlank() }, spec.optString("mime").takeIf { it.isNotBlank() }).joinToString(" · ").takeIf { it.isNotBlank() }?.let { c.addView(fact("Type", it)) }
            }
            "image" -> {
                val img = ImageView(act).apply {
                    scaleType = ImageView.ScaleType.CENTER_CROP; adjustViewBounds = true; maxHeight = (220 * dp).toInt()
                    background = GradientDrawable().apply { cornerRadius = 10 * dp; setColor(0x14FFFFFF) }
                    layoutParams = LinearLayout.LayoutParams(-1, (160 * dp).toInt()).apply { topMargin = (6 * dp).toInt() }
                    clipToOutline = true
                }
                c.addView(img)
                spec.optString("url").takeIf { it.isNotBlank() }?.let { u -> loadImage(host.act, u) { b -> img.setImageBitmap(b) } }
            }
            "progress", "approval" -> {
                val job = spec.optString("job").takeIf { it.isNotBlank() }?.let(JobStore::get)
                if (job != null) {
                    if (spec.optString("title").isBlank()) c.addView(body(job.title, 15f, act.getColor(R.color.text), 2))
                    val status = when (job.status) { "approval" -> job.approvalWhat ?: "Needs your OK"; "running" -> job.phaseLine(); "queued" -> "Queued"; "done" -> "Done"; "failed" -> "Failed: ${job.error}"; else -> job.status }
                    c.addView(body(status, 13f, if (job.status == "approval") act.getColor(R.color.amber) else act.getColor(R.color.text_user), 3))
                    job.check?.let { ch -> c.addView(fact("Check", (if (ch.optBoolean("ok")) "Passed" else "FAILED") + ch.optString("reason").takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty())) }
                    job.lastEvent()?.let { c.addView(fact("Last", it)) }
                    c.addView(segments(act, job, dp))
                } else spec.optString("what").takeIf { it.isNotBlank() }?.let { c.addView(body(it, 13f, act.getColor(R.color.amber), 3)) }
            }
        }
        // The verbs
        val actions = spec.optJSONArray("actions")
        val job = spec.optString("job").takeIf { it.isNotBlank() }
        val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END; setPadding(0, (8 * dp).toInt(), 0, 0) }
        if (kind == "approval" && job != null) {
            row.addView(pill(act, "NOT NOW", Scheme.color, false) { Approvals.notNow(act, job) })
            row.addView(pill(act, "EDIT", Scheme.color, false) { Approvals.edit(act, job) })
            row.addView(pill(act, "APPROVE", act.getColor(R.color.amber), true) { Approvals.approve(act, job) })
        } else if ((kind == "progress") && job != null) {
            row.addView(pill(act, "RECEIPT", Scheme.color, false) { act.startActivity(ReceiptActivity.intent(act, job)) })
        }
        if (kind == "file" && spec.optString("url").startsWith("/api/files/")) row.addView(pill(act, "GET", Scheme.color, false) { Files.fetch(act, spec.optString("url"), spec.optString("name").ifBlank { "file" }, spec.optString("mime")) })
        if (actions != null) for (i in 0 until actions.length()) {
            val a = actions.getJSONObject(i)
            row.addView(pill(act, a.optString("label").uppercase(), Scheme.color, false) { act(host, c, a) })
        }
        if (row.childCount > 0) c.addView(row)
        return c
    }

    /** The job's phases as a segmented bar (planning · running · tests · verifying · done; plain jobs: queued · working · done). */
    private fun segments(act: Activity, job: JobStore.Job, dp: Float): View {
        val names = job.segmentNames()
        val lit = job.segmentsDone()
        return LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(0, (8 * dp).toInt(), 0, (2 * dp).toInt())
            names.forEachIndexed { i, _ ->
                addView(View(act).apply {
                    background = GradientDrawable().apply { cornerRadius = 2 * dp; setColor(if (i < lit) (if (job.status == "approval") act.getColor(R.color.amber) else Scheme.color) else Scheme.alpha(40)) }
                    layoutParams = LinearLayout.LayoutParams(0, (4 * dp).toInt(), 1f).apply { if (i > 0) marginStart = (3 * dp).toInt() }
                })
            }
        }
    }

    fun pill(act: Activity, label: String, colour: Int, amber: Boolean, onClick: () -> Unit) = TextView(act).apply {
        val dp = act.resources.displayMetrics.density
        text = label; textSize = 10f; letterSpacing = 0.2f; setTextColor(colour); gravity = Gravity.CENTER
        background = if (amber) act.getDrawable(R.drawable.bg_amber) else GradientDrawable().apply { cornerRadius = 14 * dp; setColor(Scheme.alpha(20)); setStroke(dp.toInt().coerceAtLeast(1), Scheme.alpha(89)) }
        setPadding((14 * dp).toInt(), (7 * dp).toInt(), (14 * dp).toInt(), (7 * dp).toInt())
        layoutParams = LinearLayout.LayoutParams(-2, -2).apply { marginStart = (8 * dp).toInt() }
        setOnClickListener { onClick() }
    }

    private fun act(host: Host, card: View, a: JSONObject) {
        val url = a.optString("url"); val ask = a.optString("ask"); val api = a.optString("api"); val share = a.optString("share")
        when {
            url.isNotBlank() -> openUrl(host, card, url)
            ask.isNotBlank() -> host.ask(ask)
            share.isNotBlank() -> runCatching { host.act.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, share), null)) }
            api.startsWith("/api/jobs/") -> thread { runCatching { AresClient(host.act).post(api, a.optJSONObject("body") ?: JSONObject()) }.onSuccess { r ->
                host.act.runOnUiThread { android.widget.Toast.makeText(host.act, if (r.optBoolean("ok")) "Done." else r.optString("error").ifBlank { "That didn't work." }, android.widget.Toast.LENGTH_SHORT).show() } } }
        }
    }

    /** Open a link from the card's own bounds, remembering where the card was so it can settle back (§5). */
    private fun openUrl(host: Host, card: View, url: String) {
        val loc = IntArray(2).also(card::getLocationOnScreen)
        lastRect = Rect(loc[0], loc[1], loc[0] + card.width, loc[1] + card.height)
        last = card.tag as? JSONObject
        if (Ares.open(host.act, url, from = card)) host.opened(card, iconFor(host.act, url))
    }

    /** The icon of the app that will open this link (for the bubble's "back to ARES" arc). */
    private fun iconFor(act: Activity, url: String): Bitmap? = runCatching {
        val uri = android.net.Uri.parse(url)
        val i = Intent(if (uri.scheme == "tel") Intent.ACTION_DIAL else Intent.ACTION_VIEW, uri)
        val ri = act.packageManager.resolveActivity(i, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY) ?: return null
        val app = Apps.all.firstOrNull { it.component.packageName == ri.activityInfo.packageName } ?: return null
        val px = (20 * act.resources.displayMetrics.density).toInt()
        Icons.get(act, app, px) {}
    }.getOrNull()

    /** An image from the Mac (same origin only, with the pairing cookie). */
    private fun loadImage(act: Activity, url: String, done: (Bitmap) -> Unit) {
        val full = if (url.startsWith("/")) Ares.url(act).trimEnd('/') + url else url
        if (!full.startsWith(Ares.url(act).trimEnd('/'))) return
        thread {
            val bmp = runCatching {
                val c = java.net.URL(full).openConnection() as java.net.HttpURLConnection
                Ares.token(act)?.let { c.setRequestProperty("Cookie", "ares_token=$it") }
                c.connectTimeout = 10_000; c.readTimeout = 20_000
                c.inputStream.use { BitmapFactory.decodeStream(it) }
            }.getOrNull() ?: return@thread
            act.runOnUiThread { done(bmp) }
        }
    }

    /** Lay a card in: from a little below and transparent, springing up (DefaultSpatial), with a soft tick as it lands. */
    fun land(act: Activity, box: ViewGroup, v: View, from: Rect? = null) {
        box.addView(v)
        if (!Motion.enabled) return
        val dp = act.resources.displayMetrics.density
        if (from != null) {
            // Back from the app it opened: the card springs into its slot from where it left
            v.post {
                val loc = IntArray(2).also(v::getLocationOnScreen)
                v.translationX = (from.left - loc[0]).toFloat(); v.translationY = (from.top - loc[1]).toFloat()
                v.scaleX = from.width() / v.width.toFloat().coerceAtLeast(1f); v.scaleY = v.scaleX; v.pivotX = 0f; v.pivotY = 0f
                Motion.to(v, Motion.X, 0f, Motion.DefaultSpatial); Motion.to(v, Motion.Y, 0f, Motion.DefaultSpatial)
                Motion.scale(v, 1f, Motion.DefaultSpatial) { Haptics.settle(act) }
            }
        } else {
            v.translationY = 28 * dp; v.alpha = 0f
            Motion.to(v, Motion.Y, 0f, Motion.DefaultSpatial) { Haptics.land(act) }
            Motion.to(v, Motion.ALPHA, 1f, Motion.DefaultEffects)
        }
    }

    /** A plain wrapper so a card can sit in a FrameLayout host. */
    fun frame(act: Activity, v: View): FrameLayout = FrameLayout(act).apply { addView(v, FrameLayout.LayoutParams(-1, -2)) }
}
