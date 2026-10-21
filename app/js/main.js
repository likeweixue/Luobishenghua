// 主程序：面板系统 + 图层系统 + 笔画管线（压感采样 → 印章铺排）
import { Engine } from './engine.js';
import { History } from './history.js';
import { BrushPresets, BrushRegistry, registerCustomBrush, brushThumbnail, pressureSize, pressureAlpha, drawDab, getStamp } from './brushes.js';
import { readABR } from './abr.js';
import { initMenuBar, aboutDialog, shortcutsDialog, settingsDialog, newDocDialog } from './menu.js';
import { createHome, addRecent, toast } from './home.js';
import { serializeProject, deserializeProject, PROJECT_EXT } from './project.js';
import { idbPut, idbGet, idbDelete } from './idb.js';

/* ---------------- 设置（localStorage 持久化） ---------------- */

const settings = Object.assign(
  { undoLimit: 50, defaultWidth: 1600, defaultHeight: 1600, autosaveSec: 60 },
  JSON.parse(localStorage.getItem('lbsh-settings') || '{}')
);
function saveSettings() {
  localStorage.setItem('lbsh-settings', JSON.stringify(settings));
}
import { Dock } from './dock.js';
import { ColorWheel } from './colorwheel.js';
import { Navigator } from './navigator.js';
import { LayerStack } from './layers.js';
import { readPSD, writePSD } from './psd.js';

const canvas = document.getElementById('canvas');
const stage = document.getElementById('stage');
const engine = new Engine(canvas, 1600, 1600);
const layers = new LayerStack(1600, 1600);
engine.layers = layers;
const history = new History(engine, layers, settings.undoLimit);
const dock = new Dock(document.getElementById('dock-root'), stage);
const navigatorPanel = new Navigator(document.getElementById('navigator'), engine, stage);

const state = {
  tool: 'brush',          // brush | eraser | hand
  brush: 'hard',          // 当前画笔预设（橡皮是独立工具）
  color: '#222222',
  size: 24,
  opacity: 1,
  smoothing: 0,           // 防抖强度 0..1
  smoothPoint: null,     // 防抖平滑后的位置
  drawing: false,
  panning: false,
  spaceDown: false,
  last: null,
  spacingLeft: 0,
  panLast: null,
  journal: null,          // 当前笔画的瓦片快照日志
};

/* ---------------- 工程状态 ---------------- */

const AUTOSAVE_KEY = 'autosave';
let currentProjectPath = null;
let currentProjectName = '未命名.lbsh';
let dirty = false;
let autosaveTimer = null;
let autosaving = false;
let suppressDirty = false;

// 载入/新建文档时重置历史，且不算「脏」
function resetHistory() {
  suppressDirty = true;
  history.clear();
  suppressDirty = false;
}

/* ---------------- 首页 ---------------- */

let homeApi = null;
function hideHome() { if (homeApi) homeApi.hide(); }

/* ---------------- 工具面板 ---------------- */

const toolBtns = document.querySelectorAll('#tool-list button');

function refreshOptionsBarTool() {
  const icon = document.getElementById('opt-tool-icon');
  const name = document.getElementById('opt-tool-name');
  if (!icon || !name) return;
  if (state.tool === 'eraser') {
    icon.textContent = '◻';
    name.textContent = '橡皮擦';
  } else if (state.tool === 'hand') {
    icon.textContent = '✋';
    name.textContent = '抓手';
  } else {
    icon.textContent = '✏';
    const b = BrushRegistry.get(state.brush);
    name.textContent = '画笔' + (b && b.custom ? ' · ' + b.name : '');
  }
}

function setTool(tool) {
  state.tool = tool;
  toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.classList.toggle('panning', tool === 'hand');
  refreshOptionsBarTool();
  updateStatus();
}
toolBtns.forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

/* ---------------- 笔刷仓库 ---------------- */

const presetsEl = document.getElementById('brush-presets');

function renderBrushGrid() {
  presetsEl.innerHTML = '';
  for (const [id, brush] of BrushRegistry) {
    if (id === 'eraser') continue; // 橡皮在工具面板
    const btn = document.createElement('button');
    btn.dataset.brush = id;
    btn.title = brush.custom ? `${brush.name}（${brush.diameter}px 笔尖）` : brush.name;
    btn.appendChild(brushThumbnail(brush));
    const label = document.createElement('span');
    label.textContent = brush.name;
    btn.appendChild(label);
    if (id === state.brush) btn.classList.add('active');
    btn.addEventListener('click', () => setBrush(id));
    presetsEl.appendChild(btn);
  }
  dock.reflowBoth();
}
renderBrushGrid();

function setBrush(id) {
  if (id === 'eraser') { setTool('eraser'); return; }
  state.brush = id;
  const b = BrushRegistry.get(id);
  if (b && b.custom) {
    // 导入笔刷默认用原笔尖直径作为粗细
    state.size = Math.min(200, Math.max(4, Math.round(b.diameter / 2)));
    sizeInput.value = state.size;
    document.getElementById('brush-size-val').textContent = state.size;
  }
  renderBrushGrid();
  setTool('brush');
}

/* ---------------- .abr 导入 ---------------- */

