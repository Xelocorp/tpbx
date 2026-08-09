import { useCallback, useEffect, useState } from "react";
import {
  getStatus,
  originate,
  reloadModule,
  type Channel,
  type Endpoint,
  type Status,
} from "../api";
import type { Notify, Toast } from "../types";
import { groupCalls } from "./CallFlow";

const RELOAD_MODULES = [
  "res_pjsip.so",
  "res_pjsip_outbound_registration.so",
  "cdr_adaptive_odbc.so",
  "cel_odbc.so",
];

interface TickerLine {
  id: number;
  source: string;
  label: string;
}

export default function Dashboard({
  wsOpen,
  lines,
  notify,
}: {
  wsOpen: boolean;
  lines: TickerLine[];
  notify: Notify;
}) {
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(() => {
    getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const endpoints: Endpoint[] = status?.endpoints ?? [];
  const channels: Channel[] = status?.channels ?? [];
  const online = endpoints.filter((e) => e.state === "online").length;
  const calls = groupCalls(channels, new Set()); // count only; live flow lives on Analytics

  return (
    <>
      <div className="stat-row">
        <Stat label="Endpoints Online" value={`${online}/${endpoints.length}`} />
        <Stat label="Active Calls" value={`${calls.length}`} />
        <Stat label="Event Link" value={wsOpen ? "LIVE" : "DOWN"} />
      </div>

      <div className="two-col">
        <OriginatePanel
          endpoints={endpoints}
          onDone={(t) => {
            notify(t);
            refresh();
          }}
        />
        <ReloadPanel onDone={notify} />
      </div>

      <section className="panel">
        <header>Registered Endpoints</header>
        {status?.endpoints_error ? (
          <div className="empty">ARI: {status.endpoints_error}</div>
        ) : endpoints.length === 0 ? (
          <div className="empty">No endpoints reported by Asterisk.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Resource</th>
                <th>Tech</th>
                <th>State</th>
                <th>Active Channels</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={`${e.technology}/${e.resource}`}>
                  <td>{e.resource}</td>
                  <td>{e.technology}</td>
                  <td>
                    <span className={`badge ${e.state === "online" ? "" : "offline"}`}>
                      {e.state || "unknown"}
                    </span>
                  </td>
                  <td>{e.channel_ids?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>


      <section className="panel">
        <header>Live Event Stream</header>
        <div className="ticker">
          {lines.length === 0 ? (
            <div className="empty">Waiting for Asterisk events…</div>
          ) : (
            lines.map((l) => (
              <div className="line" key={l.id}>
                <span className="t">[{l.source.toUpperCase()}]</span>
                <span className="k">{l.label}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function OriginatePanel({
  endpoints,
  onDone,
}: {
  endpoints: Endpoint[];
  onDone: (t: Toast) => void;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [extension, setExtension] = useState("");
  const [context, setContext] = useState("from-internal");
  const [callerId, setCallerId] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!endpoint) return onDone({ kind: "err", text: "Endpoint is required" });
    setBusy(true);
    try {
      await originate({ endpoint, extension, context, callerId });
      onDone({ kind: "ok", text: `Originated call to ${endpoint}` });
    } catch (err) {
      onDone({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header>Originate Call</header>
      <form className="form" onSubmit={submit}>
        <label>
          Endpoint
          <input
            list="ep-list"
            placeholder="PJSIP/1001"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <datalist id="ep-list">
            {endpoints.map((e) => (
              <option key={e.resource} value={`${e.technology}/${e.resource}`} />
            ))}
          </datalist>
        </label>
        <div className="form-row">
          <label>
            Extension
            <input placeholder="200" value={extension} onChange={(e) => setExtension(e.target.value)} />
          </label>
          <label>
            Context
            <input value={context} onChange={(e) => setContext(e.target.value)} />
          </label>
        </div>
        <label>
          Caller ID <span className="hint-inline">(optional)</span>
          <input placeholder="Reception <100>" value={callerId} onChange={(e) => setCallerId(e.target.value)} />
        </label>
        <button className="btn" disabled={busy} type="submit">
          {busy ? "Dialing…" : "Place Call"}
        </button>
      </form>
    </section>
  );
}

function ReloadPanel({ onDone }: { onDone: (t: Toast) => void }) {
  const [module, setModule] = useState(RELOAD_MODULES[0]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await reloadModule(module);
      onDone({ kind: "ok", text: `Reloaded ${module}` });
    } catch (err) {
      onDone({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header>Reload Module</header>
      <div className="form">
        <label>
          Module
          <select value={module} onChange={(e) => setModule(e.target.value)}>
            {RELOAD_MODULES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <p className="hint-inline">
          Applies config changes without a full restart. Use res_pjsip.so after
          editing endpoints or trunks.
        </p>
        <button className="btn" disabled={busy} onClick={run}>
          {busy ? "Reloading…" : "Reload"}
        </button>
      </div>
    </section>
  );
}
