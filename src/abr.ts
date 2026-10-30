// 源文件：app 运行时使用 app/js/abr.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/abr.js。
// ABR 笔刷解析：PS v1/v2（含中文 Unicode 名）+ v6/7/9/10（samp 段笔尖位图）
// 纯解析，不依赖 DOM：输出灰度 alpha 数据，由调用方转成画布
// 参考：Adobe PS6 格式规范（legacy 记录）+ 社区逆向（modern samp/desc 段）

class Reader {
  [key: string]: any;
  constructor(buf) {
    this.v = new DataView(buf);
    this.u8 = new Uint8Array(buf);
    this.p = 0;
    this.end = buf.byteLength;
  }
  u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
  i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
  u16() { const x = this.v.getUint16(this.p); this.p += 2; return x; }
  i16() { const x = this.v.getInt16(this.p); this.p += 2; return x; }
  u8_() { return this.u8[this.p++]; }
  bytes(n) { const s = this.u8.slice(this.p, this.p + n); this.p += n; return s; }
  str(n) { return String.fromCharCode(...this.bytes(n)); }
  skip(n) { this.p += n; }
  utf16be(chars) {
    const raw = this.bytes(chars * 2);
    let s = '';
    for (let i = 0; i < chars; i++) {
      const c = (raw[i * 2] << 8) | raw[i * 2 + 1];
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }
}

function unpackBitsRow(src, out, offset, width) {
  let i = 0, o = offset;
  const end = offset + width;
  while (i < src.length && o < end) {
    let n = src[i++];
    if (n > 128) n -= 256;
    if (n >= 0) { for (let j = 0; j <= n && o < end; j++) out[o++] = src[i++]; }
    else if (n !== -128) { const b = src[i++]; for (let j = 0; j < 1 - n && o < end; j++) out[o++] = b; }
  }
  // 真实 PS 文件存在行长溢出的脏数据：按行裁剪、不足补零（与 PS 自身行为一致）
}

// 解码单个笔尖位图 → Uint8Array alpha（255-v：PS 笔尖黑色=着墨）
function decodeTip(r, w, h, depth, comp, limitEnd) {
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null;
  const alpha = new Uint8Array(w * h);
  if (depth === 8) {
    if (comp === 0) {
      const raw = r.bytes(Math.min(w * h, limitEnd - r.p));
      for (let i = 0; i < w * h; i++) alpha[i] = 255 - (raw[i] ?? 255);
    } else {
      const counts = [];
      for (let y = 0; y < h; y++) counts.push(r.u16());
      const row = new Uint8Array(w);
      for (let y = 0; y < h; y++) {
        row.fill(255);
        unpackBitsRow(r.bytes(Math.min(counts[y], limitEnd - r.p)), row, 0, w);
        for (let x = 0; x < w; x++) alpha[y * w + x] = 255 - row[x];
      }
    }
  } else if (depth === 16) {
    const rowBytes = w * 2;
    if (comp === 0) {
      const raw = r.bytes(Math.min(w * h * 2, limitEnd - r.p));
      for (let i = 0; i < w * h; i++) alpha[i] = 255 - (raw[i * 2] ?? 255);
    } else {
      const counts = [];
      for (let y = 0; y < h; y++) counts.push(r.u16());
      const row = new Uint8Array(rowBytes);
      for (let y = 0; y < h; y++) {
        row.fill(255);
        unpackBitsRow(r.bytes(Math.min(counts[y], limitEnd - r.p)), row, 0, rowBytes);
        for (let x = 0; x < w; x++) alpha[y * w + x] = 255 - row[x * 2];
      }
    }
  } else if (depth === 1) {
    const rowBytes = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) {
      const row = r.bytes(Math.min(rowBytes, limitEnd - r.p));
      for (let x = 0; x < w; x++) {
        const bit = (row[x >> 3] ?? 0) & (0x80 >> (x & 7));
        alpha[y * w + x] = bit ? 0 : 255;
      }
    }
  } else {
    return null;
  }
  return alpha;
}

export function readABR(buffer: ArrayBuffer): any {
  const r = new Reader(buffer);
  const version = r.u16();
  const second = r.u16();
  const brushes = [];
  const warnings = [];
  let skipped = 0;

  if (version === 1 || version === 2) {
    /* ---------- legacy v1/v2 ---------- */
    const count = second;
    for (let i = 0; i < count && r.p + 6 <= r.end; i++) {
      const type = r.u16();
      const size = r.u32();
      const recEnd = Math.min(r.p + size, r.end);
      if (type !== 2) { skipped++; r.p = recEnd; continue; } // computed 圆头笔跳过
      try {
        r.u32(); // misc
        const spacing = r.u16();
        let name = '';
        if (version === 2) name = r.utf16be(r.u32()); // UCS-2 名称
        r.u8_(); // antialiasing
        r.skip(8); // short bounds
        const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
        const depth = r.u16();
        const comp = r.u8_();
        const w = right - left, h = bottom - top;
        const alpha = decodeTip(r, w, h, depth, comp, recEnd);
        if (alpha) {
          brushes.push({
            name: name || `笔刷 ${i + 1}`,
            width: w, height: h,
            spacingRatio: spacing > 0 ? Math.min(1, Math.max(0.03, spacing / 100)) : 0.1,
            alpha,
          });
        } else skipped++;
      } catch (e) {
        skipped++;
        warnings.push(`第 ${i + 1} 个笔刷解析失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      r.p = recEnd;
    }
  } else if (version >= 6) {
    /* ---------- modern v6+（8BIM 段） ---------- */
    const subversion = second;
    while (r.p + 12 <= r.end) {
      const sig = r.str(4);
      if (sig !== '8BIM' && sig !== '8B64') break;
      const key = r.str(4);
      const plen = r.u32();
      const payloadEnd = Math.min(r.p + plen, r.end);
      if (key === 'samp') {
        while (r.p + 4 <= payloadEnd) {
          const elen = r.u32();
          if (elen <= 0) break;
          const entryEnd = Math.min(r.p + elen, payloadEnd);
          try {
            const idLen = r.u8_();
            r.skip(idLen); // 36 字符 UUID
            r.skip(subversion === 1 ? 10 : 264); // 固定前导数据
            const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
            const depth = r.u16();
            const comp = r.u8_();
            const w = right - left, h = bottom - top;
            const alpha = decodeTip(r, w, h, depth, comp, entryEnd);
            if (alpha) {
              brushes.push({
                name: `导入笔刷 ${brushes.length + 1}`,
                width: w, height: h,
                spacingRatio: 0.1,
                alpha,
              });
            } else skipped++;
          } catch (e) {
            skipped++;
            warnings.push('samp 条目解析失败: ' + (e instanceof Error ? e.message : String(e)));
          }
          r.p = entryEnd + ((4 - (entryEnd % 4)) % 4); // 4 字节对齐
        }
      }
      // desc 段是 Action Descriptor（含笔刷名/动态参数），M4 暂不解析
      r.p = payloadEnd + ((4 - (plen % 4)) % 4);
    }
    if (brushes.length > 0) {
      warnings.push('v' + version + ' 格式：笔刷名存在 desc 段中暂未解析，已用默认名；动态参数（散布/纹理等）待后续版本');
    }
  } else {
    throw new Error('未知的 ABR 版本: ' + version);
  }

  return { version, brushes, skipped, warnings };
}
