// 菜单栏 + 模态对话框（PS 风格：落笔生花/文件/编辑/视图/窗口/设置/帮助）

export function showModal(title, bodyHTML, onMount) {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');
  modal.innerHTML = `
    <div class="modal-title">${title}<button class="modal-close">×</button></div>
    <div class="modal-body">${bodyHTML}</div>`;
  overlay.classList.remove('hidden');
  modal.querySelector('.modal-close').addEventListener('click', hideModal);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) hideModal(); });
  if (onMount) onMount(modal);
}

export function hideModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

/* ---------------- 菜单栏 ---------------- */

export function initMenuBar(actions) {
  const bar = document.getElementById('menubar');
  let openMenu = null;

  const menus = [
    {
      label: '落笔生花', bold: true,
      items: [
        { label: '关于落笔生花', action: 'about' },
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
      items: [
        { label: '放大', shortcut: '+', action: 'zoomIn' },
        { label: '缩小', shortcut: '-', action: 'zoomOut' },
        { label: '复位视图', shortcut: '0', action: 'resetView' },
        { sep: true },
        { label: '逆时针旋转 15°', action: 'rotateLeft' },
        { label: '顺时针旋转 15°', action: 'rotateRight' },
      ],
    },
    {
      label: '窗口',
      dynamic: () => [
        ...actions.panelList().map(p => ({
          label: p.name + ' 面板',
          checked: p.visible,
          action: () => actions.togglePanel(p.id),
        })),
        { sep: true },
        { label: '重置面板布局', action: 'resetLayout' },
      ],
    },
    {
      label: '设置',
      items: [
        { label: '偏好设置…', action: 'settings' },
      ],
    },
    {
      label: '帮助',
      items: [
        { label: '快捷键一览', action: 'shortcuts' },
      ],
    },
  ];

  function closeAll() {
    bar.querySelectorAll('.menu-dropdown').forEach(d => d.remove());
    bar.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
    openMenu = null;
  }

  function openDropdown(menu, anchorEl) {
    closeAll();
    anchorEl.classList.add('open');
    const items = menu.dynamic ? menu.dynamic() : menu.items;
    const dd = document.createElement('div');
    dd.className = 'menu-dropdown';
    dd.style.left = anchorEl.offsetLeft + 'px';
    for (const item of items) {
      if (item.sep) {
        const s = document.createElement('div');
        s.className = 'menu-sep';
        dd.appendChild(s);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'menu-row';
      const check = document.createElement('span');
      check.className = 'menu-check';
      check.textContent = item.checked ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;
      const sc = document.createElement('span');
      sc.className = 'menu-shortcut';
      sc.textContent = item.shortcut || '';
      row.append(check, label, sc);
      row.addEventListener('click', () => {
        closeAll();
        if (typeof item.action === 'function') item.action();
        else if (actions[item.action]) actions[item.action]();
      });
      dd.appendChild(row);
    }
    bar.appendChild(dd);
    openMenu = menu;
  }

  for (const menu of menus) {
    const el = document.createElement('div');
    el.className = 'menu-item' + (menu.bold ? ' bold' : '');
    el.textContent = menu.label;
    el.addEventListener('click', () => {
      if (openMenu === menu) closeAll();
      else openDropdown(menu, el);
    });
    el.addEventListener('pointerenter', () => {
      if (openMenu && openMenu !== menu) openDropdown(menu, el);
    });
    bar.appendChild(el);
  }

  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !bar.contains(e.target)) closeAll();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAll(); hideModal(); }
  });
}

/* ---------------- 对话框模板 ---------------- */

export function aboutDialog() {
  showModal('关于落笔生花', `
    <div class="about">
      <div class="about-name">落笔生花</div>
      <div class="about-en">Luobishenghua · beta8</div>
      <p>一款正在生长的绘画软件。</p>
      <p>压感笔刷引擎 · 图层组 / 蒙版 / 剪贴蒙版 · 选区 / 自由变换<br>PSD 分层互通 · .abr 笔刷生态 · 原生工程 .lbsh<br>增量撤销 · 自动保存与崩溃恢复 · 全部为手写零依赖实现</p>
      <p class="about-credit">开发：WorkBuddy × likeweixue</p>
    </div>`);
}

export function shortcutsDialog() {
  showModal('快捷键一览', `
    <table class="kbd-table">
      <tr><td><kbd>B</kbd> / <kbd>E</kbd> / <kbd>H</kbd></td><td>画笔 / 橡皮 / 抓手</td></tr>
      <tr><td><kbd>V</kbd> / <kbd>M</kbd> / <kbd>⇧M</kbd></td><td>移动 / 矩形选框 / 椭圆选框</td></tr>
      <tr><td><kbd>L</kbd> / <kbd>⇧L</kbd></td><td>套索 / 多边形套索（双击或 Enter 闭合）</td></tr>
      <tr><td><kbd>⌘A</kbd> / <kbd>⌘D</kbd> / <kbd>⇧⌘I</kbd></td><td>全选 / 取消选择 / 反选</td></tr>
      <tr><td><kbd>⌘T</kbd> / <kbd>Enter</kbd> / <kbd>Esc</kbd></td><td>自由变换 / 应用 / 取消</td></tr>
      <tr><td><kbd>⌘C</kbd> / <kbd>⌘X</kbd> / <kbd>⌘V</kbd></td><td>复制 / 剪切 / 粘贴为新图层</td></tr>
      <tr><td><kbd>Delete</kbd> / <kbd>⇧F5</kbd></td><td>清除选区内容 / 填充前景色</td></tr>
      <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>笔刷减小 / 增大</td></tr>
      <tr><td><kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd></td><td>撤销 / 重做</td></tr>
      <tr><td><kbd>⌘N</kbd></td><td>新建文档</td></tr>
      <tr><td><kbd>⌘O</kbd></td><td>打开工程（.lbsh）</td></tr>
      <tr><td><kbd>⌘S</kbd> / <kbd>⇧⌘S</kbd></td><td>保存工程 / 另存为</td></tr>
      <tr><td><kbd>0</kbd></td><td>复位视图</td></tr>
      <tr><td><kbd>空格</kbd> + 拖动</td><td>平移画布</td></tr>
      <tr><td>双指滚动</td><td>平移画布</td></tr>
      <tr><td>捏合 / ⌃滚轮</td><td>缩放画布</td></tr>
      <tr><td>双击面板标题</td><td>折叠 / 展开面板</td></tr>
      <tr><td>拖动面板到边缘</td><td>磁吸停靠</td></tr>
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
