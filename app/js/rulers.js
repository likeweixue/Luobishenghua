// 源文件：app 运行时使用 app/js/rulers.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/rulers.js。
// 标尺：跟随视图缩放/平移绘制，PS 风格的像素刻度。
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000];
export class Rulers {
    enabled;
    constructor(engine, area, hCanvas, vCanvas) {
        this.engine = engine;
        this.area = area;
        this.h = hCanvas;
        this.v = vCanvas;
        this.hctx = hCanvas.getContext('2d');
        this.vctx = vCanvas.getContext('2d');
        this.enabled = localStorage.getItem('lbsh-rulers') !== '0';
        this.area.classList.toggle('rulers-off', !this.enabled);
        engine.addRenderListener(() => this.draw());
        if (window.ResizeObserver) {
            this.ro = new ResizeObserver(() => this.resize());
            this.ro.observe(this.h);
            this.ro.observe(this.v);
        }
        window.addEventListener('resize', () => this.resize());
        this.resize();
    }
    toggle() { this.setEnabled(!this.enabled); }
    setEnabled(on) {
        this.enabled = !!on;
        try {
            localStorage.setItem('lbsh-rulers', this.enabled ? '1' : '0');
        }
        catch { /* ignore */ }
        this.area.classList.toggle('rulers-off', !this.enabled);
        requestAnimationFrame(() => {
            this.engine.resize();
            this.resize();
        });
    }
    _size(canvas) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h)
            return null;
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w, h, ctx };
    }
    resize() {
        if (!this.enabled)
            return;
        this._size(this.h);
        this._size(this.v);
        this.draw();
    }
    _step(scale) {
        for (const s of STEPS)
            if (s * scale >= 62)
                return s;
        return STEPS[STEPS.length - 1];
    }
    draw() {
        if (!this.enabled)
            return;
        const h = this._size(this.h);
        const v = this._size(this.v);
        if (!h || !v)
            return;
        this._drawH(h);
        this._drawV(v);
    }
    _drawH({ w, h, ctx }) {
        const view = this.engine.view;
        const scale = view.scale;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#262626';
        ctx.fillRect(0, 0, w, h);
        ctx.font = '9px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif';
        ctx.textBaseline = 'middle';
        const step = this._step(scale);
        const minor = step / 5;
        const startW = (0 - view.tx) / scale;
        const endW = (w - view.tx) / scale;
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#5a5a5a';
        ctx.beginPath();
        const firstMinor = Math.floor(startW / minor) * minor;
        for (let world = firstMinor; world <= endW + minor; world += minor) {
            const x = Math.round(world * scale + view.tx) + 0.5;
            if (x < 0 || x > w)
                continue;
            const major = Math.abs(world / step - Math.round(world / step)) < 1e-6;
            ctx.moveTo(x, h);
            ctx.lineTo(x, h - (major ? 12 : 5));
        }
        ctx.stroke();
        ctx.fillStyle = '#8d8d8d';
        ctx.textAlign = 'left';
        const firstMajor = Math.floor(startW / step) * step;
        for (let world = firstMajor; world <= endW + step; world += step) {
            const x = Math.round(world * scale + view.tx);
            if (x < 12 || x > w - 2)
                continue;
            ctx.fillText(String(Math.round(world)), x + 3, 7);
        }
        // 文档原点强调
        const zero = Math.round(view.tx) + 0.5;
        if (zero >= 0 && zero <= w) {
            ctx.strokeStyle = '#7fb4e8';
            ctx.beginPath();
            ctx.moveTo(zero, h);
            ctx.lineTo(zero, h - 9);
            ctx.stroke();
        }
    }
    _drawV({ w, h, ctx }) {
        const view = this.engine.view;
        const scale = view.scale;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#262626';
        ctx.fillRect(0, 0, w, h);
        ctx.font = '9px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif';
        ctx.textBaseline = 'middle';
        const step = this._step(scale);
        const minor = step / 5;
        const startW = (0 - view.ty) / scale;
        const endW = (h - view.ty) / scale;
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#5a5a5a';
        ctx.beginPath();
        const firstMinor = Math.floor(startW / minor) * minor;
        for (let world = firstMinor; world <= endW + minor; world += minor) {
            const y = Math.round(world * scale + view.ty) + 0.5;
            if (y < 0 || y > h)
                continue;
            const major = Math.abs(world / step - Math.round(world / step)) < 1e-6;
            ctx.moveTo(w, y);
            ctx.lineTo(w - (major ? 12 : 5), y);
        }
        ctx.stroke();
        ctx.fillStyle = '#8d8d8d';
        ctx.textAlign = 'center';
        const firstMajor = Math.floor(startW / step) * step;
        for (let world = firstMajor; world <= endW + step; world += step) {
            const y = Math.round(world * scale + view.ty);
            if (y < 12 || y > h - 2)
                continue;
            ctx.save();
            ctx.translate(9, y);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(String(Math.round(world)), 0, 0);
            ctx.restore();
        }
        const zero = Math.round(view.ty) + 0.5;
        if (zero >= 0 && zero <= h) {
            ctx.strokeStyle = '#7fb4e8';
            ctx.beginPath();
            ctx.moveTo(w, zero);
            ctx.lineTo(w - 9, zero);
            ctx.stroke();
        }
    }
}
