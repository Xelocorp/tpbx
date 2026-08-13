# XeloVoice Android softphone (Capacitor)

Milestone 1 of the Android softphone: a [Capacitor](https://capacitorjs.com)
wrapper that reuses the **shared web softphone** (the same light dialer /
recents / incoming / in-call UI, call waiting, DND, wrap-up and telemetry built
for the desktop app in `../desktop/src/renderer`). It runs in the Android
WebView, so **WSS / WebRTC** carries audio; raw UDP/TCP/TLS is not available
here (no Node), and the transport picker is locked to WSS on mobile.

The full **native PJSIP** app (raw-transport audio, FCM push) remains the
follow-on described in `../docs/ANDROID.md`.

## How the reuse works

- `src/shim.ts` sets `window.__XELO_MOBILE__` and a WSS-only `window.sipNative`
  bridge (register/window-controls become no-ops), so the shared renderer runs
  unchanged in the WebView.
- `src/main.tsx` loads the shared styles + shim, then imports the shared
  renderer (which mounts). The renderer hides the window chrome and restricts
  transports to WSS when `__XELO_MOBILE__` is set.
- Vite bundles it (`build` → `dist/`), and Capacitor packages `dist/` into the
  APK.

## Build locally

```bash
cd desktop && npm install     # shared renderer sources resolve their deps here
cd ../mobile && npm install
npm run build                 # vite -> dist/
npx cap add android           # generates the native project (once)
npx cap sync android
cd android && ./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

CI (`.github/workflows/build-softphone-android.yml`) does this on
`ubuntu-latest`, renames the APK to `xelovoice-softphone.apk`, and publishes it
to the `softphone-latest` release; `scripts/lib.sh provision_softphone_apk`
then serves it from the console's **Softphone (Android)** button.

## Known follow-ups

- **Microphone / WebRTC permission:** `RECORD_AUDIO` is added to the manifest,
  but the Capacitor WebView may also need `onPermissionRequest` handling to
  grant `getUserMedia` at runtime. If mic capture is denied on device, add a
  small `WebChromeClient.onPermissionRequest` grant in the generated
  `MainActivity`. (Milestone-1 builds and registers; verify audio on a device.)
- **Release signing:** the workflow builds a debug-signed APK (installable with
  "unknown sources"). Add a release keystore secret + `assembleRelease` for a
  Play-ready build.
- **Background incoming calls:** a foreground service / FCM push is needed for
  the app to ring when backgrounded — part of the native-engine follow-on.
