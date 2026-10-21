// 图层栈：多图层管理 + 合成输出
// layers[0] 在最底层（纸张），数组末尾在顶层
export class LayerStack {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.layers = [];
    this.nextId = 1;
    this.activeId = null;
    this.onChange = null; // 结构/内容变化回调（刷新面板、缩略图）

    const paper = this._create('纸张');
    paper.locked = true;
    paper.ctx.fillStyle = '#ffffff';
    paper.ctx.fillRect(0, 0, w, h);
    this.layers.push(paper);

    const l1 = this._create('图层 1');
    this.layers.push(l1);
    this.activeId = l1.id;
  }

  _create(name) {
    const canvas = document.createElement('canvas');
    canvas.width = this.w;
    canvas.height = this.h;
    return {
      id: this.nextId++,
      name,
      canvas,
      ctx: canvas.getContext('2d'),
      visible: true,
      opacity: 1,
      blend: 'source-over',
      locked: false,
    };
  }

  byId(id) { return this.layers.find(l => l.id === id); }
  get active() { return this.byId(this.activeId); }
  get activeIndex() { return this.layers.findIndex(l => l.id === this.activeId); }

  // 重置为空栈（导入文档时用）
  reset(w, h) {
    this.w = w;
    this.h = h;
    this.layers = [];
    this.nextId = 1;
    this.activeId = null;
  }

  // 从外部定义推入一个图层（PSD 导入用），按数组顺序（底层先推）
  pushLayer(def) {
    const l = this._create(def.name || '图层 ' + this.nextId);
    if (def.visible !== undefined) l.visible = def.visible;
    if (def.opacity !== undefined) l.opacity = def.opacity;
    if (def.blend !== undefined) l.blend = def.blend;
    if (def.canvas) l.ctx.drawImage(def.canvas, def.left || 0, def.top || 0);
    this.layers.push(l);
    this.activeId = l.id;
    return l;
  }

  addLayer() {
    const l = this._create('图层 ' + this.nextId);
    const idx = this.activeIndex;
    this.layers.splice(idx + 1, 0, l); // 插入到激活图层上方
    this.activeId = l.id;
    this._changed();
    return l;
  }

  deleteActive() {
    const l = this.active;
    if (!l || l.locked || this.layers.length <= 1) return false;
    const idx = this.activeIndex;
    this.layers.splice(idx, 1);
    // 激活邻居：优先上方，否则下方
    const next = this.layers[idx] || this.layers[idx - 1];
    this.activeId = next.id;
    this._changed();
    return true;
  }

  moveActive(dir) { // dir=+1 上移一层，-1 下移一层
    const idx = this.activeIndex;
    const target = idx + dir;
    if (target < 0 || target >= this.layers.length) return false;
    if (this.layers[target].locked || this.active.locked) return false;
    [this.layers[idx], this.layers[target]] = [this.layers[target], this.layers[idx]];
    this._changed();
    return true;
  }

  setActive(id) {
    if (this.byId(id)) {
      this.activeId = id;
      this._changed();
    }
  }

  setVisible(id, v) {
    const l = this.byId(id);
    if (l) { l.visible = v; this._changed(); }
  }

  setOpacity(v) {
    if (this.active && !this.active.locked) {
      this.active.opacity = v;
      this._changed();
    }
  }

  setBlend(mode) {
    if (this.active && !this.active.locked) {
      this.active.blend = mode;
      this._changed();
    }
  }

  rename(id, name) {
    const l = this.byId(id);
    if (l && name.trim()) { l.name = name.trim(); this._changed(); }
  }

  // 合成所有可见图层到目标 ctx
  composite(ctx, { checkerboard = false } = {}) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.w, this.h);
    if (checkerboard) {
      ctx.fillStyle = this._checkerPattern(ctx);
      ctx.fillRect(0, 0, this.w, this.h);
    }
    for (const l of this.layers) {
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blend;
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.restore();
  }

  _checkerPattern(ctx) {
    if (!this._checker) {
      const t = document.createElement('canvas');
      t.width = t.height = 16;
      const tc = t.getContext('2d');
      tc.fillStyle = '#ffffff';
      tc.fillRect(0, 0, 16, 16);
      tc.fillStyle = '#d9d9d9';
      tc.fillRect(0, 0, 8, 8);
      tc.fillRect(8, 8, 8, 8);
      this._checker = ctx.createPattern(t, 'repeat');
    }
    return this._checker;
  }

  /* ---------- 历史快照（结构级） ---------- */

  // 结构级快照：只存元数据 + 画布引用（结构操作不改像素，顺序回放保证内容正确）
  // 这样加/删/移动/显隐等操作几乎不占内存，撤销也不会整层复制。
  snapshotFull() {
    return {
      activeId: this.activeId,
      nextId: this.nextId,
      layers: this.layers.map(l => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        blend: l.blend,
        locked: l.locked,
        canvas: l.canvas,
      })),
    };
  }

  restoreFull(state) {
    this.layers = state.layers.map(m => ({
      id: m.id, name: m.name, visible: m.visible,
      opacity: m.opacity, blend: m.blend, locked: m.locked,
      canvas: m.canvas, ctx: m.canvas.getContext('2d'),
    }));
    this.nextId = state.nextId;
    this.activeId = this.byId(state.activeId) ? state.activeId : this.layers[this.layers.length - 1].id;
    this._changed();
  }

  _copyCanvas(src) {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  _changed() {
    if (this.onChange) this.onChange();
  }
}
