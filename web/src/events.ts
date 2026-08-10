// Human-friendly formatting for the live event stream. Raw ARI/AMI events are
// noisy and cryptic; describeEvent turns the ones worth showing into a short,
// scannable line with a category so the ticker reads at a glance.
import type { WsEnvelope } from "./api";

export type EventCategory = "call" | "device" | "system";

export interface TickerLine {
  id: number;
  category: EventCategory;
  text: string;
  time: string; // HH:MM:SS
}

export function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour12: false });
}

// shortChan turns "PJSIP/1001-0000005a" into "1001" (the peer), leaving other
// shapes mostly intact.
function shortChan(name?: string): string {
  if (!name) return "";
  const m = name.match(/\/(.+?)-[^-]+$/);
  return m ? m[1] : name.replace(/^PJSIP\//, "");
}

// humanize turns "ChannelStateChange" / "PeerStatus" into "Channel state
// change" / "Peer status" for events we don't specifically format.
function humanize(s: string): string {
  const words = s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function lc(s: unknown): string {
  return String(s ?? "").toLowerCase();
}

// describeEvent returns a friendly {category, text} for the ticker, or null to
// hide the event entirely (pure noise).
export function describeEvent(env: WsEnvelope): { category: EventCategory; text: string } | null {
  if (env.kind === "ami") return describeAMI((env.data ?? {}) as Record<string, unknown>);
  if (env.kind === "ari") return describeARI((env.data ?? {}) as Record<string, unknown>);
  return null;
}

function describeAMI(d: Record<string, unknown>): { category: EventCategory; text: string } | null {
  const ev = String(d.Event ?? "");
  const chan = shortChan(d.Channel as string);
  const cid = (d.CallerIDNum as string) || (d.CallerIDName as string) || chan;
  switch (ev) {
    case "Newchannel":
      return { category: "call", text: `New call from ${cid || "unknown"}` };
    case "Newstate":
      return { category: "call", text: `${chan}: ${d.ChannelStateDesc || d.ChannelState}` };
    case "DialBegin":
      return {
        category: "call",
        text: `${cid} → ${d.DestExten || shortChan(d.DestChannel as string) || "…"} (ringing)`,
      };
    case "DialEnd":
      return { category: "call", text: `Call ${lc(d.DialStatus)} — ${cid}` };
    case "BridgeEnter":
      return { category: "call", text: `${chan} connected` };
    case "Hangup": {
      const cause = (d.CauseTxt as string) || "";
      return { category: "call", text: `Hangup ${chan}${cause ? ` — ${cause}` : ""}` };
    }
    case "PeerStatus":
      return {
        category: "device",
        text: `Extension ${shortChan(d.Peer as string)} ${lc(d.PeerStatus)}`,
      };
    case "ContactStatus":
      return {
        category: "device",
        text: `Device ${d.AOR || shortChan(d.URI as string)} ${lc(d.ContactStatus)}`,
      };
    case "Registry":
      return {
        category: "device",
        text: `Trunk ${d.Username || d.Domain || ""} ${lc(d.Status)}`,
      };
    case "FullyBooted":
      return { category: "system", text: "System ready" };
    case "Reload":
      return { category: "system", text: "Configuration reloaded" };
    // Pure noise we never want to surface.
    case "TestEvent":
    case "VarSet":
    case "Newexten":
    case "RTCPSent":
    case "RTCPReceived":
      return null;
    default:
      return { category: "system", text: humanize(ev) };
  }
}

interface AriChannel {
  name?: string;
  state?: string;
  caller?: { number?: string };
}
function describeARI(d: Record<string, unknown>): { category: EventCategory; text: string } | null {
  const type = String(d.type ?? "");
  let raw: Record<string, unknown> = {};
  try {
    raw = typeof d.raw === "string" ? JSON.parse(d.raw) : ((d.raw as Record<string, unknown>) ?? {});
  } catch {
    raw = {};
  }
  const ch = (raw.channel as AriChannel) || {};
  const name = shortChan(ch.name);
  const cid = ch.caller?.number || name;
  switch (type) {
    case "ChannelCreated":
      return { category: "call", text: `New call from ${cid || "unknown"}` };
    case "ChannelStateChange":
      return { category: "call", text: `${name}: ${ch.state}` };
    case "ChannelDestroyed": {
      const cause = (raw.cause_txt as string) || "";
      return { category: "call", text: `Call ended ${name}${cause ? ` — ${cause}` : ""}` };
    }
    case "Dial": {
      const peer = shortChan((raw.peer as AriChannel)?.name) || (raw.dialstring as string) || "…";
      return { category: "call", text: `${cid} → ${peer} (ringing)` };
    }
    case "ChannelHangupRequest":
      return { category: "call", text: `${name} hanging up` };
    case "EndpointStateChange": {
      const ep = raw.endpoint as { resource?: string; state?: string } | undefined;
      return { category: "device", text: `Endpoint ${ep?.resource ?? ""} ${lc(ep?.state)}` };
    }
    case "DeviceStateChanged": {
      const ds = raw.device_state as { name?: string; state?: string } | undefined;
      return { category: "device", text: `${ds?.name ?? ""} ${lc(ds?.state)}` };
    }
    // Chatty duplicates of the above; hide them.
    case "StasisStart":
    case "StasisEnd":
    case "ChannelVarset":
    case "ChannelDialplan":
      return null;
    default:
      return { category: "system", text: humanize(type) };
  }
}
