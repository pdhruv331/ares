pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "ARES"
include(":app")
// The macrobenchmark + baseline profile module only on demand (docs/phone-ui-prompt.md §10): it needs a device and the benchmark plugins
if (providers.gradleProperty("macroBench").isPresent) include(":macrobenchmark")
