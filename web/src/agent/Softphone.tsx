import { useCallback, useEffect, useRef, useState } from "react";
import { agentConfig, agentLogin, agentLogout, type AgentConfig } from "./api";
import { Softphone as SipPhone, type PhoneState } from "./sip";

const DIALPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

const STATE_LABEL: Record<PhoneState, string> = {
  offline: "Offline",
  connecting: "Connecting…",
  registered: "Ready",
  incoming: "Incoming call",
  outgoing: "Calling…",
  active: "In call",
  failed: "Connection failed",
};

export default function Softphone() {
  const [booting, setBooting] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [state, setState] = useState<PhoneState>("offline");
  const [detail, setDetail] = useState("");
  const [incoming, setIncoming] = useState<string | null>(null);
  const [error, setError] = useState("");

  const [dial, setDial] = useState("");
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const phoneRef = useRef<SipPhone | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedRef = useRef(false);

  // Call timer: runs only while a call is active.
  useEffect(() => {
    if (state !== "active") {
      setSeconds(0);
      return;
    }
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const startPhone = useCallback((config: AgentConfig) => {
    if (startedRef.current || !audioRef.current) return;
    startedRef.current = true;
    const phone = new SipPhone(
      {
        wsUrl: config.wsUrl,
        domain: config.domain,
        extension: config.extension,
        password: config.password,
        displayName: config.displayName,
        iceServers: config.iceServers,
      },
      {
        onState: (s, d) => {
          setState(s);
          setDetail(d ?? "");
          if (s !== "incoming") setIncoming(null);
          if (s === "registered" || s === "offline") setMuted(false);
        },
        onIncoming: (from) => setIncoming(from),
        onError: (msg) => setError(msg),
      },
      audioRef.current
    );
    phoneRef.current = phone;
    void phone.start();
  }, []);

  // On load, see if we already have a session (cookie) and boot the phone;
  // otherwise fall back to the login screen.
  useEffect(() => {
    agentConfig()
      .then((config) => {
        setCfg(config);
        setNeedLogin(false);
      })
      .catch(() => setNeedLogin(true))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (cfg) startPhone(cfg);
  }, [cfg, startPhone]);

  useEffect(() => {
    return () => {
      void phoneRef.current?.stop();
      phoneRef.current = null;
      startedRef.current = false;
    };
  }, []);

  const doLogin = async (extension: string, password: string) => {
    setError("");
    await agentLogin(extension, password);
    const config = await agentConfig();
    setCfg(config);
    setNeedLogin(false);
  };

  const doLogout = async () => {
    await phoneRef.current?.stop();
    phoneRef.current = null;
    startedRef.current = false;
    await agentLogout();
    setCfg(null);
    setNeedLogin(true);
    setState("offline");
  };

  const press = (key: string) => {
    if (state === "active") {
      phoneRef.current?.sendDtmf(key);
      setDial((d) => d + key);
    } else {
      setDial((d) => d + key);
    }
  };

  const placeCall = () => {
    if (!dial) return;
    setError("");
    void phoneRef.current?.call(dial.trim());
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    phoneRef.current?.setMuted(next);
  };

  const inCall = state === "active" || state === "outgoing";

  if (booting) {
    return <div className="phone-shell login-screen" />;
  }

  return (
    <div className="phone-shell">
      <audio ref={audioRef} autoPlay />
      {needLogin ? (
        <LoginCard onLogin={doLogin} error={error} />
      ) : (
        <div className="phone">
          <div className="phone-top">
            <div className="phone-id">
              <strong>{cfg?.displayName}</strong>
              <span>ext {cfg?.extension}</span>
            </div>
            <span className={`status-pill ${state}`}>
              <span className="status-dot" />
              {STATE_LABEL[state]}
            </span>
          </div>

          {error && <div className="phone-error">{error}</div>}

          <div className="phone-display">
            {state === "active" ? (
              <>
                <div className="call-peer">{detail || "connected"}</div>
                <div className="call-timer">{fmtTime(seconds)}</div>
              </>
            ) : state === "outgoing" ? (
              <>
                <div className="call-peer">{detail}</div>
                <div className="call-timer">calling…</div>
              </>
            ) : (
              <input
                className="dial-input"
                value={dial}
                placeholder="Enter number"
                onChange={(e) => setDial(e.target.value.replace(/[^0-9*#+]/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && placeCall()}
              />
            )}
          </div>

          <div className="dialpad">
            {DIALPAD.map((k) => (
              <button key={k} className="key" onClick={() => press(k)}>
                {k}
              </button>
            ))}
          </div>

          <div className="phone-actions">
            {inCall ? (
              <>
                <button
                  className={`btn round ${muted ? "muted" : ""}`}
                  onClick={toggleMute}
                  disabled={state !== "active"}
                >
                  {muted ? "Unmute" : "Mute"}
                </button>
                <button className="btn round hangup" onClick={() => phoneRef.current?.hangup()}>
                  End
                </button>
                <button
                  className="btn round"
                  onClick={() => setDial("")}
                  disabled={state === "active"}
                >
                  Clear
                </button>
              </>
            ) : (
              <>
                <button className="btn round" onClick={() => setDial((d) => d.slice(0, -1))}>
                  ⌫
                </button>
                <button
                  className="btn round call"
                  onClick={placeCall}
                  disabled={state !== "registered" || !dial}
                >
                  Call
                </button>
                <button className="btn round" onClick={() => setDial("")}>
                  Clear
                </button>
              </>
            )}
          </div>

          <button className="phone-logout" onClick={doLogout}>
            Sign out
          </button>
        </div>
      )}

      {incoming && (
        <div className="incoming-overlay">
          <div className="incoming-card">
            <div className="incoming-label">Incoming call</div>
            <div className="incoming-from">{incoming}</div>
            <div className="incoming-actions">
              <button
                className="btn round hangup"
                onClick={() => phoneRef.current?.reject()}
              >
                Decline
              </button>
              <button
                className="btn round call"
                onClick={() => phoneRef.current?.answer()}
              >
                Answer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LoginCard({
  onLogin,
  error,
}: {
  onLogin: (extension: string, password: string) => Promise<void>;
  error: string;
}) {
  const [extension, setExtension] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalErr("");
    try {
      await onLogin(extension.trim(), password);
    } catch (err) {
      setLocalErr((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login-card" onSubmit={submit}>
      <div className="login-brand">
        <h1>TPBX</h1>
        <div className="login-sub">Softphone</div>
      </div>
      <label>
        Extension
        <input
          value={extension}
          autoFocus
          placeholder="1001"
          onChange={(e) => setExtension(e.target.value)}
        />
      </label>
      <label>
        SIP password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {(localErr || error) && <div className="login-error">{localErr || error}</div>}
      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
