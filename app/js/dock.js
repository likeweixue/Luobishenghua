// 停靠系统：可拖动面板 + 磁吸停靠（左右边缘堆叠、面板间吸附）
const EDGE_ZONE = 56;   // 靠近边缘多少 px 触发停靠
const SNAP_DIST = 18;   // 浮动面板之间的磁吸距离
const GAP = 8;

export class Dock {
  constructor(rootEl, stageEl) {
    this.root = rootEl;
    this.stage = stageEl;
    this.panels = [...rootEl.querySelectorAll('.panel')];

    this.preview = document.createElement('div');
    this.preview.className = 'dock-preview';
    stageEl.appendChild(this.preview);

    for (const el of this.panels) this.initPanel(el);

    window.addEventListener('resize', () => {
      this.reflow('left');
      this.reflow('right');
      this.clampFloating();
    });

    this.reflow('left');
    this.reflow('right');
  }

  initPanel(el) {
    const title = el.querySelector('.panel-title');
    const collapseBtn = el.querySelector('.panel-collapse');

    const doCollapse = () => {
      el.classList.toggle('collapsed');
      collapseBtn.textContent = el.classList.contains('collapsed') ? '+' : '–';
      this.reflow('left');
      this.reflow('right');
    };
    collapseBtn.addEventListener('click', doCollapse);
    title.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.panel-collapse')) doCollapse();
    });

    title.addEventListener('pointerdown', (e) => this.startDrag(e, el));
  }

  /* ---------- 面板显隐（窗口菜单用） ---------- */

  panelInfo() {
    return this.panels.map(p => ({
      id: p.dataset.panel,
      name: p.querySelector('.panel-title .name').textContent,
      visible: !p.classList.contains('panel-hidden'),
    }));
  }

  togglePanel(id) {
    const p = this.panels.find(p => p.dataset.panel === id);
    if (!p) return;
    p.classList.toggle('panel-hidden');
    this.reflow('left');
    this.reflow('right');
  }

  isVisible(id) {
    const p = this.panels.find(p => p.dataset.panel === id);
    return p && !p.classList.contains('panel-hidden');
  }

  // 恢复默认布局（左侧：工具/工具属性/笔刷仓库/颜色；右侧：导航器/图层）
  resetLayout() {
    const defaults = { left: ['tools', 'tool-props', 'brushes', 'color'], right: ['navigator', 'layers'] };
    for (const [side, ids] of Object.entries(defaults)) {
      ids.forEach((id, i) => {
        const p = this.panels.find(p => p.dataset.panel === id);
        if (!p) return;
        p.dataset.dock = side;
        p.dataset.order = i;
        p.classList.remove('panel-hidden', 'collapsed');
        const btn = p.querySelector('.panel-collapse');
        if (btn) btn.textContent = '–';
      });
    }
    this.reflow('left');
    this.reflow('right');
  }

  column(side) {
    return this.panels
      .filter(p => p.dataset.dock === side && !p.classList.contains('panel-hidden'))
      .sort((a, b) => (+a.dataset.order || 0) - (+b.dataset.order || 0));
  }

  reflow(side) {
    const list = this.column(side);
    let y = GAP;
    list.forEach((p, i) => {
      p.dataset.order = i;
      p.style.left = side === 'left'
        ? GAP + 'px'
        : (this.stage.clientWidth - p.offsetWidth - GAP) + 'px';
      p.style.top = y + 'px';
      y += p.offsetHeight + GAP;
    });
  }

  clampFloating() {
    const r = this.stage.getBoundingClientRect();
    for (const p of this.panels) {
      if (p.dataset.dock || p.classList.contains('panel-hidden')) continue;
      const left = Math.min(parseFloat(p.style.left) || 0, r.width - p.offsetWidth - GAP);
      const top = Math.min(parseFloat(p.style.top) || 0, r.height - 30);
      p.style.left = Math.max(GAP, left) + 'px';
      p.style.top = Math.max(GAP, top) + 'px';
    }
  }

  startDrag(e, el) {
    if (e.target.closest('.panel-collapse')) return;
    e.preventDefault();
    const rootRect = this.root.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offX = e.clientX - elRect.left;
    const offY = e.clientY - elRect.top;
    let dragging = false;
    let undocked = el.dataset.dock === '' || el.dataset.dock === undefined;
    let candidate = null; // { side, index }

    const onMove = (ev) => {
      const mx = ev.clientX - rootRect.left;
      const my = ev.clientY - rootRect.top;
      if (!dragging && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      dragging = true;

      // 从停靠列中拖出：先脱钩并重排
      if (!undocked) {
        const side = el.dataset.dock;
        el.dataset.dock = '';
        undocked = true;
        this.reflow(side);
      }

      let left = mx - offX;
      let top = my - offY;
      left = Math.max(0, Math.min(left, rootRect.width - el.offsetWidth));
      top = Math.max(0, Math.min(top, rootRect.height - 24));

      // 1) 边缘停靠判定
      candidate = null;
      if (mx < EDGE_ZONE) candidate = { side: 'left' };
      else if (mx > rootRect.width - EDGE_ZONE) candidate = { side: 'right' };

      if (candidate) {
        const col = this.column(candidate.side).filter(p => p !== el);
        let index = col.length;
        col.forEach((p, i) => {
          const mid = p.offsetTop + p.offsetHeight / 2;
          if (my < mid && index === col.length) index = i;
        });
        candidate.index = index;
        this.showPreview(candidate.side, index, el);
      } else {
        this.hidePreview();
        // 2) 浮动面板间磁吸：底边堆叠 + 顶边/左边对齐
        for (const other of this.panels) {
          if (other === el) continue;
          const oL = other.offsetLeft, oT = other.offsetTop;
          const oW = other.offsetWidth, oH = other.offsetHeight;
          // 吸到某面板正下方（你说的“笔刷仓库吸在工具属性下面”）
          if (Math.abs(left - oL) < SNAP_DIST && Math.abs(top - (oT + oH + 4)) < SNAP_DIST) {
            left = oL; top = oT + oH + 4;
            break;
          }
          // 顶边对齐
          if (Math.abs(top - oT) < SNAP_DIST && Math.abs(left - oL) < SNAP_DIST * 2) {
            top = oT; left = oL;
            break;
          }
          // 右边缘对齐（纵向相邻时）
          if (Math.abs((left + el.offsetWidth) - (oL + oW)) < SNAP_DIST && Math.abs(top - oT) < SNAP_DIST) {
            left = oL + oW - el.offsetWidth; top = oT;
            break;
          }
        }
      }

      el.style.left = left + 'px';
      el.style.top = top + 'px';
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.hidePreview();
      if (dragging && candidate) {
        const { side, index } = candidate;
        // 插入到停靠列指定位置
        const col = this.column(side);
        col.splice(index, 0, el);
        col.forEach((p, i) => { p.dataset.order = i; });
        el.dataset.dock = side;
        this.reflow(side);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  showPreview(side, index, dragged) {
    const col = this.column(side).filter(p => p !== dragged);
    const w = dragged.offsetWidth;
    const h = dragged.offsetHeight;
    let y = GAP;
    for (let i = 0; i <= col.length; i++) {
      if (i === index) break;
      y += col[i].offsetHeight + GAP;
    }
    const x = side === 'left' ? GAP : this.stage.clientWidth - w - GAP;
    this.preview.style.display = 'block';
    this.preview.style.left = x + 'px';
    this.preview.style.top = y + 'px';
    this.preview.style.width = w + 'px';
    this.preview.style.height = h + 'px';
  }

  hidePreview() {
    this.preview.style.display = 'none';
  }
}
