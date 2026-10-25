// Generates the PNG icons (green rounded square with a white check mark) for the
// extension and the desktop app. No dependencies: writes PNGs by hand with zlib.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GREEN = [22, 163, 74];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Returns [r,g,b,a] for a point in unit coordinates.
function sample(x, y, { mono }) {
  const r = 0.22; // corner radius
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const inside = Math.hypot(x - cx, y - cy) <= r;
  const check =
    Math.min(
      distToSegment(x, y, 0.27, 0.52, 0.43, 0.68),
      distToSegment(x, y, 0.43, 0.68, 0.75, 0.34),
    ) < 0.075;
  if (mono) return check ? [0, 0, 0, 255] : [0, 0, 0, 0]; // macOS template tray icon
  if (!inside) return [0, 0, 0, 0];
  return check ? [255, 255, 255, 255] : [...GREEN, 255];
}

function png(size, opts = {}) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const p = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opts);
          acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3];
      raw[o] = a ? acc[0] / a : 0;
      raw[o + 1] = a ? acc[1] / a : 0;
      raw[o + 2] = a ? acc[2] / a : 0;
      raw[o + 3] = a / (SS * SS);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(path, buf) {
  mkdirSync(dirname(fileURLToPath(path)), { recursive: true });
  writeFileSync(path, buf);
}

const root = new URL('..', import.meta.url);
for (const s of [16, 32, 48, 128]) write(new URL(`extension/icons/icon${s}.png`, root), png(s));
write(new URL('app/build/icon.png', root), png(512));
write(new URL('app/assets/tray.png', root), png(16));
write(new URL('app/assets/tray@2x.png', root), png(32));
write(new URL('app/assets/trayTemplate.png', root), png(16, { mono: true }));
write(new URL('app/assets/trayTemplate@2x.png', root), png(32, { mono: true }));
console.log('Icons written.');
