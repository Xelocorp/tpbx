import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectEvents,
  getAsteriskInfo,
  getStatus,
  hangup,
  originate,
  reloadModule,
  type AsteriskInfo,
  type Channel,
  type Endpoint,
  type Status,
  type WsEnvelope,
} from "./api";

const NAV = [
  { key: "dashboard", label: "Dashboard", ready: true },
  { key: "extensions", label: "Extensions", ready: false },
  { key: "trunks", label: "Trunks", ready: false },
  { key: "routing", label: "Routing", ready: false },
  { key: "transports", label: "Transports / TLS", ready: false },
  { key: "cdr", label: "Call History", ready: false },
  { key: "logs", label: "Logs", ready: false },
];

// Modules the reload control offers. res_pjsip is the common one after
// endpoint/trunk changes.
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

interface Toast {
  kind: "ok" | "err";
  text: string;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [info, setInfo] = useState<AsteriskInfo | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [lines, setLines] = useState<TickerLine[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const lineId = useRef(0);

  const refresh = useCallback(() => {
    getStatus().then(setStatus).catch(() => {});
    getAsteriskInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    return connectEvents((env: WsEnvelope) => {
      if (env.kind === "hello") return;
      const label =
        env.kind === "ami"
          ? String(env.data?.Event ?? "event")
          : String(env.data?.type ?? "event");
      setLines((prev) =>
        [{ id: lineId.current++, source: env.kind, label }, ...prev].slice(0, 100)
      );
    }, setWsOpen);
  }, []);

  const notify = useCallback((t: Toast) => {
    setToast(t);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const endpoints: Endpoint[] = status?.endpoints ?? [];
  const channels: Channel[] = status?.channels ?? [];
  const online = endpoints.filter((e) => e.state === "online").length;
  const version = info?.system?.version;

  const onHangup = async (id: string) => {
    try {
      await hangup(id);
      notify({ kind: "ok", text: `Hung up ${id}` });
      refresh();
    } catch (e) {
      notify({ kind: "err", text: (e as Error).message });
    }
  };

  return (
    <div className="app">
      <div className="brand">
        <div>
          <h1>TPBX</h1>
          <div className="rev">CTRL CONSOLE</div>
        </div>
      </div>

      <div className="topbar">
        <span>Asterisk Control Console</span>
        <span className="topbar-right">
          {version && <span className="ver">Asterisk {version}</span>}
          <span>
            <span className={`dot ${wsOpen ? "up" : "down"}`} />
            {wsOpen ? "LIVE" : "RECONNECTING"}
          </span>
        </span>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <a
            key={n.key}
            href={`#${n.key}`}
            className={`${n.key === "dashboard" ? "active" : ""} ${n.ready ? "" : "soon"}`}
          >
            {n.label}
            {!n.ready && <span className="soon-tag">SOON</span>}
          </a>
        ))}
      </nav>

      <main className="main">
        <div className="stat-row">
          <Stat label="Endpoints Online" value={`${online}/${endpoints.length}`} />
          <Stat label="Active Calls" value={`${channels.length}`} />
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
          <header>Active Calls</header>
          {status?.channels_error ? (
            <div className="empty">ARI: {status.channels_error}</div>
          ) : channels.length === 0 ? (
            <div className="empty">No active calls.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>State</th>
                  <th>Caller</th>
                  <th>Connected</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.state}</td>
                    <td>{c.caller?.number || "-"}</td>
                    <td>{c.connected?.number || "-"}</td>
                    <td className="row-action">
                      <button className="btn danger" onClick={() => onHangup(c.id)}>
                        Hangup
                      </button>
                    </td>
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
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
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
