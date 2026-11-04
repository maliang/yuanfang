// Generates the app and tray icons without external image tools.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size);
      const offset = y * (stride + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const appIcon = png(1024, (x, y, size) => {
  const cx = size / 2;
  const cy = size / 2;
  const distance = Math.hypot(x - cx, y - cy) / (size / 2);
  if (distance > 0.94) return [0, 0, 0, 0];
  const angle = Math.atan2(y - cy, x - cx);
  const glow = 0.5 + 0.5 * Math.cos(angle * 2);
  const r = Math.round(96 + glow * 70);
  const g = Math.round(118 + glow * 60);
  const b = Math.round(255 - glow * 40);
  if (distance > 0.9) return [r, g, b, 40];
  // Inner ring and star: an abstract compass pointing outward.
  const ring = Math.abs(distance - 0.55) < 0.035;
  const spoke = Math.abs(Math.sin(angle * 2)) < 0.12 && distance < 0.62 && distance > 0.18;
  const center = distance < 0.1;
  if (ring || spoke || center) {
    const alpha = ring ? 235 : 210;
    return [250, 251, 255, alpha];
  }
  const vignette = Math.round(18 + (1 - distance) * 18);
  return [vignette, vignette + 6, vignette + 26, 255];
});

const tray = png(64, (x, y, size) => {
  const cx = size / 2;
  const cy = size / 2;
  const distance = Math.hypot(x - cx, y - cy) / (size / 2);
  const angle = Math.atan2(y - cy, x - cx);
  const ring = Math.abs(distance - 0.66) < 0.07;
  const spoke = Math.abs(Math.sin(angle * 2)) < 0.16 && distance < 0.7 && distance > 0.2;
  const center = distance < 0.16;
  return ring || spoke || center ? [0, 0, 0, 255] : [0, 0, 0, 0];
});

writeFileSync(join(here, "icon.png"), appIcon);
writeFileSync(join(here, "trayTemplate.png"), tray);
writeFileSync(join(here, "trayTemplate@2x.png"), png(128, (x, y, size) => {
  const cx = size / 2;
  const cy = size / 2;
  const distance = Math.hypot(x - cx, y - cy) / (size / 2);
  const angle = Math.atan2(y - cy, x - cx);
  const ring = Math.abs(distance - 0.66) < 0.07;
  const spoke = Math.abs(Math.sin(angle * 2)) < 0.16 && distance < 0.7 && distance > 0.2;
  const center = distance < 0.16;
  return ring || spoke || center ? [0, 0, 0, 255] : [0, 0, 0, 0];
}));
console.log("icons written");
