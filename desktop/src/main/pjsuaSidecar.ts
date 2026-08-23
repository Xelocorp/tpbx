// Native media sidecar for the raw transports (UDP / TCP / TLS).
//
// The Chromium renderer can only carry audio over WebRTC/WSS. To place and
// receive calls with two-way audio on UDP/TCP/TLS, the main process drives
// PJSIP's `pjsua` command-line softphone (built by desktop/native, bundled as
// an extraResource) over its stdin menu, and parses stdout for registration
// and call state. WSS stays entirely on SIP.js in the renderer.
//
// Built/verified on Windows: the control protocol (pjsua's interactive menu)
// is exercised on a real device; see docs/NATIVE_SOFTPHONE.md.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Conn } from "../shared/config";

export type RegState = "connecting" | "registered" | "failed" | "stopped";
export type CallState = "idle" | "outgoing" | "incoming" | "active" | "ended";

export interface SidecarReporter {
  onReg(state: RegState, detail?: string): void;
  onCall(state: CallState, detail?: string): void;
}

/** Locate the bundled pjsua.exe (packaged) or the CI/dev build output. */
export function locatePjsua(): string | null {
  const candidates = [
    path.join(process.resourcesPath || "", "pjsua", "pjsua.exe"),
    path.join(__dirname, "..", "..", "native", "out", "pjsua.exe"),
    path.join(process.cwd(), "native", "out", "pjsua.exe"),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

export class PjsuaSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private stopped = false;

  constructor(
    private readonly exe: string,
    private readonly c: Conn,
    private readonly report: SidecarReporter
  ) {}

  private port(): number {
    const p = parseInt(this.c.port || "0", 10);
    return p > 0 ? p : this.c.transport === "tls" ? 5061 : 5060;
  }

  start(): void {
    this.stopped = false;
    this.report.onReg("connecting");

    const t = this.c.transport; // udp | tcp | tls
    const reg = `sip:${this.c.server}:${this.port()};transport=${t}`;
    const id = `sip:${this.c.extension}@${this.c.server}`;
    const args = [
      "--id", id,
      "--registrar", reg,
      "--realm", "*",
      "--username", this.c.extension,
      "--password", this.c.password,
      "--reg-timeout", "300",
      "--auto-answer", "0",
      "--no-vad",
      "--app-log-level", "3",
    ];
    if (t === "tls") {
      args.push("--use-tls");
      // Self-signed servers are common; only verify when the agent didn't opt
      // into accepting an untrusted cert.
      if (!this.c.ignoreCertErrors) args.push("--tls-verify-server");
    }

    // NAT traversal via the configured STUN/TURN (so UDP/TCP/TLS audio works
    // behind NAT, same servers the WebRTC path uses).
    const stun = firstHost(this.c.stunUrls);
    const turn = firstHost(this.c.turnUrls);
    if (stun) args.push("--stun-srv", stun);
    if (turn) {
      args.push("--use-ice", "--turn-srv", turn);
      if (this.c.turnUser) args.push("--turn-user", this.c.turnUser);
      if (this.c.turnPass) args.push("--turn-passwd", this.c.turnPass);
      if (/transport=tcp/i.test(this.c.turnUrls)) args.push("--turn-tcp");
    } else if (stun) {
      args.push("--use-ice");
    }

    const proc = spawn(this.exe, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout.on("data", (d: Buffer) => this.onOut(d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => this.onOut(d.toString("utf8")));
    proc.on("error", (e) => { if (!this.stopped) this.report.onReg("failed", e.message); });
    proc.on("exit", () => { if (!this.stopped) this.report.onReg("failed", "engine exited"); });
  }

  private write(cmd: string): void {
    try { this.proc?.stdin.write(cmd.endsWith("\n") ? cmd : cmd + "\n"); } catch { /* ignore */ }
  }

  // pjsua interactive menu: `m` then a URL makes a call.
  call(target: string): void {
    const dest = target.startsWith("sip")
      ? target
      : `sip:${target}@${this.c.server};transport=${this.c.transport}`;
    this.report.onCall("outgoing", target);
    this.write("m");
    this.write(dest);
  }

  answer(): void { this.write("a"); this.write("200"); }
  hangup(): void { this.write("h"); }
  dtmf(digits: string): void { this.write("#"); this.write(digits); }

  stop(): void {
    this.stopped = true;
    this.write("q"); // graceful pjsua quit (unregisters)
    const p = this.proc;
    this.proc = null;
    setTimeout(() => { try { p?.kill(); } catch { /* ignore */ } }, 400);
    this.report.onReg("stopped");
  }

  // Parse pjsua's line-oriented output for registration + call transitions.
  private onOut(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() || "";
    for (const line of lines) this.onLine(line);
  }

  private onLine(line: string): void {
    const l = line.toLowerCase();
    // Registration
    if (l.includes("registration success") || /registration.*status=2\d\d/.test(l)) {
      this.report.onReg("registered");
    } else if (l.includes("registration failed") || /sip registration.*failed/.test(l)) {
      this.report.onReg("failed", line.trim());
    }
    // Calls (pjsua prints "Call N state changed to CONFIRMED/DISCONNECTED", and
    // "Incoming call for account ..." on inbound INVITE).
    if (l.includes("incoming call")) {
      this.report.onCall("incoming", extractPeer(line));
    } else if (l.includes("state changed to confirmed") || l.includes("call state: confirmed")) {
      this.report.onCall("active");
    } else if (l.includes("state changed to disconnected") || l.includes("call disconnected") ||
               l.includes("state changed to null")) {
      this.report.onCall("ended");
    }
  }
}

function extractPeer(line: string): string {
  const m = /sips?:([^@>\s]+)@/.exec(line);
  return m ? m[1] : "";
}

// Take the first entry of a comma-separated STUN/TURN list and reduce it to the
// bare "host[:port]" pjsua expects (strip stun:/turn(s): scheme and any query).
function firstHost(list: string): string {
  const first = (list || "").split(",")[0].trim();
  if (!first) return "";
  let v = first.replace(/^stuns?:/i, "").replace(/^turns?:/i, "");
  const q = v.indexOf("?");
  if (q >= 0) v = v.slice(0, q);
  return v.trim();
}
