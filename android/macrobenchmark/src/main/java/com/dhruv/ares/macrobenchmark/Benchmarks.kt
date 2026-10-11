package com.dhruv.ares.macrobenchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private const val PKG = "com.dhruv.ares"

/** Cold start of the launcher, with and without the baseline profile. */
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule val rule = MacrobenchmarkRule()
    @Test fun coldNone() = run(CompilationMode.None())
    @Test fun coldPartial() = run(CompilationMode.Partial())
    private fun run(mode: CompilationMode) = rule.measureRepeated(PKG, listOf(StartupTimingMetric()), iterations = 5, startupMode = StartupMode.COLD, compilationMode = mode) {
        pressHome(); startActivityAndWait()
    }
}

/** Frame times while flicking between the two pages and pulling the drawer. */
@RunWith(AndroidJUnit4::class)
class SwipeBenchmark {
    @get:Rule val rule = MacrobenchmarkRule()
    @Test fun pages() = rule.measureRepeated(PKG, listOf(FrameTimingMetric()), iterations = 5, startupMode = StartupMode.WARM) {
        startActivityAndWait()
        val pager = device.findObject(By.res(PKG, "pager"))
        repeat(3) { pager.fling(Direction.LEFT); device.waitForIdle(); pager.fling(Direction.RIGHT); device.waitForIdle() }
        val dock = device.findObject(By.res(PKG, "bottom"))
        dock.swipe(Direction.UP, 0.8f); device.waitForIdle(); device.pressBack(); device.waitForIdle()
    }
}

/** Regenerates app/src/main/baseline-prof.txt from what the device actually ran. */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()
    @Test fun generate() = rule.collect(PKG, includeInStartupProfile = true) {
        pressHome(); startActivityAndWait()
        val pager = device.findObject(By.res(PKG, "pager"))
        pager.fling(Direction.LEFT); device.waitForIdle(); pager.fling(Direction.RIGHT); device.waitForIdle()
        device.findObject(By.res(PKG, "bottom")).swipe(Direction.UP, 0.8f); device.waitForIdle(); device.pressBack()
    }
}
