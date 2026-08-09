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
  fromId: string; // channel id of the originating leg (for RTP lookup)
  toId: string; // channel id of the destination leg ("" if single-leg)
  from: CallNode;
  to: CallNode;
  state: string;
  since: string; // ISO creationtime of the originating leg
}

// AudioFlow is the derived RTP direction for a channel leg over the last poll.
export interface AudioFlow {
  known: boolean; // Asterisk actually reported RTP counters for this leg
  sending: boolean; // peer is putting audio into the PBX
  receiving: boolean; // PBX is delivering audio to the peer
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

    calls.push({
      id: src.id,
      hangupId: src.id,
      fromId: src.id,
      toId: dst ? dst.id : "",
      from,
      to,
      state: src.state,
      since: src.creationtime,
    });
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

export function CallFlow({
  call,
  audio,
  onHangup,
}: {
  call: Call;
  audio?: Record<string, AudioFlow>;
  onHangup: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ringing = call.state !== "Up";
  const fromA = call.fromId ? audio?.[call.fromId] : undefined;
  const toA = call.toId ? audio?.[call.toId] : undefined;

  return (
    <div className="callflow">
      <Party node={call.from} audio={fromA} />
      {/* left->right voice = the "from" party sending in */}
      <Connector
        active={!ringing}
        known={!!fromA?.known}
        forward={fromA?.sending}
        back={fromA?.receiving}
      />
      <div className="cf-node cf-pbx">
        <ServerIcon />
        <div className="cf-label">PBX</div>
        <div className="cf-sub">{ringing ? "ringing…" : elapsed(call.since, now)}</div>
      </div>
      <Connector
        active={!ringing}
        known={!!toA?.known}
        forward={toA?.receiving}
        back={toA?.sending}
      />
      <Party node={call.to} audio={toA} />
      <button className="btn danger cf-hangup" onClick={onHangup}>
        Hangup
      </button>
    </div>
  );
}

function Party({ node, audio }: { node: CallNode; audio?: AudioFlow }) {
  return (
    <div className="cf-node">
      {node.kind === "external" ? <MobileIcon /> : <PhoneIcon />}
      <div className="cf-label">{node.label}</div>
      <div className="cf-sub">
        {node.kind === "external" ? node.sub || "external" : node.sub || "extension"}
      </div>
      {audio?.known && (
        <div className="cf-audio">
          <span
            className={`cf-tag ${audio.sending ? "on" : "off"}`}
            title="Is this party's audio (microphone) reaching the PBX?"
          >
            {audio.sending ? "▲ voice" : "▲ no audio"}
          </span>
        </div>
      )}
    </div>
  );
}

function Connector({
  active,
  known,
  forward,
  back,
}: {
  active: boolean;
  known?: boolean;
  forward?: boolean;
  back?: boolean;
}) {
  // When the call is up but we couldn't measure RTP direction, still show a
  // neutral "media flowing" animation both ways so the link never looks dead;
  // once direction is known we render the precise forward/back dots instead.
  const neutral = active && !known;
  return (
    <div className={`cf-conn ${active ? "live" : ""} ${neutral ? "flow" : ""}`}>
      {neutral ? (
        <>
          <span className="cf-dot fwd neutral" />
          <span className="cf-dot fwd neutral d2" />
          <span className="cf-dot bwd neutral" />
          <span className="cf-dot bwd neutral d2" />
        </>
      ) : (
        <>
          {forward && <span className="cf-dot fwd" />}
          {back && <span className="cf-dot bwd" />}
        </>
      )}
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
