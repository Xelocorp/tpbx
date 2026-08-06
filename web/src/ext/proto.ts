// Message protocol between the popup UI and the background SIP engine.
//
// The engine (Chrome offscreen document / Firefox background page) owns the SIP
// connection and authoritative state; the popup is a thin, stateless view. The
// popup sends Cmd messages; the engine broadcasts a full Snapshot after every
// change so the popup can render without tracking state itself.

import type { CallLogEntry, PhoneState } from "../agent/sip";

export type Cmd =
  | { t: "sync" } // popup opened -> please broadcast a snapshot
  | { t: "initlog"; log: CallLogEntry[] } // host seeds the persisted log (Chrome path)
  | { t: "login"; server: string; extension: string; password: string }
  | { t: "logout" }
  | { t: "call"; target: string }
  | { t: "answer" }
  | { t: "reject" }
  | { t: "hangup" }
  | { t: "dtmf"; tone: string }
  | { t: "mute"; on: boolean }
  | { t: "speaker"; on: boolean }
  | { t: "dnd"; on: boolean }
  | { t: "transfer"; target: string }
  | { t: "rec"; on: boolean }
  | { t: "clearlog" };

export interface Snapshot {
  configured: boolean; // stored credentials present
  state: PhoneState;
  detail: string;
  extension: string;
  displayName: string;
  incoming: string | null;
  muted: boolean;
  speaker: boolean;
  dnd: boolean;
  recording: boolean;
  error: string;
  log: CallLogEntry[];
}

export type Evt =
  | { t: "snapshot"; snap: Snapshot }
  | { t: "ready" } // engine came up in a context without storage -> host, send config
  | { t: "incoming"; from: string } // for the notifier (SW / background)
  | { t: "callcleared" } // dismiss any incoming notification
  | { t: "download"; url: string; name: string }; // recording -> downloads API

export const STORAGE_KEY = "tpbx.ext.config";
export const LOG_KEY = "tpbx.ext.log";
