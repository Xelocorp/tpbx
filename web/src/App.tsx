import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectEvents,
  getAsteriskInfo,
  getMe,
  logout,
  type AsteriskInfo,
  type Me,
  type WsEnvelope,
} from "./api";
import type { Toast } from "./types";
import Dashboard from "./components/Dashboard";
import Extensions from "./components/Extensions";
import Trunks from "./components/Trunks";
import Routing from "./components/Routing";
import Transports from "./components/Transports";
import Analytics from "./components/Analytics";
import Settings from "./components/Settings";
import Users from "./components/Users";
import CallHistory from "./components/CallHistory";
import Login from "./components/Login";

// `roles`, when present, restricts a nav item to those roles; otherwise every
// authenticated role sees it.
const NAV: { key: string; label: string; ready: boolean; roles?: string[] }[] = [
  { key: "dashboard", label: "Dashboard", ready: true },
  { key: "extensions", label: "Extensions", ready: true },
  { key: "trunks", label: "Trunks", ready: true },
  { key: "routing", label: "Routing", ready: true },
  { key: "cdr", label: "Call History", ready: true },
  { key: "analytics", label: "Analytics", ready: true, roles: ["admin", "manager"] },
  { key: "transports", label: "Transports / TLS", ready: true, roles: ["admin"] },
  { key: "settings", label: "Settings", ready: true, roles: ["admin"] },
  { key: "users", label: "Users", ready: true, roles: ["admin"] },
];

interface TickerLine {
  id: number;
  source: string;
  label: string;
}

function currentView(): string {
  const h = (location.hash || "#dashboard").slice(1);
  return NAV.some((n) => n.key === h && n.ready) ? h : "dashboard";
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) {
    return <div className="login-screen" />; // brief blank while checking session
  }
  if (!me) {
    return <Login onLogin={setMe} />;
  }
  return <Console me={me} onLogout={() => setMe(null)} />;
}

function Console({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const nav = NAV.filter((n) => !n.roles || n.roles.includes(me.role));
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

  const doLogout = async () => {
    await logout();
    onLogout();
  };

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
          <span className="ver">{me.username}</span>
          <button className="btn ghost small" onClick={doLogout}>
            Logout
          </button>
        </span>
      </div>

      <nav className="nav">
        {nav.map((n) => (
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
        ) : view === "trunks" ? (
          <Trunks notify={notify} />
        ) : view === "routing" ? (
          <Routing notify={notify} />
        ) : view === "transports" ? (
          <Transports notify={notify} />
        ) : view === "analytics" ? (
          <Analytics notify={notify} />
        ) : view === "settings" ? (
          <Settings notify={notify} />
        ) : view === "users" ? (
          <Users notify={notify} me={me} />
        ) : view === "cdr" ? (
          <CallHistory notify={notify} />
        ) : (
          <Dashboard wsOpen={wsOpen} lines={lines} notify={notify} />
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
