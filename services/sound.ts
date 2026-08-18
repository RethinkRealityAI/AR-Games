// ============================================================================
// Procedural WebAudio SFX — no external assets.
// Ported from the legacy soundService and extended for the multi-game platform.
// ============================================================================

type Osc = OscillatorType;

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;

  private getContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      typeof window === 'undefined'
        ? undefined
        : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** Call on the first user gesture to unlock audio on mobile. */
  resume(): void {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  // -- primitives ----------------------------------------------------------

  private tone(freq: number, type: Osc, duration: number, delay = 0, vol = 0.08): void {
    const ctx = this.getContext();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  private sweep(
    from: number,
    to: number,
    type: Osc,
    duration: number,
    delay = 0,
    vol = 0.08,
  ): void {
    const ctx = this.getContext();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + duration);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  private noiseBurst(duration: number, vol = 0.05, hp = 900): void {
    const ctx = this.getContext();
    if (!ctx || !this.master) return;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = hp;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();
  }

  // -- SFX -----------------------------------------------------------------

  playClick(): void {
    this.resume();
    this.tone(820, 'sine', 0.07, 0, 0.06);
  }

  playMove(): void {
    this.resume();
    this.tone(420, 'triangle', 0.1, 0, 0.09);
    this.tone(630, 'sine', 0.1, 0.045, 0.06);
  }

  /** Connect-Four disc landing: a soft "thock" with a falling pitch. */
  playDrop(): void {
    this.resume();
    this.sweep(340, 120, 'triangle', 0.18, 0, 0.1);
    this.noiseBurst(0.05, 0.035, 600);
    this.tone(160, 'sine', 0.12, 0.14, 0.07);
  }

  playWin(): void {
    this.resume();
    this.tone(440, 'sine', 0.2, 0, 0.1);
    this.tone(554, 'sine', 0.2, 0.1, 0.1);
    this.tone(659, 'sine', 0.36, 0.2, 0.1);
    this.tone(880, 'triangle', 0.7, 0.3, 0.08);
  }

  playLose(): void {
    this.resume();
    this.tone(300, 'sawtooth', 0.28, 0, 0.06);
    this.sweep(280, 140, 'sawtooth', 0.4, 0.2, 0.06);
  }

  playDraw(): void {
    this.resume();
    this.tone(240, 'square', 0.16, 0, 0.055);
    this.tone(240, 'square', 0.16, 0.12, 0.055);
  }

  playStart(): void {
    this.resume();
    this.sweep(200, 820, 'sine', 0.4, 0, 0.09);
    this.tone(1240, 'sine', 0.2, 0.34, 0.05);
  }

  /** Soft pop for an incoming/outgoing chat message. */
  playChat(): void {
    this.resume();
    this.tone(660, 'sine', 0.06, 0, 0.05);
    this.tone(990, 'sine', 0.05, 0.04, 0.035);
  }

  /** Rising chime — an opponent joined the room. */
  playJoin(): void {
    this.resume();
    this.tone(523, 'sine', 0.16, 0, 0.07);
    this.tone(659, 'sine', 0.16, 0.09, 0.07);
    this.tone(784, 'sine', 0.3, 0.18, 0.075);
    this.tone(1047, 'triangle', 0.4, 0.27, 0.05);
  }
}

export const sound = new SoundEngine();
export default sound;
