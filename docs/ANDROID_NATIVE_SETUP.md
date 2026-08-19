# Native Android softphone — build, install & activation

The native app (`android-native/`) is a ground-up Android softphone with a real
SIP + media engine (**PJSIP / pjsua2**), so **UDP, TCP and TLS all carry audio**
natively, with background registration, ring-when-closed, earpiece/speaker
routing and reboot persistence. It plugs into the same `/api/agent/*` endpoints
and green analytics dashboard as the desktop app.

Everything below the "needs your config" line builds and runs **without any
secrets** — CI produces a working debug APK on every push.

## What CI produces

`.github/workflows/build-android-native.yml` on each push:
1. Cross-compiles PJSIP + a static OpenSSL for `arm64-v8a` (cached ~8min → ~2min).
2. Vendors `libpjsua2.so` + `libc++_shared.so` + the generated `org.pjsip.pjsua2`
   Java bindings into the app module.
3. Assembles `app-debug.apk` and uploads it as the **`xelovoice-native-debug`**
   artifact.

Install it on a device: download the artifact, `adb install app-debug.apk`
(or open the APK on the phone with unknown-sources enabled).

## What works today

- **Register / call / hangup with two-way audio over UDP, TCP, TLS** (pick the
  transport in the dialer). TLS uses the linked OpenSSL; SRTP is available.
- **Background registration**: a foreground `SipService` keeps the extension
  registered when the app is minimised or closed. Tap **Register** once — it
  stays registered until **Unregister**.
- **Reboot persistence**: `BootReceiver` restarts the service and re-registers
  after a reboot, with no agent action.
- **Incoming calls ring** with a full-screen screen over the lock screen
  (`IncomingActivity`) + the default ringtone, whenever the service is alive.
- **Earpiece by default; Speaker toggle** on demand.
- **Telemetry + Recents**: calls log to `/api/agent/*` and feed the same
  analytics dashboard and Postgres-backed Recents as desktop.

---
## Needs your config

### 1. FCM — ring when the OS has *killed* the service
The foreground service covers minimise/close. To also ring after the OS kills
the service (Doze, or swipe-away on aggressive OEMs), the app uses Firebase Cloud
Messaging. The code is already in the app (`push/FcmService`); it activates when:

1. Create a Firebase project, add an Android app with package
   `com.xelocorp.xelovoice`, and download **`google-services.json`** into
   `android-native/app/`. (It's gitignored; the `com.google.gms.google-services`
   plugin auto-applies when present — no other build change needed.)
2. Server side: on an inbound INVITE for an extension, send an FCM **data**
   message to that agent's device token. The app stores its token
   (`FcmService.onNewToken` → `Prefs.pushToken`); wire the console to collect it
   (e.g. extend `/api/agent/telemetry`) and have Asterisk (or a dialplan hook)
   trigger the push. `FcmService.onMessageReceived` then wakes `SipService`,
   which re-registers in time to receive the INVITE and ring.

### 2. Release signing + the download button
The debug APK is unsigned-for-store. To ship a signed release and serve it from
the console's **Softphone (Android)** button:

1. Add a release keystore as CI secrets and a `signingConfigs { release { … } }`
   block in `app/build.gradle.kts`, then `assembleRelease`.
2. Publish `xelovoice-softphone.apk` to the `softphone-latest` GitHub Release
   (the console's Android download button already serves whatever APK is
   attached — see `scripts/lib.sh: provision_softphone_apk`), replacing the
   Capacitor APK.

Until then, the console's Android button serves the Capacitor WebRTC build; the
native APK is available as the CI artifact above for side-loading and testing.
