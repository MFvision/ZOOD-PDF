plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    api(libs.adhan)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

tasks.test {
    // Shared fixtures and packs live outside the Gradle project; both platforms read the same files.
    systemProperty("nm.root", rootProject.projectDir.parentFile.absolutePath)
    inputs.dir(rootProject.projectDir.parentFile.resolve("shared"))
    inputs.dir(rootProject.projectDir.parentFile.resolve("packs"))
}