function importABRBuffer(buf) {
  try {
    const result = readABR(buf);
    if (result.brushes.length === 0) {
      alert(`没有可导入的笔尖${result.skipped ? `（跳过 ${result.skipped} 个计算型/不支持条目）` : ''}`);
      return;
    }
    let first = null;
    for (const tip of result.brushes) {
      const b = registerCustomBrush(tip);
      if (!first) first = b;
    }
    renderBrushGrid();
    if (first) setBrush(first.id);
    let msg = `导入 ${result.brushes.length} 个笔刷`;
    if (result.skipped) msg += `，跳过 ${result.skipped} 个（计算型圆头等）`;
    alert(msg);
    if (result.warnings.length) console.warn('[ABR]', result.warnings);
  } catch (err) {
    alert('ABR 读取失败：' + err.message);
  }
}

function importABRFile(file) {
  file.arrayBuffer().then(importABRBuffer);
}

document.getElementById('btn-import-abr').addEventListener('click', () => {
  document.getElementById('file-abr').click();
});
document.getElementById('file-abr').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) importABRFile(f);
  e.target.value = '';
});

/* ---------------- 颜色 ---------------- */

const colorChip = document.getElementById('color-chip');
const wheel = new ColorWheel(document.getElementById('color-wheel'), (hex) => {
  state.color = hex;
  colorChip.style.background = hex;
});
wheel.setHex(state.color);

const swatchesEl = document.getElementById('swatches');
const swatchColors = ['#222222', '#e24b4a', '#ef9f27', '#f7d154', '#378add', '#1d9e75', '#7f77dd', '#8b5e3c', '#ffffff', '#888888'];
for (const c of swatchColors) {
  const s = document.createElement('div');
  s.className = 'swatch';
  s.style.background = c;
  s.addEventListener('click', () => {
    state.color = c;
    wheel.setHex(c);
    colorChip.style.background = c;
  });
  swatchesEl.appendChild(s);
}

/* ---------------- 工具属性 ---------------- */

const sizeInput = document.getElementById('brush-size');
const opacityInput = document.getElementById('brush-opacity');
const smoothingInput = document.getElementById('brush-smoothing');

sizeInput.addEventListener('input', () => {
  state.size = +sizeInput.value;
  document.getElementById('brush-size-val').textContent = sizeInput.value;
  updateStatus();
});
opacityInput.addEventListener('input', () => {
  state.opacity = +opacityInput.value / 100;
  document.getElementById('brush-opacity-val').textContent = opacityInput.value + '%';
});
smoothingInput.addEventListener('input', () => {
  state.smoothing = +smoothingInput.value / 100;
  document.getElementById('brush-smoothing-val').textContent = smoothingInput.value + '%';
});

/* ---------------- 图层面板 ---------------- */

const layerListEl = document.getElementById('layer-list');
const blendSelect = document.getElementById('layer-blend');
const layerOpacityInput = document.getElementById('layer-opacity');

// 是否处于「编辑蒙版」状态：画笔作用到蒙版而不是图层像素
state.editMask = false;

function luminance(hex) {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function makeNameEl(l) {
  const name = document.createElement('span');
  name.className = 'lname' + (l.locked ? ' locked' : '');
  name.textContent = l.name;
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const n = prompt('图层名称', l.name);
    if (n && n.trim()) {
      history.pushFull('重命名图层');
      layers.rename(l.id, n);
    }
  });
  return name;
}

function makeMaskThumb(l) {
  const mthumb = document.createElement('canvas');
  mthumb.className = 'mthumb' + (state.editMask && l.id === layers.activeId ? ' editing' : '');
  mthumb.width = 22;
  mthumb.height = 18;
  mthumb.dataset.maskId = l.id;
  mthumb.title = '点击编辑蒙版';
  mthumb.addEventListener('click', (e) => {
    e.stopPropagation();
    layers.setActive(l.id);
    state.editMask = true;
    renderLayerPanel();
    updateStatus();
  });
  return mthumb;
}

function renderLayerPanel() {
  layerListEl.innerHTML = '';

  for (const { node: l, depth } of layers.flatTopFirst()) {
    const row = document.createElement('div');
    row.className = 'layer-row'
      + (l.id === layers.activeId ? ' active' : '')
      + (l.type === 'group' ? ' row-group' : '');
    row.style.paddingLeft = (3 + depth * 12) + 'px';

    const eye = document.createElement('span');
    eye.className = 'eye' + (l.visible ? '' : ' off');
    eye.textContent = '👁';
    eye.title = '显示/隐藏';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      history.pushFull(l.visible ? '隐藏' : '显示');
      layers.setVisible(l.id, !l.visible);
      engine.render();
      updateStatus();
    });
    row.appendChild(eye);

    if (l.type === 'group') {
      const arrow = document.createElement('span');
      arrow.className = 'larrow';
      arrow.textContent = l.expanded ? '▾' : '▸';
      arrow.title = '展开/折叠';
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        history.pushFull('展开/折叠组');
        layers.toggleExpanded(l.id);
      });
      const icon = document.createElement('span');
      icon.className = 'licon';
      icon.textContent = '📁';
      row.append(arrow, icon);
      if (l.mask) row.appendChild(makeMaskThumb(l));
      row.appendChild(makeNameEl(l));
    } else {
      const thumb = document.createElement('canvas');
      thumb.className = 'thumb';
      thumb.width = 30;
      thumb.height = 24;
      thumb.dataset.layerId = l.id;
      row.appendChild(thumb);

      if (l.mask) row.appendChild(makeMaskThumb(l));
      row.appendChild(makeNameEl(l));

      const tags = document.createElement('span');
      tags.className = 'ltags';
      if (l.clipping) tags.insertAdjacentHTML('beforeend', '<span class="ltag clip" title="剪贴蒙版">↳</span>');
      if (l.lockAlpha) tags.insertAdjacentHTML('beforeend', '<span class="ltag lock" title="锁定透明像素">α</span>');
      if (l.locked) tags.insertAdjacentHTML('beforeend', '<span class="ltag lock" title="锁定">🔒</span>');
      row.appendChild(tags);
    }

    row.addEventListener('click', () => {
      layers.setActive(l.id);
      state.editMask = false;
      updateStatus();
    });
    layerListEl.appendChild(row);
  }

  refreshThumbs();
  syncLayerControls();
  dock.reflowBoth();
}

