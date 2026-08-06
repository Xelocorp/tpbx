// Ringtone / ringback synthesis via the Web Audio API.
//
// No audio files are used (nothing to host, CSP-safe): tones are generated on
// the fly. incoming() plays a bell-like "trrring … trrring" cadence; ringback()
// plays the standard 440+480 Hz call-progress tone. Both loop until stop().
//
// Browsers gate audio behind a user gesture, so unlock() is called once from a
// real interaction (a click/keypress) to resume the AudioContext.
export class Ringer {
  private ctx: AudioContext | null = null;
  private timer: number | undefined;
  private active = false;

  unlock(): void {
    const ctx = this.context();
    if (ctx.state === "suspended") void ctx.resume();
  }

  incoming(): void {
    this.run("incoming");
  }

  ringback(): void {
    this.run("ringback");
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private run(kind: "incoming" | "ringback"): void {
    this.stop();
    this.active = true;
    const ctx = this.context();
    if (ctx.state === "suspended") void ctx.resume();
    const tick = () => {
      if (!this.active) return;
      const period = kind === "incoming" ? this.incomingBurst(ctx) : this.ringbackBurst(ctx);
      this.timer = window.setTimeout(tick, period * 1000);
    };
    tick();
  }

  // Standard ringback: 2s tone, 4s silence.
  private ringbackBurst(ctx: AudioContext): number {
    this.tone(ctx, [440, 480], ctx.currentTime, 2.0, 0.14);
    return 6.0;
  }

  // Incoming: two short warbling bursts, then a pause -> "trrring … trrring".
  private incomingBurst(ctx: AudioContext): number {
    this.warble(ctx, ctx.currentTime, 0.4);
    this.warble(ctx, ctx.currentTime + 0.6, 0.4);
    return 3.0;
  }

  private tone(ctx: AudioContext, freqs: number[], start: number, dur: number, vol: number): void {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(vol, start + 0.03);
    gain.gain.setValueAtTime(vol, start + dur - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    gain.connect(ctx.destination);
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(start);
      osc.stop(start + dur);
    }
  }

  // A bell-like trill: one oscillator stepping between two pitches quickly.
  private warble(ctx: AudioContext, start: number, dur: number): void {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.setValueAtTime(0.2, start + dur - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    let t = start;
    let hi = true;
    while (t < start + dur) {
      osc.frequency.setValueAtTime(hi ? 1000 : 800, t);
      hi = !hi;
      t += 0.04;
    }
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + dur);
  }
}
