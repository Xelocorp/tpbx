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

        ndk {
            // ABIs we ship prebuilt libpjsua2.so for (see scripts/build-pjsip.sh).
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    // libpjsua2.so + libc++_shared.so are prebuilt and vendored into
    // src/main/jniLibs by CI; keep them as-is (already NDK-built).
    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
