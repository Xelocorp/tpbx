// Preload: exposes a small, safe bridge to the renderer. The renderer never
// gets Node or ipcRenderer directly (contextIsolation stays on).

import { contextBridge, ipcRenderer } from "electron";
import type { Conn } from "../shared/config";

export interface SipStateEvent {
  state: "connecting" | "registered" | "failed" | "stopped";
  detail?: string;
}

export interface SipCallEvent {
  state: "idle" | "outgoing" | "incoming" | "active" | "ended";
  detail?: string;
}

const api = {
  // Raw-transport (UDP/TCP/TLS) registration, handled in the main process
  // (native pjsua engine when bundled — with audio — else register-only).
  register: (conn: Conn): Promise<boolean> => ipcRenderer.invoke("sip:register", conn),
  unregister: (): Promise<boolean> => ipcRenderer.invoke("sip:unregister"),
  // Native call control for UDP/TCP/TLS (no-ops on WSS, which SIP.js handles).
  call: (target: string): Promise<boolean> => ipcRenderer.invoke("sip:call", target),
  answer: (): Promise<boolean> => ipcRenderer.invoke("sip:answer"),
  hangup: (): Promise<boolean> => ipcRenderer.invoke("sip:hangup"),
  dtmf: (digits: string): Promise<boolean> => ipcRenderer.invoke("sip:dtmf", digits),
  // Mark a host as trusted for a self-signed cert (used by the WSS path).
  trustHost: (host: string): Promise<boolean> => ipcRenderer.invoke("cert:trust", host),
  // Subscribe to registration state updates from the main process. Returns an
  // unsubscribe function.
  onState: (cb: (e: SipStateEvent) => void): (() => void) => {
    const listener = (_e: unknown, payload: SipStateEvent) => cb(payload);
    ipcRenderer.on("sip:state", listener);
    return () => ipcRenderer.removeListener("sip:state", listener);
  },
  // Subscribe to native call-state updates (UDP/TCP/TLS path).
  onCallState: (cb: (e: SipCallEvent) => void): (() => void) => {
    const listener = (_e: unknown, payload: SipCallEvent) => cb(payload);
    ipcRenderer.on("sip:call-state", listener);
    return () => ipcRenderer.removeListener("sip:call-state", listener);
  },
  // Window controls for the frameless iPhone-mockup shell.
  minimize: (): void => ipcRenderer.send("win:minimize"),
  close: (): void => ipcRenderer.send("win:close"),
};

contextBridge.exposeInMainWorld("sipNative", api);

export type SipNative = typeof api;
