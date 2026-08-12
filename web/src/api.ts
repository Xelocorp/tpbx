// API + live-event client for the TPBX console.
//
// REST calls hit the Go backend under /api; the live event stream is a single
// WebSocket at /ws that fans out normalised AMI/ARI events.

// APP_VERSION is the XeloVoice console release, shown in the top bar. Bump this
// on each meaningful release (it is deliberately independent of the underlying
// PBX engine version, which is not surfaced to operators).
export const APP_VERSION = "V1.6";

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

// Live registration state of an extension (presence dot + device illustration).
export interface ExtStatus {
  online: boolean;
  ip?: string;
  port?: number;
  userAgent?: string;
  device: "mobile" | "web" | "desk" | "none";
  lastSeen?: string; // ISO time it was last seen registered (offline only)
}

export async function getExtensionStatus(): Promise<Record<string, ExtStatus>> {
  const r = await fetch("/api/extensions/status");
  if (!r.ok) throw new Error(`ext status ${r.status}`);
  return (await r.json()).status ?? {};
}

// resetExtensionPassword sets (or, with no password, generates) a new SIP
// secret and returns the value actually applied.
export async function resetExtensionPassword(
  id: string,
  password?: string
): Promise<{ password: string }> {
  return request("POST", `/api/extensions/${encodeURIComponent(id)}/password`, {
    password: password ?? "",
  });
}

export interface BulkResult {
  created: number;
  results: { id: string; ok: boolean; error?: string }[];
}

export function bulkCreateExtensions(extensions: Partial<Extension>[]): Promise<BulkResult> {
  return request("POST", "/api/extensions/bulk", { extensions });
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
  destType: "trunk" | "ivr";
  trunk: string;
  ivr: string;
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

// --- Global PJSIP / TLS settings (Misc PJSip + TLS/SSL/SRTP panels) ----------

export interface PJSIPSettings {
  allowTransportsReload: boolean;
  enableDebug: boolean;
  keepAliveInterval: number;
  contactCallerId: boolean;
  taskprocessorOverloadTrigger: "global" | "pjsip_only" | "none";
  endpointIdentifierOrder: string; // csv, e.g. "ip,username,anonymous"
  certName: string;
  tlsMethod: string;
  verifyClient: boolean;
  verifyServer: boolean;
}

export async function getPJSIPSettings(): Promise<PJSIPSettings> {
  const r = await fetch("/api/pjsip/settings");
  if (!r.ok) throw new Error(`pjsip settings ${r.status}`);
  return (await r.json()).settings;
}
export function savePJSIPSettings(s: PJSIPSettings): Promise<any> {
  return request("PUT", "/api/pjsip/settings", s);
}

// --- RTP stats (per channel) ------------------------------------------------

export interface RTPStat {
  rx: number; // packets received from the peer (peer is sending audio)
  tx: number; // packets sent to the peer (peer is receiving audio)
  known?: boolean; // false when Asterisk reported no RTP data at all
  raw?: string; // underlying QoS string, for diagnostics
}

export async function getRTP(): Promise<Record<string, RTPStat>> {
  const r = await fetch("/api/rtp");
  if (!r.ok) throw new Error(`rtp ${r.status}`);
  return (await r.json()).rtp ?? {};
}

// --- IVR / auto-attendant ---------------------------------------------------

export type IVRDestType =
  | "extension"
  | "ivr"
  | "voicemail"
  | "playback"
  | "external"
  | "queue"
  | "repeat"
  | "hangup";

export interface IVROption {
  digit: string;
  destType: IVRDestType;
  destValue: string;
  label: string;
}
export interface IVR {
  id: number;
  name: string;
  greeting: string;
  timeoutSec: number;
  maxRetries: number;
  invalidDest: string;
  timeoutDest: string;
  layout?: string; // opaque JSON for the visual builder canvas
  options: IVROption[];
}

export async function listIVRs(): Promise<IVR[]> {
  const r = await fetch("/api/ivrs");
  if (!r.ok) throw new Error(`ivrs ${r.status}`);
  return (await r.json()).ivrs ?? [];
}
export function getIVR(id: number): Promise<IVR> {
  return request("GET", `/api/ivrs/${id}`);
}
export function createIVR(v: Partial<IVR>): Promise<any> {
  return request("POST", "/api/ivrs", v);
}
export function updateIVR(id: number, v: Partial<IVR>): Promise<any> {
  return request("PUT", `/api/ivrs/${id}`, v);
}
export function deleteIVR(id: number): Promise<any> {
  return request("DELETE", `/api/ivrs/${id}`);
}

// --- IVR prompt library (uploaded .wav files) -------------------------------

export interface SoundFile {
  name: string; // bare name, no extension
  ref: string; // dialplan reference, e.g. "tpbx/welcome"
  file: string; // on-disk filename
  size: number;
  modified: string;
}

export interface SoundsResponse {
  sounds: SoundFile[];
  prefix: string;
  configured: boolean;
}

export async function listSounds(): Promise<SoundsResponse> {
  const r = await fetch("/api/sounds");
  if (!r.ok) throw new Error(`sounds ${r.status}`);
  return r.json();
}

export async function uploadSound(
  file: File,
  name?: string
): Promise<{ name: string; ref: string; note?: string }> {
  const fd = new FormData();
  fd.append("file", file);
  if (name) fd.append("name", name);
  const r = await fetch("/api/sounds", { method: "POST", body: fd });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `upload ${r.status}`);
  return data;
}

