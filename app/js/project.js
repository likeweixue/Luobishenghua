// .lbsh 原生工程格式：ZIP 容器
//   manifest.json   工程元数据（尺寸、图层属性、顺序）
//   layers/000.png  每个图层整幅 PNG（保留透明）
//   thumb.png       首页/最近文件用缩略图
import { zipWrite, zipRead } from './zip.js';

export const PROJECT_EXT = 'lbsh';
const FORMAT = 'luobishenghua-project';
const VERSION = 1;

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('图层编码失败')); return; }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

async function pngToSource(u8) {
  const blob = new Blob([u8], { type: 'image/png' });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* 回退 Image */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图层图片解码失败'));
    img.src = URL.createObjectURL(blob);
  });
}

/**
 * 序列化当前文档为 .lbsh 字节
 * @returns {Promise<{bytes: Uint8Array, manifest: object}>}
 */
export async function serializeProject(layers, engine) {
  const manifest = {
    format: FORMAT,
    version: VERSION,
    app: '落笔生花 Luobishenghua',
    createdAt: new Date().toISOString(),
    width: layers.w,
    height: layers.h,
    activeIndex: layers.activeIndex,
    layers: [],
  };

  const files = [];
  for (let i = 0; i < layers.layers.length; i++) {
    const l = layers.layers[i];
    const name = `layers/${String(i).padStart(3, '0')}.png`;
    files.push({ name, data: await canvasToPng(l.canvas) });
    manifest.layers.push({
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blend: l.blend,
      locked: l.locked,
      file: name,
    });
  }

  // 缩略图（最大边 320，不含棋盘格，透明区铺白）
  const k = Math.min(1, 320 / Math.max(layers.w, layers.h));
  const tw = Math.max(1, Math.round(layers.w * k));
  const th = Math.max(1, Math.round(layers.h * k));

  const flat = document.createElement('canvas');
  flat.width = layers.w;
  flat.height = layers.h;
  layers.composite(flat.getContext('2d'), { checkerboard: false });

  const t = document.createElement('canvas');
  t.width = tw;
  t.height = th;
  const tc = t.getContext('2d');
  tc.imageSmoothingQuality = 'high';
  tc.fillStyle = '#ffffff';
  tc.fillRect(0, 0, tw, th);
  tc.drawImage(flat, 0, 0, tw, th);
  files.push({ name: 'thumb.png', data: await canvasToPng(t) });

  files.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

  return { bytes: zipWrite(files), manifest };
}

/**
 * 解析 .lbsh 字节
 * @returns {Promise<{width,height,layers:Array,activeIndex:number,meta:object}>}
 */
export async function deserializeProject(bytes) {
  const files = await zipRead(bytes);
  const mf = files.get('manifest.json');
  if (!mf) throw new Error('缺少 manifest.json，不是落笔生花工程文件');

  const meta = JSON.parse(new TextDecoder().decode(mf));
  if (meta.format !== FORMAT) throw new Error('工程格式不匹配');
  if (!meta.width || !meta.height) throw new Error('工程缺少画布尺寸');
  if (meta.version > VERSION) throw new Error('工程版本过新，请升级软件');

  const out = [];
  for (const d of meta.layers || []) {
    const png = files.get(d.file);
    if (!png) continue;
    const src = await pngToSource(png);
    const canvas = document.createElement('canvas');
    canvas.width = meta.width;
    canvas.height = meta.height;
    canvas.getContext('2d').drawImage(src, 0, 0);
    if (src.close) src.close();
    out.push({
      name: d.name || '图层',
      visible: d.visible !== false,
      opacity: typeof d.opacity === 'number' ? d.opacity : 1,
      blend: d.blend || 'source-over',
      locked: !!d.locked,
      canvas,
    });
  }
  if (out.length === 0) throw new Error('工程里没有可用图层');

  return {
    width: meta.width,
    height: meta.height,
    layers: out,
    activeIndex: typeof meta.activeIndex === 'number' ? meta.activeIndex : out.length - 1,
    meta,
  };
}
