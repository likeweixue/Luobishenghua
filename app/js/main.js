// 主程序：面板系统 + 图层系统 + 笔画管线（压感采样 → 印章铺排）
// DeepSeek 自 beta12 起参与落笔生花的界面、面板交互、WebGL2 合成与测试（2026）。
import { Engine } from './engine.js';
import { History } from './history.js';
import { BrushPresets, BrushRegistry, registerCustomBrush, brushThumbnail, pressureSize, pressureAlpha, drawDab, getStamp } from './brushes.js';
import { readABR } from './abr.js';
import { initMenuBar, aboutDialog, shortcutsDialog, settingsDialog, newDocDialog, showMenuAt } from './menu.js';
import { icon } from './icons.js';
import { openColorPicker, normalizeHex } from './colorpicker.js';
import { Rulers } from './rulers.js';
import { createHome, addRecent, toast } from './home.js';
import { serializeProject, deserializeProject, PROJECT_EXT } from './project.js';
import { idbPut, idbGet, idbDelete } from './idb.js';
import { Selection } from './selection.js';
import { Transform } from './transform.js';
import { Dynamics, CurveEditor } from './dynamics.js';
import { floodFill, drawGradient, Smudge, pickColor } from './paint.js';

/* ---------------- 设置（localStorage 持久化） ---------------- */

const settings = Object.assign(
  {
    undoLimit: 50, defaultWidth: 1600, defaultHeight: 1600, autosaveSec: 60,
    gpu: true,               // WebGL2 合成（结构不支持时自动回退）
    dynamics: null,          // 压感曲线 + 倾斜 / 间距 / 散布
  },
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

// Tauri 桌面端标记：macOS 使用覆盖式标题栏，给窗口红绿灯留出空间
if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
  document.body.classList.add('tauri');
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) document.body.classList.add('tauri-mac');
}

const canvas = document.getElementById('canvas');
const stage = document.getElementById('stage');
const engine = new Engine(canvas, 1600, 1600, document.getElementById('glcanvas'));
const layers = new LayerStack(1600, 1600);
engine.layers = layers;
engine.gpuEnabled = settings.gpu !== false;
engine.onGpuChange = () => updateStatus();
const history = new History(engine, layers, settings.undoLimit);
const dock = new Dock(document.getElementById('dock-root'), stage);
const navigatorPanel = new Navigator(document.getElementById('navigator'), engine, stage);
const rulers = new Rulers(engine, document.getElementById('canvas-area'), document.getElementById('ruler-h'), document.getElementById('ruler-v'));
const selection = new Selection(1600, 1600);
engine.selection = selection;
const transform = new Transform(engine, layers, history, selection);

const state = {
  tool: 'brush',          // brush | eraser | hand
  brush: 'hard',          // 当前画笔预设（橡皮是独立工具）
  color: '#222222',
  bgColor: '#ffffff',
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
  clipboard: null,        // 内部剪贴板 { canvas, x, y }
  selDrag: null,          // 选区拖拽状态
  polyPoints: null,       // 多边形套索顶点
  transforming: false,
  strokeTarget: 'layer',
  // N5 新增工具
  smudgeSession: null,     // 涂抹采样缓冲
  smudgeStrength: 0.55,
  fillTolerance: 32,
  fillContiguous: true,
  gradType: 'linear',
  gradReverse: false,
  gradDrag: null,          // 渐变拖拽 { x0,y0,x1,y1 }
  pickMode: 'all',         // 吸管取样：all | layer
  altPick: false,          // 按住 Alt 临时吸管
  tilt: 0,
};

// 恢复上次的笔刷动态设置
if (settings.dynamics) Dynamics.load(settings.dynamics);
else Dynamics.rebuild();

/* ---------------- 工程状态 ---------------- */

const AUTOSAVE_KEY = 'autosave';
let currentProjectPath = null;
let currentProjectName = '未命名-1.lbsh';
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

const TOOL_META = {
  brush: { icon: 'brush', name: '画笔' },
  eraser: { icon: 'eraser', name: '橡皮擦' },
  move: { icon: 'move', name: '移动' },
  rect: { icon: 'marquee', name: '矩形选框' },
  ellipse: { icon: 'ellipse', name: '椭圆选框' },
  lasso: { icon: 'lasso', name: '套索' },
  poly: { icon: 'poly', name: '多边形套索' },
  smudge: { icon: 'smudge', name: '涂抹' },
  bucket: { icon: 'bucket', name: '油漆桶' },
  gradient: { icon: 'gradient', name: '渐变' },
  eyedropper: { icon: 'eyedropper', name: '吸管' },
  hand: { icon: 'hand', name: '抓手' },
  zoom: { icon: 'zoom', name: '缩放' },
};

const TOOL_GROUPS = {
  marquee: ['rect', 'ellipse'],
  lasso: ['lasso', 'poly'],
  brush: ['brush', 'eraser', 'smudge'],
  fill: ['bucket', 'gradient', 'eyedropper'],
};
const TOOL_KEYS = { brush: 'B', eraser: 'E', smudge: 'S', move: 'V', rect: 'M', ellipse: '⇧M', lasso: 'L', poly: '⇧L', bucket: 'G', gradient: '⇧G', eyedropper: 'I', hand: 'H', zoom: 'Z' };

// 需要「粗细 / 不透明度 / 防抖」的工具
const BRUSHISH = ['brush', 'eraser', 'smudge'];

const SELECT_TOOLS = ['rect', 'ellipse', 'lasso', 'poly'];
function isSelectTool(t) { return SELECT_TOOLS.includes(t); }

function refreshOptionsBarTool() {
  const name = document.getElementById('opt-tool-name');
  const use = document.getElementById('opt-tool-use');
  if (!name) return;
  const meta = TOOL_META[state.tool] || TOOL_META.brush;
  if (use) use.setAttribute('href', '#i-' + meta.icon);
  if (state.tool === 'brush') {
    const b = BrushRegistry.get(state.brush);
    name.textContent = '画笔' + (b && b.custom ? ' · ' + b.name : '');
  } else if (state.tool === 'eraser') {
    name.textContent = '橡皮擦';
  } else {
    name.textContent = meta.name;
  }
}

function updateOptionsBar() {
  const brushish = BRUSHISH.includes(state.tool);
  const tr = transform.active;
  const selish = !tr && (isSelectTool(state.tool) || selection.active);
  document.getElementById('opt-brush-group').classList.toggle('hidden', !brushish);
  document.getElementById('opt-smudge-group').classList.toggle('hidden', state.tool !== 'smudge');
  document.getElementById('opt-bucket-group').classList.toggle('hidden', state.tool !== 'bucket');
  document.getElementById('opt-gradient-group').classList.toggle('hidden', state.tool !== 'gradient');
  document.getElementById('opt-pick-group').classList.toggle('hidden', state.tool !== 'eyedropper');
  document.getElementById('opt-transform-group').classList.toggle('hidden', !tr);
  document.getElementById('opt-select-group').classList.toggle('hidden', !selish);
  document.getElementById('opt-zoom-group').classList.toggle('hidden', state.tool !== 'zoom');
  document.getElementById('btn-sel-none').disabled = !selection.active;
  document.getElementById('btn-sel-invert').disabled = !selection.active;
  document.getElementById('btn-sel-feather').disabled = !selection.active;
  refreshOptionsBarTool();
}

function cancelPoly() {
  state.polyPoints = null;
  engine.previewPath = null;
  engine.render();
}

