import { useEffect, useRef, useState } from "react";
import type { Cmd, Snapshot } from "../proto";
import { wext } from "../wext";

const DIALPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
const LABEL: Record<string, string> = {
  offline: "Offline",
  connecting: "Connecting…",
  registered: "Ready",
  incoming: "Incoming call",
  outgoing: "Calling…",
  active: "In call",
  failed: "Connection failed",
};

function send(cmd: Cmd): void {
  try {
    const p = wext.runtime.sendMessage(cmd);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* engine not up yet */
  }
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function Popup() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [dial, setDial] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [target, setTarget] = useState("");
  const [seconds, setSeconds] = useState(0);
  const prevState = useRef("");

  useEffect(() => {
    const onMsg = (ev: { t?: string; snap?: Snapshot }) => {
      if (ev && ev.t === "snapshot" && ev.snap) setSnap(ev.snap);
    };
    wext.runtime.onMessage.addListener(onMsg);
    send({ t: "sync" });
    return () => wext.runtime.onMessage.removeListener(onMsg);
  }, []);

  const state = snap?.state ?? "offline";
  useEffect(() => {
    if (state !== prevState.current) {
      prevState.current = state;
      if (state !== "active") setSeconds(0);
      if (state === "registered") setTransferring(false);
    }
    if (state !== "active") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  if (!snap) {
    return <div className="phone" style={{ minHeight: 120 }} />;
  }

  if (!snap.configured) {
    return (
      <div className="phone">
        <div className="login-brand">
          <h1>XeloVoice</h1>
          <div className="login-sub">Softphone</div>
        </div>
        <p className="hint-inline" style={{ textAlign: "center" }}>
          Not set up yet. Enter your server and extension to sign in.
        </p>
        <button className="btn" onClick={() => wext.runtime.openOptionsPage()}>
          Set up
        </button>
      </div>
    );
  }

  const inCall = state === "active" || state === "outgoing";
  const press = (k: string) => {
    if (state === "active") send({ t: "dtmf", tone: k });
    setDial((d) => d + k);
  };

  // The background engine can't show a mic prompt; granting it here (a visible
  // context) authorises the whole extension so the engine can capture audio.
  const ensureMic = async (): Promise<void> => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      /* denied — the engine will surface the resulting call error */
    }
  };
  const callNow = async () => {
    if (!dial) return;
    await ensureMic();
    send({ t: "call", target: dial });
  };
  const answerNow = async () => {
    await ensureMic();
    send({ t: "answer" });
  };

  return (
    <div className="phone">
      <div className="phone-top">
        <div className="phone-id">
          <strong>{snap.displayName}</strong>
          <span>ext {snap.extension}</span>
        </div>
        <div className="phone-top-right">
          <span className={`status-pill ${state}`}>
            <span className="status-dot" />
            {LABEL[state] ?? state}
          </span>
          <button
            className={`dnd-toggle ${snap.dnd ? "on" : ""}`}
            onClick={() => send({ t: "dnd", on: !snap.dnd })}
          >
            DND
          </button>
        </div>
      </div>

      {snap.recording && (
        <div className="rec-bar">
          <span className="rec-dot" /> Recording
        </div>
      )}
      {snap.error && (
        <div className="phone-error">
          {snap.error}
          {/(microphone|not allowed|permission|NotAllowed)/i.test(snap.error) && (
            <button
              className="btn ghost small"
              style={{ marginTop: 6 }}
              onClick={ensureMic}
            >
              Enable microphone
            </button>
          )}
        </div>
      )}

      <div className="phone-display">
        {transferring ? (
          <input
            className="dial-input"
            autoFocus
            value={target}
            placeholder="Transfer to…"
            onChange={(e) => setTarget(e.target.value.replace(/[^0-9*#+]/g, ""))}
          />
        ) : state === "active" ? (
          <>
            <div className="call-peer">{snap.detail || "connected"}</div>
            <div className="call-timer">{fmt(seconds)}</div>
          </>
        ) : state === "outgoing" ? (
          <>
            <div className="call-peer">{snap.detail}</div>
            <div className="call-timer">calling…</div>
          </>
        ) : (
          <input
            className="dial-input"
            value={dial}
            placeholder="Enter number"
            onChange={(e) => setDial(e.target.value.replace(/[^0-9*#+]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && dial && void callNow()}
          />
        )}
      </div>

      {!transferring && (
        <div className="dialpad">
          {DIALPAD.map((k) => (
            <button key={k} className="key" onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>
      )}

      {transferring ? (
        <div className="phone-actions">
          <button className="btn round" onClick={() => setTransferring(false)}>
            Cancel
          </button>
          <button
            className="btn round call"
            disabled={!target}
            onClick={() => {
              send({ t: "transfer", target });
              setTransferring(false);
              setTarget("");
            }}
          >
            Transfer
          </button>
        </div>
      ) : inCall ? (
        <>
          <div className="phone-actions">
            <button
              className={`btn round ${snap.muted ? "muted" : ""}`}
              disabled={state !== "active"}
              onClick={() => send({ t: "mute", on: !snap.muted })}
            >
              {snap.muted ? "Unmute" : "Mute"}
            </button>
            <button
              className={`btn round ${snap.speaker ? "" : "muted"}`}
              disabled={state !== "active"}
              onClick={() => send({ t: "speaker", on: !snap.speaker })}
            >
              {snap.speaker ? "Speaker" : "Spk off"}
            </button>
            <button
              className="btn round"
              disabled={state !== "active"}
              onClick={() => setTransferring(true)}
            >
              Transfer
            </button>
            <button
              className={`btn round ${snap.recording ? "recording" : ""}`}
              disabled={state !== "active"}
              onClick={() => send({ t: "rec", on: !snap.recording })}
            >
              {snap.recording ? "Stop Rec" : "Record"}
            </button>
          </div>
          <button className="btn round hangup wide" onClick={() => send({ t: "hangup" })}>
            End
          </button>
        </>
      ) : state === "incoming" ? (
        <div className="phone-actions">
          <button className="btn round hangup" onClick={() => send({ t: "reject" })}>
            Decline
          </button>
          <button className="btn round call" onClick={answerNow}>
            Answer
          </button>
        </div>
      ) : (
        <div className="phone-actions">
          <button className="btn round" onClick={() => setDial((d) => d.slice(0, -1))}>
            ⌫
          </button>
          <button
            className="btn round call"
            disabled={state !== "registered" || !dial}
            onClick={callNow}
          >
            Call
          </button>
          <button className="btn round" onClick={() => setDial("")}>
            Clear
          </button>
        </div>
      )}

      {snap.log.length > 0 && (
        <div className="call-log">
          <div className="call-log-head">
            <span>Recent</span>
            <button className="call-log-clear" onClick={() => send({ t: "clearlog" })}>
              Clear
            </button>
          </div>
          <ul>
            {snap.log.slice(0, 20).map((e, i) => {
              const missed = e.direction === "in" && !e.answered;
              const kind = missed ? "missed" : e.direction;
              return (
                <li
                  key={`${e.at}-${i}`}
                  className={`log-entry ${kind}`}
                  onClick={() => setDial(e.peer)}
                >
                  <span className={`log-icon ${kind}`}>
                    {missed ? "✕" : e.direction === "in" ? "↙" : "↗"}
                  </span>
                  <span className="log-peer">{e.peer}</span>
                  <span className="log-meta">
                    {e.answered ? fmt(e.durationSec) : missed ? "missed" : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <button className="phone-logout" onClick={() => wext.runtime.openOptionsPage()}>
        Settings
      </button>
    </div>
  );
}
