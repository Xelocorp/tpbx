import { useCallback, useEffect, useState } from "react";
import {
  createTransport,
  deleteTransport,
  getTransport,
  listTransports,
  restartAsterisk,
  updateTransport,
  type Transport,
} from "../api";
import type { Notify } from "../types";

const PROTOCOLS: Transport["protocol"][] = ["udp", "tcp", "tls", "wss"];
const TLS_METHODS = ["tlsv1_2", "tlsv1_3", "tlsv1_1", "sslv23"];

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

export default function Transports({ notify }: { notify: Notify }) {
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
        <button className="btn" onClick={openNew}>
          + New Transport
        </button>
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
                    <button className="btn small" onClick={() => openEdit(t.name)}>
                      Edit
                    </button>
                    <button className="btn danger" onClick={() => onDelete(t.name)}>
                      Delete
                    </button>
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