function setTool(tool) {
  if (state.polyPoints && tool !== 'poly') cancelPoly();
  if (transform.active && tool !== 'move') {
    // 切换工具时先提交变换，避免浮动内容悬空
    transform.commit();
  }
  state.tool = tool;
  state.editMask = false;
  toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.classList.toggle('panning', tool === 'hand');
  canvas.classList.toggle('moving', tool === 'move');
  canvas.classList.toggle('zooming', tool === 'zoom');
  updateOptionsBar();
  updateStatus();
  renderBrushPreview();
}
toolBtns.forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
toolBtns.forEach(b => b.addEventListener('contextmenu', (e) => {
  const group = b.dataset.group;
  if (!group || !TOOL_GROUPS[group]) return;
  e.preventDefault();
  showMenuAt(b, TOOL_GROUPS[group].map(t => ({
    label: TOOL_META[t].name,
    shortcut: TOOL_KEYS[t],
    icon: TOOL_META[t].icon,
    checked: state.tool === t,
    action: () => setTool(t),
  })), { align: 'left' });
}));

/* ---------------- 笔刷仓库 ---------------- */

const presetsEl = document.getElementById('brush-presets');
const brushPreview = document.getElementById('brush-preview');

function renderBrushPreview() {
  if (!brushPreview) return;
  const ctx = brushPreview.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, brushPreview.width, brushPreview.height);
  const id = state.tool === 'eraser' ? 'eraser' : state.brush;
  const brush = BrushRegistry.get(id) || BrushRegistry.get('hard');
  if (!brush) return;
  const t = brushThumbnail(brush, brushPreview.width, brushPreview.height, state.color);
  ctx.drawImage(t, 0, 0);
}

function renderBrushGrid() {
  presetsEl.innerHTML = '';
  for (const [id, brush] of BrushRegistry) {
    if (id === 'eraser') continue; // 橡皮是独立工具
    const btn = document.createElement('button');
    btn.dataset.brush = id;
    btn.title = brush.custom ? `${brush.name}（${brush.diameter}px 笔尖）` : brush.name;
    btn.appendChild(brushThumbnail(brush));
    const label = document.createElement('span');
    label.textContent = brush.name;
    btn.appendChild(label);
    if (id === state.brush) btn.classList.add('active');
    btn.addEventListener('click', () => setBrush(id));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      dock.openPanel('dynamics', { anchor: btn });
    });
    presetsEl.appendChild(btn);
  }
  renderBrushPreview();
  dock.reflowBoth();
}
renderBrushGrid();

function toggleBrushAux(id, anchor) {
  // 画笔预设与画笔设置都属于辅助浮层：打开一个时收起另一个，避免叠在一起
  const other = id === 'brushes' ? 'dynamics' : 'brushes';
  if (!dock.isVisible(id) && dock.isVisible(other)) dock.closePanel(other);
  dock.togglePanel(id, { anchor });
}

document.getElementById('btn-brush-preset').addEventListener('click', (e) => {
  toggleBrushAux('brushes', e.currentTarget);
});
document.getElementById('btn-brush-settings').addEventListener('click', (e) => {
  toggleBrushAux('dynamics', e.currentTarget);
});

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
const bgChip = document.getElementById('color-bg-chip');
const panelFgChip = document.getElementById('panel-fg-chip');
const colorHexInput = document.getElementById('color-hex');
const colorRgbLabel = document.getElementById('color-rgb');
const statusColorEl = document.getElementById('status-color');

function applyColor(hex, opts = {}) {
  const norm = normalizeHex(hex) || '#000000';
  state.color = norm;
  if (colorChip) colorChip.style.background = norm;
  if (panelFgChip) panelFgChip.style.background = norm;
  if (!opts.noWheel) wheel.setHex(norm);
  if (!opts.noInput && colorHexInput && document.activeElement !== colorHexInput) {
    colorHexInput.value = norm.toUpperCase();
  }
  if (colorRgbLabel) {
    const v = norm.replace('#', '');
    colorRgbLabel.textContent = `${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}`;
  }
  if (statusColorEl) statusColorEl.textContent = `前景 ${norm.toUpperCase()}`;
  renderBrushPreview();
  return norm;
}

function applyBgColor(hex) {
  const norm = normalizeHex(hex) || '#ffffff';
  state.bgColor = norm;
  if (bgChip) bgChip.style.background = norm;
  return norm;
}

const wheel = new ColorWheel(document.getElementById('color-wheel'), (hex) => {
  applyColor(hex, { noWheel: true });
});
wheel.setHex(state.color);

const swatchesEl = document.getElementById('swatches');
const DEFAULT_SWATCHES = ['#222222', '#e24b4a', '#ef9f27', '#f7d154', '#378add', '#1d9e75', '#7f77dd', '#8b5e3c', '#ffffff', '#888888'];
let swatchColors = (() => {
  try {
    const arr = JSON.parse(localStorage.getItem('lbsh-swatches') || 'null');
    if (Array.isArray(arr) && arr.length) return arr.map(normalizeHex).filter(Boolean);
  } catch { /* ignore */ }
  return DEFAULT_SWATCHES.slice();
})();

function saveSwatches() {
  try { localStorage.setItem('lbsh-swatches', JSON.stringify(swatchColors)); } catch { /* ignore */ }
}

function renderSwatches() {
  if (!swatchesEl) return;
  swatchesEl.innerHTML = '';
  for (const c of swatchColors) {
    const el = document.createElement('div');
    el.className = 'swatch';
    el.style.background = c;
    el.title = c.toUpperCase() + '（右键删除）';
    el.addEventListener('click', () => applyColor(c));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      swatchColors = swatchColors.filter(x => x !== c);
      if (!swatchColors.length) swatchColors = DEFAULT_SWATCHES.slice();
      saveSwatches();
      renderSwatches();
    });
    swatchesEl.appendChild(el);
  }
}

function addSwatch(c) {
  const norm = normalizeHex(c);
  if (!norm) return;
  if (!swatchColors.includes(norm)) swatchColors.push(norm);
  saveSwatches();
  renderSwatches();
}

colorHexInput?.addEventListener('input', () => {
  const h = normalizeHex(colorHexInput.value);
  if (h) applyColor(h, { noInput: true });
});
colorHexInput?.addEventListener('blur', () => {
  if (colorHexInput) colorHexInput.value = state.color.toUpperCase();
});
colorHexInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); colorHexInput.blur(); }
});

document.getElementById('btn-color-fg').addEventListener('click', () => {
  openColorPicker(state.color, {
    title: '拾色器（前景色）',
    onPreview: (h) => applyColor(h),
    onCommit: (h) => applyColor(h),
  });
});
document.getElementById('btn-color-bg').addEventListener('click', () => {
  openColorPicker(state.bgColor, {
    title: '拾色器（背景色）',
    onPreview: (h) => applyBgColor(h),
    onCommit: (h) => applyBgColor(h),
  });
});
document.getElementById('btn-swap-colors').addEventListener('click', () => {
  const fg = state.color;
  applyColor(state.bgColor);
  applyBgColor(fg);
});
document.getElementById('btn-default-colors').addEventListener('click', () => {
  applyColor('#000000');
  applyBgColor('#ffffff');
});
document.getElementById('swatch-add').addEventListener('click', () => addSwatch(state.color));

applyColor(state.color, { noWheel: false });
applyBgColor(state.bgColor);
renderSwatches();

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

/* ---------------- 笔刷动态面板 ---------------- */

const curveEditor = new CurveEditor(document.getElementById('curve-editor'));

function persistDynamics() {
  settings.dynamics = Dynamics.toJSON();
  saveSettings();
}

