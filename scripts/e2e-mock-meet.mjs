// Phase 2/4/5 verification: runs the REAL content script + injected script against a mock Google Meet
// page (pre-join screen -> "Join now" -> in-call UI with "Leave call" and a connected WebRTC peer)
// and checks the acceptance behaviour that is testable without Google: single play per entry,
// no play in the waiting room, cooldown, disabled switch, mute respect, leave stops audio.
//
// The content script's chrome.* API is mocked (settings, clip, status capture). The receiving side
// is a second RTCPeerConnection analysing the audio it receives, as in loopback-test.mjs.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_MEDIA_ARGS, findChrome, tone, wav16 } from './lib/testAudio.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const injected = join(root, 'dist', 'injected.js');
const content = join(root, 'dist', 'content.js');
if (!existsSync(injected) || !existsSync(content)) {
  console.error('Run `npm run build` first.');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'meetentry-e2e-'));
const micFile = join(tmp, 'mic.wav');
writeFileSync(micFile, wav16(tone(400, 4, 0.3), 48000));
const clipB64 = wav16(tone(1500, 8, 0.7), 48000).toString('base64');

const settings0 = {
  enabled: true, displayName: '', email: '', volume: 1, durationSec: 5, startOffsetSec: 0, cooldownSec: 30,
  fadeMs: 300, monitorLocally: false, clipId: 'clip-1', clipName: 'test.wav', clipLengthSec: 8,
};

const chromeMock = `
  window.__settings = ${JSON.stringify(settings0)};
  window.__statuses = [];
  window.chrome = {
    runtime: {
      id: 'mock',
      sendMessage: async (msg) => {
        if (msg.t === 'status') { window.__statuses.push(msg.status); return { ok: true }; }
        if (msg.t === 'get-clip') return { ok: true, clipId: msg.clipId, wavBase64: ${JSON.stringify(clipB64)} };
      },
      onMessage: { addListener: (cb) => (window.__cmd = cb) },
    },
    storage: {
      local: { get: async () => ({ 'meetentry.settings': window.__settings }) },
      onChanged: { addListener: (cb) => (window.__onSettings = cb) },
    },
  };
`;

const meetPage = `<!doctype html><html><body><div id="screen"><button id="join">Join now</button></div>
<script>
  let calls = [];
  window.__startCall = async ({ muted = false, leaveDelay = 0 } = {}) => {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = mic.getAudioTracks()[0];
    if (muted) track.enabled = false;
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    a.addTrack(track, mic);
    const got = new Promise((res) => (b.ontrack = (e) => res(e.streams[0] ?? new MediaStream([e.track]))));
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    await Promise.all([a, b].map((pc) => new Promise((r) => { if (pc.connectionState === 'connected') return r(); pc.onconnectionstatechange = () => pc.connectionState === 'connected' && r(); })));
    const remote = await got;
    const el = new Audio(); el.srcObject = remote; el.volume = 0.01; await el.play().catch(() => {});
    const ctx = new AudioContext(); await ctx.resume();
    const an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(remote).connect(an);
    const bins = new Float32Array(an.frequencyBinCount);
    const dbAt = (hz) => { const i = Math.round(hz / ctx.sampleRate * an.fftSize); let m = -Infinity; for (let k = i - 2; k <= i + 2; k++) m = Math.max(m, bins[k]); return m; };
    window.__measure = (ms) => new Promise((res) => { const out = [], t0 = performance.now();
      const id = setInterval(() => { an.getFloatFrequencyData(bins); out.push({ t: Math.round(performance.now() - t0), mic: dbAt(400), clip: dbAt(1500) });
        if (performance.now() - t0 >= ms) { clearInterval(id); res(out); } }, 100); });
    calls.push({ a, b, ctx, el, track });
    window.__track = track;
    const showLeave = () => { document.getElementById('screen').innerHTML = '<button aria-label="Leave call"><i class="google-material-icons">call_end</i></button>'; };
    leaveDelay ? setTimeout(showLeave, leaveDelay) : showLeave();
  };
  window.__leave = () => {
    calls.forEach(({ a, b, ctx, el, track }) => { a.close(); b.close(); ctx.close(); el.srcObject = null; track.stop(); });
    calls = [];
    document.getElementById('screen').innerHTML = '<h1>You left the meeting</h1><button>Rejoin</button>';
  };
</script></body></html>`;

const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: FAKE_MEDIA_ARGS(micFile) });
const context = await browser.newContext({ permissions: ['microphone'] });
await context.addInitScript({ content: chromeMock });
await context.addInitScript({ content: readFileSync(injected, 'utf8') });
await context.addInitScript({ content: readFileSync(content, 'utf8') });
const page = await context.newPage();
await page.route('https://meet.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: meetPage }));
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto('https://meet.google.com/abc-defg-hij');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};
const last = () => page.evaluate(() => window.__statuses.at(-1));
const playingStarts = () =>
  page.evaluate(() => window.__statuses.filter((s, i, arr) => s.playback === 'playing' && arr[i - 1]?.playback !== 'playing').length);
const setSettings = (patch) =>
  page.evaluate((p) => {
    window.__settings = { ...window.__settings, ...p };
    window.__onSettings({ 'meetentry.settings': { newValue: window.__settings } }, 'local');
  }, patch);
const PRESENT = -55, ABSENT = -75;
const max = (a) => Math.max(...a), min = (a) => Math.min(...a);

// ---- pre-join --------------------------------------------------------------------------------
console.log('[1] Pre-join screen');
await sleep(1800);
let s = await last();
check('detected pre-join state', s?.meetingState === 'preJoin', s?.meetingState);
check('injected script connected to content script', s?.injectionConnected === true);
check('nothing played before joining', (await playingStarts()) === 0);

