# XeloVoice Android softphone — build plan

This documents how the Android softphone is delivered and the plan for the
native build. The **download plumbing is already in place**: the admin console
shows a "Softphone (Android)" button that serves
`/downloads/xelovoice-softphone.apk` (a disabled "not published" state until an
APK is provisioned), and `scripts/lib.sh provision_softphone_apk` places the APK
into the console's downloads during `install.sh` / `upgrade.sh` from any of:

- `TPBX_SOFTPHONE_APK` — a local `.apk` path to copy;
- `TPBX_SOFTPHONE_APK_URL` — a URL to download;
- `TPBX_GITHUB_TOKEN` — fetch the `xelovoice-softphone.apk` asset from the
  `softphone-latest` GitHub Release (same token/repo/tag as the Windows build);
- a local Gradle build at `android/app/build/outputs/apk/release/*.apk`.

So once a build produces `xelovoice-softphone.apk` and attaches it to the
`softphone-latest` release, the Android button goes live exactly like Windows.

## Chosen approach: native PJSIP

Per the product decision, the Android app is a **native app with a real SIP +
media engine (PJSIP / pjsua2)** so all transports (UDP/TCP/TLS **and** WSS)
carry audio — unlike the Windows/desktop app where UDP/TCP/TLS are
registration-only. This is a substantial native project and is **not buildable
or verifiable in the cloud CI container used for the rest of this repo**; it
needs the Android SDK + NDK and a compiled PJSIP.

### Structure (to add under `android/`)

```
android/
├── settings.gradle, build.gradle          Gradle project
├── app/
│   ├── build.gradle                        applicationId com.xelocorp.xelovoice
│   └── src/main/
│       ├── AndroidManifest.xml             RECORD_AUDIO, INTERNET, FOREGROUND_SERVICE, POST_NOTIFICATIONS
│       ├── java/com/xelocorp/xelovoice/
│       │   ├── MainActivity.kt             dialer / recents / settings UI (Compose)
│       │   ├── sip/PjsipService.kt         foreground Service wrapping pjsua2
│       │   ├── sip/SipEngine.kt            register/call/hold/DTMF over UDP/TCP/TLS/WSS
│       │   ├── CallActivity.kt             full-screen incoming/in-call (mirrors the desktop UI)
│       │   └── analytics/Telemetry.kt      POST /api/agent/telemetry (same as desktop)
│       └── jniLibs/<abi>/libpjsua2.so      prebuilt PJSIP (per ABI)
```

### Build pipeline (to add: `.github/workflows/build-softphone-android.yml`)

1. `runs-on: ubuntu-latest`, `actions/setup-java`, `android-actions/setup-android`.
2. Provide PJSIP: either build it in-workflow with the NDK (slow) or vendor a
   prebuilt `libpjsua2.so` per ABI (arm64-v8a, armeabi-v7a, x86_64).
3. `./gradlew assembleRelease` → sign with a release keystore (CI secret) →
   `xelovoice-softphone.apk`.
4. Upload as an artifact and attach to the `softphone-latest` release (reusing
   `softprops/action-gh-release`), so `provision_softphone_apk` can fetch it.

### Remaining native work (the large part)

- Integrate **pjsua2** (JNI/`.so`) and implement register/call/hold/transfer/
  DTMF, mirroring the desktop `wssPhone`/`sipSignaling` semantics but with real
  media on every transport.
- **Audio**: OpenSL ES / AAudio device, echo cancellation, speaker/earpiece.
- **Background + incoming calls**: a foreground `Service` for registration and a
  **push (FCM)** path (or a persistent connection) so calls ring when the app is
  backgrounded — Android kills long-lived sockets otherwise.
- **UI**: reuse the light dialer/recents/incoming/in-call design from the
  desktop softphone (Jetpack Compose), plus the post-call **wrap-up** capture so
  Android calls feed the same analytics dashboard.
- **Telemetry**: same `/api/agent/*` login + `/api/agent/telemetry` calls.

### Faster alternative (if priorities change)

A **Capacitor** wrapper around the existing web softphone (`desktop/src/renderer`
is already web tech) would produce a **CI-buildable APK today** with working
WSS/WebRTC audio — the same WSS-primary trade-off as the desktop app (no raw
UDP/TCP/TLS media). It reuses all the UI, telemetry, call-waiting and wrap-up
code already written, and only the native raw-transport media would be missing.
