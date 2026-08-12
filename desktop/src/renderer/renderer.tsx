import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_CONN,
  defaultPort,
  deriveWssUrl,
  requiredFields,
  type Conn,
  type Transport,
} from "../shared/config";
import { WssPhone, type PhoneState } from "./wssPhone";

const STORE_KEY = "xelovoice.conn";

function loadConn(): Conn {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_CONN, ...(JSON.parse(raw) as Partial<Conn>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CONN };
}

function csv(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function iceServersFrom(c: Conn): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  const stun = csv(c.stunUrls);
  if (stun.length) out.push({ urls: stun });
  const turn = csv(c.turnUrls);
  if (turn.length) {
    out.push({ urls: turn, username: c.turnUser, credential: c.turnPass });
  }
  return out;
}

const TRANSPORTS: Transport[] = ["wss", "tls", "tcp", "udp"];

type View = "settings" | "phone";

function App() {
  const [conn, setConn] = useState<Conn>(loadConn);
  const [view, setView] = useState<View>("settings");
  const [state, setState] = useState<PhoneState>("offline");
  const [detail, setDetail] = useState("");
  const [peer, setPeer] = useState("");
  const [readout, setReadout] = useState("");
  const [muted, setMuted] = useState(false);
  const [dnd, setDnd] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const phoneRef = useRef<WssPhone | null>(null);
  const isWss = conn.transport === "wss";

  const set = <K extends keyof Conn>(k: K, v: Conn[K]) => setConn((c) => ({ ...c, [k]: v }));

  const pickTransport = (t: Transport) =>
    setConn((c) => ({ ...c, transport: t, port: t === "wss" ? c.port : defaultPort(t) }));

  // Subscribe to raw-transport (UDP/TCP/TLS) registration state from main.
  useEffect(() => {
    const off = window.sipNative.onState(({ state: s, detail: d }) => {
      setDetail(d || "");
      if (s === "registered") setState("registered");
      else if (s === "connecting") setState("connecting");
      else if (s === "failed") setState("failed");
      else setState("offline");
    });
    return off;
  }, []);

  const missing = useMemo(
    () => requiredFields(conn.transport).filter((f) => !String(conn[f]).trim()),
    [conn]
  );

  const connect = useCallback(async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(conn));
    setDetail("");
    setState("connecting");
    setView("phone");

    if (conn.transport === "wss") {
      if (conn.ignoreCertErrors) await window.sipNative.trustHost(conn.server);
      const audio = document.getElementById("remote-audio") as HTMLAudioElement;
      const phone = new WssPhone(
        {
          wsUrl: deriveWssUrl(conn),
          domain: conn.server,
          extension: conn.extension,
          password: conn.password,
          displayName: conn.displayName,
          iceServers: iceServersFrom(conn),
        },
        {
          onState: (s, d) => {
            setState(s);
            if (d !== undefined) setDetail(d);
            if (s === "incoming" || s === "outgoing" || s === "active") setPeer(d || "");
            if (s === "registered") setPeer("");
          },
          onIncoming: (from) => setPeer(from),
          onError: (m) => setDetail(m),
        },
        audio
      );
      phoneRef.current = phone;
      await phone.start();
    } else {
      // Raw transports register in the main process.
      await window.sipNative.register(conn);
    }
  }, [conn]);

  const disconnect = useCallback(async () => {
    if (conn.transport === "wss") {
      await phoneRef.current?.stop();
      phoneRef.current = null;
    } else {
      await window.sipNative.unregister();
    }
    setState("offline");
    setPeer("");
    setView("settings");
  }, [conn.transport]);

  const inCall = state === "incoming" || state === "outgoing" || state === "active";

  const onCall = () => {
    if (!isWss) return; // raw transports: registration only in this build
    if (!readout.trim()) return;
    void phoneRef.current?.call(readout.trim());
  };
  const onHangup = () => phoneRef.current?.hangup();
  const onAnswer = () => void phoneRef.current?.answer();
  const onKey = (k: string) => {
    if (state === "active") phoneRef.current?.sendDtmf(k);
    setReadout((r) => r + k);
  };
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    phoneRef.current?.setMuted(m);
  };
  const toggleDnd = () => {
    const d = !dnd;
    setDnd(d);
    phoneRef.current?.setDND(d);
  };
  const onTransfer = () => {
    if (state !== "active") return;
    const target = window.prompt("Transfer call to (number/extension):");
    if (!target) return;
    setTransferring(true);
    void phoneRef.current?.blindTransfer(target).finally(() => setTransferring(false));
  };

  if (view === "settings") {
    return (
      <Settings
        conn={conn}
        set={set}
        pickTransport={pickTransport}
        missing={missing}
        onConnect={connect}
      />
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <span className={`dot ${state}`} />
        <span className="title">
          {conn.extension || "Softphone"} · {conn.transport.toUpperCase()}
        </span>
        <span className="spacer" />
        <button className="icon-btn" onClick={disconnect} title="Disconnect / settings">
          ⚙ Disconnect
        </button>
      </div>
      <div className="status">
        {state === "registered"
          ? "Registered"
          : state === "connecting"
            ? `Connecting…${detail ? " " + detail : ""}`
            : state === "failed"
              ? `Failed: ${detail}`
              : state === "incoming"
                ? `Incoming from ${peer}`
                : state === "outgoing"
                  ? `Calling ${peer}…`
                  : state === "active"
                    ? `In call: ${peer}`
                    : "Offline"}
      </div>

      <div className="dialer">
        {!isWss && (
          <div className="banner">
            {conn.transport.toUpperCase()} registers over this transport. Placing
            calls with audio uses WebRTC (WSS) in this build — switch the
            transport to WSS to make calls. Native audio for UDP/TCP/TLS is on
            the roadmap.
          </div>
        )}
        <div className="readout">{readout || " "}</div>
        <div className="peer">{peer}</div>

        <div className="keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((k) => (
            <button key={k} className="key" onClick={() => onKey(k)}>
              {k}
            </button>
          ))}
        </div>

        <div className="actions">
          {state === "incoming" ? (
            <button className="action" onClick={onAnswer}>
              <span className="circle call">✆</span>
              Answer
            </button>
          ) : (
            <button className="action" onClick={onCall} disabled={!isWss}>
              <span className="circle call" style={{ opacity: isWss ? 1 : 0.4 }}>
                ✆
              </span>
              Call
            </button>
          )}
          <button className="action" onClick={onHangup} disabled={!inCall}>
            <span className="circle hangup" style={{ opacity: inCall ? 1 : 0.4 }}>
              ✕
            </span>
            Hang up
          </button>
          <button className="action" onClick={toggleMute} disabled={state !== "active"}>
            <span className={`circle ${muted ? "on" : "neutral"}`}>🎙</span>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button className="action" onClick={toggleDnd}>
            <span className={`circle ${dnd ? "on" : "neutral"}`}>DND</span>
            DND
          </button>
          <button className="action" onClick={onTransfer} disabled={state !== "active" || transferring}>
            <span className="circle neutral">↗</span>
            Transfer
          </button>
        </div>
        {readout && (
          <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setReadout("")}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function Settings({
  conn,
  set,
  pickTransport,
  missing,
  onConnect,
}: {
  conn: Conn;
  set: <K extends keyof Conn>(k: K, v: Conn[K]) => void;
  pickTransport: (t: Transport) => void;
  missing: (keyof Conn)[];
  onConnect: () => void;
}) {
  const isWss = conn.transport === "wss";
  const showCert = conn.transport === "wss" || conn.transport === "tls";

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">XeloVoice Softphone</span>
      </div>
      <div className="settings">
        <h2>Connection</h2>

        <div className="field">
          <label>Transport</label>
          <div className="transport-seg">
            {TRANSPORTS.map((t) => (
              <button key={t} className={conn.transport === t ? "on" : ""} onClick={() => pickTransport(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Common fields (every transport). */}
        <div className="field">
          <label>Extension</label>
          <input value={conn.extension} onChange={(e) => set("extension", e.target.value.trim())} placeholder="1001" />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={conn.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder="SIP secret"
          />
        </div>
        <div className="field">
          <label>Display name (optional)</label>
          <input value={conn.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Jane Doe" />
        </div>
        <div className="field">
          <label>Server / SIP domain</label>
          <input value={conn.server} onChange={(e) => set("server", e.target.value.trim())} placeholder="pbx.example.com" />
        </div>

        {/* Transport-specific fields: only the ones that matter are shown. */}
        {isWss ? (
          <>
            <div className="field">
              <label>WSS port</label>
              <input value={conn.wssPort} onChange={(e) => set("wssPort", e.target.value.trim())} placeholder="8089" />
            </div>
            <div className="field">
              <label>WSS URL override (optional — reverse proxy)</label>
              <input
                value={conn.wssUrl}
                onChange={(e) => set("wssUrl", e.target.value.trim())}
                placeholder="wss://pbx.example.com/asterisk-ws"
              />
            </div>
            <div className="field">
              <label>STUN URLs (optional, comma-separated)</label>
              <input
                value={conn.stunUrls}
                onChange={(e) => set("stunUrls", e.target.value)}
                placeholder="stun:pbx.example.com:3478"
              />
            </div>
            <div className="field">
              <label>TURN URLs (optional, comma-separated)</label>
              <input
                value={conn.turnUrls}
                onChange={(e) => set("turnUrls", e.target.value)}
                placeholder="turn:pbx.example.com:3478?transport=udp"
              />
            </div>
            {csv(conn.turnUrls).length > 0 && (
              <div className="field" style={{ flexDirection: "row", gap: 8 }}>
                <input
                  style={{ flex: 1 }}
                  value={conn.turnUser}
                  onChange={(e) => set("turnUser", e.target.value)}
                  placeholder="TURN username"
                />
                <input
                  style={{ flex: 1 }}
                  value={conn.turnPass}
                  onChange={(e) => set("turnPass", e.target.value)}
                  placeholder="TURN password"
                />
              </div>
            )}
          </>
        ) : (
          <div className="field">
            <label>Port</label>
            <input value={conn.port} onChange={(e) => set("port", e.target.value.trim())} placeholder={defaultPort(conn.transport)} />
          </div>
        )}

        {showCert && (
          <div className="field checkbox">
            <input
              id="cert"
              type="checkbox"
              checked={conn.ignoreCertErrors}
              onChange={(e) => set("ignoreCertErrors", e.target.checked)}
            />
            <label htmlFor="cert">Accept self-signed / untrusted server certificate</label>
          </div>
        )}

        {!isWss && (
          <p className="hint">
            {conn.transport.toUpperCase()} performs SIP registration over a raw
            socket. Calls with audio use WebRTC (WSS) in this build; native audio
            for UDP/TCP/TLS is planned.
          </p>
        )}

        <button className="btn" onClick={onConnect} disabled={missing.length > 0}>
          {missing.length > 0 ? `Fill: ${missing.join(", ")}` : "Connect"}
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
