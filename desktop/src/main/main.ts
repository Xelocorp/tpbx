// Electron main process for the XeloVoice softphone.
//
// Responsibilities:
//   - create the window and load the renderer,
//   - allow the agent to opt into accepting a self-signed server cert (common
//     for Asterisk WSS/TLS), scoped to the configured host,
//   - run SIP REGISTER for the raw transports (UDP/TCP/TLS) via sipSignaling,
//     relaying status to the renderer over IPC. The renderer owns the WSS path.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import path from "node:path";
import { SipRegistration, type RegState } from "./sipSignaling";
import { PjsuaSidecar, locatePjsua, type CallState } from "./pjsuaSidecar";
import type { Conn } from "../shared/config";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let registration: SipRegistration | null = null; // register-only fallback
let sidecar: PjsuaSidecar | null = null;          // pjsua (UDP/TCP/TLS with audio)
let isQuitting = false; // true only when the user chooses Quit (vs close-to-tray)

// Hosts the agent has chosen to trust despite an untrusted certificate.
const trustedHosts = new Set<string>();

function createWindow(): void {
  win = new BrowserWindow({
    width: 390,
    height: 820,
    minWidth: 360,
    minHeight: 720,
    // Frameless so the renderer can draw an iPhone-style shell with its own
    // title/drag area and window controls.
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the renderer (and its SIP/WSS registration) fully alive while the
      // window is hidden/minimised, so the agent stays registered in the
      // background and incoming calls still ring.
      backgroundThrottling: false,
    },
  });

  // Open external links (e.g. help) in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Close-to-tray: closing the window hides it (registration keeps running);
  // the app only really exits from the tray's Quit.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

// A tiny green tray icon (no asset dependency) so the app can live in the
// background with the window closed.
function trayIcon(): Electron.NativeImage {
  // 16x16 solid-green PNG (data URL).
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNk" +
    "+M9Qz0BFwDiqgVENoxpGNYxqGNUwqmFUw6iGUQ0ANz0F+e3m0mkAAAAASUVORK5CYII=";
  return nativeImage.createFromDataURL(png);
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip("XeloVoice Softphone");
  const menu = Menu.buildFromTemplate([
    { label: "Open XeloVoice", click: () => showWindow() },
    { type: "separator" },
    {
      label: "Quit (stops registration)",
      click: () => {
        isQuitting = true;
        registration?.stop();
        sidecar?.stop();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showWindow());
}

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  win.show();
  win.focus();
}

// A softphone frequently talks to Asterisk over a self-signed cert. Rather than
// disabling TLS verification globally, only bypass it for a host the agent has
// explicitly marked as trusted (via the "accept self-signed certificate"
// option), and only for the WSS/TLS control connections.
app.on("certificate-error", (event, _wc, url, _error, _cert, callback) => {
  try {
    const host = new URL(url).hostname;
    if (trustedHosts.has(host)) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch {
    /* fall through to reject */
  }
  callback(false);
});

function emit(state: RegState, detail?: string): void {
  win?.webContents.send("sip:state", { state, detail });
}

function emitCall(state: CallState, detail?: string): void {
  win?.webContents.send("sip:call-state", { state, detail });
}

function stopRaw(): void {
  registration?.stop();
  registration = null;
  sidecar?.stop();
  sidecar = null;
}

ipcMain.handle("sip:register", (_e, conn: Conn) => {
  if (conn.ignoreCertErrors && conn.server) trustedHosts.add(conn.server);
  stopRaw();
  const exe = locatePjsua();
  if (exe) {
    // Native engine: registration AND two-way audio on UDP/TCP/TLS.
    sidecar = new PjsuaSidecar(exe, conn, {
      onReg: (s, d) => emit(s, d),
      onCall: (s, d) => emitCall(s, d),
    });
    sidecar.start();
  } else {
    // Fallback (e.g. sidecar not bundled): registration only, no media.
    registration = new SipRegistration(conn, emit);
    registration.start();
  }
  return true;
});

ipcMain.handle("sip:unregister", () => {
  stopRaw();
  return true;
});

// Native call control (UDP/TCP/TLS via the pjsua sidecar). No-ops if the
// sidecar isn't active (e.g. WSS, which the renderer handles itself).
ipcMain.handle("sip:call", (_e, target: string) => { sidecar?.call(target); return true; });
ipcMain.handle("sip:answer", () => { sidecar?.answer(); return true; });
ipcMain.handle("sip:hangup", () => { sidecar?.hangup(); return true; });
ipcMain.handle("sip:dtmf", (_e, digits: string) => { sidecar?.dtmf(digits); return true; });

// Let the renderer register a host as trusted for the WSS path too.
ipcMain.handle("cert:trust", (_e, host: string) => {
  if (host) trustedHosts.add(host);
  return true;
});

// Window controls for the frameless (iPhone-mockup) shell.
ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:close", () => win?.close());

app.whenReady().then(() => {
  createWindow();
  createTray();
  // Start on OS login so registration is restored after a restart / reboot
  // without the agent doing anything (the renderer auto-connects when it was
  // connected before). Best-effort; unsupported on some Linux setups.
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
  } catch {
    /* ignore */
  }
});

// Do NOT quit when the window is closed — the app lives in the tray and keeps
// the SIP registration alive in the background. It exits only via tray Quit.
app.on("window-all-closed", () => {
  /* stay running in the tray */
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showWindow();
});
