package com.dhruv.ares

import android.animation.ValueAnimator
import android.view.View
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.FloatPropertyCompat
import androidx.dynamicanimation.animation.FloatValueHolder
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import java.util.WeakHashMap
import kotlin.math.abs
import kotlin.math.sign

/**
 * The phone's motion kit (docs/phone-ui-prompt.md §1): every moving surface tracks the finger 1:1, then springs on from
 * the finger's own velocity. Spring tokens are Material 3 Expressive's (damping / stiffness, as in the Compose source):
 * spatial springs (position, size) may overshoot; effects springs (alpha, colour, glow) never do. Taps open critically
 * damped; anything released from a fling keeps a little bounce. The system's "Remove animations" setting makes every
 * spring land instantly.
 */
object Motion {
    class Spec(val damping: Float, val stiffness: Float) {
        fun force(target: Float) = SpringForce(target).setDampingRatio(damping).setStiffness(stiffness)
    }
    val FastSpatial = Spec(0.6f, 800f)
    val DefaultSpatial = Spec(0.8f, 380f)
    val SlowSpatial = Spec(0.8f, 200f)
    val FastEffects = Spec(1f, 3800f)
    val DefaultEffects = Spec(1f, 1600f)
    val SlowEffects = Spec(1f, 800f)
    /** A sheet or card opened by a tap: no overshoot at all (Apple's rule: 100% damping for taps, ~80% for flings). */
    val TapSpatial = Spec(1f, 380f)
    val TapSlow = Spec(1f, 200f)

    val enabled: Boolean get() = ValueAnimator.areAnimatorsEnabled()

    /** How far something thrown at `velocity` (units/s) would travel before resting; the destination is picked from this. */
    fun project(velocity: Float, horizonS: Float = 0.35f) = velocity * horizonS

    /**
     * Apple's rubber band: past an edge the offset grows ever more slowly. `over` is how far past the edge the finger is
     * (positive), `limit` the size of the surface (the band can never exceed `limit * c`).
     */
    fun rubber(over: Float, limit: Float, c: Float = 0.55f): Float {
        if (over <= 0f || limit <= 0f) return 0f
        return (1f - 1f / (over * c / limit + 1f)) * limit
    }
    /** The same, signed, for a value that may be past either end of [lo, hi]. */
    fun band(value: Float, lo: Float, hi: Float, limit: Float, c: Float = 0.55f): Float = when {
        value < lo -> lo - rubber(lo - value, limit, c)
        value > hi -> hi + rubber(value - hi, limit, c)
        else -> value
    }

    // ---- Springs on views -------------------------------------------------------------------------------------------
    // One SpringAnimation per view and property, reused: a new target retargets the running spring (animateToFinalPosition)
    // instead of restarting it, so a finger landing mid-flight never causes a jump.
    private val springs = WeakHashMap<View, HashMap<FloatPropertyCompat<View>, SpringAnimation>>()

    val X: FloatPropertyCompat<View> = DynamicAnimation.TRANSLATION_X
    val Y: FloatPropertyCompat<View> = DynamicAnimation.TRANSLATION_Y
    val SCALE_X: FloatPropertyCompat<View> = DynamicAnimation.SCALE_X
    val SCALE_Y: FloatPropertyCompat<View> = DynamicAnimation.SCALE_Y
    val ALPHA: FloatPropertyCompat<View> = DynamicAnimation.ALPHA

    private fun springOf(v: View, prop: FloatPropertyCompat<View>): SpringAnimation {
        val map = springs.getOrPut(v) { HashMap() }
        return map.getOrPut(prop) {
            SpringAnimation(v, prop).apply {
                spring = DefaultSpatial.force(prop.getValue(v))
                minimumVisibleChange = when (prop) { SCALE_X, SCALE_Y -> DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE; ALPHA -> DynamicAnimation.MIN_VISIBLE_CHANGE_ALPHA; else -> DynamicAnimation.MIN_VISIBLE_CHANGE_PIXELS }
            }
        }
    }

