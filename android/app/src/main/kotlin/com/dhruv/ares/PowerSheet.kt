package com.dhruv.ares

import android.app.Activity
import android.app.Dialog
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView

/** SLIDE TO POWER DOWN (docs/ignition-prompt.md §4e): the bottom sheet the app's ⏻ and the home screen's menu both use. */
object PowerSheet {
    fun show(a: Activity, onConfirm: () -> Unit): Dialog {
        val d = Dialog(a, R.style.Theme_Ares_Sheet)
        d.setContentView(R.layout.dialog_power)
        d.window?.apply { setGravity(Gravity.BOTTOM); setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); setBackgroundDrawableResource(android.R.color.transparent) }
        val jobs = JobStore.working
        d.findViewById<TextView>(R.id.sheetSub).text = "${if (jobs > 0) "$jobs job${if (jobs == 1) "" else "s"} pause" else "Jobs pause"} · phone access stops"
        val slide = d.findViewById<SlideView>(R.id.slide)
        slide.onDetent = { Haptics.tick(a) }
        slide.onSpringBack = { Haptics.tick(a) }
        slide.onComplete = {
            Haptics.heavy(a)
            d.dismiss()
            onConfirm()
        }
        d.findViewById<View>(R.id.sheetCancel).setOnClickListener { d.dismiss() }
        d.show()
        return d
    }
}
