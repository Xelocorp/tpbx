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
import { WssPhone, type CallEnded, type CallsSnapshot, type PhoneState } from "./wssPhone";
import { Ringer } from "./ringer";
import { Telemetry, deriveConsoleBase } from "./telemetry";
import { addLog, fmtDur, fmtTime, groupLog, loadLog, type LogEntry } from "./callLog";
import logo from "./xelovoice.png";

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
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function iceServersFrom(c: Conn): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  const stun = csv(c.stunUrls);
  if (stun.length) out.push({ urls: stun });
  const turn = csv(c.turnUrls);
  if (turn.length) out.push({ urls: turn, username: c.turnUser, credential: c.turnPass });
  return out;
}
function outcomeOf(e: CallEnded): "answered" | "rejected" | "missed" | "failed" {
  if (e.answered) return "answered";
  if (e.declined) return "rejected";
  return e.direction === "in" ? "missed" : "failed";
}

const TRANSPORTS: Transport[] = ["wss", "tls", "tcp", "udp"];
const KEYS: { d: string; sub?: string }[] = [
  { d: "1" }, { d: "2", sub: "ABC" }, { d: "3", sub: "DEF" },
  { d: "4", sub: "GHI" }, { d: "5", sub: "JKL" }, { d: "6", sub: "MNO" },
  { d: "7", sub: "PQRS" }, { d: "8", sub: "TUV" }, { d: "9", sub: "WXYZ" },
  { d: "*" }, { d: "0", sub: "+" }, { d: "#" },
];
type Tab = "favorites" | "recents" | "contacts" | "keypad" | "voicemail";

