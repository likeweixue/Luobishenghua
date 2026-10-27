// 瓦片（tile）图层存储：把每层从「一张全尺寸画布」改成「按需分配的瓦片集合」
//
// 为什么：4000×4000 的一层整画布 = 64MB，50 层就是 3.2GB，浏览器扛不住。
// 改成 256×256 瓦片后，只有真正画过的区域才占内存——空白层 0 开销，
// 只画了中间一块的层也只占那一块。这也是 PS / CSP 一直用瓦片的原因。
//
// 坐标约定：全部是文档世界坐标（0..w, 0..h），瓦片自己的画布是局部的，
// 通过 ctx.translate(-tileX, -tileY) 让调用方继续用世界坐标绘制。

export const TILE_SIZE = 256;

const key = (tx, ty) => tx + ',' + ty;

// 复用一张 1×1 画布来 createImageData，避免每次分配上下文
let _scratchCtx = null;
function scratchCtx() {
  if (!_scratchCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    _scratchCtx = c.getContext('2d');
  }
  return _scratchCtx;
}

/* ---------------- 蒙版工具（默认全显示 = 未分配瓦片） ---------------- */

/** 导出一张「有效蒙版」画布：白底 + 瓦片内容（用于 PNG / PSD 保存） */
export function maskToCanvas(surface) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, surface.w);
  c.height = Math.max(1, surface.h);
  const ctx = c.getContext('2d');
  // 默认全显示 = 不透明白
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  // 有瓦片的地方必须「替换」而不是叠加：叠加会把 alpha=0 的孔洞重新变成不透明
  for (const t of surface.tiles.values()) {
    const r = surface.tileRect(t.tx, t.ty);
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(t.canvas, r.x, r.y);
  }
  return c;
}

/** 从整层蒙版画布建瓦片：保留「被遮住」的瓦片，跳过全白瓦片 */
export function maskFromCanvas(canvas, w, h) {
  const s = new TileSurface(w, h, TILE_SIZE, { blank: '#ffffff' });
  s.fromCanvas(canvas, { skipEmpty: false, skipFull: true });
  return s;
}

export class TileSurface {
  /**
   * @param blank 新建瓦片时的底色（默认透明）。蒙版用 '#ffffff'：
   *              没被碰过的区域等于「全显示」，只有画过的瓦片才存在。
   */
  constructor(w, h, ts = TILE_SIZE, { blank = null } = {}) {
    this.w = w;
    this.h = h;
    this.ts = ts;
    this.blank = blank;
    this.tiles = new Map();   // "tx,ty" -> { canvas, ctx, tx, ty }
    this._bbox = null;        // 惰性计算的包围盒
  }

  /* ---------------- 几何 ---------------- */

  get cols() { return Math.ceil(this.w / this.ts); }
  get rows() { return Math.ceil(this.h / this.ts); }
  get tileCount() { return this.tiles.size; }
  isEmpty() { return this.tiles.size === 0; }

  tileRect(tx, ty) {
    return {
      x: tx * this.ts,
      y: ty * this.ts,
      w: Math.min(this.ts, this.w - tx * this.ts),
      h: Math.min(this.ts, this.h - ty * this.ts),
    };
  }

  rangeOf(x, y, w, h) {
    const tx0 = Math.max(0, Math.floor(x / this.ts));
    const ty0 = Math.max(0, Math.floor(y / this.ts));
    const tx1 = Math.min(this.cols - 1, Math.floor((x + w - 1) / this.ts));
    const ty1 = Math.min(this.rows - 1, Math.floor((y + h - 1) / this.ts));
    return { tx0, ty0, tx1, ty1, valid: tx1 >= tx0 && ty1 >= ty0 };
  }

