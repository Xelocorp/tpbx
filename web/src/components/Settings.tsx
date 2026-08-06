import { useCallback, useEffect, useMemo, useState } from "react";
import { getWebRTCSettings, saveWebRTCSettings, type WebRTCSettings } from "../api";
import type { Notify } from "../types";

const BLANK: WebRTCSettings = {
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

export default function Settings({ notify }: { notify: Notify }) {
  const [s, setS] = useState<WebRTCSettings>(BLANK);
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
      <>
        <div className="page-head">
          <h2>Settings</h2>
        </div>
        <section className="panel">
          <div className="empty">Loading…</div>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h2>Settings</h2>
      </div>

      <section className="panel">
        <header>WebRTC · Signalling & TURN</header>
        <div className="form">
          <p className="hint-inline">
            These settings tell the browser softphone where to reach signalling
            (WSS) and media (STUN/TURN). They vary per deployment — a LAN
            Proxmox VM, a public VPS, Oracle Cloud behind 1:1 NAT — so they live
            here, not in the installer. Changes apply to new agent sessions.
          </p>

          <div className="form-row">
            <label>
              Public host <span className="hint-inline">(FQDN/IP agents reach; blank = auto-detect)</span>
              <input
                value={s.publicHost}
                placeholder={`auto: ${browserHost}`}
                onChange={(e) => set("publicHost", e.target.value.trim())}
              />
            </label>
            <label>
              WSS port <span className="hint-inline">(ignored if WSS URL is set)</span>
              <input value={s.wssPort} onChange={(e) => set("wssPort", e.target.value.trim())} />
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
              onChange={(e) => set("wssUrl", e.target.value.trim())}
            />
          </label>

          <div className="form-row">
            <label>
              ICE transport policy
              <select
                value={s.iceTransportPolicy}
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
                onChange={(e) => set("turnHost", e.target.value.trim())}
              />
            </label>
            <label className="checkbox" style={{ alignSelf: "end", paddingBottom: 10 }}>
              <input
                type="checkbox"
                checked={s.turnTls}
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
                  onChange={(e) => set("turnUrls", e.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  TURN username
                  <input
                    value={s.turnStaticUser}
                    onChange={(e) => set("turnStaticUser", e.target.value)}
                  />
                </label>
                <label>
                  TURN password
                  <input
                    type="text"
                    value={s.turnStaticPassword}
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
            <button className="btn" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save settings"}
            </button>
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
            itself never leaves the server.
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
