// 面板坞：PS 风格标签组 + 自由拖拽组合。
// 源文件：app 运行时使用 app/js/dock.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/dock.js。
// beta12 起由 DeepSeek 参与落笔生花的面板 / 交互重构；beta14 加入标签拖拽停靠。
const STORE_KEY = 'lbsh-dock-v3';
const GROUP_KEYS = ['color', 'layers', 'history'];
const DEFAULT_GROUPS = {
    color: ['color', 'swatches'],
    layers: ['layers'],
    history: ['history', 'navigator'],
};
const DEFAULT_ACTIVE = { color: 'color', layers: 'layers', history: 'history' };
const DEFAULT_FLOAT = {
    brushes: { left: 330, top: 8, collapsed: false },
    dynamics: { left: 620, top: 8, collapsed: false },
};
const DEFAULT_CLOSED = ['brushes', 'dynamics'];
const DEFAULT_HEIGHTS = { color: 238, history: 194 };
const DEFAULT_WIDTH = 296;
const DEFAULT_HOME = {
    color: 'color',
    swatches: 'color',
    layers: 'layers',
    history: 'history',
    navigator: 'history',
    brushes: null,
    dynamics: null,
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export class Dock {
    onPanelMenu;
    onLayout;
    constructor(rootEl, stageEl) {
        this.root = rootEl;
        this.stage = stageEl;
        this.floatingLayer = document.getElementById('floating-layer');
        this.panels = [...document.querySelectorAll('.panel[data-panel]')];
        this.byId = new Map(this.panels.map(p => [p.dataset.panel, p]));
        this.groupOfPanel = new Map();
        this.groups = [...rootEl.querySelectorAll('.dock-group')].map(el => ({
            el: el,
            key: el.dataset.group,
            headEl: el.querySelector('.dock-head'),
            tabsEl: el.querySelector('.dock-tabs'),
            bodyEl: el.querySelector('.dock-body'),
            menuBtn: el.querySelector('.dock-menu'),
            toggleBtn: el.querySelector('.dock-toggle'),
            panels: [],
        }));
        this.groupByKey = new Map(this.groups.map(g => [g.key, g]));
        this.onPanelMenu = null;
        this.onLayout = null;
        this.z = 130;
        this._layoutRaf = 0;
        this.drag = null;
        this.dropTarget = null;
        this.dragLine = null;
        this.dragGhost = null;
        this.dragEl = null;
        this._dragOrigin = null;
        this.state = this.loadState();
        this.initGroups();
        this.initFloating();
        this.initSplitters();
        this.initResizer();
        this.applyAll();
        window.addEventListener('resize', () => {
            this.clampHeights();
            this.clampFloating();
        });
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.drag)
                this.cancelDrag();
        });
        window.addEventListener('blur', () => { if (this.drag)
            this.cancelDrag(); });
    }
    /* ---------------- 状态 ---------------- */
    defaultState() {
        return {
            groups: clone(DEFAULT_GROUPS),
            active: clone(DEFAULT_ACTIVE),
            float: clone(DEFAULT_FLOAT),
            closed: DEFAULT_CLOSED.slice(),
            collapsed: [],
            heights: { ...DEFAULT_HEIGHTS },
            width: DEFAULT_WIDTH,
        };
    }
    loadState() {
        const base = this.defaultState();
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        }
        catch { /* ignore */ }
        if (!saved || typeof saved !== 'object')
            return base;
        const known = new Set(this.byId.keys());
        const assigned = new Set();
        const groups = {};
        const sg = saved.groups && typeof saved.groups === 'object' ? saved.groups : null;
        for (const key of GROUP_KEYS) {
            const src = sg && Array.isArray(sg[key]) ? sg[key] : base.groups[key];
            const list = [];
            for (const id of src) {
                if (!known.has(id) || assigned.has(id))
                    continue;
                list.push(id);
                assigned.add(id);
            }
            groups[key] = list;
        }
        const float = {};
        const sf = saved.float && typeof saved.float === 'object' ? saved.float : {};
        for (const [id, pos] of Object.entries(sf)) {
            if (!known.has(id) || assigned.has(id))
                continue;
            const left = Number(pos?.left);
            const top = Number(pos?.top);
            float[id] = {
                left: Number.isFinite(left) ? left : 330,
                top: Number.isFinite(top) ? top : 8,
                collapsed: !!pos?.collapsed,
            };
            assigned.add(id);
        }
        // 丢失 / 新增的面板：回到默认组，或默认浮动
        for (const id of known) {
            if (assigned.has(id))
                continue;
            const home = DEFAULT_HOME[id];
            if (home) {
                groups[home].push(id);
                assigned.add(id);
            }
            else {
                float[id] = clone(sf[id] || DEFAULT_FLOAT[id] || { left: 330, top: 8 });
                assigned.add(id);
            }
        }
        const closed = Array.isArray(saved.closed)
            ? [...new Set(saved.closed.filter(id => known.has(id)))]
            : base.closed.slice();
        const active = { ...base.active };
        if (saved.active && typeof saved.active === 'object') {
            for (const key of GROUP_KEYS) {
                const id = saved.active[key];
                if (known.has(id) && groups[key].includes(id) && !closed.includes(id))
                    active[key] = id;
            }
        }
        const heights = { ...base.heights };
        if (saved.heights && typeof saved.heights === 'object') {
            for (const key of Object.keys(heights)) {
                if (Number.isFinite(saved.heights[key]))
                    heights[key] = saved.heights[key];
            }
        }
        const collapsed = Array.isArray(saved.collapsed)
            ? saved.collapsed.filter(k => GROUP_KEYS.includes(k))
            : [];
        const width = Number.isFinite(saved.width) ? clamp(saved.width, 250, 460) : base.width;
        return { groups, active, float, closed, collapsed, heights, width };
    }
    saveState() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(this.state));
        }
        catch { /* ignore */ }
    }
    /* ---------------- 初始化 ---------------- */
    initGroups() {
        for (const g of this.groups) {
            g.toggleBtn?.addEventListener('click', () => this.toggleCollapse(g));
            g.menuBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = this.state.active[g.key] || null;
                if (this.onPanelMenu)
                    this.onPanelMenu(id, g.menuBtn);
            });
            g.headEl?.addEventListener('dblclick', (e) => {
                if (e.target.closest('button'))
                    return;
                this.toggleCollapse(g);
            });
        }
    }
    initFloating() {
        for (const p of this.panels) {
            this.ensureTitle(p);
            p.addEventListener('pointerdown', () => {
                if (p.classList.contains('floating'))
                    this.front(p);
            });
        }
    }
    initSplitters() {
        for (const sp of this.root.querySelectorAll('.dock-splitter')) {
            sp.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                const key = sp.dataset.resize;
                const group = this.groupByKey.get(key)?.el;
                if (!group || group.classList.contains('collapsed') || group.classList.contains('empty-group'))
                    return;
                const startY = e.clientY;
                const startH = group.offsetHeight;
                document.body.style.cursor = 'row-resize';
                const otherKey = key === 'color' ? 'history' : 'color';
                const otherH = Number(this.state.heights[otherKey]) || 194;
                const move = (ev) => {
                    const dy = ev.clientY - startY;
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
    }
    initResizer() {
        const rz = this.root.querySelector('.dock-resizer');
        if (!rz)
            return;
        rz.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = this.root.offsetWidth;
            document.body.style.cursor = 'col-resize';
            const move = (ev) => {
                const max = Math.min(460, window.innerWidth - 640);
                const next = clamp(startW - (ev.clientX - startX), 250, Math.max(280, max));
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
    scheduleLayout() {
        if (this._layoutRaf)
            return;
        this._layoutRaf = requestAnimationFrame(() => {
            this._layoutRaf = 0;
            if (this.onLayout)
                this.onLayout();
        });
    }
    /* ---------------- 应用 / 渲染 ---------------- */
    applyAll() {
        this.root.style.width = this.state.width + 'px';
        this.root.style.flexBasis = this.state.width + 'px';
        // 先修正组归属：同一个面板只能在一个地方
        for (const g of this.groups) {
            if (!Array.isArray(this.state.groups[g.key]))
                this.state.groups[g.key] = [];
            g.panels = this.state.groups[g.key];
            for (const id of g.panels) {
                this.groupOfPanel.set(id, g);
                delete this.state.float[id];
            }
        }
        for (const g of this.groups) {
            for (const id of g.panels) {
                const p = this.byId.get(id);
                if (!p)
                    continue;
                this.ensureTitle(p);
                p.classList.remove('floating');
                p.classList.remove('collapsed');
                delete p.dataset.float;
                p.hidden = false;
                p.style.left = '';
                p.style.top = '';
                p.style.zIndex = '';
                if (p.parentElement !== g.bodyEl)
                    g.bodyEl.appendChild(p);
            }
        }
        for (const [id, pos] of Object.entries(this.state.float)) {
            const p = this.byId.get(id);
            if (!p || this.groupOfPanel.has(id)) {
                delete this.state.float[id];
                continue;
            }
            this.ensureTitle(p);
            p.classList.add('floating');
            p.classList.remove('active');
            p.dataset.float = '1';
            p.hidden = this.state.closed.includes(id);
            p.classList.toggle('collapsed', !!pos.collapsed);
            if (p.parentElement !== this.floatingLayer)
                this.floatingLayer.appendChild(p);
            this.positionFloating(p, null);
        }
        this.renderAllGroups();
        for (const g of this.groups) {
            const h = this.state.heights[g.key];
            if (Number.isFinite(h) && g.key !== 'layers')
                g.el.style.flexBasis = h + 'px';
            g.el.classList.toggle('collapsed', this.state.collapsed.includes(g.key));
            g.el.classList.toggle('empty-group', g.panels.length === 0);
        }
    }
    renderAllGroups() {
        const closed = new Set(this.state.closed);
        for (const g of this.groups) {
            const panels = Array.isArray(this.state.groups[g.key]) ? this.state.groups[g.key] : [];
            g.panels = panels;
            const visible = panels.filter(id => !closed.has(id));
            let active = this.state.active[g.key];
            if (!active || !visible.includes(active))
                active = visible[0] || null;
            this.state.active[g.key] = active;
            g.tabsEl.innerHTML = '';
            for (const id of visible) {
                const p = this.byId.get(id);
                if (!p)
                    continue;
                const tab = document.createElement('button');
                tab.className = 'dock-tab' + (id === active ? ' active' : '');
                tab.dataset.tab = id;
                tab.textContent = p.dataset.name || id;
                tab.title = p.dataset.name || id;
                tab.addEventListener('pointerdown', (e) => this.onTabPointerDown(e, g, id));
                g.tabsEl.appendChild(tab);
            }
            for (const id of panels) {
                const p = this.byId.get(id);
                if (!p)
                    continue;
                if (p.parentElement !== g.bodyEl)
                    g.bodyEl.appendChild(p);
                p.classList.remove('floating');
                p.classList.remove('collapsed');
                p.hidden = false;
                p.classList.toggle('active', id === active && !closed.has(id));
                this.groupOfPanel.set(id, g);
            }
            g.el.classList.toggle('no-tabs', visible.length === 0);
            g.el.classList.toggle('empty-group', panels.length === 0);
        }
    }
    ensureTitle(p) {
        let title = p.querySelector(':scope > .panel-title');
        if (!title) {
            title = document.createElement('div');
            title.className = 'panel-title';
            const grip = document.createElement('span');
            grip.className = 'panel-grip';
            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = p.dataset.name || p.dataset.panel || '';
            const sub = document.createElement('span');
            sub.className = 'panel-sub';
            const close = document.createElement('button');
            close.className = 'panel-close';
            close.title = '关闭';
            close.textContent = '×';
            title.append(grip, name, sub, close);
            p.prepend(title);
        }
        if (title.dataset.bound !== '1') {
            title.dataset.bound = '1';
            const close = title.querySelector('.panel-close');
            close?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closePanel(p.dataset.panel);
            });
            title.addEventListener('pointerdown', (e) => this.startFloatingDrag(e, p));
            title.addEventListener('dblclick', (e) => {
                if (e.target.closest('.panel-close'))
                    return;
                const id = p.dataset.panel;
                if (!this.state.float[id])
                    return;
                const on = !p.classList.contains('collapsed');
                p.classList.toggle('collapsed', on);
                this.state.float[id].collapsed = on;
                this.saveState();
            });
        }
        return title;
    }
    /* ---------------- 面板显隐 / API ---------------- */
    panelInfo() {
        return this.panels.map(p => ({
            id: p.dataset.panel,
            name: p.dataset.name || p.dataset.panel,
            visible: !this.state.closed.includes(p.dataset.panel),
            floating: !!this.state.float[p.dataset.panel],
        }));
    }
    isVisible(id) {
        return !this.state.closed.includes(id);
    }
    activeId(group) {
        const g = typeof group === 'string' ? this.groupByKey.get(group) : group;
        return g ? (this.state.active[g.key] || null) : null;
    }
    activate(group, id) {
        const g = typeof group === 'string' ? this.groupByKey.get(group) : group;
        if (!g || !id)
            return;
        if (!g.panels.includes(id) || this.state.closed.includes(id))
            return;
        this.state.active[g.key] = id;
        g.el.classList.remove('collapsed');
        this.state.collapsed = this.state.collapsed.filter(k => k !== g.key);
        this.renderAllGroups();
        this.saveState();
    }
    togglePanel(id, opts = {}) {
        if (this.isVisible(id))
            this.closePanel(id);
        else
            this.openPanel(id, opts);
    }
    openPanel(id, opts = {}) {
        const p = this.byId.get(id);
        if (!p)
            return;
        this.state.closed = this.state.closed.filter(x => x !== id);
        if (this.state.float[id]) {
            p.hidden = false;
            this.ensureTitle(p);
            p.classList.add('floating');
            p.dataset.float = '1';
            if (p.parentElement !== this.floatingLayer)
                this.floatingLayer.appendChild(p);
            this.positionFloating(p, opts.anchor || null);
            this.front(p);
        }
        else {
            let g = this.groupOfPanel.get(id);
            if (!g) {
                const homeKey = DEFAULT_HOME[id] || 'color';
                g = this.groupByKey.get(homeKey) || this.groups[0];
                if (!g)
                    return;
                g.panels.push(id);
                this.state.groups[g.key] = g.panels;
                this.groupOfPanel.set(id, g);
                if (p.parentElement !== g.bodyEl)
                    g.bodyEl.appendChild(p);
            }
            this.state.active[g.key] = id;
            g.el.classList.remove('collapsed');
            this.state.collapsed = this.state.collapsed.filter(k => k !== g.key);
            this.renderAllGroups();
        }
        this.saveState();
    }
    closePanel(id) {
        if (!this.byId.has(id) || this.state.closed.includes(id))
            return;
        this.state.closed.push(id);
        const p = this.byId.get(id);
        if (this.state.float[id]) {
            p.hidden = true;
        }
        else {
            const g = this.groupOfPanel.get(id);
            if (g && this.state.active[g.key] === id) {
                const next = g.panels.find(pid => !this.state.closed.includes(pid) && pid !== id) || null;
                this.state.active[g.key] = next;
            }
            this.renderAllGroups();
        }
        this.saveState();
    }
    resetLayout() {
        this.state = this.defaultState();
        this.applyAll();
        this.saveState();
        this.scheduleLayout();
    }
    reflowBoth() {
        // 动态标签组由 flex 自动排版；这里只同步活动项
        this.renderAllGroups();
    }
    toggleCollapse(g) {
        const on = !g.el.classList.contains('collapsed');
        g.el.classList.toggle('collapsed', on);
        this.state.collapsed = this.state.collapsed.filter(k => k !== g.key);
        if (on)
            this.state.collapsed.push(g.key);
        this.saveState();
    }
    /* ---------------- 拖拽：标签 / 浮动面板 ---------------- */
    onTabPointerDown(e, g, id) {
        if (e.button !== 0 || this.drag)
            return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const tab = e.currentTarget;
        let moved = false;
        const move = (ev) => {
            if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4)
                return;
            if (!moved) {
                moved = true;
                this.beginDrag('tab', id, tab);
            }
            this.updateDropTarget(ev.clientX, ev.clientY, id);
        };
        const up = (ev) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            if (!moved) {
                this.activate(g, id);
                return;
            }
            const target = this.dropTarget;
            if (target && target.group)
                this.moveDockedPanel(id, target);
            else
                this.floatPanel(id, ev.clientX, ev.clientY);
            this.endDragVisual();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }
    startFloatingDrag(e, p) {
        if (e.button !== 0 || !p.classList.contains('floating'))
            return;
        if (e.target.closest('.panel-close'))
            return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startL = p.offsetLeft;
        const startT = p.offsetTop;
        this._dragOrigin = { left: startL, top: startT };
        let moved = false;
        const move = (ev) => {
            if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3)
                return;
            if (!moved) {
                moved = true;
                this.beginDrag('float', p.dataset.panel, null);
                p.style.pointerEvents = 'none';
                this.front(p);
            }
            const lr = this.floatingLayer.getBoundingClientRect();
            const maxL = Math.max(4, lr.width - p.offsetWidth - 6);
            const maxT = Math.max(4, lr.height - 40);
            p.style.left = clamp(startL + ev.clientX - startX, 4, maxL) + 'px';
            p.style.top = clamp(startT + ev.clientY - startY, 4, maxT) + 'px';
            this.updateDropTarget(ev.clientX, ev.clientY, p.dataset.panel);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            if (!moved)
                return;
            p.style.pointerEvents = '';
            if (this.dropTarget && this.dropTarget.group) {
                this.dockFloatingPanel(p.dataset.panel, this.dropTarget);
            }
            else {
                const id = p.dataset.panel;
                this.state.float[id] = {
                    ...(this.state.float[id] || {}),
                    left: parseFloat(p.style.left) || 0,
                    top: parseFloat(p.style.top) || 0,
                };
                this.saveState();
            }
            this.endDragVisual();
            this.front(p);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }
    beginDrag(type, id, sourceTab) {
        this.drag = { type, id, sourceTab };
        this.dragEl = type === 'float' ? this.byId.get(id) : null;
        document.body.classList.add('dock-dragging');
        if (sourceTab)
            sourceTab.classList.add('dragging');
        if (type === 'tab') {
            const p = this.byId.get(id);
            this.dragGhost = document.createElement('div');
            this.dragGhost.className = 'dock-drag-ghost';
            this.dragGhost.textContent = p?.dataset.name || id;
            document.body.appendChild(this.dragGhost);
        }
    }
    moveGhost(x, y) {
        if (!this.dragGhost)
            return;
        const w = this.dragGhost.offsetWidth;
        const h = this.dragGhost.offsetHeight;
        this.dragGhost.style.left = clamp(x + 14, 4, window.innerWidth - w - 6) + 'px';
        this.dragGhost.style.top = clamp(y + 12, 4, window.innerHeight - h - 6) + 'px';
    }
    updateDropTarget(x, y, dragId) {
        if (!this.drag)
            return;
        this.dropTarget = this.findDropTarget(x, y, dragId);
        this.moveGhost(x, y);
        this.renderDropTarget();
    }
    findDropTarget(x, y, dragId) {
        const els = document.elementsFromPoint(x, y);
        for (const el of els) {
            if (el.closest('.panel.floating'))
                continue;
            const ge = el.closest('.dock-group');
            if (!ge)
                continue;
            const g = this.groups.find(item => item.el === ge);
            if (!g)
                continue;
            if (el.closest('.dock-tabs')) {
                return { group: g, index: this.tabIndex(g, x, dragId) };
            }
            return {
                group: g,
                index: g.panels.filter(id => !this.state.closed.includes(id) && id !== dragId).length,
            };
        }
        const r = this.root.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            let best = null;
            let bestDist = Infinity;
            for (const g of this.groups) {
                const gr = g.el.getBoundingClientRect();
                const d = y < gr.top ? gr.top - y : y > gr.bottom ? y - gr.bottom : 0;
                if (d < bestDist) {
                    bestDist = d;
                    best = g;
                }
            }
            if (best) {
                return {
                    group: best,
                    index: best.panels.filter(id => !this.state.closed.includes(id) && id !== dragId).length,
                };
            }
        }
        return null;
    }
    tabIndex(g, x, dragId) {
        const tabs = [...g.tabsEl.querySelectorAll('.dock-tab')]
            .filter(t => t.dataset.tab !== dragId);
        if (!tabs.length)
            return 0;
        for (let i = 0; i < tabs.length; i++) {
            const r = tabs[i].getBoundingClientRect();
            if (x < r.left + r.width / 2)
                return i;
        }
        return tabs.length;
    }
    renderDropTarget() {
        this.clearDropTarget();
        const target = this.dropTarget;
        if (!target)
            return;
        target.group.el.classList.add('drop-hot');
        const tabs = [...target.group.tabsEl.querySelectorAll('.dock-tab')]
            .filter(t => t.dataset.tab !== this.drag?.id);
        let left;
        if (!tabs.length)
            left = 3;
        else if (target.index <= 0)
            left = tabs[0].offsetLeft;
        else if (target.index >= tabs.length) {
            const last = tabs[tabs.length - 1];
            left = last.offsetLeft + last.offsetWidth;
        }
        else
            left = tabs[target.index].offsetLeft;
        const line = document.createElement('div');
        line.className = 'dock-drop-line';
        line.style.left = left + 'px';
        target.group.tabsEl.appendChild(line);
        this.dragLine = line;
    }
    clearDropTarget() {
        if (this.dragLine) {
            this.dragLine.remove();
            this.dragLine = null;
        }
        for (const g of this.groups)
            g.el.classList.remove('drop-hot');
    }
    endDragVisual() {
        this.clearDropTarget();
        if (this.dragGhost) {
            this.dragGhost.remove();
            this.dragGhost = null;
        }
        if (this.drag?.sourceTab)
            this.drag.sourceTab.classList.remove('dragging');
        if (this.dragEl)
            this.dragEl.style.pointerEvents = '';
        document.body.classList.remove('dock-dragging');
        this.drag = null;
        this.dragEl = null;
        this.dropTarget = null;
        this._dragOrigin = null;
    }
    cancelDrag() {
        if (this._dragOrigin && this.dragEl) {
            this.dragEl.style.left = this._dragOrigin.left + 'px';
            this.dragEl.style.top = this._dragOrigin.top + 'px';
        }
        this.endDragVisual();
    }
    /* ---------------- 移动 / 停靠 ---------------- */
    moveDockedPanel(id, target) {
        const from = this.groupOfPanel.get(id);
        if (!from)
            return;
        const to = target.group;
        if (!to)
            return;
        const closed = new Set(this.state.closed);
        from.panels = from.panels.filter(pid => pid !== id);
        this.state.groups[from.key] = from.panels;
        const visible = to.panels.filter(pid => !closed.has(pid));
        let at = target.index >= visible.length
            ? to.panels.length
            : to.panels.indexOf(visible[target.index]);
        if (at < 0)
            at = to.panels.length;
        to.panels.splice(at, 0, id);
        this.state.groups[to.key] = to.panels;
        const p = this.byId.get(id);
        if (p) {
            p.classList.remove('floating');
            p.classList.remove('collapsed');
            p.hidden = false;
            delete p.dataset.float;
            p.style.left = '';
            p.style.top = '';
            p.style.zIndex = '';
            if (p.parentElement !== to.bodyEl)
                to.bodyEl.appendChild(p);
        }
        this.groupOfPanel.set(id, to);
        if (from.key !== to.key && this.state.active[from.key] === id) {
            this.state.active[from.key] = from.panels.find(pid => !closed.has(pid)) || null;
        }
        this.state.active[to.key] = id;
        to.el.classList.remove('collapsed');
        this.state.collapsed = this.state.collapsed.filter(k => k !== to.key);
        this.renderAllGroups();
        this.saveState();
    }
    dockFloatingPanel(id, target) {
        const p = this.byId.get(id);
        const to = target.group;
        if (!p || !to)
            return;
        delete this.state.float[id];
        p.classList.remove('floating');
        p.classList.remove('collapsed');
        p.hidden = false;
        delete p.dataset.float;
        p.style.left = '';
        p.style.top = '';
        p.style.zIndex = '';
        if (p.parentElement !== to.bodyEl)
            to.bodyEl.appendChild(p);
        const closed = new Set(this.state.closed);
        const visible = to.panels.filter(pid => !closed.has(pid));
        let at = target.index >= visible.length
            ? to.panels.length
            : to.panels.indexOf(visible[target.index]);
        if (at < 0)
            at = to.panels.length;
        to.panels.splice(at, 0, id);
        this.state.groups[to.key] = to.panels;
        this.groupOfPanel.set(id, to);
        this.state.closed = this.state.closed.filter(x => x !== id);
        this.state.active[to.key] = id;
        to.el.classList.remove('collapsed');
        this.state.collapsed = this.state.collapsed.filter(k => k !== to.key);
        this.renderAllGroups();
        this.saveState();
    }
    floatPanel(id, clientX, clientY) {
        const p = this.byId.get(id);
        if (!p)
            return;
        const from = this.groupOfPanel.get(id);
        if (from) {
            from.panels = from.panels.filter(pid => pid !== id);
            this.state.groups[from.key] = from.panels;
            if (this.state.active[from.key] === id) {
                this.state.active[from.key] = from.panels.find(pid => !this.state.closed.includes(pid)) || null;
            }
        }
        this.ensureTitle(p);
        p.classList.add('floating');
        p.classList.remove('collapsed');
        p.classList.remove('active');
        p.dataset.float = '1';
        p.hidden = false;
        if (p.parentElement !== this.floatingLayer)
            this.floatingLayer.appendChild(p);
        const lr = this.floatingLayer.getBoundingClientRect();
        const maxL = Math.max(4, lr.width - p.offsetWidth - 6);
        const maxT = Math.max(4, lr.height - 40);
        const left = clamp(clientX - lr.left - 80, 4, maxL);
        const top = clamp(clientY - lr.top - 14, 4, maxT);
        p.style.left = left + 'px';
        p.style.top = top + 'px';
        this.state.float[id] = { left, top, collapsed: false };
        this.state.closed = this.state.closed.filter(x => x !== id);
        this.groupOfPanel.delete(id);
        this.renderAllGroups();
        this.saveState();
        this.front(p);
    }
    /* ---------------- 浮动位置 / 层级 ---------------- */
    positionFloating(p, anchor) {
        const id = p.dataset.panel;
        const saved = this.state.float[id] || {};
        const lr = this.floatingLayer.getBoundingClientRect();
        if (!lr.width)
            return;
        let left = Number.isFinite(saved.left) ? saved.left : 330;
        let top = Number.isFinite(saved.top) ? saved.top : 8;
        if (anchor) {
            const ar = anchor.getBoundingClientRect();
            left = ar.left - lr.left;
            top = Math.max(36, ar.bottom - lr.top + 6);
        }
        const maxL = Math.max(4, lr.width - p.offsetWidth - 6);
        const maxT = Math.max(4, lr.height - 40);
        left = clamp(left, 4, maxL);
        top = clamp(top, 4, maxT);
        p.style.left = left + 'px';
        p.style.top = top + 'px';
        if (anchor) {
            this.state.float[id] = { ...(this.state.float[id] || {}), left, top };
            this.saveState();
        }
    }
    front(p) {
        p.style.zIndex = String(++this.z);
    }
    clampFloating() {
        for (const [id] of Object.entries(this.state.float)) {
            const p = this.byId.get(id);
            if (!p || p.hidden)
                continue;
            this.positionFloating(p, null);
        }
    }
    clampHeights() {
        const total = this.root.clientHeight;
        if (!total)
            return;
        const minLayers = 150;
        let color = Number(this.state.heights.color) || 238;
        let history = Number(this.state.heights.history) || 194;
        const avail = total - 12;
        if (color + history + minLayers > avail) {
            const over = color + history + minLayers - avail;
            if (history > color)
                history = Math.max(110, history - over);
            else
                color = Math.max(110, color - over);
        }
        this.state.heights.color = color;
        this.state.heights.history = history;
        for (const g of this.groups) {
            const h = this.state.heights[g.key];
            if (Number.isFinite(h) && g.key !== 'layers')
                g.el.style.flexBasis = h + 'px';
        }
    }
}