function syncDynamicsUI() {
  document.getElementById('dyn-tilt').checked = Dynamics.tiltEnabled;
  const sp = Math.round(Dynamics.spacingScale * 100);
  document.getElementById('dyn-spacing').value = sp;
  document.getElementById('dyn-spacing-val').textContent = sp + '%';
  const sc = Math.round(Dynamics.scatter * 100);
  document.getElementById('dyn-scatter').value = sc;
  document.getElementById('dyn-scatter-val').textContent = sc + '%';
  curveEditor.draw();
  // 曲线与预设一致时把下拉切过去，否则显示「自定义」
  const presetSel = document.getElementById('dyn-curve-preset');
  const name = matchCurvePreset();
  if (name) presetSel.value = name;
  else {
    if (!presetSel.querySelector('option[value=""]')) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '自定义';
      presetSel.appendChild(o);
    }
    presetSel.value = '';
  }
}

function matchCurvePreset() {
  const curves = {
    linear: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]],
    soft: [[0, 0], [0.25, 0.12], [0.5, 0.38], [0.75, 0.72], [1, 1]],
    hard: [[0, 0], [0.25, 0.42], [0.5, 0.68], [0.75, 0.87], [1, 1]],
    light: [[0, 0.15], [0.5, 0.6], [1, 1]],
  };
  const near = (a, b) => Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02;
  for (const [name, pts] of Object.entries(curves)) {
    if (pts.length !== Dynamics.points.length) continue;
    if (pts.every((p, i) => near(p, Dynamics.points[i]))) return name;
  }
  return null;
}

Dynamics.onChange = () => {
  persistDynamics();
  syncDynamicsUI();
};
syncDynamicsUI();

document.getElementById('dyn-curve-preset').addEventListener('change', (e) => {
  if (!e.target.value) return;
  Dynamics.setPreset(e.target.value);
});

document.getElementById('dyn-tilt').addEventListener('change', (e) => {
  Dynamics.tiltEnabled = e.target.checked;
  persistDynamics();
});

document.getElementById('dyn-spacing').addEventListener('input', (e) => {
  Dynamics.spacingScale = +e.target.value / 100;
  document.getElementById('dyn-spacing-val').textContent = e.target.value + '%';
  persistDynamics();
});

document.getElementById('dyn-scatter').addEventListener('input', (e) => {
  Dynamics.scatter = +e.target.value / 100;
  document.getElementById('dyn-scatter-val').textContent = e.target.value + '%';
  persistDynamics();
});

/* ---------------- 新工具参数 ---------------- */

document.getElementById('smudge-strength').addEventListener('input', (e) => {
  state.smudgeStrength = +e.target.value / 100;
  document.getElementById('smudge-strength-val').textContent = e.target.value + '%';
});

document.getElementById('fill-tolerance').addEventListener('input', (e) => {
  state.fillTolerance = +e.target.value;
  document.getElementById('fill-tolerance-val').textContent = e.target.value;
});

document.getElementById('fill-contiguous').addEventListener('change', (e) => {
  state.fillContiguous = e.target.checked;
});

document.getElementById('grad-type').addEventListener('change', (e) => {
  state.gradType = e.target.value;
});

document.getElementById('grad-reverse').addEventListener('change', (e) => {
  state.gradReverse = e.target.checked;
});

document.getElementById('pick-mode').addEventListener('change', (e) => {
  state.pickMode = e.target.value;
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
    eye.innerHTML = icon(l.visible ? 'eye' : 'eye-off');
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
      const folderIcon = document.createElement('span');
      folderIcon.className = 'licon';
      folderIcon.innerHTML = icon('folder');
      row.append(arrow, folderIcon);
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
      if (l.clipping) tags.insertAdjacentHTML('beforeend', `<span class="ltag clip" title="剪贴蒙版">${icon('clip')}</span>`);
      if (l.lockAlpha) tags.insertAdjacentHTML('beforeend', `<span class="ltag lock" title="锁定透明像素">${icon('alpha')}</span>`);
      if (l.locked) tags.insertAdjacentHTML('beforeend', `<span class="ltag lock" title="锁定">${icon('lock')}</span>`);
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
    if (!l || !l.surface) continue;
    const tc = thumb.getContext('2d');
    tc.clearRect(0, 0, 30, 24);
    tc.save();
    tc.scale(30 / layers.w, 24 / layers.h);
    l.surface.drawInto(tc);
    tc.restore();
  }
  for (const mthumb of layerListEl.querySelectorAll('canvas.mthumb[data-mask-id]')) {
    const l = layers.byId(+mthumb.dataset.maskId);
    if (!l || !l.mask) continue;
    const tc = mthumb.getContext('2d');
    const ms = l.mask.surface;
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, 22, 18);
    // 蒙版缩略图：白 = 显示（默认），被改过的瓦片铺黑底再叠白色蒙版值
    tc.fillStyle = '#ffffff';
    tc.fillRect(0, 0, 22, 18);
    tc.save();
    tc.scale(22 / layers.w, 18 / layers.h);
    for (const t of ms.tiles.values()) {
      const r = ms.tileRect(t.tx, t.ty);
      tc.fillStyle = '#111111';
      tc.fillRect(r.x, r.y, r.w, r.h);
      tc.drawImage(t.canvas, r.x, r.y);
    }
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
  document.getElementById('layer-opacity-val').textContent = Math.round(n.opacity * 100) + '%';

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
  mBtn.classList.toggle('on', !!n.mask);
  mBtn.classList.toggle('off', !!(n.mask && !n.mask.enabled));
  mBtn.title = !n.mask ? '添加蒙版' : (n.mask.enabled ? '停用蒙版' : '启用蒙版');

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
  updateStatus();
});
layerOpacityInput.addEventListener('pointerdown', () => history.pushFull('图层不透明度'));
layerOpacityInput.addEventListener('input', () => {
  layers.setOpacity(+layerOpacityInput.value / 100);
  document.getElementById('layer-opacity-val').textContent = layerOpacityInput.value + '%';
  engine.render();
});

layers.onChange = () => {
  engine.invalidateCompositeCaches();
  renderLayerPanel();
};

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
  if (!suppressDirty) {
    dirty = true;
    updateDocTab();
    setAutosaveStatus('未保存');
  }
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
  if (transform.active) transform.reset();
  selection.resize(project.width, project.height);
  layers.reset(project.width, project.height);
  layers.layers = layers.importNodes(project.nodes || []);
  const active = project.activePath ? layers.nodeAtPath(project.activePath) : null;
  const fallback = layers.leaves().slice(-1)[0];
  layers.activeId = (active || fallback)?.id || null;

  engine.setDocSize(project.width, project.height);
  setDocLabel(project.width, project.height);
  resetHistory();
  renderLayerPanel();
  engine.resize();
  engine.fit();
  updateStatus();

  currentProjectPath = meta.path || null;
  currentProjectName = meta.name || `未命名.${PROJECT_EXT}`;
  dirty = false;
  updateDocTab();
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
    updateDocTab();
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

function setDocLabel(w, h) {
  const el = document.getElementById('status-doc');
  if (el) el.textContent = `${w} × ${h} px`;
}

function updateDocTab() {
  const tab = document.getElementById('doc-tab');
  const nameEl = document.getElementById('doc-tab-name');
  if (!tab || !nameEl) return;
  const base = (currentProjectName || '未命名.lbsh').replace(/\.lbsh$/i, '');
  nameEl.textContent = base;
  tab.classList.toggle('modified', dirty);
  tab.title = (currentProjectName || '未命名.lbsh') + (dirty ? ' — 有未保存的修改' : '');
  document.title = `${base}${dirty ? ' •' : ''} — 落笔生花`;
}

