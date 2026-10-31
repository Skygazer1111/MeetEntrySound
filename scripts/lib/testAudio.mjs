// Shared helpers for the browser-based verification scripts.
import { existsSync } from 'node:fs';

export function wav16(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return buf;
}

export const tone = (hz, sec, amp, rate = 48000) =>
  Float32Array.from({ length: Math.floor(sec * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error('Chrome not found. Set CHROME_PATH.');
    process.exit(2);
  }
  return found;
}

export const FAKE_MEDIA_ARGS = (micFile) => [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${micFile}`,
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];
