// 菜单栏 + 模态对话框 + 通用弹出菜单（PS 风格）
// 源文件：app 运行时使用 app/js/menu.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/menu.js。
import { icon } from './icons.js';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function fmtShortcut(sc) {
    if (!sc)
        return '';
    if (IS_MAC)
        return sc;
    return sc.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+');
}
/* ---------------- 模态对话框 ---------------- */
export function showModal(title, bodyHTML, onMount) {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById('modal');
    modal.innerHTML = `
    <div class="modal-title">${title}<button class="modal-close">×</button></div>
    <div class="modal-body">${bodyHTML}</div>`;
    overlay.classList.remove('hidden');
    modal.querySelector('.modal-close').addEventListener('click', hideModal);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay)
        hideModal(); });
    if (onMount)
        onMount(modal);
}
export function hideModal() {
    const modal = document.getElementById('modal');
    if (modal)
        modal.classList.remove('color-picker-modal');
    document.getElementById('modal-overlay').classList.add('hidden');
}
/* ---------------- 通用弹出菜单 ---------------- */
let activeMenu = null;
export function closeMenus() {
    if (activeMenu) {
        const a = activeMenu;
        activeMenu = null;
        a.cleanup();
    }
}
/**
 * 在锚点元素下方弹出菜单。
 * items: [{ label, shortcut, checked, disabled, icon, action, sep }]
 */
