// Shared connection config between the renderer (UI + WSS/WebRTC via SIP.js)
// and the main process (UDP/TCP/TLS SIP registration over raw sockets).

export type Transport = "wss" | "tls" | "tcp" | "udp";

export interface Conn {
  transport: Transport;
  extension: string;
  password: string;
  displayName: string;
  server: string; // SIP domain / host (the part after @ and the target host)

  // Non-WSS transports (raw SIP): the signalling port.
  port: string;

  // WSS transport (WebRTC):
  wssPort: string; // Asterisk secure-WebSocket port (default 8089)
  wssUrl: string; // full override, e.g. wss://pbx.example.com/asterisk-ws ("" = derive)
  stunUrls: string; // comma-separated (optional)
  turnUrls: string; // comma-separated (optional)
  turnUser: string;
  turnPass: string;

  // TLS / WSS-over-self-signed: accept an untrusted server certificate.
  ignoreCertErrors: boolean;

  // Console origin for telemetry/analytics (blank = derive https://<server>).
  consoleUrl: string;
}

export const DEFAULT_CONN: Conn = {
  transport: "wss",
  extension: "",
  password: "",
  displayName: "",
  server: "",
  port: "5060",
  wssPort: "8089",
  wssUrl: "",
  stunUrls: "",
  turnUrls: "",
  turnUser: "",
  turnPass: "",
  ignoreCertErrors: false,
  consoleUrl: "",
};

// The default signalling port for a given raw-SIP transport.
export function defaultPort(t: Transport): string {
  return t === "tls" ? "5061" : "5060";
}

// deriveWssUrl mirrors the console's logic: an explicit WSS URL wins, otherwise
// build wss://<server>:<wssPort>/ws.
export function deriveWssUrl(c: Conn): string {
  const explicit = c.wssUrl.trim();
  if (explicit) return explicit;
  const port = c.wssPort.trim() || "8089";
  return `wss://${c.server}:${port}/ws`;
}

// Fields required for a given transport, used by the UI to show only what
// matters and to validate before connecting.
export function requiredFields(t: Transport): (keyof Conn)[] {
  const common: (keyof Conn)[] = ["extension", "password", "server"];
  if (t === "wss") return common; // wssPort has a default; wssUrl is optional
  return [...common, "port"];
}
