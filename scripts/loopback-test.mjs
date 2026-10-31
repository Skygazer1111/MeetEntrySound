// Phase 3 verification: proves the audio-injection MECHANISM end to end in a real Chrome, with a
// real receiving RTCPeerConnection that analyses the audio it gets over WebRTC.
//
//   page "Meet" side:  fake mic (400 Hz tone) -> RTCPeerConnection A  --WebRTC-->  B -> FFT analyser
//   MeetEntry:         dist/injected.js loaded at document_start, driven over its real bridge protocol
//
// The receiver measures energy at 400 Hz (the mic) and 1500 Hz (the entrance clip), so we can show
// that the clip arrives at the far end, the mic keeps flowing, and everything is restored afterwards.
//
// WHAT THIS DOES NOT PROVE: that Google Meet itself accepts and forwards the swapped track. That
// can only be confirmed with a second participant in a real meeting (see README acceptance tests).
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const injectedPath = join(root, 'dist', 'injected.js');
if (!existsSync(injectedPath)) {
  console.error('dist/injected.js not found. Run `npm run build` first.');
  process.exit(2);
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = chromeCandidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error('Chrome not found. Set CHROME_PATH.');
  process.exit(2);
}

// ---- test audio files -----------------------------------------------------------------------
function wav16(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return buf;
}
const tone = (hz, sec, amp, rate = 48000) =>
  Float32Array.from({ length: Math.floor(sec * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

const tmp = mkdtempSync(join(tmpdir(), 'meetentry-'));
const micFile = join(tmp, 'mic-400hz.wav');
writeFileSync(micFile, wav16(tone(400, 4, 0.3), 48000)); // fake microphone: a steady 400 Hz tone
const clipB64 = wav16(tone(1500, 8, 0.7), 48000).toString('base64'); // entrance clip: 1500 Hz tone, 8 s

// ---- browser --------------------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${micFile}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'] });
await context.addInitScript({ content: readFileSync(injectedPath, 'utf8') }); // like a MAIN-world document_start content script
const page = await context.newPage();
await page.route('https://meet.google.com/**', (route) =>
  route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>mock meet</body></html>' }),
);
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto('https://meet.google.com/abc-defg-hij');

// Harness: a sending peer ("you in Meet") and a receiving peer ("another participant").
await page.evaluate(async (clipB64) => {
  window.__events = [];
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => window.__events.push({ at: performance.now(), ...e.data });
  window.postMessage({ source: 'meetentry-bridge', type: 'init-port' }, location.origin, [ch.port2]);
  window.__send = (cmd, transfer = []) => ch.port1.postMessage(cmd, transfer);
  window.__b64ToBuf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const micTrack = mic.getAudioTracks()[0];
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const sender = a.addTrack(micTrack, mic);
  const gotStream = new Promise((res) => (b.ontrack = (e) => res(e.streams[0] ?? new MediaStream([e.track]))));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  await Promise.all([a, b].map((pc) => new Promise((res) => {
    if (pc.connectionState === 'connected') return res();
    pc.onconnectionstatechange = () => pc.connectionState === 'connected' && res();
  })));

  const remote = await gotStream;
  const el = new Audio();
  el.srcObject = remote; // Chrome only feeds remote audio to Web Audio if it is also attached to a media element
  el.volume = 0.01;
  await el.play().catch(() => undefined);
  const ctx = new AudioContext();
  await ctx.resume();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(remote).connect(analyser);
  const bins = new Float32Array(analyser.frequencyBinCount);
  const dbAt = (hz) => {
    const i = Math.round((hz / ctx.sampleRate) * analyser.fftSize);
    let m = -Infinity;
    for (let k = i - 2; k <= i + 2; k++) m = Math.max(m, bins[k]);
    return m;
  };
  window.__measure = (ms) => new Promise((res) => {
    const out = [];
    const t0 = performance.now();
    const id = setInterval(() => {
      analyser.getFloatFrequencyData(bins);
      out.push({ t: Math.round(performance.now() - t0), mic: dbAt(400), clip: dbAt(1500) });
      if (performance.now() - t0 >= ms) { clearInterval(id); res(out); }
    }, 100);
  });
  window.__h = { micTrack, sender, a, b };
  window.__clipB64 = clipB64;
}, clipB64);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};
const PRESENT = -55; // dB: tone clearly audible at the receiver
const ABSENT = -75; // dB: tone not there
const events = () => page.evaluate(() => window.__events.splice(0));
const senderIsMic = () => page.evaluate(() => window.__h.sender.track === window.__h.micTrack);
const play = (extra = {}) =>
  page.evaluate((extra) => {
    window.__send({ type: 'play', requestId: 1, source: 'manual', volume: 1, durationSec: 5, fadeMs: 300, monitor: false, ...extra });
  }, extra);
const setMicEnabled = (v) => page.evaluate((v) => (window.__h.micTrack.enabled = v), v);

// ---- handshake + clip --------------------------------------------------------------------------
await sleep(500);
let ev = await events();
check('injected script answered the bridge handshake', ev.some((e) => e.type === 'hello'));
check('peer connection observed as connected', ev.some((e) => e.type === 'peers' && e.peers.connected && e.peers.audioSender), JSON.stringify(ev.filter((e) => e.type === 'peers').pop()?.peers));
await page.evaluate(() => window.__send({ type: 'load-clip', clipKey: 'k', wav: window.__b64ToBuf(window.__clipB64) }));
await sleep(400);
ev = await events();
check('clip loaded in page context', ev.some((e) => e.type === 'clip-loaded'));

// ---- scenario 1: normal entrance (5 s) ----------------------------------------------------------
console.log('\n[1] Normal 5 s entrance');
let series = page.evaluate(() => window.__measure(8500));
await sleep(1000);
await play();
const s1 = await series;
ev = await events();
const during = s1.filter((p) => p.t > 2000 && p.t < 5500);
const before = s1.filter((p) => p.t < 900);
const after = s1.filter((p) => p.t > 7200);
check('play accepted', ev.some((e) => e.type === 'play-result' && e.ok === true), JSON.stringify(ev.find((e) => e.type === 'play-result')));
check('RECEIVER hears nothing at 1500 Hz before the clip', Math.max(...before.map((p) => p.clip)) < ABSENT, `max ${Math.max(...before.map((p) => p.clip)).toFixed(0)} dB`);
check('RECEIVER hears the entrance clip (1500 Hz) during playback', Math.min(...during.map((p) => p.clip)) > PRESENT, `min ${Math.min(...during.map((p) => p.clip)).toFixed(0)} dB`);
check('mic keeps flowing to the receiver during the clip (400 Hz)', Math.min(...during.map((p) => p.mic)) > PRESENT, `min ${Math.min(...during.map((p) => p.mic)).toFixed(0)} dB`);
check('clip stops by itself (silent at receiver after ~6 s)', Math.max(...after.map((p) => p.clip)) < ABSENT, `max ${Math.max(...after.map((p) => p.clip)).toFixed(0)} dB`);
check('mic still flowing after the clip', Math.min(...after.map((p) => p.mic)) > PRESENT, `min ${Math.min(...after.map((p) => p.mic)).toFixed(0)} dB`);
check("Meet's original mic track restored on the sender", await senderIsMic());
check("playback-ended reported 'completed'", ev.some((e) => e.type === 'playback-ended' && e.reason === 'completed'));
check('sender-side stats reported sending-verified', ev.some((e) => e.type === 'routing' && e.state === 'sending-verified'), ev.find((e) => e.type === 'routing')?.detail);

// ---- scenario 2: muted ---------------------------------------------------------------------------
console.log('\n[2] Muted user is never un-muted and nothing plays');
await setMicEnabled(false);
await play();
await sleep(800);
ev = await events();
const muted = ev.find((e) => e.type === 'play-result');
check("play refused with reason 'muted'", muted && muted.ok === false && muted.reason === 'muted', muted?.message);
check('sender track untouched', await senderIsMic());
check('mic still disabled (not force-unmuted)', await page.evaluate(() => window.__h.micTrack.enabled === false));
await setMicEnabled(true);

// ---- scenario 3: emergency stop ------------------------------------------------------------------
console.log('\n[3] Emergency stop');
series = page.evaluate(() => window.__measure(4500));
await sleep(300);
await play({ durationSec: 8 });
await sleep(1800);
await page.evaluate(() => window.__send({ type: 'stop', reason: 'user-stop' }));
const s3 = await series;
ev = await events();
check("playback-ended reported 'user-stop'", ev.some((e) => e.type === 'playback-ended' && e.reason === 'user-stop'));
check('receiver silent at 1500 Hz shortly after stop', Math.max(...s3.filter((p) => p.t > 3300).map((p) => p.clip)) < ABSENT);
check('mic track restored after stop', await senderIsMic());

// ---- scenario 4: user mutes mid-clip -------------------------------------------------------------
console.log('\n[4] User mutes during the clip');
await play({ durationSec: 8 });
await sleep(1500);
await setMicEnabled(false);
await sleep(1200);
ev = await events();
check("clip stopped with reason 'muted-during-playback'", ev.some((e) => e.type === 'playback-ended' && e.reason === 'muted-during-playback'));
check('mic track restored after mute', await senderIsMic());
await setMicEnabled(true);

// ---- scenario 5: Meet swaps its own track mid-clip -----------------------------------------------
console.log('\n[5] Meet calls replaceTrack during the clip (e.g. device change)');
await play({ durationSec: 8 });
await sleep(1500);
await page.evaluate(() => window.__h.sender.replaceTrack(window.__h.micTrack)); // "Meet" takes the sender back
await sleep(500);
ev = await events();
check("backed off with reason 'replaced-by-meet'", ev.some((e) => e.type === 'playback-ended' && e.reason === 'replaced-by-meet'));
check("Meet's track is on the sender (we did not fight it)", await senderIsMic());

// ---- scenario 6: no double playback ----------------------------------------------------------------
console.log('\n[6] Duplicate play requests');
await play({ durationSec: 5, requestId: 10 });
await page.evaluate(() => window.__send({ type: 'play', requestId: 11, source: 'auto', volume: 1, durationSec: 5, fadeMs: 300, monitor: false }));
await sleep(700);
ev = await events();
const second = ev.find((e) => e.type === 'play-result' && e.requestId === 11);
check("second concurrent play rejected as 'already-playing'", second && second.ok === false && second.reason === 'already-playing');
await page.evaluate(() => window.__send({ type: 'stop', reason: 'user-stop' }));
await sleep(500);

// ---- scenario 7: audio resources released -------------------------------------------------------------
console.log('\n[7] Cleanup');
await sleep(500);
check('mic track restored at the end', await senderIsMic());

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('Failed:', failed.map((f) => f.name).join('; '));
  process.exit(1);
}
