// 撤销/重做：瓦片级增量（笔画）+ 图层级/整栈级（结构操作）
//
// 笔画不再整层快照，而是把画布切成 128×128 瓦片：
//   落笔时只对「第一次被碰到」的瓦片保存 before 像素，
//   抬笔时保存同一批瓦片的 after 像素。
// 内存只与被笔触覆盖的面积成正比；一笔没画到的地方零开销。

const TILE = 128;

function tileKey(tx, ty) { return tx + ',' + ty; }
function parseKey(k) { const i = k.indexOf(','); return [ +k.slice(0, i), +k.slice(i + 1) ]; }

export class StrokeJournal {
  constructor(layers, layerId, target = 'layer') {
    this.layers = layers;
    this.layerId = layerId;
    this.target = target;   // 'layer' | 'mask'
    this.before = new Map();  // key -> ImageData
    this.after = new Map();
    this.bytes = 0;
  }

  _ctx() {
    const l = this.layers.byId(this.layerId);
    if (!l) return null;
    if (this.target === 'mask') return l.mask ? l.mask.ctx : null;
    return l.ctx;
  }

  _keysFor(x, y, r) {
    const w = this.layers.w;
    const h = this.layers.h;
    const x0 = Math.max(0, Math.floor((x - r) / TILE));
    const x1 = Math.min(Math.floor((w - 1) / TILE), Math.floor((x + r) / TILE));
    const y0 = Math.max(0, Math.floor((y - r) / TILE));
    const y1 = Math.min(Math.floor((h - 1) / TILE), Math.floor((y + r) / TILE));
    const keys = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) keys.push(tileKey(tx, ty));
    }
    return keys;
  }

  _rect(key) {
    const [tx, ty] = parseKey(key);
    const sx = tx * TILE;
    const sy = ty * TILE;
    return [sx, sy, Math.min(TILE, this.layers.w - sx), Math.min(TILE, this.layers.h - sy)];
  }

  // 在画这一笔之前调用：只复制首次碰到的瓦片
  captureBefore(x, y, radius) {
    const ctx = this._ctx();
    if (!ctx) return;
    for (const k of this._keysFor(x, y, radius)) {
      if (this.before.has(k)) continue;
      const [sx, sy, sw, sh] = this._rect(k);
      const img = ctx.getImageData(sx, sy, sw, sh);
      this.before.set(k, img);
      this.bytes += img.data.byteLength;
    }
  }

  // 抬笔时调用：补齐 after 像素，返回可入栈的历史条目
  commit() {
    const ctx = this._ctx();
    if (!ctx || this.before.size === 0) return null;
    for (const k of this.before.keys()) {
      const [sx, sy, sw, sh] = this._rect(k);
      const img = ctx.getImageData(sx, sy, sw, sh);
      this.after.set(k, img);
      this.bytes += img.data.byteLength;
    }
    return {
      kind: 'tiles', layerId: this.layerId, target: this.target,
      before: this.before, after: this.after, bytes: this.bytes,
    };
  }
}

export class History {
  constructor(engine, layers, limit = 50) {
    this.engine = engine;
    this.layers = layers;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.undoLabels = [];  // 与 undoStack 对齐：该步对应的操作名
    this.redoLabels = [];
    this.onChange = null;
    this._batch = false;
    this.trimmed = false;   // 是否因步数上限丢弃过最早的状态
  }

  _notify() {
    if (!this._batch && this.onChange) this.onChange();
  }

  _push(stack, labels, entry, label) {
    stack.push(entry);
    labels.push(label);
    while (stack.length > this.limit) {
      stack.shift();
      labels.shift();
      if (stack === this.undoStack) this.trimmed = true;
    }
  }

  /* ---------- 记录 ---------- */

  beginStroke(layerId, target = 'layer') {
    return new StrokeJournal(this.layers, layerId, target);
  }

  commitStroke(journal, label = '绘制') {
    const entry = journal.commit();
    if (!entry) return false;
    this._push(this.undoStack, this.undoLabels, entry, label);
    this.redoStack.length = 0;
    this.redoLabels.length = 0;
    this._notify();
    return true;
  }

  _fullEntry() {
    const state = this.layers.snapshotFull();
    return {
      kind: 'full',
      state,
      bytes: 0,   // 引用式快照：不复制像素，不额外占内存
    };
  }

  // 结构变化（增删/移动/显隐/模式/不透明度/重命名）
  pushFull(label = '编辑') {
    this._push(this.undoStack, this.undoLabels, this._fullEntry(), label);
    this.redoStack.length = 0;
    this.redoLabels.length = 0;
    this._notify();
  }

