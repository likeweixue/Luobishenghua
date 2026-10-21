// 色轮：CSP 风格的色相环 + SV 方块取色器
export class ColorWheel {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.h = 0;      // 0-360
    this.s = 0.1;    // 0-1
    this.v = 0.15;   // 0-1
    this.cx = canvas.width / 2;
    this.cy = canvas.height / 2;
    this.ringOuter = 74;
    this.ringInner = 56;
    this.sq = 76;    // SV 方块边长
    this.dragTarget = null;

    canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragTarget) this.onPointer(e, true);
    });
    window.addEventListener('pointerup', () => { this.dragTarget = null; });

    this.draw();
  }

  get sqX() { return this.cx - this.sq / 2; }
  get sqY() { return this.cy - this.sq / 2; }

  hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }

  hex() {
    const { r, g, b } = this.hsvToRgb(this.h, this.s, this.v);
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
  }

  setHex(hex) {
    const m = hex.replace('#', '');
    const r = parseInt(m.slice(0, 2), 16) / 255;
    const g = parseInt(m.slice(2, 4), 16) / 255;
    const b = parseInt(m.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    this.v = max;
    this.s = max === 0 ? 0 : d / max;
    if (d === 0) { /* 保留原色相 */ }
    else if (max === r) this.h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) this.h = ((b - r) / d + 2) * 60;
    else this.h = ((r - g) / d + 4) * 60;
    this.draw();
  }

  onPointer(e, isDrag = false) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    const dx = x - this.cx;
    const dy = y - this.cy;
    const dist = Math.hypot(dx, dy);

    if (!isDrag) {
      if (dist >= this.ringInner - 4 && dist <= this.ringOuter + 4) this.dragTarget = 'ring';
      else if (x >= this.sqX && x <= this.sqX + this.sq && y >= this.sqY && y <= this.sqY + this.sq) this.dragTarget = 'square';
      else return;
    }

    if (this.dragTarget === 'ring') {
      this.h = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
    } else if (this.dragTarget === 'square') {
      this.s = Math.min(1, Math.max(0, (x - this.sqX) / this.sq));
      this.v = Math.min(1, Math.max(0, 1 - (y - this.sqY) / this.sq));
    }
    this.draw();
    this.onChange(this.hex());
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // 色相环
    ctx.lineWidth = this.ringOuter - this.ringInner;
    const ringR = (this.ringOuter + this.ringInner) / 2;
    for (let a = 0; a < 360; a += 2) {
      ctx.strokeStyle = `hsl(${a}, 100%, 50%)`;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, ringR, (a - 1.2) * Math.PI / 180, (a + 2.2) * Math.PI / 180);
      ctx.stroke();
    }

    // SV 方块
    const hueColor = `hsl(${this.h}, 100%, 50%)`;
    ctx.fillStyle = hueColor;
    ctx.fillRect(this.sqX, this.sqY, this.sq, this.sq);
    let g1 = ctx.createLinearGradient(this.sqX, 0, this.sqX + this.sq, 0);
    g1.addColorStop(0, 'rgba(255,255,255,1)');
    g1.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(this.sqX, this.sqY, this.sq, this.sq);
    let g2 = ctx.createLinearGradient(0, this.sqY, 0, this.sqY + this.sq);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g2;
    ctx.fillRect(this.sqX, this.sqY, this.sq, this.sq);

    // 色相指示点
    const hr = this.h * Math.PI / 180;
    const hx = this.cx + Math.cos(hr) * ringR;
    const hy = this.cy + Math.sin(hr) * ringR;
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();

    // SV 指示点
    const sx = this.sqX + this.s * this.sq;
    const sy = this.sqY + (1 - this.v) * this.sq;
    ctx.beginPath();
    ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = this.hex();
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
}
