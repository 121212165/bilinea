// T-012：扩展图标生成器（零依赖 PNG，node:zlib + 手写 CRC/编码）
// 设计：蓝→紫渐变圆角底，两枚叠放对话泡（大泡含两条透明文字缝，小泡叠右下）= 双语互译。
// 用法：node scripts/gen-icons.mjs → static/icons/itr-{16,48,128}.png
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 参数化绘制（单位坐标 [0,1]） ----------
const C1 = [74, 108, 247]; // #4A6CF7
const C2 = [140, 63, 242]; // #8C3FF2

/** 圆角矩形 SDF：<=0 在内部 */
function sdfRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function bubble(px, py, cx, cy, hw, hh, r, slits) {
  if (sdfRoundRect(px, py, cx, cy, hw, hh, r) > 0) return null;
  for (const [sx, sy, shw, shh] of slits) {
    if (sdfRoundRect(px, py, sx, sy, shw, shh, shh) <= 0) return 'slit';
  }
  return 'fill';
}

/** 单点颜色：返回 [r,g,b,a] */
function shade(u, v) {
  // 底：渐变圆角方
  if (sdfRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.16) > 0) return [0, 0, 0, 0];
  const t = (u + v) / 2;
  let color = [
    Math.round(C1[0] + (C2[0] - C1[0]) * t),
    Math.round(C1[1] + (C2[1] - C1[1]) * t),
    Math.round(C1[2] + (C2[2] - C1[2]) * t),
    255,
  ];
  const mix = (a, b, k) => a.map((x, i) => Math.round(x + (b[i] - x) * k));

  // 小泡（右下，半透明白叠在渐变上）
  const b2 = bubble(u, v, 0.63, 0.70, 0.20, 0.155, 0.09, [[0.63, 0.70, 0.11, 0.024]]);
  if (b2 === 'fill') color = mix(color, [255, 255, 255], 0.72);

  // 泡尾（大泡左下小圆）
  if (Math.hypot(u - 0.185, v - 0.545) <= 0.052) color = [255, 255, 255, 255];

  // 大泡（左上，不透明白；文字缝透出底色）
  const b1 = bubble(u, v, 0.41, 0.345, 0.27, 0.215, 0.12, [
    [0.41, 0.28, 0.15, 0.03],
    [0.38, 0.425, 0.115, 0.03],
  ]);
  if (b1 === 'fill') color = [255, 255, 255, 255];

  return color;
}

function render(size) {
  const SS = 3; // 3×3 超采样抗锯齿
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca] = shade(u, v);
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, rgba);
}

mkdirSync('static/icons', { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`static/icons/itr-${size}.png`, render(size));
  console.log(`[icons] itr-${size}.png ✓`);
}
