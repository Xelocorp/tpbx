// Agent softphone API client. All requests are same-origin and rely on the
// tpbx_agent session cookie set by the backend at login.

export interface AgentConfig {
  extension: string;
  displayName: string;
  password: string;
  domain: string;
  wsUrl: string;
  iceServers: RTCIceServer[];
}

export interface AgentIdentity {
  extension: string;
  displayName: string;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function agentLogin(extension: string, password: string): Promise<AgentIdentity> {
  const r = await post("/api/agent/login", { extension, password });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `login failed (${r.status})` }));
    throw new Error(msg.error ?? "login failed");
  }
  return r.json();
}

export async function agentLogout(): Promise<void> {
  await post("/api/agent/logout");
}

export async function agentConfig(): Promise<AgentConfig> {
  const r = await fetch("/api/agent/config");
  if (!r.ok) throw new Error(`config ${r.status}`);
  return r.json();
}
