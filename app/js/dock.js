// 面板坞：PS 式右侧标签组 + 可调高度/宽度 + 可拖动的浮动面板。
const STORE_KEY = 'lbsh-dock-v2';

const DEFAULTS = {
  active: { color: 'color', layers: 'layers', history: 'history' },
  closed: ['brushes', 'dynamics'],
  collapsed: [],
  heights: { color: 238, history: 194 },
  width: 296,
  float: {},
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

export class Dock {
  constructor(rootEl, stageEl) {
    this.root = rootEl;
    this.stage = stageEl;
    this.floatingLayer = document.getElementById('floating-layer');
    this.panels = [...document.querySelectorAll('.panel[data-panel]')];
    this.byId = new Map(this.panels.map(p => [p.dataset.panel, p]));
    this.tabs = new Map();
    this.groupOfPanel = new Map();
    this.groups = [...rootEl.querySelectorAll('.dock-group')].map(el => ({
      el,
      key: el.dataset.group,
      tabs: [...el.querySelectorAll('.dock-tab')],
      panels: [...el.querySelectorAll('.panel[data-panel]')],
    }));
    for (const g of this.groups) {
      for (const t of g.tabs) this.tabs.set(t.dataset.tab, t);
      for (const p of g.panels) this.groupOfPanel.set(p.dataset.panel, g);
    }
    this.onPanelMenu = null;
    this.onLayout = null;
    this.z = 130;
    this._layoutRaf = 0;

    this.state = this.loadState();
    this.clampHeights();
    this.initGroups();
    this.initFloating();
    this.initResizers();
    this.applyAll();

    window.addEventListener('resize', () => {
      this.clampHeights();
      this.clampFloating();
    });
  }

  // 窗口变矮时，限制固定面板组高度，保证图层组仍有空间
  clampHeights() {
    const total = this.root.clientHeight;
    if (!total) return;
    const minLayers = 150;
    let color = Number(this.state.heights.color) || 238;
    let history = Number(this.state.heights.history) || 194;
    const avail = total - 12;
    if (color + history + minLayers > avail) {
      const over = color + history + minLayers - avail;
      if (history > color) history = Math.max(110, history - over);
      else color = Math.max(110, color - over);
    }
    this.state.heights.color = color;
    this.state.heights.history = history;
    for (const g of this.groups) {
      const h = this.state.heights[g.key];
      if (Number.isFinite(h) && g.key !== 'layers') g.el.style.flexBasis = h + 'px';
    }
  }

  /* ---------------- 状态 ---------------- */

  loadState() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* ignore */ }
    const s = clone(DEFAULTS);
    if (saved && typeof saved === 'object') {
      if (saved.active && typeof saved.active === 'object') Object.assign(s.active, saved.active);
      if (Array.isArray(saved.closed)) s.closed = saved.closed.filter(x => typeof x === 'string');
      if (Array.isArray(saved.collapsed)) s.collapsed = saved.collapsed.filter(x => typeof x === 'string');
      if (saved.heights) {
        if (Number.isFinite(saved.heights.color)) s.heights.color = saved.heights.color;
        if (Number.isFinite(saved.heights.history)) s.heights.history = saved.heights.history;
      }
      if (Number.isFinite(saved.width)) s.width = saved.width;
      if (saved.float && typeof saved.float === 'object') s.float = saved.float;
    }
    return s;
  }

  saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch { /* ignore */ }
  }

  /* ---------------- 初始化 ---------------- */

  initGroups() {
    for (const g of this.groups) {
      for (const tab of g.tabs) {
        tab.addEventListener('click', () => {
          this.state.closed = this.state.closed.filter(id => id !== tab.dataset.tab);
          g.el.classList.remove('collapsed');
          this.state.collapsed = this.state.collapsed.filter(k => k !== g.key);
          this.activate(g, tab.dataset.tab);
          this.applyAll();
          this.saveState();
        });
      }
      const toggle = g.el.querySelector('.dock-toggle');
      if (toggle) {
        toggle.addEventListener('click', () => {
          const on = !g.el.classList.contains('collapsed');
          g.el.classList.toggle('collapsed', on);
          this.state.collapsed = this.state.collapsed.filter(k => k !== g.key);
          if (on) this.state.collapsed.push(g.key);
          this.saveState();
        });
      }
      const menu = g.el.querySelector('.dock-menu');
      if (menu) {
        menu.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = this.activeId(g);
          if (this.onPanelMenu) this.onPanelMenu(id, menu);
        });
      }
      const head = g.el.querySelector('.dock-head');
      if (head) {
        head.addEventListener('dblclick', (e) => {
          if (e.target.closest('button')) return;
          const on = !g.el.classList.contains('collapsed');
          g.el.classList.toggle('collapsed', on);
          this.state.collapsed = this.state.collapsed.filter(k => k !== g.key);
          if (on) this.state.collapsed.push(g.key);
          this.saveState();
        });
      }
    }
  }

  initFloating() {
    for (const p of this.panels) {
      if (p.dataset.float !== '1') continue;
      const title = p.querySelector('.panel-title');
      const close = p.querySelector('.panel-close');
      if (close) {
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closePanel(p.dataset.panel);
        });
      }
      p.addEventListener('pointerdown', () => this.front(p));
      if (title) {
        title.addEventListener('pointerdown', (e) => this.startFloatingDrag(e, p));
        title.addEventListener('dblclick', (e) => {
          if (e.target.closest('.panel-close')) return;
          const on = !p.classList.contains('collapsed');
          p.classList.toggle('collapsed', on);
          const id = p.dataset.panel;
          this.state.float[id] = { ...(this.state.float[id] || {}), collapsed: on };
          this.saveState();
        });
      }
      // 双击笔刷打开画笔设置
      if (p.dataset.panel === 'brushes') {
        p.addEventListener('dblclick', (e) => {
          if (e.target.closest('#brush-presets')) {
            this.closePanel('brushes');
            this.openPanel('dynamics', { anchor: document.getElementById('btn-brush-settings') });
          }
        });
      }
    }
  }

  initResizers() {
    for (const sp of this.root.querySelectorAll('.dock-splitter')) {
      sp.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const key = sp.dataset.resize;
        const group = this.root.querySelector(`.dock-group[data-group="${key}"]`);
        if (!group || group.classList.contains('collapsed')) return;
        const startY = e.clientY;
        const startH = group.offsetHeight;
        document.body.style.cursor = 'row-resize';
        const otherKey = key === 'color' ? 'history' : 'color';
        const otherH = Number(this.state.heights[otherKey]) || 194;
        const move = (ev) => {
          const dy = ev.clientY - startY;
          // 给图层组留至少 150px，避免固定组把面板坞撑爆
          const max = Math.max(110, this.root.clientHeight - otherH - 158);
          const next = Math.max(110, Math.min(max, key === 'history' ? startH - dy : startH + dy));
          group.style.flexBasis = next + 'px';
          this.state.heights[key] = next;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          document.body.style.cursor = '';
          this.saveState();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

    const rz = this.root.querySelector('.dock-resizer');
    if (rz) {
      rz.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = this.root.offsetWidth;
        document.body.style.cursor = 'col-resize';
        const move = (ev) => {
          const max = Math.min(460, window.innerWidth - 640);
          const next = Math.max(250, Math.min(Math.max(280, max), startW - (ev.clientX - startX)));
          this.state.width = Math.round(next);
          this.root.style.width = next + 'px';
          this.root.style.flexBasis = next + 'px';
          this.scheduleLayout();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          document.body.style.cursor = '';
          this.saveState();
          this.scheduleLayout();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }
  }

  scheduleLayout() {
    if (this._layoutRaf) return;
    this._layoutRaf = requestAnimationFrame(() => {
      this._layoutRaf = 0;
      if (this.onLayout) this.onLayout();
    });
  }

  /* ---------------- 组 / 标签 ---------------- */

  activeId(g) {
    const t = g.tabs.find(tab => tab.classList.contains('active'));
    return t ? t.dataset.tab : null;
  }

  activate(g, id) {
    const tab = this.tabs.get(id);
    const panel = this.byId.get(id);
    if (!tab || !panel || !g.panels.includes(panel)) return;
    if (tab.classList.contains('tab-hidden')) return;
    for (const t of g.tabs) t.classList.remove('active');
    for (const p of g.panels) p.classList.remove('active');
    tab.classList.add('active');
    panel.classList.add('active');
    this.state.active[g.key] = id;
  }

  applyAll() {
    this.root.style.width = this.state.width + 'px';
    this.root.style.flexBasis = this.state.width + 'px';

    for (const g of this.groups) {
      const collapsed = this.state.collapsed.includes(g.key);
      g.el.classList.toggle('collapsed', collapsed);
      const h = this.state.heights[g.key];
      if (Number.isFinite(h) && g.key !== 'layers') g.el.style.flexBasis = h + 'px';
      for (const tab of g.tabs) {
        tab.classList.toggle('tab-hidden', this.state.closed.includes(tab.dataset.tab));
      }
      const visible = g.tabs.filter(t => !t.classList.contains('tab-hidden'));
      g.el.classList.toggle('no-tabs', visible.length === 0);

      const wanted = this.state.active[g.key];
      let pick = visible.find(t => t.dataset.tab === wanted);
      if (!pick) pick = visible[0];
      for (const t of g.tabs) t.classList.remove('active');
      for (const p of g.panels) p.classList.remove('active');
      if (pick) {
        pick.classList.add('active');
        this.byId.get(pick.dataset.tab)?.classList.add('active');
        this.state.active[g.key] = pick.dataset.tab;
      }
    }

    for (const p of this.panels) {
      if (p.dataset.float !== '1') continue;
      const id = p.dataset.panel;
      const closed = this.state.closed.includes(id);
      p.hidden = closed;
      if (!closed) {
        this.applyFloatingState(p);
        this.positionFloating(p, null);
      }
    }
  }

  applyFloatingState(p) {
    const id = p.dataset.panel;
    p.classList.toggle('collapsed', !!this.state.float[id]?.collapsed);
  }

  /* ---------------- 显隐 / 面板 API ---------------- */

  panelInfo() {
    return this.panels.map(p => ({
      id: p.dataset.panel,
      name: p.dataset.name || p.dataset.panel,
      visible: !this.state.closed.includes(p.dataset.panel),
      floating: p.dataset.float === '1',
    }));
  }

  isVisible(id) {
    return !this.state.closed.includes(id);
  }

  togglePanel(id, opts = {}) {
    if (this.isVisible(id)) this.closePanel(id);
    else this.openPanel(id, opts);
  }

  openPanel(id, opts = {}) {
    const p = this.byId.get(id);
    if (!p) return;
    this.state.closed = this.state.closed.filter(x => x !== id);
    if (p.dataset.float === '1') {
      p.hidden = false;
      this.applyFloatingState(p);
      this.positionFloating(p, opts.anchor || null);
      this.front(p);
    } else {
      const g = this.groupOfPanel.get(id);
      if (g) {
        g.el.classList.remove('collapsed');
        this.state.collapsed = this.state.collapsed.filter(k => k !== g.key);
        const tab = this.tabs.get(id);
        if (tab) tab.classList.remove('tab-hidden');
        g.el.classList.remove('no-tabs');
        this.activate(g, id);
      }
    }
    this.applyAll();
    this.saveState();
  }

  closePanel(id) {
    const p = this.byId.get(id);
    if (!p) return;
    if (!this.state.closed.includes(id)) this.state.closed.push(id);
    if (p.dataset.float === '1') {
      p.hidden = true;
    } else {
      p.classList.remove('active');
    }
    this.applyAll();
    this.saveState();
  }

  resetLayout() {
    this.state = clone(DEFAULTS);
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    for (const p of this.panels) {
      if (p.dataset.float !== '1') p.style.left = p.style.top = '';
      p.classList.remove('collapsed');
      p.style.zIndex = '';
    }
    this.applyAll();
    this.saveState();
    this.scheduleLayout();
  }

  // 笔刷数量 / 图层数量变化后调用（布局由 flex 自动处理，这里只同步空态）
  reflowBoth() {
    for (const g of this.groups) {
      const visible = g.tabs.filter(t => !t.classList.contains('tab-hidden'));
      g.el.classList.toggle('no-tabs', visible.length === 0);
      if (visible.length && !visible.some(t => t.classList.contains('active'))) {
        this.activate(g, visible[0].dataset.tab);
      }
    }
  }

  /* ---------------- 浮动面板拖动 ---------------- */

  startFloatingDrag(e, p) {
    if (e.target.closest('.panel-close')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const layerRect = this.floatingLayer.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startL = p.offsetLeft;
    const startT = p.offsetTop;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      moved = true;
      const maxL = layerRect.width - p.offsetWidth - 6;
      const maxT = layerRect.height - 40;
      const l = Math.max(4, Math.min(maxL, startL + ev.clientX - startX));
      const t = Math.max(4, Math.min(maxT, startT + ev.clientY - startY));
      p.style.left = l + 'px';
      p.style.top = t + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      const id = p.dataset.panel;
      this.state.float[id] = {
        ...(this.state.float[id] || {}),
        left: parseFloat(p.style.left) || 0,
        top: parseFloat(p.style.top) || 0,
      };
      this.saveState();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  positionFloating(p, anchor) {
    const id = p.dataset.panel;
    const saved = this.state.float[id] || {};
    const layerRect = this.floatingLayer.getBoundingClientRect();
    if (!layerRect.width) return;
    let left = Number.isFinite(saved.left) ? saved.left : null;
    let top = Number.isFinite(saved.top) ? saved.top : null;
    if (anchor) {
      const ar = anchor.getBoundingClientRect();
      left = ar.left - layerRect.left;
      // 文档标签栏高 29px，弹出的画笔面板落在标签栏下方，少遮挡标签
      top = Math.max(36, ar.bottom - layerRect.top + 6);
    }
    if (left == null) {
      left = id === 'dynamics' ? 620 : 330;
      top = top == null ? 8 : top;
    }
    if (top == null) top = 8;
    const maxL = Math.max(4, layerRect.width - p.offsetWidth - 6);
    const maxT = Math.max(4, layerRect.height - 44);
    left = Math.max(4, Math.min(maxL, left));
    top = Math.max(4, Math.min(maxT, top));
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    if (anchor) {
      this.state.float[id] = { ...(this.state.float[id] || {}), left, top };
      this.saveState();
    }
  }

  clampFloating() {
    for (const p of this.panels) {
      if (p.dataset.float !== '1' || p.hidden) continue;
      this.positionFloating(p, null);
    }
    this.applyAll();
  }

  front(p) {
    p.style.zIndex = String(++this.z);
  }
}
