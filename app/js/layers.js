// 图层栈：树结构（组 / 图层）+ 图层蒙版 + 剪贴蒙版 + 锁定 + 合并
//
// 节点结构：
//   图层 { id, type:'layer', name, visible, opacity, blend, locked, lockAlpha,
//          clipping, canvas, ctx, mask: null | { canvas, ctx, enabled } }
//   组   { id, type:'group', name, visible, opacity, blend, locked,
//          clipping, expanded, children: [] }
//
// 数组约定：同一层内 children[0] 在最下面，末尾在最上面（与 PSD 文件顺序一致）。

export class LayerStack {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.layers = [];        // 根节点数组（最底层在前）
    this.nextId = 1;
    this.activeId = null;
    this.onChange = null;
    this._bufs = [];         // 合成缓冲区池（组缓冲 / 蒙版 / 剪贴）
    this._checker = null;

    const paper = this._create('纸张');
    paper.locked = true;
    paper.ctx.fillStyle = '#ffffff';
    paper.ctx.fillRect(0, 0, w, h);
    this.layers.push(paper);

    const l1 = this._create('图层 1');
    this.layers.push(l1);
    this.activeId = l1.id;
  }

  /* ---------------- 节点创建 ---------------- */

  _create(name) {
    const canvas = document.createElement('canvas');
    canvas.width = this.w;
    canvas.height = this.h;
    return {
      id: this.nextId++,
      type: 'layer',
      name,
      canvas,
      ctx: canvas.getContext('2d'),
      visible: true,
      opacity: 1,
      blend: 'source-over',
      locked: false,
      lockAlpha: false,
      clipping: false,
      mask: null,
    };
  }

  _createGroup(name) {
    return {
      id: this.nextId++,
      type: 'group',
      name,
      visible: true,
      opacity: 1,
      blend: 'source-over',
      locked: false,
      clipping: false,
      expanded: true,
      children: [],
      mask: null,
    };
  }

  /* ---------------- 查找 ---------------- */

  byId(id) {
    return this._find(this.layers, id);
  }

  _find(nodes, id) {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.type === 'group') {
        const hit = this._find(n.children, id);
        if (hit) return hit;
      }
    }
    return null;
  }

  // 返回包含该节点的数组与下标
  locate(id, nodes = this.layers, trail = []) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { array: nodes, index: i, path: trail.concat(i) };
      if (n.type === 'group') {
        const hit = this.locate(id, n.children, trail.concat(i));
        if (hit) return hit;
      }
    }
    return null;
  }

  pathOf(id) {
    const loc = this.locate(id);
    return loc ? loc.path : null;
  }

  nodeAtPath(path) {
    let arr = this.layers;
    let node = null;
    for (const i of path) {
      node = arr[i];
      if (!node) return null;
      arr = node.children || [];
    }
    return node;
  }

  get active() { return this.byId(this.activeId); }

  get activeIndex() {
    const loc = this.locate(this.activeId);
    return loc ? loc.index : -1;
  }

  activeParent() {
    const loc = this.locate(this.activeId);
    return loc ? loc.array : this.layers;
  }

  // 面板用：从顶层往下的扁平列表 [{ node, depth }]
  flatTopFirst() {
    const out = [];
    const walk = (nodes, depth) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        out.push({ node: n, depth });
        if (n.type === 'group' && n.expanded) walk(n.children, depth + 1);
      }
    };
    walk(this.layers, 0);
    return out;
  }

  // 所有叶子图层（自下而上）
  leaves() {
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.type === 'group') walk(n.children);
        else out.push(n);
      }
    };
    walk(this.layers);
    return out;
  }

  /* ---------------- 文档 ---------------- */

  reset(w, h) {
    this.w = w;
    this.h = h;
    this.layers = [];
    this.nextId = 1;
    this.activeId = null;
    this._bufs = [];
    this._checker = null;
  }

  // 按「底层先推」的顺序加入图层（PSD / 工程导入用）
  pushLayer(def) {
    const l = this._create(def.name || '图层 ' + this.nextId);
    if (def.visible !== undefined) l.visible = def.visible;
    if (def.opacity !== undefined) l.opacity = def.opacity;
    if (def.blend !== undefined) l.blend = def.blend;
    if (def.locked !== undefined) l.locked = def.locked;
    if (def.lockAlpha) l.lockAlpha = true;
    if (def.clipping) l.clipping = true;
    if (def.canvas) l.ctx.drawImage(def.canvas, def.left || 0, def.top || 0);
    if (def.maskCanvas) l.mask = this._makeMaskFromCanvas(def.maskCanvas);
    this.layers.push(l);
    this.activeId = l.id;
    return l;
  }

  // 从工程/PSD 的节点定义树构建图层（递归）
  importNodes(defs) {
    return (defs || []).map(d => {
      if (d.type === 'group') {
        const g = this._createGroup(d.name || '组');
        this._applyDef(g, d);
        g.expanded = d.expanded !== false;
        if (d.maskCanvas) {
          g.mask = this._makeMaskFromCanvas(d.maskCanvas);
          g.mask.enabled = d.maskEnabled !== false;
        }
        g.children = this.importNodes(d.children || []);
        return g;
      }
      const l = this._create(d.name || '图层');
      this._applyDef(l, d);
      l.lockAlpha = !!d.lockAlpha;
      if (d.canvas) l.ctx.drawImage(d.canvas, d.left || 0, d.top || 0);
      if (d.maskCanvas) {
        l.mask = this._makeMaskFromCanvas(d.maskCanvas);
        l.mask.enabled = d.maskEnabled !== false;
      }
      return l;
    });
  }

  _applyDef(n, d) {
    if (d.visible !== undefined) n.visible = d.visible;
    if (d.opacity !== undefined) n.opacity = d.opacity;
    if (d.blend !== undefined) n.blend = d.blend;
    if (d.locked !== undefined) n.locked = d.locked;
    if (d.clipping !== undefined) n.clipping = d.clipping;
  }

  _makeMaskFromCanvas(src) {
    const canvas = document.createElement('canvas');
    canvas.width = this.w;
    canvas.height = this.h;
    canvas.getContext('2d').drawImage(src, 0, 0);
    return { canvas, ctx: canvas.getContext('2d'), enabled: true };
  }

  /* ---------------- 结构操作 ---------------- */

  addLayer() {
    const l = this._create('图层 ' + this.nextId);
    const act = this.active;
    if (act && act.type === 'group') {
      act.children.push(l);
    } else {
      const loc = this.locate(this.activeId);
      const arr = loc ? loc.array : this.layers;
      const idx = loc ? loc.index : arr.length - 1;
      arr.splice(idx + 1, 0, l);
    }
    this.activeId = l.id;
    this._changed();
    return l;
  }

  addGroup() {
    const g = this._createGroup('组 ' + this.nextId);
    const act = this.active;
    if (act && act.type === 'group') {
      act.children.push(g);
    } else {
      const loc = this.locate(this.activeId);
      const arr = loc ? loc.array : this.layers;
      const idx = loc ? loc.index : arr.length - 1;
      arr.splice(idx + 1, 0, g);
    }
    this.activeId = g.id;
    this._changed();
    return g;
  }

  deleteActive() {
    const act = this.active;
    if (!act || act.locked) return false;
    const loc = this.locate(act.id);
    if (!loc) return false;
    if (loc.array === this.layers && this.layers.length <= 1) return false;
    loc.array.splice(loc.index, 1);
    const next = loc.array[loc.index] || loc.array[loc.index - 1];
    if (next) this.activeId = next.id;
    else if (this.layers.length) this.activeId = this.layers[this.layers.length - 1].id;
    this._changed();
    return true;
  }

  moveActive(dir) {
    const loc = this.locate(this.activeId);
    if (!loc) return false;
    const target = loc.index + dir;
    if (target < 0 || target >= loc.array.length) return false;
    const node = loc.array[loc.index];
    if (node.locked || loc.array[target].locked) return false;
    loc.array[loc.index] = loc.array[target];
    loc.array[target] = node;
    this._changed();
    return true;
  }

  // 把节点移入指定组（放到组内最上层）
  moveIntoGroup(groupId, nodeId = this.activeId) {
    const g = this.byId(groupId);
    if (!g || g.type !== 'group' || groupId === nodeId) return false;
    const loc = this.locate(nodeId);
    if (!loc) return false;
    if (loc.array === g.children) return false;
    const [node] = loc.array.splice(loc.index, 1);
    g.children.push(node);
    this.activeId = node.id;
    this._changed();
    return true;
  }

  _findParentArray(arr, nodes = this.layers) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'group') {
        if (n.children === arr) return { node: n, array: nodes, index: i };
        const hit = this._findParentArray(arr, n.children);
        if (hit) return hit;
      }
    }
    return null;
  }

  // 移入同一层中「上方最近的组」
  moveActiveIntoNearestGroup() {
    const loc = this.locate(this.activeId);
    if (!loc) return false;
    for (let i = loc.index + 1; i < loc.array.length; i++) {
      if (loc.array[i].type === 'group') return this.moveIntoGroup(loc.array[i].id);
    }
    return false;
  }

  // 移出所在的组，放到组的上方
  moveActiveOutOfGroup() {
    const loc = this.locate(this.activeId);
    if (!loc) return false;
    const parent = this._findParentArray(loc.array);
    if (!parent) return false; // 已经在根层
    const [node] = loc.array.splice(loc.index, 1);
    const gIdx = parent.array.indexOf(parent.node);
    parent.array.splice(gIdx + 1, 0, node);
    this.activeId = node.id;
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
    const n = this.byId(id);
    if (n) { n.visible = v; this._changed(); }
  }

  setOpacity(v) {
    const n = this.active;
    if (n && !n.locked) { n.opacity = v; this._changed(); }
  }

  setBlend(mode) {
    const n = this.active;
    if (n && !n.locked) { n.blend = mode; this._changed(); }
  }

  rename(id, name) {
    const n = this.byId(id);
    if (n && name.trim()) { n.name = name.trim(); this._changed(); }
  }

  toggleLock(id = this.activeId) {
    const n = this.byId(id);
    if (!n || n.type !== 'layer') return false;
    n.locked = !n.locked;
    this._changed();
    return true;
  }

  toggleLockAlpha(id = this.activeId) {
    const n = this.byId(id);
    if (!n || n.type !== 'layer') return false;
    n.lockAlpha = !n.lockAlpha;
    this._changed();
    return true;
  }

  toggleExpanded(id) {
    const n = this.byId(id);
    if (!n || n.type !== 'group') return false;
    n.expanded = !n.expanded;
    this._changed();
    return true;
  }

  toggleClipping(id = this.activeId) {
    const n = this.byId(id);
    if (!n) return false;
    n.clipping = !n.clipping;
    this._changed();
    return true;
  }

  /* ---------------- 蒙版 ---------------- */

  addMask(id = this.activeId) {
    const n = this.byId(id);
    if (!n || n.mask) return false;
    const canvas = document.createElement('canvas');
    canvas.width = this.w;
    canvas.height = this.h;
    const ctx = canvas.getContext('2d');
    // 蒙版用 alpha 通道表达：全白 = 全显示
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.w, this.h);
    n.mask = { canvas, ctx, enabled: true };
    this._changed();
    return true;
  }

  deleteMask(id = this.activeId) {
    const n = this.byId(id);
    if (!n || !n.mask) return false;
    n.mask = null;
    this._changed();
    return true;
  }

  toggleMaskEnabled(id = this.activeId) {
    const n = this.byId(id);
    if (!n || !n.mask) return false;
    n.mask.enabled = !n.mask.enabled;
    this._changed();
    return true;
  }

  // 反相蒙版：写新画布（copy-on-write），避免破坏历史快照引用的旧画布
  invertMask(id = this.activeId) {
    const n = this.byId(id);
    if (!n || !n.mask) return false;
    const src = n.mask.ctx.getImageData(0, 0, this.w, this.h);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = 255 - d[i + 3];
    }
    const canvas = document.createElement('canvas');
    canvas.width = this.w;
    canvas.height = this.h;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(src, 0, 0);
    n.mask = { canvas, ctx, enabled: n.mask.enabled };
    this._changed();
    return true;
  }

  clearMask(id = this.activeId) {
    const n = this.byId(id);
    if (!n || !n.mask) return false;
    const canvas = document.createElement('canvas');
    canvas.width = this.w;
    canvas.height = this.h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.w, this.h);
    n.mask = { canvas, ctx, enabled: n.mask.enabled };
    this._changed();
    return true;
  }

  // 蒙版上作画：亮度当作蒙版值（白=显示，黑=隐藏）
  paintMaskDab(layer, x, y, size, lum, stampCanvas) {
    if (!layer.mask || !layer.mask.enabled) return;
    const ctx = layer.mask.ctx;
    ctx.save();
    if (lum >= 0.5) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = lum;
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1 - lum;
    }
    ctx.drawImage(stampCanvas, x - size / 2, y - size / 2, size, size);
    ctx.restore();
  }

  /* ---------------- 合并 ---------------- */

  _blank() {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    return c;
  }

  // 合并到下一层（仅同组内相邻的两个图层）
  mergeDown(id = this.activeId) {
    const loc = this.locate(id);
    if (!loc || loc.index === 0) return false;
    const above = loc.array[loc.index];
    const below = loc.array[loc.index - 1];
    if (above.type !== 'layer' || below.type !== 'layer') return false;
    if (below.locked) return false;

    const c = this._blank();
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.globalAlpha = below.opacity;
    ctx.drawImage(this._contentOf(below), 0, 0);
    ctx.globalAlpha = above.opacity;
    ctx.globalCompositeOperation = above.clipping ? 'source-atop' : above.blend;
    ctx.drawImage(this._contentOf(above), 0, 0);
    ctx.restore();

    below.ctx.clearRect(0, 0, this.w, this.h);
    below.ctx.drawImage(c, 0, 0);
    below.opacity = 1;
    below.blend = 'source-over';
    below.mask = null;
    below.clipping = false;

    loc.array.splice(loc.index, 1);
    this.activeId = below.id;
    this._changed();
    return true;
  }

  // 盖印：把当前所有可见内容合成到一个新图层（保留原图层）
  stampVisible() {
    const c = this._blank();
    this.composite(c.getContext('2d'), { checkerboard: false });
    const l = this._create('盖印图层');
    l.ctx.drawImage(c, 0, 0);
    const arr = this.activeParent();
    const loc = this.locate(this.activeId);
    arr.splice(loc ? loc.index + 1 : arr.length, 0, l);
    this.activeId = l.id;
    this._changed();
    return l;
  }

  // 合并可见：可见内容合成一层，隐藏图层保留
  mergeVisible() {
    const c = this._blank();
    this.composite(c.getContext('2d'), { checkerboard: false });
    const prune = (nodes) => nodes.filter(n => {
      if (n.visible) return false;
      if (n.type === 'group') n.children = prune(n.children);
      return true;
    });
    this.layers = prune(this.layers);
    const l = this._create('合并图层');
    l.ctx.drawImage(c, 0, 0);
    this.layers.push(l);
    this.activeId = l.id;
    this._changed();
    return l;
  }

  // 拼合图像：全部压成一层
  flatten() {
    const c = this._blank();
    this.composite(c.getContext('2d'), { checkerboard: false });
    this.layers = [];
    const l = this._create('背景');
    l.ctx.drawImage(c, 0, 0);
    this.layers.push(l);
    this.activeId = l.id;
    this._changed();
    return l;
  }

  /* ---------------- 合成 ---------------- */

  _buffer(slot) {
    let c = this._bufs[slot];
    if (!c) {
      c = document.createElement('canvas');
      this._bufs[slot] = c;
    }
    if (c.width !== this.w || c.height !== this.h) {
      c.width = this.w;
      c.height = this.h;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.w, this.h);
    return { canvas: c, ctx };
  }

  _draw(target, src, node) {
    target.save();
    target.globalAlpha = node.opacity;
    target.globalCompositeOperation = node.blend || 'source-over';
    target.drawImage(src, 0, 0);
    target.restore();
  }

  // 图层内容（叠加蒙版后的结果）
  _contentOf(node, depth = 0) {
    if (!node.mask || !node.mask.enabled) return node.canvas;
    const m = this._buffer(depth * 3 + 1);
    m.ctx.drawImage(node.canvas, 0, 0);
    m.ctx.globalCompositeOperation = 'destination-in';
    m.ctx.drawImage(node.mask.canvas, 0, 0);
    m.ctx.globalCompositeOperation = 'source-over';
    return m.canvas;
  }

  _renderNodes(nodes, target, depth) {
    let clipBase = null;
    for (const node of nodes) {
      if (!node.visible) {
        if (!node.clipping) clipBase = null;
        continue;
      }

      if (node.type === 'group') {
        const buf = this._buffer(depth * 3);
        this._renderNodes(node.children, buf.ctx, depth + 1);
        let src = buf.canvas;
        if (node.mask && node.mask.enabled) {
          const m = this._buffer(depth * 3 + 1);
          m.ctx.drawImage(src, 0, 0);
          m.ctx.globalCompositeOperation = 'destination-in';
          m.ctx.drawImage(node.mask.canvas, 0, 0);
          m.ctx.globalCompositeOperation = 'source-over';
          src = m.canvas;
        }
        if (node.clipping && clipBase) {
          const c = this._buffer(depth * 3 + 2);
          c.ctx.drawImage(src, 0, 0);
          c.ctx.globalCompositeOperation = 'destination-in';
          c.ctx.drawImage(clipBase, 0, 0);
          c.ctx.globalCompositeOperation = 'source-over';
          this._draw(target, c.canvas, node);
        } else {
          this._draw(target, src, node);
          clipBase = src;
        }
      } else {
        let src = node.canvas;
        if (node.mask && node.mask.enabled) {
          const m = this._buffer(depth * 3 + 1);
          m.ctx.drawImage(node.canvas, 0, 0);
          m.ctx.globalCompositeOperation = 'destination-in';
          m.ctx.drawImage(node.mask.canvas, 0, 0);
          m.ctx.globalCompositeOperation = 'source-over';
          src = m.canvas;
        }
        if (node.clipping && clipBase) {
          const c = this._buffer(depth * 3 + 2);
          c.ctx.drawImage(src, 0, 0);
          c.ctx.globalCompositeOperation = 'destination-in';
          c.ctx.drawImage(clipBase, 0, 0);
          c.ctx.globalCompositeOperation = 'source-over';
          this._draw(target, c.canvas, node);
        } else {
          this._draw(target, src, node);
          clipBase = src;
        }
      }
    }
  }

  composite(ctx, { checkerboard = false } = {}) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.w, this.h);
    if (checkerboard) {
      ctx.fillStyle = this._checkerPattern(ctx);
      ctx.fillRect(0, 0, this.w, this.h);
    }
    this._renderNodes(this.layers, ctx, 0);
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

  /* ---------------- 历史快照（引用式） ---------------- */

  _snapNodes(nodes) {
    return nodes.map(n => {
      const base = {
        id: n.id, type: n.type, name: n.name,
        visible: n.visible, opacity: n.opacity, blend: n.blend,
        locked: n.locked, clipping: n.clipping,
        mask: n.mask ? { canvas: n.mask.canvas, enabled: n.mask.enabled } : null,
      };
      if (n.type === 'group') {
        return { ...base, expanded: n.expanded, children: this._snapNodes(n.children) };
      }
      return { ...base, lockAlpha: n.lockAlpha, canvas: n.canvas };
    });
  }

  _restoreNodes(snaps) {
    return snaps.map(m => {
      const base = {
        id: m.id, type: m.type, name: m.name,
        visible: m.visible, opacity: m.opacity, blend: m.blend,
        locked: m.locked, clipping: m.clipping,
        mask: m.mask ? { canvas: m.mask.canvas, ctx: m.mask.canvas.getContext('2d'), enabled: m.mask.enabled } : null,
      };
      if (m.type === 'group') {
        return { ...base, expanded: m.expanded, children: this._restoreNodes(m.children) };
      }
      return {
        ...base,
        lockAlpha: m.lockAlpha,
        canvas: m.canvas,
        ctx: m.canvas.getContext('2d'),
      };
    });
  }

  snapshotFull() {
    return {
      activeId: this.activeId,
      nextId: this.nextId,
      layers: this._snapNodes(this.layers),
    };
  }

  restoreFull(state) {
    this.layers = this._restoreNodes(state.layers);
    this.nextId = state.nextId;
    this.activeId = this.byId(state.activeId) ? state.activeId : (this.leaves().slice(-1)[0]?.id || null);
    this._changed();
  }

  _changed() {
    if (this.onChange) this.onChange();
  }
}