export function deleteSound(name: string): Promise<any> {
  return request("DELETE", `/api/sounds/${encodeURIComponent(name)}`);
}

export function soundAudioUrl(name: string): string {
  return `/api/sounds/${encodeURIComponent(name)}/audio`;
}

// --- WebRTC / TURN settings (admin) -----------------------------------------

export interface WebRTCSettings {
  publicHost: string;
  wssPort: string;
  wssUrl: string;
  stunEnabled: boolean;
  stunUrls: string;
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

// --- System / Branding settings (admin) -------------------------------------

export interface SystemSettings {
  publicDomain: string; // FQDN/IP agents reach; "" = derive from request host
  brandName: string; // shown in the console title / browser tab
  defaultTheme: "light" | "dark"; // default for users with no saved theme
  timezone: string; // IANA name (informational)
}

export interface SystemSettingsResponse {
  settings: SystemSettings;
  envDomain: string; // install-time TPBX_DOMAIN, shown as the fallback
}

export async function getSystemSettings(): Promise<SystemSettingsResponse> {
  const r = await fetch("/api/settings/system");
  if (!r.ok) throw new Error(`settings ${r.status}`);
  return r.json();
}
export function saveSystemSettings(s: SystemSettings): Promise<any> {
  return request("PUT", "/api/settings/system", s);
}

// InfraInfo is the read-only, masked infrastructure config shown on the System
// tab. Secrets (DB password, ARI/AMI passwords) are masked/omitted server-side.
export interface InfraInfo {
  httpAddr: string;
  databaseUrl: string;
  ariUrl: string;
  ariUser: string;
  amiAddr: string;
  amiUser: string;
  asteriskConf: string;
  dialplanFile: string;
  transportsFile: string;
  pjsipFile: string;
  soundsDir: string;
  wssPort: string;
}

export async function getInfra(): Promise<InfraInfo> {
  const r = await fetch("/api/settings/infra");
  if (!r.ok) throw new Error(`infra ${r.status}`);
  return r.json();
}

// Branding is the public (no-auth) brand name + default theme, fetched before
// login so the tab title and initial theme can be applied without a session.
export interface Branding {
  brandName: string;
  defaultTheme: "light" | "dark";
}

export async function getBranding(): Promise<Branding> {
  const r = await fetch("/api/branding");
  if (!r.ok) throw new Error(`branding ${r.status}`);
  return r.json();
}

// --- Analytics (manager/admin) ----------------------------------------------

export interface AgentStat {
  extension: string;
  displayName: string;
  calls: number;
  answered: number;
  inbound: number;
  outbound: number;
  missed: number;
  talkTotal: number;
  talkAvg: number;
  longest: number;
  transfers: number;
  hangupByAgent: number;
  hangupByOther: number;
}

export interface AgentAnalytics {
  from: string;
  to: string;
  agents: AgentStat[];
}

export async function getAgentAnalytics(days: number): Promise<AgentAnalytics> {
  const r = await fetch(`/api/analytics/agents?days=${days}`);
  if (!r.ok) throw new Error(`analytics ${r.status}`);
  return r.json();
}

// --- Auth (Phase 8) ---------------------------------------------------------

// Feature keys the permission matrix is expressed over (mirrors the backend
// store.Features list and the nav).
export type Feature =
  | "extensions"
  | "trunks"
  | "routing"
  | "ivr"
  | "cdr"
  | "analytics"
  | "transports"
  | "settings"
  | "users";
export type Action = "view" | "create" | "edit" | "delete";

export interface Perm {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}
export type Permissions = Partial<Record<Feature, Perm>>;

export interface Me {
  username: string;
  role: string;
  displayName?: string;
  permissions: Permissions;
  totpEnabled: boolean;
  totpSetupRequired: boolean;
}

// A login attempt either completes (returns Me) or asks for a second factor.
export type LoginResult = Me | { totpRequired: true };
export function isTotpRequired(r: LoginResult): r is { totpRequired: true } {
  return (r as { totpRequired?: boolean }).totpRequired === true;
}

// can reports whether the current user may perform an action on a feature.
export function can(me: Me | null, feature: Feature, action: Action): boolean {
  if (!me) return false;
  if (me.role === "admin") return true;
  return me.permissions?.[feature]?.[action] === true;
}

// getMe returns the current user, or null if not authenticated (401).
export async function getMe(): Promise<Me | null> {
  const r = await fetch("/api/me");
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`me ${r.status}`);
  return r.json();
}

