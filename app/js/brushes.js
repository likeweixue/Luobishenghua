// 笔刷引擎：印章（stamp）生成 + 压感参数模型 + 自定义笔刷注册表
// 每种笔刷 = 一个预渲染的笔尖印章 + 一组压感映射参数

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

function rgba(color, a) {
  const { r, g, b } = hexToRgb(color);
  return `rgba(${r},${g},${b},${a})`;
}

const STAMP_SIZE = 128;
const stampCache = new Map();

function makeHardStamp(color) {
  const c = document.createElement('canvas');
  c.width = c.height = STAMP_SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(STAMP_SIZE / 2, STAMP_SIZE / 2, STAMP_SIZE / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function makeSoftStamp(color) {
  const c = document.createElement('canvas');
  c.width = c.height = STAMP_SIZE;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(
    STAMP_SIZE / 2, STAMP_SIZE / 2, 0,
    STAMP_SIZE / 2, STAMP_SIZE / 2, STAMP_SIZE / 2
  );
  g.addColorStop(0, rgba(color, 1));
  g.addColorStop(0.55, rgba(color, 0.45));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, STAMP_SIZE, STAMP_SIZE);
  return c;
}

function makePencilStamp(color) {
  const c = document.createElement('canvas');
  c.width = c.height = STAMP_SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(STAMP_SIZE / 2, STAMP_SIZE / 2, STAMP_SIZE / 2 - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * STAMP_SIZE;
    const y = Math.random() * STAMP_SIZE;
    const d = Math.hypot(x - STAMP_SIZE / 2, y - STAMP_SIZE / 2);
    if (d > STAMP_SIZE / 2 - 4) continue;
    ctx.globalAlpha = 0.15 + Math.random() * 0.5;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return c;
}

function makeWatercolorStamp(color) {
  const c = document.createElement('canvas');
  c.width = c.height = STAMP_SIZE;
  const ctx = c.getContext('2d');
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2;
    const off = i === 0 ? 0 : STAMP_SIZE * 0.09 * (0.5 + Math.random() * 0.5);
    const cx = STAMP_SIZE / 2 + Math.cos(ang) * off;
    const cy = STAMP_SIZE / 2 + Math.sin(ang) * off;
    const r = STAMP_SIZE * (i === 0 ? 0.42 : 0.36);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba(color, 0.5));
    g.addColorStop(0.7, rgba(color, 0.22));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, STAMP_SIZE, STAMP_SIZE);
  }
  return c;
}

/* ---------------- 内置预设 ---------------- */

export const BrushPresets = {
  hard: {
    name: '硬边圆笔',
    makeStamp: makeHardStamp,
    spacingRatio: 0.12,
    sizePressure: true,
    opacityPressure: false,
    minSizeFactor: 0.15,
    flow: 1,
  },
  soft: {
    name: '软边喷枪',
    makeStamp: makeSoftStamp,
    spacingRatio: 0.08,
    sizePressure: true,
    opacityPressure: true,
    minSizeFactor: 0.3,
    flow: 0.5,
  },
  pencil: {
    name: '铅笔',
    makeStamp: makePencilStamp,
    spacingRatio: 0.22,
    sizePressure: false,
    opacityPressure: true,
    minSizeFactor: 1,
    jitter: 0.35,
    flow: 0.8,
  },
  watercolor: {
    name: '水彩',
    makeStamp: makeWatercolorStamp,
    spacingRatio: 0.06,
    sizePressure: true,
    opacityPressure: false,
    minSizeFactor: 0.4,
    sizeBoost: 1.8,
    flow: 0.14,
  },
  eraser: {
    name: '橡皮擦',
    makeStamp: (color) => makeSoftStamp(color),
    spacingRatio: 0.1,
    sizePressure: true,
    opacityPressure: false,
    minSizeFactor: 0.3,
    erase: true,
    flow: 0.9,
  },
};

/* ---------------- 笔刷注册表（内置 + .abr 导入） ---------------- */

export const BrushRegistry = new Map();
for (const [key, preset] of Object.entries(BrushPresets)) {
  BrushRegistry.set(key, { id: key, custom: false, ...preset });
}

let customCount = 0;

// 把 .abr 解析出的笔尖（灰度 alpha 数组）注册为可用笔刷
export function registerCustomBrush({ name, width, height, spacingRatio, alpha }) {
  const id = 'custom-' + (++customCount);
  // 白底 + alpha 通道的笔尖图，染色时用 destination-in
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = width;
  alphaCanvas.height = height;
  const img = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = alpha[i];
  }
  alphaCanvas.getContext('2d').putImageData(img, 0, 0);

  const brush = {
    id,
    name,
    custom: true,
    alphaCanvas,
    diameter: Math.max(width, height),
    spacingRatio: spacingRatio || 0.1,
    sizePressure: true,
    opacityPressure: false,
    minSizeFactor: 0.15,
    flow: 1,
  };
  BrushRegistry.set(id, brush);
  return brush;
}

// 染色：笔尖 alpha × 当前颜色
function tintStamp(alphaCanvas, color) {
  const c = document.createElement('canvas');
  c.width = alphaCanvas.width;
  c.height = alphaCanvas.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(alphaCanvas, 0, 0);
  return c;
}

export function getStamp(id, color) {
  const key = id + '|' + color;
  if (!stampCache.has(key)) {
    const b = BrushRegistry.get(id);
    stampCache.set(key, b.custom ? tintStamp(b.alphaCanvas, color) : b.makeStamp(color));
  }
  return stampCache.get(key);
}

export function pressureSize(id, baseSize, pressure) {
  const p = BrushRegistry.get(id);
  let factor = 1;
  if (p.sizePressure) {
    factor = p.minSizeFactor + (1 - p.minSizeFactor) * pressure;
  }
  let size = baseSize * factor;
  if (p.sizeBoost) size *= p.sizeBoost;
  return Math.max(0.5, size);
}

export function pressureAlpha(id, baseOpacity, pressure) {
  const p = BrushRegistry.get(id);
  let a = baseOpacity * p.flow;
  if (p.opacityPressure) {
    a *= 0.25 + 0.75 * pressure;
  }
  return Math.min(1, a);
}

// 在精确中心落一个笔尖（不带随机抖动）。GPU 笔刷预览与提交共用同一组中心。
export function drawDabAt(ctx, id, color, x, y, size, alpha) {
  const stamp = getStamp(id, id === 'eraser' ? '#000000' : color);
  ctx.save();
  if (id === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  }
  ctx.globalAlpha = alpha;
  ctx.drawImage(stamp, x - size / 2, y - size / 2, size, size);
  ctx.restore();
}

export function drawDab(ctx, id, color, x, y, size, alpha, jitter) {
  let dx = x;
  let dy = y;
  if (jitter) {
    dx += (Math.random() - 0.5) * size * jitter;
    dy += (Math.random() - 0.5) * size * jitter;
  }
  drawDabAt(ctx, id, color, dx, dy, size, alpha);
}

// 生成笔刷预览缩略图（默认黑尖白底，可指定颜色）
export function brushThumbnail(brush, w = 44, h = 30, color = '#222222') {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const stamp = brush.custom
    ? tintStamp(brush.alphaCanvas, color)
    : brush.makeStamp(color);
  const k = Math.min((w - 6) / stamp.width, (h - 6) / stamp.height);
  const dw = stamp.width * k;
  const dh = stamp.height * k;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(stamp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return c;
}