function App() {
  const [conn, setConn] = useState<Conn>(loadConn);
  const [phase, setPhase] = useState<"setup" | "live">("setup");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("keypad");
  const [state, setState] = useState<PhoneState>("offline");
  const [detail, setDetail] = useState("");
  const [peer, setPeer] = useState("");
  const [readout, setReadout] = useState("");
  const [muted, setMuted] = useState(false);
  const [dnd, setDnd] = useState(false);
  const [calls, setCalls] = useState<CallsSnapshot>({});
  const [log, setLog] = useState<LogEntry[]>(loadLog);
  const [callStart, setCallStart] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [dtmfOpen, setDtmfOpen] = useState(false);

  const phoneRef = useRef<WssPhone | null>(null);
  const ringerRef = useRef<Ringer>(new Ringer());
  const telRef = useRef<Telemetry | null>(null);
  const registeredSent = useRef(false);
  const ringMode = useRef<"none" | "incoming" | "outgoing" | "waiting">("none");
  const isWss = conn.transport === "wss";

  const applyRing = useCallback((snap: CallsSnapshot) => {
    const want = snap.waiting
      ? "waiting"
      : snap.active?.state === "incoming" && !snap.held
        ? "incoming"
        : snap.active?.state === "outgoing"
          ? "outgoing"
          : "none";
    if (want === ringMode.current) return;
    ringMode.current = want;
    ringerRef.current.stop();
    if (want === "incoming") ringerRef.current.incoming();
    else if (want === "outgoing") ringerRef.current.ringback();
    else if (want === "waiting") ringerRef.current.waiting();
  }, []);

  // Call timer while a call is active.
  useEffect(() => {
    if (state !== "active") {
      setElapsed(0);
      return;
    }
    const start = callStart || Date.now();
    if (!callStart) setCallStart(start);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [state, callStart]);

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

  const set = <K extends keyof Conn>(k: K, v: Conn[K]) => setConn((c) => ({ ...c, [k]: v }));
  const pickTransport = (t: Transport) =>
    setConn((c) => ({ ...c, transport: t, port: t === "wss" ? c.port : defaultPort(t) }));
  const missing = useMemo(
    () => requiredFields(conn.transport).filter((f) => !String(conn[f]).trim()),
    [conn]
  );

  const connect = useCallback(async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(conn));
    setDetail("");
    setState("connecting");
    setPhase("live");
    setSettingsOpen(false);
    setTab("keypad");
    registeredSent.current = false;
    ringerRef.current.unlock();

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
            if (s === "active") setCallStart(Date.now());
            if (s === "registered") {
              setPeer("");
              setCallStart(0);
              if (!registeredSent.current) {
                tel.send({ event: "registered", transport: "wss" });
                registeredSent.current = true;
              }
            }
          },
          onIncoming: () => {},
          onWaiting: () => {},
          onCalls: (snap) => {
            setCalls(snap);
            applyRing(snap);
          },
          onError: (m) => setDetail(m),
          onCallEnded: (e) => {
            tel.send({
              event: "call",
              direction: e.direction,
              peer: e.peer,
              outcome: outcomeOf(e),
              durationSec: e.durationSec,
              transport: "wss",
            });
            setLog(addLog({ peer: e.peer, direction: e.direction, outcome: outcomeOf(e), durationSec: e.durationSec, at: Date.now() }));
          },
        },
        audio
      );
      phoneRef.current = phone;
      await phone.start();
    } else {
      await window.sipNative.register(conn);
    }
  }, [conn, applyRing]);

  const disconnect = useCallback(async () => {
    ringerRef.current.stop();
    ringMode.current = "none";
    setCalls({});
    telRef.current?.send({ event: "unregistered", transport: conn.transport });
    if (conn.transport === "wss") {
      await phoneRef.current?.stop();
      phoneRef.current = null;
    } else {
      await window.sipNative.unregister();
    }
    setState("offline");
    setPeer("");
    setPhase("setup");
  }, [conn.transport]);

  const dial = (target: string) => {
    if (!isWss || !target.trim()) return;
    ringerRef.current.unlock();
    void phoneRef.current?.call(target.trim());
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
    const target = window.prompt("Transfer call to (number/extension):");
    if (target) void phoneRef.current?.blindTransfer(target);
  };
  const redial = (p: string) => {
    setReadout(p);
    setTab("keypad");
    dial(p);
  };

  // --- render -------------------------------------------------------------
  const gear = () => setSettingsOpen(true);

  let body: React.ReactNode;
  if (phase === "setup" || settingsOpen) {
    body = (
      <SettingsScreen
        conn={conn}
        set={set}
        pickTransport={pickTransport}
        missing={missing}
        live={phase === "live"}
        onConnect={connect}
        onDisconnect={disconnect}
        onClose={() => setSettingsOpen(false)}
      />
    );
  } else if (state === "incoming") {
    body = <IncomingScreen peer={peer} onAnswer={() => phoneRef.current?.answer()} onDecline={() => phoneRef.current?.hangup()} onGear={gear} state={state} />;
  } else if (state === "outgoing" || state === "active") {
    body = (
      <InCallScreen
        peer={peer}
        state={state}
        elapsed={elapsed}
        muted={muted}
        dtmfOpen={dtmfOpen}
        calls={calls}
        onKey={onKey}
        toggleDtmf={() => setDtmfOpen((v) => !v)}
        onMute={toggleMute}
        onTransfer={onTransfer}
        onHangup={() => phoneRef.current?.hangup()}
        onAnswerWaiting={() => void phoneRef.current?.answerWaiting()}
        onRejectWaiting={() => phoneRef.current?.rejectWaiting()}
        onSwap={() => void phoneRef.current?.swap()}
        onGear={gear}
      />
    );
  } else {
    // Idle tabbed UI.
    const tabTitle: Record<Tab, string> = {
      favorites: "Favorites",
      recents: "Call Log",
      contacts: "Contacts",
      keypad: "SIP Dialer",
      voicemail: "Voicemail",
    };
    body = (
      <>
        <Header
          title={tabTitle[tab]}
          state={state}
          onGear={gear}
          showLogo={tab === "keypad"}
          dnd={dnd}
          onDnd={toggleDnd}
        />
        {state !== "registered" && (
          <div className={`conn-note ${state}`}>
            {state === "connecting"
              ? `Connecting…${detail ? " " + detail : ""}`
              : state === "failed"
                ? `Not connected: ${detail || "check settings"}`
                : "Offline"}
          </div>
        )}
        <div className="body">
          {tab === "keypad" ? (
            <KeypadScreen readout={readout} setReadout={setReadout} onKey={onKey} onCall={() => dial(readout)} canCall={isWss} />
          ) : tab === "recents" ? (
            <RecentsScreen log={log} onRedial={redial} />
          ) : tab === "contacts" ? (
            <Placeholder icon="👤" title="Contacts" text="Contact directory is coming soon." />
          ) : tab === "favorites" ? (
            <Placeholder icon="★" title="Favorites" text="Star numbers from Recents to see them here (coming soon)." />
          ) : (
            <Placeholder icon="✉" title="Voicemail" text="Voicemail integration is coming soon." />
          )}
        </div>
        <TabBar tab={tab} setTab={setTab} />
      </>
    );
  }

  return (
    <div className="phone">
      <TitleBar />
      {body}
    </div>
  );
}

