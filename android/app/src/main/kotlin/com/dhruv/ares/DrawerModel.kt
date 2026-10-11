package com.dhruv.ares

import android.content.Context
import android.content.pm.ApplicationInfo
import org.json.JSONArray
import org.json.JSONObject
import java.text.Collator

/**
 * What's on the drawer's pages (docs/phone-ui-prompt.md follow-up: the paged drawer): apps and folders in the owner's own
 * order (CUSTOM, prefs `drawerLayout`), or the same items laid A–Z (read-only for dragging). A folder is a named list of
 * app keys. Apps that vanish leave no gap, new installs join the end of the last page, a page with nothing on it goes,
 * and a folder left with one app dissolves back into that app. The grid (prefs `drawerGrid`: 4x6 or 5x6) sets a page's capacity.
 */
class DrawerModel(private val c: Context) {
    sealed class Item {
        abstract val id: String
        data class App(val key: String) : Item() { override val id get() = key }
        class Folder(override val id: String, var name: String, val apps: MutableList<String>) : Item()
    }

    private val prefs = Ares.prefs(c)
    private val collator = Collator.getInstance().apply { strength = Collator.PRIMARY }
    /** The owner's pages (custom order). */
    val pages: MutableList<MutableList<Item>> = ArrayList()
    var az: Boolean
        get() = prefs.getString("drawerSort", "mine") == "az"
        set(v) { prefs.edit().putString("drawerSort", if (v) "az" else "mine").apply() }
    var cols: Int = 4
        private set
    var rows: Int = 6
        private set
    val capacity get() = cols * rows

    init { load() }

    // ---- Persistence -------------------------------------------------------------------------------------------------

    private fun load() {
        prefs.getString("drawerGrid", "4x6")?.split('x')?.let { if (it.size == 2) { cols = it[0].toIntOrNull()?.coerceIn(3, 6) ?: 4; rows = it[1].toIntOrNull()?.coerceIn(3, 8) ?: 6 } }
        pages.clear()
        val saved = prefs.getString("drawerLayout", null)
        if (saved != null) runCatching {
            val a = JSONArray(saved)
            for (p in 0 until a.length()) {
                val pg = a.getJSONArray(p); val list = ArrayList<Item>()
                for (i in 0 until pg.length()) {
                    val o = pg.opt(i)
                    if (o is JSONObject) list += Item.Folder(o.optString("id").ifBlank { "f${System.nanoTime()}" }, o.optString("name", "Folder"), (0 until (o.optJSONArray("apps")?.length() ?: 0)).map { o.getJSONArray("apps").getString(it) }.toMutableList())
                    else if (o is String && o.isNotBlank()) list += Item.App(o)
                }
                pages += list
            }
        } else prefs.getString("drawerOrder", null)?.split('\n')?.filter { it.isNotBlank() }?.let { keys ->
            // The old single list (YOUR ORDER): the same order, cut into pages
            keys.chunked(capacity).forEach { pages += it.map<String, Item> { k -> Item.App(k) }.toMutableList() }
        }
        if (pages.isEmpty()) pages += ArrayList<Item>()
    }

    fun save() {
        val a = JSONArray()
        for (pg in pages) a.put(JSONArray().also { arr -> for (it0 in pg) arr.put(if (it0 is Item.Folder) JSONObject().put("id", it0.id).put("name", it0.name).put("apps", JSONArray(it0.apps)) else it0.id) })
        prefs.edit().putString("drawerLayout", a.toString()).apply()
    }

    /** The grid size ("4x6" / "5x6"): the pages re-flow in the same order to the new capacity. */
    fun setGrid(spec: String) {
        val (cc, rr) = spec.split('x').map { it.toInt() }
        if (cc == cols && rr == rows) return
        val flat = pages.flatten()
        cols = cc; rows = rr
        prefs.edit().putString("drawerGrid", spec).apply()
        pages.clear()
        flat.chunked(capacity).forEach { pages += it.toMutableList() }
        if (pages.isEmpty()) pages += ArrayList<Item>()
        save()
    }

    // ---- Keeping it true to the installed apps ------------------------------------------------------------------------

    /** Drop what's gone, dissolve single-app folders, add new installs to the end of the last page, remove empty pages. */
    fun reconcile(): Boolean {
        val all = Apps.all
        if (all.isEmpty()) return false
        val known = all.map { it.key }.toHashSet()
        var changed = false
        val placed = HashSet<String>()
        for (pg in pages) {
            val it0 = pg.listIterator()
            while (it0.hasNext()) {
                when (val item = it0.next()) {
                    is Item.App -> if (item.key !in known || !placed.add(item.key)) { it0.remove(); changed = true }
                    is Item.Folder -> {
                        if (item.apps.retainAll { it in known && placed.add(it) }) changed = true
                        if (item.apps.isEmpty()) { it0.remove(); changed = true }
                        else if (item.apps.size == 1) { it0.set(Item.App(item.apps[0])); changed = true }
                    }
                }
            }
        }
        val fresh = all.filter { it.key !in placed }.sortedWith { a, b -> collator.compare(a.label, b.label) }
        for (app in fresh) { append(Item.App(app.key)); changed = true }
        if (trim()) changed = true
        if (changed) save()
        return changed
    }

