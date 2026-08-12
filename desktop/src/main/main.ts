// Electron main process for the XeloVoice softphone.
//
// Responsibilities:
//   - create the window and load the renderer,
//   - allow the agent to opt into accepting a self-signed server cert (common
//     for Asterisk WSS/TLS), scoped to the configured host,
//   - run SIP REGISTER for the raw transports (UDP/TCP/TLS) via sipSignaling,
//     relaying status to the renderer over IPC. The renderer owns the WSS path.

import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { SipRegistration, type RegState } from "./sipSignaling";
import type { Conn } from "../shared/config";

let win: BrowserWindow | null = null;
let registration: SipRegistration | null = null;

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
    },
  });

  // Open external links (e.g. help) in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
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

ipcMain.handle("sip:register", (_e, conn: Conn) => {
  if (conn.ignoreCertErrors && conn.server) trustedHosts.add(conn.server);
  registration?.stop();
  registration = new SipRegistration(conn, emit);
  registration.start();
  return true;
});

ipcMain.handle("sip:unregister", () => {
  registration?.stop();
  registration = null;
  return true;
});

// Let the renderer register a host as trusted for the WSS path too.
ipcMain.handle("cert:trust", (_e, host: string) => {
  if (host) trustedHosts.add(host);
  return true;
});

// Window controls for the frameless (iPhone-mockup) shell.
ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:close", () => win?.close());

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  registration?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