function refreshThumbs() {
  for (const thumb of layerListEl.querySelectorAll('canvas.thumb[data-layer-id]')) {
    const l = layers.byId(+thumb.dataset.layerId);
    if (!l || !l.canvas) continue;
    const tc = thumb.getContext('2d');
    tc.clearRect(0, 0, 30, 24);
    tc.save();
    tc.scale(30 / layers.w, 24 / layers.h);
    tc.drawImage(l.canvas, 0, 0);
    tc.restore();
  }
  for (const mthumb of layerListEl.querySelectorAll('canvas.mthumb[data-mask-id]')) {
    const l = layers.byId(+mthumb.dataset.maskId);
    if (!l || !l.mask) continue;
    const tc = mthumb.getContext('2d');
    tc.fillStyle = '#111111';
    tc.fillRect(0, 0, 22, 18);
    tc.save();
    tc.scale(22 / layers.w, 18 / layers.h);
    tc.drawImage(l.mask.canvas, 0, 0);
    tc.restore();
    if (!l.mask.enabled) {
      tc.strokeStyle = '#e24b4a';
      tc.lineWidth = 2;
      tc.beginPath();
      tc.moveTo(1, 1); tc.lineTo(21, 17);
      tc.moveTo(21, 1); tc.lineTo(1, 17);
      tc.stroke();
    }
  }
}

function syncLayerControls() {
  const n = layers.active;
  if (!n) return;
  blendSelect.value = n.blend;
  layerOpacityInput.value = Math.round(n.opacity * 100);
  document.getElementById('layer-opacity-val').textContent = Math.round(n.opacity * 100);

  const locked = n.locked;
  const isGroup = n.type === 'group';
  blendSelect.disabled = locked;
  layerOpacityInput.disabled = locked;
  document.getElementById('btn-layer-del').disabled = locked;
  document.getElementById('btn-layer-up').disabled = locked;
  document.getElementById('btn-layer-down').disabled = locked;
  document.getElementById('btn-layer-merge').disabled = locked || isGroup;
  document.getElementById('btn-layer-lockalpha').disabled = isGroup;

  const mBtn = document.getElementById('btn-layer-mask');
  mBtn.disabled = locked;
  mBtn.textContent = !n.mask ? '蒙版' : (n.mask.enabled ? '蒙版✓' : '蒙版✕');

  const cBtn = document.getElementById('btn-layer-clip');
  cBtn.disabled = isGroup && false;
  cBtn.classList.toggle('active', !!n.clipping);

  document.getElementById('btn-layer-lockalpha').classList.toggle('active', !!n.lockAlpha);
}

function layerOp(label, fn) {
  history.pushFull(label);
  if (!fn()) history.dropLast();
  engine.render();
  refreshThumbs();
  updateStatus();
}

document.getElementById('btn-layer-add').addEventListener('click', () => {
  history.pushFull('新建图层');
  layers.addLayer();
  engine.render();
  updateStatus();
});

document.getElementById('btn-layer-group').addEventListener('click', () => {
  history.pushFull('新建组');
  layers.addGroup();
  engine.render();
  updateStatus();
});

document.getElementById('btn-layer-del').addEventListener('click', () => {
  const n = layers.active;
  if (!n) return;
  const what = n.type === 'group' ? `组「${n.name}」及其全部内容` : `「${n.name}」`;
  if (!confirm(`删除${what}？（可用撤销恢复）`)) return;
  layerOp('删除图层', () => layers.deleteActive());
});

document.getElementById('btn-layer-up').addEventListener('click', () => {
  layerOp('上移图层', () => layers.moveActive(1));
});
document.getElementById('btn-layer-down').addEventListener('click', () => {
  layerOp('下移图层', () => layers.moveActive(-1));
});

document.getElementById('btn-layer-mask').addEventListener('click', () => {
  const n = layers.active;
  if (!n) return;
  if (!n.mask) layerOp('添加蒙版', () => layers.addMask());
  else layerOp(n.mask.enabled ? '停用蒙版' : '启用蒙版', () => layers.toggleMaskEnabled());
});

document.getElementById('btn-layer-clip').addEventListener('click', () => {
  layerOp('剪贴蒙版', () => layers.toggleClipping());
});

document.getElementById('btn-layer-merge').addEventListener('click', () => {
  const n = layers.active;
  if (!n || n.type === 'group') return;
  layerOp('向下合并', () => layers.mergeDown());
});

document.getElementById('btn-layer-lockalpha').addEventListener('click', () => {
  layerOp('锁定透明像素', () => layers.toggleLockAlpha());
});

blendSelect.addEventListener('change', () => {
  history.pushFull('混合模式');
  layers.setBlend(blendSelect.value);
  engine.render();
});
layerOpacityInput.addEventListener('pointerdown', () => history.pushFull('图层不透明度'));
layerOpacityInput.addEventListener('input', () => {
  layers.setOpacity(+layerOpacityInput.value / 100);
  document.getElementById('layer-opacity-val').textContent = layerOpacityInput.value;
  engine.render();
});

layers.onChange = () => renderLayerPanel();