    /** Onto the end of the last page, or a new page when it's full. */
    fun append(item: Item) {
        if (pages.isEmpty() || pages.last().size >= capacity) pages += ArrayList<Item>()
        pages.last() += item
    }

    /** Remove empty pages (always keeping one). True if any went. */
    fun trim(): Boolean {
        val n = pages.size
        pages.removeAll { it.isEmpty() }
        if (pages.isEmpty()) pages += ArrayList<Item>()
        return pages.size != n
    }

    // ---- What's shown -------------------------------------------------------------------------------------------------

    fun label(item: Item): String = when (item) { is Item.App -> Apps.find(item.key)?.label ?: ""; is Item.Folder -> item.name }

    /** The pages as the drawer shows them: the owner's, or everything A–Z (folders sorted among the apps by name). */
    fun arranged(): List<List<Item>> {
        if (!az) return pages.map { it.toList() }
        val items = pages.flatten().sortedWith { a, b -> collator.compare(label(a), label(b)) }
        return items.chunked(capacity).ifEmpty { listOf(emptyList()) }
    }

    /** Leaving A–Z by dragging: the A–Z order becomes the custom one (like YOUR ORDER did). */
    fun adoptAz() {
        if (!az) return
        val flat = arranged().flatten()
        pages.clear(); flat.chunked(capacity).forEach { pages += it.toMutableList() }
        if (pages.isEmpty()) pages += ArrayList<Item>()
        az = false
        save()
    }

    fun find(id: String): Pair<Int, Int>? {
        for ((p, pg) in pages.withIndex()) { val i = pg.indexOfFirst { it.id == id }; if (i >= 0) return p to i }
        return null
    }
    fun folder(id: String): Item.Folder? = pages.flatten().filterIsInstance<Item.Folder>().firstOrNull { it.id == id }
    fun folderOf(key: String): Item.Folder? = pages.flatten().filterIsInstance<Item.Folder>().firstOrNull { key in it.apps }

    // ---- Editing (custom order) -------------------------------------------------------------------------------------------

    /** Take an item off its page (no trimming: the page may be mid-drag). */
    fun remove(id: String): Item? {
        val (p, i) = find(id) ?: return null
        return pages[p].removeAt(i)
    }

    /** Put an item at (page, index), creating the page if needed; a full page pushes its last item onto the next one, and so on. */
    fun insert(page: Int, index: Int, item: Item) {
        while (pages.size <= page) pages += ArrayList<Item>()
        val pg = pages[page]
        pg.add(index.coerceIn(0, pg.size), item)
        var p = page
        while (pages[p].size > capacity) {
            val spill = pages[p].removeAt(pages[p].size - 1)
            if (pages.size <= p + 1) pages += ArrayList<Item>()
            pages[p + 1].add(0, spill)
            p++
        }
    }

    /** Move an item within or between pages. */
    fun move(id: String, page: Int, index: Int) {
        val item = remove(id) ?: return
        insert(page, index, item)
    }

    /** A new folder in place of `target`, holding it and `dragged` (both apps). */
    fun makeFolder(target: Item.App, dragged: Item.App): Item.Folder {
        val f = Item.Folder("f${System.currentTimeMillis().toString(36)}", folderName(listOf(target.key, dragged.key)), mutableListOf(target.key, dragged.key))
        remove(dragged.id)
        val (p, i) = find(target.id) ?: run { append(f); return f }
        pages[p][i] = f
        return f
    }

    fun addToFolder(folder: Item.Folder, dragged: Item.App) {
        remove(dragged.id)
        if (dragged.key !in folder.apps) folder.apps += dragged.key
    }

    /** An app out of its folder (dissolving the folder if one app is left); the app isn't placed yet. */
    fun takeOut(folder: Item.Folder, key: String): Item.App {
        folder.apps.remove(key)
        if (folder.apps.size == 1) find(folder.id)?.let { (p, i) -> pages[p][i] = Item.App(folder.apps[0]) }
        else if (folder.apps.isEmpty()) remove(folder.id)
        return Item.App(key)
    }

    /** A name from the apps' categories when they agree, else "Folder". */
    fun folderName(keys: List<String>): String {
        val cats = keys.mapNotNull { k -> Apps.find(k)?.info?.applicationInfo?.category }.toSet()
        if (cats.size != 1) return "Folder"
        return when (cats.first()) {
            ApplicationInfo.CATEGORY_GAME -> "Games"; ApplicationInfo.CATEGORY_AUDIO -> "Music"; ApplicationInfo.CATEGORY_VIDEO -> "Video"
            ApplicationInfo.CATEGORY_IMAGE -> "Photos"; ApplicationInfo.CATEGORY_SOCIAL -> "Social"; ApplicationInfo.CATEGORY_NEWS -> "News"
            ApplicationInfo.CATEGORY_MAPS -> "Maps"; ApplicationInfo.CATEGORY_PRODUCTIVITY -> "Work"; else -> "Folder"
        }
    }
}