function updateStatus() {
  const name = state.tool === 'brush'
    ? (BrushRegistry.get(state.brush)?.name || '画笔')
    : (TOOL_META[state.tool]?.name || '画笔');
  const selInfo = selection.active && selection.bounds
    ? ` · 选区 ${selection.bounds.w}×${selection.bounds.h}`
    : '';
  document.getElementById('status-brush').textContent =
    `${name} · ${state.size}px · ${layers.active ? layers.active.name : ''}${selInfo}`;

  const memEl = document.getElementById('status-memory');
  if (memEl) {
    memEl.textContent = `${fmtBytes(layers.pixelBytes())} · ${layers.tileCount()} 瓦片`;
  }
  document.getElementById('btn-undo').disabled = !history.canUndo;
  document.getElementById('btn-redo').disabled = !history.canRedo;
  document.getElementById('zoom-label').textContent = Math.round(engine.view.scale * 100) + '%';
  const gpuEl = document.getElementById('status-gpu');
  if (gpuEl) {
    const active = engine.gpuActive();
    gpuEl.textContent = active ? 'GPU' : 'CPU';
    gpuEl.classList.toggle('on', active);
    gpuEl.title = active
      ? ('WebGL2 合成' + (engine.gpu && engine.gpu.lastInfo ? ' · ' + engine.gpu.lastInfo : ''))
      : (engine.gpu && engine.gpu.ok && engine.gpuEnabled
        ? '当前图层结构（剪贴蒙版 / 组嵌套过深 / 瓦片超限）已回退 Canvas2D'
        : (engine.gpu && !engine.gpu.ok ? '当前环境不支持 WebGL2，使用 Canvas2D' : 'Canvas2D 合成'));
  }
  updateDocTab();
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
  if (l.locked) l.surface.fill('#ffffff');
  else l.surface.clearAll();
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
  if (transform.active) transform.reset();
  selection.resize(psd.width, psd.height);
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
  setDocLabel(psd.width, psd.height);
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
  updateDocTab();
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
  if (transform.active) transform.reset();
  selection.resize(w, h);
  layers.reset(w, h);
  const paper = layers._create('纸张');
  paper.locked = true;
  paper.surface.fill('#ffffff');
  layers.layers.push(paper);
  const l1 = layers._create('图层 1');
  layers.layers.push(l1);
  layers.activeId = l1.id;
  engine.setDocSize(w, h);
  setDocLabel(w, h);
  resetHistory();
  renderLayerPanel();
  engine.resize();
  engine.fit();
  updateStatus();
  currentProjectPath = null;
  currentProjectName = `未命名-${++untitledCount}.${PROJECT_EXT}`;
  dirty = false;
  updateDocTab();
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

function zoom100() {
  const s = engine.view.scale;
  if (s > 0) engine.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / s);
  updateStatus();
}

function toolbarVisible() {
  return !document.body.classList.contains('toolbar-hidden');
}
function toggleToolbar() {
  document.body.classList.toggle('toolbar-hidden');
  engine.resize();
  updateStatus();
}
function togglePanels() {
  document.body.classList.toggle('panels-hidden');
  engine.resize();
}
function resetSwatches() {
  swatchColors = DEFAULT_SWATCHES.slice();
  saveSwatches();
  renderSwatches();
}

function gpuAvailable() {
  return !!(engine.gpu && engine.gpu.ok);
}
function gpuOn() {
  return !!(engine.gpuEnabled && gpuAvailable());
}
function toggleGpu() {
  if (!gpuAvailable()) {
    toast('当前环境不支持 WebGL2，继续使用 Canvas2D');
    return;
  }
  settings.gpu = !gpuOn();
  saveSettings();
  engine.setGpuEnabled(settings.gpu);
  updateStatus();
  toast(settings.gpu ? 'GPU 合成已开启' : 'GPU 合成已关闭，使用 Canvas2D');
}

function openPreferences() {
  settingsDialog(settings, (s) => {
    Object.assign(settings, s);
    history.limit = settings.undoLimit;
    saveSettings();
    scheduleAutosave();
  });
}

function panelMenuItems(id) {
  const click = (elId) => () => document.getElementById(elId)?.click();
  switch (id) {
    case 'color':
      return [
        { label: '复制十六进制', shortcut: state.color.toUpperCase(), icon: 'edit', action: () => {
          navigator.clipboard?.writeText(state.color.toUpperCase());
          toast('颜色已复制');
        } },
        { label: '拾色器…', icon: 'search', action: () => document.getElementById('btn-color-fg').click() },
        { sep: true },
        { label: '默认前景 / 背景色', icon: 'default-colors', action: () => document.getElementById('btn-default-colors').click() },
      ];
    case 'swatches':
      return [
        { label: '添加当前颜色', icon: 'plus', action: () => addSwatch(state.color) },
        { label: '恢复默认色板', icon: 'undo', action: resetSwatches },
      ];
    case 'layers':
      return [
        { label: '新建图层', icon: 'plus', action: click('btn-layer-add') },
        { label: '新建组', icon: 'folder-plus', action: click('btn-layer-group') },
        { sep: true },
        { label: '添加 / 启用蒙版', icon: 'mask', action: click('btn-layer-mask') },
        { label: '剪贴蒙版', icon: 'clip', action: click('btn-layer-clip') },
        { label: '锁定透明像素', icon: 'alpha', action: click('btn-layer-lockalpha') },
        { sep: true },
        { label: '向下合并', icon: 'merge', action: click('btn-layer-merge') },
        { label: '拼合图像', icon: 'layer-stack', action: () => layerOp('拼合图像', () => !!layers.flatten()) },
        { sep: true },
        { label: '删除图层', icon: 'trash', action: click('btn-layer-del') },
      ];
    case 'history':
      return [
        { label: '撤销', shortcut: '⌘Z', icon: 'undo', action: click('btn-hist-undo') },
        { label: '重做', shortcut: '⇧⌘Z', icon: 'redo', action: click('btn-hist-redo') },
        { sep: true },
        { label: '清除历史记录', icon: 'trash', action: () => {
          if (!confirm('清除全部历史记录？（不影响画面内容）')) return;
          resetHistory();
          refreshHistoryPanel();
          updateStatus();
        } },
      ];
    case 'navigator':
      return [
        { label: '适合屏幕', shortcut: '⌘0', icon: 'fit', action: () => { engine.fit(); updateStatus(); } },
        { label: '实际像素', shortcut: '⌘1', icon: 'search', action: zoom100 },
      ];
    case 'brushes':
      return [
        { label: '导入 .abr 笔刷…', icon: 'open', action: click('btn-import-abr') },
        { label: '画笔设置', icon: 'sliders', action: () => { dock.closePanel('brushes'); dock.openPanel('dynamics', { anchor: document.getElementById('btn-brush-settings') }); } },
        { sep: true },
        { label: '关闭面板', icon: 'close', action: () => dock.closePanel('brushes') },
      ];
    case 'dynamics':
      return [
        { label: '重置画笔动态', icon: 'undo', action: () => { Dynamics.rebuild(); syncDynamicsUI(); persistDynamics(); } },
        { label: '关闭面板', icon: 'close', action: () => dock.closePanel('dynamics') },
      ];
    default:
      return [];
  }
}