/* ---------------- 历史面板 ---------------- */

const historyListEl = document.getElementById('history-list');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  if (!n) return '0';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function refreshHistoryPanel() {
  if (!historyListEl) return;
  const items = history.timeline();
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'hist-row' + (it.current ? ' current' : '') + (it.future ? ' future' : '');
    row.title = it.label;
    row.innerHTML = `<span class="hidx">${it.index}</span><span class="hlabel">${escapeHtml(it.label)}</span>`;
    row.addEventListener('click', () => {
      history.jumpTo(it.index);
      refreshThumbs();
      updateStatus();
    });
    frag.appendChild(row);
  }
  historyListEl.innerHTML = '';
  historyListEl.appendChild(frag);
  const cur = historyListEl.querySelector('.hist-row.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  const mem = document.getElementById('hist-memory');
  if (mem) {
    const used = history.memoryBytes();
    mem.textContent = `${history.position} 步` + (used ? ` · ${fmtBytes(used)}` : '');
  }
  if (dock) dock.reflowBoth();
}

history.onChange = () => {
  refreshHistoryPanel();
  if (!suppressDirty) dirty = true;
  const btnU = document.getElementById('btn-hist-undo');
  const btnR = document.getElementById('btn-hist-redo');
  if (btnU) btnU.disabled = !history.canUndo;
  if (btnR) btnR.disabled = !history.canRedo;
};
document.getElementById('btn-hist-undo').addEventListener('click', () => { history.undo(); refreshThumbs(); updateStatus(); });
document.getElementById('btn-hist-redo').addEventListener('click', () => { history.redo(); refreshThumbs(); updateStatus(); });

/* ---------------- 工程文件（.lbsh） ---------------- */

function setAutosaveStatus(text) {
  const el = document.getElementById('status-autosave');
  if (el) el.textContent = text;
}

async function applyProject(project, meta = {}) {
  layers.reset(project.width, project.height);
  layers.layers = layers.importNodes(project.nodes || []);
  const active = project.activePath ? layers.nodeAtPath(project.activePath) : null;
  const fallback = layers.leaves().slice(-1)[0];
  layers.activeId = (active || fallback)?.id || null;

  engine.setDocSize(project.width, project.height);
  document.getElementById('status-doc').textContent = `画布 ${project.width} × ${project.height}`;
  resetHistory();
  renderLayerPanel();
  engine.resize();
  engine.fit();
  updateStatus();

  currentProjectPath = meta.path || null;
  currentProjectName = meta.name || `未命名.${PROJECT_EXT}`;
  dirty = false;
  addRecent({ name: currentProjectName, path: currentProjectPath, w: project.width, h: project.height });
  hideHome();
  setAutosaveStatus('未修改');
  toast(`已打开 ${currentProjectName}`);
}

async function saveProject({ saveAs = false } = {}) {
  try {
    setAutosaveStatus('正在保存…');
    const { bytes } = await serializeProject(layers, engine);
    if (TAURI && TAURI.dialog && TAURI.fs) {
      let path = saveAs ? null : currentProjectPath;
      if (!path) {
        path = await TAURI.dialog.save({
          defaultPath: currentProjectName || `未命名.${PROJECT_EXT}`,
          filters: [{ name: '落笔生花工程', extensions: [PROJECT_EXT] }],
        });
      }
      if (!path) { setAutosaveStatus('未保存'); return false; }
      await TAURI.fs.writeFile(path, bytes);
      currentProjectPath = path;
      currentProjectName = path.split(/[\\/]/).pop();
    } else {
      await saveBytes(bytes, currentProjectName || `luobishenghua.${PROJECT_EXT}`, '落笔生花工程', [PROJECT_EXT]);
    }
    dirty = false;
    await idbDelete(AUTOSAVE_KEY);
    setAutosaveStatus('已保存');
    addRecent({ name: currentProjectName, path: currentProjectPath, w: layers.w, h: layers.h });
    toast('工程已保存');
    return true;
  } catch (err) {
    setAutosaveStatus('保存失败');
    alert('保存工程失败：' + err.message);
    return false;
  }
}

async function openProjectFromBytes(buf, name, path = null) {
  try {
    const project = await deserializeProject(buf);
    await applyProject(project, { name, path });
  } catch (err) {
    alert('打开工程失败：' + err.message);
  }
}

async function openProjectDialog() {
  if (TAURI && TAURI.dialog && TAURI.fs) {
    try {
      const path = await TAURI.dialog.open({
        multiple: false,
        filters: [{ name: '落笔生花工程', extensions: [PROJECT_EXT] }],
      });
      if (!path) return;
      const bytes = await TAURI.fs.readFile(path);
      await openProjectFromBytes(bytes, path.split(/[\\/]/).pop(), path);
    } catch (err) {
      alert('打开工程失败：' + err.message);
    }
    return;
  }
  document.getElementById('file-open-project').click();
}

document.getElementById('file-open-project').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) f.arrayBuffer().then(b => openProjectFromBytes(new Uint8Array(b), f.name));
  e.target.value = '';
});

/* ---------------- 自动保存 / 崩溃恢复 ---------------- */

