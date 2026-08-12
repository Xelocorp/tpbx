import { useCallback, useEffect, useState } from "react";
import {
  createTransport,
  deleteTransport,
  getPJSIPSettings,
  getTransport,
  listTransports,
  restartAsterisk,
  savePJSIPSettings,
  updateTransport,
  can,
  type PJSIPSettings,
  type Transport,
  type Me,
} from "../api";
import type { Notify } from "../types";

const PROTOCOLS: Transport["protocol"][] = ["udp", "tcp", "tls", "wss"];
const TLS_METHODS = ["tlsv1_2", "tlsv1_3", "tlsv1_1", "sslv23"];
const OVERLOAD_TRIGGERS: PJSIPSettings["taskprocessorOverloadTrigger"][] = ["global", "pjsip_only", "none"];
const IDENTIFIER_TOKENS = ["ip", "username", "anonymous", "header", "auth_username"];

const BLANK: Transport = {
  name: "",
  protocol: "udp",
  bindAddr: "0.0.0.0",
  bindPort: 5060,
  tlsCertFile: "",
  tlsPrivKeyFile: "",
  tlsCaListFile: "",
  tlsMethod: "tlsv1_2",
  externalMediaAddress: "",
  externalSignalingAddress: "",
  localNet: "",
  enabled: true,
  position: 0,
};

