// 笔刷抬笔提交 Worker：把 dab 批量画进瓦片，主线程只负责 before/after 快照。
// 源文件：app 运行时使用 app/js/brush-worker.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/brush-worker.js。
// DeepSeek 自 beta12 起参与落笔生花；beta20 增加此 Worker 提交路径。
//
// 消息：
//   { id, stamp: ImageBitmap, tiles: [{tx,ty,x,y,w,h,bmp}], dabs: [{x,y,size,alpha}] }
// 回复：
//   { id, results: [{tx,ty,w,h,data:ArrayBuffer}] }  （data 以 transfer 方式回传）
interface WorkerTile {
  tx: number;
  ty: number;
  x: number;
  y: number;
  w: number;
  h: number;
  bmp: ImageBitmap | null;
}

interface WorkerDab {
  x: number;
  y: number;
  size: number;
  alpha: number;
}

interface WorkerResult {
  tx: number;
  ty: number;
  w: number;
  h: number;
  data: ArrayBuffer;
}

interface WorkerRequest {
  id: number;
  stamp: ImageBitmap;
  tiles: WorkerTile[];
  dabs: WorkerDab[];
}

const worker = self as any;
worker.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { id, stamp, tiles, dabs } = ev.data;
  const results: WorkerResult[] = [];
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
      if (cx + r < 0 || cy + r < 0 || cx - r > t.w || cy - r > t.h) continue;
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
