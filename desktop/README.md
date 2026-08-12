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

CI does this on `windows-latest` (`.github/workflows/build-softphone.yml`) and
publishes `xelovoice-softphone-setup.exe`. The admin console links to it at
`/downloads/xelovoice-softphone-setup.exe` (served from `web/dist/downloads/`,
the same place as the browser-extension zips), so drop the built installer
there during deploy.

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
