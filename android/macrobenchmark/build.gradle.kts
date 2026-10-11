// Only included with -PmacroBench=1 (settings.gradle.kts): needs a connected device and the benchmark plugins.
plugins {
    id("com.android.test")
    id("androidx.baselineprofile")
}
android {
    namespace = "com.dhruv.ares.macrobenchmark"
    compileSdk = 36
    defaultConfig { minSdk = 34; targetSdk = 36; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    targetProjectPath = ":app"
    testOptions.managedDevices.allDevices.create<com.android.build.api.dsl.ManagedVirtualDevice>("pixel").apply { device = "Pixel 8"; apiLevel = 36; systemImageSource = "google" }
}
dependencies {
    implementation("androidx.benchmark:benchmark-macro-junit4:1.3.4")
    implementation("androidx.test.ext:junit:1.2.1")
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
