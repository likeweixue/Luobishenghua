// 视图引擎：文档画布 + 无限视图变换（平移/缩放/旋转）
// DeepSeek 自 beta12 起参与落笔生花；beta13 起此文件接入 WebGL2 合成。
import { GpuRenderer } from './gpu.js';

export class Engine {
  constructor(displayCanvas, docW = 1600, docH = 1600, glCanvas = null) {
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
    this._renderListeners = new Set();
    this.selection = null;   // 选区（绘制蚂蚁线）
    this.transform = null;   // 自由变换浮动层
    this.previewPath = null; // 选区拖拽预览路径
    this.gradientPreview = null; // 渐变拖拽预览
    this.antsPhase = 0;      // 蚂蚁线动画相位（屏幕像素）
    this.layers = null;   // 图层栈（M2 起由 LayerStack 接管）

    // GPU 合成（可选）：简单平铺图层走 WebGL2，复杂结构自动回退 Canvas2D
    this.glCanvas = glCanvas || null;
    this.gpuEnabled = true;
    this.gpu = glCanvas ? new GpuRenderer(glCanvas) : null;
    this.onGpuChange = null;
    if (this.gpu) this.gpu.onLost = () => { this.render(); if (this.onGpuChange) this.onGpuChange(); };
    this.onDocSync = null;   // doc 画布空闲合成完成后的回调（导航器等）
    this._docTimer = 0;
    this._gpuLast = false;
  }

  // 进入/离开 GPU 模式时同步状态；离开时释放纹理，避免复杂图层回退后仍占显存
  _syncGpuMode() {
    const on = this.gpuActive();
    if (!on && this._gpuLast && this.gpu) this.gpu.dropTextures();
    this._gpuLast = on;
    return on;
  }

  /** 当前帧是否走 GPU 路径（结构不满足或 WebGL 不可用时为 false） */
  gpuActive() {
    return !!(this.gpu && this.gpu.ok && this.gpuEnabled && this.layers && this.gpu.canRender(this.layers));
  }

  /** 运行时开关；关闭时清空 GL 画布并立刻走 Canvas2D */
  setGpuEnabled(on) {
    this.gpuEnabled = !!on;
    if (!this.gpuEnabled && this.gpu) this.gpu.clear();
    this._caches = null;
    this.render();
  }

  _renderGpu() {
    if (!this.gpu || !this.gpu.ok) return false;
    try {
      return this.gpu.render(this.layers, this.view, this.canvas.clientWidth, this.canvas.clientHeight, this.dpr);
    } catch (err) {
      console.warn('[GPU] render failed, fallback Canvas2D', err);
      this.gpu.ok = false;
      return false;
    }
  }

