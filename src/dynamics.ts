// 源文件：app 运行时使用 app/js/dynamics.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/dynamics.js。
// 笔刷动态：压感曲线（可拖拽编辑） + 倾斜映射 + 间距/散布
// 曲线用分段线性控制点表示，烘焙成 256 级 LUT，笔画热路径只做一次查表

const LUT_SIZE = 256;

const CURVE_PRESETS = {
  linear: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]],
  soft: [[0, 0], [0.25, 0.12], [0.5, 0.38], [0.75, 0.72], [1, 1]],
  hard: [[0, 0], [0.25, 0.42], [0.5, 0.68], [0.75, 0.87], [1, 1]],
  light: [[0, 0.15], [0.5, 0.6], [1, 1]],
};

export const Dynamics: any = {
  points: CURVE_PRESETS.linear.map(p => p.slice()),
  lut: new Float32Array(LUT_SIZE),
  tiltEnabled: false,
  tiltStrength: 1,      // 倾斜对大小的放大倍数上限
  spacingScale: 1,      // 间距倍数（1 = 笔刷自带间距）
  scatter: 0,           // 散布（0..1，额外随机抖动）
  tilt: 0,              // 当前笔画的倾斜量（由笔画管线写入）
  onChange: null,

  /** 重算 LUT（控制点改动后调用） */
  rebuild() {
    const pts = this.points.slice().sort((a, b) => a.x - b.x);
    let k = 0;
    for (let i = 0; i < LUT_SIZE; i++) {
      const p = i / (LUT_SIZE - 1);
      while (k < pts.length - 2 && p > pts[k + 1][0]) k++;
      const [x0, y0] = pts[k];
      const [x1, y1] = pts[Math.min(k + 1, pts.length - 1)];
      const t = x1 > x0 ? (p - x0) / (x1 - x0) : 0;
      this.lut[i] = Math.max(0, Math.min(1, y0 + (y1 - y0) * Math.max(0, Math.min(1, t))));
    }
    if (this.onChange) this.onChange(this);
  },

  /** 压感映射：原始压力 0..1 → 曲线后的压力 */
  map(p) {
    const v = Math.max(0, Math.min(1, p || 0));
    return this.lut[Math.round(v * (LUT_SIZE - 1))];
  },

  /** 倾斜量 0..1（笔与屏幕法线夹角 / 90°） */
  tiltFromEvent(e) {
    if (e.tiltX || e.tiltY) {
      return Math.min(1, Math.hypot(e.tiltX, e.tiltY) / 90);
    }
    return 0;
  },

  /** 倾斜带来的大小倍数 */
  tiltSizeFactor() {
    if (!this.tiltEnabled) return 1;
    return 1 + this.tilt * this.tiltStrength * 1.2;
  },

  setPoints(points) {
    this.points = points.map(p => [clamp01(p[0]), clamp01(p[1])]);
    // 首尾固定在 x=0 和 x=1，避免曲线断裂
    this.points[0][0] = 0;
    this.points[this.points.length - 1][0] = 1;
    this.rebuild();
  },

  setPreset(name) {
    const p = CURVE_PRESETS[name];
    if (!p) return;
    this.setPoints(p.map(v => v.slice()));
  },

  toJSON() {
    return {
      points: this.points,
      tiltEnabled: this.tiltEnabled,
      tiltStrength: this.tiltStrength,
      spacingScale: this.spacingScale,
      scatter: this.scatter,
    };
  },

  load(obj) {
    if (!obj) return;
    if (Array.isArray(obj.points) && obj.points.length >= 2) this.setPoints(obj.points);
    else this.rebuild();
    if (typeof obj.tiltEnabled === 'boolean') this.tiltEnabled = obj.tiltEnabled;
    if (typeof obj.tiltStrength === 'number') this.tiltStrength = obj.tiltStrength;
    if (typeof obj.spacingScale === 'number') this.spacingScale = obj.spacingScale;
    if (typeof obj.scatter === 'number') this.scatter = obj.scatter;
    this.rebuild();
  },
};

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/* ---------------- 曲线编辑器（画布 + 拖点） ---------------- */

