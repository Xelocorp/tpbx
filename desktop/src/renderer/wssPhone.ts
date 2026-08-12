// WSS / WebRTC softphone for the renderer, built on SIP.js. Primary path:
// registration, inbound/outbound calls, DTMF, mute, blind transfer, STUN/TURN,
// and CALL WAITING — a second call is presented (not rejected) while one is
// active, and the agent can hold the current call, answer the second, and swap.

import {
  Inviter,
  Invitation,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  Web,
  type Session,
} from "sip.js";

export type PhoneState =
  | "offline"
  | "connecting"
  | "registered"
  | "incoming"
  | "outgoing"
  | "active"
  | "failed";

export interface WssConfig {
  wsUrl: string;
  domain: string;
  extension: string;
  password: string;
  displayName: string;
  iceServers: RTCIceServer[];
}

// CallEnded describes a finished call, for the call log / telemetry.
export interface CallEnded {
  direction: "in" | "out";
  peer: string;
  answered: boolean; // media was established
  declined: boolean; // the local user (or DND) actively rejected an incoming call
  durationSec: number; // talk time (0 if never answered)
}

// CallsSnapshot is the full multi-call state the UI renders (active + a held
// call + a ringing second call).
export interface CallsSnapshot {
  active?: { peer: string; state: "incoming" | "outgoing" | "active" };
  held?: { peer: string };
  waiting?: { peer: string };
}

export interface WssCallbacks {
  onState: (state: PhoneState, detail?: string) => void;
  onIncoming: (from: string) => void;
  onWaiting: (from: string) => void; // second call while already on a call
  onCalls: (s: CallsSnapshot) => void; // full multi-call snapshot
  onError: (message: string) => void;
  onCallEnded?: (e: CallEnded) => void;
}

interface CallMeta {
  dir: "in" | "out";
  peer: string;
  answeredAt: number;
  declined: boolean;
}

export class WssPhone {
  private ua?: UserAgent;
  private registerer?: Registerer;

  // Call slots: `active` is the in-focus call (ringing or established); `held`
  // is a second established call on hold; `incoming` / `waiting` are ringing
  // Invitations (first / second).
  private active?: Session;
  private held?: Session;
  private incoming?: Invitation;
  private waiting?: Invitation;
  private meta = new Map<Session, CallMeta>();

  private dnd = false;
  private reconnectTimer?: number;

  constructor(
    private cfg: WssConfig,
    private cb: WssCallbacks,
    private audio: HTMLAudioElement
  ) {}

  async start(): Promise<void> {
    this.cb.onState("connecting");
    const uri = UserAgent.makeURI(`sip:${this.cfg.extension}@${this.cfg.domain}`);
    if (!uri) {
      this.cb.onError("invalid SIP address");
      this.cb.onState("failed", "invalid SIP address");
      return;
    }

    this.ua = new UserAgent({
      uri,
      displayName: this.cfg.displayName,
      authorizationUsername: this.cfg.extension,
      authorizationPassword: this.cfg.password,
      transportOptions: { server: this.cfg.wsUrl },
      sessionDescriptionHandlerFactoryOptions: {
        iceGatheringTimeout: 3000,
        peerConnectionConfiguration: { iceServers: this.cfg.iceServers },
      },
      delegate: {
        onInvite: (invitation) => this.onInvite(invitation),
        onConnect: () => this.register(),
        onDisconnect: (err?: Error) => {
          this.cb.onState("connecting", "reconnecting");
          if (err) this.reconnect();
        },
      },
    });

    this.registerer = new Registerer(this.ua);
    this.registerer.stateChange.addListener((s) => {
      if (s === RegistererState.Registered) this.cb.onState("registered");
      else if (s === RegistererState.Unregistered && this.active === undefined) {
        this.cb.onState("connecting");
      }
    });

    try {
      await this.ua.start();
    } catch (e) {
      this.cb.onState("failed", (e as Error).message);
      this.cb.onError((e as Error).message);
    }
  }

  private register(): void {
    void this.registerer
      ?.register({
        requestDelegate: {
          onReject: (r) => {
            this.cb.onState("failed", `registration rejected (${r.message.statusCode})`);
            this.cb.onError(
              `registration rejected: ${r.message.reasonPhrase ?? r.message.statusCode}`
            );
          },
        },
      })
      .catch((e) => this.cb.onState("failed", (e as Error).message));
  }

