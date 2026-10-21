// 主程序：面板系统 + 图层系统 + 笔画管线（压感采样 → 印章铺排）
import { Engine } from './engine.js';
import { History } from './history.js';
import { BrushPresets, BrushRegistry, registerCustomBrush, brushThumbnail, pressureSize, pressureAlpha, drawDab } from './brushes.js';
import { readABR } from './abr.js';
import { initMenuBar, aboutDialog, shortcutsDialog, settingsDialog, newDocDialog } from './menu.js';

/* ---------------- 设置（localStorage 持久化） ---------------- */

const settings = Object.assign(
  { undoLimit: 25, defaultWidth: 1600, defaultHeight: 1600 },
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
  drawing: false,
  panning: false,
  spaceDown: false,
  last: null,
  spacingLeft: 0,
  panLast: null,
};

/* ---------------- 工具面板 ---------------- */

const toolBtns = document.querySelectorAll('#tool-list button');
function setTool(tool) {
  state.tool = tool;
  toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.classList.toggle('panning', tool === 'hand');
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
sizeInput.addEventListener('input', () => {
  state.size = +sizeInput.value;
  document.getElementById('brush-size-val').textContent = sizeInput.value;
  updateStatus();
});
opacityInput.addEventListener('input', () => {
  state.opacity = +opacityInput.value / 100;
  document.getElementById('brush-opacity-val').textContent = opacityInput.value + '%';
});

/* ---------------- 图层面板 ---------------- */

const layerListEl = document.getElementById('layer-list');
const blendSelect = document.getElementById('layer-blend');
const layerOpacityInput = document.getElementById('layer-opacity');

function renderLayerPanel() {
  layerListEl.innerHTML = '';
  // 面板中顶层在上：倒序渲染
  for (let i = layers.layers.length - 1; i >= 0; i--) {
    const l = layers.layers[i];
    const row = document.createElement('div');
    row.className = 'layer-row' + (l.id === layers.activeId ? ' active' : '');

    const eye = document.createElement('span');
    eye.className = 'eye' + (l.visible ? '' : ' off');
    eye.textContent = '👁';
    eye.title = '显示/隐藏';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      history.pushFull();
      layers.setVisible(l.id, !l.visible);
      engine.render();
      updateStatus();
    });

    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    thumb.width = 30;
    thumb.height = 24;
    thumb.dataset.layerId = l.id;

    const name = document.createElement('span');
    name.className = 'lname' + (l.locked ? ' locked' : '');
    name.textContent = l.name + (l.locked ? ' 🔒' : '');
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (l.locked) return;
      const n = prompt('图层名称', l.name);
      if (n && n.trim()) {
        history.pushFull();
        layers.rename(l.id, n);
      }
    });

    row.append(eye, thumb, name);
    row.addEventListener('click', () => {
      layers.setActive(l.id);
      updateStatus();
    });
    layerListEl.appendChild(row);
  }
  refreshThumbs();
  syncLayerControls();
}

function refreshThumbs() {
  for (const thumb of layerListEl.querySelectorAll('canvas.thumb')) {
    const l = layers.byId(+thumb.dataset.layerId);
    if (!l) continue;
    const tc = thumb.getContext('2d');
    tc.clearRect(0, 0, 30, 24);
    tc.save();
    tc.scale(30 / layers.w, 24 / layers.h);
    tc.drawImage(l.canvas, 0, 0);
    tc.restore();
  }
}

function syncLayerControls() {
  const l = layers.active;
  if (!l) return;
  blendSelect.value = l.blend;
  layerOpacityInput.value = Math.round(l.opacity * 100);
  document.getElementById('layer-opacity-val').textContent = Math.round(l.opacity * 100);
  const locked = l.locked;
  blendSelect.disabled = locked;
  layerOpacityInput.disabled = locked;
  document.getElementById('btn-layer-del').disabled = locked;
  document.getElementById('btn-layer-up').disabled = locked;
  document.getElementById('btn-layer-down').disabled = locked;
}

document.getElementById('btn-layer-add').addEventListener('click', () => {
  history.pushFull();
  layers.addLayer();
  engine.render();
  updateStatus();
});
document.getElementById('btn-layer-del').addEventListener('click', () => {
  if (!confirm(`删除「${layers.active.name}」？（可用撤销恢复）`)) return;
  history.pushFull();
  layers.deleteActive();
  engine.render();
  updateStatus();
});
document.getElementById('btn-layer-up').addEventListener('click', () => {
  history.pushFull();
  if (!layers.moveActive(1)) history.undoStack.pop();
  engine.render();
  updateStatus();
});
document.getElementById('btn-layer-down').addEventListener('click', () => {
  history.pushFull();
  if (!layers.moveActive(-1)) history.undoStack.pop();
  engine.render();
  updateStatus();
});
blendSelect.addEventListener('change', () => {
  history.pushFull();
  layers.setBlend(blendSelect.value);
  engine.render();
});
layerOpacityInput.addEventListener('pointerdown', () => history.pushFull()); // 拖动前记一次历史
layerOpacityInput.addEventListener('input', () => {
  layers.setOpacity(+layerOpacityInput.value / 100);
  document.getElementById('layer-opacity-val').textContent = layerOpacityInput.value;
  engine.render();
});

