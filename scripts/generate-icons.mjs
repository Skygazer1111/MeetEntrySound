// Generates public/icons/icon{16,48,128}.png without external dependencies.
// Design: rounded purple->blue gradient tile with white "sound wave" bars.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function render(size) {
  const SS = 4; // supersampling for smooth edges
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const bars = [0.28, 0.5, 0.72, 0.5, 0.28]; // relative heights
  const barW = size * 0.1;
  const gap = size * 0.065;
  const totalW = bars.length * barW + (bars.length - 1) * gap;
  const startX = (size - totalW) / 2;

  const inRoundRect = (x, y, w, h, r) => {
    const cx = Math.min(Math.max(x, r), w - r);
    const cy = Math.min(Math.max(y, r), h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!inRoundRect(fx, fy, size, size, radius)) continue;
          const t = clamp01((fx + fy) / (2 * size));
          let cr = lerp(124, 59, t), cg = lerp(58, 130, t), cb = lerp(237, 246, t);
          // bars
          for (let i = 0; i < bars.length; i++) {
            const bx = startX + i * (barW + gap);
            const bh = bars[i] * size * 0.8;
            const by = (size - bh) / 2;
            if (inRoundRect(fx - bx, fy - by, barW, bh, barW / 2)) {
              cr = 255; cg = 255; cb = 255;
            }
          }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const cov = a / (255 * n);
      px[i] = cov ? Math.round(r / (cov * n)) : 0;
      px[i + 1] = cov ? Math.round(g / (cov * n)) : 0;
      px[i + 2] = cov ? Math.round(b / (cov * n)) : 0;
      px[i + 3] = Math.round(cov * 255);
    }
  }
  return px;
}

function png(size) {
  const raw = render(size);
  const stride = size * 4;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(resolve(outDir, `icon${size}.png`), png(size));
  console.log(`wrote icon${size}.png`);
}
