// 撤销/重做：笔画级（单层快照）+ 结构级（整栈快照）
export class History {
  constructor(engine, layers, limit = 25) {
    this.engine = engine;
    this.layers = layers;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  _snapCanvas(src) {
    const c = document.createElement('canvas');
    c.width = this.layers.w;
    c.height = this.layers.h;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  _push(stack, entry) {
    stack.push(entry);
    if (stack.length > this.limit) stack.shift();
  }

  // 在「修改激活图层像素」之前调用
  pushPaint() {
    const l = this.layers.active;
    if (!l) return;
    this._push(this.undoStack, { kind: 'paint', layerId: l.id, snap: this._snapCanvas(l.canvas) });
    this.redoStack.length = 0;
  }

  // 在「修改图层结构」（增删/移动/显隐/模式/不透明度/重命名）之前调用
  pushFull() {
    this._push(this.undoStack, { kind: 'full', state: this.layers.snapshotFull() });
    this.redoStack.length = 0;
  }

  _applyPaint(entry) {
    const l = this.layers.byId(entry.layerId) || this.layers.active;
    if (!l) return;
    l.ctx.save();
    l.ctx.globalCompositeOperation = 'source-over';
    l.ctx.globalAlpha = 1;
    l.ctx.clearRect(0, 0, this.layers.w, this.layers.h);
    l.ctx.drawImage(entry.snap, 0, 0);
    l.ctx.restore();
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    if (e.kind === 'paint') {
      const l = this.layers.byId(e.layerId) || this.layers.active;
      if (l) this._push(this.redoStack, { kind: 'paint', layerId: l.id, snap: this._snapCanvas(l.canvas) });
      this._applyPaint(e);
    } else {
      this._push(this.redoStack, { kind: 'full', state: this.layers.snapshotFull() });
      this.layers.restoreFull(e.state);
    }
    this.engine.render();
    if (this.layers.onChange) this.layers.onChange();
    return true;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    if (e.kind === 'paint') {
      const l = this.layers.byId(e.layerId) || this.layers.active;
      if (l) this._push(this.undoStack, { kind: 'paint', layerId: l.id, snap: this._snapCanvas(l.canvas) });
      this._applyPaint(e);
    } else {
      this._push(this.undoStack, { kind: 'full', state: this.layers.snapshotFull() });
      this.layers.restoreFull(e.state);
    }
    this.engine.render();
    if (this.layers.onChange) this.layers.onChange();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
