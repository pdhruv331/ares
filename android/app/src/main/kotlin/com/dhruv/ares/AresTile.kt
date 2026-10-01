package com.dhruv.ares

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: one swipe down and a tap, and ARES is listening. */
class AresTile : TileService() {
    companion object {
        fun refresh(c: Context) = runCatching { requestListeningState(c, ComponentName(c, AresTile::class.java)) }
    }

    override fun onStartListening() {
        val tile = qsTile ?: return
        val status = Ares.status(this)
        tile.state = if (status == "online") Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "ARES"
        tile.subtitle = when (status) { "online" -> "Tap to talk"; "offline" -> "Mac offline"; else -> "Not paired" }
        tile.updateTile()
    }

    override fun onClick() {
        val open = {
            val i = if (Ares.paired(this)) AskActivity.intent(this, listen = true) else Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivityAndCollapse(PendingIntent.getActivity(this, 1, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        }
        if (isLocked) unlockAndRun(open) else open()
    }
}

/** Start ARES's notification and bubble when the phone boots or the app is updated. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) AresService.start(c)
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Updater.remindAutoBlocker(c)
    }
}