async function doAutosave(force = false) {
  if (autosaving) return;
  if (!dirty && !force) return;
  autosaving = true;
  try {
    const { bytes } = await serializeProject(layers, engine);
    await idbPut(AUTOSAVE_KEY, {
      bytes,
      ts: Date.now(),
      name: currentProjectName,
      width: layers.w,
      height: layers.h,
    });
    setAutosaveStatus('已自动保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  } catch (err) {
    console.warn('[autosave]', err);
    setAutosaveStatus('自动保存失败');
  } finally {
    autosaving = false;
  }
}

function scheduleAutosave() {
  clearInterval(autosaveTimer);
  const sec = Math.max(10, settings.autosaveSec || 60);
  autosaveTimer = setInterval(() => doAutosave(false), sec * 1000);
}

let recoveryRecord = null;

async function checkRecovery() {
  try {
    const rec = await idbGet(AUTOSAVE_KEY);
    if (!rec || !rec.bytes) return;
    recoveryRecord = rec;
    const banner = document.getElementById('recovery-banner');
    if (!banner) return;
    document.getElementById('recovery-name').textContent = rec.name || `未命名.${PROJECT_EXT}`;
    document.getElementById('recovery-time').textContent = new Date(rec.ts).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    banner.classList.remove('hidden');
  } catch (err) {
    console.warn('[recovery]', err);
  }
}

document.getElementById('recovery-restore').addEventListener('click', async () => {
  if (!recoveryRecord) return;
  const rec = recoveryRecord;
  document.getElementById('recovery-banner').classList.add('hidden');
  await openProjectFromBytes(rec.bytes, rec.name, null);
});

document.getElementById('recovery-discard').addEventListener('click', async () => {
  recoveryRecord = null;
  document.getElementById('recovery-banner').classList.add('hidden');
  try { await idbDelete(AUTOSAVE_KEY); } catch { /* ignore */ }
});

/* ---------------- 顶栏操作 ---------------- */

function updateStatus() {
  const name = state.tool === 'eraser' ? '橡皮擦'
    : state.tool === 'hand' ? '抓手'
    : BrushRegistry.get(state.brush).name;
  document.getElementById('status-brush').textContent =
    `${name} · ${state.size}px · ${layers.active ? layers.active.name : ''}`;
  document.getElementById('btn-undo').disabled = !history.canUndo;
  document.getElementById('btn-redo').disabled = !history.canRedo;
  document.getElementById('zoom-label').textContent = Math.round(engine.view.scale * 100) + '%';
}

document.getElementById('btn-undo').addEventListener('click', () => { history.undo(); refreshThumbs(); updateStatus(); });
document.getElementById('btn-redo').addEventListener('click', () => { history.redo(); refreshThumbs(); updateStatus(); });
function clearActiveLayer() {
  const l = layers.active;
  if (!l) return;
  // 编辑蒙版状态下清空蒙版（恢复全显示）
  if (state.editMask && l.mask) {
    if (!confirm('清空蒙版（恢复全部显示）？')) return;
    history.pushFull('清空蒙版');   // clearMask 写新画布，快照引用旧画布
    layers.clearMask(l.id);
    engine.render();
    refreshThumbs();
    updateStatus();
    return;
  }
  if (l.type === 'group') { toast('组不能直接清空，请选择组内图层'); return; }

  if (!confirm(`清空「${l.name}」的内容？（可用撤销恢复）`)) return;
  const before = history.captureLayer(l.id);
  l.ctx.save();
  l.ctx.globalCompositeOperation = 'source-over';
  if (l.locked) {
    l.ctx.fillStyle = '#ffffff';
    l.ctx.fillRect(0, 0, layers.w, layers.h);
  } else {
    l.ctx.clearRect(0, 0, layers.w, layers.h);
  }
  l.ctx.restore();
  history.pushLayerDiff(l.id, before, '清空图层');
  engine.render();
  refreshThumbs();
  updateStatus();
}
/* ---------------- 文件保存桥（Tauri 桌面 / Web 回退） ---------------- */

const TAURI = window.__TAURI__ || null;

async function saveBytes(bytes, defaultName, filterName, exts) {
  if (TAURI && TAURI.dialog && TAURI.fs) {
    try {
      const path = await TAURI.dialog.save({
        defaultPath: defaultName,
        filters: [{ name: filterName, extensions: exts }],
      });
      if (!path) return; // 用户取消
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(await bytes.arrayBuffer());
      await TAURI.fs.writeFile(path, u8);
    } catch (err) {
      alert('保存失败：' + err.message);
    }
    return;
  }
  // Web 预览回退：浏览器下载
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(a.href);
}

function doExportPNG() {
  engine.exportPNG(async (blob) => {
    await saveBytes(blob, 'luobishenghua.png', 'PNG 图像', ['png']);
  });
}
document.getElementById('btn-save').addEventListener('click', doExportPNG);

/* ---------------- PSD 导入/导出 ---------------- */

function loadDocumentFromPSD(psd, meta = {}) {
  layers.reset(psd.width, psd.height);
  if (psd.nodes && psd.nodes.length > 0) {
    layers.layers = layers.importNodes(psd.nodes);
    const last = layers.leaves().slice(-1)[0];
    layers.activeId = last ? last.id : null;
  } else if (psd.composite) {
    // 无图层信息：用合成图像作为单图层
    const c = document.createElement('canvas');
    c.width = psd.width;
    c.height = psd.height;
    c.getContext('2d').putImageData(psd.composite, 0, 0);
    layers.pushLayer({ name: '背景', canvas: c });
    const last = layers.leaves().slice(-1)[0];
    layers.activeId = last ? last.id : null;
  }
  engine.setDocSize(psd.width, psd.height);
  document.getElementById('status-doc').textContent = `画布 ${psd.width} × ${psd.height}`;
  resetHistory();
  renderLayerPanel();
  engine.resize();
  engine.fit();
  updateStatus();
  addRecent({
    name: meta.name || '未命名.psd',
    path: meta.path || null,
    w: psd.width,
    h: psd.height,
  });
  // PSD 只是导入，还没有对应的 .lbsh 工程文件
  currentProjectPath = null;
  currentProjectName = (meta.name || '未命名').replace(/\.[^.]+$/, '') + '.' + PROJECT_EXT;
  dirty = true;
  setAutosaveStatus('未保存');
  hideHome();
}

function openPSDFile(file, path = null) {
  file.arrayBuffer().then(buf => {
    try {
      const psd = readPSD(buf);
      loadDocumentFromPSD(psd, { name: file.name, path });
    } catch (err) {
      alert('PSD 读取失败：' + err.message);
    }
  });
}

// 桌面端走原生打开对话框（能拿到真实路径，最近文件可一键重开）；Web 预览回退到 file input
async function openPSDDialog() {
  if (TAURI && TAURI.dialog && TAURI.fs) {
    try {
      const path = await TAURI.dialog.open({
        multiple: false,
        filters: [{ name: 'Photoshop 文档', extensions: ['psd'] }],
      });
      if (!path) return;
      const bytes = await TAURI.fs.readFile(path);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const psd = readPSD(buf);
      const name = path.split(/[\\/]/).pop();
      loadDocumentFromPSD(psd, { name, path });
    } catch (err) {
      alert('PSD 读取失败：' + err.message);
    }
    return;
  }
  document.getElementById('file-open').click();
}

document.getElementById('btn-open').addEventListener('click', openPSDDialog);
document.getElementById('file-open').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) openPSDFile(f);
  e.target.value = '';
});