export function login(username: string, password: string, totpCode?: string): Promise<LoginResult> {
  return request("POST", "/api/login", { username, password, totpCode });
}

// --- Two-factor (TOTP) ------------------------------------------------------

export interface TotpEnrollResponse {
  secret: string;
  otpauthUri: string;
}
export function enrollTotp(): Promise<TotpEnrollResponse> {
  return request("POST", "/api/totp/enroll");
}
export function activateTotp(code: string): Promise<any> {
  return request("POST", "/api/totp/activate", { code });
}
export function disableTotp(code: string): Promise<any> {
  return request("POST", "/api/totp/disable", { code });
}
export function resetUserTotp(username: string): Promise<any> {
  return request("POST", `/api/users/${encodeURIComponent(username)}/totp/reset`);
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
  totpEnabled: boolean;
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
export function updateUser(
  username: string,
  u: { role: string; displayName?: string; disabled?: boolean }
): Promise<any> {
  return request("PUT", `/api/users/${encodeURIComponent(username)}`, u);
}
export function deleteUser(username: string): Promise<any> {
  return request("DELETE", `/api/users/${encodeURIComponent(username)}`);
}
export function resetUserPassword(username: string, password: string): Promise<any> {
  return request("POST", `/api/users/${encodeURIComponent(username)}/password`, { password });
}

// --- Roles (RBAC) -----------------------------------------------------------

export interface Role {
  name: string;
  displayName: string;
  permissions: Permissions;
  requireTotp: boolean;
  builtIn: boolean;
}

export interface RolesResponse {
  roles: Role[];
  features: Feature[];
  actions: Action[];
}

export async function listRoles(): Promise<RolesResponse> {
  const r = await fetch("/api/roles");
  if (!r.ok) throw new Error(`roles ${r.status}`);
  return r.json();
}
export function createRole(role: {
  name: string;
  displayName: string;
  permissions: Permissions;
  requireTotp: boolean;
}): Promise<any> {
  return request("POST", "/api/roles", role);
}
export function updateRole(
  name: string,
  role: { displayName: string; permissions: Permissions; requireTotp: boolean }
): Promise<any> {
  return request("PUT", `/api/roles/${encodeURIComponent(name)}`, role);
}
export function deleteRole(name: string): Promise<any> {
  return request("DELETE", `/api/roles/${encodeURIComponent(name)}`);
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
