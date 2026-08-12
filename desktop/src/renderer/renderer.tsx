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
import { WssPhone, type CallEnded, type PhoneState } from "./wssPhone";
import { Ringer } from "./ringer";
import { Telemetry, deriveConsoleBase } from "./telemetry";

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
  if (turn.length) out.push({ urls: turn, username: c.turnUser, credential: c.turnPass });
  return out;
}

// Map a finished call to the outcome the analytics backend records.
function outcomeOf(e: CallEnded): "answered" | "rejected" | "missed" | "failed" {
  if (e.answered) return "answered";
  if (e.declined) return "rejected";
  return e.direction === "in" ? "missed" : "failed";
}

const TRANSPORTS: Transport[] = ["wss", "tls", "tcp", "udp"];
type View = "settings" | "phone";

function nowClock(): string {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

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
  const [clock, setClock] = useState(nowClock());

  const phoneRef = useRef<WssPhone | null>(null);
  const ringerRef = useRef<Ringer>(new Ringer());
  const telRef = useRef<Telemetry | null>(null);
  const registeredSent = useRef(false);
  const isWss = conn.transport === "wss";

  useEffect(() => {
    const t = setInterval(() => setClock(nowClock()), 15000);
    return () => clearInterval(t);
  }, []);

  const set = <K extends keyof Conn>(k: K, v: Conn[K]) => setConn((c) => ({ ...c, [k]: v }));
  const pickTransport = (t: Transport) =>
    setConn((c) => ({ ...c, transport: t, port: t === "wss" ? c.port : defaultPort(t) }));

  // Raw-transport (UDP/TCP/TLS) registration state from the main process.
  useEffect(() => {
    const off = window.sipNative.onState(({ state: s, detail: d }) => {
      setDetail(d || "");
      if (s === "registered") {
        setState("registered");
        if (!registeredSent.current) {
          telRef.current?.send({ event: "registered", transport: conn.transport });
          registeredSent.current = true;
        }
      } else if (s === "connecting") setState("connecting");
      else if (s === "failed") setState("failed");
      else setState("offline");
    });
    return off;
  }, [conn.transport]);

  const missing = useMemo(
    () => requiredFields(conn.transport).filter((f) => !String(conn[f]).trim()),
    [conn]
  );

  const stopRing = () => ringerRef.current.stop();

  const connect = useCallback(async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(conn));
    setDetail("");
    setState("connecting");
    setView("phone");
    registeredSent.current = false;
    ringerRef.current.unlock(); // the Connect click is our audio gesture

    // Telemetry (best-effort): log into the console with the same SIP creds.
    const tel = new Telemetry(deriveConsoleBase(conn.server, conn.consoleUrl));
    telRef.current = tel;
    void tel.login(conn.extension, conn.password);

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
            if (s === "registered") {
              setPeer("");
              stopRing();
              if (!registeredSent.current) {
                tel.send({ event: "registered", transport: "wss" });
                registeredSent.current = true;
              }
            }
            if (s === "outgoing") ringerRef.current.ringback();
            if (s === "active" || s === "failed" || s === "offline") stopRing();
          },
          onIncoming: () => ringerRef.current.incoming(),
          onError: (m) => setDetail(m),
          onCallEnded: (e) => {
            stopRing();
            tel.send({
              event: "call",
              direction: e.direction,
              peer: e.peer,
              outcome: outcomeOf(e),
              durationSec: e.durationSec,
              transport: "wss",
            });
          },
        },
        audio
      );
      phoneRef.current = phone;
      await phone.start();
    } else {
      await window.sipNative.register(conn);
    }
  }, [conn]);

  const disconnect = useCallback(async () => {
    stopRing();
    telRef.current?.send({ event: "unregistered", transport: conn.transport });
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
    if (!isWss || !readout.trim()) return;
    ringerRef.current.unlock();
    void phoneRef.current?.call(readout.trim());
  };
  const onHangup = () => phoneRef.current?.hangup();
  const onAnswer = () => {
    stopRing();
    void phoneRef.current?.answer();
  };
  const onKey = (k: string) => {
    ringerRef.current.unlock();
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
    telRef.current?.send({ event: d ? "dnd_on" : "dnd_off", transport: conn.transport });
  };
  const onTransfer = () => {
    if (state !== "active") return;
    const target = window.prompt("Transfer call to (number/extension):");
    if (!target) return;
    setTransferring(true);
    void phoneRef.current?.blindTransfer(target).finally(() => setTransferring(false));
  };

  const statusText =
    state === "registered"
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
                : "Offline";

  return (
    <PhoneShell clock={clock} state={state}>
      {view === "settings" ? (
        <Settings conn={conn} set={set} pickTransport={pickTransport} missing={missing} onConnect={connect} />
      ) : (
        <div className="scene">
          <div className="phone-head">
            <span className={`dot ${state}`} />
            <span className="who">
              {conn.extension || "Softphone"} · {conn.transport.toUpperCase()}
            </span>
            <button className="pill-btn" onClick={disconnect}>
              Disconnect
            </button>
          </div>
          <div className="status">{statusText}</div>

          {!isWss && (
            <div className="banner">
              {conn.transport.toUpperCase()} registers on this transport. Calls with
              audio use WebRTC (WSS) — switch to WSS to place calls.
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
            <button className="clear" onClick={() => setReadout("")}>
              Clear
            </button>
          )}
        </div>
      )}
    </PhoneShell>
  );
}

