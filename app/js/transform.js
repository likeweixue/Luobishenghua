// 自由变换：把选区内容（或整层）"提"到浮动层，拖动/缩放/旋转/翻转后落回图层
// 提层时立即从图层上挖掉对应像素，取消 = 原样还原；提交 = 写回并记一条图层级撤销
export class Transform {
  constructor(engine, layers, history, selection) {
    this.engine = engine;
    this.layers = layers;
    this.history = history;
    this.selection = selection;
    this.active = false;
    this.mode = 'free';
    this.drag = null;
  }

  start(mode = 'free') {
    const layer = this.layers.active;
    if (!layer || layer.type !== 'layer' || layer.locked) return false;
    if (this.active) return false;

    const w = this.layers.w;
    const h = this.layers.h;
    const hasSel = this.selection && this.selection.active && this.selection.bounds;
    const bounds = hasSel ? this.selection.bounds : { x: 0, y: 0, w, h };

    this.layer = layer;
    // 取消时用它整层还原（只存实际存在的瓦片，空白区域零开销）
    this.beforeSnap = layer.surface.snapshotAll();

    // 源：选区内容或整层（直接从瓦片取这块区域）
    const src = layer.surface.extract(bounds.x, bounds.y, bounds.w, bounds.h);
    if (hasSel) {
      const sctx = src.getContext('2d');
      sctx.globalCompositeOperation = 'destination-in';
      sctx.drawImage(this.selection.mask, -bounds.x, -bounds.y);
      sctx.globalCompositeOperation = 'source-over';
    }

    // 从图层挖掉
    if (hasSel) {
      layer.surface.drawCanvas(this.selection.mask, 0, 0, { composite: 'destination-out' });
    } else {
      layer.surface.clearAll();
    }

    this.source = src;
    this.srcW = src.width;
    this.srcH = src.height;
    this.cx = bounds.x + bounds.w / 2;
    this.cy = bounds.y + bounds.h / 2;
    this.dx = 0;
    this.dy = 0;
    this.scaleX = 1;
    this.scaleY = 1;
    this.angle = 0;
    this.flipH = false;
    this.flipV = false;
    this.active = true;
    this.mode = mode;
    this.drag = null;

    this.engine.transform = this;
    this.engine.render();
    return true;
  }

  /* ---------------- 几何 ---------------- */

  _center() {
    return { x: this.cx + this.dx, y: this.cy + this.dy };
  }

  _localToWorld(px, py) {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const ctr = this._center();
    return { x: ctr.x + px * c - py * s, y: ctr.y + px * s + py * c };
  }

