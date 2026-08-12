// Minimal SIP REGISTER client for the raw transports (UDP / TCP / TLS).
//
// The renderer (Chromium) can only speak SIP over WebSocket, so when the agent
// picks UDP/TCP/TLS the registration runs here in the Node main process, which
// has real sockets. This implements REGISTER with HTTP digest auth and periodic
// re-registration, and reports status back to the UI. It deliberately does NOT
// carry media: two-way audio over non-WebRTC RTP needs a native media engine,
// which is a separate effort. WSS/WebRTC calls (the primary path) are fully
// handled in the renderer by SIP.js.

import dgram from "node:dgram";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import type { Conn } from "../shared/config";

export type RegState = "connecting" | "registered" | "failed" | "stopped";

export interface Reporter {
  (state: RegState, detail?: string): void;
}

interface Socketish {
  send(data: string): void;
  close(): void;
  localAddress(): string;
}

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

function randHex(n: number): string {
  return crypto.randomBytes(n).toString("hex");
}

// Parse a WWW-Authenticate / Proxy-Authenticate header value into fields.
function parseAuth(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip the leading scheme ("Digest ").
  const idx = header.indexOf(" ");
  const params = idx >= 0 ? header.slice(idx + 1) : header;
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim();
  }
  return out;
}

// A single REGISTER session over one raw transport. Reconnects/re-registers on
// a timer; stop() tears everything down.
export class SipRegistration {
  private socket?: Socketish;
  private cseq = 0;
  private callId = randHex(12);
  private fromTag = randHex(6);
  private nc = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly expires = 300;

  constructor(private readonly c: Conn, private readonly report: Reporter) {}

