import { useEffect, useRef, useState } from "react";
import {
  connectEvents,
  getStatus,
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

interface TickerLine {
  id: number;
  source: string;
  label: string;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [lines, setLines] = useState<TickerLine[]>([]);
  const lineId = useRef(0);

  // Initial + periodic snapshot from ARI via the backend.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Live event stream.
  useEffect(() => {
    return connectEvents((env: WsEnvelope) => {
      if (env.kind === "hello") return;
      const label =
        env.kind === "ami"
          ? String(env.data?.Event ?? "event")
          : String(env.data?.type ?? "event");
      setLines((prev) => {
        const next = [
          { id: lineId.current++, source: env.kind, label },
          ...prev,
        ];
        return next.slice(0, 100);
      });
    }, setWsOpen);
  }, []);

  const endpoints: Endpoint[] = status?.endpoints ?? [];
  const channels: Channel[] = status?.channels ?? [];
  const online = endpoints.filter((e) => e.state === "online").length;

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
        <span>
          <span className={`dot ${wsOpen ? "up" : "down"}`} />
          {wsOpen ? "LIVE" : "RECONNECTING"}
        </span>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <a
            key={n.key}
            href={`#${n.key}`}
            className={`${n.key === "dashboard" ? "active" : ""} ${
              n.ready ? "" : "soon"
            }`}
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
                      <span
                        className={`badge ${
                          e.state === "online" ? "" : "offline"
                        }`}
                      >
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
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.state}</td>
                    <td>{c.caller?.number || "-"}</td>
                    <td>{c.connected?.number || "-"}</td>
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