// 拖拽文件到窗口：.psd 打开文档，.abr 导入笔刷
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) {
    if (/\.lbsh$/i.test(f.name)) { f.arrayBuffer().then(b => openProjectFromBytes(new Uint8Array(b), f.name)); return; }
    if (/\.psd$/i.test(f.name)) { openPSDFile(f); return; }
    if (/\.abr$/i.test(f.name)) { importABRFile(f); return; }
  }
});

// Tauri 桌面壳：HTML5 drop 被原生窗口接管时走 tauri 事件读真实文件路径
if (TAURI && TAURI.event) {
  TAURI.event.listen('tauri://drag-drop', async (ev) => {
    const paths = (ev.payload && ev.payload.paths) || [];
    for (const p of paths) {
      if (!/\.(psd|abr|lbsh)$/i.test(p)) continue;
      try {
        const bytes = await TAURI.fs.readFile(p);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (/\.lbsh$/i.test(p)) {
          await openProjectFromBytes(new Uint8Array(buf), p.split(/[\\/]/).pop(), p);
        } else if (/\.psd$/i.test(p)) {
          const psd = readPSD(buf);
          const name = p.split(/[\\/]/).pop();
          loadDocumentFromPSD(psd, { name, path: p });
        } else {
          importABRBuffer(buf);
        }
        return;
      } catch (err) {
        alert('文件读取失败：' + err.message);
      }
    }
  });
}

async function doExportPSD() {
  try {
    // 合成图像（无棋盘格）
    const t = document.createElement('canvas');
    t.width = layers.w;
    t.height = layers.h;
    const tc = t.getContext('2d');
    layers.composite(tc, { checkerboard: false });
    const bytes = writePSD({
      width: layers.w,
      height: layers.h,
      nodes: layers.layers,
      compositeImage: tc.getImageData(0, 0, layers.w, layers.h),
    });
    await saveBytes(bytes, 'luobishenghua.psd', 'Photoshop 文档', ['psd']);
  } catch (err) {
    alert('PSD 导出失败：' + err.message);
  }
}
document.getElementById('btn-save-psd').addEventListener('click', doExportPSD);

/* ---------------- 新建文档 / 缩放 ---------------- */

let untitledCount = 0;

function newDocument(w, h) {
  layers.reset(w, h);
  const paper = layers._create('纸张');
  paper.locked = true;
  paper.ctx.fillStyle = '#ffffff';
  paper.ctx.fillRect(0, 0, w, h);
  layers.layers.push(paper);
  const l1 = layers._create('图层 1');
  layers.layers.push(l1);
  layers.activeId = l1.id;
  engine.setDocSize(w, h);
  document.getElementById('status-doc').textContent = `画布 ${w} × ${h}`;
  resetHistory();
  renderLayerPanel();
  engine.resize();
  engine.fit();
  updateStatus();
  currentProjectPath = null;
  currentProjectName = `未命名 ${untitledCount}.${PROJECT_EXT}`;
  dirty = false;
  setAutosaveStatus('未修改');
  addRecent({ name: currentProjectName, w, h });
  hideHome();
}

function zoomCenter(factor) {
  engine.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
  updateStatus();
}

/* ---------------- 首页 ---------------- */

homeApi = createHome({
  hasDocument: () => true,
  onCreateDoc: (w, h) => newDocument(w, h),
  onNewDialog: () => newDocDialog(settings, (w, h) => newDocument(w, h)),
  onOpenPSD: () => openPSDDialog(),
  onImportABR: () => document.getElementById('file-abr').click(),
  onOpenRecent: async (r) => {
    if (r.path && TAURI && TAURI.fs) {
      try {
        const bytes = await TAURI.fs.readFile(r.path);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        loadDocumentFromPSD(readPSD(buf), { name: r.name, path: r.path });
      } catch (err) {
        toast('无法打开：' + err.message + '（文件可能已移动）');
      }
    } else {
      toast('浏览器预览无法直接重开本地文件，请用「打开 PSD」重新选择');
    }
  },
  onClose: () => hideHome(),
});