  private reconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(async () => {
      try {
        await this.ua?.reconnect();
      } catch {
        this.reconnect();
      }
    }, 3000);
  }

  async call(target: string): Promise<void> {
    if (!this.ua || this.active) return; // one dialled call at a time
    const uri = UserAgent.makeURI(`sip:${target}@${this.cfg.domain}`);
    if (!uri) {
      this.cb.onError("invalid number");
      return;
    }
    const inviter = new Inviter(this.ua, uri, {
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.active = inviter;
    this.meta.set(inviter, { dir: "out", peer: target, answeredAt: 0, declined: false });
    this.wireSession(inviter, target);
    this.cb.onState("outgoing", target);
    this.emitCalls();
    try {
      await inviter.invite();
    } catch (e) {
      this.cb.onError((e as Error).message);
      this.cb.onState("registered");
    }
  }

  setDND(on: boolean): void {
    this.dnd = on;
  }

  private onInvite(invitation: Invitation): void {
    const from =
      invitation.remoteIdentity.displayName || invitation.remoteIdentity.uri.user || "unknown";
    if (this.dnd) {
      invitation.reject({ statusCode: 486 }); // Do Not Disturb
      this.cb.onCallEnded?.({ direction: "in", peer: from, answered: false, declined: true, durationSec: 0 });
      return;
    }
    // No active call -> this is the primary incoming call.
    if (!this.active) {
      this.incoming = invitation;
      this.active = invitation;
      this.meta.set(invitation, { dir: "in", peer: from, answeredAt: 0, declined: false });
      this.wireSession(invitation, from);
      this.cb.onIncoming(from);
      this.cb.onState("incoming", from);
      this.emitCalls();
      return;
    }
    // Active call is established and no other slot is taken -> CALL WAITING.
    if (this.active.state === SessionState.Established && !this.held && !this.waiting) {
      this.waiting = invitation;
      this.meta.set(invitation, { dir: "in", peer: from, answeredAt: 0, declined: false });
      this.wireSession(invitation, from);
      this.cb.onWaiting(from);
      this.emitCalls();
      return;
    }
    // Otherwise we are genuinely busy (already handling two calls).
    invitation.reject({ statusCode: 486 });
  }

  // answer accepts the primary ringing incoming call.
  async answer(): Promise<void> {
    if (!this.incoming) return;
    await this.incoming.accept({
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.incoming = undefined;
  }

  // answerWaiting puts the current active call on hold and answers the second
  // (waiting) call, which becomes the new active call.
  async answerWaiting(): Promise<void> {
    const w = this.waiting;
    if (!w) return;
    if (this.active && this.active.state === SessionState.Established) {
      await this.setHold(this.active, true);
      this.held = this.active;
    }
    this.waiting = undefined;
    this.active = w;
    try {
      await w.accept({
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
      });
    } catch (e) {
      this.cb.onError((e as Error).message);
    }
    this.emitCalls();
  }

  // rejectWaiting declines the second (waiting) call with Busy Here.
  rejectWaiting(): void {
    const w = this.waiting;
    if (!w) return;
    const m = this.meta.get(w);
    if (m) m.declined = true;
    this.waiting = undefined;
    w.reject({ statusCode: 486 });
    this.emitCalls();
  }

  // swap toggles which of two established calls is active; the other is held.
  async swap(): Promise<void> {
    if (!this.active || !this.held) return;
    const a = this.active;
    const h = this.held;
    await this.setHold(a, true);
    await this.setHold(h, false);
    this.active = h;
    this.held = a;
    this.attachRemoteAudio(this.active);
    const m = this.meta.get(this.active);
    this.cb.onState("active", m?.peer || "");
    this.emitCalls();
  }

  // hangup ends the active call. If a held call remains, it is resumed and
  // becomes active; otherwise we return to the registered state.
  hangup(): void {
    const s = this.active;
    if (!s) return;
    switch (s.state) {
      case SessionState.Initial:
      case SessionState.Establishing:
        if (s instanceof Inviter) {
          s.cancel();
        } else if (s instanceof Invitation) {
          const m = this.meta.get(s);
          if (m) m.declined = true;
          s.reject();
        }
        break;
      case SessionState.Established:
        void s.bye();
        break;
    }
  }

  async blindTransfer(target: string): Promise<void> {
    const s = this.active;
    if (!s || s.state !== SessionState.Established) return;
    const uri = UserAgent.makeURI(`sip:${target}@${this.cfg.domain}`);
    if (!uri) {
      this.cb.onError("invalid transfer target");
      return;
    }
    try {
      await s.refer(uri);
    } catch (e) {
      this.cb.onError((e as Error).message);
    }
  }

  sendDtmf(tone: string): void {
    const sdh = this.active?.sessionDescriptionHandler as
      | { sendDtmf?: (t: string) => boolean }
      | undefined;
    sdh?.sendDtmf?.(tone);
  }

  setMuted(muted: boolean): void {
    this.peerConnection(this.active)
      ?.getSenders()
      .forEach((sender) => {
        if (sender.track && sender.track.kind === "audio") sender.track.enabled = !muted;
      });
  }

  async stop(): Promise<void> {
    window.clearTimeout(this.reconnectTimer);
    if (this.held) void this.held.bye().catch(() => {});
    this.hangup();
    try {
      await this.registerer?.unregister();
    } catch {
      /* ignore */
    }
    try {
      await this.ua?.stop();
    } catch {
      /* ignore */
    }
    this.cb.onState("offline");
  }

  // setHold renegotiates a session to (un)hold via a re-INVITE.
  private async setHold(session: Session, hold: boolean): Promise<void> {
    try {
      await session.invite({
        sessionDescriptionHandlerModifiers: hold ? [Web.holdModifier] : [],
      });
    } catch (e) {
      this.cb.onError(`hold failed: ${(e as Error).message}`);
    }
  }

  private peerConnection(session?: Session): RTCPeerConnection | undefined {
    const sdh = session?.sessionDescriptionHandler as
      | { peerConnection?: RTCPeerConnection }
      | undefined;
    return sdh?.peerConnection;
  }

  private wireSession(session: Session, label: string): void {
    session.stateChange.addListener((state: SessionState) => {
      switch (state) {
        case SessionState.Established:
          if (session === this.active) {
            const m = this.meta.get(session);
            if (m) m.answeredAt = Date.now();
            this.attachRemoteAudio(session);
            this.cb.onState("active", label);
            this.emitCalls();
          }
          break;
        case SessionState.Terminated:
          this.onTerminated(session);
          break;
      }
    });
  }

  // onTerminated cleans up whichever slot the ended session occupied, emits the
  // call-ended record once, and promotes a held call to active if needed.
  private onTerminated(session: Session): void {
    this.emitEnded(session);

    if (session === this.waiting) {
      this.waiting = undefined;
      this.emitCalls();
      return;
    }
    if (session === this.held) {
      this.held = undefined;
      this.emitCalls();
      return;
    }
    // The active call ended.
    if (session === this.active) {
      this.incoming = undefined;
      if (this.held) {
        // Resume the held call.
        this.active = this.held;
        this.held = undefined;
        void this.setHold(this.active, false);
        this.attachRemoteAudio(this.active);
        const m = this.meta.get(this.active);
        this.cb.onState("active", m?.peer || "");
        this.emitCalls();
        return;
      }
      this.active = undefined;
      this.audio.srcObject = null;
      this.cb.onState("registered");
      this.emitCalls();
    }
  }

  private emitEnded(session: Session): void {
    const m = this.meta.get(session);
    if (!m) return;
    this.meta.delete(session);
    const answered = m.answeredAt > 0;
    this.cb.onCallEnded?.({
      direction: m.dir,
      peer: m.peer,
      answered,
      declined: m.declined,
      durationSec: answered ? Math.round((Date.now() - m.answeredAt) / 1000) : 0,
    });
  }

  private emitCalls(): void {
    const snap: CallsSnapshot = {};
    if (this.active) {
      const m = this.meta.get(this.active);
      const st =
        this.active.state === SessionState.Established
          ? "active"
          : m?.dir === "out"
            ? "outgoing"
            : "incoming";
      snap.active = { peer: m?.peer || "", state: st };
    }
    if (this.held) snap.held = { peer: this.meta.get(this.held)?.peer || "" };
    if (this.waiting) snap.waiting = { peer: this.meta.get(this.waiting)?.peer || "" };
    this.cb.onCalls(snap);
  }

  private attachRemoteAudio(session: Session): void {
    const pc = this.peerConnection(session);
    if (!pc) return;
    const remote = new MediaStream();
    pc.getReceivers().forEach((receiver) => {
      if (receiver.track) remote.addTrack(receiver.track);
    });
    this.audio.srcObject = remote;
    void this.audio.play().catch(() => {
      /* autoplay satisfied by the call/answer click */
    });
  }
}
