import { useCallback, useEffect, useState } from "react";
import {
  createInboundRoute,
  createOutboundRoute,
  deleteInboundRoute,
  deleteOutboundRoute,
  listInboundRoutes,
  listIVRs,
  listOutboundRoutes,
  listTrunks,
  updateInboundRoute,
  updateOutboundRoute,
  type InboundRoute,
  type IVR,
  type OutboundRoute,
  type Trunk,
} from "../api";
import type { Notify } from "../types";

const BLANK_OUT: OutboundRoute = {
  id: 0,
  name: "",
  pattern: "_9.",
  destType: "trunk",
  trunk: "",
  ivr: "",
  strip: 1,
  prepend: "",
  callerId: "",
  position: 100,
  enabled: true,
};

const BLANK_IN: InboundRoute = {
  id: 0,
  name: "",
  did: "",
  destination: "",
  enabled: true,
};

export default function Routing({ notify }: { notify: Notify }) {
  const [outbound, setOutbound] = useState<OutboundRoute[]>([]);
  const [inbound, setInbound] = useState<InboundRoute[]>([]);
  const [trunks, setTrunks] = useState<Trunk[]>([]);
  const [ivrs, setIvrs] = useState<IVR[]>([]);
  const [editOut, setEditOut] = useState<OutboundRoute | null>(null);
  const [editIn, setEditIn] = useState<InboundRoute | null>(null);

  const refresh = useCallback(() => {
    listOutboundRoutes().then(setOutbound).catch((e) => notify({ kind: "err", text: (e as Error).message }));
    listInboundRoutes().then(setInbound).catch((e) => notify({ kind: "err", text: (e as Error).message }));
    listTrunks().then(setTrunks).catch(() => {});
    listIVRs().then(setIvrs).catch(() => {});
  }, [notify]);

  useEffect(refresh, [refresh]);

  const delOut = async (id: number) => {
    if (!confirm("Delete this outbound route?")) return;
    try {
      await deleteOutboundRoute(id);
      notify({ kind: "ok", text: "Outbound route deleted" });
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };
  const delIn = async (id: number) => {
    if (!confirm("Delete this inbound route?")) return;
    try {
      await deleteInboundRoute(id);
      notify({ kind: "ok", text: "Inbound route deleted" });
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Routing</h2>
      </div>

      <section className="panel">
        <header>
          Outbound Routes
          <button className="btn small" style={{ float: "right" }} onClick={() => setEditOut({ ...BLANK_OUT })}>
            + New
          </button>
        </header>
        {outbound.length === 0 ? (
          <div className="empty">No outbound routes. Add one to place calls through a trunk.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Pattern</th>
                <th>Destination</th>
                <th>Strip</th>
                <th>Prepend</th>
                <th>On</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {outbound.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.pattern}</td>
                  <td>
                    {r.destType === "ivr" ? (
                      <span className="badge">IVR: {r.ivr}</span>
                    ) : (
                      `trunk: ${r.trunk}`
                    )}
                  </td>
                  <td>{r.destType === "ivr" ? "—" : r.strip}</td>
                  <td>{r.destType === "ivr" ? "—" : r.prepend || "-"}</td>
                  <td>{r.enabled ? "yes" : "no"}</td>
                  <td className="row-action">
                    <button className="btn small" onClick={() => setEditOut(r)}>Edit</button>
                    <button className="btn danger" onClick={() => delOut(r.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <header>
          Inbound Routes
          <button className="btn small" style={{ float: "right" }} onClick={() => setEditIn({ ...BLANK_IN })}>
            + New
          </button>
        </header>
        {inbound.length === 0 ? (
          <div className="empty">No inbound routes. Add one to send incoming DIDs to an extension.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>DID (match)</th>
                <th>Destination</th>
                <th>On</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {inbound.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.did}</td>
                  <td>{r.destination}</td>
                  <td>{r.enabled ? "yes" : "no"}</td>
                  <td className="row-action">
                    <button className="btn small" onClick={() => setEditIn(r)}>Edit</button>
                    <button className="btn danger" onClick={() => delIn(r.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editOut && (
        <OutForm
          initial={editOut}
          trunks={trunks}
          ivrs={ivrs}
          onClose={() => setEditOut(null)}
          onSaved={(m) => { notify({ kind: "ok", text: m }); setEditOut(null); refresh(); }}
          onError={(m) => notify({ kind: "err", text: m })}
        />
      )}
      {editIn && (
        <InForm
          initial={editIn}
          onClose={() => setEditIn(null)}
          onSaved={(m) => { notify({ kind: "ok", text: m }); setEditIn(null); refresh(); }}
          onError={(m) => notify({ kind: "err", text: m })}
        />
      )}
    </>
  );
}

function OutForm({
  initial, trunks, ivrs, onClose, onSaved, onError,
}: {
  initial: OutboundRoute;
  trunks: Trunk[];
  ivrs: IVR[];
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [f, setF] = useState<OutboundRoute>(initial);
  const [busy, setBusy] = useState(false);
  const isNew = f.id === 0;
  const toIVR = f.destType === "ivr";
  const set = <K extends keyof OutboundRoute>(k: K, v: OutboundRoute[K]) =>
    setF((p) => ({ ...p, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (toIVR && !f.ivr) return onError("Choose an IVR menu");
    if (!toIVR && !f.trunk) return onError("Choose a trunk");
    setBusy(true);
    try {
      if (isNew) { await createOutboundRoute(f); onSaved(`Created route ${f.name}`); }
      else { await updateOutboundRoute(f.id, f); onSaved(`Updated route ${f.name}`); }
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>{isNew ? "New Outbound Route" : `Edit ${f.name}`}</header>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>Name<input value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
            <label>
              Send to
              <select value={f.destType} onChange={(e) => set("destType", e.target.value as OutboundRoute["destType"])}>
                <option value="trunk">Trunk (external)</option>
                <option value="ivr">IVR menu</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Dial pattern <span className="hint-inline">(e.g. _9. = 9 then any)</span>
              <input value={f.pattern} onChange={(e) => set("pattern", e.target.value)} />
            </label>
            {toIVR ? (
              <label>
                IVR menu
                <select value={f.ivr} onChange={(e) => set("ivr", e.target.value)}>
                  <option value="">— choose —</option>
                  {ivrs.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
                </select>
              </label>
            ) : (
              <label>
                Trunk
                <select value={f.trunk} onChange={(e) => set("trunk", e.target.value)}>
                  <option value="">— choose —</option>
                  {trunks.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              </label>
            )}
          </div>
          {!toIVR && (
            <div className="form-row">
              <label>
                Strip <span className="hint-inline">(leading digits)</span>
                <input type="number" min={0} value={f.strip} onChange={(e) => set("strip", parseInt(e.target.value || "0", 10))} />
              </label>
              <label>Prepend<input value={f.prepend} onChange={(e) => set("prepend", e.target.value)} /></label>
            </div>
          )}
          {!toIVR && (
            <label>Caller ID override<input value={f.callerId} onChange={(e) => set("callerId", e.target.value)} /></label>
          )}
          <label className="check">
            <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
          {toIVR ? (
            <p className="hint-inline">
              Result: dialing a number matching the pattern sends the caller into
              the <b>{f.ivr || "…"}</b> auto-attendant menu. Useful for an internal
              "dial 500 for the menu" or steering certain numbers to an announcement.
            </p>
          ) : (
            <p className="hint-inline">
              Result: dialing a number matching the pattern strips {f.strip} leading
              digit(s), prepends "{f.prepend}", and dials it out via <b>{f.trunk || "…"}</b>.
              Keep outbound numbers longer than 4 digits (or prefixed) so they don't
              collide with internal extensions.
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function InForm({
  initial, onClose, onSaved, onError,
}: {
  initial: InboundRoute;
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [f, setF] = useState<InboundRoute>(initial);
  const [busy, setBusy] = useState(false);
  const isNew = f.id === 0;
  const set = <K extends keyof InboundRoute>(k: K, v: InboundRoute[K]) =>
    setF((p) => ({ ...p, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isNew) { await createInboundRoute(f); onSaved(`Created route ${f.name}`); }
      else { await updateInboundRoute(f.id, f); onSaved(`Updated route ${f.name}`); }
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>{isNew ? "New Inbound Route" : `Edit ${f.name}`}</header>
        <form className="form" onSubmit={submit}>
          <label>Name<input value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
          <div className="form-row">
            <label>
              DID / number to match <span className="hint-inline">(use _. for any)</span>
              <input value={f.did} placeholder="e.g. 18005551212 or _." onChange={(e) => set("did", e.target.value)} />
            </label>
            <label>
              Destination extension
              <input value={f.destination} placeholder="1001" onChange={(e) => set("destination", e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
          <p className="hint-inline">
            Incoming calls on a trunk whose dialed number matches the DID are sent
            to the destination extension.
          </p>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
