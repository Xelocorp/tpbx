import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiDocsUrl,
  apiV1Base,
  can,
  createApiToken,
  deleteApiToken,
  getBranding,
  getInfra,
  getSystemSettings,
  getWebRTCSettings,
  listApiTokens,
  revokeApiToken,
  saveSystemSettings,
  saveWebRTCSettings,
  type ApiToken,
  type InfraInfo,
  type Me,
  type SystemSettings,
  type WebRTCSettings,
} from "../api";
import type { Notify } from "../types";
import PJSIPPanel from "./PJSIPPanel";

const BLANK_WEBRTC: WebRTCSettings = {
  publicHost: "",
  wssPort: "8089",
  wssUrl: "",
  stunEnabled: true,
  stunUrls: "",
  turnEnabled: true,
  turnMode: "builtin",
  turnHost: "",
  turnUrls: "",
  turnStaticUser: "",
  turnStaticPassword: "",
  turnTls: true,
  iceTransportPolicy: "all",
};

const csv = (s: string) =>
  s
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

// Append :port unless the host already carries one (avoids host:19302:3478).
const hostPort = (host: string, port: string) =>
  host.includes(":") ? host : `${host}:${port}`;

type TabKey = "system" | "branding" | "webrtc" | "sip" | "api";
const TABS: { key: TabKey; label: string }[] = [
  { key: "system", label: "System" },
  { key: "branding", label: "Branding & Theme" },
  { key: "webrtc", label: "WebRTC / TURN" },
  { key: "sip", label: "SIP / PJSIP" },
  { key: "api", label: "API" },
];

export default function Settings({ notify, me }: { notify: Notify; me: Me }) {
  const canEdit = can(me, "settings", "edit");
  const [tab, setTab] = useState<TabKey>("system");

  return (
    <>
      <div className="page-head">
        <h2>Settings</h2>
      </div>

      <div className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "system" ? (
        <SystemTab notify={notify} canEdit={canEdit} />
      ) : tab === "branding" ? (
        <BrandingTab notify={notify} canEdit={canEdit} />
      ) : tab === "webrtc" ? (
        <WebRTCTab notify={notify} canEdit={canEdit} />
      ) : tab === "sip" ? (
        <PJSIPPanel notify={notify} canEdit={canEdit} />
      ) : (
        <ApiTab notify={notify} canEdit={canEdit} />
      )}
    </>
  );
}

// --- API tab: docs link, endpoint, and token management ----------------------

function ApiTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null); // plaintext shown once
  const base = apiV1Base();
  const docs = apiDocsUrl();

  const load = useCallback(() => {
    listApiTokens()
      .then(setTokens)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [notify]);
  useEffect(load, [load]);

  const copy = (text: string, label: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => notify({ kind: "ok", text: `${label} copied` }))
      .catch(() => notify({ kind: "err", text: "copy failed" }));
  };

  const create = async () => {
    setBusy(true);
    try {
      const r = await createApiToken(name.trim() || "api-token");
      setFresh(r.token);
      setName("");
      load();
      notify({ kind: "ok", text: "Token created — copy it now, it won't be shown again." });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: ApiToken) => {
    if (!confirm(`Revoke token "${t.name}"? Any integration using it stops working immediately.`)) return;
    try {
      await revokeApiToken(t.id);
      load();
      notify({ kind: "ok", text: "Token revoked" });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  const remove = async (t: ApiToken) => {
    if (!confirm(`Delete token "${t.name}" permanently?`)) return;
    try {
      await deleteApiToken(t.id);
      load();
      notify({ kind: "ok", text: "Token deleted" });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <>
      <section className="panel">
        <header>API access</header>
        <div className="form" style={{ gap: 10 }}>
          <p className="hint-inline">
            Control XeloVoice from your own systems — manage extensions, place
            calls, and pull call-center reports over a token-authenticated REST
            API. Every request must carry a token created below.
          </p>
          <div className="api-row">
            <span className="api-row-label">API endpoint</span>
            <code className="api-code">{base}</code>
            <button className="btn ghost sm" onClick={() => copy(base, "Endpoint")}>
              Copy
            </button>
          </div>
          <div className="api-row">
            <span className="api-row-label">API documentation</span>
            <a className="api-code link" href={docs} target="_blank" rel="noreferrer">
              {docs}
            </a>
            <a className="btn sm" href={docs} target="_blank" rel="noreferrer">
              Open docs
            </a>
          </div>
        </div>
      </section>

      {fresh && (
        <section className="panel">
          <header>Your new token</header>
          <div className="form" style={{ gap: 8 }}>
            <p className="hint-inline">
              Copy this now — for security it is only shown once. Store it like a
              password.
            </p>
            <div className="api-row">
              <code className="api-code fresh">{fresh}</code>
              <button className="btn sm" onClick={() => copy(fresh, "Token")}>
                Copy token
              </button>
              <button className="btn ghost sm" onClick={() => setFresh(null)}>
                Done
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="panel">
        <header>API tokens</header>
        <div className="form" style={{ gap: 10 }}>
          {canEdit && (
            <div className="api-create">
              <input
                placeholder="Token name (e.g. TawasulCX integration)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && create()}
              />
              <button className="btn" onClick={create} disabled={busy}>
                {busy ? "Creating…" : "Create token"}
              </button>
            </div>
          )}

          {tokens === null ? (
            <div className="empty">Loading…</div>
          ) : tokens.length === 0 ? (
            <div className="empty">No tokens yet. Create one to start using the API.</div>
          ) : (
            <table className="wrapup-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Token</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Status</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className={t.revoked ? "row-muted" : ""}>
                    <td>{t.name}</td>
                    <td>
                      <code>{t.prefix}…</code>
                    </td>
                    <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}</td>
                    <td>
                      {t.revoked ? (
                        <span className="pill danger">revoked</span>
                      ) : (
                        <span className="pill ok">active</span>
                      )}
                    </td>
                    {canEdit && (
                      <td className="row-actions">
                        {!t.revoked && (
                          <button className="btn ghost sm" onClick={() => revoke(t)}>
                            Revoke
                          </button>
                        )}
                        <button className="btn ghost sm danger" onClick={() => remove(t)}>
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

// --- System tab: public domain + timezone (editable) and read-only infra -----

function SystemTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const [s, setS] = useState<SystemSettings | null>(null);
  const [envDomain, setEnvDomain] = useState("");
  const [infra, setInfra] = useState<InfraInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getSystemSettings()
      .then((r) => {
        setS(r.settings);
        setEnvDomain(r.envDomain);
      })
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
    getInfra()
      .then(setInfra)
      .catch(() => setInfra(null));
  }, [notify]);
  useEffect(load, [load]);

  const set = <K extends keyof SystemSettings>(k: K, v: SystemSettings[K]) =>
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));

  const save = async () => {
    if (!s) return;
    setBusy(true);
    try {
      await saveSystemSettings(s);
      notify({ kind: "ok", text: "System settings saved. New softphone sessions use the domain immediately." });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!s) {
    return (
      <section className="panel">
        <div className="empty">Loading…</div>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <header>Public address</header>
        <div className="form">
          <p className="hint-inline">
            The domain (or IP) browsers and softphones reach this system at. It
            drives the WebRTC signalling URL and TURN/STUN hosts, so changing it
            here is all that is needed after a domain move — no env edit or
            reinstall. Blank means “derive from the address the browser used”.
          </p>
          <label>
            Public domain
            <input
              value={s.publicDomain}
              disabled={!canEdit}
              placeholder={envDomain ? `env default: ${envDomain}` : "e.g. pbx.example.com"}
              onChange={(e) => set("publicDomain", e.target.value.trim())}
            />
          </label>
          <label>
            Timezone <span className="hint-inline">(display only)</span>
            <input
              value={s.timezone}
              disabled={!canEdit}
              placeholder="UTC"
              onChange={(e) => set("timezone", e.target.value.trim())}
            />
          </label>
          <label>
            Service level target <span className="hint-inline">(seconds)</span>
            <input
              type="number"
              min={1}
              value={s.slaSeconds || 20}
              disabled={!canEdit}
              placeholder="20"
              onChange={(e) => set("slaSeconds", Math.max(1, parseInt(e.target.value, 10) || 20))}
            />
          </label>
          {canEdit && (
            <div className="form-actions">
              <button className="btn ghost" onClick={load} disabled={busy}>
                Reset
              </button>
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save system settings"}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <header>Infrastructure (read-only)</header>
        <div className="form" style={{ gap: 8 }}>
          <p className="hint-inline">
            Bootstrap and credential settings live in the service environment
            (<code>/etc/tpbx/tpbx.env</code>) and Asterisk’s own config, so they
            are shown here for reference but not editable from the console.
            Secrets are masked.
          </p>
          {infra ? (
            <>
              <InfraRow label="HTTP listen" value={infra.httpAddr} />
              <InfraRow label="Database" value={infra.databaseUrl} />
              <InfraRow label="ARI" value={`${infra.ariUrl}  (user ${infra.ariUser})`} />
              <InfraRow label="AMI" value={`${infra.amiAddr}  (user ${infra.amiUser})`} />
              <InfraRow label="WSS port" value={infra.wssPort} />
              <InfraRow label="Asterisk conf" value={infra.asteriskConf} />
              <InfraRow label="Dialplan file" value={infra.dialplanFile} />
              <InfraRow label="Transports file" value={infra.transportsFile} />
              <InfraRow label="PJSIP file" value={infra.pjsipFile} />
              <InfraRow label="Sounds dir" value={infra.soundsDir} />
            </>
          ) : (
            <div className="empty">Infrastructure details unavailable.</div>
          )}
        </div>
      </section>
    </>
  );
}

function InfraRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 12, fontFamily: "var(--mono)", fontSize: 13 }}>
      <span style={{ color: "var(--muted)", minWidth: 130 }}>{label}</span>
      <span style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>{value || "—"}</span>
    </div>
  );
}

// --- Branding tab: brand name + default theme --------------------------------

function BrandingTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const [s, setS] = useState<SystemSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getSystemSettings()
      .then((r) => setS(r.settings))
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [notify]);
  useEffect(load, [load]);

  const set = <K extends keyof SystemSettings>(k: K, v: SystemSettings[K]) =>
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));

  const save = async () => {
    if (!s) return;
    setBusy(true);
    try {
      await saveSystemSettings(s);
      // Refresh the public branding so the tab title updates immediately.
      getBranding()
        .then((b) => {
          document.title = b.brandName + " · Control Console";
        })
        .catch(() => {});
      notify({ kind: "ok", text: "Branding saved. Users see it on their next load." });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!s) {
    return (
      <section className="panel">
        <div className="empty">Loading…</div>
      </section>
    );
  }

  return (
    <section className="panel">
      <header>Branding &amp; theme</header>
      <div className="form">
        <p className="hint-inline">
          The brand name shows in the browser tab title. The default theme
          applies to users who have not picked one themselves; anyone can still
          toggle light/dark from the top bar, and their choice is remembered.
        </p>
        <label>
          Brand name
          <input
            value={s.brandName}
            disabled={!canEdit}
            placeholder="XeloVoice"
            onChange={(e) => set("brandName", e.target.value)}
          />
        </label>
        <label>
          Default theme
          <select
            value={s.defaultTheme}
            disabled={!canEdit}
            onChange={(e) => set("defaultTheme", e.target.value as SystemSettings["defaultTheme"])}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <p className="hint-inline">
          The login and console logos are theme images bundled with the app
          (light/dark variants in <code>web/src/assets</code>); swap those files
          to change the logo.
        </p>
        {canEdit && (
          <div className="form-actions">
            <button className="btn ghost" onClick={load} disabled={busy}>
              Reset
            </button>
            <button className="btn" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save branding"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// --- WebRTC tab: the signalling + STUN/TURN configuration --------------------

// Mirror the backend's derivation so the admin sees what agents will receive.
function effectiveUrls(s: WebRTCSettings, browserHost: string) {
  const host = s.publicHost || browserHost;
  const turnHost = s.turnHost || host;
  let stun: string[] = [];
  if (s.stunEnabled) {
    stun = csv(s.stunUrls);
    if (!stun.length) stun = [`stun:${hostPort(turnHost, "3478")}`];
  }
  let turn: string[] = [];
  if (s.turnEnabled && s.turnMode !== "none") {
    const explicit = csv(s.turnUrls);
    if (explicit.length) {
      turn = explicit;
    } else {
      turn = [
        `turn:${hostPort(turnHost, "3478")}?transport=udp`,
        `turn:${hostPort(turnHost, "3478")}?transport=tcp`,
      ];
      if (s.turnTls) turn.push(`turns:${hostPort(turnHost, "5349")}?transport=tcp`);
    }
  }
  const wsUrl = s.wssUrl.trim() || `wss://${host}:${s.wssPort || "8089"}/ws`;
  return { wsUrl, stun, turn };
}

function WebRTCTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const [s, setS] = useState<WebRTCSettings>(BLANK_WEBRTC);
  const [builtinReady, setBuiltinReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getWebRTCSettings()
      .then((r) => {
        setS(r.settings);
        setBuiltinReady(r.builtinReady);
      })
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [notify]);
  useEffect(load, [load]);

  const set = <K extends keyof WebRTCSettings>(k: K, v: WebRTCSettings[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await saveWebRTCSettings(s);
      notify({ kind: "ok", text: "WebRTC settings saved. New agent sessions use them immediately." });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const browserHost = useMemo(() => location.hostname, []);
  const eff = useMemo(() => effectiveUrls(s, browserHost), [s, browserHost]);
  const isStatic = s.turnMode === "static";

  if (loading) {
    return (
      <section className="panel">
        <div className="empty">Loading…</div>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <header>WebRTC · Signalling &amp; TURN</header>
        <div className="form">
          <p className="hint-inline">
            These settings tell the browser softphone where to reach signalling
            (WSS) and media (STUN/TURN). They vary per deployment — a LAN
            Proxmox VM, a public VPS, Oracle Cloud behind 1:1 NAT. Public host
            blank falls back to the System tab’s public domain. Changes apply to
            new agent sessions.
          </p>

          <div className="form-row">
            <label>
              Public host <span className="hint-inline">(blank = System public domain / auto-detect)</span>
              <input
                value={s.publicHost}
                placeholder={`auto: ${browserHost}`}
                disabled={!canEdit}
                onChange={(e) => set("publicHost", e.target.value.trim())}
              />
            </label>
            <label>
              WSS port <span className="hint-inline">(ignored if WSS URL is set)</span>
              <input value={s.wssPort} disabled={!canEdit} onChange={(e) => set("wssPort", e.target.value.trim())} />
            </label>
          </div>

          <label>
            WSS URL override{" "}
            <span className="hint-inline">
              (for a reverse proxy that terminates TLS — full wss:// URL; blank = derive from host + port)
            </span>
            <input
              value={s.wssUrl}
              placeholder="wss://pbx.eko.bz/asterisk-ws"
              disabled={!canEdit}
              onChange={(e) => set("wssUrl", e.target.value.trim())}
            />
          </label>

          <div className="form-row">
            <label>
              ICE transport policy
              <select
                value={s.iceTransportPolicy}
                disabled={!canEdit}
                onChange={(e) => set("iceTransportPolicy", e.target.value as WebRTCSettings["iceTransportPolicy"])}
              >
                <option value="all">all — direct first, TURN fallback (best quality)</option>
                <option value="relay">relay — force all media through TURN</option>
              </select>
            </label>
            <label className="checkbox" style={{ alignSelf: "end", paddingBottom: 10 }}>
              <input
                type="checkbox"
                checked={s.stunEnabled}
                disabled={!canEdit}
                onChange={(e) => set("stunEnabled", e.target.checked)}
              />
              Offer STUN
            </label>
          </div>

          <div className="form-row">
            <label>
              TURN mode
              <select
                value={s.turnMode}
                disabled={!canEdit}
                onChange={(e) => set("turnMode", e.target.value as WebRTCSettings["turnMode"])}
              >
                <option value="builtin">Built-in coturn (this server)</option>
                <option value="static">External TURN (username / password)</option>
                <option value="none">None (STUN only)</option>
              </select>
            </label>
            <label className="checkbox" style={{ alignSelf: "end", paddingBottom: 10 }}>
              <input
                type="checkbox"
                checked={s.turnEnabled}
                disabled={!canEdit}
                onChange={(e) => set("turnEnabled", e.target.checked)}
              />
              TURN enabled
            </label>
          </div>

          <label>
            STUN URLs{" "}
            <span className="hint-inline">
              (comma-separated; blank = derive stun:&lt;host&gt;:3478 from your coturn)
            </span>
            <input
              value={s.stunUrls}
              placeholder="stun:stun.l.google.com:19302"
              disabled={!canEdit}
              onChange={(e) => set("stunUrls", e.target.value)}
            />
          </label>

          {s.turnMode === "builtin" && !builtinReady && (
            <p className="hint-inline" style={{ color: "#d98a8a" }}>
              No built-in TURN secret is provisioned (TPBX_TURN_SECRET). Re-run
              install.sh on this server, or switch to External TURN.
            </p>
          )}

          <div className="form-row">
            <label>
              TURN host <span className="hint-inline">(blank = same as public host)</span>
              <input
                value={s.turnHost}
                placeholder="(same as public host)"
                disabled={!canEdit}
                onChange={(e) => set("turnHost", e.target.value.trim())}
              />
            </label>
            <label className="checkbox" style={{ alignSelf: "end", paddingBottom: 10 }}>
              <input
                type="checkbox"
                checked={s.turnTls}
                disabled={!canEdit}
                onChange={(e) => set("turnTls", e.target.checked)}
              />
              Offer TURN over TLS (turns:5349)
            </label>
          </div>

          {isStatic && (
            <>
              <label>
                TURN URLs <span className="hint-inline">(comma-separated; blank = derive from TURN host)</span>
                <input
                  value={s.turnUrls}
                  placeholder="turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349"
                  disabled={!canEdit}
                  onChange={(e) => set("turnUrls", e.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  TURN username
                  <input value={s.turnStaticUser} disabled={!canEdit} onChange={(e) => set("turnStaticUser", e.target.value)} />
                </label>
                <label>
                  TURN password
                  <input
                    type="text"
                    value={s.turnStaticPassword}
                    disabled={!canEdit}
                    onChange={(e) => set("turnStaticPassword", e.target.value)}
                  />
                </label>
              </div>
            </>
          )}

          <div className="form-actions">
            <button className="btn ghost" onClick={load} disabled={busy}>
              Reset
            </button>
            {canEdit && (
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save settings"}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <header>Effective configuration (preview)</header>
        <div className="form" style={{ gap: 8 }}>
          <PreviewRow label="Signalling" value={eff.wsUrl} />
          <PreviewRow label="STUN" value={eff.stun.join("  ") || "—"} />
          <PreviewRow
            label="TURN"
            value={
              s.turnEnabled && s.turnMode !== "none"
                ? `${eff.turn.join("  ")}  (${s.turnMode})`
                : "disabled"
            }
          />
          <p className="hint-inline">
            Agents load these when they open the softphone. Built-in TURN sends
            short-lived credentials minted from the coturn secret; the secret
            itself never leaves the server. When Public host is blank the System
            public domain is used.
          </p>
        </div>
      </section>

      <section className="panel">
        <header>Softphone browser extension</header>
        <div className="form" style={{ gap: 12 }}>
          <p className="hint-inline">
            A background softphone for Chrome and Firefox — it stays registered
            and rings (with a desktop notification) even when no window is open.
            Agents install it once and sign in with this server's URL + their
            extension.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <a className="btn" href="/downloads/tpbx-softphone-chrome.zip" download>
              Download for Chrome
            </a>
            <a className="btn ghost" href="/downloads/tpbx-softphone-firefox.zip" download>
              Download for Firefox
            </a>
          </div>
          <p className="hint-inline">
            <strong>Chrome:</strong> unzip → <code>chrome://extensions</code> → enable
            Developer mode → <em>Load unpacked</em> → pick the folder.
            <br />
            <strong>Firefox:</strong> unzip → <code>about:debugging</code> → This
            Firefox → <em>Load Temporary Add-on</em> → pick <code>manifest.json</code>.
          </p>
        </div>
      </section>
    </>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 12, fontFamily: "var(--mono)", fontSize: 13 }}>
      <span style={{ color: "var(--muted)", minWidth: 90 }}>{label}</span>
      <span style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