    /**
     * Spring `prop` of `v` to `target` (retargeting if it's already moving). `velocity` is the finger's, in units/s, for a
     * release; `onSettle` runs once when the spring comes to rest (not when it's retargeted away).
     */
    fun to(v: View, prop: FloatPropertyCompat<View>, target: Float, spec: Spec = DefaultSpatial, velocity: Float? = null, onSettle: (() -> Unit)? = null): SpringAnimation {
        val s = springOf(v, prop)
        if (!enabled) { s.cancel(); prop.setValue(v, target); onSettle?.invoke(); return s }
        s.spring.setDampingRatio(spec.damping).setStiffness(spec.stiffness)
        if (onSettle != null) {
            val l = object : DynamicAnimation.OnAnimationEndListener {
                override fun onAnimationEnd(a: DynamicAnimation<out DynamicAnimation<*>>, canceled: Boolean, value: Float, vel: Float) {
                    a.removeEndListener(this)
                    if (!canceled) onSettle()
                }
            }
            s.addEndListener(l)
        }
        if (velocity != null) s.setStartVelocity(velocity)
        if (s.isRunning) s.animateToFinalPosition(target) else { s.spring.finalPosition = target; s.start() }
        return s
    }
    fun cancel(v: View, prop: FloatPropertyCompat<View>) { springs[v]?.get(prop)?.cancel() }
    fun cancelAll(v: View) { springs[v]?.values?.forEach { it.cancel() } }
    fun isMoving(v: View, prop: FloatPropertyCompat<View>) = springs[v]?.get(prop)?.isRunning == true

    /** Scale both axes together. */
    fun scale(v: View, target: Float, spec: Spec = DefaultSpatial, velocity: Float? = null, onSettle: (() -> Unit)? = null) {
        to(v, SCALE_X, target, spec, velocity)
        to(v, SCALE_Y, target, spec, velocity, onSettle)
    }

    /** Rows or tiles entering 15–30 ms apart on the same spring: each from `dy` below and transparent to its place. */
    fun stagger(views: List<View>, dy: Float, stepMs: Long = 20, spec: Spec = DefaultSpatial) {
        if (!enabled) { for (v in views) { v.translationY = 0f; v.alpha = 1f }; return }
        views.forEachIndexed { i, v ->
            cancel(v, Y); cancel(v, ALPHA)
            v.translationY = dy; v.alpha = 0f
            v.postDelayed({ if (v.isAttachedToWindow) { to(v, Y, 0f, spec); to(v, ALPHA, 1f, DefaultEffects) } else { v.translationY = 0f; v.alpha = 1f } }, i * stepMs)
        }
    }

    // ---- A sprung value (the pager's offset, a sheet's position, the reactor's parameters) ---------------------------------

    /** A float that tracks the finger directly (`set`) and springs to a target on release (`to`), calling `onUpdate` each frame. */
    class Value(initial: Float, private var spec: Spec = DefaultSpatial, private val onUpdate: (Float) -> Unit) {
        private val holder = FloatValueHolder(initial)
        private val anim = SpringAnimation(holder).apply {
            spring = spec.force(initial)
            addUpdateListener { _, v, _ -> onUpdate(v) }
        }
        var minimumVisibleChange: Float
            get() = anim.minimumVisibleChange
            set(v) { anim.minimumVisibleChange = v }
        val value: Float get() = holder.value
        val moving: Boolean get() = anim.isRunning
        /** The finger has it: stop any spring and set it directly. */
        fun set(v: Float) { if (anim.isRunning) anim.cancel(); holder.value = v; onUpdate(v) }
        fun to(target: Float, spec: Spec = this.spec, velocity: Float? = null, onSettle: (() -> Unit)? = null) {
            if (!enabled) { anim.cancel(); holder.value = target; onUpdate(target); onSettle?.invoke(); return }
            anim.spring.setDampingRatio(spec.damping).setStiffness(spec.stiffness)
            if (onSettle != null) anim.addEndListener(object : DynamicAnimation.OnAnimationEndListener {
                override fun onAnimationEnd(a: DynamicAnimation<out DynamicAnimation<*>>, canceled: Boolean, value: Float, vel: Float) { a.removeEndListener(this); if (!canceled) onSettle() }
            })
            if (velocity != null) anim.setStartVelocity(velocity)
            if (anim.isRunning) anim.animateToFinalPosition(target) else { anim.spring.finalPosition = target; anim.start() }
        }
        fun cancel() = anim.cancel()
    }

    /** Which of two rests a release lands on: the nearer to where the throw would end, unless the throw is clearly one way. */
    fun pick(value: Float, velocity: Float, a: Float, b: Float, minFling: Float): Float {
        if (abs(velocity) > minFling) return if (sign(velocity) == sign(b - a)) b else a
        val end = value + project(velocity)
        return if (abs(end - a) <= abs(end - b)) a else b
    }
}