dock.onPanelMenu = (id, anchor) => showMenuAt(anchor, panelMenuItems(id), { align: 'left' });
dock.onLayout = () => engine.resize();

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
  clearLayer: () => clearSelectionContent(true),
  selectAll, deselect, invertSelection, featherSelection, freeTransform: startFreeTransform,
  copy: copySelection, cut: cutSelection, paste: pasteClipboard, fill: fillSelection,
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
  zoom100,
  rotateLeft: () => { engine.rotateBy(-Math.PI / 12); updateStatus(); },
  rotateRight: () => { engine.rotateBy(Math.PI / 12); updateStatus(); },
  toggleRulers: () => rulers.toggle(),
  rulersOn: () => rulers.enabled,
  toggleGpu,
  gpuOn,
  gpuAvailable,
  toggleToolbar,
  toolbarVisible,
  togglePanels,
  resetLayout: () => dock.resetLayout(),
  panelList: () => dock.panelInfo(),
  togglePanel: (id) => dock.togglePanel(id),
  settings: openPreferences,
  shortcuts: shortcutsDialog,
});
document.getElementById('btn-rotate-left').addEventListener('click', () => { engine.rotateBy(-Math.PI / 12); updateStatus(); });
document.getElementById('btn-rotate-right').addEventListener('click', () => { engine.rotateBy(Math.PI / 12); updateStatus(); });
document.getElementById('btn-reset-view').addEventListener('click', () => { engine.fit(); updateStatus(); });
document.getElementById('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
document.getElementById('btn-zoom-out').addEventListener('click', () => zoomCenter(0.8));
document.getElementById('btn-zoom-fit').addEventListener('click', () => { engine.fit(); updateStatus(); });
document.getElementById('btn-zoom-100').addEventListener('click', zoom100);
document.getElementById('zoom-label').addEventListener('dblclick', () => { engine.fit(); updateStatus(); });
document.getElementById('btn-settings').addEventListener('click', openPreferences);
document.getElementById('btn-shortcuts').addEventListener('click', shortcutsDialog);
document.getElementById('doc-new').addEventListener('click', () => newDocDialog(settings, (w, h) => newDocument(w, h)));
document.getElementById('doc-tab-close').addEventListener('click', () => {
  if (dirty && !confirm('文档有未保存的修改，仍要关闭吗？')) return;
  homeApi?.show();
});

/* ---------------- 笔画管线 ---------------- */

function activeBrushType() {
  return state.tool === 'eraser' ? 'eraser' : state.brush;
}


function getPressure(e) {
  const raw = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
  state.tilt = Dynamics.tiltFromEvent(e);
  // 数位笔走可调压感曲线；鼠标/触控板固定 50%，避免曲线把鼠标笔画改细
  return e.pointerType === 'pen' ? Dynamics.map(raw) : raw;
}

/* ---------------- 笔画渲染调度（脏矩形 + rAF 合并） ---------------- */

let dirtyRect = null;
let rafId = 0;

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bt = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bt - y };
}

function markDabDirty(x, y, size) {
  const pad = size / 2 + 4;
  const r = { x: x - pad, y: y - pad, w: pad * 2, h: pad * 2 };
  dirtyRect = dirtyRect ? unionRect(dirtyRect, r) : r;
}

function paintDirty() {
  const r = dirtyRect;
  dirtyRect = null;
  if (!r) return;
  // 脏区超过画布一半就整屏重绘（有上下层缓存，也不贵）
  if (r.w * r.h > layers.w * layers.h * 0.5) engine.render();
  else engine.renderDirty(r);
}

function scheduleStrokeRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    paintDirty();
  });
}

function flushStrokeRender() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  paintDirty();
}

// 有选区时：把笔尖画到固定大小的缓冲上，再用选区蒙版裁掉外部
const DAB_BUF = 256;
const dabBuf = document.createElement('canvas');
dabBuf.width = DAB_BUF;
dabBuf.height = DAB_BUF;

// 返回 { canvas, x, y }：canvas 是已按选区裁好的笔尖，x/y 是它在世界坐标里的中心
function buildMaskedDab(type, color, x, y, size, jitter) {
  const b = dabBuf.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'source-over';
  b.clearRect(0, 0, DAB_BUF, DAB_BUF);

  const stamp = getStamp(type, type === 'eraser' ? '#000000' : color);
  let dx = x, dy = y;
  if (jitter) {
    dx += (Math.random() - 0.5) * size * jitter;
    dy += (Math.random() - 0.5) * size * jitter;
  }
  b.drawImage(stamp, (DAB_BUF - size) / 2, (DAB_BUF - size) / 2, size, size);
  b.globalCompositeOperation = 'destination-in';
  b.drawImage(selection.mask,
    dx - DAB_BUF / 2, dy - DAB_BUF / 2, DAB_BUF, DAB_BUF,
    0, 0, DAB_BUF, DAB_BUF);
  b.globalCompositeOperation = 'source-over';
  return { canvas: dabBuf, x: dx, y: dy };
}

// 兼容旧调用名（测试里用过）
function maskedDab(ctx, type, color, x, y, size, alpha, jitter) {
  const d = buildMaskedDab(type, color, x, y, size, jitter);
  ctx.save();
  if (type === 'eraser') ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = alpha;
  ctx.drawImage(d.canvas, d.x - DAB_BUF / 2, d.y - DAB_BUF / 2, DAB_BUF, DAB_BUF);
  ctx.restore();
}

function stampAt(x, y, pressure) {
  const l = layers.active;
  if (!l) return;
  if (l.type !== 'layer' && !(state.editMask && l.mask)) return;
  const type = activeBrushType();
  const preset = BrushRegistry.get(type);
  const size = pressureSize(type, state.size, pressure) * Dynamics.tiltSizeFactor();
  const alpha = pressureAlpha(type, state.opacity, pressure);
  const scatter = (preset.jitter || 0) + Dynamics.scatter;
  markDabDirty(x, y, size);
  // 落笔前先为将被覆盖的瓦片保存 before 像素（增量撤销）
  if (state.journal) state.journal.captureBefore(x, y, size / 2 + 2);

  // 编辑蒙版：用亮度当蒙版值（白=显示，黑=隐藏）
  if (state.editMask && l.mask) {
    const lum = state.tool === 'eraser' ? 0 : luminance(state.color);
    const stamp = getStamp(type === 'eraser' ? 'hard' : type, '#ffffff');
    layers.paintMaskDab(l, x, y, size, lum, stamp);
    return;
  }

  const isEraser = type === 'eraser';
  const composite = isEraser ? 'destination-out' : (l.lockAlpha ? 'source-atop' : 'source-over');

  if (selection.active && l.type === 'layer') {
    const d = buildMaskedDab(type, state.color, x, y, size, scatter);
    l.surface.drawCanvas(d.canvas, d.x - DAB_BUF / 2, d.y - DAB_BUF / 2, { alpha, composite });
  } else {
    // 直接在世界坐标的瓦片上落章（surface.stamp 已把 ctx 平移好）
    l.surface.stamp(x, y, size / 2 + 1, (ctx) => {
      // 锁定透明像素：source-atop 只作用到已有像素上（橡皮不受影响）
      if (l.lockAlpha && !isEraser) ctx.globalCompositeOperation = 'source-atop';
      drawDab(ctx, type, state.color, x, y, size, alpha, scatter);
    });
  }
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
  // 锁定透明像素不再需要 save/source-atop：落章时按瓦片带合成模式绘制
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  const pressure = getPressure(e);
  state.last = { ...p, pressure };
  state.smoothPoint = { x: p.x, y: p.y };
  state.spacingLeft = 0;
  stampAt(p.x, p.y, pressure);
  scheduleStrokeRender();
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
    const curSize = pressureSize(activeBrushType(), state.size, pressure) * Dynamics.tiltSizeFactor();
    const spacing = Math.max(0.4, curSize * preset.spacingRatio * Dynamics.spacingScale);

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
  scheduleStrokeRender();
}

