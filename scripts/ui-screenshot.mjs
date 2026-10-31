// Renders the built popup/options pages in headless Chrome with a mocked chrome.* API and saves
// screenshots to ./screenshots. Also exercises the real upload path (decode -> normalise -> IndexedDB).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'screenshots');
mkdirSync(out, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// a 12 s two-note test clip as WAV
const rate = 44100;
const n = rate * 12;
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
const stereo = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) {
  const t = i / rate;
  const env = Math.abs(Math.sin(Math.PI * t * 1.5)) * (t < 4 ? 0.3 : 0.9);
  const v = Math.round(env * Math.sin(2 * Math.PI * (t < 6 ? 330 : 523) * t) * 30000);
  stereo.writeInt16LE(v, i * 4); stereo.writeInt16LE(v, i * 4 + 2);
}
const wavPath = join(mkdtempSync(join(tmpdir(), 'me-ui-')), 'victory-theme.wav');
writeFileSync(wavPath, Buffer.concat([buf.subarray(0, 44), stereo]).subarray(0, 44 + n * 4));
// fix header sizes for 2-channel data
const full = readFileSync(wavPath);
full.writeUInt32LE(36 + n * 4, 4); full.writeUInt32LE(n * 4, 40);
writeFileSync(wavPath, full);

const chromeMock = (statusJson) => `
  const mk = () => { const d = {}; const ls = new Set(); return { d, ls }; };
  const areas = { local: mk(), session: mk() };
  const fire = (area, key, newValue) => areas.session.ls.forEach(() => {}) || window.__ls.forEach((cb) => cb({ [key]: { newValue } }, area));
  window.__ls = new Set();
  const area = (name) => ({
    get: async (k) => (typeof k === 'string' ? (k in areas[name].d ? { [k]: areas[name].d[k] } : {}) : { ...areas[name].d }),
    set: async (o) => { Object.assign(areas[name].d, o); for (const k in o) fire(name, k, o[k]); },
  });
  window.chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (cb) => window.__ls.add(cb), removeListener: (cb) => window.__ls.delete(cb) } },
    runtime: { id: 'mock', openOptionsPage() {}, sendMessage: async () => ({ ok: true }) },
    tabs: { sendMessage: async () => ({ ok: true }) },
  };
  ${statusJson ? `areas.session.d['meetentry.tabStatus'] = { '1': ${statusJson} };` : ''}
`;

const status = JSON.stringify({
  tabId: 1, meetingState: 'joined', meetCode: 'abc-defg-hij',
  peers: { count: 1, connected: true, audioSender: true, micMuted: false },
  playback: 'idle', routing: { state: 'sending-verified', detail: 'Sender stats: 18711 audio bytes sent, peak level 0.87 while the clip played.' },
  lastEvent: { level: 'info', message: 'Entrance finished.', at: Date.now() }, injectionConnected: true, updatedAt: Date.now(),
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
const ctx = await browser.newContext({ viewport: { width: 380, height: 700 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.addInitScript(chromeMock(null));
await page.goto(`${base}/popup.html`);
await page.waitForSelector('.dropzone');
await page.screenshot({ path: join(out, 'popup-empty.png'), fullPage: true });

await page.setInputFiles('input[type=file]', wavPath);
await page.waitForSelector('canvas.waveform', { timeout: 15000 });
await page.evaluate((s) => window.chrome.storage.session.set({ 'meetentry.tabStatus': { 1: JSON.parse(s) } }), status);
await page.evaluate(() => window.chrome.storage.local.get().then((v) => window.chrome.storage.local.set({ 'meetentry.settings': { ...v['meetentry.settings'], enabled: true, displayName: 'Alex' } })));
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, 'popup-configured.png'), fullPage: true });

const settings = await page.evaluate(() => window.chrome.storage.local.get());
console.log('stored settings:', JSON.stringify(settings['meetentry.settings']));

const opt = await ctx.newPage();
await opt.setViewportSize({ width: 760, height: 900 });
await opt.addInitScript(chromeMock(status));
await opt.goto(`${base}/options.html`);
await opt.waitForSelector('.options');
await opt.screenshot({ path: join(out, 'options.png'), fullPage: true });

console.log(errors.length ? `console/page errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
server.close();
