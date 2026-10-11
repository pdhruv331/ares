# Macrobenchmark + Baseline Profile (docs/phone-ui-prompt.md §10)

Numbers come from the REAL Galaxy, never the emulator (its software GPU says nothing about the panel).

## Jank while you use it (no extra module)

JankStats runs in every ARES screen (`Perf.kt`) with named states (`HomePager=Swiping`, `Reactor=Summon`, …) and logs
every frame over budget, not only the ones JankStats calls jank. With the phone plugged in:

```
scripts/phone-jank.sh            # tails ARES.jank from logcat; Ctrl-C prints a summary
```

Then flick pages, pull the drawer, throw the bubble, summon from Chrome. Each logged line names the state it happened in.

## Macrobenchmark (startup + the swipe), run on demand

The module is kept out of the normal build (it needs a connected device and the benchmark plugins). To run it:

```
cd android && ./gradlew -PmacroBench=1 :macrobenchmark:connectedBenchmarkAndroidTest
```

`settings.gradle.kts` includes `:macrobenchmark` only with `-PmacroBench=1`. The module measures cold startup of
HomeActivity and a page flick (`StartupBenchmark`, `SwipeBenchmark`), and `./gradlew -PmacroBench=1 :macrobenchmark:generateBaselineProfile`
regenerates `app/src/main/baseline-prof.txt` from what the device actually ran (replace the hand-written one).
