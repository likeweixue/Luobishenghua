// 绘画工具：油漆桶（扫描线洪泛填充）、渐变、涂抹、吸管
import { getStamp } from './brushes.js';

const hexToRgb = (hex) => {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
};

const rgba = (hex, a) => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/* ---------------- 吸管 ---------------- */

/** 从画布取色；全透明返回 null */
export function pickColor(canvas, x, y) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) return null;
  const d = canvas.getContext('2d').getImageData(cx, cy, 1, 1).data;
  if (d[3] < 8) return null;
  return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 油漆桶 ---------------- */

/**
 * 洪泛填充。
 * @param target 目标画布（图层或蒙版）
 * @param opts { tolerance 0..255, contiguous 连续/全图, mask 选区蒙版, alpha 填充不透明度, lockAlpha 锁透明 }
 * @returns { count } 填充像素数；失败返回 null
 */
export function floodFill(target, w, h, sx, sy, hexColor, opts = {}) {
  const {
    tolerance = 32, contiguous = true, mask = null,
    alpha = 1, lockAlpha = false,
  } = opts;

  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

  const ctx = target.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  const si = (sy * w + sx) * 4;
  const sr = d[si], sg = d[si + 1], sb = d[si + 2], sa = d[si + 3];

  const tol = Math.max(0, Math.min(255, tolerance));
  const matches = (i) => {
    const p = i * 4;
    return Math.abs(d[p] - sr) <= tol
      && Math.abs(d[p + 1] - sg) <= tol
      && Math.abs(d[p + 2] - sb) <= tol
      && Math.abs(d[p + 3] - sa) <= tol;
  };

  const filled = new Uint8Array(w * h);
  let count = 0;
  let minX = sx, maxX = sx, minY = sy, maxY = sy;

  if (contiguous) {
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (filled[y * w + x] || !matches(y * w + x)) continue;

      let xl = x;
      while (xl - 1 >= 0 && !filled[y * w + xl - 1] && matches(y * w + xl - 1)) xl--;
      let xr = x;
      while (xr + 1 < w && !filled[y * w + xr + 1] && matches(y * w + xr + 1)) xr++;

      for (let i = xl; i <= xr; i++) {
        filled[y * w + i] = 1;
        count++;
      }
      if (xl < minX) minX = xl;
      if (xr > maxX) maxX = xr;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        for (let i = xl; i <= xr; i++) {
          const idx = ny * w + i;
          if (filled[idx] || !matches(idx)) continue;
          // 只在连续段的起点入栈，避免逐像素压栈
          if (i === xl || !matches(idx - 1) || filled[idx - 1]) stack.push(i, ny);
        }
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) {
      if (!matches(i)) continue;
      filled[i] = 1;
      count++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (count === 0) return { count: 0 };

  // 只在填充包围盒内构造临时画布，避免整幅大画布的额外内存
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const tmp = document.createElement('canvas');
  tmp.width = bw;
  tmp.height = bh;
  const tctx = tmp.getContext('2d');
  const out = tctx.createImageData(bw, bh);
  const { r, g, b } = hexToRgb(hexColor);
  const a255 = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      if (!filled[(minY + yy) * w + (minX + xx)]) continue;
      const o = (yy * bw + xx) * 4;
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = a255;
    }
  }
  tctx.putImageData(out, 0, 0);

  if (mask) {
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(mask, minX, minY, bw, bh, 0, 0, bw, bh);
    tctx.globalCompositeOperation = 'source-over';
  }
  if (lockAlpha) {
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(target, minX, minY, bw, bh, 0, 0, bw, bh);
    tctx.globalCompositeOperation = 'source-over';
  }

  ctx.drawImage(tmp, minX, minY);
  return { count };
}

/* ---------------- 渐变 ---------------- */

/**
 * 渐变填充（线性 / 径向）。
 * @param color 起始色（默认前景色）
 * @param color2 结束色；为空表示渐变到透明
 */
