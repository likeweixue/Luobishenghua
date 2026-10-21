// 视图引擎：文档画布 + 无限视图变换（平移/缩放/旋转）
export class Engine {
  constructor(displayCanvas, docW = 1600, docH = 1600) {
    this.canvas = displayCanvas;
    this.ctx = displayCanvas.getContext('2d');
    this.docW = docW;
    this.docH = docH;
    this.doc = document.createElement('canvas');
    this.doc.width = docW;
    this.doc.height = docH;
    this.dctx = this.doc.getContext('2d');
    this.dctx.fillStyle = '#ffffff';
    this.dctx.fillRect(0, 0, docW, docH);
    // view: screen = R(rotation) * scale * world + (tx, ty)，坐标均为 CSS px
    this.view = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    this.dpr = window.devicePixelRatio || 1;
    this.onRender = null; // 渲染后回调（导航器等）
    this.layers = null;   // 图层栈（M2 起由 LayerStack 接管）
  }

  // 把文档中的某个点移动到屏幕中心（导航器用）
  centerOn(wx, wy) {
    const v = this.view;
    const cx = this.canvas.clientWidth / 2;
    const cy = this.canvas.clientHeight / 2;
    const cos = Math.cos(v.rotation);
    const sin = Math.sin(v.rotation);
    v.tx = cx - (wx * cos - wy * sin) * v.scale;
    v.ty = cy - (wx * sin + wy * cos) * v.scale;
    this.render();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.render();
  }

  fit() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const s = Math.min(w / this.docW, h / this.docH) * 0.85;
    this.view.scale = s;
    this.view.rotation = 0;
    this.view.tx = (w - this.docW * s) / 2;
    this.view.ty = (h - this.docH * s) / 2;
    this.render();
  }

  screenToWorld(sx, sy) {
    const { scale, rotation, tx, ty } = this.view;
    const dx = sx - tx;
    const dy = sy - ty;
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    return {
      x: (dx * cos - dy * sin) / scale,
      y: (dx * sin + dy * cos) / scale,
    };
  }

  zoomAt(sx, sy, factor) {
    const v = this.view;
    const before = this.screenToWorld(sx, sy);
    v.scale = Math.min(16, Math.max(0.05, v.scale * factor));
    const cos = Math.cos(v.rotation);
    const sin = Math.sin(v.rotation);
    v.tx = sx - (before.x * cos - before.y * sin) * v.scale;
    v.ty = sy - (before.x * sin + before.y * cos) * v.scale;
    this.render();
  }

  rotateBy(angle) {
    const v = this.view;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // 绕视图中心旋转
    const cx = w / 2;
    const cy = h / 2;
    const before = this.screenToWorld(cx, cy);
    v.rotation += angle;
    const cos = Math.cos(v.rotation);
    const sin = Math.sin(v.rotation);
    v.tx = cx - (before.x * cos - before.y * sin) * v.scale;
    v.ty = cy - (before.x * sin + before.y * cos) * v.scale;
    this.render();
  }

  panBy(dx, dy) {
    this.view.tx += dx;
    this.view.ty += dy;
    this.render();
  }

  render() {
    const ctx = this.ctx;
    const v = this.view;

    // 多图层模式下先把图层栈合成到显示缓冲（带棋盘格衬底标示透明区）
    if (this.layers) {
      this.layers.composite(this.dctx, { checkerboard: true });
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 工作区底色：PS 式深灰（面板间隙透出的也是深灰，不会出现白缝）
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(v.tx, v.ty);
    ctx.rotate(v.rotation);
    ctx.scale(v.scale, v.scale);

    // 文档投影边（深色工作区下需要更重的投影才看得出层次）
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 28 / v.scale;
    ctx.shadowOffsetY = 2 / v.scale;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.docW, this.docH);
    ctx.restore();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.doc, 0, 0);

    // 文档边框（深色背景上用浅描边勾出纸张边界）
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1 / v.scale;
    ctx.strokeRect(0, 0, this.docW, this.docH);

    if (this.onRender) this.onRender();
  }

  // 切换文档尺寸（导入 PSD 时用）
  setDocSize(w, h) {
    this.docW = w;
    this.docH = h;
    this.doc.width = w;
    this.doc.height = h;
  }

  // 导出 PNG：合成所有图层（无棋盘格，保留真实透明通道）
  exportPNG(callback) {
    const t = document.createElement('canvas');
    t.width = this.docW;
    t.height = this.docH;
    const c = t.getContext('2d');
    if (this.layers) {
      this.layers.composite(c, { checkerboard: false });
    } else {
      c.drawImage(this.doc, 0, 0);
    }
    t.toBlob(callback, 'image/png');
  }

  // 清空文档（历史记录由调用方负责）
  clearDoc() {
    this.dctx.save();
    this.dctx.globalCompositeOperation = 'source-over';
    this.dctx.fillStyle = '#ffffff';
    this.dctx.fillRect(0, 0, this.docW, this.docH);
    this.dctx.restore();
    this.render();
  }
}
