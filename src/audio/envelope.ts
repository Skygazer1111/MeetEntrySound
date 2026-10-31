// Gain envelope shared by the popup preview and the in-meeting player so both sound identical.

export interface EnvelopePoint {
  /** Seconds from clip start. */
  t: number;
  gain: number;
}

/** Fade-in, hold, fade-out. The fade is capped to half the clip so short clips still work. */
export function computeEnvelope(durationSec: number, fadeMs: number, volume: number): EnvelopePoint[] {
  const dur = Math.max(0.05, durationSec);
  const fade = Math.min(Math.max(0, fadeMs) / 1000, dur / 2);
  const vol = Math.min(1, Math.max(0, volume));
  if (fade === 0) return [{ t: 0, gain: vol }, { t: dur, gain: vol }];
  return [
    { t: 0, gain: 0 },
    { t: fade, gain: vol },
    { t: dur - fade, gain: vol },
    { t: dur, gain: 0 },
  ];
}

/** Applies an envelope to an AudioParam starting at `startTime` (AudioContext time). */
export function applyEnvelope(param: AudioParam, startTime: number, points: EnvelopePoint[]): void {
  param.cancelScheduledValues(startTime);
  param.setValueAtTime(points[0].gain, startTime + points[0].t);
  for (let i = 1; i < points.length; i++) {
    param.linearRampToValueAtTime(points[i].gain, startTime + points[i].t);
  }
}

/** Gain at time t (used for the preview progress display and in tests). */
export function envelopeGainAt(points: EnvelopePoint[], t: number): number {
  if (t <= points[0].t) return points[0].gain;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1];
      const b = points[i];
      const span = b.t - a.t;
      return span <= 0 ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / span;
    }
  }
  return points[points.length - 1].gain;
}
