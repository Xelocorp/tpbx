# Native softphone plan — PJSIP media on Android and Desktop

This is the execution plan for the two native efforts you asked for:

1. **Native Android app** — a ground-up Android softphone with a real SIP +
   media engine (PJSIP / **pjsua2**) so **UDP, TCP, TLS and WSS all carry
   audio**, plus background registration, incoming ring when closed, speaker /
   earpiece routing, and persistence across reboot.
2. **Desktop (Windows) native media** — give the existing Electron app real
   audio on **UDP/TCP/TLS** (today those transports register only; WSS already
   carries audio), by driving calls through a native PJSIP engine.

> **Build/verify constraint.** These cannot be compiled or run in the cloud
> container this repo is otherwise built in — they need the Android NDK/SDK, a
> Windows/macOS native toolchain, and real devices for audio testing. So this
> document is written to be executed on a proper native toolchain (Android
> Studio + a Windows build box / CI with the NDK). The web/Go/Electron-JS parts
> of the system stay CI-built as today.

---

## Part 1 — Native Android app (`android-native/`)

### Engine
- **pjsua2** (the C++/JNI high-level API over PJSIP). Build PJSIP for Android
  with the NDK for each ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`), producing
  `libpjsua2.so` + the generated `org.pjsip.pjsua2` Java bindings. Vendor the
  `.so` per ABI under `app/src/main/jniLibs/<abi>/` and the Java bindings as a
  source set (or an `.aar`).
- pjsua2 gives all four transports with media natively:
  `pjsua_transport_create` for UDP/TCP/TLS, and `PJSIP_TRANSPORT_WSS` for the
  WebSocket transport — one engine, feature-parity with (and beyond) the web app.

### Project layout
```
android-native/
├── settings.gradle.kts, build.gradle.kts
├── app/
│   ├── build.gradle.kts                 applicationId com.xelocorp.xelovoice
│   └── src/main/
│       ├── AndroidManifest.xml          RECORD_AUDIO, INTERNET, FOREGROUND_SERVICE,
│       │                                FOREGROUND_SERVICE_MICROPHONE, POST_NOTIFICATIONS,
│       │                                RECEIVE_BOOT_COMPLETED, USE_FULL_SCREEN_INTENT
│       ├── jniLibs/<abi>/libpjsua2.so   prebuilt PJSIP per ABI
│       ├── java/org/pjsip/pjsua2/...     generated bindings
│       └── java/com/xelocorp/xelovoice/
│           ├── sip/SipService.kt        foreground Service owning the pjsua2 Endpoint
│           ├── sip/SipEngine.kt         register/call/hold/DTMF/transfer per transport
│           ├── sip/Account.kt, Call.kt  pjsua2 Account/Call subclasses (callbacks)
│           ├── audio/AudioRoute.kt      AudioManager earpiece(default)/speaker toggle
│           ├── push/FcmService.kt       FirebaseMessagingService -> wake + register
│           ├── boot/BootReceiver.kt     RECEIVE_BOOT_COMPLETED -> start SipService
│           ├── ui/ (Jetpack Compose)    dialer / recents / incoming / in-call / wrap-up
│           │                            (mirror the light design from the web app)
│           └── net/Telemetry.kt         /api/agent/login + /api/agent/telemetry + /calls
```

### Background registration + incoming calls when closed
- **Foreground `SipService`** holds the pjsua2 `Endpoint` and the account
  registration for the app's whole lifetime, with an ongoing notification. This
  keeps SIP alive when the UI is minimised or closed.
- **Reboot persistence:** `BootReceiver` (RECEIVE_BOOT_COMPLETED) restarts
  `SipService`, which re-registers using the saved account — so registration
  survives reboot with no agent action. The agent only taps Connect again if
  they explicitly signed out.
- **Ring when the OS kills the service:** register the device with **FCM**;
  Asterisk (or a small server hook) sends a data push on an inbound INVITE,
  `FcmService` wakes `SipService`, which re-registers in time to receive the
  INVITE and shows a **full-screen incoming call** (`USE_FULL_SCREEN_INTENT`)
  that rings even from a locked screen.

### Speaker / earpiece
- Default to **earpiece**; a **Speaker** toggle on the in-call screen flips
  `AudioManager` (`setMode(MODE_IN_COMMUNICATION)`, `isSpeakerphoneOn` /
  `setCommunicationDevice` on API 31+). Wire it to a pjsua2 conf-port route.

### Telemetry / analytics parity
- Same `/api/agent/*` calls as the web app: login with extension+secret, POST
  call/dnd/register events and the **post-call wrap-up** disposition, and load
  **Recents** from `/api/agent/calls`. So Android calls feed the same green
  analytics dashboard and persist in Postgres exactly like desktop.

### CI (`.github/workflows/build-android-native.yml`)
1. `ubuntu-latest` + JDK 17 + `android-actions/setup-android` + **NDK**.
2. Build (or restore from cache/artifact) PJSIP `libpjsua2.so` per ABI.
3. `./gradlew assembleRelease`, sign with a release keystore (CI secret).
4. Publish `xelovoice-softphone.apk` to the `softphone-latest` release — the
   console's **Softphone (Android)** button already serves whatever APK is
   attached, so no console change is needed.

### Milestones
- **M1** register on all four transports + place/receive a WSS+audio call.
- **M2** audio on UDP/TCP/TLS; speaker/earpiece toggle.
- **M3** foreground service + reboot persistence.
- **M4** FCM push so it rings when the app is killed; full-screen incoming.
- **M5** wrap-up + telemetry + Recents parity; release signing.

---

## Part 2 — Desktop (Windows) native media for UDP/TCP/TLS

The Electron renderer (Chromium) can only do WebRTC/WSS media. To carry audio on
UDP/TCP/TLS it needs a native engine in the **main process**:

### Approach (recommended): pjsua2 sidecar / native addon
- Embed **pjsua2** in the desktop app as either
  (a) a **Node N-API native addon** (`desktop/native/`, built with `node-gyp` /
  `prebuild` per platform), or
  (b) a small **pjsua sidecar process** the main process controls over a local
  socket (simpler cross-compilation, no ABI coupling to Electron).
- The renderer keeps its current UI. When the transport is UDP/TCP/TLS, calls
  are driven through the native engine (register/INVITE/answer/hold/DTMF +
  audio device I/O) instead of SIP.js; **WSS stays on SIP.js/WebRTC** unchanged.
- Audio device selection (mic/speaker) via pjsua2's sound device layer.

### Build/CI
- Native addons/sidecar must be compiled **per OS/arch** (Windows x64 first).
  electron-builder bundles the prebuilt binary. This replaces the current
  "registration-only" behaviour on UDP/TCP/TLS with full calls.
- The Windows build box (or a Windows CI runner with MSVC + PJSIP) compiles and
  signs; the existing `build-softphone.yml` is extended to include the native
  artifact.

### Milestones
- **D1** sidecar/addon builds on Windows CI and registers over UDP/TCP/TLS.
- **D2** two-way audio on UDP/TCP/TLS; hold/DTMF/transfer parity.
- **D3** call-waiting + wrap-up + telemetry parity with the WSS path.

---

## How to actually get these built & tested

Because they can't be compiled or exercised here, the realistic paths are:

1. **Author in staged, reviewable commits that you build/test** on Android
   Studio (Android) and a Windows box (desktop addon). I write each milestone;
   you compile, run on a device, and report back; I iterate. Honest about the
   round-trip: I can't catch native compile/runtime errors on my side.
2. **Stand up a native CI** (NDK for Android; a Windows runner with MSVC + a
   prebuilt PJSIP for desktop). Once that exists, I can iterate against CI logs
   the same way I fixed the Windows/Capacitor builds.

Either way the server, analytics, telemetry, provisioning and download buttons
are already in place and unchanged — the native apps plug into the same
`/api/agent/*` endpoints and the same `softphone-latest` release flow.
