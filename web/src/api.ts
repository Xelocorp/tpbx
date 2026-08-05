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

export interface AsteriskInfo {
  system?: { version?: string; entity_id?: string };
  status?: { startup_time?: string; last_reload_time?: string };
}

export async function getAsteriskInfo(): Promise<AsteriskInfo> {
  const r = await fetch("/api/asterisk/info");
  if (!r.ok) throw new Error(`info ${r.status}`);
  return r.json();
}

// jsonPost/jsonDelete throw an Error carrying the backend error message so the
// UI can surface exactly why a control action failed.
async function request(method: string, url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `${method} ${url} failed (${r.status})`);
  return data;
}

export interface OriginateInput {
  endpoint: string;
  extension: string;
  context: string;
  callerId?: string;
}

export function originate(input: OriginateInput): Promise<any> {
  return request("POST", "/api/originate", input);
}

export function hangup(channelId: string): Promise<any> {
  return request("DELETE", `/api/channels/${encodeURIComponent(channelId)}`);
}

export function reloadModule(module: string): Promise<any> {
  return request("POST", "/api/reload", { module });
}

// --- Extensions (Phase 3) ---------------------------------------------------

export interface Extension {
  id: string;
  password?: string;
  context: string;
  transport: string;
  codecs: string;
  callerId: string;
  maxContacts: number;
  webrtc: boolean;
  dtmfMode: string;
}

export async function listExtensions(): Promise<Extension[]> {
  const r = await fetch("/api/extensions");
  if (!r.ok) throw new Error(`extensions ${r.status}`);
  const data = await r.json();
  return data.extensions ?? [];
}

export async function getExtension(id: string): Promise<Extension> {
  return request("GET", `/api/extensions/${encodeURIComponent(id)}`);
}

export function createExtension(e: Partial<Extension>): Promise<any> {
  return request("POST", "/api/extensions", e);
}

export function updateExtension(id: string, e: Partial<Extension>): Promise<any> {
  return request("PUT", `/api/extensions/${encodeURIComponent(id)}`, e);
}

export function deleteExtension(id: string): Promise<any> {
  return request("DELETE", `/api/extensions/${encodeURIComponent(id)}`);
}

// --- Trunks (Phase 4) -------------------------------------------------------

export interface Trunk {
  name: string;
  mode: "register" | "ip";
  host: string;
  port: number;
  username: string;
  password?: string;
  fromUser: string;
  fromDomain: string;
  context: string;
  transport: string;
  codecs: string;
  // state is live reachability from Asterisk (online/offline/unknown),
  // populated on list responses only; not part of the stored trunk.
  state?: string;
}

export async function listTrunks(): Promise<Trunk[]> {
  const r = await fetch("/api/trunks");
  if (!r.ok) throw new Error(`trunks ${r.status}`);
  const data = await r.json();
  return data.trunks ?? [];
}

export async function getTrunk(id: string): Promise<Trunk> {
  return request("GET", `/api/trunks/${encodeURIComponent(id)}`);
}

export function createTrunk(t: Partial<Trunk>): Promise<any> {
  return request("POST", "/api/trunks", t);
}

export function updateTrunk(id: string, t: Partial<Trunk>): Promise<any> {
  return request("PUT", `/api/trunks/${encodeURIComponent(id)}`, t);
}

export function deleteTrunk(id: string): Promise<any> {
  return request("DELETE", `/api/trunks/${encodeURIComponent(id)}`);
}

// --- Routing (Phase 5) ------------------------------------------------------

export interface OutboundRoute {
  id: number;
  name: string;
  pattern: string;
  trunk: string;
  strip: number;
  prepend: string;
  callerId: string;
  position: number;
  enabled: boolean;
}

export interface InboundRoute {
  id: number;
  name: string;
  did: string;
  destination: string;
  enabled: boolean;
}

export async function listOutboundRoutes(): Promise<OutboundRoute[]> {
  const r = await fetch("/api/routes/outbound");
  if (!r.ok) throw new Error(`outbound ${r.status}`);
  return (await r.json()).routes ?? [];
}
export function createOutboundRoute(r: Partial<OutboundRoute>): Promise<any> {
  return request("POST", "/api/routes/outbound", r);
}
export function updateOutboundRoute(id: number, r: Partial<OutboundRoute>): Promise<any> {
  return request("PUT", `/api/routes/outbound/${id}`, r);
}
export function deleteOutboundRoute(id: number): Promise<any> {
  return request("DELETE", `/api/routes/outbound/${id}`);
}

