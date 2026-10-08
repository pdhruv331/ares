package com.dhruv.ares

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.LauncherActivityInfo
import android.content.pm.LauncherApps
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.AdaptiveIconDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.UserHandle
import android.os.UserManager
import android.provider.MediaStore
import android.provider.Telephony
import android.util.LruCache
import java.text.Collator
import java.util.concurrent.Executors

/**
 * The phone's launchable apps for the home screen (docs/launcher-prompt.md §4, §5): listed through LauncherApps (work
 * profile and Secure Folder apps included), sorted by name, kept fresh as apps come and go, drawn as ARES's themed icons,
 * and the five in the dock.
 */
object Apps {
    class App(val info: LauncherActivityInfo) {
        val label: String = info.label?.toString()?.trim().orEmpty().ifEmpty { info.componentName.packageName }
        val component: ComponentName get() = info.componentName
        val user: UserHandle get() = info.user
        /** Stable across launches: the component, plus the profile for apps that aren't in the main one. */
        val key: String get() = component.flattenToString() + if (user == android.os.Process.myUserHandle()) "" else "#" + user.hashCode()
        val letter: String get() = label.firstOrNull()?.uppercaseChar()?.let { if (it.isLetter()) it.toString() else "#" } ?: "#"
    }

    @Volatile var all: List<App> = emptyList()
        private set
    private val listeners = java.util.concurrent.CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newSingleThreadExecutor { Thread(it, "ares-apps").apply { isDaemon = true } }
    private var watching = false

    fun listen(l: () -> Unit) { listeners += l }
    fun unlisten(l: () -> Unit) { listeners -= l }

    private fun launcher(c: Context) = c.getSystemService(LauncherApps::class.java)

    /** List every app (off the main thread); the first call also starts watching for installs and removals. */
    fun load(c: Context) {
        val ctx = c.applicationContext
        if (!watching) {
            watching = true
            launcher(ctx).registerCallback(object : LauncherApps.Callback() {
                override fun onPackageRemoved(p: String, u: UserHandle) { Icons.forget(p); load(ctx) }
                override fun onPackageAdded(p: String, u: UserHandle) = load(ctx)
                override fun onPackageChanged(p: String, u: UserHandle) { Icons.forget(p); load(ctx) }
                override fun onPackagesAvailable(p: Array<out String>, u: UserHandle, r: Boolean) = load(ctx)
                override fun onPackagesUnavailable(p: Array<out String>, u: UserHandle, r: Boolean) = load(ctx)
            }, main)
        }
        work.execute {
            val la = launcher(ctx)
            val collator = Collator.getInstance().apply { strength = Collator.PRIMARY }
            val list = ctx.getSystemService(UserManager::class.java).userProfiles
                .flatMap { u -> runCatching { la.getActivityList(null, u) }.getOrDefault(emptyList()) }
                .map(::App)
                .sortedWith { a, b -> collator.compare(a.label, b.label) }
            all = list
            main.post { for (l in listeners) l() }
        }
    }

    fun find(key: String): App? = all.firstOrNull { it.key == key }

    /** Open an app, growing out of the view that was tapped. */
    fun open(c: Context, app: App, from: android.view.View?) {
        val opts = from?.let { android.app.ActivityOptions.makeScaleUpAnimation(it, 0, 0, it.width, it.height).toBundle() }
        val bounds = from?.let { v -> IntArray(2).also { v.getLocationOnScreen(it) }.let { android.graphics.Rect(it[0], it[1], it[0] + v.width, it[1] + v.height) } }
        runCatching { launcher(c).startMainActivity(app.component, app.user, bounds, opts) }
            .onFailure { android.widget.Toast.makeText(c, "${app.label} can't be opened.", android.widget.Toast.LENGTH_SHORT).show() }
    }

    // ---- The dock ------------------------------------------------------------------------------------------------

    const val DOCK = 5

    /** The five dock slots (null = empty). Until you change it: phone, messages, browser, music, camera. */
    fun dock(c: Context): List<String?> {
        val saved = Ares.prefs(c).getString("dock", null)
        if (saved != null) return saved.split('|').map { it.ifEmpty { null } }.let { it + List(DOCK - it.size.coerceAtMost(DOCK)) { null } }.take(DOCK)
        if (all.isEmpty()) return List(DOCK) { null } // (not listed yet: decide once they are)
        return defaultDock(c).also { setDock(c, it) }
    }

