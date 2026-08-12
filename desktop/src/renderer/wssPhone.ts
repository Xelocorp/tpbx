// WSS / WebRTC softphone for the renderer, built on SIP.js. This is the primary
// (fully functional) path: registration, inbound/outbound calls, DTMF, mute and
// blind transfer, with STUN/TURN injected into every peer connection. Adapted
// from the browser agent app's sip.ts.

import {
  Inviter,
  Invitation,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
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

export interface WssCallbacks {
  onState: (state: PhoneState, detail?: string) => void;
  onIncoming: (from: string) => void;
  onError: (message: string) => void;
  onCallEnded?: (e: CallEnded) => void;
}

export class WssPhone {
  private ua?: UserAgent;
  private registerer?: Registerer;
  private session?: Session;
  private incoming?: Invitation;
  private dnd = false;
  private reconnectTimer?: number;
  private callMeta?: { dir: "in" | "out"; peer: string; answeredAt: number; declined: boolean };

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
      else if (s === RegistererState.Unregistered && this.session === undefined) {
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
    if (!this.ua) return;
    const uri = UserAgent.makeURI(`sip:${target}@${this.cfg.domain}`);
    if (!uri) {
      this.cb.onError("invalid number");
      return;
    }
    const inviter = new Inviter(this.ua, uri, {
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.session = inviter;
    this.callMeta = { dir: "out", peer: target, answeredAt: 0, declined: false };
    this.wireSession(inviter, target);
    this.cb.onState("outgoing", target);
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
      invitation.reject({ statusCode: 486 }); // Busy Here (Do Not Disturb)
      this.cb.onCallEnded?.({ direction: "in", peer: from, answered: false, declined: true, durationSec: 0 });
      return;
    }
    if (this.session) {
      invitation.reject({ statusCode: 486 }); // already on a call
      return;
    }
    this.incoming = invitation;
    this.session = invitation;
    this.callMeta = { dir: "in", peer: from, answeredAt: 0, declined: false };
    this.wireSession(invitation, from);
    this.cb.onIncoming(from);
    this.cb.onState("incoming", from);
  }

  async answer(): Promise<void> {
    if (!this.incoming) return;
    await this.incoming.accept({
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.incoming = undefined;
  }

  hangup(): void {
    const s = this.session;
    if (!s) return;
    switch (s.state) {
      case SessionState.Initial:
      case SessionState.Establishing:
        if (s instanceof Inviter) {
          s.cancel();
        } else if (s instanceof Invitation) {
          if (this.callMeta) this.callMeta.declined = true; // user declined a ringing call
          s.reject();
        }
        break;
      case SessionState.Established:
        void s.bye();
        break;
    }
  }

  async blindTransfer(target: string): Promise<void> {
    const s = this.session;
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
    const sdh = this.session?.sessionDescriptionHandler as
      | { sendDtmf?: (t: string) => boolean }
      | undefined;
    sdh?.sendDtmf?.(tone);
  }

  setMuted(muted: boolean): void {
    this.peerConnection()
      ?.getSenders()
      .forEach((sender) => {
        if (sender.track && sender.track.kind === "audio") sender.track.enabled = !muted;
      });
  }

  async stop(): Promise<void> {
    window.clearTimeout(this.reconnectTimer);
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

  private peerConnection(): RTCPeerConnection | undefined {
    const sdh = this.session?.sessionDescriptionHandler as
      | { peerConnection?: RTCPeerConnection }
      | undefined;
    return sdh?.peerConnection;
  }

  private wireSession(session: Session, label: string): void {
    session.stateChange.addListener((state: SessionState) => {
      switch (state) {
        case SessionState.Established:
          if (this.callMeta) this.callMeta.answeredAt = Date.now();
          this.attachRemoteAudio();
          this.cb.onState("active", label);
          break;
        case SessionState.Terminated:
          this.emitEnded();
          this.audio.srcObject = null;
          this.session = undefined;
          this.incoming = undefined;
          this.cb.onState("registered");
          break;
      }
    });
  }

  // emitEnded reports a finished call once, deriving talk duration from when the
  // media was established.
  private emitEnded(): void {
    const m = this.callMeta;
    this.callMeta = undefined;
    if (!m) return;
    const answered = m.answeredAt > 0;
    this.cb.onCallEnded?.({
      direction: m.dir,
      peer: m.peer,
      answered,
      declined: m.declined,
      durationSec: answered ? Math.round((Date.now() - m.answeredAt) / 1000) : 0,
    });
  }

  private attachRemoteAudio(): void {
    const pc = this.peerConnection();
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