export async function listInboundRoutes(): Promise<InboundRoute[]> {
  const r = await fetch("/api/routes/inbound");
  if (!r.ok) throw new Error(`inbound ${r.status}`);
  return (await r.json()).routes ?? [];
}
export function createInboundRoute(r: Partial<InboundRoute>): Promise<any> {
  return request("POST", "/api/routes/inbound", r);
}
export function updateInboundRoute(id: number, r: Partial<InboundRoute>): Promise<any> {
  return request("PUT", `/api/routes/inbound/${id}`, r);
}
export function deleteInboundRoute(id: number): Promise<any> {
  return request("DELETE", `/api/routes/inbound/${id}`);
}

// --- Transports / TLS -------------------------------------------------------

export interface Transport {
  name: string;
  protocol: "udp" | "tcp" | "tls" | "wss";
  bindAddr: string;
  bindPort: number;
  tlsCertFile: string;
  tlsPrivKeyFile: string;
  tlsCaListFile: string;
  tlsMethod: string;
  externalMediaAddress: string;
  externalSignalingAddress: string;
  localNet: string;
  enabled: boolean;
  position: number;
}

export async function listTransports(): Promise<Transport[]> {
  const r = await fetch("/api/transports");
  if (!r.ok) throw new Error(`transports ${r.status}`);
  return (await r.json()).transports ?? [];
}
export async function getTransport(name: string): Promise<Transport> {
  return request("GET", `/api/transports/${encodeURIComponent(name)}`);
}
export function createTransport(t: Partial<Transport>): Promise<any> {
  return request("POST", "/api/transports", t);
}
export function updateTransport(name: string, t: Partial<Transport>): Promise<any> {
  return request("PUT", `/api/transports/${encodeURIComponent(name)}`, t);
}
export function deleteTransport(name: string): Promise<any> {
  return request("DELETE", `/api/transports/${encodeURIComponent(name)}`);
}
export function restartAsterisk(): Promise<any> {
  return request("POST", "/api/asterisk/restart");
}

// --- WebRTC / TURN settings (admin) -----------------------------------------

export interface WebRTCSettings {
  publicHost: string;
  wssPort: string;
  stunEnabled: boolean;
  turnEnabled: boolean;
  turnMode: "builtin" | "static" | "none";
  turnHost: string;
  turnUrls: string;
  turnStaticUser: string;
  turnStaticPassword: string;
  turnTls: boolean;
  iceTransportPolicy: "all" | "relay";
}

export interface WebRTCSettingsResponse {
  settings: WebRTCSettings;
  builtinReady: boolean;
}

export async function getWebRTCSettings(): Promise<WebRTCSettingsResponse> {
  const r = await fetch("/api/settings/webrtc");
  if (!r.ok) throw new Error(`settings ${r.status}`);
  return r.json();
}
export function saveWebRTCSettings(s: WebRTCSettings): Promise<any> {
  return request("PUT", "/api/settings/webrtc", s);
}

// --- Auth (Phase 8) ---------------------------------------------------------

export interface Me {
  username: string;
  role: string;
  displayName?: string;
}

// getMe returns the current user, or null if not authenticated (401).
export async function getMe(): Promise<Me | null> {
  const r = await fetch("/api/me");
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`me ${r.status}`);
  return r.json();
}

export function login(username: string, password: string): Promise<Me> {
  return request("POST", "/api/login", { username, password });
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" });
}

export function changePassword(password: string): Promise<any> {
  return request("POST", "/api/change-password", { password });
}

export interface GuiUser {
  username: string;
  role: string;
  displayName: string;
  disabled: boolean;
  lastLoginAt?: string;
}

export async function listUsers(): Promise<GuiUser[]> {
  const r = await fetch("/api/users");
  if (!r.ok) throw new Error(`users ${r.status}`);
  return (await r.json()).users ?? [];
}
export function createUser(u: { username: string; password: string; role: string; displayName?: string }): Promise<any> {
  return request("POST", "/api/users", u);
}
export function deleteUser(username: string): Promise<any> {
  return request("DELETE", `/api/users/${encodeURIComponent(username)}`);
}
export function resetUserPassword(username: string, password: string): Promise<any> {
  return request("POST", `/api/users/${encodeURIComponent(username)}/password`, { password });
}

// --- Call History / CDR -----------------------------------------------------

export interface CDRRecord {
  id: number;
  callDate: string;
  clid: string;
  src: string;
  dst: string;
  duration: number;
  billsec: number;
  disposition: string;
}

export interface CDRPage {
  records: CDRRecord[];
  total: number;
}

export async function listCDR(params: {
  q?: string;
  disposition?: string;
  limit: number;
  offset: number;
}): Promise<CDRPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.disposition) qs.set("disposition", params.disposition);
  qs.set("limit", String(params.limit));
  qs.set("offset", String(params.offset));
  const r = await fetch(`/api/cdr?${qs.toString()}`);
  if (!r.ok) throw new Error(`cdr ${r.status}`);
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