export class CurveEditor {
  [key: string]: any;

  constructor(canvas: any, onChange?: any) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || null;
    this.drag = null;
    this.hover = -1;
    this.pad = 10;
    this.w = canvas.width;
    this.h = canvas.height;

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = -1; this.draw(); } });
    this.draw();
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    };
  }

  // 归一化点 → 画布像素（y 轴翻转：压力 1 在顶部）
  _toPx(p) {
    const { pad, w, h } = this;
    return { x: pad + p[0] * (w - pad * 2), y: h - pad - p[1] * (h - pad * 2) };
  }

  _hit(nx, ny) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < Dynamics.points.length; i++) {
      const px = this._toPx(Dynamics.points[i]);
      const d = Math.hypot(px.x - nx * this.w, px.y - ny * this.h);
      if (d < 11 && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  _down(e) {
    const p = this._pos(e);
    let i = this._hit(p.x, p.y);
    if (i < 0) {
      // 点在空白处：在最近区间插入一个控制点
      i = this._insert(p.x, 1 - p.y);
      if (i < 0) return;
    }
    this.drag = i;
    this.canvas.setPointerCapture(e.pointerId);
    this._apply(p);
  }

  _insert(nx, ny) {
    const pts = Dynamics.points;
    for (let i = 0; i < pts.length - 1; i++) {
      if (nx > pts[i][0] && nx < pts[i + 1][0]) {
        pts.splice(i + 1, 0, [nx, ny]);
        Dynamics.rebuild();
        this._emit();
        return i + 1;
      }
    }
    return -1;
  }

  _move(e) {
    const p = this._pos(e);
    if (this.drag === null || this.drag === undefined) {
      const i = this._hit(p.x, p.y);
      if (i !== this.hover) { this.hover = i; this.draw(); }
      return;
    }
    this._apply(p);
  }

  _apply(p) {
    const i = this.drag;
    const pts = Dynamics.points;
    if (i < 0 || i >= pts.length) return;
    const isFirst = i === 0;
    const isLast = i === pts.length - 1;
    const gap = 0.04;
    let x = clamp01(p.x);
    if (isFirst) x = 0;
    else if (isLast) x = 1;
    else x = Math.max(pts[i - 1][0] + gap, Math.min(pts[i + 1][0] - gap, x));
    pts[i] = [x, clamp01(1 - p.y)];
    Dynamics.rebuild();
    this.draw();
    this._emit();
  }

  _up(e) {
    if (this.drag !== null && this.drag !== undefined) {
      this.drag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }

  _emit() {
    if (this.onChange) this.onChange(Dynamics);
  }

  draw() {
    const { ctx, w, h, pad } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#232326';
    ctx.fillRect(0, 0, w, h);

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = pad + (i / 4) * (w - pad * 2);
      const y = pad + (i / 4) * (h - pad * 2);
      ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, h - pad); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }

    // 对角线（参考：线性）
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(w - pad, pad);
    ctx.stroke();
    ctx.setLineDash([]);

    // 曲线
    const pts = Dynamics.points;
    ctx.strokeStyle = '#4a90d9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = this._toPx(pts[i]);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // 曲线下填充
    ctx.lineTo(this._toPx(pts[pts.length - 1]).x, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,144,217,0.12)';
    ctx.fill();

    // 控制点
    for (let i = 0; i < pts.length; i++) {
      const p = this._toPx(pts[i]);
      const active = i === this.drag || i === this.hover;
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? 5 : 3.6, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#7fb4e8' : '#2f6ea8';
      ctx.fill();
      ctx.strokeStyle = '#cfe3f7';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // 轴向标签
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.fillText('压力', 2, 9);
    ctx.fillText('笔压', w - 22, h - 1);
  }
}