  // GPU 模式下 2D 画布只画选区/变换/渐变预览等叠加层
  _paintOverlaysOnly() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._paintOverlays();
  }

  // doc 画布（导航器 / 吸管 / 测试用）空闲合成，避免每帧 CPU 全量合成
  scheduleDocSync() {
    if (this._docTimer) clearTimeout(this._docTimer);
    this._docTimer = setTimeout(() => {
      this._docTimer = 0;
      if (!this.layers) return;
      this._compositeDoc();
      this._docValid = true;
      if (this.onDocSync) this.onDocSync();
    }, 160);
  }

  syncDocNow() {
    if (this._docTimer) {
      clearTimeout(this._docTimer);
      this._docTimer = 0;
    }
    if (!this.layers) return;
    this._compositeDoc();
    this._docValid = true;
    if (this.onDocSync) this.onDocSync();
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
    this._paperDirty = true;
    this.renderViewOnly();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this._paperDirty = true;
    this.renderViewOnly();
  }

  fit() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const s = Math.min(w / this.docW, h / this.docH) * 0.85;
    this.view.scale = s;
    this.view.rotation = 0;
    this.view.tx = (w - this.docW * s) / 2;
    this.view.ty = (h - this.docH * s) / 2;
    this._paperDirty = true;
    this.renderViewOnly();
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
    this._paperDirty = true;
    this.renderViewOnly();
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
    this._paperDirty = true;
    this.renderViewOnly();
  }

  panBy(dx, dy) {
    this.view.tx += dx;
    this.view.ty += dy;
    this._paperDirty = true;
    this.renderViewOnly();
  }

  /* ---------------- 渲染管线（性能优化） ----------------
     1) 静态纸面（工作区 + 阴影 + 白纸）缓存为屏幕大小位图，视图不变时只 blit
     2) 图层合成拆成「下方缓存 + 激活层 + 上方缓存」，笔画只重合成脏矩形
     3) render(rect) 只重绘脏区，避免每帧全量重绘
  */

  invalidatePaper() { this._paperDirty = true; }

  invalidateCompositeCaches() {
    this._caches = null;
    this._docValid = false;
  }

  _applyView(ctx) {
    const v = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(v.tx, v.ty);
    ctx.rotate(v.rotation);
    ctx.scale(v.scale, v.scale);
  }

  _buildPaper() {
    const c = this.canvas;
    if (!this._paper) this._paper = document.createElement('canvas');
    if (this._paper.width !== c.width || this._paper.height !== c.height) {
      this._paper.width = c.width;
      this._paper.height = c.height;
    }
    const p = this._paper.getContext('2d');
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.fillStyle = '#2b2b2b';
    p.fillRect(0, 0, this._paper.width, this._paper.height);

    const v = this.view;
    p.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    p.translate(v.tx, v.ty);
    p.rotate(v.rotation);
    p.scale(v.scale, v.scale);

    p.save();
    p.shadowColor = 'rgba(0,0,0,0.55)';
    p.shadowBlur = 28 / v.scale;
    p.shadowOffsetY = 2 / v.scale;
    p.fillStyle = '#ffffff';
    p.fillRect(0, 0, this.docW, this.docH);
    p.restore();

    p.strokeStyle = 'rgba(255,255,255,0.14)';
    p.lineWidth = 1 / v.scale;
    p.strokeRect(0, 0, this.docW, this.docH);

    this._paperDirty = false;
  }

  // 激活层在根层且不是剪贴层时，缓存「下方」和「上方」的合成结果。
  // 注意：激活层如果是剪贴基底，紧跟其后的剪贴层必须一起留在中间层，
  // 否则它们会被分到「上方」缓存里，失去基底裁剪（会被整片画出来）。
  _ensureCaches() {
    const layers = this.layers;
    if (!layers) return null;
    const loc = layers.locate(layers.activeId);
    if (!loc || loc.array !== layers.layers) return null;
    const node = layers.layers[loc.index];
    if (!node || node.type !== 'layer' || node.clipping) return null;

    let to = loc.index;
    while (to + 1 < layers.layers.length && layers.layers[to + 1].clipping) to++;

    if (this._caches
      && this._caches.activeId === node.id
      && this._caches.from === loc.index
      && this._caches.to === to
      && this._caches.w === layers.w
      && this._caches.h === layers.h) {
      return this._caches;
    }
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = layers.w;
      c.height = layers.h;
      return c;
    };
    const below = mk();
    const above = mk();
    layers._renderNodes(layers.layers.slice(0, loc.index), below.getContext('2d'), 0);
    layers._renderNodes(layers.layers.slice(to + 1), above.getContext('2d'), 0);
    this._caches = {
      below, above, activeId: node.id, from: loc.index, to, w: layers.w, h: layers.h,
    };
    return this._caches;
  }

  _compositeDoc() {
    if (!this.layers) return;
    const dctx = this.dctx;
    const caches = this._ensureCaches();
    if (!caches) {
      this.layers.composite(dctx, { checkerboard: true });
      return;
    }
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.globalAlpha = 1;
    dctx.globalCompositeOperation = 'source-over';
    dctx.clearRect(0, 0, this.layers.w, this.layers.h);
    dctx.fillStyle = this.layers._checkerPattern(dctx);
    dctx.fillRect(0, 0, this.layers.w, this.layers.h);
    dctx.drawImage(caches.below, 0, 0);
    // 激活层 + 挂在它上面的剪贴层作为一组渲染（保持裁剪关系）
    this.layers._renderNodes(this.layers.layers.slice(caches.from, caches.to + 1), dctx, 0);
    dctx.drawImage(caches.above, 0, 0);
  }

  _compositeDocRegion(rect) {
    if (!this.layers) return;
    const dctx = this.dctx;
    const caches = this._ensureCaches();
    if (!caches) { this.layers.composite(dctx, { checkerboard: true }); return; }
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const w = Math.min(this.layers.w - x, Math.ceil(rect.w) + 1);
    const h = Math.min(this.layers.h - y, Math.ceil(rect.h) + 1);
    if (w <= 0 || h <= 0) return;

    dctx.save();
    dctx.beginPath();
    dctx.rect(x, y, w, h);
    dctx.clip();
    dctx.globalAlpha = 1;
    dctx.globalCompositeOperation = 'source-over';
    dctx.clearRect(x, y, w, h);
    dctx.fillStyle = this.layers._checkerPattern(dctx);
    dctx.fillRect(x, y, w, h);
    dctx.drawImage(caches.below, x, y, w, h, x, y, w, h);
    // 已在脏区上做过 clip，这里把激活组整组画一遍
    this.layers._renderNodes(this.layers.layers.slice(caches.from, caches.to + 1), dctx, 0);
    dctx.drawImage(caches.above, x, y, w, h, x, y, w, h);
    dctx.restore();
  }

  // 世界矩形 → 屏幕包围盒（CSS px）
  _worldRectToScreen(rect) {
    const v = this.view;
    const cos = Math.cos(v.rotation);
    const sin = Math.sin(v.rotation);
    const pts = [
      [rect.x, rect.y], [rect.x + rect.w, rect.y],
      [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h],
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [wx, wy] of pts) {
      const sx = (wx * cos - wy * sin) * v.scale + v.tx;
      const sy = (wx * sin + wy * cos) * v.scale + v.ty;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  _paintScreen(clip) {
    const ctx = this.ctx;
    if (!this.canvas.width || !this.canvas.height) return;
    ctx.save();
    if (clip) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      ctx.rect(clip.x - 2, clip.y - 2, clip.w + 4, clip.h + 4);
      ctx.clip();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._paper, 0, 0);
    this._applyView(ctx);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.doc, 0, 0);
    ctx.restore();
  }

  // 注册渲染监听（可多个：导航器、标尺等）
  addRenderListener(fn) {
    this._renderListeners.add(fn);
    return () => this._renderListeners.delete(fn);
  }

  _fireRender() {
    if (this.onRender) this.onRender();
    for (const fn of this._renderListeners) {
      try { fn(); } catch (err) { console.warn('[render]', err); }
    }
  }

  /**
   * 渲染。传入 rect（世界坐标）时只更新脏区。
   */
  render(rect = null) {
    if (!this.canvas.width || !this.canvas.height) {
      this._fireRender();
      return;
    }
    if (this._syncGpuMode() && this._renderGpu()) {
      this._paintOverlaysOnly();
      this.scheduleDocSync();
      this._fireRender();
      return;
    }
    const paperWasDirty = this._paperDirty || !this._paper;
    if (paperWasDirty) this._buildPaper();

    if (rect) this._compositeDocRegion(rect);
    else this._compositeDoc();
    this._docValid = true;

    const clip = rect && !paperWasDirty ? this._worldRectToScreen(rect) : null;
    this._paintScreen(clip);

    this._paintOverlays();
    this._fireRender();
  }

  // 只重绘屏幕（不重新合成图层）：平移/缩放/旋转时用
  renderViewOnly() {
    if (!this.canvas.width || !this.canvas.height) {
      this._fireRender();
      return;
    }
    if (this._syncGpuMode() && this._renderGpu()) {
      this._paintOverlaysOnly();
      this._fireRender();
      return;
    }
    if (!this._docValid) {
      this._compositeDoc();
      this._docValid = true;
    }
    if (this._paperDirty || !this._paper) this._buildPaper();
    this._paintScreen(null);
    this._paintOverlays();
    this._fireRender();
  }

  _paintOverlays() {
    const ctx = this.ctx;
    const v = this.view;
    ctx.save();
    this._applyView(ctx);

    if (this.transform) this.transform.render(ctx, v);
    if (this.gradientPreview) this._drawGradientPreview(ctx);
    if (this.selection) this._drawSelection(ctx, v);

    if (this.previewPath) {
      ctx.save();
      ctx.lineWidth = 1 / v.scale;
      ctx.setLineDash([4 / v.scale, 4 / v.scale]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke(this.previewPath);
      ctx.lineDashOffset = -4 / v.scale;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.stroke(this.previewPath);
      ctx.restore();
    }

    ctx.restore();
  }

  renderDirty(rect) {
    this.render(rect);
  }

  // 渐变拖拽预览：直接按真实渐变画在文档范围内，半透明覆盖
  _drawGradientPreview(ctx) {
    const g = this.gradientPreview;
    if (!g) return;
    const hex2rgba = (hex, a) => {
      const m = hex.replace('#', '');
      const v = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
      return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${a})`;
    };
    let grad;
    if (g.type === 'radial') {
      const r = Math.max(1, Math.hypot(g.x1 - g.x0, g.y1 - g.y0));
      grad = ctx.createRadialGradient(g.x0, g.y0, 0, g.x0, g.y0, r);
    } else {
      const x1 = Math.abs(g.x1 - g.x0) < 0.01 && Math.abs(g.y1 - g.y0) < 0.01 ? g.x0 + 1 : g.x1;
      grad = ctx.createLinearGradient(g.x0, g.y0, x1, g.y1);
    }
    const c1 = hex2rgba(g.color, 0.85);
    const c2 = hex2rgba(g.color, 0);
    grad.addColorStop(0, g.reverse ? c2 : c1);
    grad.addColorStop(1, g.reverse ? c1 : c2);

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.docW, this.docH);

    // 方向指示线
    const lw = 1.2 / this.view.scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = lw * 2;
    ctx.beginPath();
    ctx.moveTo(g.x0, g.y0);
    ctx.lineTo(g.x1, g.y1);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.restore();
  }

  _drawSelection(ctx, v) {
    const sel = this.selection;
    if (!sel || !sel.active) return;
    const lw = 1 / v.scale;
    ctx.save();
    ctx.lineWidth = lw;
    ctx.setLineDash([4 * lw, 4 * lw]);
    if (sel.path) {
      ctx.lineDashOffset = -this.antsPhase * lw;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.stroke(sel.path);
      ctx.strokeStyle = 'rgba(0,0,0,0.88)';
      ctx.lineDashOffset = -(this.antsPhase + 4) * lw;
      ctx.stroke(sel.path);
    } else {
      ctx.lineDashOffset = -this.antsPhase * lw;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeRect(0, 0, this.docW, this.docH);
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineDashOffset = -(this.antsPhase + 4) * lw;
      ctx.strokeRect(0, 0, this.docW, this.docH);
    }
    ctx.restore();
  }

  // 切换文档尺寸（导入 PSD 时用）
  setDocSize(w, h) {
    this.docW = w;
    this.docH = h;
    this.doc.width = w;
    this.doc.height = h;
    this._paperDirty = true;
    this._caches = null;
    this._docValid = false;
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
