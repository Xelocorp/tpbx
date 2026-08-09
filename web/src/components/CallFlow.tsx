import { useEffect, useState } from "react";
import type { Channel } from "../api";

// A call is one or two bridged channel legs presented as a single flow:
// originator -> PBX -> destination.
export interface CallNode {
  kind: "ext" | "external" | "unknown";
  label: string; // primary identifier (extension number or external number)
  sub: string; // secondary (caller name / trunk)
}
export interface Call {
  id: string;
  hangupId: string; // a leg id to hang up (tears down the whole call)
  from: CallNode;
  to: CallNode;
  state: string;
  since: string; // ISO creationtime of the originating leg
}

// parsePeer pulls the endpoint/trunk name out of a channel name such as
// "PJSIP/1001-0000005a" -> "1001".
function parsePeer(name: string): string {
  const m = name.match(/\/(.+)-[^-]+$/);
  return m ? m[1] : name;
}

function classify(peer: string, num: string, trunks: Set<string>): CallNode["kind"] {
  if (trunks.has(peer)) return "external";
  // A short, all-digit peer is an internal extension; anything else external.
  if (/^\d{1,6}$/.test(peer)) return "ext";
  if (num && !/^\d{1,6}$/.test(num)) return "external";
  return "ext";
}

function nodeFromLeg(leg: Channel, trunks: Set<string>): CallNode {
  const peer = parsePeer(leg.name);
  const kind = classify(peer, leg.connected?.number || leg.caller?.number || "", trunks);
  if (kind === "external") {
    return {
      kind,
      label: leg.connected?.number || leg.caller?.number || peer,
      sub: trunks.has(peer) ? peer : "external",
    };
  }
  return { kind, label: peer, sub: leg.caller?.name || "" };
}

// groupCalls pairs reciprocal legs (A.caller == B.connected && vice-versa) into
// single calls, ordering each pair by creation time so the originator is first.
export function groupCalls(channels: Channel[], trunks: Set<string>): Call[] {
  const used = new Set<string>();
  const calls: Call[] = [];
  for (const c of channels) {
    if (used.has(c.id)) continue;
    const mate = channels.find(
      (o) =>
        o.id !== c.id &&
        !used.has(o.id) &&
        o.caller?.number === c.connected?.number &&
        o.connected?.number === c.caller?.number
    );
    used.add(c.id);
    if (mate) used.add(mate.id);

    const legs = (mate ? [c, mate] : [c]).sort((a, b) =>
      (a.creationtime || "").localeCompare(b.creationtime || "")
    );
    const src = legs[0];
    const dst = legs[1];
    const from = nodeFromLeg(src, trunks);
    const to = dst
      ? nodeFromLeg(dst, trunks)
      : ({
          kind: /^\d{1,6}$/.test(src.connected?.number || "") ? "ext" : "external",
          label: src.connected?.number || "…",
          sub: "",
        } as CallNode);

    calls.push({ id: src.id, hangupId: src.id, from, to, state: src.state, since: src.creationtime });
  }
  return calls;
}

function elapsed(sinceISO: string, now: number): string {
  const start = Date.parse(sinceISO);
  if (!start) return "";
  const s = Math.max(0, Math.floor((now - start) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function CallFlow({ call, onHangup }: { call: Call; onHangup: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ringing = call.state !== "Up";

  return (
    <div className="callflow">
      <Party node={call.from} />
      <Connector active={!ringing} />
      <div className="cf-node cf-pbx">
        <ServerIcon />
        <div className="cf-label">PBX</div>
        <div className="cf-sub">{ringing ? "ringing…" : elapsed(call.since, now)}</div>
      </div>
      <Connector active={!ringing} />
      <Party node={call.to} />
      <button className="btn danger cf-hangup" onClick={onHangup}>
        Hangup
      </button>
    </div>
  );
}

function Party({ node }: { node: CallNode }) {
  return (
    <div className="cf-node">
      {node.kind === "external" ? <MobileIcon /> : <PhoneIcon />}
      <div className="cf-label">{node.label}</div>
      <div className="cf-sub">
        {node.kind === "external" ? node.sub || "external" : node.sub || "extension"}
      </div>
    </div>
  );
}

function Connector({ active }: { active: boolean }) {
  return (
    <div className={`cf-conn ${active ? "live" : ""}`}>
      <span className="cf-dot" />
    </div>
  );
}

/* --- inline icons (stroke = currentColor) --- */
function PhoneIcon() {
  return (
    <svg className="cf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
      <line x1="9" y1="18.5" x2="15" y2="18.5" />
    </svg>
  );
}
function MobileIcon() {
  return (
    <svg className="cf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="6.5" y="2" width="11" height="20" rx="2.5" />
      <line x1="10.5" y1="19" x2="13.5" y2="19" />
    </svg>
  );
}
function ServerIcon() {
  return (
    <svg className="cf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <line x1="6.5" y1="7.5" x2="6.6" y2="7.5" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="6.5" y1="16.5" x2="6.6" y2="16.5" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