export function drawGradient(target, w, h, opts = {}) {
  const {
    x0 = 0, y0 = 0, x1 = w, y1 = 0,
    type = 'linear', color = '#000000', color2 = null,
    alpha = 1, reverse = false, mask = null, lockAlpha = false,
  } = opts;

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');

  let grad;
  if (type === 'radial') {
    const r = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
    grad = tctx.createRadialGradient(x0, y0, 0, x0, y0, r);
  } else {
    // 起止点重合时给一个默认方向，避免 createLinearGradient 抛错
    if (Math.abs(x1 - x0) < 0.01 && Math.abs(y1 - y0) < 0.01) { x1 = x0 + 1; }
    grad = tctx.createLinearGradient(x0, y0, x1, y1);
  }

  const c1 = rgba(color, Math.max(0, Math.min(1, alpha)));
  const c2 = color2 ? rgba(color2, Math.max(0, Math.min(1, alpha))) : rgba(color, 0);
  grad.addColorStop(0, reverse ? c2 : c1);
  grad.addColorStop(1, reverse ? c1 : c2);

  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, w, h);

  if (mask) {
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(mask, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
  }
  if (lockAlpha) {
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(target, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
  }

  target.getContext('2d').drawImage(tmp, 0, 0);
}

/* ---------------- 涂抹 ---------------- */

/**
 * 涂抹：维护一个采样缓冲区，每次移动把上一次采到的像素按压力刷到新位置，
 * 再从新位置重新采样 —— 于是颜色被一路「拖」过去。
 */
export class Smudge {
  constructor() {
    this.buf = document.createElement('canvas');
    this.scratch = document.createElement('canvas');
    this.box = 0;
  }

  _ensure(box) {
    if (this.box === box) return;
    this.box = box;
    this.buf.width = this.buf.height = box;
    this.scratch.width = this.scratch.height = box;
  }

  /** 开始涂抹：采样起点周围一块圆形区域 */
  begin(layer, x, y, size, opts = {}) {
    this._capture(layer, x, y, size, opts);
  }

  _capture(layer, x, y, size, opts = {}) {
    const box = Math.max(3, Math.round(size * 1.1));
    this._ensure(box);
    const b = this.buf.getContext('2d');
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-over';
    b.globalAlpha = 1;
    b.clearRect(0, 0, box, box);
    b.drawImage(layer.canvas, x - box / 2, y - box / 2, box, box, 0, 0, box, box);
    // 圆形笔尖遮罩，避免拖出方块边
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(getStamp('hard', '#ffffff'), 0, 0, box, box);
    if (opts.mask) {
      b.drawImage(opts.mask, x - box / 2, y - box / 2, box, box, 0, 0, box, box);
    }
    b.globalCompositeOperation = 'source-over';
  }

  /** 拖到新位置：先刷旧像素，再重新采样 */
  drag(layer, x, y, size, strength, opts = {}) {
    const box = this.box;
    if (!box) return;

    const s = this.scratch.getContext('2d');
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, box, box);
    s.drawImage(this.buf, 0, 0);
    if (opts.mask) {
      s.globalCompositeOperation = 'destination-in';
      s.drawImage(opts.mask, x - box / 2, y - box / 2, box, box, 0, 0, box, box);
      s.globalCompositeOperation = 'source-over';
    }

    const ctx = layer.ctx;
    ctx.save();
    if (opts.lockAlpha) ctx.globalCompositeOperation = 'source-atop';
    // 强度下限 0.5：否则每步 source-over 与底图混合会让颜色迅速变淡
    ctx.globalAlpha = Math.max(0.05, Math.min(1, 0.5 + 0.5 * strength));
    ctx.drawImage(this.scratch, x - box / 2, y - box / 2, box, box);
    ctx.restore();

    this._capture(layer, x, y, size, opts);
  }

  get radius() { return this.box / 2; }
}