  getTile(tx, ty, create = false) {
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return null;
    const k = key(tx, ty);
    let t = this.tiles.get(k);
    if (!t && create) {
      const r = this.tileRect(tx, ty);
      const canvas = document.createElement('canvas');
      canvas.width = r.w;
      canvas.height = r.h;
      const ctx = canvas.getContext('2d');
      if (this.blank) {
        ctx.fillStyle = this.blank;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      t = { canvas, ctx, tx, ty, rev: 0 };
      this.tiles.set(k, t);
      this._bbox = null;
    }
    return t || null;
  }

  /** 已分配瓦片的包围盒（世界坐标）；空层返回 null */
  bbox() {
    if (this._bbox !== undefined && this._bbox !== null) return this._bbox;
    if (this.tiles.size === 0) { this._bbox = null; return null; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of this.tiles.values()) {
      const r = this.tileRect(t.tx, t.ty);
      if (r.x < x0) x0 = r.x;
      if (r.y < y0) y0 = r.y;
      if (r.x + r.w > x1) x1 = r.x + r.w;
      if (r.y + r.h > y1) y1 = r.y + r.h;
    }
    this._bbox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    return this._bbox;
  }

  byteSize() {
    let n = 0;
    for (const t of this.tiles.values()) n += t.canvas.width * t.canvas.height * 4;
    return n;
  }

  /* ---------------- 迭代 ---------------- */

  /**
   * 遍历与矩形相交的瓦片。fn(ctx, rect) 里的 ctx 已平移到世界坐标原点，
   * 所以 fn 里可以直接用世界坐标绘制。
   */
  forEachTileInRect(x, y, w, h, create, fn) {
    const rg = this.rangeOf(x, y, w, h);
    if (!rg.valid) return;
    for (let ty = rg.ty0; ty <= rg.ty1; ty++) {
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const t = this.getTile(tx, ty, create);
        if (!t) continue;
        const r = this.tileRect(tx, ty);
        t.ctx.save();
        t.ctx.translate(-r.x, -r.y);
        try { fn(t.ctx, r); } finally { t.ctx.restore(); }
        t.rev = (t.rev || 0) + 1;
      }
    }
  }

  /** 以 (x,y) 为心、半径 radius 的方形范围内所有瓦片 */
  stamp(x, y, radius, fn) {
    const r = Math.max(1, radius);
    this.forEachTileInRect(x - r, y - r, r * 2, r * 2, true, fn);
  }

  /* ---------------- 绘制到目标 ---------------- */

  /** 1:1 把内容画到目标 ctx（目标可以带缩放变换，如缩略图） */
  drawInto(ctx) {
    for (const t of this.tiles.values()) {
      ctx.drawImage(t.canvas, t.tx * this.ts, t.ty * this.ts);
    }
  }

