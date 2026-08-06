// SIP.js wrapper for the browser softphone.
//
// It hides the SIP.js UserAgent/Registerer/Session machinery behind a small
// imperative API (start/stop/call/answer/hangup/dtmf/mute) and a set of
// callbacks the React UI subscribes to. WebRTC specifics that make audio
// "just work" live here: ICE servers (STUN/TURN) are injected into every peer
// connection, and remote audio is wired to an <audio> element on connect.

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

export interface SoftphoneConfig {
  wsUrl: string;
  domain: string;
  extension: string;
  password: string;
  displayName: string;
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
}

export interface SoftphoneCallbacks {
  onState: (state: PhoneState, detail?: string) => void;
  onIncoming: (from: string) => void;
  onError: (message: string) => void;
  onRecording?: (blob: Blob) => void; // fired when a recording is finalised
}

export class Softphone {
  private ua?: UserAgent;
  private registerer?: Registerer;
  private session?: Session;
  private readonly audio: HTMLAudioElement;
  private dnd = false;

  constructor(
    private cfg: SoftphoneConfig,
    private cb: SoftphoneCallbacks,
    audio: HTMLAudioElement
  ) {
    this.audio = audio;
  }

  async start(): Promise<void> {
    this.cb.onState("connecting");
    const uri = UserAgent.makeURI(`sip:${this.cfg.extension}@${this.cfg.domain}`);
    if (!uri) {
      this.cb.onError("invalid SIP address");
      return;
    }

    this.ua = new UserAgent({
      uri,
      displayName: this.cfg.displayName,
      authorizationUsername: this.cfg.extension,
      authorizationPassword: this.cfg.password,
      transportOptions: { server: this.cfg.wsUrl },
      // Inject STUN/TURN into every peer connection so media traverses NAT.
      sessionDescriptionHandlerFactoryOptions: {
        iceGatheringTimeout: 5000,
        peerConnectionConfiguration: {
          iceServers: this.cfg.iceServers,
          // "all" tries a direct path first and falls back to TURN (best
          // quality); "relay" forces media through TURN. Admin-configurable.
          iceTransportPolicy: this.cfg.iceTransportPolicy ?? "all",
        },
      },
      delegate: {
        onInvite: (invitation: Invitation) => this.onIncoming(invitation),
        // Register on every (re)connection of the transport. This single path
        // covers both the initial connect and automatic reconnects.
        onConnect: () => this.register(),
        onDisconnect: (err?: Error) => {
          this.cb.onState("connecting", "reconnecting");
          if (err) this.reconnect();
        },
      },
    });

    // Build the Registerer before start() so it exists when onConnect fires.
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

  private reconnectTimer?: number;
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

  // Place an outbound call to a number/extension.
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
    this.wireSession(inviter, target);
    this.cb.onState("outgoing", target);
    try {
      await inviter.invite();
    } catch (e) {
      this.cb.onError((e as Error).message);
      this.cb.onState("registered");
    }
  }

  // setDND toggles Do Not Disturb. While on, incoming calls are auto-declined
  // with 486 Busy Here and never ring.
  setDND(on: boolean): void {
    this.dnd = on;
  }

  private incoming?: Invitation;
  private onIncoming(invitation: Invitation): void {
    if (this.dnd) {
      invitation.reject({ statusCode: 486 }); // Busy Here (Do Not Disturb)
      return;
    }
    if (this.session) {
      // Already on a call: reject with busy.
      invitation.reject({ statusCode: 486 });
      return;
    }
    this.incoming = invitation;
    this.session = invitation;
    const from = invitation.remoteIdentity.displayName || invitation.remoteIdentity.uri.user || "unknown";
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

  reject(): void {
    if (this.incoming) {
      this.incoming.reject();
      this.incoming = undefined;
    }
  }

  // Hang up / cancel whatever session is active, in any state.
  hangup(): void {
    const s = this.session;
    if (!s) return;
    switch (s.state) {
      case SessionState.Initial:
      case SessionState.Establishing:
        if (s instanceof Inviter) s.cancel();
        else if (s instanceof Invitation) s.reject();
        break;
      case SessionState.Established:
        s.bye();
        break;
    }
  }

  // blindTransfer sends the active call to another number/extension (SIP REFER).
  // Our leg ends once the far end takes over.
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

  private recorder?: MediaRecorder;
  private recChunks: Blob[] = [];
  private recCtx?: AudioContext;

  // startRecording mixes the local (mic) and remote audio into one stream and
  // records it. Returns false if there is no active media to record.
  startRecording(): boolean {
    const pc = this.peerConnection();
    if (!pc || this.recorder) return false;
    const tracks: MediaStreamTrack[] = [];
    pc.getSenders().forEach((s) => {
      if (s.track && s.track.kind === "audio") tracks.push(s.track);
    });
    pc.getReceivers().forEach((r) => {
      if (r.track && r.track.kind === "audio") tracks.push(r.track);
    });
    if (tracks.length === 0) return false;

    const ctx = new AudioContext();
    this.recCtx = ctx;
    const dest = ctx.createMediaStreamDestination();
    for (const t of tracks) {
      ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const rec = mime
      ? new MediaRecorder(dest.stream, { mimeType: mime })
      : new MediaRecorder(dest.stream);
    this.recChunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.recChunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(this.recChunks, { type: rec.mimeType || "audio/webm" });
      this.recChunks = [];
      void this.recCtx?.close();
      this.recCtx = undefined;
      this.cb.onRecording?.(blob);
    };
    rec.start();
    this.recorder = rec;
    return true;
  }

  stopRecording(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = undefined;
  }

  sendDtmf(tone: string): void {
    const sdh = this.session?.sessionDescriptionHandler as
      | { sendDtmf?: (t: string) => boolean }
      | undefined;
    sdh?.sendDtmf?.(tone);
  }

  setMuted(muted: boolean): void {
    const pc = this.peerConnection();
    pc?.getSenders().forEach((sender) => {
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
          this.attachRemoteAudio();
          this.cb.onState("active", label);
          break;
        case SessionState.Terminated:
          this.cleanupSession();
          break;
      }
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
      /* autoplay may require a gesture; the answer/call click satisfies it */
    });
  }

  private cleanupSession(): void {
    this.stopRecording(); // finalise any recording when the call ends
    this.audio.srcObject = null;
    this.session = undefined;
    this.incoming = undefined;
    this.cb.onState("registered");
  }
}
