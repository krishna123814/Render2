plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.simplelauncher"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.simplelauncher"
        minSdk = 24
        targetSdk = 34

        val vcProp = (project.findProperty("vc") as String?)?.toIntOrNull()
        versionCode = vcProp ?: (System.currentTimeMillis() / 60000L).toInt()
        versionName = "1.0"
    }

    // Keystore GitHub Secrets se build ke waqt app/lion-release.jks me banti hai (repo me nahi).
    // Secrets na hon to build debug key se chalti hai.
    val lionKs = file("lion-release.jks")
    val lionPass = System.getenv("LION_STORE_PASSWORD")
    val lionAlias = System.getenv("LION_KEY_ALIAS") ?: "lion"
    val lionKeyPass = System.getenv("LION_KEY_PASSWORD") ?: lionPass
    if (lionKs.exists() && !lionPass.isNullOrEmpty()) {
        signingConfigs {
            create("lion") {
                storeFile = lionKs
                storePassword = lionPass
                keyAlias = lionAlias
                keyPassword = lionKeyPass
            }
        }
    }

    buildTypes {
        debug {
            signingConfigs.findByName("lion")?.let { signingConfig = it }
        }
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("lion")?.let { signingConfig = it }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
