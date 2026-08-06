// Background SIP engine. Runs in a DOM context that survives with the
// extension: a Chrome offscreen document or a Firefox background page. It owns
// the SIP.js connection, auto-registers from stored credentials, and mirrors
// state to the popup via runtime messaging.

import { Softphone as SipPhone, type CallLogEntry, type PhoneState } from "../agent/sip";
import { STORAGE_KEY, LOG_KEY, type Cmd, type Evt, type Snapshot } from "./proto";
import { wext } from "./wext";

interface StoredCfg {
  server: string;
  extension: string;
  password: string;
}

const blank: Snapshot = {
  configured: false,
  state: "offline",
  detail: "",
  extension: "",
  displayName: "",
  incoming: null,
  muted: false,
  speaker: true,
  dnd: false,
  recording: false,
  error: "",
  log: [],
};

export class Engine {
  private phone?: SipPhone;
  private readonly audio: HTMLAudioElement;
  private snap: Snapshot = { ...blank };
  private server = "";

  constructor() {
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    document.body.appendChild(this.audio);

    wext.runtime.onMessage.addListener((msg: Cmd) => {
      void this.onCmd(msg);
    });
    void this.boot();
  }

  private async boot(): Promise<void> {
    this.snap.log = await this.loadLog();
    const cfg = await this.loadCfg();
    if (cfg) {
      this.snap.configured = true;
      await this.connect(cfg);
    }
    this.broadcast();
  }

  private async onCmd(msg: Cmd): Promise<void> {
    if (!msg || typeof msg.t !== "string") return;
    switch (msg.t) {
      case "sync":
        this.broadcast();
        break;
      case "login": {
        const cfg: StoredCfg = { server: msg.server, extension: msg.extension, password: msg.password };
        await this.saveCfg(cfg);
        this.snap.configured = true;
        this.snap.error = "";
        await this.connect(cfg);
        break;
      }
      case "logout":
        await this.phone?.stop();
        this.phone = undefined;
        await this.clearCfg();
        this.snap = { ...blank, log: this.snap.log };
        this.broadcast();
        break;
      case "call":
        void this.phone?.call(msg.target);
        break;
      case "answer":
        void this.phone?.answer();
        break;
      case "reject":
        this.phone?.reject();
        break;
      case "hangup":
        this.phone?.hangup();
        break;
      case "dtmf":
        this.phone?.sendDtmf(msg.tone);
        break;
      case "mute":
        this.phone?.setMuted(msg.on);
        this.set({ muted: msg.on });
        break;
      case "speaker":
        this.phone?.setSpeaker(msg.on);
        this.set({ speaker: msg.on });
        break;
      case "dnd":
        this.phone?.setDND(msg.on);
        this.set({ dnd: msg.on });
        break;
      case "transfer":
        void this.phone?.blindTransfer(msg.target);
        break;
      case "rec":
        if (msg.on) {
          if (this.phone?.startRecording()) this.set({ recording: true });
        } else {
          this.phone?.stopRecording();
          this.set({ recording: false });
        }
        break;
      case "clearlog":
        this.snap.log = [];
        await this.saveLog();
        this.broadcast();
        break;
    }
  }

  private async connect(cfg: StoredCfg): Promise<void> {
    this.server = cfg.server.replace(/\/+$/, "");
    try {
      const login = await this.post("/api/agent/login", {
        extension: cfg.extension,
        password: cfg.password,
      });
      const token = login.token as string;
      const ac = await this.get("/api/agent/config", token);

      await this.phone?.stop();
      this.phone = new SipPhone(
        {
          wsUrl: ac.wsUrl,
          domain: ac.domain,
          extension: ac.extension,
          password: ac.password,
          displayName: ac.displayName,
          iceServers: ac.iceServers,
          iceTransportPolicy: ac.iceTransportPolicy,
        },
        {
          onState: (state: PhoneState, detail?: string) => {
            this.set({ state, detail: detail ?? "", incoming: state === "incoming" ? this.snap.incoming : null });
            if (state === "registered" || state === "offline") this.set({ muted: false });
            if (state !== "active") this.set({ recording: false });
          },
          onIncoming: (from) => {
            this.set({ incoming: from });
            this.emit({ t: "incoming", from });
          },
          onError: (message) => this.set({ error: message }),
          onCallEnded: (entry: CallLogEntry) => {
            this.snap.log = [entry, ...this.snap.log].slice(0, 100);
            void this.saveLog();
            this.emit({ t: "callcleared" });
            this.broadcast();
          },
          onRecording: (blob) => void this.offerDownload(blob, ac.extension),
        },
        this.audio
      );
      this.set({ extension: ac.extension, displayName: ac.displayName, error: "" });
      void this.phone.start();
    } catch (e) {
      this.set({ state: "failed", error: (e as Error).message });
    }
  }

  // --- helpers -------------------------------------------------------------

  private set(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.broadcast();
  }

  private broadcast(): void {
    this.emit({ t: "snapshot", snap: this.snap });
  }

  private emit(ev: Evt): void {
    try {
      // Fire-and-forget; a missing receiver (popup closed) is expected.
      const p = wext.runtime.sendMessage(ev);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* no receiver */
    }
  }

  private async offerDownload(blob: Blob, ext: string): Promise<void> {
    const reader = new FileReader();
    const url: string = await new Promise((resolve) => {
      reader.onloadend = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const kind = blob.type.includes("mp4") ? "mp4" : "webm";
    this.emit({ t: "download", url, name: `call-${ext}-${stamp}.${kind}` });
  }

  private async post(path: string, body: unknown): Promise<Record<string, any>> {
    const r = await fetch(this.server + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }

  private async get(path: string, token: string): Promise<Record<string, any>> {
    const r = await fetch(this.server + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }

  private async loadCfg(): Promise<StoredCfg | null> {
    const o = await wext.storage.local.get(STORAGE_KEY);
    return (o?.[STORAGE_KEY] as StoredCfg) ?? null;
  }
  private async saveCfg(c: StoredCfg): Promise<void> {
    await wext.storage.local.set({ [STORAGE_KEY]: c });
  }
  private async clearCfg(): Promise<void> {
    await wext.storage.local.remove(STORAGE_KEY);
  }
  private async loadLog(): Promise<CallLogEntry[]> {
    const o = await wext.storage.local.get(LOG_KEY);
    return (o?.[LOG_KEY] as CallLogEntry[]) ?? [];
  }
  private async saveLog(): Promise<void> {
    await wext.storage.local.set({ [LOG_KEY]: this.snap.log });
  }
}
