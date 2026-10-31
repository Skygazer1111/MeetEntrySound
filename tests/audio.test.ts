import { describe, expect, it } from 'vitest';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  computePeaks,
  encodeWavMono16,
  parseWavMono16,
  sliceWav,
  wavDurationSec,
  wavPeaks,
} from '@/audio/clipProcessor';
import { computeEnvelope, envelopeGainAt } from '@/audio/envelope';

const sine = (seconds: number, freq = 440, rate = 48000) =>
  Float32Array.from({ length: Math.floor(seconds * rate) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate));

describe('WAV helpers', () => {
  it('round-trips encode/parse with correct duration', () => {
    const wav = encodeWavMono16(sine(2));
    expect(wavDurationSec(wav)).toBeCloseTo(2, 3);
    const parsed = parseWavMono16(wav);
    expect(parsed.sampleRate).toBe(48000);
    expect(Math.abs(parsed.samples[100])).toBeGreaterThan(0);
  });

  it('rejects non-WAV data', () => {
    expect(() => parseWavMono16(new ArrayBuffer(100))).toThrow();
    expect(() => parseWavMono16(new ArrayBuffer(10))).toThrow();
  });

  it('slices a window and clamps to the clip length', () => {
    const wav = encodeWavMono16(sine(12));
    expect(wavDurationSec(sliceWav(wav, 2, 7))).toBeCloseTo(7, 3);
    expect(wavDurationSec(sliceWav(wav, 8, 7))).toBeCloseTo(4, 3);
    expect(wavDurationSec(sliceWav(wav, 50, 7))).toBe(0);
    expect(wavDurationSec(sliceWav(wav, -3, 5))).toBeCloseTo(5, 3);
  });

  it('slicing preserves sample content', () => {
    const src = sine(3);
    const wav = encodeWavMono16(src);
    const a = parseWavMono16(wav).samples;
    const b = parseWavMono16(sliceWav(wav, 1, 1)).samples;
    for (let i = 0; i < 50; i++) expect(Math.abs(b[i] - a[48000 + i])).toBeLessThanOrEqual(1);
  });

  it('computes bounded peaks', () => {
    const peaks = wavPeaks(encodeWavMono16(sine(1)), 20);
    expect(peaks).toHaveLength(20);
    for (const p of peaks) {
      expect(p).toBeGreaterThan(0.3);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(computePeaks([], 10).every((v) => v === 0)).toBe(true);
  });

  it('base64 round-trips binary data', () => {
    const wav = encodeWavMono16(sine(1));
    const back = base64ToArrayBuffer(arrayBufferToBase64(wav));
    expect(new Uint8Array(back)).toEqual(new Uint8Array(wav));
  });
});

describe('envelope', () => {
  it('fades in and out around the target volume', () => {
    const env = computeEnvelope(7, 400, 0.8);
    expect(envelopeGainAt(env, 0)).toBe(0);
    expect(envelopeGainAt(env, 0.2)).toBeCloseTo(0.4, 5);
    expect(envelopeGainAt(env, 3)).toBeCloseTo(0.8, 5);
    expect(envelopeGainAt(env, 6.8)).toBeCloseTo(0.4, 5);
    expect(envelopeGainAt(env, 7)).toBe(0);
  });

  it('caps the fade to half the clip and supports no fade', () => {
    const env = computeEnvelope(1, 5000, 1);
    expect(env[1].t).toBeCloseTo(0.5);
    expect(computeEnvelope(5, 0, 0.5)).toEqual([{ t: 0, gain: 0.5 }, { t: 5, gain: 0.5 }]);
  });

  it('clamps volume to 0..1', () => {
    expect(computeEnvelope(5, 0, 7)[0].gain).toBe(1);
    expect(computeEnvelope(5, 0, -1)[0].gain).toBe(0);
  });
});