// PhoneShell draws the iPhone-style bezel, notch, status bar (with window
// controls) and home indicator around the app content.
function PhoneShell({
  clock,
  state,
  children,
}: {
  clock: string;
  state: PhoneState;
  children: React.ReactNode;
}) {
  return (
    <div className="phone">
      <div className="statusbar">
        <span className="clock">{clock}</span>
        <span className="notch" />
        <span className="winctl">
          <button className="wc" title="Minimize" onClick={() => window.sipNative.minimize()}>
            —
          </button>
          <button className="wc close" title="Close" onClick={() => window.sipNative.close()}>
            ✕
          </button>
        </span>
      </div>
      <div className={`screen ${state}`}>{children}</div>
      <div className="home-indicator" />
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
    <div className="settings">
      <h2>XeloVoice Softphone</h2>

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

      <div className="field">
        <label>Extension</label>
        <input value={conn.extension} onChange={(e) => set("extension", e.target.value.trim())} placeholder="1001" />
      </div>
      <div className="field">
        <label>Password</label>
        <input type="password" value={conn.password} onChange={(e) => set("password", e.target.value)} placeholder="SIP secret" />
      </div>
      <div className="field">
        <label>Display name (optional)</label>
        <input value={conn.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Jane Doe" />
      </div>
      <div className="field">
        <label>Server / SIP domain</label>
        <input value={conn.server} onChange={(e) => set("server", e.target.value.trim())} placeholder="pbx.example.com" />
      </div>

      {isWss ? (
        <>
          <div className="field">
            <label>WSS port</label>
            <input value={conn.wssPort} onChange={(e) => set("wssPort", e.target.value.trim())} placeholder="8089" />
          </div>
          <div className="field">
            <label>WSS URL override (optional)</label>
            <input value={conn.wssUrl} onChange={(e) => set("wssUrl", e.target.value.trim())} placeholder="wss://pbx.example.com/asterisk-ws" />
          </div>
          <div className="field">
            <label>STUN URLs (optional)</label>
            <input value={conn.stunUrls} onChange={(e) => set("stunUrls", e.target.value)} placeholder="stun:pbx.example.com:3478" />
          </div>
          <div className="field">
            <label>TURN URLs (optional)</label>
            <input value={conn.turnUrls} onChange={(e) => set("turnUrls", e.target.value)} placeholder="turn:pbx.example.com:3478?transport=udp" />
          </div>
          {csv(conn.turnUrls).length > 0 && (
            <div className="field" style={{ flexDirection: "row", gap: 6 }}>
              <input style={{ flex: 1 }} value={conn.turnUser} onChange={(e) => set("turnUser", e.target.value)} placeholder="TURN user" />
              <input style={{ flex: 1 }} value={conn.turnPass} onChange={(e) => set("turnPass", e.target.value)} placeholder="TURN pass" />
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
          <input id="cert" type="checkbox" checked={conn.ignoreCertErrors} onChange={(e) => set("ignoreCertErrors", e.target.checked)} />
          <label htmlFor="cert">Accept self-signed certificate</label>
        </div>
      )}

      <div className="field">
        <label>Console URL for analytics (optional)</label>
        <input value={conn.consoleUrl} onChange={(e) => set("consoleUrl", e.target.value.trim())} placeholder={conn.server ? `https://${conn.server}` : "https://pbx.example.com"} />
      </div>

      <button className="btn" onClick={onConnect} disabled={missing.length > 0}>
        {missing.length > 0 ? `Fill: ${missing.join(", ")}` : "Connect"}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
