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

dependencies {
    // FCM lets Asterisk wake the app to ring when the OS has killed the
    // service. The code compiles unconditionally; push only activates once a
    // google-services.json is dropped in (see docs/ANDROID_NATIVE_SETUP.md).
    implementation("com.google.firebase:firebase-messaging:24.0.0")
}

// Activate Firebase only when configured, so CI stays green without secrets.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
