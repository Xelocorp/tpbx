// Softphone -> console telemetry (best-effort).
//
// The softphone talks straight to Asterisk for SIP/media, so the console does
// not otherwise know about DND toggles or the agent's view of a call (answered
// vs rejected vs missed). This logs into the agent API with the same extension
// + secret the phone already uses, then POSTs events. Everything here is
// fire-and-forget: if the console is unreachable the phone works unchanged.

export type TelemetryEvent =
  | { event: "registered" | "unregistered" | "dnd_on" | "dnd_off"; transport: string }
  | {
      event: "call";
      direction: "in" | "out";
      peer: string;
      outcome: "answered" | "rejected" | "missed" | "failed";
      durationSec: number;
      transport: string;
      // Post-call wrap-up disposition (answered calls only).
      nature?: "technical" | "billing" | "sales" | "other";
      resolution?: "resolved" | "unresolved";
      hangupCause?: "user_frustration" | "technical_drop" | "other";
      note?: string;
    };

export class Telemetry {
  private token: string | null = null;
  private base: string; // console origin, e.g. https://pbx.example.com

  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  // login exchanges the SIP extension + secret for an agent session token.
  // Returns true on success. Any failure disables telemetry silently.
  async login(extension: string, password: string): Promise<boolean> {
    if (!this.base) return false;
    try {
      const r = await fetch(`${this.base}/api/agent/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension, password }),
      });
      if (!r.ok) return false;
      const j = (await r.json()) as { token?: string };
      this.token = j.token || null;
      return this.token !== null;
    } catch {
      return false;
    }
  }

  send(ev: TelemetryEvent): void {
    if (!this.token || !this.base) return;
    void fetch(`${this.base}/api/agent/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(ev),
    }).catch(() => {
      /* best-effort */
    });
  }

  get enabled(): boolean {
    return this.token !== null;
  }

  // getCalls fetches the agent's persisted call log (Recents) from the server.
  async getCalls(): Promise<
    { direction: "in" | "out"; peer: string; outcome: string; durationSec: number; at: string }[]
  > {
    if (!this.token || !this.base) return [];
    try {
      const r = await fetch(`${this.base}/api/agent/calls`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { calls?: unknown[] };
      return (j.calls as never[]) || [];
    } catch {
      return [];
    }
  }

  // clearCalls deletes the agent's persisted call log.
  async clearCalls(): Promise<boolean> {
    if (!this.token || !this.base) return false;
    try {
      const r = await fetch(`${this.base}/api/agent/calls`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.token}` },
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}

// deriveConsoleBase guesses the console origin from the connection config. An
// explicit consoleUrl wins; otherwise assume the console is HTTPS on the same
// host as the SIP server (the common reverse-proxy deployment).
export function deriveConsoleBase(server: string, consoleUrl: string): string {
  const explicit = consoleUrl.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (!server) return "";
  return `https://${server}`;
}
