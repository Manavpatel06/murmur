// Procedural sound: a wind-and-wings bed that swells with flock speed, plus chimes.
export class MurmurAudio {
  private ctx: AudioContext | null = null;
  private bed: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private master: GainNode | null = null;

  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ctx.destination);

    // Brown noise loop for the rush of thousands of wings.
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 600;
    this.bed = ctx.createGain();
    this.bed.gain.value = 0.15;
    src.connect(this.filter).connect(this.bed).connect(this.master);
    src.start();
  }

  setIntensity(speed01: number, steering: boolean) {
    if (!this.ctx || !this.bed || !this.filter) return;
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1, speed01));
    this.bed.gain.setTargetAtTime(0.08 + s * 0.35, t, 0.3);
    this.filter.frequency.setTargetAtTime(400 + s * 1400 + (steering ? 300 : 0), t, 0.3);
  }

  chime(pitch = 1) {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [mult, delay] of [[1, 0], [1.5, 0.08], [2, 0.16]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 523.25 * pitch * mult;
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(0.12, t + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.4);
      o.connect(g).connect(this.master);
      o.start(t + delay);
      o.stop(t + delay + 1.5);
    }
  }

  fanfare() {
    [0, 0.25, 0.5, 0.9].forEach((d, i) => setTimeout(() => this.chime(1 + i * 0.25), d * 1000));
  }
}