document.getElementById('btn-home').addEventListener('click', () => {
  if (homeApi) homeApi.show();
});

/* ---------------- 菜单栏 ---------------- */

initMenuBar({
  about: aboutDialog,
  home: () => homeApi && homeApi.show(),
  newDoc: () => newDocDialog(settings, (w, h) => newDocument(w, h)),
  openProject: () => openProjectDialog(),
  saveProject: () => saveProject(),
  saveAsProject: () => saveProject({ saveAs: true }),
  openPSD: () => openPSDDialog(),
  exportPNG: doExportPNG,
  exportPSD: doExportPSD,
  importABR: () => document.getElementById('file-abr').click(),
  undo: () => { history.undo(); refreshThumbs(); updateStatus(); },
  redo: () => { history.redo(); refreshThumbs(); updateStatus(); },
  clearLayer: clearActiveLayer,
  layerNew: () => document.getElementById('btn-layer-add').click(),
  layerGroup: () => document.getElementById('btn-layer-group').click(),
  layerDelete: () => document.getElementById('btn-layer-del').click(),
  layerUp: () => document.getElementById('btn-layer-up').click(),
  layerDown: () => document.getElementById('btn-layer-down').click(),
  layerMoveIn: () => layerOp('移入组', () => layers.moveActiveIntoNearestGroup()),
  layerMoveOut: () => layerOp('移出组', () => layers.moveActiveOutOfGroup()),
  layerMask: () => document.getElementById('btn-layer-mask').click(),
  layerMaskDelete: () => layerOp('删除蒙版', () => layers.deleteMask()),
  layerMaskInvert: () => layerOp('反相蒙版', () => layers.invertMask()),
  layerClip: () => document.getElementById('btn-layer-clip').click(),
  layerMerge: () => document.getElementById('btn-layer-merge').click(),
  layerMergeVisible: () => layerOp('合并可见', () => !!layers.mergeVisible()),
  layerStamp: () => { history.pushFull('盖印图层'); layers.stampVisible(); engine.render(); updateStatus(); },
  layerFlatten: () => layerOp('拼合图像', () => !!layers.flatten()),
  layerLockAlpha: () => document.getElementById('btn-layer-lockalpha').click(),
  zoomIn: () => zoomCenter(1.25),
  zoomOut: () => zoomCenter(0.8),
  resetView: () => { engine.fit(); updateStatus(); },
  rotateLeft: () => { engine.rotateBy(-Math.PI / 12); updateStatus(); },
  rotateRight: () => { engine.rotateBy(Math.PI / 12); updateStatus(); },
  resetLayout: () => dock.resetLayout(),
  panelList: () => dock.panelInfo(),
  togglePanel: (id) => dock.togglePanel(id),
  settings: () => settingsDialog(settings, (s) => {
    Object.assign(settings, s);
    history.limit = settings.undoLimit;
    saveSettings();
    scheduleAutosave();
  }),
  shortcuts: shortcutsDialog,
});
document.getElementById('btn-rotate-left').addEventListener('click', () => { engine.rotateBy(-Math.PI / 12); updateStatus(); });
document.getElementById('btn-rotate-right').addEventListener('click', () => { engine.rotateBy(Math.PI / 12); updateStatus(); });
document.getElementById('btn-reset-view').addEventListener('click', () => { engine.fit(); updateStatus(); });

/* ---------------- 笔画管线 ---------------- */

function activeBrushType() {
  return state.tool === 'eraser' ? 'eraser' : state.brush;
}

function activeCtx() {
  return layers.active ? layers.active.ctx : engine.dctx;
}

