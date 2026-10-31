// Popup-side preview player. Plays the selected window of the stored clip on the local speakers
// using the same envelope as the in-meeting player. Never touches Meet.

import { applyEnvelope, computeEnvelope } from './envelope';
import { sliceWav } from './clipProcessor';

export interface PreviewOptions {
  startOffsetSec: number;
  durationSec: number;
  volume: number;
  fadeMs: number;
}

export class PreviewPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private raf = 0;
  private startedAt = 0;
  private lengthSec = 0;

  constructor(private onProgress: (progress: number | null) => void) {}

  get playing(): boolean {
    return this.source !== null;
  }

  async play(wav: ArrayBuffer, opts: PreviewOptions): Promise<void> {
    this.stop();
    const slice = sliceWav(wav, opts.startOffsetSec, opts.durationSec);
    const ctx = new AudioContext();
    this.ctx = ctx;
    const buffer = await ctx.decodeAudioData(slice);
    if (this.ctx !== ctx) return; // stopped while decoding
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    const t0 = ctx.currentTime + 0.03;
    applyEnvelope(gain.gain, t0, computeEnvelope(buffer.duration, opts.fadeMs, opts.volume));
    src.onended = () => this.stop();
    src.start(t0);
    this.source = src;
    this.lengthSec = buffer.duration;
    this.startedAt = performance.now();
    const tick = () => {
      if (!this.source) return;
      const elapsed = (performance.now() - this.startedAt) / 1000;
      this.onProgress(Math.min(1, elapsed / this.lengthSec));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    const { source, ctx } = this;
    this.source = null;
    this.ctx = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
    }
    if (ctx) void ctx.close().catch(() => undefined);
    this.onProgress(null);
  }
}
