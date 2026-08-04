import { useCallback, useEffect, useRef, useState } from "react";
import { connectEvents, getAsteriskInfo, type AsteriskInfo, type WsEnvelope } from "./api";
import type { Toast } from "./types";
import Dashboard from "./components/Dashboard";
import Extensions from "./components/Extensions";

const NAV = [
  { key: "dashboard", label: "Dashboard", ready: true },
  { key: "extensions", label: "Extensions", ready: true },
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

// currentView reads the hash so deep links / refreshes land on the right page.
function currentView(): string {
  const h = (location.hash || "#dashboard").slice(1);
  return NAV.some((n) => n.key === h && n.ready) ? h : "dashboard";
}

export default function App() {
  const [view, setView] = useState<string>(currentView());
  const [info, setInfo] = useState<AsteriskInfo | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [lines, setLines] = useState<TickerLine[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const lineId = useRef(0);

  useEffect(() => {
    const onHash = () => setView(currentView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    getAsteriskInfo().then(setInfo).catch(() => setInfo(null));
    const t = setInterval(() => getAsteriskInfo().then(setInfo).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, []);

  // Single WebSocket for the whole app; the LIVE indicator and the dashboard
  // ticker both read from it.
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

  const version = info?.system?.version;

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
            href={n.ready ? `#${n.key}` : undefined}
            className={`${n.key === view ? "active" : ""} ${n.ready ? "" : "soon"}`}
          >
            {n.label}
            {!n.ready && <span className="soon-tag">SOON</span>}
          </a>
        ))}
      </nav>

      <main className="main">
        {view === "extensions" ? (
          <Extensions notify={notify} />
        ) : (
          <Dashboard wsOpen={wsOpen} lines={lines} notify={notify} />
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