function getPressure(e) {
  if (e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
  return 0.5;
}

function stampAt(x, y, pressure) {
  const l = layers.active;
  if (!l) return;
  if (l.type !== 'layer' && !(state.editMask && l.mask)) return;
  const type = activeBrushType();
  const preset = BrushRegistry.get(type);
  const size = pressureSize(type, state.size, pressure);
  const alpha = pressureAlpha(type, state.opacity, pressure);
  // 落笔前先为将被覆盖的瓦片保存 before 像素（增量撤销）
  if (state.journal) state.journal.captureBefore(x, y, size / 2 + 2);

  // 编辑蒙版：用亮度当蒙版值（白=显示，黑=隐藏）
  if (state.editMask && l.mask) {
    const lum = state.tool === 'eraser' ? 0 : luminance(state.color);
    const stamp = getStamp(type === 'eraser' ? 'hard' : type, '#ffffff');
    layers.paintMaskDab(l, x, y, size, lum, stamp);
    return;
  }

  drawDab(l.ctx, type, state.color, x, y, size, alpha, preset.jitter || 0);
}

function beginStroke(e) {
  const l = layers.active;
  if (!l || !l.visible) return false;
  const target = (state.editMask && l.mask) ? 'mask' : 'layer';
  if (target === 'layer') {
    if (l.type !== 'layer' || l.locked) return false;        // 组/锁定图层不画
  }
  state.journal = history.beginStroke(l.id, target);
  state.strokeTarget = target;
  // 锁定透明像素：只在已有像素范围内绘制
  if (target === 'layer' && l.lockAlpha) {
    l.ctx.save();
    l.ctx.globalCompositeOperation = 'source-atop';
  }
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  const pressure = getPressure(e);
  state.last = { ...p, pressure };
  state.smoothPoint = { x: p.x, y: p.y };
  state.spacingLeft = 0;
  stampAt(p.x, p.y, pressure);
  engine.render();
  return true;
}

function continueStroke(e) {
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const preset = BrushRegistry.get(activeBrushType());
  for (const ev of events) {
    const raw = engine.screenToWorld(ev.offsetX, ev.offsetY);
    let p = raw;
    // 防抖：对指针位置做指数平滑，数值越大越稳（略滞后）
    if (state.smoothing > 0.001 && state.smoothPoint) {
      const a = 1 - state.smoothing * 0.88;   // 0 → 1（无平滑），1 → 0.12（强平滑）
      state.smoothPoint.x += (raw.x - state.smoothPoint.x) * a;
      state.smoothPoint.y += (raw.y - state.smoothPoint.y) * a;
      p = { x: state.smoothPoint.x, y: state.smoothPoint.y };
    }
    const pressure = getPressure(ev);
    const last = state.last;

    let dx = p.x - last.x;
    let dy = p.y - last.y;
    let dist = Math.hypot(dx, dy);
    const curSize = pressureSize(activeBrushType(), state.size, pressure);
    const spacing = Math.max(0.4, curSize * preset.spacingRatio);

    while (state.spacingLeft + dist >= spacing) {
      const t = (spacing - state.spacingLeft) / dist;
      const ix = last.x + dx * t;
      const iy = last.y + dy * t;
      const ip = last.pressure + (pressure - last.pressure) * t;
      stampAt(ix, iy, ip);
      dx = p.x - ix;
      dy = p.y - iy;
      dist = Math.hypot(dx, dy);
      state.spacingLeft = 0;
      last.x = ix;
      last.y = iy;
      last.pressure = ip;
      if (dist === 0) break;
    }
    state.spacingLeft += dist;
    state.last = { x: p.x, y: p.y, pressure };
    document.getElementById('status-pressure').textContent =
      `压感: ${Math.round(pressure * 100)}%` + (ev.pointerType === 'pen' ? ' (数位笔)' : ' (鼠标/触控板)');
  }
  engine.render();
}

/* ---------------- 指针事件 ---------------- */

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (state.spaceDown || state.tool === 'hand' || e.button === 1) {
    state.panning = true;
    state.panLast = { x: e.clientX, y: e.clientY };
    return;
  }
  if (e.button !== 0) return;
  state.drawing = beginStroke(e);
  updateStatus();
});

canvas.addEventListener('pointermove', (e) => {
  if (state.panning) {
    engine.panBy(e.clientX - state.panLast.x, e.clientY - state.panLast.y);
    state.panLast = { x: e.clientX, y: e.clientY };
    updateStatus();
    return;
  }
  if (state.drawing) continueStroke(e);
});

function endPointer() {
  if (state.panning) state.panning = false;
  if (state.drawing) {
    state.drawing = false;
    state.last = null;
    state.smoothPoint = null;
    const act = layers.active;
    if (act && act.type === 'layer' && state.strokeTarget === 'layer' && act.lockAlpha) {
      act.ctx.restore();  // 解除 source-atop
      act.ctx.globalCompositeOperation = 'source-over';
    }
    if (state.journal) {
      const toolName = state.tool === 'eraser' ? '橡皮擦' : (BrushRegistry.get(state.brush)?.name || '画笔');
      const where = state.strokeTarget === 'mask' ? '蒙版' : toolName;
      history.commitStroke(state.journal, `${where} ${state.size}px`);
      state.journal = null;
    }
    refreshThumbs();
    updateStatus();
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    engine.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.06 : 0.94);
  } else {
    engine.panBy(-e.deltaX, -e.deltaY);
  }
  updateStatus();
}, { passive: false });

/* ---------------- 键盘 ---------------- */

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  // 首页显示时不响应绘画快捷键
  if (homeApi && homeApi.visible) return;
  if (e.code === 'Space') {
    state.spaceDown = true;
    canvas.classList.add('panning');
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) history.redo(); else history.undo();
    refreshThumbs();
    updateStatus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newDocDialog(settings, newDocument);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openProjectDialog();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveProject({ saveAs: e.shiftKey });
    return;
  }
  if (e.key === '[') { sizeInput.value = Math.max(1, +sizeInput.value - 4); sizeInput.dispatchEvent(new Event('input')); }
  if (e.key === ']') { sizeInput.value = Math.min(200, +sizeInput.value + 4); sizeInput.dispatchEvent(new Event('input')); }
  if (e.key === '0') { engine.fit(); updateStatus(); }
  if (e.key.toLowerCase() === 'e') setTool('eraser');
  if (e.key.toLowerCase() === 'b') setTool('brush');
  if (e.key.toLowerCase() === 'h') setTool('hand');
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    state.spaceDown = false;
    if (state.tool !== 'hand') canvas.classList.remove('panning');
  }
});

/* ---------------- 启动 ---------------- */

window.addEventListener('resize', () => engine.resize());
renderLayerPanel();
engine.resize();
engine.fit();
refreshOptionsBarTool();
updateStatus();
refreshHistoryPanel();
scheduleAutosave();
checkRecovery();
setAutosaveStatus('未修改');
// 启动先进首页（显示最近文件 / 新建 / 预设）；?nohome=1 可跳过（用于截图/调试）
if (!/[?&]nohome=1/.test(location.search)) homeApi.show();

/* ---------------- 调试/自动化钩子（不影响正常使用） ---------------- */
window.__lbsh = {
  engine, layers, history,
  doAutosave,
  saveProject,
  openProjectFromBytes,
  get dirty() { return dirty; },
  get projectName() { return currentProjectName; },
};