  /** 把世界区域 [x,y,w,h] 画到目标 ctx 的 (0,0) */
  drawIntoRegion(ctx, x, y, w, h) {
    const rg = this.rangeOf(x, y, w, h);
    if (!rg.valid) return;
    for (let ty = rg.ty0; ty <= rg.ty1; ty++) {
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const t = this.tiles.get(key(tx, ty));
        if (!t) continue;
        const r = this.tileRect(tx, ty);
        const ix0 = Math.max(x, r.x);
        const iy0 = Math.max(y, r.y);
        const ix1 = Math.min(x + w, r.x + r.w);
        const iy1 = Math.min(y + h, r.y + r.h);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        ctx.drawImage(
          t.canvas,
          ix0 - r.x, iy0 - r.y, ix1 - ix0, iy1 - iy0,
          ix0 - x, iy0 - y, ix1 - ix0, iy1 - iy0,
        );
      }
    }
  }

  /** 把外部画布画进来（支持 alpha / 合成模式），按瓦片切片 */
  drawCanvas(src, dx, dy, { alpha = 1, composite = 'source-over' } = {}) {
    const sw = src.width;
    const sh = src.height;
    if (sw <= 0 || sh <= 0) return;
    this.forEachTileInRect(dx, dy, sw, sh, true, (ctx, r) => {
      const ix0 = Math.max(dx, r.x);
      const iy0 = Math.max(dy, r.y);
      const ix1 = Math.min(dx + sw, r.x + r.w);
      const iy1 = Math.min(dy + sh, r.y + r.h);
      if (ix1 <= ix0 || iy1 <= iy0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = composite;
      // 注意：forEachTileInRect 已经把 ctx 平移成世界坐标，这里直接给世界坐标
      ctx.drawImage(
        src,
        ix0 - dx, iy0 - dy, ix1 - ix0, iy1 - iy0,
        ix0, iy0, ix1 - ix0, iy1 - iy0,
      );
      ctx.restore();
    });
  }

  /* ---------------- 清除 / 转换 ---------------- */

  clearRect(x, y, w, h) {
    const rg = this.rangeOf(x, y, w, h);
    if (!rg.valid) return;
    for (let ty = rg.ty0; ty <= rg.ty1; ty++) {
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const k = key(tx, ty);
        const t = this.tiles.get(k);
        if (!t) continue;
        const r = this.tileRect(tx, ty);
        const covers = x <= r.x && y <= r.y && x + w >= r.x + r.w && y + h >= r.y + r.h;
        if (covers) this.tiles.delete(k);
        else {
          t.ctx.clearRect(x - r.x, y - r.y, w, h);
          t.rev = (t.rev || 0) + 1;
        }
      }
    }
    this._bbox = null;
  }

  clearAll() {
    this.tiles.clear();
    this._bbox = null;
  }

  /** 整层填充纯色（纸张用） */
  fill(color) {
    this.clearAll();
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const t = this.getTile(tx, ty, true);
        t.ctx.fillStyle = color;
        t.ctx.fillRect(0, 0, t.canvas.width, t.canvas.height);
        t.rev = (t.rev || 0) + 1;
      }
    }
  }

  /** 导出整层为画布（PNG / PSD / 工程保存用） */
  toCanvas() {
    const c = document.createElement('canvas');
    c.width = Math.max(1, this.w);
    c.height = Math.max(1, this.h);
    this.drawInto(c.getContext('2d'));
    return c;
  }

  toImageData() {
    return this.toCanvas().getContext('2d').getImageData(0, 0, this.w, this.h);
  }

  /** 取一块区域为新画布 */
  extract(x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    this.drawIntoRegion(c.getContext('2d'), x, y, w, h);
    return c;
  }

  /** 把外部画布画进来（putCanvas 别名，语义更直白） */
  putCanvas(src, dx, dy, opts) {
    this.drawCanvas(src, dx, dy, opts);
  }

  /** 取单点 RGBA [r,g,b,a]；越界或空瓦片返回 [0,0,0,0] */
  pixelAt(x, y) {
    const tx = Math.floor(x / this.ts);
    const ty = Math.floor(y / this.ts);
    const t = this.tiles.get(key(tx, ty));
    if (!t) return [0, 0, 0, 0];
    const r = this.tileRect(tx, ty);
    const lx = Math.floor(x - r.x);
    const ly = Math.floor(y - r.y);
    if (lx < 0 || ly < 0 || lx >= r.w || ly >= r.h) return [0, 0, 0, 0];
    const d = t.ctx.getImageData(lx, ly, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }

  /** 取单点颜色（吸管）；透明返回 null */
  colorAt(x, y) {
    const tx = Math.floor(x / this.ts);
    const ty = Math.floor(y / this.ts);
    const t = this.tiles.get(key(tx, ty));
    if (!t) return null;
    const r = this.tileRect(tx, ty);
    const lx = Math.floor(x - r.x);
    const ly = Math.floor(y - r.y);
    if (lx < 0 || ly < 0 || lx >= r.w || ly >= r.h) return null;
    const d = t.ctx.getImageData(lx, ly, 1, 1).data;
    if (d[3] < 8) return null;
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 用整层画布替换内容。逐瓦片扫描 alpha，全透明的瓦片直接跳过
   * （PSD 导入的图层经常只有一小块有像素）。
   */
  fromCanvas(canvas, { skipEmpty = true, skipFull = false } = {}) {
    this.clearAll();
    const sw = Math.min(canvas.width, this.w);
    const sh = Math.min(canvas.height, this.h);
    if (sw <= 0 || sh <= 0) return;
    const rg = this.rangeOf(0, 0, sw, sh);
    if (!rg.valid) return;

    for (let ty = rg.ty0; ty <= rg.ty1; ty++) {
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const r = this.tileRect(tx, ty);
        const ix1 = Math.min(sw, r.x + r.w);
        const iy1 = Math.min(sh, r.y + r.h);
        const iw = ix1 - r.x;
        const ih = iy1 - r.y;
        if (iw <= 0 || ih <= 0) continue;

        if (!skipEmpty) {
          const t = this.getTile(tx, ty, true);
          // 覆盖语义：先清掉这块（瓦片可能有白底），否则 alpha 会被底图吃掉
          t.ctx.clearRect(0, 0, iw, ih);
          t.ctx.drawImage(canvas, r.x, r.y, iw, ih, 0, 0, iw, ih);
          t.rev = (t.rev || 0) + 1;
          continue;
        }

        // 扫描这一块是否全透明
        const probe = document.createElement('canvas');
        probe.width = iw;
        probe.height = ih;
        const pctx = probe.getContext('2d', { willReadFrequently: true });
        pctx.drawImage(canvas, r.x, r.y, iw, ih, 0, 0, iw, ih);
        const data = pctx.getImageData(0, 0, iw, ih).data;
        let hasPixel = false;
        let fullPixel = true;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 0) {
            hasPixel = true;
            if (data[i] !== 255) fullPixel = false;
          } else {
            fullPixel = false;
          }
          if (hasPixel && !fullPixel) break;
        }
        if (!hasPixel) continue;
        if (skipFull && fullPixel) continue;

        const t = this.getTile(tx, ty, true);
        t.ctx.clearRect(0, 0, iw, ih);
        t.ctx.drawImage(probe, 0, 0);
        t.rev = (t.rev || 0) + 1;
      }
    }
    this._bbox = null;
  }

  /* ---------------- 从 PSD 通道平面直接建瓦片 ---------------- */

  /**
   * 直接从通道平面写瓦片（PSD 导入用）。
   * 避免「先建一张整层画布再扫描」的峰值内存，图层 Rect 之外完全不碰。
   * @param planes { 0, 1, 2, -1: Uint8Array }  缺失的通道按 0 / 255 处理
   * @param rect   { x, y, w, h }  图层在文档中的位置与尺寸（平面坐标原点对应该 rect）
   */
  fromPlanes(planes, rect) {
    const { x, y, w, h } = rect;
    if (w <= 0 || h <= 0) return;
    const R = planes[0], G = planes[1], B = planes[2], A = planes[-1];
    const rg = this.rangeOf(x, y, w, h);
    if (!rg.valid) return;
    const scratch = scratchCtx();

    for (let ty = rg.ty0; ty <= rg.ty1; ty++) {
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const r = this.tileRect(tx, ty);
        const ix0 = Math.max(x, r.x);
        const iy0 = Math.max(y, r.y);
        const ix1 = Math.min(x + w, r.x + r.w);
        const iy1 = Math.min(y + h, r.y + r.h);
        const iw = ix1 - ix0;
        const ih = iy1 - iy0;
        if (iw <= 0 || ih <= 0) continue;

        const img = scratch.createImageData(iw, ih);
        const d = img.data;
        let anyOpaque = false;
        for (let yy = 0; yy < ih; yy++) {
          const rowBase = (iy0 + yy - y) * w;
          for (let xx = 0; xx < iw; xx++) {
            const si = rowBase + (ix0 + xx - x);
            const o = (yy * iw + xx) * 4;
            const a = A ? A[si] : 255;
            d[o] = R ? R[si] : 0;
            d[o + 1] = G ? G[si] : 0;
            d[o + 2] = B ? B[si] : 0;
            d[o + 3] = a;
            if (a !== 0) anyOpaque = true;
          }
        }
        if (!anyOpaque) continue;   // 全透明瓦片不分配

        const t = this.getTile(tx, ty, true);
        t.ctx.putImageData(img, ix0 - r.x, iy0 - r.y);
        t.rev = (t.rev || 0) + 1;
      }
    }
    this._bbox = null;
  }

  /**
   * 从 PSD 的蒙版平面建瓦片：RGB 恒白，A = 蒙版值。
   * 全 255（默认显示）的瓦片直接跳过 —— 蒙版的「没画过 = 全显示」由空白瓦片底色保证。
   */
  fromMaskPlane(plane, rect) {
    const { x, y, w, h } = rect;
    if (w <= 0 || h <= 0 || !plane) return;
    const rg = this.rangeOf(x, y, w, h);
    if (!rg.valid) return;
    const scratch = scratchCtx();

    for (let ty = rg.ty0; ty <= rg.ty1; ty++) {
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const r = this.tileRect(tx, ty);
        const ix0 = Math.max(x, r.x);
        const iy0 = Math.max(y, r.y);
        const ix1 = Math.min(x + w, r.x + r.w);
        const iy1 = Math.min(y + h, r.y + r.h);
        const iw = ix1 - ix0;
        const ih = iy1 - iy0;
        if (iw <= 0 || ih <= 0) continue;

        const img = scratch.createImageData(iw, ih);
        const d = img.data;
        let allFull = true;
        // 蒙版矩形之外是「全显示」，所以本瓦片里矩形外的像素也要按 255 处理
        const tw = r.w;
        const th = r.h;
        for (let yy = 0; yy < th; yy++) {
          const gy = r.y + yy;
          const insideY = gy >= iy0 && gy < iy1;
          for (let xx = 0; xx < tw; xx++) {
            const gx = r.x + xx;
            const insideX = gx >= ix0 && gx < ix1;
            let a = 255;
            if (insideX && insideY) {
              a = plane[(gy - y) * w + (gx - x)];
            }
            if (a !== 255) allFull = false;
            const o = (yy * tw + xx) * 4;
            d[o] = 255;
            d[o + 1] = 255;
            d[o + 2] = 255;
            d[o + 3] = a;
          }
        }
        if (allFull) continue;

        const t = this.getTile(tx, ty, true);
        t.ctx.putImageData(img, 0, 0);
        t.rev = (t.rev || 0) + 1;
      }
    }
    this._bbox = null;
  }

  /* ---------------- 历史快照 ---------------- */

  /**
   * 记录区域内所有瓦片的像素（不存在的瓦片也记，还原时要把它们删掉）。
   * 返回 Map<key, { existed, w, h, data }>
   */
  snapshotTiles(x, y, w, h) {
    const snap = new Map();
    const rg = this.rangeOf(x, y, w, h);
    if (!rg.valid) return snap;
    for (let ty = rg.ty0; ty <= rg.ty1; ty++) {
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const k = key(tx, ty);
        const t = this.tiles.get(k);
        const r = this.tileRect(tx, ty);
        if (t) {
          snap.set(k, { existed: true, tx, ty, w: r.w, h: r.h, data: t.ctx.getImageData(0, 0, r.w, r.h) });
        } else {
          snap.set(k, { existed: false, tx, ty, w: r.w, h: r.h });
        }
      }
    }
    return snap;
  }

  restoreTiles(snap) {
    for (const [k, s] of snap) {
      if (!s.existed) { this.tiles.delete(k); continue; }
      const t = this.getTile(s.tx, s.ty, true);
      if (!t) continue;
      t.ctx.putImageData(s.data, 0, 0);
      t.rev = (t.rev || 0) + 1;
    }
    this._bbox = null;
  }

  snapshotAll() {
    return this.snapshotTiles(0, 0, this.w, this.h);
  }

  restoreAll(snap) {
    this.clearAll();
    this.restoreTiles(snap);
  }

  /** 快照占用估算（字节） */
  static snapshotBytes(snap) {
    let n = 0;
    for (const s of snap.values()) if (s.existed && s.data) n += s.data.data.byteLength;
    return n;
  }
}