    fun setDock(c: Context, slots: List<String?>) = Ares.prefs(c).edit().putString("dock", slots.take(DOCK).joinToString("|") { it ?: "" }).apply()

    private fun defaultDock(c: Context): List<String?> {
        val pm = c.packageManager
        val me = android.os.Process.myUserHandle()
        fun byPackage(p: String?) = p?.let { pkg -> all.firstOrNull { it.component.packageName == pkg && it.user == me } }
        fun byIntent(i: Intent) = byPackage(pm.resolveActivity(i, 0)?.activityInfo?.packageName)
        fun first(vararg pkgs: String) = pkgs.firstNotNullOfOrNull(::byPackage)
        val picks = listOf(
            byIntent(Intent(Intent.ACTION_DIAL)) ?: first("com.samsung.android.dialer", "com.google.android.dialer"),
            byPackage(Telephony.Sms.getDefaultSmsPackage(c)) ?: first("com.samsung.android.messaging", "com.google.android.apps.messaging"),
            byIntent(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"))) ?: first("com.android.chrome", "com.sec.android.app.sbrowser"),
            first("com.spotify.music", "com.google.android.apps.youtube.music", "com.sec.android.gallery3d", "com.google.android.apps.photos"),
            byIntent(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)) ?: first("com.sec.android.app.camera", "com.google.android.GoogleCamera"),
        )
        return picks.map { it?.key }
    }
}

/**
 * ARES's themed icons (docs/launcher-prompt.md §5): the app's monochrome layer (Android 13+) tinted the scheme's colour (Scheme) on a dark
 * circle; apps without one get their own icon, desaturated, on the same circle. "Original icons" draws them as they are.
 * Rendered once per size off the main thread and cached.
 */
object Icons {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) { override fun sizeOf(k: String, v: Bitmap) = v.byteCount }
    private val work = Executors.newFixedThreadPool(2) { Thread(it, "ares-icons").apply { isDaemon = true; priority = Thread.MIN_PRIORITY } }
    private val main = Handler(Looper.getMainLooper())

    fun original(c: Context) = Ares.prefs(c).getBoolean("homeOriginalIcons", false)
    fun forget(pkg: String) = cache.snapshot().keys.filter { it.contains(pkg) }.forEach(cache::remove)
    fun clear() = cache.evictAll()

    /** The icon for `app` at `px`, now if cached, else later through `done` (on the main thread). */
    fun get(c: Context, app: Apps.App, px: Int, done: (Bitmap) -> Unit): Bitmap? {
        val orig = original(c)
        val tint = Scheme.color
        val key = "${app.key}@$px${if (orig) "o" else "#$tint"}"
        cache.get(key)?.let { return it }
        val ctx = c.applicationContext
        work.execute {
            val bmp = cache.get(key) ?: runCatching { render(ctx, app, px, orig, tint) }.getOrNull()?.also { cache.put(key, it) } ?: return@execute
            main.post { done(bmp) }
        }
        return null
    }

    private fun render(c: Context, app: Apps.App, px: Int, orig: Boolean, tint: Int): Bitmap {
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val d = app.info.getIcon(c.resources.displayMetrics.densityDpi).mutate()
        val h = px / 2f
        if (orig) {
            val s = (px * 0.04f).toInt(); d.setBounds(s, s, px - s, px - s); d.draw(canvas)
            return bmp
        }
        val dp = c.resources.displayMetrics.density
        val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(255, 8, 22, 32) }
        canvas.drawCircle(h, h, h - dp, disc)
        val mono = (d as? AdaptiveIconDrawable)?.monochrome
        canvas.save()
        canvas.clipPath(Path().apply { addCircle(h, h, h - dp, Path.Direction.CW) })
        if (mono != null) {
            // The layer is 108 units with the glyph in the middle; scaled so the glyph fills about half the circle
            val m = mono.mutate()
            m.setTint(tint)
            val size = px * 1.45f
            m.setBounds((h - size / 2).toInt(), (h - size / 2).toInt(), (h + size / 2).toInt(), (h + size / 2).toInt())
            m.draw(canvas)
        } else {
            val k = 0.62f
            val inset = (px * (1 - k) / 2).toInt()
            d.setBounds(inset, inset, px - inset, px - inset)
            d.colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0.15f) })
            d.alpha = 220
            d.draw(canvas)
            d.colorFilter = null; d.alpha = 255
        }
        canvas.restore()
        val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = dp; color = tint; alpha = 90 }
        canvas.drawCircle(h, h, h - dp, ring)
        return bmp
    }
}
