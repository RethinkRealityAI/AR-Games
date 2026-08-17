
// Simple procedural sound synthesizer using Web Audio API
// No external assets required.

class SoundService {
  private ctx: AudioContext | null = null;

  private getContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.ctx;
  }

  // Call this on first user interaction to unlock audio on mobile
  resume() {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
  }

  private playTone(freq: number, type: OscillatorType, duration: number, delay = 0, vol = 0.1) {
    const ctx = this.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    
    gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + delay + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration);
  }

  playClick() {
    this.resume();
    this.playTone(800, 'sine', 0.1, 0, 0.1);
  }

  playMove() {
    this.resume();
    this.playTone(400, 'triangle', 0.1, 0, 0.15);
    this.playTone(600, 'sine', 0.1, 0.05, 0.1);
  }

  playWin() {
    this.resume();
    this.playTone(440, 'sine', 0.2, 0, 0.2);       // A4
    this.playTone(554, 'sine', 0.2, 0.1, 0.2);     // C#5
    this.playTone(659, 'sine', 0.4, 0.2, 0.2);     // E5
    this.playTone(880, 'triangle', 0.8, 0.3, 0.15); // A5
  }

  playLose() {
    this.resume();
    this.playTone(300, 'sawtooth', 0.3, 0, 0.1);
    this.playTone(280, 'sawtooth', 0.4, 0.2, 0.1);
  }

  playDraw() {
    this.resume();
    this.playTone(200, 'square', 0.2, 0, 0.1);
    this.playTone(200, 'square', 0.2, 0.1, 0.1);
  }
  
  playStart() {
    this.resume();
    const ctx = this.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  }
}

export const soundService = new SoundService();
