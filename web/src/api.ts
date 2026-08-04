// API + live-event client for the TPBX console.
//
// REST calls hit the Go backend under /api; the live event stream is a single
// WebSocket at /ws that fans out normalised AMI/ARI events.

export interface Endpoint {
  technology: string;
  resource: string;
  state: string;
  channel_ids: string[] | null;
}

export interface Channel {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  creationtime: string;
}

export interface Status {
  time: string;
  endpoints?: Endpoint[];
  channels?: Channel[];
  endpoints_error?: string;
  channels_error?: string;
}

export interface Health {
  status: string;
  database: string;
  time: string;
}

export interface WsEnvelope {
  kind: "hello" | "ari" | "ami";
  data: any;
}

export async function getStatus(): Promise<Status> {
  const r = await fetch("/api/status");
  if (!r.ok) throw new Error(`status ${r.status}`);
  return r.json();
}

export async function getHealth(): Promise<Health> {
  const r = await fetch("/api/health");
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}

// connectEvents opens the live WebSocket and invokes onMessage for each frame.
// It reconnects automatically with a small backoff. Returns a close function.
export function connectEvents(
  onMessage: (env: WsEnvelope) => void,
  onOpenChange: (open: boolean) => void
): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let backoff = 1000;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 1000;
      onOpenChange(true);
    };
    ws.onclose = () => {
      onOpenChange(false);
      if (!closed) {
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
