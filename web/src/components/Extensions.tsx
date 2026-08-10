import { useCallback, useEffect, useRef, useState } from "react";
import {
  bulkCreateExtensions,
  createExtension,
  deleteExtension,
  getExtension,
  getExtensionStatus,
  listExtensions,
  resetExtensionPassword,
  updateExtension,
  type Extension,
  type ExtStatus,
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
  const [status, setStatus] = useState<Record<string, ExtStatus>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Extension | null>(null); // form open when non-null
  const [isNew, setIsNew] = useState(false);
  const [detail, setDetail] = useState<string | null>(null); // extension id whose detail is open
  const [bulk, setBulk] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    listExtensions()
      .then(setRows)
      .catch((e) => notify({ kind: "err", text: (e as Error).message }))
      .finally(() => setLoading(false));
  }, [notify]);

  const pollStatus = useCallback(() => {
    getExtensionStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    pollStatus();
    const t = setInterval(pollStatus, 5000);
    return () => clearInterval(t);
  }, [pollStatus]);

  const openNew = () => {
    setIsNew(true);
    setEditing({ ...BLANK });
  };

  const openEdit = async (id: string) => {
    try {
      const ext = await getExtension(id);
      // Do not prefill the password field; blank means "keep unchanged".
      setIsNew(false);
      setDetail(null);
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
        <div className="row-action">
          <button className="btn ghost" onClick={() => setBulk(true)}>
            Bulk Upload
          </button>
          <button className="btn" onClick={openNew}>
            + New Extension
          </button>
        </div>
      </div>

      <section className="panel">
        <header>SIP Accounts</header>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">No extensions yet. Create one to get started.</div>
        ) : (
          <table className="ext-table">
            <thead>
              <tr>
                <th>Device</th>
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
              {rows.map((e) => {
                const st = status[e.id];
                return (
                  <tr key={e.id} className="ext-row" onClick={() => setDetail(e.id)}>
                    <td>
                      <DeviceCell st={st} webrtc={e.webrtc} />
                    </td>
                    <td>
                      <strong>{e.id}</strong>
                    </td>
                    <td>{e.context}</td>
                    <td>{e.transport || (e.webrtc ? "wss (auto)" : "-")}</td>
                    <td>{e.codecs}</td>
                    <td>{e.callerId || "-"}</td>
                    <td>{e.webrtc ? <span className="badge">yes</span> : "-"}</td>
                    <td className="row-action" onClick={(ev) => ev.stopPropagation()}>
                      <button className="btn small" onClick={() => openEdit(e.id)}>
                        Edit
                      </button>
                      <button className="btn danger" onClick={() => onDelete(e.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {detail && (
        <ExtDetail
          id={detail}
          ext={rows.find((r) => r.id === detail)}
          st={status[detail]}
          onClose={() => setDetail(null)}
          onEdit={() => openEdit(detail)}
          notify={notify}
        />
      )}

      {bulk && (
        <BulkModal
          existing={new Set(rows.map((r) => r.id))}
          onClose={() => setBulk(false)}
          onDone={(msg) => {
            notify({ kind: "ok", text: msg });
            setBulk(false);
            refresh();
          }}
          onError={(msg) => notify({ kind: "err", text: msg })}
        />
      )}

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

// DeviceCell shows a device illustration (mobile / web / desk phone) with an
// online/offline status dot overlaid.
function DeviceCell({ st, webrtc }: { st?: ExtStatus; webrtc: boolean }) {
  const online = !!st?.online;
  const device = st?.device && st.device !== "none" ? st.device : webrtc ? "web" : "desk";
  return (
    <span className={`dev ${online ? "on" : "off"}`} title={online ? "Registered" : "Offline"}>
      <DeviceIcon kind={device} />
      <span className={`dev-dot ${online ? "on" : "off"}`} />
    </span>
  );
}

export function DeviceIcon({ kind }: { kind: string }) {
  if (kind === "mobile") {
    return (
      <svg className="dev-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="6.5" y="2" width="11" height="20" rx="2.5" />
        <line x1="10.5" y1="19" x2="13.5" y2="19" />
      </svg>
    );
  }
  if (kind === "web") {
    return (
      <svg className="dev-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2.5" y="4" width="19" height="12.5" rx="1.8" />
        <line x1="9" y1="20.5" x2="15" y2="20.5" />
        <line x1="12" y1="16.5" x2="12" y2="20.5" />
      </svg>
    );
  }
  // desk phone
  return (
    <svg className="dev-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 8.5 C4 5 7 3.5 12 3.5 C17 3.5 20 5 20 8.5 L20 10 L15.5 10 L15 7.8 C13 7.2 11 7.2 9 7.8 L8.5 10 L4 10 Z" />
      <rect x="6" y="12" width="12" height="8.5" rx="1.5" />
      <line x1="9" y1="15" x2="15" y2="15" />
      <line x1="9" y1="17.7" x2="13" y2="17.7" />
    </svg>
  );
}

function relTime(iso?: string): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!t) return iso;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(t);
  return `${Math.floor(s / 86400)} d ago · ${d.toLocaleString()}`;
}

// ExtDetail is the click-through popup: live status illustration, where it is
// connected from, last-seen (offline only), and reset/edit actions.
function ExtDetail({
  id,
  ext,
  st,
  onClose,
  onEdit,
  notify,
}: {
  id: string;
  ext?: Extension;
  st?: ExtStatus;
  onClose: () => void;
  onEdit: () => void;
  notify: Notify;
}) {
  const [newPass, setNewPass] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = !!st?.online;
  const device = st?.device && st.device !== "none" ? st.device : ext?.webrtc ? "web" : "desk";

  const reset = async () => {
    if (!confirm(`Reset the SIP password for ${id}? The device must re-register with the new secret.`))
      return;
    setBusy(true);
    try {
      const r = await resetExtensionPassword(id); // server generates a strong one
      setNewPass(r.password);
      notify({ kind: "ok", text: `Password reset for ${id}` });
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>Extension {id}</header>

        <div className="ext-detail">
          <div className={`ext-hero ${online ? "on" : "off"}`}>
            <span className="ext-hero-icon">
              <DeviceIcon kind={device} />
            </span>
            <span className={`dev-dot lg ${online ? "on" : "off"}`} />
            <div className="ext-hero-state">{online ? "Registered" : "Offline"}</div>
            <div className="ext-hero-sub">
              {device === "mobile" ? "Mobile softphone" : device === "web" ? "Web / WebRTC" : "Desk phone"}
            </div>
          </div>

          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <span className={`badge ${online ? "" : "offline"}`}>
                {online ? "operational" : "not registered"}
              </span>
            </dd>
            {online && st?.ip && (
              <>
                <dt>Connected from</dt>
                <dd>
                  {st.ip}
                  {st.port ? `:${st.port}` : ""}
                </dd>
              </>
            )}
            {online && st?.userAgent && (
              <>
                <dt>User agent</dt>
                <dd className="mono-sm">{st.userAgent}</dd>
              </>
            )}
            {!online && (
              <>
                <dt>Last connected</dt>
                <dd>{relTime(st?.lastSeen)}</dd>
              </>
            )}
            <dt>Caller ID</dt>
            <dd>{ext?.callerId || "-"}</dd>
            <dt>Codecs</dt>
            <dd>{ext?.codecs || "-"}</dd>
          </dl>

          {newPass && (
            <div className="pass-reveal">
              New password: <code>{newPass}</code>
              <button
                className="btn ghost small"
                onClick={() => navigator.clipboard?.writeText(newPass).catch(() => {})}
              >
                Copy
              </button>
            </div>
          )}
        </div>

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn warn" disabled={busy} onClick={reset}>
            {busy ? "Resetting…" : "Reset Password"}
          </button>
          <button type="button" className="btn" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

const TEMPLATE_HEADER = "extension,password,callerId,context,transport,codecs,maxContacts,webrtc,dtmfMode";
const TEMPLATE_ROWS = [
  "2001,S3cret-2001,Reception <2001>,from-internal,transport-udp,ulaw&alaw,1,no,rfc4733",
  "2002,S3cret-2002,Sales <2002>,from-internal,transport-udp,ulaw&alaw,1,no,rfc4733",
  "2003,S3cret-2003,Support <2003>,from-internal,,ulaw&alaw,2,yes,rfc4733",
];

function downloadTemplate() {
  const csv = [TEMPLATE_HEADER, ...TEMPLATE_ROWS].join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "extensions-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// parseCSV turns the template CSV into extension objects. It tolerates an
// optional header row and uses "&" or ";" inside the codecs field (so it does
// not collide with the comma delimiter). Fields map positionally.
function parseCSV(text: string): { rows: Partial<Extension>[]; errors: string[] } {
  const errors: string[] = [];
  const rows: Partial<Extension>[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /^extension\s*,/i.test(line)) continue; // header
    const c = line.split(",").map((x) => x.trim());
    const id = c[0];
    if (!id) continue;
    if (!c[1]) {
      errors.push(`Row ${i + 1} (${id}): password is required`);
      continue;
    }
    rows.push({
      id,
      password: c[1],
      callerId: c[2] || "",
      context: c[3] || "from-internal",
      transport: (c[4] || "").trim(),
      codecs: (c[5] || "ulaw,alaw").replace(/[&;]/g, ","),
      maxContacts: parseInt(c[6] || "1", 10) || 1,
      webrtc: /^(yes|true|1)$/i.test(c[7] || ""),
      dtmfMode: c[8] || "rfc4733",
    });
  }
  return { rows, errors };
}

function BulkModal({
  existing,
  onClose,
  onDone,
  onError,
}: {
  existing: Set<string>;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.readAsText(f);
  };

  const submit = async () => {
    const { rows, errors } = parseCSV(text);
    if (rows.length === 0) {
      onError(errors[0] || "Nothing to upload — paste rows or choose a CSV file.");
      return;
    }
    const dupes = rows.filter((r) => existing.has(r.id!)).map((r) => r.id);
    if (dupes.length && !confirm(`These already exist and will be skipped by the server: ${dupes.join(", ")}. Continue?`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await bulkCreateExtensions(rows);
      const failed = res.results.filter((r) => !r.ok);
      const lines = [
        `Created ${res.created} of ${rows.length} extension(s).`,
        ...errors,
        ...failed.map((f) => `${f.id}: ${f.error}`),
      ];
      setReport(lines);
      if (failed.length === 0 && errors.length === 0) {
        onDone(`Created ${res.created} extension(s).`);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>Bulk Upload Extensions</header>
        <div className="form">
          <p className="hint-inline">
            Upload a CSV to create many extensions at once. Columns:{" "}
            <code>extension, password, callerId, context, transport, codecs, maxContacts, webrtc, dtmfMode</code>.
            Use <code>&amp;</code> to separate multiple codecs (e.g. <code>ulaw&amp;alaw</code>). Leave{" "}
            <code>transport</code> blank for WebRTC rows.
          </p>
          <div className="row-action">
            <button type="button" className="btn ghost small" onClick={downloadTemplate}>
              ↓ Download template
            </button>
            <button type="button" className="btn ghost small" onClick={() => fileRef.current?.click()}>
              Choose CSV file…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>
          <label>
            CSV content
            <textarea
              rows={8}
              className="mono"
              placeholder={TEMPLATE_HEADER + "\n" + TEMPLATE_ROWS[0]}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>

          {report && (
            <div className="bulk-report">
              {report.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {report ? "Close" : "Cancel"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={submit}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
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
