plugins {
    id("com.android.application")
}

android {
    namespace = "com.xelocorp.xelovoice"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xelocorp.xelovoice"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.6.0"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
