// 源文件：app 运行时使用 app/js/selection.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/selection.js。
// 选区模型：用一张 alpha 蒙版画布表示（alpha = 选中程度，支持羽化）
// 同时保留几何路径（用于绘制蚂蚁线）
export class Selection {
  [key: string]: any;

  active: boolean;
  mask: HTMLCanvasElement;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.mask = document.createElement('canvas');
    this.mask.width = w;
    this.mask.height = h;
    this.ctx = this.mask.getContext('2d');
    this.active = false;
    this.path = null;      // Path2D（世界坐标），仅几何选区有
    this.bounds = null;    // { x, y, w, h }
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.mask.width = w;
    this.mask.height = h;
    this.clear();
    this.ctx = this.mask.getContext('2d');
  }

  _docCanvas() {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    return c;
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.active = false;
    this.path = null;
    this.bounds = null;
  }

  selectAll() {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.active = true;
    this.path = null;
    this.bounds = { x: 0, y: 0, w: this.w, h: this.h };
  }

  // 用路径生成/合并选区；mode: replace | add | subtract | intersect
  setPath(path2d, mode = 'replace') {
    const tmp = this._docCanvas();
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#ffffff';
    tctx.fill(path2d);
    this.combine(tmp, mode);
    this.path = path2d;
  }

  combine(tmpCanvas, mode = 'replace') {
    const c = this.ctx;
    const first = !this.active || mode === 'replace';
    if (first) {
      c.clearRect(0, 0, this.w, this.h);
      c.drawImage(tmpCanvas, 0, 0);
    } else if (mode === 'add') {
      c.drawImage(tmpCanvas, 0, 0);
    } else if (mode === 'subtract') {
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(tmpCanvas, 0, 0);
      c.globalCompositeOperation = 'source-over';
    } else if (mode === 'intersect') {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(tmpCanvas, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
    this.active = !this._isEmpty();
    this.bounds = this.active ? this._computeBounds() : null;
    if (!this.active) this.path = null;
  }

  invert() {
    const tmp = this._docCanvas();
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, this.w, this.h);
    tctx.globalCompositeOperation = 'destination-out';
    tctx.drawImage(this.mask, 0, 0);
    tctx.globalCompositeOperation = 'source-over';

    this.ctx.clearRect(0, 0, this.w, this.h);
    this.ctx.drawImage(tmp, 0, 0);
    this.path = null;                 // 反相后没有几何路径，蚂蚁线退化为文档边框
    this.active = !this._isEmpty();   // 全选反选 = 空选区
    this.bounds = this.active ? { x: 0, y: 0, w: this.w, h: this.h } : null;
  }

  feather(px) {
    if (!this.active || px <= 0) return;
    const tmp = this._docCanvas();
    const tctx = tmp.getContext('2d');
    tctx.filter = `blur(${px}px)`;
    tctx.drawImage(this.mask, 0, 0);
    tctx.filter = 'none';

    this.ctx.clearRect(0, 0, this.w, this.h);
    this.ctx.drawImage(tmp, 0, 0);
    this.path = null;
    this.bounds = this._computeBounds() || { x: 0, y: 0, w: this.w, h: this.h };
  }

  // 扩展/收缩（负数为收缩），用模糊+阈值近似
  expand(px) {
    if (!this.active || px === 0) return;
    const radius = Math.abs(px);
    const tmp = this._docCanvas();
    const tctx = tmp.getContext('2d');
    tctx.filter = `blur(${Math.max(1, radius / 2)}px)`;
    tctx.drawImage(this.mask, 0, 0);
    tctx.filter = 'none';
    // 阈值：扩展→alpha>0，收缩→alpha>较高值
    const img = tctx.getImageData(0, 0, this.w, this.h);
    const d = img.data;
    const threshold = px > 0 ? 32 : 160;
    for (let i = 3; i < d.length; i += 4) {
      d[i] = d[i] > threshold ? 255 : 0;
    }
    tctx.putImageData(img, 0, 0);

    this.ctx.clearRect(0, 0, this.w, this.h);
    this.ctx.drawImage(tmp, 0, 0);
    this.path = null;
    this.bounds = this._computeBounds();
    this.active = !!this.bounds;
  }

  _isEmpty() {
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] !== 0) return false;
    }
    return true;
  }

  _computeBounds() {
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
    let minX = this.w, minY = this.h, maxX = -1, maxY = -1;
    for (let y = 0; y < this.h; y++) {
      const row = y * this.w * 4;
      for (let x = 0; x < this.w; x++) {
        if (d[row + x * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // 把画布内容按选区裁剪后的副本（选区外透明）
  cropMasked(srcCanvas, bounds = this.bounds) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, bounds.w);
    c.height = Math.max(1, bounds.h);
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, -bounds.x, -bounds.y);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.mask, -bounds.x, -bounds.y);
    ctx.globalCompositeOperation = 'source-over';
    return c;
  }

  // 用选区遮罩绘制一个临时的全幅画布
  maskedCopy(srcCanvas) {
    const c = this._docCanvas();
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return c;
  }
}
