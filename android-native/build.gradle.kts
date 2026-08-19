// Root build file. The native XeloVoice Android softphone (pjsua2) is built
// here; this milestone-0 scaffold establishes the toolchain (assembles an APK)
// before PJSIP is layered in. See docs/NATIVE_SOFTPHONE.md.
plugins {
    id("com.android.application") version "8.5.2" apply false
    // Applied by :app only when a google-services.json is present (FCM opt-in).
    id("com.google.gms.google-services") version "4.4.2" apply false
}