export default function Transports({ notify, me }: { notify: Notify; me: Me }) {
  const canCreate = can(me, "transports", "create");
  const canEdit = can(me, "transports", "edit");
  const canDelete = can(me, "transports", "delete");
  const [rows, setRows] = useState<Transport[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Transport | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false); // a change needs a restart to apply
  const [restarting, setRestarting] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    listTransports()
      .then(setRows)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(refresh, [refresh]);

  const openNew = () => {
    setIsNew(true);
    setEditing({ ...BLANK });
  };

  const openEdit = async (name: string) => {
    try {
      const t = await getTransport(name);
      setIsNew(false);
      setEditing(t);
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  const onDelete = async (name: string) => {
    if (!confirm(`Delete transport ${name}?`)) return;
    try {
      await deleteTransport(name);
      notify({ kind: "ok", text: `Deleted ${name}` });
      setDirty(true);
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  const onRestart = async () => {
    if (
      !confirm(
        "Restart the phone system now to apply transport changes?\n\n" +
          "This briefly drops SIP service and disconnects any active calls. " +
          "The console will reconnect automatically."
      )
    )
      return;
    setRestarting(true);
    try {
      await restartAsterisk();
      notify({ kind: "ok", text: "The phone system is restarting — reconnecting shortly." });
      setDirty(false);
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setRestarting(false);
    }
  };

  const bindOf = (t: Transport) =>
    t.protocol === "wss" ? "via HTTP(S)" : `${t.bindAddr}:${t.bindPort}`;

  return (
    <>
      <div className="page-head">
        <h2>Transports / TLS</h2>
        {canCreate && (
          <button className="btn" onClick={openNew}>
            + New Transport
          </button>
        )}
      </div>

      {dirty && (
        <section className="panel restart-banner">
          <div>
            <strong>Restart required.</strong> Transport changes are written to
            config, but bind/TLS changes only take effect after a full service
            restart.
          </div>
          <button className="btn" onClick={onRestart} disabled={restarting}>
            {restarting ? "Restarting…" : "Restart Service"}
          </button>
        </section>
      )}

      <section className="panel">
        <header>PJSIP Transports</header>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            No transports defined. SIP will not bind until at least one exists.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Protocol</th>
                <th>Bind</th>
                <th>TLS cert</th>
                <th>External addr</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>
                    <span className="badge">{t.protocol}</span>
                  </td>
                  <td>{bindOf(t)}</td>
                  <td>{t.protocol === "tls" ? t.tlsCertFile || "-" : "-"}</td>
                  <td>{t.externalSignalingAddress || t.externalMediaAddress || "-"}</td>
                  <td>
                    <span className={`badge ${t.enabled ? "" : "offline"}`}>
                      {t.enabled ? "yes" : "no"}
                    </span>
                  </td>
                  <td className="row-action">
                    {canEdit && (
                      <button className="btn small" onClick={() => openEdit(t.name)}>
                        Edit
                      </button>
                    )}
                    {canDelete && (
                      <button className="btn danger" onClick={() => onDelete(t.name)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint-inline" style={{ padding: "0 16px 16px" }}>
          A <code>wss</code> transport rides on the built-in HTTP(S) listener and
          must not bind a port. WebRTC endpoints additionally need{" "}
          <code>webrtc = yes</code> (set on the extension).
        </p>
      </section>

      <PJSIPPanel notify={notify} canEdit={canEdit} onSaved={() => setDirty(true)} />

      {editing && (
        <TransportForm
          initial={editing}
          isNew={isNew}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            notify({ kind: "ok", text: msg });
            setEditing(null);
            setDirty(true);
            refresh();
          }}
          onError={(msg) => notify({ kind: "err", text: msg })}
        />
      )}
    </>
  );
}

// YesNo is the two-button segmented toggle used across the PJSIP settings panel,
// mirroring the reference UI.
function YesNo({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="yesno">
      <button
        type="button"
        className={`yesno-btn ${value ? "on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(true)}
      >
        Yes
      </button>
      <button
        type="button"
        className={`yesno-btn ${!value ? "on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(false)}
      >
        No
      </button>
    </div>
  );
}

// PJSIPPanel edits the res_pjsip [global] options and TLS defaults (the "Misc
// PJSip Settings" and "TLS/SSL/SRTP Settings" panels from the reference UI).
function PJSIPPanel({
  notify,
  canEdit,
  onSaved,
}: {
  notify: Notify;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [s, setS] = useState<PJSIPSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getPJSIPSettings()
      .then(setS)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }));
  }, [notify]);
  useEffect(load, [load]);

  if (!s) {
    return (
      <section className="panel">
        <header>PJSIP &amp; TLS Settings</header>
        <div className="empty">Loading…</div>
      </section>
    );
  }

  const set = <K extends keyof PJSIPSettings>(k: K, v: PJSIPSettings[K]) =>
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));

  const identTokens = s.endpointIdentifierOrder
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const toggleIdent = (tok: string) => {
    const has = identTokens.includes(tok);
    const next = has ? identTokens.filter((t) => t !== tok) : [...identTokens, tok];
    set("endpointIdentifierOrder", next.join(","));
  };

  const save = async () => {
    setBusy(true);
    try {
      await savePJSIPSettings(s);
      notify({ kind: "ok", text: "PJSIP settings saved. A restart fully applies global/TLS changes." });
      onSaved();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="panel">
        <header>Misc PJSip Settings</header>
        <div className="form">
          <div className="settings-row">
            <span>Allow Transports Reload</span>
            <YesNo value={s.allowTransportsReload} disabled={!canEdit} onChange={(v) => set("allowTransportsReload", v)} />
          </div>
          <div className="settings-row">
            <span>Enable Debug</span>
            <YesNo value={s.enableDebug} disabled={!canEdit} onChange={(v) => set("enableDebug", v)} />
          </div>
          <div className="settings-row">
            <span>Keep Alive Interval</span>
            <input
              type="number"
              min={0}
              max={3600}
              disabled={!canEdit}
              value={s.keepAliveInterval}
              onChange={(e) => set("keepAliveInterval", Number(e.target.value))}
              style={{ maxWidth: 120 }}
            />
          </div>
          <div className="settings-row">
            <span>Caller ID into Contact Header</span>
            <YesNo value={s.contactCallerId} disabled={!canEdit} onChange={(v) => set("contactCallerId", v)} />
          </div>
          <div className="settings-row">
            <span>Taskprocessor Overload Trigger</span>
            <div className="seg">
              {OVERLOAD_TRIGGERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`seg-btn ${s.taskprocessorOverloadTrigger === t ? "on" : ""}`}
                  disabled={!canEdit}
                  onClick={() => set("taskprocessorOverloadTrigger", t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span>Endpoint Identifier Order</span>
            <div className="seg">
              {IDENTIFIER_TOKENS.map((tok) => (
                <button
                  key={tok}
                  type="button"
                  className={`seg-btn ${identTokens.includes(tok) ? "on" : ""}`}
                  disabled={!canEdit}
                  onClick={() => toggleIdent(tok)}
                  title="Click to toggle; order follows click order"
                >
                  {tok}
                </button>
              ))}
            </div>
          </div>
          <p className="hint-inline">
            Identifier order (left to right): <code>{s.endpointIdentifierOrder || "—"}</code>
          </p>
        </div>
      </section>

      <section className="panel">
        <header>TLS/SSL/SRTP Settings</header>
        <div className="form">
          <div className="settings-row">
            <span>Certificate Manager</span>
            <input
              disabled={!canEdit}
              placeholder="certificate label (e.g. wildcard)"
              value={s.certName}
              onChange={(e) => set("certName", e.target.value)}
            />
          </div>
          <div className="settings-row">
            <span>SSL Method</span>
            <select disabled={!canEdit} value={s.tlsMethod} onChange={(e) => set("tlsMethod", e.target.value)}>
              {TLS_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <span>Verify Client</span>
            <YesNo value={s.verifyClient} disabled={!canEdit} onChange={(v) => set("verifyClient", v)} />
          </div>
          <div className="settings-row">
            <span>Verify Server</span>
            <YesNo value={s.verifyServer} disabled={!canEdit} onChange={(v) => set("verifyServer", v)} />
          </div>
          {canEdit && (
            <div className="form-actions">
              <button className="btn" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save PJSIP settings"}
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function TransportForm({
  initial,
  isNew,
  onClose,
  onSaved,
  onError,
}: {
  initial: Transport;
  isNew: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [f, setF] = useState<Transport>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Transport>(k: K, v: Transport[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isNew) {
        await createTransport(f);
        onSaved(`Created transport ${f.name}`);
      } else {
        await updateTransport(f.name, f);
        onSaved(`Updated transport ${f.name}`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isWss = f.protocol === "wss";
  const isTls = f.protocol === "tls";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>{isNew ? "New Transport" : `Edit ${f.name}`}</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Name
              <input
                value={f.name}
                disabled={!isNew}
                placeholder="transport-udp"
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
            <label>
              Protocol
              <select
                value={f.protocol}
                onChange={(e) => set("protocol", e.target.value as Transport["protocol"])}
              >
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!isWss && (
            <div className="form-row">
              <label>
                Bind address
                <input value={f.bindAddr} onChange={(e) => set("bindAddr", e.target.value)} />
              </label>
              <label>
                Bind port
                <input
                  type="number"
                  value={f.bindPort}
                  onChange={(e) => set("bindPort", parseInt(e.target.value || "0", 10))}
                />
              </label>
            </div>
          )}

          {isTls && (
            <>
              <div className="form-row">
                <label>
                  Certificate file
                  <input
                    value={f.tlsCertFile}
                    placeholder="/path/to/server.crt"
                    onChange={(e) => set("tlsCertFile", e.target.value)}
                  />
                </label>
                <label>
                  Private key file
                  <input
                    value={f.tlsPrivKeyFile}
                    placeholder="/path/to/server.key"
                    onChange={(e) => set("tlsPrivKeyFile", e.target.value)}
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  CA list file <span className="hint-inline">(mutual TLS, optional)</span>
                  <input
                    value={f.tlsCaListFile}
                    onChange={(e) => set("tlsCaListFile", e.target.value)}
                  />
                </label>
                <label>
                  TLS method
                  <select value={f.tlsMethod} onChange={(e) => set("tlsMethod", e.target.value)}>
                    {TLS_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}

          <div className="form-row">
            <label>
              External signaling address <span className="hint-inline">(NAT, optional)</span>
              <input
                value={f.externalSignalingAddress}
                placeholder="pbx.example.com"
                onChange={(e) => set("externalSignalingAddress", e.target.value)}
              />
            </label>
            <label>
              External media address <span className="hint-inline">(NAT, optional)</span>
              <input
                value={f.externalMediaAddress}
                placeholder="pbx.example.com"
                onChange={(e) => set("externalMediaAddress", e.target.value)}
              />
            </label>
          </div>

          <label>
            Local networks <span className="hint-inline">(comma-separated CIDRs, optional)</span>
            <input
              value={f.localNet}
              placeholder="10.0.0.0/8, 192.168.0.0/16"
              onChange={(e) => set("localNet", e.target.value)}
            />
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            Enabled
          </label>

          <p className="hint-inline">
            Bind and TLS changes require a service restart, which you can
            trigger from the banner after saving.
          </p>

          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Saving…" : isNew ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
