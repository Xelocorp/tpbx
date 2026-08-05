import { useCallback, useEffect, useState } from "react";
import {
  createTrunk,
  deleteTrunk,
  getTrunk,
  listTrunks,
  updateTrunk,
  type Trunk,
} from "../api";
import type { Notify } from "../types";

const TRANSPORTS = ["transport-udp", "transport-tcp", "transport-tls"];

const BLANK: Trunk = {
  name: "",
  mode: "register",
  host: "",
  port: 5060,
  username: "",
  password: "",
  fromUser: "",
  fromDomain: "",
  context: "from-trunk",
  transport: "transport-udp",
  codecs: "ulaw,alaw",
};

export default function Trunks({ notify }: { notify: Notify }) {
  const [rows, setRows] = useState<Trunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Trunk | null>(null);
  const [isNew, setIsNew] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    listTrunks()
      .then(setRows)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(refresh, [refresh]);

  // Poll live status every 10s without flashing the loading state. Skip the
  // poll while a trunk is being edited so a background update can't stomp
  // the form's underlying row.
  useEffect(() => {
    const t = setInterval(() => {
      if (editing) return;
      listTrunks()
        .then(setRows)
        .catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [editing]);

  const openNew = () => {
    setIsNew(true);
    setEditing({ ...BLANK });
  };

  const openEdit = async (name: string) => {
    try {
      const t = await getTrunk(name);
      setIsNew(false);
      setEditing({ ...t, password: "" });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  const onDelete = async (name: string) => {
    if (!confirm(`Delete trunk ${name}?`)) return;
    try {
      await deleteTrunk(name);
      notify({ kind: "ok", text: `Deleted ${name}` });
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Trunks</h2>
        <button className="btn" onClick={openNew}>
          + New Trunk
        </button>
      </div>

      <section className="panel">
        <header>SIP Provider Trunks</header>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            No trunks yet. Add one to connect to a SIP provider and reach the PSTN.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Mode</th>
                <th>Host</th>
                <th>Port</th>
                <th>Username</th>
                <th>Codecs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>
                    <span
                      className={`badge ${t.state === "online" ? "" : "offline"}`}
                    >
                      {t.state ?? "unknown"}
                    </span>
                  </td>
                  <td>
                    <span className="badge">{t.mode}</span>
                  </td>
                  <td>{t.host}</td>
                  <td>{t.port}</td>
                  <td>{t.username || "-"}</td>
                  <td>{t.codecs}</td>
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
      </section>

      {editing && (
        <TrunkForm
          initial={editing}
          isNew={isNew}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            notify({ kind: "ok", text: msg });
            setEditing(null);
            refresh();
          }}
          onError={(msg) => notify({ kind: "err", text: msg })}
        />
      )}
    </>
  );
}

function TrunkForm({
  initial,
  isNew,
  onClose,
  onSaved,
  onError,
}: {
  initial: Trunk;
  isNew: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [f, setF] = useState<Trunk>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Trunk>(k: K, v: Trunk[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isNew) {
        await createTrunk(f);
        onSaved(`Created trunk ${f.name}`);
      } else {
        await updateTrunk(f.name, f);
        onSaved(`Updated trunk ${f.name}`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const register = f.mode === "register";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>{isNew ? "New Trunk" : `Edit Trunk ${f.name}`}</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Name
              <input
                value={f.name}
                disabled={!isNew}
                placeholder="myprovider"
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
            <label>
              Mode
              <select
                value={f.mode}
                onChange={(e) => set("mode", e.target.value as Trunk["mode"])}
              >
                <option value="register">register (username / password)</option>
                <option value="ip">ip (trusted peer, no auth)</option>
              </select>
            </label>
          </div>

          <div className="form-row">
            <label>
              Provider host / IP
              <input
                placeholder="sip.provider.com"
                value={f.host}
                onChange={(e) => set("host", e.target.value)}
              />
            </label>
            <label>
              Port
              <input
                type="number"
                value={f.port}
                onChange={(e) => set("port", parseInt(e.target.value || "5060", 10))}
              />
            </label>
          </div>

          {register && (
            <div className="form-row">
              <label>
                Username
                <input value={f.username} onChange={(e) => set("username", e.target.value)} />
              </label>
              <label>
                Password {!isNew && <span className="hint-inline">(blank = keep)</span>}
                <input
                  type="text"
                  value={f.password ?? ""}
                  placeholder={isNew ? "provider secret" : "unchanged"}
                  onChange={(e) => set("password", e.target.value)}
                />
              </label>
            </div>
          )}

          <div className="form-row">
            <label>
              From user <span className="hint-inline">(outbound caller ID)</span>
              <input
                placeholder="(defaults to username)"
                value={f.fromUser}
                onChange={(e) => set("fromUser", e.target.value)}
              />
            </label>
            <label>
              From domain
              <input
                placeholder="(defaults to host)"
                value={f.fromDomain}
                onChange={(e) => set("fromDomain", e.target.value)}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              Transport
              <select value={f.transport} onChange={(e) => set("transport", e.target.value)}>
                {TRANSPORTS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Codecs
              <input value={f.codecs} onChange={(e) => set("codecs", e.target.value)} />
            </label>
          </div>

          <label>
            Inbound context
            <input value={f.context} onChange={(e) => set("context", e.target.value)} />
          </label>

          <p className="hint-inline">
            A register trunk authenticates and registers to the provider. Once
            saved, check its status with <code>pjsip show registrations</code>.
            Outbound/inbound call routing is configured on the Routing page.
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
