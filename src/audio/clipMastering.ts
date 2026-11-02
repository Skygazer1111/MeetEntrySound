// Clip "mastering" chain shared by the in-meeting player and the popup preview, so both sound the
// same. It makes the clip hold up through Meet's low-bitrate Opus voice encoding:
//   - high-pass at 100 Hz removes sub-bass that wastes bitrate and muddies the voice codec,
//   - a gentle compressor makes loudness denser and steadier,
//   - a small presence boost keeps the music clear and intelligible.

export interface ClipChain {
  /** Connect the clip source to this node. */
  input: AudioNode;
  /** Connect this node onwards (gain / destination). */
  output: AudioNode;
}

export const MASTERING = {
  highpassHz: 100,
  compressor: { threshold: -18, knee: 12, ratio: 3, attack: 0.01, release: 0.2 },
  presence: { frequency: 2500, q: 0.8, gainDb: 2 },
} as const;

export function buildClipChain(ctx: BaseAudioContext): ClipChain {
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = MASTERING.highpassHz;
  highpass.Q.value = 0.707;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = MASTERING.compressor.threshold;
  comp.knee.value = MASTERING.compressor.knee;
  comp.ratio.value = MASTERING.compressor.ratio;
  comp.attack.value = MASTERING.compressor.attack;
  comp.release.value = MASTERING.compressor.release;

  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = MASTERING.presence.frequency;
  presence.Q.value = MASTERING.presence.q;
  presence.gain.value = MASTERING.presence.gainDb;

  highpass.connect(comp).connect(presence);
  return { input: highpass, output: presence };
}

/** tanh soft-clip curve, normalised so that +/-1 maps to +/-1. Final safety stage instead of hard clipping. */
export function softClipCurve(samples = 1024, drive = 1.2): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}