/* ---------------- 油漆桶 / 渐变 / 涂抹 / 吸管 ---------------- */

function selMask() {
  return selection.active ? selection.mask : null;
}

function setColor(hex) {
  applyColor(hex);
}

function doBucketFill(e) {
  if (transformGuard()) return;
  const l = targetLayer();
  if (!l) return;
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  const before = history.captureLayer(l.id);
  // 洪泛需要整层连通性：临时拼一张整层画布，填完再拆回瓦片（一次性开销）
  const tmp = l.surface.toCanvas();
  const res = floodFill(tmp, layers.w, layers.h, p.x, p.y, state.color, {
    tolerance: state.fillTolerance,
    contiguous: state.fillContiguous,
    mask: selMask(),
    alpha: state.opacity,
    lockAlpha: l.lockAlpha,
  });
  if (!res || res.count === 0) { toast('这个位置没有可填充的区域'); return; }
  l.surface.fromCanvas(tmp);
  history.pushLayerDiff(l.id, before, `油漆桶 ${res.count}px`);
  engine.render();
  refreshThumbs();
  updateStatus();
  toast(`填充 ${res.count.toLocaleString()} 像素`);
}

function startGradient(e) {
  if (transformGuard()) return;
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  state.gradDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  engine.gradientPreview = {
    ...state.gradDrag, type: state.gradType, color: state.color, reverse: state.gradReverse,
  };
  engine.renderViewOnly();
}

function moveGradient(e) {
  const d = state.gradDrag;
  if (!d) return;
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  if (e.shiftKey) {
    // Shift 约束到水平 / 垂直 / 45°
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    if (Math.abs(dx) > Math.abs(dy) * 2) { d.x1 = p.x; d.y1 = d.y0; }
    else if (Math.abs(dy) > Math.abs(dx) * 2) { d.x1 = d.x0; d.y1 = p.y; }
    else {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      d.x1 = d.x0 + Math.sign(dx || 1) * m;
      d.y1 = d.y0 + Math.sign(dy || 1) * m;
    }
  } else {
    d.x1 = p.x;
    d.y1 = p.y;
  }
  engine.gradientPreview = {
    ...d, type: state.gradType, color: state.color, reverse: state.gradReverse,
  };
  engine.renderViewOnly();
}

function finishGradient() {
  const d = state.gradDrag;
  state.gradDrag = null;
  engine.gradientPreview = null;
  if (!d) return;
  if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 2) {
    engine.render();
    toast('拖出一条线来定义渐变方向');
    return;
  }
  const l = targetLayer();
  if (!l) { engine.render(); return; }
  const before = history.captureLayer(l.id);
  const tmp = l.surface.toCanvas();
  drawGradient(tmp, layers.w, layers.h, {
    x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1,
    type: state.gradType,
    color: state.color,
    reverse: state.gradReverse,
    alpha: state.opacity,
    mask: selMask(),
    lockAlpha: l.lockAlpha,
  });
  l.surface.fromCanvas(tmp);
  history.pushLayerDiff(l.id, before, `${state.gradType === 'radial' ? '径向' : '线性'}渐变`);
  engine.render();
  refreshThumbs();
  updateStatus();
}

function beginSmudge(e) {
  const l = targetLayer();
  if (!l || !l.visible) return false;
  state.journal = history.beginStroke(l.id, 'layer');
  state.strokeTarget = 'layer';
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  state.smudgeSession = new Smudge();
  state.smudgeSession.begin(l, p.x, p.y, state.size, { mask: selMask() });
  state.last = { x: p.x, y: p.y, pressure: getPressure(e) };
  state.spacingLeft = 0;
  return true;
}

function stampSmudge(l, s, x, y) {
  const size = state.size;
  markDabDirty(x, y, size);
  if (state.journal) state.journal.captureBefore(x, y, size / 2 + 2);
  s.drag(l, x, y, size, state.smudgeStrength, {
    mask: selMask(),
    lockAlpha: l.lockAlpha,
  });
}

function continueSmudge(e) {
  const l = layers.active;
  const s = state.smudgeSession;
  if (!l || !s) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const p = engine.screenToWorld(ev.offsetX, ev.offsetY);
    const last = state.last;
    let dx = p.x - last.x;
    let dy = p.y - last.y;
    let dist = Math.hypot(dx, dy);
    const step = Math.max(1, state.size * 0.12);
    while (dist >= step) {
      const t = step / dist;
      const ix = last.x + dx * t;
      const iy = last.y + dy * t;
      stampSmudge(l, s, ix, iy);
      dx = p.x - ix;
      dy = p.y - iy;
      dist = Math.hypot(dx, dy);
      last.x = ix;
      last.y = iy;
    }
    state.last = { x: p.x, y: p.y, pressure: getPressure(ev) };
  }
  scheduleStrokeRender();
}

function pickAt(e) {
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  let hex = null;
  if (state.pickMode === 'layer') {
    const l = layers.active;
    if (l && l.type === 'layer') hex = l.surface.colorAt(p.x, p.y);
  } else {
    if (engine.gpuActive()) engine.syncDocNow();
    hex = pickColor(engine.doc, p.x, p.y);
  }
  if (!hex) return false;
  setColor(hex);
  return true;
}

/* ---------------- 指针事件 ---------------- */

/* ---------------- 选区 ---------------- */

function selMode(e) {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return 'replace';
}

function buildRectPath(a, b, square, fromCenter) {
  let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
  if (square) {
    const sx = Math.sign(x1 - x0) || 1;
    const sy = Math.sign(y1 - y0) || 1;
    const sz = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + sx * sz;
    y1 = y0 + sy * sz;
  }
  if (fromCenter) { x0 = 2 * a.x - x1; y0 = 2 * a.y - y1; }
  const p = new Path2D();
  p.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  return p;
}

function buildEllipsePath(a, b, square, fromCenter) {
  let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
  if (square) {
    const sx = Math.sign(x1 - x0) || 1;
    const sy = Math.sign(y1 - y0) || 1;
    const sz = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + sx * sz;
    y1 = y0 + sy * sz;
  }
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (fromCenter) { cx = a.x; cy = a.y; rx = Math.abs(x1 - x0); ry = Math.abs(y1 - y0); }
  const p = new Path2D();
  p.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
  return p;
}

function pointsPath(points, close) {
  const p = new Path2D();
  if (!points || points.length === 0) return p;
  p.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i].x, points[i].y);
  if (close) p.closePath();
  return p;
}

function updateSelPreview(path) {
  engine.previewPath = path;
  engine.render();
}

function onSelectionChanged() {
  engine.selection = selection;
  engine.render();
  updateOptionsBar();
  updateStatus();
}

function startSelection(e) {
  const p = engine.screenToWorld(e.offsetX, e.offsetY);

  if (state.tool === 'poly') {
    if (!state.polyPoints) {
      state.polyPoints = [];
      state.polyMode = selMode(e);
    }
    state.polyPoints.push(p);
    updatePolyPreview(p);
    return;
  }

  state.selDrag = {
    mode: selMode(e),
    start: p,
    last: p,
    points: state.tool === 'lasso' ? [p] : null,
    square: e.shiftKey,
    fromCenter: e.altKey,
  };
  if (state.tool === 'lasso') updateSelPreview(pointsPath([p], false));
  else if (state.tool === 'rect') updateSelPreview(buildRectPath(p, p, e.shiftKey, e.altKey));
  else updateSelPreview(buildEllipsePath(p, p, e.shiftKey, e.altKey));
}

