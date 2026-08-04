import { useCallback, useEffect, useState } from "react";
import {
  createExtension,
  deleteExtension,
  getExtension,
  listExtensions,
  updateExtension,
  type Extension,
} from "../api";
import type { Notify } from "../types";

const TRANSPORTS = ["transport-udp", "transport-tcp", "transport-tls", "transport-wss"];
const DTMF_MODES = ["rfc4733", "inband", "info", "auto"];

const BLANK: Extension = {
  id: "",
  password: "",
  context: "from-internal",
  transport: "transport-udp",
  codecs: "ulaw,alaw",
  callerId: "",
  maxContacts: 1,
  webrtc: false,
  dtmfMode: "rfc4733",
};

export default function Extensions({ notify }: { notify: Notify }) {
  const [rows, setRows] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Extension | null>(null); // form open when non-null
  const [isNew, setIsNew] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    listExtensions()
      .then(setRows)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(refresh, [refresh]);

  const openNew = () => {
    setIsNew(true);
    setEditing({ ...BLANK });
  };

  const openEdit = async (id: string) => {
    try {
      const ext = await getExtension(id);
      // Do not prefill the password field; blank means "keep unchanged".
      setIsNew(false);
      setEditing({ ...ext, password: "" });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm(`Delete extension ${id}? This removes its SIP account.`)) return;
    try {
      await deleteExtension(id);
      notify({ kind: "ok", text: `Deleted ${id}` });
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Extensions</h2>
        <button className="btn" onClick={openNew}>
          + New Extension
        </button>
      </div>

      <section className="panel">
        <header>SIP Accounts</header>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">No extensions yet. Create one to get started.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Extension</th>
                <th>Context</th>
                <th>Transport</th>
                <th>Codecs</th>
                <th>Caller ID</th>
                <th>WebRTC</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td>{e.context}</td>
                  <td>{e.transport}</td>
                  <td>{e.codecs}</td>
                  <td>{e.callerId || "-"}</td>
                  <td>{e.webrtc ? <span className="badge">yes</span> : "-"}</td>
                  <td className="row-action">
                    <button className="btn small" onClick={() => openEdit(e.id)}>
                      Edit
                    </button>
                    <button className="btn danger" onClick={() => onDelete(e.id)}>
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
        <ExtForm
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

function ExtForm({
  initial,
  isNew,
  onClose,
  onSaved,
  onError,
}: {
  initial: Extension;
  isNew: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [f, setF] = useState<Extension>(initial);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Extension>(k: K, v: Extension[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isNew) {
        await createExtension(f);
        onSaved(`Created extension ${f.id}`);
      } else {
        await updateExtension(f.id, f);
        onSaved(`Updated extension ${f.id}`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>{isNew ? "New Extension" : `Edit Extension ${f.id}`}</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Extension number
              <input
                value={f.id}
                disabled={!isNew}
                placeholder="1001"
                onChange={(e) => set("id", e.target.value)}
              />
            </label>
            <label>
              Password {!isNew && <span className="hint-inline">(blank = keep)</span>}
              <input
                type="text"
                value={f.password ?? ""}
                placeholder={isNew ? "SIP secret" : "unchanged"}
                onChange={(e) => set("password", e.target.value)}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              Context
              <input value={f.context} onChange={(e) => set("context", e.target.value)} />
            </label>
            <label>
              Caller ID
              <input
                placeholder="Name <1001>"
                value={f.callerId}
                onChange={(e) => set("callerId", e.target.value)}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              Transport
              <select
                value={f.transport}
                disabled={f.webrtc}
                onChange={(e) => set("transport", e.target.value)}
              >
                {TRANSPORTS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              DTMF mode
              <select value={f.dtmfMode} onChange={(e) => set("dtmfMode", e.target.value)}>
                {DTMF_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-row">
            <label>
              Codecs (allow)
              <input value={f.codecs} onChange={(e) => set("codecs", e.target.value)} />
            </label>
            <label>
              Max contacts
              <input
                type="number"
                min={1}
                value={f.maxContacts}
                onChange={(e) => set("maxContacts", parseInt(e.target.value || "1", 10))}
              />
            </label>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={f.webrtc}
              onChange={(e) => set("webrtc", e.target.checked)}
            />
            WebRTC (forces the WSS transport, enables ICE/DTLS/AVPF)
          </label>

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
