// icon.svg と同じ図柄の PNG アイコンを作る（外部ツールなしで、自前で塗りつぶす）。
// 図柄：青（#1a4bb3）の地に白いピン、ピンへ続く黄色（#FFE01F）の点線の経路
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x1a, 0x4b, 0xb3];
const WHITE = [0xff, 0xff, 0xff];
const YELLOW = [0xff, 0xe0, 0x1f];

// たどった経路の点線（icon.svg の path：3 次ベジェ曲線を、太さ 22・点 2・間 44 の丸い点線で描いたもの）の点の中心
const ROUTE = [[132, 404], [170, 330], [250, 380], [262, 318]];
const DOTS = (() => {
  const at = (t) => {
    const u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map((i) => k.reduce((sum, w, j) => sum + w * ROUTE[j][i], 0));
  };
  const dots = [];
  let len = 0;
  let next = 1; // 点（長さ 2）の中心までの道のり
  let prev = at(0);
  for (let n = 1; n <= 4000; n++) {
    const p = at(n / 4000);
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    if (len >= next) {
      dots.push(p);
      next += 46;
    }
    prev = p;
  }
  return dots;
})();

// ピンの幅（icon.svg の path と同じ曲線）。左右対称なので、左半分の輪郭（上端 (300,96) → 左端 (200,196) → 先端 (300,360)）から、
// 高さごとの中心（x = 300）からの幅を表にしておく
const PIN_TOP = 96;
const PIN_TIP = 360;
const PIN_HALF = (() => {
  const cubic = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [0, 1].map((i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
  };
  const pts = [];
  for (let n = 0; n <= 2000; n++) pts.push(cubic([300, 96], [244, 96], [200, 140], [200, 196], n / 2000));
  for (let n = 1; n <= 2000; n++) pts.push(cubic([200, 196], [200, 268], [300, 360], [300, 360], n / 2000));
  const table = [];
  let k = 0;
  for (let y = PIN_TOP; y <= PIN_TIP; y += 0.1) {
    while (k < pts.length - 2 && pts[k + 1][1] < y) k++;
    const [a, b] = [pts[k], pts[k + 1]];
    const x = b[1] === a[1] ? a[0] : a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
    table.push(300 - x);
  }
  return (y) => (y < PIN_TOP || y > PIN_TIP ? -1 : table[Math.min(table.length - 1, Math.round((y - PIN_TOP) * 10))]);
})();

// 512 基準の座標で、その点の色を返す（null は透明）
function colorAt(x, y, maskable) {
  if (!maskable) {
    const r = 96;
    const cx = Math.min(Math.max(x, r), 512 - r);
    const cy = Math.min(Math.max(y, r), 512 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  }
  // maskable は図柄を小さめにして安全領域に収める（地は四隅まで塗る）
  const s = maskable ? 0.8 : 1;
  const px = 256 + (x - 256) / s;
  const py = 256 + (y - 256) / s;
  // ピン（穴は (300,196) を中心とする半径 38 の円）
  if (Math.abs(px - 300) <= PIN_HALF(py)) return (px - 300) ** 2 + (py - 196) ** 2 <= 38 * 38 ? BLUE : WHITE;
  // 経路：出発点（半径 22）と点線の点（半径 11）。ピンの下に隠れる点はピンが上に描かれる
  if ((px - 132) ** 2 + (py - 404) ** 2 <= 22 * 22) return YELLOW;
  if (DOTS.some(([dx, dy]) => (px - dx) ** 2 + (py - dy) ** 2 <= 11.5 * 11.5)) return YELLOW;
  return BLUE;
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
