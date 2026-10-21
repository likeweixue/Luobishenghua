// PSD 读写器：8-bit RGB/RGBA 子集（Raw + RLE PackBits 压缩）
// 支持：分层读取（名称/显隐/不透明度/混合模式/位置）、分层写入、中文图层名（luni 块）
// 不支持：16/32 位通道、CMYK/灰度、图层组（组内容会平铺为普通图层）、矢量/智能对象

const KEY_TO_BLEND = {
  'norm': 'source-over',
  'mul ': 'multiply',
  'scrn': 'screen',
  'over': 'overlay',
  'dark': 'darken',
  'ligh': 'lighten',
  'smud': 'soft-light',
  'div ': 'color-dodge',
  'lddg': 'lighter',
};
const BLEND_TO_KEY = Object.fromEntries(Object.entries(KEY_TO_BLEND).map(([k, v]) => [v, k]));

/* ---------------- 二进制读写辅助 ---------------- */

class Reader {
  constructor(buf) {
    this.v = new DataView(buf);
    this.u8 = new Uint8Array(buf);
    this.p = 0;
  }
  u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
  i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
  u16() { const x = this.v.getUint16(this.p); this.p += 2; return x; }
  i16() { const x = this.v.getInt16(this.p); this.p += 2; return x; }
  u8_() { return this.u8[this.p++]; }
  bytes(n) { const s = this.u8.slice(this.p, this.p + n); this.p += n; return s; }
  str(n) { return String.fromCharCode(...this.bytes(n)); }
  skip(n) { this.p += n; }
}

