import { useCallback, useEffect, useState } from "react";
import {
  createIVR,
  deleteIVR,
  getIVR,
  listIVRs,
  updateIVR,
  type IVR,
  type IVROption,
} from "../api";
import type { Notify } from "../types";

const DEST_TYPES = ["extension", "ivr", "hangup"] as const;

const BLANK: IVR = {
  id: 0,
  name: "",
  greeting: "",
  timeoutSec: 5,
  maxRetries: 3,
  invalidDest: "",
  timeoutDest: "",
  options: [{ digit: "1", destType: "extension", destValue: "", label: "" }],
};

export default function IVRPage({ notify }: { notify: Notify }) {
  const [rows, setRows] = useState<IVR[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<IVR | null>(null);
  const [isNew, setIsNew] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    listIVRs()
      .then(setRows)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(refresh, [refresh]);

  const openNew = () => {
    setIsNew(true);
    setEditing({ ...BLANK, options: [{ digit: "1", destType: "extension", destValue: "", label: "" }] });
  };
  const openEdit = async (id: number) => {
    try {
      setIsNew(false);
      setEditing(await getIVR(id));
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };
  const onDelete = async (v: IVR) => {
    if (!confirm(`Delete IVR "${v.name}"?`)) return;
    try {
      await deleteIVR(v.id);
      notify({ kind: "ok", text: `Deleted ${v.name}` });
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>IVR / Auto-Attendant</h2>
        <button className="btn" onClick={openNew}>
          + New IVR
        </button>
      </div>

      <section className="panel">
        <header>Menus</header>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            No IVR menus yet. Create one, then point an inbound route at it
            (destination <code>ivr:&lt;name&gt;</code>).
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Greeting</th>
                <th>Keys</th>
                <th>Timeout</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}</td>
                  <td>{v.greeting || "—"}</td>
                  <td>{v.options.map((o) => o.digit).join(" ") || "—"}</td>
                  <td>{v.timeoutSec}s ×{v.maxRetries}</td>
                  <td className="row-action">
                    <button className="btn small" onClick={() => openEdit(v.id)}>
                      Edit
                    </button>
                    <button className="btn danger" onClick={() => onDelete(v)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint-inline" style={{ padding: "0 16px 16px" }}>
          Route a DID to a menu on the <strong>Routing</strong> page by setting
          the inbound destination to <code>ivr:&lt;name&gt;</code>. The greeting
          is an Asterisk sound file (e.g. <code>custom/welcome</code>) placed in
          the server's sounds directory.
        </p>
      </section>

      {editing && (
        <IVRForm
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

function IVRForm({
  initial,
  isNew,
  onClose,
  onSaved,
  onError,
}: {
  initial: IVR;
  isNew: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [f, setF] = useState<IVR>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof IVR>(k: K, v: IVR[K]) => setF((p) => ({ ...p, [k]: v }));

  const setOpt = (i: number, patch: Partial<IVROption>) =>
    setF((p) => ({ ...p, options: p.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const addOpt = () =>
    setF((p) => ({
      ...p,
      options: [...p.options, { digit: "", destType: "extension", destValue: "", label: "" }],
    }));
  const rmOpt = (i: number) => setF((p) => ({ ...p, options: p.options.filter((_, j) => j !== i) }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isNew) {
        await createIVR(f);
        onSaved(`Created IVR ${f.name}`);
      } else {
        await updateIVR(f.id, f);
        onSaved(`Updated IVR ${f.name}`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <header>{isNew ? "New IVR" : `Edit ${f.name}`}</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Name <span className="hint-inline">(context id)</span>
              <input value={f.name} disabled={!isNew} placeholder="main" onChange={(e) => set("name", e.target.value)} />
            </label>
            <label>
              Greeting sound
              <input
                value={f.greeting}
                placeholder="custom/welcome"
                onChange={(e) => set("greeting", e.target.value)}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              Wait for input (seconds)
              <input
                type="number"
                value={f.timeoutSec}
                onChange={(e) => set("timeoutSec", parseInt(e.target.value || "5", 10))}
              />
            </label>
            <label>
              Retries before giving up
              <input
                type="number"
                value={f.maxRetries}
                onChange={(e) => set("maxRetries", parseInt(e.target.value || "3", 10))}
              />
            </label>
          </div>

          <div className="ivr-opts">
            <div className="ivr-opts-head">
              <span>Key</span>
              <span>Action</span>
              <span>Target</span>
              <span>Label</span>
              <span></span>
            </div>
            {f.options.map((o, i) => (
              <div className="ivr-opt-row" key={i}>
                <input
                  className="k"
                  value={o.digit}
                  maxLength={1}
                  placeholder="1"
                  onChange={(e) => setOpt(i, { digit: e.target.value.replace(/[^0-9*#]/g, "") })}
                />
                <select
                  value={o.destType}
                  onChange={(e) => setOpt(i, { destType: e.target.value as IVROption["destType"] })}
                >
                  {DEST_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  value={o.destValue}
                  disabled={o.destType === "hangup"}
                  placeholder={o.destType === "ivr" ? "ivr name" : o.destType === "extension" ? "1001" : ""}
                  onChange={(e) => setOpt(i, { destValue: e.target.value })}
                />
                <input value={o.label} placeholder="Sales" onChange={(e) => setOpt(i, { label: e.target.value })} />
                <button type="button" className="btn small danger" onClick={() => rmOpt(i)}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost small" onClick={addOpt}>
              + Add key
            </button>
          </div>

          <div className="form-row">
            <DestPicker label="On invalid key" value={f.invalidDest} onChange={(v) => set("invalidDest", v)} />
            <DestPicker label="On timeout" value={f.timeoutDest} onChange={(v) => set("timeoutDest", v)} />
          </div>
          <p className="hint-inline">
            Invalid/timeout: the greeting replays up to the retry count, then
            goes to the fallback (or hangs up if none).
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

// DestPicker edits a "type:value" destination string used by fallbacks.
function DestPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [type, val] = value.includes(":") ? value.split(/:(.*)/s) : [value || "", ""];
  const set = (t: string, v: string) => {
    if (t === "" || t === "hangup") onChange(t === "hangup" ? "hangup" : "");
    else onChange(`${t}:${v}`);
  };
  return (
    <label>
      {label}
      <div style={{ display: "flex", gap: 8 }}>
        <select value={type} onChange={(e) => set(e.target.value, val)} style={{ flex: "0 0 130px" }}>
          <option value="">Replay / hang up</option>
          <option value="extension">Extension</option>
          <option value="ivr">IVR</option>
          <option value="hangup">Hang up</option>
        </select>
        {(type === "extension" || type === "ivr") && (
          <input
            value={val}
            placeholder={type === "ivr" ? "menu name" : "1001"}
            onChange={(e) => set(type, e.target.value)}
          />
        )}
      </div>
    </label>
  );
}
