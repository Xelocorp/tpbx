# TPBX Softphone — browser extension

A background WebRTC softphone for Chrome and Firefox. The SIP registration lives
in the extension background, so calls arrive (with a desktop notification + ring)
even when no phone window is open.

## Architecture

- **Chrome (MV3):** a service worker (`sw.js`) keeps a hidden **offscreen
  document** (`offscreen.html`) alive; the offscreen doc runs the SIP engine
  (`engine.ts` → reuses the web softphone's `sip.ts`/`ringer.ts`). The worker
  owns notifications + downloads.
- **Firefox (MV3):** a **background page** (`background.html`) runs the same
  engine directly and handles notifications/downloads (Firefox has no offscreen
  API).
- **Popup** (`popup.html`) is a thin UI that talks to the engine over
  `runtime` messaging. **Options** (`options.html`) stores the server URL +
  extension + SIP password and grants the microphone.
- Auth is **token-based** (`Authorization: Bearer`) against `/api/agent/*`,
  which now sends CORS headers — the extension is cross-origin so cookies can't
  be used.

## Build

```bash
cd web
npm run build:ext      # -> web/dist-ext/
```

`dist-ext/manifest.json` is the Chrome manifest; `dist-ext/manifest.firefox.json`
is the Firefox one.

## Load it

**Chrome:** `chrome://extensions` → enable Developer mode → *Load unpacked* →
select `web/dist-ext`.

**Firefox:** in `dist-ext`, replace `manifest.json` with the contents of
`manifest.firefox.json` (Firefox needs `background.page`, not a service worker),
then `about:debugging` → This Firefox → *Load Temporary Add-on* → pick
`dist-ext/manifest.json`. (Or run `npx web-ext run` from `dist-ext` after the
swap.)

## First-run

1. Click the toolbar icon → **Set up** → enter the server URL (e.g.
   `https://pbx.eko.bz`), the extension, and its SIP password.
2. Click **Grant microphone** (once) so background calls have audio.
3. **Save & connect.** The popup shows **Ready** when registered; incoming calls
   ring + notify even with the popup closed.

## Known caveats (needs on-device testing)

- **Chrome mic in background:** getUserMedia must have been granted to the
  extension origin (the Options "Grant microphone" step) before the offscreen
  doc can capture audio.
- **MV3 service-worker lifetime:** the offscreen document holds the live
  WebSocket and persists independently; the worker is additionally kept warm by
  a 30s alarm.
- **Host permission** is broad (`*://*/*`) so any TPBX server URL can be
  configured; narrow it to your domain for a published build.
- The embedded notification icon is a placeholder — swap in a real 128px PNG for
  production.