class Writer {
  constructor() { this.chunks = []; this.len = 0; }
  _push(a) { this.chunks.push(a); this.len += a.length; }
  u32(x) { this._push(new Uint8Array([(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255])); }
  i32(x) { this.u32(x >>> 0); }
  u16(x) { this._push(new Uint8Array([(x >>> 8) & 255, x & 255])); }
  i16(x) { this.u16(x & 0xffff); }
  u8_(x) { this._push(new Uint8Array([x & 255])); }
  bytes(a) { this._push(a instanceof Uint8Array ? a : new Uint8Array(a)); }
  str(s) { this._push(new Uint8Array([...s].map(c => c.charCodeAt(0)))); }
  pad(n) { if (n > 0) this._push(new Uint8Array(n)); }
  concat() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/* ---------------- PackBits RLE ---------------- */

function packBits(row) {
  const out = [];
  let i = 0;
  const n = row.length;
  while (i < n) {
    // 重复字节 → 压缩包
    if (i + 1 < n && row[i] === row[i + 1]) {
      let run = 2;
      while (i + run < n && row[i + run] === row[i] && run < 128) run++;
      out.push(257 - run, row[i]);
      i += run;
    } else {
      // 字面量包
      const start = i;
      i++;
      while (i < n && !(i + 1 < n && row[i] === row[i + 1]) && i - start < 128) i++;
      out.push(i - start - 1);
      for (let j = start; j < i; j++) out.push(row[j]);
    }
  }
  return Uint8Array.from(out);
}

function unpackBits(src, out, offset, width) {
  let i = 0;
  let o = offset;
  const end = offset + width;
  while (i < src.length && o < end) {
    let n = src[i++];
    if (n > 128) n = n - 256; // 转 int8
    if (n >= 0 && n <= 127) {
      for (let j = 0; j <= n && o < end; j++) out[o++] = src[i++];
    } else if (n >= -127 && n <= -1) {
      const b = src[i++];
      for (let j = 0; j < 1 - n && o < end; j++) out[o++] = b;
    }
    // -128 = noop
  }
}

/* ---------------- 读取 ---------------- */

export function readPSD(buffer) {
  const r = new Reader(buffer);
  if (r.str(4) !== '8BPS') throw new Error('不是 PSD 文件');
  const version = r.u16();
  if (version !== 1) throw new Error('这是 PSB（大型文档），暂不支持');
  r.skip(6);
  const channels = r.u16();
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const mode = r.u16();
  if (depth !== 8) throw new Error(`暂不支持 ${depth} 位通道（仅支持 8 位）`);
  if (mode !== 3) throw new Error('暂不支持非 RGB 颜色模式（CMYK/灰度等）');

  r.skip(r.u32()); // 颜色模式数据
  r.skip(r.u32()); // 图像资源

  const layers = [];
  const layerMaskLen = r.u32();
  const layerMaskEnd = r.p + layerMaskLen;

  if (layerMaskLen > 0) {
    const liLen = r.u32();
    if (liLen > 0) {
      let count = r.i16();
      if (count < 0) count = -count;

      const recs = [];
      for (let i = 0; i < count; i++) {
        const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
        const nch = r.u16();
        const chans = [];
        for (let c = 0; c < nch; c++) chans.push({ id: r.i16(), len: r.u32() });
        r.skip(4); // '8BIM'
        const blendKey = r.str(4);
        const opacity = r.u8_() / 255;
        r.u8_(); // clipping
        const flags = r.u8_();
        r.skip(1);
        const extraLen = r.u32();
        const extraEnd = r.p + extraLen;
        r.skip(r.u32()); // 蒙版数据
        r.skip(r.u32()); // 混合范围
        // 图层名（Pascal，MacRoman/ASCII）
        const nameLen = r.u8_();
        let name = new TextDecoder('latin1').decode(r.bytes(nameLen));
        r.skip((4 - ((1 + nameLen) % 4)) % 4);
        // 附加信息块：找 luni（Unicode 图层名）
        try {
          while (r.p + 12 <= extraEnd) {
            r.skip(4); // '8BIM' / '8B64'
            const key = r.str(4);
            const blen = r.u32();
            const bstart = r.p;
            if (key === 'luni') {
              const n = r.u32();
              const raw = r.bytes(n * 2);
              let s = '';
              for (let j = 0; j < n; j++) s += String.fromCharCode((raw[j * 2] << 8) | raw[j * 2 + 1]);
              name = s;
            }
            r.p = bstart + blen + (blen % 2 ? 1 : 0);
          }
        } catch (_) { /* 附加块解析失败就用 Pascal 名 */ }
        r.p = extraEnd;

        recs.push({
          top, left, bottom, right, chans,
          blend: KEY_TO_BLEND[blendKey] || 'source-over',
          opacity,
          visible: !(flags & 2),
          name: name || `图层 ${i + 1}`,
        });
      }

      // 通道像素数据
      for (const rec of recs) {
        const w = rec.right - rec.left;
        const h = rec.bottom - rec.top;
        rec.planes = {};
        for (const ch of rec.chans) {
          const comp = r.u16();
          const plane = new Uint8Array(Math.max(0, w * h));
          if (comp === 0) {
            plane.set(r.bytes(w * h));
          } else if (comp === 1) {
            const counts = [];
            for (let y = 0; y < h; y++) counts.push(r.u16());
            for (let y = 0; y < h; y++) unpackBits(r.bytes(counts[y]), plane, y * w, w);
          } else {
            throw new Error('未知压缩方式: ' + comp);
          }
          rec.planes[ch.id] = plane;
        }
      }

      // 合成每个图层的画布
      for (const rec of recs) {
        const w = rec.right - rec.left;
        const h = rec.bottom - rec.top;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w);
        canvas.height = Math.max(1, h);
        if (w > 0 && h > 0) {
          const img = new ImageData(w, h);
          const d = img.data;
          const R = rec.planes[0], G = rec.planes[1], B = rec.planes[2], A = rec.planes[-1];
          for (let i = 0; i < w * h; i++) {
            d[i * 4] = R ? R[i] : 0;
            d[i * 4 + 1] = G ? G[i] : 0;
            d[i * 4 + 2] = B ? B[i] : 0;
            d[i * 4 + 3] = A ? A[i] : 255;
          }
          canvas.getContext('2d').putImageData(img, 0, 0);
        }
        layers.push({
          name: rec.name,
          visible: rec.visible,
          opacity: rec.opacity,
          blend: rec.blend,
          left: rec.left,
          top: rec.top,
          canvas,
        });
      }
    }
  }
  r.p = layerMaskEnd;

  // 无图层时读取合成图像作为单图层
  let composite = null;
  if (layers.length === 0) {
    const comp = r.u16();
    const img = new ImageData(width, height);
    const d = img.data;
    const planes = [];
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(width * height);
      planes.push(plane);
      if (comp === 0) {
        plane.set(r.bytes(width * height));
      } else {
        const counts = [];
        for (let y = 0; y < height; y++) counts.push(r.u16());
        for (let y = 0; y < height; y++) unpackBits(r.bytes(counts[y]), plane, y * width, width);
      }
    }
    for (let i = 0; i < width * height; i++) {
      d[i * 4] = planes[0][i];
      d[i * 4 + 1] = planes[1] ? planes[1][i] : 0;
      d[i * 4 + 2] = planes[2] ? planes[2][i] : 0;
      d[i * 4 + 3] = planes[3] ? planes[3][i] : 255;
    }
    composite = img;
  }