// ---- entering: media connects first, leave control appears 2 s later ----------------------------
console.log('\n[2] Join (media connects before the in-call UI appears)');
await page.evaluate(() => window.__startCall({ leaveDelay: 2000 }));
const series = await page.evaluate(() => window.__measure(11500));
s = await last();
const early = series.filter((p) => p.t < 2200);
const mid = series.filter((p) => p.t > 4200 && p.t < 6800);
const late = series.filter((p) => p.t > 9500);
check('state is joined', s?.meetingState === 'joined', s?.meetingState);
check('no music while only media was connected (no in-call UI yet)', max(early.map((p) => p.clip)) < ABSENT, `${max(early.map((p) => p.clip)).toFixed(0)} dB`);
check('RECEIVER hears the entrance clip after entry', min(mid.map((p) => p.clip)) > PRESENT, `${min(mid.map((p) => p.clip)).toFixed(0)} dB`);
check('microphone keeps flowing during the clip', min(mid.map((p) => p.mic)) > PRESENT, `${min(mid.map((p) => p.mic)).toFixed(0)} dB`);
check('clip ends after the configured 5 s', max(late.map((p) => p.clip)) < ABSENT, `${max(late.map((p) => p.clip)).toFixed(0)} dB`);
check('exactly one play for this entry', (await playingStarts()) === 1, String(await playingStarts()));
s = await last();
check('routing reports sender-side verification', s?.routing?.state === 'sending-verified', s?.routing?.detail);
check('playback state returned to idle', s?.playback === 'idle');
await sleep(5000);
check('still exactly one play 5 s later (no duplicates)', (await playingStarts()) === 1);

// ---- leave -----------------------------------------------------------------------------------
console.log('\n[3] Leave, then rejoin within the cooldown');
await page.evaluate(() => window.__leave());
await sleep(2600);
s = await last();
// ("left" is transient: Meet's post-call screen has a Rejoin button, which returns us to preJoin)
check('no longer treated as in the meeting after leaving', s?.meetingState === 'left' || s?.meetingState === 'preJoin', s?.meetingState);
await page.evaluate(() => window.__startCall());
await sleep(4000);
s = await last();
check('rejoined: state is joined again', s?.meetingState === 'joined');
check('no second play while cooldown (30 s) is active', (await playingStarts()) === 1);
check('user told why', /cooldown/i.test(s?.lastEvent?.message ?? ''), s?.lastEvent?.message);

// ---- disabled -----------------------------------------------------------------------------------
console.log('\n[4] Extension switched off');
await page.evaluate(() => window.__leave());
await sleep(2600);
await setSettings({ enabled: false, cooldownSec: 0 });
await page.evaluate(() => window.__startCall());
await sleep(4000);
s = await last();
check('disabled: nothing plays on entry', (await playingStarts()) === 1);
check('disabled: reported as turned off', /turned off/i.test(s?.lastEvent?.message ?? ''), s?.lastEvent?.message);

// ---- muted at entry -----------------------------------------------------------------------------
console.log('\n[5] Joining while muted');
await page.evaluate(() => window.__leave());
await sleep(2600);
await setSettings({ enabled: true, cooldownSec: 0 });
await page.evaluate(() => window.__startCall({ muted: true }));
await sleep(4000);
s = await last();
check('muted: nothing plays', (await playingStarts()) === 1);
check('muted: user is told it was skipped', s?.lastEvent?.level === 'warn' && /muted/i.test(s.lastEvent.message), s?.lastEvent?.message);
check('muted: mic was NOT force-unmuted', await page.evaluate(() => window.__track.enabled === false));
check('muted: status shows muted mic', s?.peers?.micMuted === true);

// ---- re-entry plays again (cooldown 0), and leaving mid-clip stops audio --------------------------
console.log('\n[6] New entry plays again; leaving mid-clip stops it');
await page.evaluate(() => window.__leave());
await sleep(2600);
await page.evaluate(() => window.__startCall());
await sleep(3500); // ~1.5-2.5 s into the clip
check('new entry plays (2nd play overall)', (await playingStarts()) === 2, String(await playingStarts()));
s = await last();
check('status shows playing', s?.playback === 'playing');
await page.evaluate(() => window.__leave());
await sleep(1500);
s = await last();
check('leaving mid-clip ends playback', s?.playback === 'idle', `${s?.playback} / ${s?.lastEvent?.message}`);
await sleep(2500);
check('no stray playback after leaving', (await playingStarts()) === 2);

// ---- manual replay + stop via popup commands ------------------------------------------------------
console.log('\n[7] Popup commands (replay / emergency stop)');
await page.evaluate(() => window.__startCall());
await sleep(1000); // entry not yet stable: manual replay allowed once media is up
await page.evaluate(() => window.__cmd({ t: 'replay' }, { id: 'mock' }, () => {}));
await sleep(1200);
s = await last();
check('manual replay starts playback', s?.playback === 'playing', s?.lastEvent?.message);
await page.evaluate(() => window.__cmd({ t: 'stop' }, { id: 'mock' }, () => {}));
await sleep(600);
s = await last();
check('emergency stop ends playback', s?.playback === 'idle', s?.lastEvent?.message);
const rejected = await page.evaluate(() => window.__cmd({ t: 'replay' }, { id: 'evil-extension' }, () => {}));
check('commands from other senders are ignored', rejected === false);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('Failed:', failed.map((f) => f.name).join('; '));
  process.exit(1);
}