// Slim draggable strip with window controls (frameless window).
function TitleBar() {
  return (
    <div className="titlebar">
      <span className="tb-drag" />
      <button className="tb-btn" title="Minimize" onClick={() => window.sipNative.minimize()}>—</button>
      <button className="tb-btn close" title="Close" onClick={() => window.sipNative.close()}>✕</button>
    </div>
  );
}

function SignalIcon({ state }: { state: PhoneState }) {
  const cls = state === "registered" || state === "active" ? "sig up" : state === "connecting" ? "sig warn" : "sig down";
  return (
    <span className={cls} title={state}>
      <i /><i /><i />
    </span>
  );
}

function Header({
  title, state, onGear, showLogo, dnd, onDnd,
}: {
  title: string; state: PhoneState; onGear: () => void; showLogo?: boolean; dnd?: boolean; onDnd?: () => void;
}) {
  return (
    <div className="header">
      <SignalIcon state={state} />
      {showLogo ? <img className="wordmark" src={logo} alt="XeloVoice" /> : <span className="htitle">{title}</span>}
      <span className="hspace" />
      {onDnd && (
        <button className={`dnd-pill ${dnd ? "on" : ""}`} onClick={onDnd} title="Do Not Disturb">DND</button>
      )}
      <button className="gear" onClick={onGear} title="Settings">⚙</button>
    </div>
  );
}

function KeypadScreen({
  readout, setReadout, onKey, onCall, canCall,
}: {
  readout: string; setReadout: (s: string) => void; onKey: (k: string) => void; onCall: () => void; canCall: boolean;
}) {
  return (
    <div className="keypad-screen">
      <div className="dial-readout">
        <span>{readout || " "}</span>
        {readout && <button className="bksp" onClick={() => setReadout(readout.slice(0, -1))}>⌫</button>}
      </div>
      <div className="keypad">
        {KEYS.map((k) => (
          <button key={k.d} className="key" onClick={() => onKey(k.d)}>
            <span className="kd">{k.d}</span>
            {k.sub && <span className="ks">{k.sub}</span>}
          </button>
        ))}
      </div>
      <div className="call-fab-row">
        <button className="fab call" disabled={!canCall || !readout.trim()} onClick={onCall} title="Call">
          ✆
        </button>
      </div>
    </div>
  );
}

function dirIcon(e: LogEntry): string {
  if (e.direction === "out") return "↗";
  return e.outcome === "answered" ? "↙" : "↙"; // inbound
}

