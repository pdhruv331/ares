import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing: a private key kept on this Mac (android/ares.jks), so every update installs over the last one
val keys = Properties().apply { rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use(::load) }

android {
    namespace = "com.dhruv.ares"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dhruv.ares"
        minSdk = 34 // built for the Galaxy S26 Ultra; nothing older needed
        targetSdk = 36
        versionCode = (findProperty("aresVersionCode") as String?)?.toInt() ?: 1 // set by build.sh
        versionName = "0.5.0"
    }

    signingConfigs {
        if (keys.isNotEmpty()) create("ares") {
            storeFile = rootProject.file(keys.getProperty("storeFile"))
            storePassword = keys.getProperty("storePassword")
            keyAlias = keys.getProperty("keyAlias")
            keyPassword = keys.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("ares")
        }
    }
}

// The one third-party library: Firebase Cloud Messaging, to receive call and ARES notifications with the Mac off.
// No google-services plugin, no analytics: the app is configured at runtime from the Mac (Push.kt).
dependencies {
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    // Phone UI v3 (docs/phone-ui-prompt.md): springs for every gesture (Motion.kt), jank measurement, the baseline profile
    implementation("androidx.dynamicanimation:dynamicanimation:1.1.0")
    implementation("androidx.metrics:metrics-performance:1.0.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
}

// ARES's 3D brain (the same files as the Mac app) bundled into the APK, so the app's brain works offline
val brainAssets = layout.buildDirectory.dir("generated/brainAssets")
val copyBrain by tasks.registering(Copy::class) {
    into(brainAssets.map { it.dir("brain") })
    from("src/main/brain")
    from(rootProject.file("../src/renderer")) { include("perf.js", "neural.js", "brain3d.mjs", "brain-mesh.js"); into("src/renderer") }
    from(rootProject.file("../node_modules/three/build")) { include("three.module.js", "three.core.js"); into("node_modules/three/build") }
}
android.sourceSets["main"].assets.srcDir(brainAssets.get().asFile)

// The phone's three short sounds (Sounds.kt) are the Mac's own WAVs (src/renderer/sounds), copied in at build time
val soundRes = layout.buildDirectory.dir("generated/soundRes")
val copySounds by tasks.registering(Copy::class) {
    into(soundRes.map { it.dir("raw") })
    from(rootProject.file("../src/renderer/sounds")) { include("tick.wav", "ptt-on.wav", "ptt-off.wav") }
    rename { it.replace('-', '_') }
}
android.sourceSets["main"].res.srcDir(soundRes.get().asFile)

tasks.named("preBuild") { dependsOn(copyBrain, copySounds) }