function moveSelection(e) {
  const d = state.selDrag;
  if (!d) return;
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  d.last = p;
  if (state.tool === 'lasso') {
    const last = d.points[d.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5) d.points.push(p);
    updateSelPreview(pointsPath(d.points, false));
  } else if (state.tool === 'rect') {
    updateSelPreview(buildRectPath(d.start, p, e.shiftKey, e.altKey));
  } else if (state.tool === 'ellipse') {
    updateSelPreview(buildEllipsePath(d.start, p, e.shiftKey, e.altKey));
  }
}

function finishSelection(e) {
  const d = state.selDrag;
  if (!d) return;
  const p = d.last || engine.screenToWorld(e.offsetX, e.offsetY);
  let path;
  if (state.tool === 'lasso') path = pointsPath(d.points, true);
  else if (state.tool === 'rect') path = buildRectPath(d.start, p, d.square, d.fromCenter);
  else path = buildEllipsePath(d.start, p, d.square, d.fromCenter);

  state.selDrag = null;
  engine.previewPath = null;

  // 点击而不是拖拽：视为取消选择
  if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < 1.5) {
    selection.clear();
  } else {
    selection.setPath(path, d.mode);
  }
  onSelectionChanged();
}

function updatePolyPreview(cursor) {
  const pts = state.polyPoints;
  if (!pts || pts.length === 0) return;
  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  if (cursor) path.lineTo(cursor.x, cursor.y);
  engine.previewPath = path;
  engine.render();
}

function finishPoly() {
  const pts = state.polyPoints;
  if (!pts || pts.length < 3) { cancelPoly(); return; }
  const path = pointsPath(pts, true);
  const mode = state.polyMode || 'replace';
  state.polyPoints = null;
  engine.previewPath = null;
  selection.setPath(path, mode);
  onSelectionChanged();
}

function selectAll() {
  selection.selectAll();
  onSelectionChanged();
}

function deselect() {
  selection.clear();
  state.polyPoints = null;
  engine.previewPath = null;
  onSelectionChanged();
}

function invertSelection() {
  if (!selection.active) { toast('请先建立选区'); return; }
  selection.invert();
  onSelectionChanged();
}

function featherSelection() {
  if (!selection.active) { toast('请先建立选区'); return; }
  const v = prompt('羽化半径（像素）', '8');
  if (v === null) return;
  const px = Math.max(0, Math.min(200, +v || 0));
  if (px > 0) { selection.feather(px); onSelectionChanged(); }
}

/* ---------------- 编辑命令 ---------------- */

function targetLayer(needMessage = true) {
  const l = layers.active;
  if (!l || l.type !== 'layer') { if (needMessage) toast('请选择一个像素图层'); return null; }
  if (l.locked) { if (needMessage) toast('图层已锁定'); return null; }
  return l;
}

function selectionBounds() {
  return selection.active && selection.bounds
    ? selection.bounds
    : { x: 0, y: 0, w: layers.w, h: layers.h };
}

function transformGuard() {
  if (transform.active) { toast('请先应用或取消变换（Enter / Esc）'); return true; }
  return false;
}

function copySelection() {
  if (transformGuard()) return false;
  const l = layers.active;
  if (!l || l.type !== 'layer') { toast('请选择一个像素图层'); return false; }
  const b = selectionBounds();
  const c = l.surface.extract(b.x, b.y, b.w, b.h);
  const ctx = c.getContext('2d');
  if (selection.active) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(selection.mask, -b.x, -b.y);
    ctx.globalCompositeOperation = 'source-over';
  }
  state.clipboard = { canvas: c, x: b.x, y: b.y };
  toast(`已复制 ${b.w} × ${b.h}`);
  return true;
}

function cutSelection() {
  if (!copySelection()) return;
  clearSelectionContent(false);
}

function pasteClipboard() {
  if (transformGuard()) return;
  if (!state.clipboard) { toast('剪贴板为空'); return; }
  history.pushFull('粘贴');
  const l = layers.addLayer();
  l.name = '粘贴';
  l.surface.putCanvas(state.clipboard.canvas, state.clipboard.x, state.clipboard.y);
  engine.render();
  refreshThumbs();
  updateStatus();
  toast('已粘贴为新图层');
}

function clearSelectionContent(showConfirm = false) {
  if (transformGuard()) return;
  const l = targetLayer();
  if (!l) return;
  if (showConfirm && !confirm('清除选中内容？')) return;
  const before = history.captureLayer(l.id);
  if (selection.active) l.surface.drawCanvas(selection.mask, 0, 0, { composite: 'destination-out' });
  else l.surface.clearAll();
  history.pushLayerDiff(l.id, before, selection.active ? '清除选区' : '清除图层');
  engine.render();
  refreshThumbs();
  updateStatus();
}

function fillSelection() {
  if (transformGuard()) return;
  const l = targetLayer();
  if (!l) return;
  const before = history.captureLayer(l.id);
  const tmp = document.createElement('canvas');
  tmp.width = layers.w;
  tmp.height = layers.h;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = state.color;
  tctx.fillRect(0, 0, layers.w, layers.h);
  if (selection.active) {
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(selection.mask, 0, 0);
  }
  l.surface.putCanvas(tmp, 0, 0);
  history.pushLayerDiff(l.id, before, '填充');
  engine.render();
  refreshThumbs();
  updateStatus();
}

/* ---------------- 自由变换 ---------------- */

function startFreeTransform() {
  if (transform.active) { transform.commit(); updateOptionsBar(); }
  if (!transform.start('free')) toast('请选择一个未锁定的像素图层');
  else updateOptionsBar();
}

function commitTransform() {
  if (!transform.active) return;
  transform.commit();
  updateOptionsBar();
  refreshThumbs();
  updateStatus();
}

function cancelTransform() {
  if (!transform.active) return;
  transform.cancel();
  updateOptionsBar();
  refreshThumbs();
  updateStatus();
}

document.getElementById('btn-sel-all').addEventListener('click', selectAll);
document.getElementById('btn-sel-invert').addEventListener('click', invertSelection);
document.getElementById('btn-sel-feather').addEventListener('click', featherSelection);
document.getElementById('btn-sel-none').addEventListener('click', deselect);
document.getElementById('btn-tr-flip-h').addEventListener('click', () => transform.flip('h'));
document.getElementById('btn-tr-flip-v').addEventListener('click', () => transform.flip('v'));
document.getElementById('btn-tr-apply').addEventListener('click', commitTransform);
document.getElementById('btn-tr-cancel').addEventListener('click', cancelTransform);