  start(): void {
    this.stopped = false;
    this.report("connecting");
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Best-effort de-registration (Expires: 0), then close.
    try {
      if (this.socket) this.sendRegister(0);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      this.socket?.close();
      this.socket = undefined;
      this.report("stopped");
    }, 150);
  }

  private port(): number {
    const p = parseInt(this.c.port || "0", 10);
    return p > 0 ? p : this.c.transport === "tls" ? 5061 : 5060;
  }

  private open(): void {
    const host = this.c.server;
    const port = this.port();
    const onData = (buf: Buffer) => this.onMessage(buf.toString("utf8"));
    const onErr = (e: Error) => {
      if (!this.stopped) this.retry("socket error: " + e.message);
    };

    if (this.c.transport === "udp") {
      const s = dgram.createSocket("udp4");
      s.on("message", onData);
      s.on("error", onErr);
      s.connect(port, host, () => {
        const addr = s.address();
        this.socket = {
          send: (d) => s.send(Buffer.from(d)),
          close: () => {
            try {
              s.close();
            } catch {
              /* ignore */
            }
          },
          localAddress: () => addr.address,
        };
        this.sendRegister(this.expires);
      });
      return;
    }

    if (this.c.transport === "tcp") {
      const s = net.connect(port, host, () => {
        this.socket = {
          send: (d) => s.write(d),
          close: () => s.destroy(),
          localAddress: () => s.localAddress || "0.0.0.0",
        };
        this.sendRegister(this.expires);
      });
      s.on("data", onData);
      s.on("error", onErr);
      s.on("close", () => {
        if (!this.stopped) this.retry("connection closed");
      });
      return;
    }

    // tls
    const s = tls.connect(
      { host, port, servername: host, rejectUnauthorized: !this.c.ignoreCertErrors },
      () => {
        this.socket = {
          send: (d) => s.write(d),
          close: () => s.destroy(),
          localAddress: () => s.localAddress || "0.0.0.0",
        };
        this.sendRegister(this.expires);
      }
    );
    s.on("data", onData);
    s.on("error", onErr);
    s.on("close", () => {
      if (!this.stopped) this.retry("connection closed");
    });
  }

  private transportToken(): string {
    return this.c.transport.toUpperCase(); // UDP | TCP | TLS
  }

  private sendRegister(expires: number, auth?: string): void {
    if (!this.socket) return;
    this.cseq += 1;
    const local = this.socket.localAddress();
    const lport = this.port(); // advertised contact port (best-effort)
    const branch = "z9hG4bK" + randHex(8);
    const target = `sip:${this.c.server}`;
    const aor = `sip:${this.c.extension}@${this.c.server}`;
    const contact = `sip:${this.c.extension}@${local}:${lport};transport=${this.c.transport}`;
    const display = this.c.displayName ? `"${this.c.displayName}" ` : "";

    const lines = [
      `REGISTER ${target} SIP/2.0`,
      `Via: SIP/2.0/${this.transportToken()} ${local}:${lport};branch=${branch};rport`,
      `Max-Forwards: 70`,
      `From: ${display}<${aor}>;tag=${this.fromTag}`,
      `To: <${aor}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} REGISTER`,
      `Contact: <${contact}>`,
      `Expires: ${expires}`,
      `User-Agent: XeloVoice-Softphone`,
    ];
    if (auth) lines.push(auth);
    lines.push(`Content-Length: 0`, "", "");
    this.socket.send(lines.join("\r\n"));
  }

  private onMessage(msg: string): void {
    const statusLine = msg.split("\r\n", 1)[0] || "";
    const m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(statusLine);
    if (!m) return; // not a response (e.g. a stray request); ignore for REGISTER
    const code = parseInt(m[1], 10);
    const reason = m[2] || "";

    if (code === 401 || code === 407) {
      this.handleChallenge(msg, code);
      return;
    }
    if (code >= 200 && code < 300) {
      this.report("registered");
      this.scheduleReRegister();
      return;
    }
    if (code >= 300) {
      this.report("failed", `registration rejected (${code} ${reason})`);
      this.scheduleRetry();
    }
  }

  private handleChallenge(msg: string, code: number): void {
    const headerName = code === 407 ? "proxy-authenticate" : "www-authenticate";
    const line = msg
      .split("\r\n")
      .find((l) => l.toLowerCase().startsWith(headerName + ":"));
    if (!line) {
      this.report("failed", "auth challenge missing");
      return;
    }
    const p = parseAuth(line.slice(line.indexOf(":") + 1).trim());
    const realm = p["realm"] || "";
    const nonce = p["nonce"] || "";
    const qop = p["qop"];
    const opaque = p["opaque"];
    const uri = `sip:${this.c.server}`;

    const ha1 = md5(`${this.c.extension}:${realm}:${this.c.password}`);
    const ha2 = md5(`REGISTER:${uri}`);
    let response: string;
    let extra = "";
    if (qop && qop.split(",").map((x) => x.trim()).includes("auth")) {
      this.nc += 1;
      const ncValue = this.nc.toString(16).padStart(8, "0");
      const cnonce = randHex(8);
      response = md5(`${ha1}:${nonce}:${ncValue}:${cnonce}:auth:${ha2}`);
      extra = `, qop=auth, nc=${ncValue}, cnonce="${cnonce}"`;
    } else {
      response = md5(`${ha1}:${nonce}:${ha2}`);
    }

    const scheme = code === 407 ? "Proxy-Authorization" : "Authorization";
    let header =
      `${scheme}: Digest username="${this.c.extension}", realm="${realm}", ` +
      `nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
    if (opaque) header += `, opaque="${opaque}"`;
    header += extra;

    this.sendRegister(this.expires, header);
  }

  private scheduleReRegister(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    // Re-register at half the granted lifetime (simple, safe).
    this.timer = setTimeout(() => this.sendRegister(this.expires), (this.expires / 2) * 1000);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sendRegister(this.expires), 10_000);
  }

  private retry(detail: string): void {
    if (this.stopped) return;
    this.report("connecting", detail);
    this.socket?.close();
    this.socket = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), 3000);
  }
}
