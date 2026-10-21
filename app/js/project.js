// .lbsh 原生工程格式（v2）：ZIP 容器
//   manifest.json   工程元数据（尺寸、图层树、蒙版、剪贴、锁定）
//   layers/NNN.png  每个图层的整幅 PNG（保留透明）
//   masks/NNN.png   蒙版（alpha 通道即蒙版值）
//   thumb.png       首页/最近文件用缩略图
// v1（扁平 layers 数组）仍可读取。
import { zipWrite, zipRead } from './zip.js';

export const PROJECT_EXT = 'lbsh';
const FORMAT = 'luobishenghua-project';
const VERSION = 2;

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

async function pngToCanvas(u8, W, H) {
  const src = await pngToSource(u8);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').drawImage(src, 0, 0);
  if (src.close) src.close();
  return canvas;
}

async function collectNodes(nodes, files, counter) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'group') {
      const g = {
        type: 'group',
        name: n.name,
        visible: n.visible,
        opacity: n.opacity,
        blend: n.blend,
        locked: !!n.locked,
        clipping: !!n.clipping,
        expanded: n.expanded !== false,
      };
      if (n.mask) {
        const file = `masks/${String(counter.mask++).padStart(3, '0')}.png`;
        files.push({ name: file, data: await canvasToPng(n.mask.canvas) });
        g.mask = { file, enabled: n.mask.enabled !== false };
      }
      g.children = await collectNodes(n.children || [], files, counter);
      out.push(g);
    } else {
      const file = `layers/${String(counter.layer++).padStart(3, '0')}.png`;
      files.push({ name: file, data: await canvasToPng(n.canvas) });
      const d = {
        type: 'layer',
        name: n.name,
        visible: n.visible,
        opacity: n.opacity,
        blend: n.blend,
        locked: !!n.locked,
        lockAlpha: !!n.lockAlpha,
        clipping: !!n.clipping,
        file,
      };
      if (n.mask) {
        const mfile = `masks/${String(counter.mask++).padStart(3, '0')}.png`;
        files.push({ name: mfile, data: await canvasToPng(n.mask.canvas) });
        d.mask = { file: mfile, enabled: n.mask.enabled !== false };
      }
      out.push(d);
    }
  }
  return out;
}

async function restoreNodes(defs, files, W, H) {
  const out = [];
  for (const d of defs) {
    const base = {
      name: d.name,
      visible: d.visible !== false,
      opacity: typeof d.opacity === 'number' ? d.opacity : 1,
      blend: d.blend || 'source-over',
      locked: !!d.locked,
      clipping: !!d.clipping,
    };
    if (d.type === 'group') {
      const g = { ...base, type: 'group', expanded: d.expanded !== false };
      if (d.mask && d.mask.file) {
        const png = files.get(d.mask.file);
        if (png) g.maskCanvas = await pngToCanvas(png, W, H);
        g.maskEnabled = d.mask.enabled !== false;
      }
      g.children = await restoreNodes(d.children || [], files, W, H);
      out.push(g);
    } else {
      const l = { ...base, type: 'layer', lockAlpha: !!d.lockAlpha };
      const png = files.get(d.file);
      if (png) l.canvas = await pngToCanvas(png, W, H);
      if (d.mask && d.mask.file) {
        const m = files.get(d.mask.file);
        if (m) l.maskCanvas = await pngToCanvas(m, W, H);
        l.maskEnabled = d.mask.enabled !== false;
      }
      out.push(l);
    }
  }
  return out;
}

/**
 * 序列化当前文档为 .lbsh 字节
 * @returns {Promise<{bytes: Uint8Array, manifest: object}>}
 */
export async function serializeProject(layers, engine) {
  const files = [];
  const counter = { layer: 0, mask: 0 };
  const nodes = await collectNodes(layers.layers, files, counter);

  const manifest = {
    format: FORMAT,
    version: VERSION,
    app: '落笔生花 Luobishenghua',
    createdAt: new Date().toISOString(),
    width: layers.w,
    height: layers.h,
    activePath: layers.pathOf(layers.activeId),
    nodes,
  };

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
 * 解析 .lbsh 字节（v1 / v2）
 * @returns {Promise<{width,height,nodes:Array,activePath:Array|null,meta:object}>}
 */
export async function deserializeProject(bytes) {
  const files = await zipRead(bytes);
  const mf = files.get('manifest.json');
  if (!mf) throw new Error('缺少 manifest.json，不是落笔生花工程文件');

  const meta = JSON.parse(new TextDecoder().decode(mf));
  if (meta.format !== FORMAT) throw new Error('工程格式不匹配');
  if (!meta.width || !meta.height) throw new Error('工程缺少画布尺寸');
  if (meta.version > VERSION) throw new Error('工程版本过新，请升级软件');

  let nodes;
  if (meta.nodes) {
    nodes = await restoreNodes(meta.nodes, files, meta.width, meta.height);
  } else {
    // v1：扁平 layers 数组
    const defs = (meta.layers || []).map(d => ({
      type: 'layer', ...d,
    }));
    nodes = await restoreNodes(defs, files, meta.width, meta.height);
    if (typeof meta.activeIndex === 'number' && meta.activeIndex >= 0) {
      meta.activePath = [Math.min(meta.activeIndex, nodes.length - 1)];
    }
  }

  if (!nodes || nodes.length === 0) throw new Error('工程里没有可用图层');

  return {
    width: meta.width,
    height: meta.height,
    nodes,
    activePath: Array.isArray(meta.activePath) ? meta.activePath : null,
    meta,
  };
}