layers.onChange = () => renderLayerPanel();

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
document.getElementById('btn-clear').addEventListener('click', () => {
  const l = layers.active;
  if (!l) return;
  if (!confirm(`清空「${l.name}」的内容？（可用撤销恢复）`)) return;
  history.pushPaint();
  l.ctx.save();
  l.ctx.globalCompositeOperation = 'source-over';
  if (l.locked) {
    l.ctx.fillStyle = '#ffffff';
    l.ctx.fillRect(0, 0, layers.w, layers.h);
  } else {
    l.ctx.clearRect(0, 0, layers.w, layers.h);
  }
  l.ctx.restore();
  engine.render();
  refreshThumbs();
  updateStatus();
});
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

function loadDocumentFromPSD(psd) {
  layers.reset(psd.width, psd.height);
  if (psd.layers.length > 0) {
    // PSD 文件中图层是「顶层在前」，内部栈是「底层在前」→ 倒序推入
    for (let i = psd.layers.length - 1; i >= 0; i--) {
      layers.pushLayer(psd.layers[i]);
    }
  } else if (psd.composite) {
    // 无图层信息：用合成图像作为单图层
    const c = document.createElement('canvas');
    c.width = psd.width;
    c.height = psd.height;
    c.getContext('2d').putImageData(psd.composite, 0, 0);
    layers.pushLayer({ name: '背景', canvas: c });
  }
  layers.activeId = layers.layers[layers.layers.length - 1].id;
  engine.setDocSize(psd.width, psd.height);
  document.getElementById('status-doc').textContent = `画布 ${psd.width} × ${psd.height}`;
  history.clear();
  renderLayerPanel();
  engine.resize();
  engine.fit();
  updateStatus();
}

function openPSDFile(file) {
  file.arrayBuffer().then(buf => {
    try {
      const psd = readPSD(buf);
      loadDocumentFromPSD(psd);
    } catch (err) {
      alert('PSD 读取失败：' + err.message);
    }
  });
}

document.getElementById('btn-open').addEventListener('click', () => {
  document.getElementById('file-open').click();
});
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
    if (/\.psd$/i.test(f.name)) { openPSDFile(f); return; }
    if (/\.abr$/i.test(f.name)) { importABRFile(f); return; }
  }
});

// Tauri 桌面壳：HTML5 drop 被原生窗口接管时走 tauri 事件读真实文件路径
if (TAURI && TAURI.event) {
  TAURI.event.listen('tauri://drag-drop', async (ev) => {
    const paths = (ev.payload && ev.payload.paths) || [];
    for (const p of paths) {
      if (!/\.(psd|abr)$/i.test(p)) continue;
      try {
        const bytes = await TAURI.fs.readFile(p);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (/\.psd$/i.test(p)) {
          const psd = readPSD(buf);
          loadDocumentFromPSD(psd);
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
    // 文件图层顺序：顶层在前
    const defs = [...layers.layers].reverse().map(l => ({
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blend: l.blend,
      imageData: l.ctx.getImageData(0, 0, layers.w, layers.h),
    }));
    const bytes = writePSD({
      width: layers.w,
      height: layers.h,
      layers: defs,
      compositeImage: tc.getImageData(0, 0, layers.w, layers.h),
    });
    await saveBytes(bytes, 'luobishenghua.psd', 'Photoshop 文档', ['psd']);
  } catch (err) {
    alert('PSD 导出失败：' + err.message);
  }
}
document.getElementById('btn-save-psd').addEventListener('click', doExportPSD);

/* ---------------- 新建文档 / 缩放 ---------------- */

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
  history.clear();
  renderLayerPanel();
  engine.resize();
  engine.fit();
  updateStatus();
}

function zoomCenter(factor) {
  engine.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
  updateStatus();
}

/* ---------------- 菜单栏 ---------------- */

initMenuBar({
  about: aboutDialog,
  newDoc: () => newDocDialog(settings, newDocument),
  openPSD: () => document.getElementById('file-open').click(),
  exportPNG: doExportPNG,
  exportPSD: doExportPSD,
  importABR: () => document.getElementById('file-abr').click(),
  undo: () => { history.undo(); refreshThumbs(); updateStatus(); },
  redo: () => { history.redo(); refreshThumbs(); updateStatus(); },
  clearLayer: () => document.getElementById('btn-clear').click(),
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
  const type = activeBrushType();
  const preset = BrushRegistry.get(type);
  const size = pressureSize(type, state.size, pressure);
  const alpha = pressureAlpha(type, state.opacity, pressure);
  drawDab(activeCtx(), type, state.color, x, y, size, alpha, preset.jitter || 0);
}

function beginStroke(e) {
  const l = layers.active;
  if (!l || !l.visible) return false; // 隐藏图层不画
  history.pushPaint();
  const p = engine.screenToWorld(e.offsetX, e.offsetY);
  const pressure = getPressure(e);
  state.last = { ...p, pressure };
  state.spacingLeft = 0;
  stampAt(p.x, p.y, pressure);
  engine.render();
  return true;
}

function continueStroke(e) {
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const preset = BrushRegistry.get(activeBrushType());
  for (const ev of events) {
    const p = engine.screenToWorld(ev.offsetX, ev.offsetY);
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
    document.getElementById('file-open').click();
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
updateStatus();
