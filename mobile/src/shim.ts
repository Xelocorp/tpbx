// Platform shim: marks the mobile platform and provides a WSS-only native
// bridge so the shared softphone renderer runs inside the Android WebView,
// where there is no Node/IPC. Raw UDP/TCP/TLS registration and window controls
// are no-ops here; the renderer restricts the transport picker to WSS when
// __XELO_MOBILE__ is set.
//
// Imported before the renderer so window.sipNative exists when it mounts.

type StateCb = (e: { state: "connecting" | "registered" | "failed" | "stopped"; detail?: string }) => void;

interface Win {
  __XELO_MOBILE__?: boolean;
  sipNative?: unknown;
}

const w = window as unknown as Win;
w.__XELO_MOBILE__ = true;
w.sipNative = {
  register: async (): Promise<boolean> => false, // raw transports unsupported on mobile
  unregister: async (): Promise<boolean> => true,
  trustHost: async (): Promise<boolean> => true, // WSS cert handled by the OS trust store
  onState: (_cb: StateCb): (() => void) => () => {},
  minimize: (): void => {},
  close: (): void => {},
};
