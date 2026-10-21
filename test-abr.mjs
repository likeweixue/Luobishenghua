// ABR 解析自检：手工构造 v2 与 v6 格式文件 → 解析验证
const { readABR } = await import('./js/abr.js');

function utf16be(s) {
  const a = new Uint8Array(s.length * 2 + 2);
  for (let i = 0; i < s.length; i++) { a[i * 2] = s.charCodeAt(i) >> 8; a[i * 2 + 1] = s.charCodeAt(i) & 255; }
  return { bytes: a, chars: s.length + 1 }; // +1 含终止符
}
class W {
  constructor() { this.c = []; }
  u32(x) { this.c.push([(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]); }
  u16(x) { this.c.push([(x >>> 8) & 255, x & 255]); }
  u8(x) { this.c.push([x & 255]); }
  bytes(a) { this.c.push([...a]); }
  str(s) { this.c.push([...s].map(c => c.charCodeAt(0))); }
  out() { return Uint8Array.from(this.c.flat()); }
}
// 单行 PackBits：整行同一灰度
function rleRow(w, gray) {
  const out = [];
  let left = w;
  while (left > 0) { const run = Math.min(128, left); out.push(257 - run, gray); left -= run; }
  return out;
}

/* ---- 构造 v2 文件：一个 RLE 笔尖 + 一个 raw 笔尖 ---- */
const vw = new W();
vw.u16(2); vw.u16(2); // version 2, 2 个笔刷
// brush1: RLE, 10x6, 灰度交替行
{
  const W1 = 10, H1 = 6;
  const payload = new W();
  payload.u32(0); payload.u16(25); // misc, spacing 25%
  const nm = utf16be('水墨笔刷A');
  payload.u32(nm.chars); payload.bytes(nm.bytes);
  payload.u8(1); // aa
  for (let i = 0; i < 4; i++) payload.u16(0); // short bounds
  payload.u32(0); payload.u32(0); payload.u32(H1); payload.u32(W1); // long bounds
  payload.u16(8); payload.u8(1); // depth, RLE
  const rows = [];
  for (let y = 0; y < H1; y++) rows.push(rleRow(W1, y % 2 === 0 ? 0 : 255));
  for (const row of rows) payload.u16(row.length);
  for (const row of rows) payload.bytes(row);
  const pb = payload.out();
  vw.u16(2); vw.u32(pb.length); vw.bytes(pb);
}
// brush2: raw, 4x4
{
  const W2 = 4, H2 = 4;
  const payload = new W();
  payload.u32(0); payload.u16(0);
  payload.u32(1); payload.bytes([0, 0]); // 空名（1 个终止符）
  payload.u8(1);
  for (let i = 0; i < 4; i++) payload.u16(0);
  payload.u32(0); payload.u32(0); payload.u32(H2); payload.u32(W2);
  payload.u16(8); payload.u8(0); // raw
  const raw = new Uint8Array(16).fill(128);
  raw[0] = 0; raw[15] = 255; // 左上角纯黑，右下角纯白
  payload.bytes(raw);
  const pb = payload.out();
  vw.u16(2); vw.u32(pb.length); vw.bytes(pb);
}
const v2 = readABR(vw.out().buffer);

let ok = true;
function assert(cond, msg) { if (!cond) { ok = false; console.error('✗', msg); } else console.log('✓', msg); }

assert(v2.brushes.length === 2, 'v2: 解析出 2 个笔刷');
assert(v2.brushes[0].name === '水墨笔刷A', 'v2: 中文笔刷名: ' + v2.brushes[0].name);
assert(v2.brushes[0].width === 10 && v2.brushes[0].height === 6, 'v2: 尺寸 10x6');
assert(v2.brushes[0].alpha[0] === 255, 'v2: RLE 首行黑色→alpha 255');
assert(v2.brushes[0].alpha[10] === 0, 'v2: 次行白色→alpha 0');
assert(Math.abs(v2.brushes[0].spacingRatio - 0.25) < 0.001, 'v2: spacing 25% → 0.25');
assert(v2.brushes[1].alpha[0] === 255 && v2.brushes[1].alpha[15] === 0, 'v2: raw 笔尖像素正确');

/* ---- 构造 v6 文件：samp 段一个笔尖 ---- */
const mw = new W();
mw.u16(6); mw.u16(2); // version 6 subversion 2
{
  const W3 = 5, H3 = 3;
  const entry = new W();
  const uuid = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'; // 36 字符
  entry.u8(36); entry.str(uuid);
  for (let i = 0; i < 264; i++) entry.u8(0); // subversion2 前导
  entry.u32(0); entry.u32(0); entry.u32(H3); entry.u32(W3);
  entry.u16(8); entry.u8(1); // depth 8, RLE
  const rows = [];
  for (let y = 0; y < H3; y++) rows.push(rleRow(W3, y === 1 ? 0 : 255));
  for (const row of rows) entry.u16(row.length);
  for (const row of rows) entry.bytes(row);
  let eb = entry.out();
  const elen = eb.length;
  // 4 字节对齐
  const pad = (4 - (elen % 4)) % 4;
  const epad = new Uint8Array(elen + pad);
  epad.set(eb);

  const samp = new W();
  samp.u32(elen);
  samp.bytes(eb);
  samp.bytes(new Uint8Array(pad));
  const sb = samp.out();
  const spad = (4 - (sb.length % 4)) % 4;

  mw.str('8BIM'); mw.str('samp'); mw.u32(sb.length);
  mw.bytes(sb);
  mw.bytes(new Uint8Array(spad));
}
const v6 = readABR(mw.out().buffer);
assert(v6.brushes.length === 1, 'v6: samp 段解析出 1 个笔尖');
assert(v6.brushes[0].width === 5 && v6.brushes[0].height === 3, 'v6: 尺寸 5x3');
assert(v6.brushes[0].alpha[5] === 255, 'v6: 中间行黑色→alpha 255');
assert(v6.brushes[0].alpha[0] === 0, 'v6: 首行白色→alpha 0');

console.log(ok ? '\nABR 自检全部通过 ✅' : '\n存在失败 ❌');
process.exit(ok ? 0 : 1);