  _worldToLocal(x, y) {
    const c = Math.cos(-this.angle);
    const s = Math.sin(-this.angle);
    const ctr = this._center();
    const dx = x - ctr.x;
    const dy = y - ctr.y;
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  _half() {
    return { hw: (this.srcW * this.scaleX) / 2, hh: (this.srcH * this.scaleY) / 2 };
  }

  handles() {
    const { hw, hh } = this._half();
    const defs = [
      ['nw', -hw, -hh], ['n', 0, -hh], ['ne', hw, -hh],
      ['e', hw, 0], ['se', hw, hh], ['s', 0, hh],
      ['sw', -hw, hh], ['w', -hw, 0],
    ];
    const out = defs.map(([k, x, y]) => ({ k, ...this._localToWorld(x, y) }));
    // 旋转手柄：上方 28 屏幕像素
    const top = this._localToWorld(0, -hh);
    const ctr = this._center();
    const len = Math.hypot(top.x - ctr.x, top.y - ctr.y) || 1;
    const ux = (top.x - ctr.x) / len;
    const uy = (top.y - ctr.y) / len;
    const off = 30 / this.engine.view.scale;
    out.push({ k: 'rotate', x: top.x + ux * off, y: top.y + uy * off });
    return out;
  }

  hitTest(sx, sy) {
    const p = this.engine.screenToWorld(sx, sy);
    const tol = 9 / this.engine.view.scale;
    for (const hd of this.handles()) {
      if (Math.hypot(p.x - hd.x, p.y - hd.y) <= tol) return hd.k;
    }
    const loc = this._worldToLocal(p.x, p.y);
    const { hw, hh } = this._half();
    if (Math.abs(loc.x) <= hw && Math.abs(loc.y) <= hh) return 'move';
    return null;
  }

  /* ---------------- 交互 ---------------- */

  beginDrag(handle, sx, sy) {
    if (!this.active) return false;
    const p = this.engine.screenToWorld(sx, sy);
    this.drag = {
      handle,
      startWorld: p,
      startDx: this.dx,
      startDy: this.dy,
      startScaleX: this.scaleX,
      startScaleY: this.scaleY,
      startAngle: this.angle,
      startAnglePointer: Math.atan2(p.y - this._center().y, p.x - this._center().x),
    };
    return true;
  }

  pointerDown(sx, sy) {
    if (!this.active) return false;
    const handle = this.hitTest(sx, sy);
    if (!handle) return false;
    return this.beginDrag(handle, sx, sy);
  }

  pointerMove(sx, sy, shift = false) {
    if (!this.active || !this.drag) return false;
    const p = this.engine.screenToWorld(sx, sy);
    const d = this.drag;

    if (d.handle === 'move') {
      this.dx = d.startDx + (p.x - d.startWorld.x);
      this.dy = d.startDy + (p.y - d.startWorld.y);
    } else if (d.handle === 'rotate') {
      const ctr = this._center();
      const a = Math.atan2(p.y - ctr.y, p.x - ctr.x);
      let angle = d.startAngle + (a - d.startAnglePointer);
      if (shift) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      this.angle = angle;
    } else {
      const loc = this._worldToLocal(p.x, p.y);
      const halfW = this.srcW / 2;
      const halfH = this.srcH / 2;
      let scaleX = this.scaleX;
      let scaleY = this.scaleY;
      const kx = Math.abs(loc.x) / Math.max(1, halfW);
      const ky = Math.abs(loc.y) / Math.max(1, halfH);
      if (d.handle.includes('e') || d.handle.includes('w')) scaleX = Math.max(0.02, kx);
      if (d.handle.includes('n') || d.handle.includes('s')) scaleY = Math.max(0.02, ky);
      if (shift && d.handle.length === 2) {
        const k = Math.max(scaleX, scaleY);
        scaleX = scaleY = k;
      }
      this.scaleX = scaleX;
      this.scaleY = scaleY;
    }
    this.engine.render();
    return true;
  }

  pointerUp() {
    if (!this.active) return;
    this.drag = null;
    if (this.mode === 'move') this.commit();
  }

  flip(axis) {
    if (!this.active) return;
    if (axis === 'h') this.flipH = !this.flipH;
    else this.flipV = !this.flipV;
    this.engine.render();
  }

  /* ---------------- 提交 / 取消 ---------------- */

  commit() {
    if (!this.active) return false;
    const w = this.layers.w;
    const h = this.layers.h;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    const ctr = this._center();
    tctx.save();
    tctx.translate(ctr.x, ctr.y);
    tctx.rotate(this.angle);
    tctx.scale(this.scaleX * (this.flipH ? -1 : 1), this.scaleY * (this.flipV ? -1 : 1));
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(this.source, -this.srcW / 2, -this.srcH / 2, this.srcW, this.srcH);
    tctx.restore();

    this.layer.surface.putCanvas(tmp, 0, 0);

    this.history.pushLayerDiff(this.layer.id, this.beforeSnap, '自由变换');
    this._cleanup();
    this.engine.render();
    if (this.layers.onChange) this.layers.onChange();
    return true;
  }

  cancel() {
    if (!this.active) return false;
    if (this.beforeSnap) this.layer.surface.restoreAll(this.beforeSnap);
    this._cleanup();
    this.engine.render();
    if (this.layers.onChange) this.layers.onChange();
    return true;
  }

  reset() {
    this._cleanup();
  }

  _cleanup() {
    this.active = false;
    this.drag = null;
    this.source = null;
    this.beforeSnap = null;
    this.engine.transform = null;
  }

  /* ---------------- 绘制 ---------------- */

  render(ctx, view) {
    if (!this.active || !this.source) return;
    const ctr = this._center();
    ctx.save();
    ctx.translate(ctr.x, ctr.y);
    ctx.rotate(this.angle);
    ctx.scale(this.scaleX * (this.flipH ? -1 : 1), this.scaleY * (this.flipV ? -1 : 1));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.source, -this.srcW / 2, -this.srcH / 2, this.srcW, this.srcH);
    ctx.restore();

    if (this.mode !== 'free') return;

    const lw = 1 / view.scale;
    const { hw, hh } = this._half();
    const quad = [
      this._localToWorld(-hw, -hh),
      this._localToWorld(hw, -hh),
      this._localToWorld(hw, hh),
      this._localToWorld(-hw, hh),
    ];

    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(74,144,217,0.95)';
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.stroke();

    // 旋转手柄连线
    const top = this._localToWorld(0, -hh);
    const rot = this.handles().find(h => h.k === 'rotate');
    if (rot) {
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(rot.x, rot.y);
      ctx.stroke();
    }

    // 手柄
    const s = 4 / view.scale;
    for (const hd of this.handles()) {
      ctx.beginPath();
      if (hd.k === 'rotate') {
        ctx.arc(hd.x, hd.y, s, 0, Math.PI * 2);
      } else {
        ctx.rect(hd.x - s, hd.y - s, s * 2, s * 2);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(74,144,217,1)';
      ctx.stroke();
    }
    ctx.restore();
  }
}