  // 单图层整体替换（如「清空图层」）：before 由调用方在修改前复制
  pushLayerDiff(layerId, beforeCanvas, label = '编辑') {
    const l = this.layers.byId(layerId);
    if (!l) return;
    const after = this._copy(beforeCanvas.width, beforeCanvas.height, l.canvas);
    const before = this._copy(beforeCanvas.width, beforeCanvas.height, beforeCanvas);
    this._push(this.undoStack, this.undoLabels, {
      kind: 'layer', layerId, before, after,
      bytes: before.width * before.height * 4 * 2,
    }, label);
    this.redoStack.length = 0;
    this.redoLabels.length = 0;
    this._notify();
  }

  _copy(w, h, src) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // 撤销「刚压栈但实际没发生」的操作（如已到顶仍上移）
  dropLast() {
    this.undoStack.pop();
    this.undoLabels.pop();
    this._notify();
  }

  captureLayer(layerId) {
    const l = this.layers.byId(layerId);
    return l ? this._copy(this.layers.w, this.layers.h, l.canvas) : null;
  }

  /* ---------- 应用 ---------- */

  _applyTiles(entry, which) {
    const l = this.layers.byId(entry.layerId);
    if (!l) return;
    const ctx = entry.target === 'mask' ? (l.mask && l.mask.ctx) : l.ctx;
    if (!ctx) return;
    const map = which === 'before' ? entry.before : entry.after;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    for (const [k, img] of map) {
      const [sx, sy] = this._rectOf(k, img.width, img.height);
      ctx.putImageData(img, sx, sy);
    }
    ctx.restore();
  }

  _rectOf(key, w, h) {
    const [tx, ty] = parseKey(key);
    return [tx * TILE, ty * TILE, w, h];
  }

  _applyLayer(entry, which) {
    const l = this.layers.byId(entry.layerId);
    if (!l) return;
    const src = which === 'before' ? entry.before : entry.after;
    l.ctx.save();
    l.ctx.globalCompositeOperation = 'source-over';
    l.ctx.globalAlpha = 1;
    l.ctx.clearRect(0, 0, this.layers.w, this.layers.h);
    l.ctx.drawImage(src, 0, 0);
    l.ctx.restore();
  }

  _doUndo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    const label = this.undoLabels.pop() || '编辑';

    if (e.kind === 'tiles') {
      this._applyTiles(e, 'before');
      this.redoStack.push(e);
    } else if (e.kind === 'layer') {
      this._applyLayer(e, 'before');
      this.redoStack.push(e);
    } else {
      this.redoStack.push(this._fullEntry());
      this.layers.restoreFull(e.state);
    }
    this.redoLabels.push(label);
    return true;
  }

  _doRedo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    const label = this.redoLabels.pop() || '编辑';

    if (e.kind === 'tiles') {
      this._applyTiles(e, 'after');
      this.undoStack.push(e);
    } else if (e.kind === 'layer') {
      this._applyLayer(e, 'after');
      this.undoStack.push(e);
    } else {
      this.undoStack.push(this._fullEntry());
      this.layers.restoreFull(e.state);
    }
    this.undoLabels.push(label);
    return true;
  }

  undo() {
    if (!this._doUndo()) return false;
    if (!this._batch) { this.engine.render(); this._notify(); }
    return true;
  }

  redo() {
    if (!this._doRedo()) return false;
    if (!this._batch) { this.engine.render(); this._notify(); }
    return true;
  }

  // 跳转到时间轴某个位置（0 = 最早），内部逐步回放
  jumpTo(target) {
    const max = this.undoStack.length + this.redoStack.length;
    target = Math.max(0, Math.min(target, max));
    this._batch = true;
    let guard = max + 4;
    while (this.undoStack.length > target && guard-- > 0) this._doUndo();
    while (this.undoStack.length < target && guard-- > 0) this._doRedo();
    this._batch = false;
    this.engine.render();
    if (this.layers.onChange) this.layers.onChange();
    this._notify();
    return this.undoStack.length === target;
  }

  /* ---------- 查询 ---------- */

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get position() { return this.undoStack.length; }

  // 时间轴：[{index, label, current, future}]
  timeline() {
    const n = this.undoStack.length;
    const rn = this.redoStack.length;
    const items = [{
      index: 0,
      label: this.trimmed ? '更早的状态' : '初始状态',
      current: n === 0,
      future: false,
    }];
    for (let i = 0; i < n; i++) {
      items.push({ index: i + 1, label: this.undoLabels[i] || '编辑', current: n === i + 1, future: false });
    }
    for (let i = rn - 1; i >= 0; i--) {
      items.push({ index: n + (rn - i), label: this.redoLabels[i] || '编辑', current: false, future: true });
    }
    return items;
  }

  memoryBytes() {
    let b = 0;
    for (const e of this.undoStack) b += e.bytes || 0;
    for (const e of this.redoStack) b += e.bytes || 0;
    return b;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.undoLabels.length = 0;
    this.redoLabels.length = 0;
    this.trimmed = false;
    this._notify();
  }
}
