# XeloVoice Softphone (Windows)

An Electron desktop softphone for XeloVoice. The agent picks a SIP transport and
only the fields that transport needs are shown.

- **WSS / WebRTC** — the primary path. Full registration, inbound/outbound
  calls, DTMF, mute, DND and blind transfer, with STUN/TURN. Runs in the
  renderer via [SIP.js](https://sipjs.com).
- **UDP / TCP / TLS** — SIP `REGISTER` (with digest auth) over a raw socket in
  the Electron main process, so the agent can register and verify connectivity
  on these transports. Two-way **audio** on these legacy transports needs a
  native media engine and is not included in this build — place calls over WSS.

## Develop

```bash
cd desktop
npm install
npm run build        # esbuild bundles main + renderer into dist/
npm start            # launches Electron against dist/
npm run typecheck    # tsc --noEmit
```

## Package the Windows installer

```bash
npm run dist         # electron-builder --win nsis  -> release/xelovoice-softphone-setup.exe
```

CI does this on `windows-latest` (`.github/workflows/build-softphone.yml`): it
builds the installer and publishes it to a rolling GitHub Release tagged
`softphone-latest` (and to `softphone-v*` tags for versioned releases).

## Getting the installer onto the server (making the button live)

The admin console serves the installer from its own disk at
`/downloads/xelovoice-softphone-setup.exe` (`web/dist/downloads/`, the same place
as the extension zips) and shows a "Softphone (not published)" state until the
file is present. `scripts/lib.sh provision_softphone` (run by `install.sh` /
`upgrade.sh`) puts it there, trying in order:

1. `TPBX_SOFTPHONE_EXE` — a local installer path to copy;
2. `TPBX_SOFTPHONE_EXE_URL` — a URL to download;
3. `TPBX_GITHUB_TOKEN` — **the recommended path**: fetch the `softphone-latest`
   release asset via the GitHub API (read-only token; works for the private
   repo). Override the repo/tag with `TPBX_GITHUB_REPO` /
   `TPBX_SOFTPHONE_RELEASE_TAG`;
4. a local `desktop/release/` build.

So the steady-state flow is: push a desktop change → CI rebuilds and updates the
`softphone-latest` release → run `sudo ./upgrade.sh` on the server (with
`TPBX_GITHUB_TOKEN` set in `/etc/tpbx/tpbx.env`) → the button serves the newest
installer.

## Layout

```
desktop/
├── src/
│   ├── shared/config.ts      Connection model + per-transport required fields
│   ├── main/
│   │   ├── main.ts           Window, IPC, per-host self-signed-cert opt-in
│   │   ├── preload.ts        contextBridge -> window.sipNative
│   │   └── sipSignaling.ts   UDP/TCP/TLS SIP REGISTER (digest auth)
│   └── renderer/
│       ├── renderer.tsx      React UI: transport-aware connect form + dialer
│       ├── wssPhone.ts       SIP.js WSS/WebRTC softphone
│       ├── index.html, styles.css
│       └── global.d.ts       window.sipNative typing
├── electron-builder.yml
├── package.json
└── tsconfig.json
```
