plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.kapt")
}
android {
    namespace = "com.flitfancy.mobile"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.flitfancy.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "WEBSITE_URL", "\"https://flitfancy.com/\"")
        buildConfigField("String", "UPLOAD_BASE", "\"https://console.flitfancy.com\"")
    }
    signingConfigs {
        create("localRelease") {
            storeFile = System.getenv("FLIT_ANDROID_KEYSTORE")?.let { file(it) }
            storePassword = System.getenv("FLIT_ANDROID_STORE_PASSWORD")
            keyAlias = "flitfancy"
            keyPassword = System.getenv("FLIT_ANDROID_STORE_PASSWORD")
        }
    }
    buildTypes {
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("localRelease") }
    }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
kapt { correctErrorTypes = true }
dependencies {
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.webkit:webkit:1.15.0")
    implementation("androidx.room:room-runtime:2.8.4")
    implementation("androidx.room:room-ktx:2.8.4")
    kapt("androidx.room:room-compiler:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("org.robolectric:robolectric:4.16")
}