export function showMenuAt(anchor, items, opts = {}) {
    closeMenus();
    const layer = document.getElementById('menu-layer');
    const dd = document.createElement('div');
    dd.className = 'menu-dropdown';
    if (opts.className)
        dd.className += ' ' + opts.className;
    for (const item of items) {
        if (!item)
            continue;
        if (item.sep) {
            const s = document.createElement('div');
            s.className = 'menu-sep';
            dd.appendChild(s);
            continue;
        }
        const row = document.createElement('div');
        row.className = 'menu-row' + (item.disabled ? ' disabled' : '');
        const lead = document.createElement('span');
        lead.className = 'menu-check';
        if (item.checked)
            lead.textContent = '✓';
        else if (item.icon)
            lead.innerHTML = icon(item.icon);
        const label = document.createElement('span');
        label.className = 'menu-label';
        label.textContent = item.label;
        const sc = document.createElement('span');
        sc.className = 'menu-shortcut';
        sc.textContent = fmtShortcut(item.shortcut);
        row.append(lead, label, sc);
        if (!item.disabled) {
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                closeMenus();
                if (typeof item.action === 'function')
                    item.action();
            });
        }
        dd.appendChild(row);
    }
    layer.appendChild(dd);
    // 定位
    const ar = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = dd.offsetWidth;
    const h = dd.offsetHeight;
    let left = opts.align === 'left' ? ar.left : ar.right - w;
    if (opts.align === 'center')
        left = ar.left + ar.width / 2 - w / 2;
    let top = ar.bottom + 2;
    if (left < 6)
        left = 6;
    if (left + w > vw - 6)
        left = vw - w - 6;
    if (top + h > vh - 6) {
        top = ar.top - h - 2;
        if (top < 6)
            top = Math.max(6, vh - h - 6);
    }
    dd.style.left = Math.round(left) + 'px';
    dd.style.top = Math.round(top) + 'px';
    const onDown = (e) => {
        if (!dd.contains(e.target) && !anchor.contains(e.target))
            closeMenus();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMenus();
        }
    };
    const onBlur = () => closeMenus();
    const onResize = () => closeMenus();
    setTimeout(() => {
        document.addEventListener('pointerdown', onDown, true);
    }, 0);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    activeMenu = {
        dd,
        anchor,
        cleanup() {
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('resize', onResize);
            dd.remove();
            anchor.classList?.remove('open');
        },
    };
    return activeMenu;
}
/* ---------------- 菜单栏 ---------------- */
export function initMenuBar(actions) {
    const bar = document.getElementById('menubar');
    const container = document.getElementById('menu-items') || bar;
    let openMenu = null;
    const menus = [
        {
            label: '落笔生花', bold: true,
            items: [
                { label: '关于落笔生花', action: 'about' },
                { sep: true },
                { label: '偏好设置…', shortcut: '⌘,', action: 'settings' },
                { sep: true },
                { label: '快捷键一览', action: 'shortcuts' },
            ],
        },
        {
            label: '文件',
            items: [
                { label: '首页 / 最近文件', action: 'home' },
                { sep: true },
                { label: '新建文档…', shortcut: '⌘N', action: 'newDoc' },
                { label: '打开工程…', shortcut: '⌘O', action: 'openProject' },
                { label: '打开 PSD…', action: 'openPSD' },
                { sep: true },
                { label: '保存工程', shortcut: '⌘S', action: 'saveProject' },
                { label: '工程另存为…', shortcut: '⇧⌘S', action: 'saveAsProject' },
                { sep: true },
                { label: '导出 PNG', action: 'exportPNG' },
                { label: '导出 PSD（分层）', action: 'exportPSD' },
                { sep: true },
                { label: '导入 .abr 笔刷…', action: 'importABR' },
            ],
        },
        {
            label: '编辑',
            items: [
                { label: '撤销', shortcut: '⌘Z', action: 'undo' },
                { label: '重做', shortcut: '⇧⌘Z', action: 'redo' },
                { sep: true },
                { label: '复制', shortcut: '⌘C', action: 'copy' },
                { label: '剪切', shortcut: '⌘X', action: 'cut' },
                { label: '粘贴为新图层', shortcut: '⌘V', action: 'paste' },
                { sep: true },
                { label: '清除（选区 / 图层）', shortcut: 'Delete', action: 'clearLayer' },
                { label: '填充前景色', shortcut: '⇧F5', action: 'fill' },
                { sep: true },
                { label: '自由变换', shortcut: '⌘T', action: 'freeTransform' },
            ],
        },
        {
            label: '图层',
            items: [
                { label: '新建图层', action: 'layerNew' },
                { label: '新建组', action: 'layerGroup' },
                { label: '删除', action: 'layerDelete' },
                { sep: true },
                { label: '上移一层', action: 'layerUp' },
                { label: '下移一层', action: 'layerDown' },
                { label: '移入上方组', action: 'layerMoveIn' },
                { label: '移出组', action: 'layerMoveOut' },
                { sep: true },
                { label: '添加 / 启用蒙版', action: 'layerMask' },
                { label: '反相蒙版', action: 'layerMaskInvert' },
                { label: '删除蒙版', action: 'layerMaskDelete' },
                { label: '剪贴蒙版', action: 'layerClip' },
                { sep: true },
                { label: '锁定透明像素', action: 'layerLockAlpha' },
                { label: '向下合并', action: 'layerMerge' },
                { label: '合并可见', action: 'layerMergeVisible' },
                { label: '盖印图层', action: 'layerStamp' },
                { label: '拼合图像', action: 'layerFlatten' },
                { sep: true },
                { label: '清除（选区 / 图层）', action: 'clearLayer' },
            ],
        },
        {
            label: '选择',
            items: [
                { label: '全选', shortcut: '⌘A', action: 'selectAll' },
                { label: '取消选择', shortcut: '⌘D', action: 'deselect' },
                { label: '反选', shortcut: '⇧⌘I', action: 'invertSelection' },
                { sep: true },
                { label: '羽化…', action: 'featherSelection' },
            ],
        },
        {
            label: '视图',
            dynamic: () => [
                { label: '放大', shortcut: '⌘+', action: 'zoomIn' },
                { label: '缩小', shortcut: '⌘-', action: 'zoomOut' },
                { label: '适合屏幕', shortcut: '⌘0', action: 'resetView' },
                { label: '实际像素', shortcut: '⌘1', action: 'zoom100' },
                { sep: true },
                { label: '标尺', checked: actions.rulersOn ? actions.rulersOn() : false, action: 'toggleRulers' },
                {
                    label: 'GPU 合成（组 / 蒙版 / 混合）',
                    checked: actions.gpuOn ? actions.gpuOn() : false,
                    disabled: actions.gpuAvailable ? !actions.gpuAvailable() : false,
                    action: 'toggleGpu',
                },
                { sep: true },
                { label: '逆时针旋转 15°', action: 'rotateLeft' },
                { label: '顺时针旋转 15°', action: 'rotateRight' },
            ],
        },
        {
            label: '窗口',
            dynamic: () => [
                ...actions.panelList().map(p => ({
                    label: p.name,
                    checked: p.visible,
                    action: () => actions.togglePanel(p.id),
                })),
                { sep: true },
                { label: '工具栏', checked: actions.toolbarVisible ? actions.toolbarVisible() : true, action: 'toggleToolbar' },
                { label: '显示 / 隐藏面板', shortcut: 'Tab', action: 'togglePanels' },
                { sep: true },
                { label: '重置工作区', action: 'resetLayout' },
            ],
        },
        {
            label: '帮助',
            items: [
                { label: '快捷键一览', action: 'shortcuts' },
                { label: '关于落笔生花', action: 'about' },
            ],
        },
    ];
    function closeAll() {
        closeMenus();
        container.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
        openMenu = null;
    }
    function openDropdown(menu, anchorEl) {
        closeAll();
        anchorEl.classList.add('open');
        const rawItems = menu.dynamic ? menu.dynamic() : menu.items;
        // 菜单项里允许写 action: 'saveProject' 这样的字符串；在这里解析成函数。
        // （面板菜单 / 工具组菜单传入的本来就是函数，保持不变。）
        const items = rawItems.map(item => {
            if (!item || item.sep || typeof item.action !== 'string')
                return item;
            const fn = actions[item.action];
            return { ...item, action: typeof fn === 'function' ? fn : () => { } };
        });
        showMenuAt(anchorEl, items, { align: 'left' });
        const instance = activeMenu;
        const oldCleanup = instance.cleanup;
        instance.cleanup = () => {
            oldCleanup();
            anchorEl.classList.remove('open');
            if (openMenu === menu)
                openMenu = null;
        };
        openMenu = menu;
    }
    for (const menu of menus) {
        const el = document.createElement('div');
        el.className = 'menu-item' + (menu.bold ? ' bold' : '');
        el.textContent = menu.label;
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (openMenu === menu)
                closeAll();
            else
                openDropdown(menu, el);
        });
        el.addEventListener('pointerenter', () => {
            if (openMenu && openMenu !== menu)
                openDropdown(menu, el);
        });
        container.appendChild(el);
    }
    document.addEventListener('pointerdown', (e) => {
        if (openMenu && !bar.contains(e.target) && !e.target.closest('.menu-dropdown'))
            closeAll();
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAll();
            hideModal();
        }
    });
}
/* ---------------- 对话框模板 ---------------- */
export function aboutDialog() {
    showModal('关于落笔生花', `
    <div class="about">
      <div class="about-name">落笔生花</div>
      <div class="about-en">LUOBISHENGHUA · beta25 · Photoshop 风格工作台</div>
      <p>一款正在生长的专业绘画软件。</p>
      <p>瓦片化图层存储（大画布 / 多图层）· WebGL2 GPU 合成（组 / 蒙版 / 混合）· GPU 笔刷预览 / Worker 提交<br>压感笔刷引擎<br>图层组 / 蒙版 / 剪贴蒙版 · 选区 / 自由变换<br>涂抹 · 油漆桶 · 渐变 · 吸管 · 可调压感曲线与倾斜<br>PSD 分层互通 · .abr 笔刷生态 · 原生工程 .lbsh<br>增量撤销 · 自动保存与崩溃恢复 · 全部为手写零依赖实现</p>
      <p class="about-credit">开发：WorkBuddy × likeweixue<br>面板 / GPU / 测试协作：DeepSeek（beta12 起）</p>
    </div>`);
}
export function shortcutsDialog() {
    showModal('快捷键一览', `
    <table class="kbd-table">
      <tr><td><kbd>B</kbd> / <kbd>E</kbd> / <kbd>H</kbd></td><td>画笔 / 橡皮 / 抓手</td></tr>
      <tr><td><kbd>S</kbd> / <kbd>G</kbd> / <kbd>⇧G</kbd> / <kbd>I</kbd> / <kbd>Z</kbd></td><td>涂抹 / 油漆桶 / 渐变 / 吸管 / 缩放</td></tr>
      <tr><td><kbd>Alt</kbd> + 点击</td><td>画笔/橡皮/涂抹时临时吸管取色</td></tr>
      <tr><td><kbd>V</kbd> / <kbd>M</kbd> / <kbd>⇧M</kbd></td><td>移动 / 矩形选框 / 椭圆选框</td></tr>
      <tr><td><kbd>L</kbd> / <kbd>⇧L</kbd></td><td>套索 / 多边形套索（双击或 Enter 闭合）</td></tr>
      <tr><td><kbd>⌘A</kbd> / <kbd>⌘D</kbd> / <kbd>⇧⌘I</kbd></td><td>全选 / 取消选择 / 反选</td></tr>
      <tr><td><kbd>⌘T</kbd> / <kbd>Enter</kbd> / <kbd>Esc</kbd></td><td>自由变换 / 应用 / 取消</td></tr>
      <tr><td><kbd>⌘C</kbd> / <kbd>⌘X</kbd> / <kbd>⌘V</kbd></td><td>复制 / 剪切 / 粘贴为新图层</td></tr>
      <tr><td><kbd>Delete</kbd> / <kbd>⇧F5</kbd></td><td>清除选区内容 / 填充前景色</td></tr>
      <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>笔刷减小 / 增大</td></tr>
      <tr><td><kbd>X</kbd> / <kbd>D</kbd></td><td>交换前景/背景色 / 恢复默认黑白</td></tr>
      <tr><td><kbd>F5</kbd></td><td>打开 / 关闭画笔设置</td></tr>
      <tr><td><kbd>Tab</kbd></td><td>显示 / 隐藏全部面板</td></tr>
      <tr><td><kbd>⌘0</kbd> / <kbd>⌘1</kbd></td><td>适合屏幕 / 实际像素</td></tr>
      <tr><td><kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd></td><td>撤销 / 重做</td></tr>
      <tr><td><kbd>⌘N</kbd> / <kbd>⌘O</kbd> / <kbd>⌘S</kbd></td><td>新建 / 打开工程 / 保存工程</td></tr>
      <tr><td><kbd>空格</kbd> + 拖动</td><td>平移画布</td></tr>
      <tr><td>双指滚动 / 捏合</td><td>平移画布 / 缩放画布</td></tr>
      <tr><td>右键工具按钮</td><td>展开同组工具</td></tr>
      <tr><td>拖动面板分隔条</td><td>调整面板高度 / 宽度</td></tr>
    </table>`);
}
export function settingsDialog(settings, onApply) {
    showModal('偏好设置', `
    <div class="form">
      <label>撤销步数上限
        <input type="number" id="set-undo" min="5" max="100" value="${settings.undoLimit}">
      </label>
      <label>自动保存间隔（秒）
        <input type="number" id="set-autosave" min="10" max="600" value="${settings.autosaveSec || 60}">
      </label>
      <label>新建画布默认宽度
        <input type="number" id="set-w" min="100" max="8192" value="${settings.defaultWidth}">
      </label>
      <label>新建画布默认高度
        <input type="number" id="set-h" min="100" max="8192" value="${settings.defaultHeight}">
      </label>
      <div class="form-actions"><button class="primary" id="set-ok">保存</button></div>
    </div>`, (modal) => {
        modal.querySelector('#set-ok').addEventListener('click', () => {
            onApply({
                undoLimit: Math.max(5, Math.min(100, +modal.querySelector('#set-undo').value || 50)),
                autosaveSec: Math.max(10, Math.min(600, +modal.querySelector('#set-autosave').value || 60)),
                defaultWidth: Math.max(100, Math.min(8192, +modal.querySelector('#set-w').value || 1600)),
                defaultHeight: Math.max(100, Math.min(8192, +modal.querySelector('#set-h').value || 1600)),
            });
            hideModal();
        });
    });
}
export function newDocDialog(settings, onCreate) {
    showModal('新建文档', `
    <div class="form">
      <label>宽度（px）
        <input type="number" id="nd-w" min="100" max="8192" value="${settings.defaultWidth}">
      </label>
      <label>高度（px）
        <input type="number" id="nd-h" min="100" max="8192" value="${settings.defaultHeight}">
      </label>
      <p class="panel-hint">将替换当前文档（当前内容请先行导出）</p>
      <div class="form-actions"><button class="primary" id="nd-ok">创建</button></div>
    </div>`, (modal) => {
        modal.querySelector('#nd-ok').addEventListener('click', () => {
            const w = Math.max(100, Math.min(8192, +modal.querySelector('#nd-w').value || 1600));
            const h = Math.max(100, Math.min(8192, +modal.querySelector('#nd-h').value || 1600));
            onCreate(w, h);
            hideModal();
        });
    });
}
