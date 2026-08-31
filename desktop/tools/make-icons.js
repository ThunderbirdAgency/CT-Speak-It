/**
 * Generates Mockingbird's icon assets — no design tool, no binary blobs in the
 * repo that nobody can regenerate. Run `npm run icons` after changing anything
 * here; the PNGs it writes are committed so a fresh clone builds immediately.
 *
 *   assets/trayTemplate.png / @2x  macOS menu bar (template image: black+alpha,
 *                                  macOS recolors it for light/dark automatically)
 *   assets/tray.png                Windows/Linux tray
 *   assets/icon.png                512×512 app/installer icon
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------------ png out

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
  console.log('wrote', path.relative(process.cwd(), file));
}

// ------------------------------------------------------------- tiny raster
// Everything is drawn from signed-distance shapes and supersampled 4×4, which
// is all a microphone glyph needs and keeps this file dependency-free.

const SS = 4;

function render(size, shade) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          const c = shade(px, py);
          if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = a ? Math.round(r / a) : 0;
      rgba[i + 1] = a ? Math.round(g / a) : 0;
      rgba[i + 2] = a ? Math.round(b / a) : 0;
      rgba[i + 3] = Math.round((a / n) * 255);
    }
  }
  return rgba;
}

// Rounded capsule (the mic body), in 0..1 space.
function inCapsule(x, y, cx, top, bottom, halfW) {
  if (Math.abs(x - cx) > halfW) return false;
  if (y >= top + halfW && y <= bottom - halfW) return true;
  const cy = y < top + halfW ? top + halfW : bottom - halfW;
  return Math.hypot(x - cx, y - cy) <= halfW;
}

// The U-shaped cradle under the capsule.
function inCradle(x, y, cx, cy, radius, thickness) {
  const d = Math.hypot(x - cx, y - cy);
  return y >= cy && Math.abs(d - radius) <= thickness / 2;
}

/** The Mockingbird mark: a microphone with its cradle and stand. */
function micGlyph(color) {
  return (x, y) => {
    const cx = 0.5;
    if (inCapsule(x, y, cx, 0.16, 0.56, 0.13)) return color;
    if (inCradle(x, y, cx, 0.5, 0.24, 0.055)) return color;
    // stand
    if (Math.abs(x - cx) <= 0.035 && y >= 0.74 && y <= 0.86) return color;
    // base
    if (Math.abs(x - cx) <= 0.15 && y >= 0.83 && y <= 0.885) return color;
    return null;
  };
}

function withRoundedBackground(size, glyph, inset) {
  return (x, y) => {
    // rounded square with a subtle vertical gradient
    const r = 0.22;
    const inside = (() => {
      const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
      const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
      return Math.hypot(dx, dy) <= r;
    })();
    if (!inside) return null;
    const gx = (x - inset) / (1 - 2 * inset);
    const gy = (y - inset) / (1 - 2 * inset);
    if (gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1) {
      const fg = glyph(gx, gy);
      if (fg) return fg;
    }
    const t = y;
    return [
      Math.round(30 - t * 14),
      Math.round(37 - t * 17),
      Math.round(46 - t * 22),
      1
    ];
  };
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

// macOS template images must be black + alpha; the OS tints them.
writePng(path.join(outDir, 'trayTemplate.png'), 16, render(16, micGlyph([0, 0, 0, 1])));
writePng(path.join(outDir, 'trayTemplate@2x.png'), 32, render(32, micGlyph([0, 0, 0, 1])));
// Windows/Linux trays draw the icon as-is; a dark glyph reads on both themes
// with a light halo behind it.
writePng(path.join(outDir, 'tray.png'), 32, render(32, micGlyph([32, 38, 46, 1])));
writePng(path.join(outDir, 'tray@2x.png'), 64, render(64, micGlyph([32, 38, 46, 1])));
// App / installer icon.
writePng(path.join(outDir, 'icon.png'), 512,
  render(512, withRoundedBackground(512, micGlyph([232, 236, 241, 1]), 0.17)));