// 蚂蚁线动画：有选区时以 ~8fps 重绘
setInterval(() => {
  if (!selection.active) return;
  engine.antsPhase = (engine.antsPhase + 1) % 8;
  engine.render();
}, 120);

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (state.spaceDown || state.tool === 'hand' || e.button === 1) {
    state.panning = true;
    state.panLast = { x: e.clientX, y: e.clientY };
    return;
  }
  if (e.button !== 0) return;

  if (state.tool === 'zoom') {
    engine.zoomAt(e.offsetX, e.offsetY, e.altKey ? 0.8 : 1.25);
    updateStatus();
    return;
  }

  // 1) 自由变换进行中：先处理手柄 / 框内拖动
  if (transform.active) {
    const handle = transform.hitTest(e.offsetX, e.offsetY);
    if (handle) {
      transform.beginDrag(handle, e.offsetX, e.offsetY);
      state.transforming = true;
    } else if (state.tool === 'move') {
      // 移动工具：点在框内任意位置都可以拖
      transform.beginDrag('move', e.offsetX, e.offsetY);
      state.transforming = true;
    }
    return;
  }

  // 2) 移动工具：提层 + 拖动，松手即落回
  if (state.tool === 'move') {
    if (!transform.start('move')) { toast('请先选择一个未锁定的像素图层'); return; }
    transform.beginDrag('move', e.offsetX, e.offsetY);
    state.transforming = true;
    updateOptionsBar();
    return;
  }

  // 3) 选区工具
  if (isSelectTool(state.tool)) { startSelection(e); return; }

  // 4) 按住 Alt 临时吸管（画笔/橡皮/涂抹时）
  if (e.altKey && BRUSHISH.includes(state.tool)) {
    state.altPick = true;
    pickAt(e);
    return;
  }

  // 5) 油漆桶 / 渐变 / 吸管 / 涂抹
  if (state.tool === 'bucket') { doBucketFill(e); return; }
  if (state.tool === 'gradient') { startGradient(e); return; }
  if (state.tool === 'eyedropper') { pickAt(e); return; }
  if (state.tool === 'smudge') {
    state.drawing = beginSmudge(e);
    updateStatus();
    return;
  }

  // 6) 画笔 / 橡皮
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
  if (state.transforming && transform.active && transform.drag) {
    transform.pointerMove(e.offsetX, e.offsetY, e.shiftKey);
    return;
  }
  if (state.gradDrag) { moveGradient(e); return; }
  if (state.selDrag) { moveSelection(e); return; }
  if (state.polyPoints) { updatePolyPreview(engine.screenToWorld(e.offsetX, e.offsetY)); return; }
  if (state.altPick) { pickAt(e); return; }
  if (state.tool === 'eyedropper' && (e.buttons & 1)) { pickAt(e); return; }
  if (state.drawing) {
    if (state.smudgeSession) continueSmudge(e);
    else continueStroke(e);
  }
});

function endPointer(e) {
  if (state.panning) state.panning = false;
  if (state.altPick) state.altPick = false;

  if (state.transforming) {
    state.transforming = false;
    if (transform.active) transform.pointerUp();
    updateOptionsBar();
  }

  if (state.gradDrag) finishGradient();
  if (state.selDrag) finishSelection(e);

  if (state.drawing) {
    state.drawing = false;
    state.last = null;
    state.smoothPoint = null;
    flushStrokeRender();
    if (state.journal) {
      const toolName = state.tool === 'eraser' ? '橡皮擦' : (BrushRegistry.get(state.brush)?.name || '画笔');
      const where = state.strokeTarget === 'mask' ? '蒙版'
        : state.smudgeSession ? '涂抹'
        : toolName;
      history.commitStroke(state.journal, `${where} ${state.size}px`);
      state.journal = null;
    }
    state.smudgeSession = null;
    refreshThumbs();
    updateStatus();
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', () => { if (state.polyPoints) finishPoly(); });
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
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    togglePanels();
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    toggleBrushAux('dynamics', document.getElementById('btn-brush-settings'));
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '0') {
    e.preventDefault();
    engine.fit();
    updateStatus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '1') {
    e.preventDefault();
    zoom100();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (transform.active) return;  // 变换中不响应撤销
    if (e.shiftKey) history.redo(); else history.undo();
    refreshThumbs();
    updateStatus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAll();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    deselect();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    invertSelection();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
    e.preventDefault();
    startFreeTransform();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    copySelection();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    cutSelection();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (e.key === 'Enter') {
    if (transform.active) { e.preventDefault(); commitTransform(); return; }
    if (state.polyPoints) { e.preventDefault(); finishPoly(); return; }
  }
  if (e.key === 'Escape') {
    if (transform.active) { e.preventDefault(); cancelTransform(); return; }
    if (state.polyPoints) { e.preventDefault(); cancelPoly(); return; }
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    clearSelectionContent(false);
    return;
  }
  if ((e.shiftKey && e.key === 'F5') || (e.altKey && e.key === 'Backspace')) {
    e.preventDefault();
    fillSelection();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    openPreferences();
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
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '[') { sizeInput.value = Math.max(1, +sizeInput.value - 4); sizeInput.dispatchEvent(new Event('input')); }
  if (e.key === ']') { sizeInput.value = Math.min(200, +sizeInput.value + 4); sizeInput.dispatchEvent(new Event('input')); }
  if (e.key === '0') { engine.fit(); updateStatus(); }
  if (e.key.toLowerCase() === 'x') {
    document.getElementById('btn-swap-colors').click();
    return;
  }
  if (e.key.toLowerCase() === 'd') {
    document.getElementById('btn-default-colors').click();
    return;
  }
  if (e.key.toLowerCase() === 'e') setTool('eraser');
  if (e.key.toLowerCase() === 'b') setTool('brush');
  if (e.key.toLowerCase() === 'h') setTool('hand');
  if (e.key.toLowerCase() === 'v') setTool('move');
  if (e.key.toLowerCase() === 'm') setTool(e.shiftKey ? 'ellipse' : 'rect');
  if (e.key.toLowerCase() === 'l') setTool(e.shiftKey ? 'poly' : 'lasso');
  if (e.key.toLowerCase() === 's') setTool('smudge');
  if (e.key.toLowerCase() === 'g') setTool(e.shiftKey ? 'gradient' : 'bucket');
  if (e.key.toLowerCase() === 'i') setTool('eyedropper');
  if (e.key.toLowerCase() === 'z') setTool('zoom');
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
updateOptionsBar();
updateStatus();
refreshHistoryPanel();
scheduleAutosave();
checkRecovery();
setAutosaveStatus('未修改');

// 滑块已填充比例（PS 风格：进度部分高亮）
function syncRangeFill(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const val = Number(el.value) || 0;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', Math.max(0, Math.min(100, pct)).toFixed(2) + '%');
}
document.querySelectorAll('input[type="range"]').forEach(syncRangeFill);
document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'range') syncRangeFill(e.target);
});
// 初始状态同步
applyColor(state.color, { noWheel: false });
applyBgColor(state.bgColor);
updateDocTab();
rulers.resize();
// 启动先进首页（显示最近文件 / 新建 / 预设）；?nohome=1 可跳过（用于截图/调试）
if (!/[?&]nohome=1/.test(location.search)) homeApi.show();

/* ---------------- 调试/自动化钩子（不影响正常使用） ---------------- */
window.__lbsh = {
  engine, layers, history, selection, transform, state, Dynamics,
  doAutosave,
  saveProject,
  openProjectFromBytes,
  newDocument,
  maskedDab, stampAt, beginStroke, continueStroke,
  doBucketFill, startGradient, moveGradient, finishGradient,
  beginSmudge, continueSmudge, stampSmudge, pickAt, setColor,
  floodFill, drawGradient,
  setTool, updateOptionsBar,
  selectAll, deselect, invertSelection, featherSelection,
  copySelection, pasteClipboard, clearSelectionContent, fillSelection,
  dock, rulers, applyColor, updateDocTab, zoom100, updateStatus, renderLayerPanel, refreshHistoryPanel,
  get dirty() { return dirty; },
  get projectName() { return currentProjectName; },
};
