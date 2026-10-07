// icon.svg と同じ図柄の PNG アイコンを作る（外部ツールなしで、自前で塗りつぶす）
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x1a, 0x73, 0xe8];
const WHITE = [0xff, 0xff, 0xff];

// 512 基準の座標で、その点の色を返す（null は透明）
function colorAt(x, y, maskable) {
  if (!maskable) {
    const r = 96;
    const cx = Math.min(Math.max(x, r), 512 - r);
    const cy = Math.min(Math.max(y, r), 512 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  }
  // maskable は図柄を小さめにして安全領域に収める
  const s = maskable ? 0.8 : 1;
  const px = 256 + (x - 256) / s;
  const py = 256 + (y - 256) / s;
  const inHole = (px - 256) ** 2 + (py - 218) ** 2 <= 48 * 48;
  const inHead = (px - 256) ** 2 + (py - 218) ** 2 <= 126 * 126;
  // 先端 (256,420) に向かってすぼまる部分
  const inTail = py >= 218 && py <= 420 && Math.abs(px - 256) <= 126 * Math.sqrt(Math.max(0, (420 - py) / 202));
  return (inHead || inTail) && !inHole ? WHITE : BLUE;
}

function png(size, maskable) {
  const ss = 4; // 縁をなめらかにするための分割数
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt(((x + (sx + 0.5) / ss) * 512) / size, ((y + (sy + 0.5) / ss) * 512) / size, maskable);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0;
      raw[o + 1] = a ? g / a : 0;
      raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../src/client/public/', import.meta.url);
writeFileSync(new URL('icon-192.png', out), png(192, false));
writeFileSync(new URL('icon-512.png', out), png(512, false));
writeFileSync(new URL('icon-maskable-512.png', out), png(512, true));
console.log('icons written');