function RecentsScreen({ log, onRedial }: { log: LogEntry[]; onRedial: (p: string) => void }) {
  const [q, setQ] = useState("");
  const filtered = q.trim() ? log.filter((e) => e.peer.toLowerCase().includes(q.trim().toLowerCase())) : log;
  const groups = groupLog(filtered);
  return (
    <div className="recents">
      <div className="search">
        <span className="mag">🔍</span>
        <input placeholder="Search calls" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.length === 0 ? (
        <Placeholder icon="🕘" title="No calls yet" text="Your recent calls will appear here." />
      ) : (
        groups.map((g) => (
          <div key={g.label} className="rgroup">
            <div className="rlabel">{g.label}</div>
            {g.items.map((e) => {
              const missed = e.outcome === "missed" || e.outcome === "rejected";
              return (
                <button key={e.id} className="rrow" onClick={() => onRedial(e.peer)}>
                  <span className={`rdir ${missed ? "missed" : e.direction}`}>{dirIcon(e)}</span>
                  <span className="rmain">
                    <span className={`rname ${missed ? "missed" : ""}`}>{e.peer || "Unknown"}</span>
                    <span className="rsub">
                      {cap(e.outcome)} · {fmtTime(e.at)}
                      {e.outcome === "answered" ? ` · ${fmtDur(e.durationSec)}` : ""}
                    </span>
                  </span>
                  <span className="rinfo">ⓘ</span>
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function IncomingScreen({
  peer, onAnswer, onDecline, onGear, state,
}: {
  peer: string; onAnswer: () => void; onDecline: () => void; onGear: () => void; state: PhoneState;
}) {
  return (
    <>
      <Header title="Incoming Call" state={state} onGear={onGear} />
      <div className="callview">
        <div className="avatar">👤</div>
        <div className="cname">{peer || "Unknown"}</div>
        <div className="cnum">{peer}</div>
        <div className="incoming-pill">● INCOMING CALL</div>
        <div className="swipe">Tap to answer</div>
        <div className="call-actions">
          <button className="fab hangup" onClick={onDecline} title="Decline">✆</button>
          <button className="fab call" onClick={onAnswer} title="Answer">✆</button>
        </div>
      </div>
    </>
  );
}

function InCallScreen({
  peer, state, elapsed, muted, dtmfOpen, calls,
  onKey, toggleDtmf, onMute, onTransfer, onHangup, onAnswerWaiting, onRejectWaiting, onSwap, onGear,
}: {
  peer: string; state: PhoneState; elapsed: number; muted: boolean; dtmfOpen: boolean; calls: CallsSnapshot;
  onKey: (k: string) => void; toggleDtmf: () => void; onMute: () => void; onTransfer: () => void;
  onHangup: () => void; onAnswerWaiting: () => void; onRejectWaiting: () => void; onSwap: () => void; onGear: () => void;
}) {
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <>
      <Header title="SIP Connected" state={state} onGear={onGear} />
      <div className="callview">
        <div className="avatar">👤</div>
        <div className="cname">{peer || "Unknown"}</div>
        <div className="cnum">{state === "outgoing" ? "Calling…" : `${mm}:${ss}`}</div>

        {calls.waiting && (
          <div className="waiting-call">
            <span className="wc-label">Call waiting · {calls.waiting.peer}</span>
            <span className="wc-actions">
              <button className="wc-answer" onClick={onAnswerWaiting}>Answer &amp; hold</button>
              <button className="wc-reject" onClick={onRejectWaiting}>Reject</button>
            </span>
          </div>
        )}
        {calls.held && (
          <div className="held-chip">
            <span>On hold · {calls.held.peer}</span>
            <button className="pill-btn" onClick={onSwap}>⇄ Swap</button>
          </div>
        )}

        {dtmfOpen && (
          <div className="keypad small">
            {KEYS.map((k) => (
              <button key={k.d} className="key" onClick={() => onKey(k.d)}>
                <span className="kd">{k.d}</span>
              </button>
            ))}
          </div>
        )}

        <div className="incall-controls">
          <button className={`ctl ${muted ? "on" : ""}`} onClick={onMute}><span>🎙</span>{muted ? "Unmute" : "Mute"}</button>
          <button className={`ctl ${dtmfOpen ? "on" : ""}`} onClick={toggleDtmf}><span>⌗</span>Keypad</button>
          <button className="ctl" onClick={onTransfer} disabled={state !== "active"}><span>↗</span>Transfer</button>
        </div>
        <div className="call-actions single">
          <button className="fab hangup" onClick={onHangup} title="Hang up">✆</button>
        </div>
      </div>
    </>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: { key: Tab; icon: string; label: string }[] = [
    { key: "favorites", icon: "★", label: "Favorites" },
    { key: "recents", icon: "🕘", label: "Recents" },
    { key: "contacts", icon: "👤", label: "Contacts" },
    { key: "keypad", icon: "⡇⡇", label: "Keypad" },
    { key: "voicemail", icon: "✉", label: "Voicemail" },
  ];
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <button key={t.key} className={`tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)}>
          <span className="ticon">{t.icon}</span>
          <span className="tlabel">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function Placeholder({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="placeholder">
      <div className="ph-icon">{icon}</div>
      <div className="ph-title">{title}</div>
      <div className="ph-text">{text}</div>
    </div>
  );
}

function SettingsScreen({
  conn, set, pickTransport, missing, live, onConnect, onDisconnect, onClose,
}: {
  conn: Conn;
  set: <K extends keyof Conn>(k: K, v: Conn[K]) => void;
  pickTransport: (t: Transport) => void;
  missing: (keyof Conn)[];
  live: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const isWss = conn.transport === "wss";
  const showCert = conn.transport === "wss" || conn.transport === "tls";
  return (
    <div className="settings">
      <div className="settings-head">
        <img className="wordmark dark" src={logo} alt="XeloVoice" />
        {live && <button className="pill-btn" onClick={onClose}>Close</button>}
      </div>

      <div className="field">
        <label>Transport</label>
        <div className="transport-seg">
          {TRANSPORTS.map((t) => (
            <button key={t} className={conn.transport === t ? "on" : ""} onClick={() => pickTransport(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="field"><label>Extension</label>
        <input value={conn.extension} onChange={(e) => set("extension", e.target.value.trim())} placeholder="1001" /></div>
      <div className="field"><label>Password</label>
        <input type="password" value={conn.password} onChange={(e) => set("password", e.target.value)} placeholder="SIP secret" /></div>
      <div className="field"><label>Display name (optional)</label>
        <input value={conn.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Jane Doe" /></div>
      <div className="field"><label>Server / SIP domain</label>
        <input value={conn.server} onChange={(e) => set("server", e.target.value.trim())} placeholder="pbx.example.com" /></div>

      {isWss ? (
        <>
          <div className="field"><label>WSS port</label>
            <input value={conn.wssPort} onChange={(e) => set("wssPort", e.target.value.trim())} placeholder="8089" /></div>
          <div className="field"><label>WSS URL override (optional)</label>
            <input value={conn.wssUrl} onChange={(e) => set("wssUrl", e.target.value.trim())} placeholder="wss://pbx.example.com/asterisk-ws" /></div>
          <div className="field"><label>STUN URLs (optional)</label>
            <input value={conn.stunUrls} onChange={(e) => set("stunUrls", e.target.value)} placeholder="stun:pbx.example.com:3478" /></div>
          <div className="field"><label>TURN URLs (optional)</label>
            <input value={conn.turnUrls} onChange={(e) => set("turnUrls", e.target.value)} placeholder="turn:pbx.example.com:3478?transport=udp" /></div>
          {csv(conn.turnUrls).length > 0 && (
            <div className="field" style={{ flexDirection: "row", gap: 6 }}>
              <input style={{ flex: 1 }} value={conn.turnUser} onChange={(e) => set("turnUser", e.target.value)} placeholder="TURN user" />
              <input style={{ flex: 1 }} value={conn.turnPass} onChange={(e) => set("turnPass", e.target.value)} placeholder="TURN pass" />
            </div>
          )}
        </>
      ) : (
        <div className="field"><label>Port</label>
          <input value={conn.port} onChange={(e) => set("port", e.target.value.trim())} placeholder={defaultPort(conn.transport)} /></div>
      )}

      {showCert && (
        <div className="field checkbox">
          <input id="cert" type="checkbox" checked={conn.ignoreCertErrors} onChange={(e) => set("ignoreCertErrors", e.target.checked)} />
          <label htmlFor="cert">Accept self-signed certificate</label>
        </div>
      )}
      <div className="field"><label>Console URL for analytics (optional)</label>
        <input value={conn.consoleUrl} onChange={(e) => set("consoleUrl", e.target.value.trim())} placeholder={conn.server ? `https://${conn.server}` : "https://pbx.example.com"} /></div>

      {live ? (
        <button className="btn danger" onClick={onDisconnect}>Disconnect</button>
      ) : (
        <button className="btn" onClick={onConnect} disabled={missing.length > 0}>
          {missing.length > 0 ? `Fill: ${missing.join(", ")}` : "Connect"}
        </button>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
