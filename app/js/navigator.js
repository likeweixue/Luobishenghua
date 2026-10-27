// 导航器：文档缩略图 + 视野红框，拖动红框平移视野
export class Navigator {
  constructor(canvas, engine, stage) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.stage = stage;
    this.dragging = false;

    canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.jump(e); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (this.dragging) this.jump(e); });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });

    engine.onRender = () => this.draw();
    engine.onDocSync = () => this.draw();
  }

  // 文档在导航器中的布局（contain）
  layout() {
    const k = Math.min(this.canvas.width / this.engine.docW, this.canvas.height / this.engine.docH);
    return {
      k,
      ox: (this.canvas.width - this.engine.docW * k) / 2,
      oy: (this.canvas.height - this.engine.docH * k) / 2,
    };
  }

  draw() {
    const ctx = this.ctx;
    const { k, ox, oy } = this.layout();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.engine.doc, ox, oy, this.engine.docW * k, this.engine.docH * k);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(ox, oy, this.engine.docW * k, this.engine.docH * k);

    // 视野红框：画布四角换算到文档坐标再映射到导航器
    const w = this.engine.canvas.clientWidth;
    const h = this.engine.canvas.clientHeight;
    const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([sx, sy]) => {
      const p = this.engine.screenToWorld(sx, sy);
      return [ox + p.x * k, oy + p.y * k];
    });
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.strokeStyle = '#e24b4a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  jump(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    const { k, ox, oy } = this.layout();
    const wx = (x - ox) / k;
    const wy = (y - oy) / k;
    this.engine.centerOn(wx, wy);
  }
}
