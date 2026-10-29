const worker = self;
worker.onmessage = (ev) => {
    const { id, stamp, tiles, dabs } = ev.data;
    const results = [];
    for (const t of tiles) {
        const c = new OffscreenCanvas(t.w, t.h);
        const ctx = c.getContext('2d');
        if (t.bmp) {
            ctx.drawImage(t.bmp, 0, 0);
            t.bmp.close?.();
        }
        for (const d of dabs) {
            const cx = d.x - t.x;
            const cy = d.y - t.y;
            const r = d.size / 2;
            if (cx + r < 0 || cy + r < 0 || cx - r > t.w || cy - r > t.h)
                continue;
            ctx.globalAlpha = d.alpha;
            ctx.drawImage(stamp, cx - r, cy - r, d.size, d.size);
        }
        ctx.globalAlpha = 1;
        const img = ctx.getImageData(0, 0, t.w, t.h);
        results.push({ tx: t.tx, ty: t.ty, w: t.w, h: t.h, data: img.data.buffer });
    }
    stamp.close?.();
    worker.postMessage({ id, results }, results.map(r => r.data));
};
