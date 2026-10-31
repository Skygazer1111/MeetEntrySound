// Clip processing. The pure WAV helpers (encode / parse / slice / peaks) have no DOM dependency so
// they run in the service worker and in unit tests. `normalizeFileToWav` needs Web Audio and is
// only used from the popup/options page.

export const STORE_SAMPLE_RATE = 48000;
/** Longest stretch of an uploaded file we keep (the user then picks a 5-10 s window inside it). */
export const MAX_STORED_SEC = 60;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const HEADER_BYTES = 44;

export function encodeWavMono16(samples: Float32Array, sampleRate = STORE_SAMPLE_RATE): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(HEADER_BYTES + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export interface ParsedWav {
  sampleRate: number;
  /** View over the PCM data of the input buffer (not copied). */
  samples: Int16Array;
}

/** Parses the WAV flavour we produce ourselves: PCM, mono, 16-bit. Throws on anything else. */
export function parseWavMono16(buf: ArrayBuffer): ParsedWav {
  if (buf.byteLength < HEADER_BYTES) throw new Error('WAV too short');
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  let sampleRate = 0;
  let fmtOk = false;
  while (offset + 8 <= buf.byteLength) {
    const id = tag(offset);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      const format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      fmtOk = format === 1 && channels === 1 && bits === 16;
    } else if (id === 'data') {
      if (!fmtOk) throw new Error('Unsupported WAV format (expected mono 16-bit PCM)');
      const available = Math.min(size, buf.byteLength - body);
      const even = available - (available % 2);
      return { sampleRate, samples: new Int16Array(buf.slice(body, body + even)) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export function wavDurationSec(buf: ArrayBuffer): number {
  const { sampleRate, samples } = parseWavMono16(buf);
  return samples.length / sampleRate;
}

/** Returns a new WAV containing [startSec, startSec + durationSec) of the input (clamped to its length). */
export function sliceWav(buf: ArrayBuffer, startSec: number, durationSec: number): ArrayBuffer {
  const { sampleRate, samples } = parseWavMono16(buf);
  const total = samples.length;
  const start = Math.min(total, Math.max(0, Math.floor(startSec * sampleRate)));
  const end = Math.min(total, start + Math.max(0, Math.floor(durationSec * sampleRate)));
  const out = new Float32Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = samples[start + i] / (samples[start + i] < 0 ? 0x8000 : 0x7fff);
  return encodeWavMono16(out, sampleRate);
}

/** Min/max-free peak envelope (absolute peaks in 0..1) for drawing a waveform. */
export function computePeaks(samples: ArrayLike<number>, buckets: number, scale = 1): Float32Array {
  const peaks = new Float32Array(buckets);
  if (samples.length === 0 || buckets <= 0) return peaks;
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    let max = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      const a = Math.abs(samples[i]) / scale;
      if (a > max) max = a;
    }
    peaks[b] = Math.min(1, max);
  }
  return peaks;
}

export function wavPeaks(buf: ArrayBuffer, buckets: number): Float32Array {
  return computePeaks(parseWavMono16(buf).samples, buckets, 0x8000);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export class ClipError extends Error {}

/**
 * Decodes an uploaded MP3/WAV, downmixes to mono, resamples to 48 kHz, peak-normalises and
 * returns a WAV (at most MAX_STORED_SEC long). Browser only.
 */
export async function normalizeFileToWav(file: Blob & { name?: string }): Promise<{ wav: ArrayBuffer; lengthSec: number }> {
  if (file.size > MAX_UPLOAD_BYTES) throw new ClipError('File is too large (max 15 MB).');
  const bytes = await file.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes);
  } catch {
    throw new ClipError('Could not decode this file. Please use a valid MP3 or WAV.');
  } finally {
    void decodeCtx.close();
  }
  if (decoded.duration < 1) throw new ClipError('Clip is too short (needs at least 1 second).');

  const keepSec = Math.min(decoded.duration, MAX_STORED_SEC);
  const frames = Math.ceil(keepSec * STORE_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, STORE_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination); // implicit down-mix to mono
  src.start(0);
  const rendered = await offline.startRendering();
  const data = rendered.getChannelData(0);

  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak < 1e-4) throw new ClipError('This clip appears to be silent.');
  const gain = 0.9 / peak;
  const normalized = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) normalized[i] = data[i] * gain;

  return { wav: encodeWavMono16(normalized), lengthSec: keepSec };
}