  return { width, height, layers, composite };
}

/* ---------------- 写入 ---------------- */

function encodeChannelRLE(plane, w, h) {
  const counts = new Uint16Array(h);
  const parts = [];
  let dataTotal = 0;
  for (let y = 0; y < h; y++) {
    const packed = packBits(plane.subarray(y * w, (y + 1) * w));
    counts[y] = packed.length;
    parts.push(packed);
    dataTotal += packed.length;
  }
  return { counts, parts, blockLen: 2 + h * 2 + dataTotal }; // 含压缩方式字 + 行长度表
}

function splitPlanes(imageData) {
  const d = imageData.data;
  const n = imageData.width * imageData.height;
  const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = d[i * 4];
    G[i] = d[i * 4 + 1];
    B[i] = d[i * 4 + 2];
    A[i] = d[i * 4 + 3];
  }
  return [R, G, B, A];
}

// layers: [{ name, visible, opacity(0-1), blend, imageData }]，数组按「顶层在前」传入
export function writePSD({ width, height, layers, compositeImage }) {
  const w = width, h = height;

  // 预编码每个图层的通道数据
  const chanIds = [0, 1, 2, -1];
  const encoded = layers.map(l => {
    const planes = splitPlanes(l.imageData);
    return chanIds.map((id, i) => encodeChannelRLE(planes[i], w, h));
  });

  /* ---- 图层信息区 ---- */
  const li = new Writer();
  li.i16(layers.length);
  layers.forEach((l, li_idx) => {
    li.i32(0); li.i32(0); li.i32(h); li.i32(w); // 全尺寸图层
    li.u16(4);
    chanIds.forEach((id, ci) => {
      li.i16(id);
      li.u32(encoded[li_idx][ci].blockLen);
    });
    li.str('8BIM');
    li.str(BLEND_TO_KEY[l.blend] || 'norm');
    li.u8_(Math.round(l.opacity * 255));
    li.u8_(0); // clipping
    li.u8_(l.visible ? 0 : 2); // flags
    li.u8_(0); // filler

    // extra data
    const extra = new Writer();
    extra.u32(0); // 蒙版
    extra.u32(0); // 混合范围
    const ascii = (l.name || 'Layer').replace(/[^\x20-\x7E]/g, '?').slice(0, 255);
    extra.u8_(ascii.length);
    extra.str(ascii);
    extra.pad((4 - ((1 + ascii.length) % 4)) % 4);
    // luni：Unicode 图层名
    const uni = l.name || 'Layer';
    const luni = new Writer();
    luni.str('8BIM');
    luni.str('luni');
    luni.u32(4 + uni.length * 2);
    luni.u32(uni.length);
    for (let i = 0; i < uni.length; i++) luni.u16(uni.charCodeAt(i));
    if ((4 + uni.length * 2) % 2) luni.u8_(0);
    extra.bytes(luni.concat());

    li.u32(extra.len);
    li.bytes(extra.concat());
  });
  // 通道像素数据
  layers.forEach((l, li_idx) => {
    encoded[li_idx].forEach(ch => {
      li.u16(1); // RLE
      for (let y = 0; y < h; y++) li.u16(ch.counts[y]);
      for (const part of ch.parts) li.bytes(part);
    });
  });
  const liBytes = li.concat();
  const liPadded = liBytes.length % 2 ? liBytes.length + 1 : liBytes.length;

  /* ---- 合成图像（RGB 三通道 RLE）---- */
  const comp = new Writer();
  comp.u16(1);
  const compPlanes = splitPlanes(compositeImage).slice(0, 3);
  const compEncoded = compPlanes.map(p => encodeChannelRLE(p, w, h));
  for (const ch of compEncoded) for (let y = 0; y < h; y++) comp.u16(ch.counts[y]);
  for (const ch of compEncoded) for (const part of ch.parts) comp.bytes(part);

  /* ---- 组装文件 ---- */
  const out = new Writer();
  out.str('8BPS');
  out.u16(1);
  out.bytes(new Uint8Array(6));
  out.u16(3); // 合成图通道数 RGB
  out.u32(h);
  out.u32(w);
  out.u16(8);
  out.u16(3); // RGB
  out.u32(0); // 颜色模式数据
  out.u32(0); // 图像资源
  // 图层与蒙版区
  out.u32(4 + liPadded + 4);
  out.u32(liPadded);
  out.bytes(liBytes);
  if (liBytes.length % 2) out.u8_(0);
  out.u32(0); // 全局蒙版
  // 合成图像数据
  out.bytes(comp.concat());

  return out.concat();
}
