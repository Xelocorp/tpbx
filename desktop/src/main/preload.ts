// Preload: exposes a small, safe bridge to the renderer. The renderer never
// gets Node or ipcRenderer directly (contextIsolation stays on).

import { contextBridge, ipcRenderer } from "electron";
import type { Conn } from "../shared/config";

export interface SipStateEvent {
  state: "connecting" | "registered" | "failed" | "stopped";
  detail?: string;
}

const api = {
  // Raw-transport (UDP/TCP/TLS) registration, handled in the main process.
  register: (conn: Conn): Promise<boolean> => ipcRenderer.invoke("sip:register", conn),
  unregister: (): Promise<boolean> => ipcRenderer.invoke("sip:unregister"),
  // Mark a host as trusted for a self-signed cert (used by the WSS path).
  trustHost: (host: string): Promise<boolean> => ipcRenderer.invoke("cert:trust", host),
  // Subscribe to registration state updates from the main process. Returns an
  // unsubscribe function.
  onState: (cb: (e: SipStateEvent) => void): (() => void) => {
    const listener = (_e: unknown, payload: SipStateEvent) => cb(payload);
    ipcRenderer.on("sip:state", listener);
    return () => ipcRenderer.removeListener("sip:state", listener);
  },
  // Window controls for the frameless iPhone-mockup shell.
  minimize: (): void => ipcRenderer.send("win:minimize"),
  close: (): void => ipcRenderer.send("win:close"),
};

contextBridge.exposeInMainWorld("sipNative", api);

export type SipNative = typeof api;
