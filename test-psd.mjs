// PSD 读写回环自检（Node 环境 + 浏览器 API 桩）
global.ImageData = class {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
};

// 最小 canvas 桩：支持 putImageData / getImageData / 其余空实现
function makeStubCanvas() {
  const c = {
    width: 0, height: 0, _img: null,
    getContext: () => ({
      putImageData(img) { c._img = img; },
      getImageData(x, y, w, h) { return c._img || new ImageData(w, h); },
      drawImage() {}, clearRect() {}, fillRect() {}, save() {}, restore() {},
      set fillStyle(v) {}, get fillStyle() { return '#000'; },
      set globalAlpha(v) {}, set globalCompositeOperation(v) {},
      set transform(v) {},
    }),
  };
  return c;
}
global.document = { createElement: () => makeStubCanvas() };

const { readPSD, writePSD } = await import('./app/js/psd.js');

const W = 37, H = 23; // 非整数倍尺寸测 RLE 边界
function makeLayer(seed) {
  const img = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = (i * 7 + seed) % 256;
    img.data[i * 4 + 1] = (i * 3 + seed * 2) % 256;
    img.data[i * 4 + 2] = (i * 11 + seed * 5) % 256;
    img.data[i * 4 + 3] = (i % 5 === 0) ? 0 : 200 + (i + seed) % 56;
  }
  return img;
}

function canvasOf(img) {
  const c = makeStubCanvas();
  c.width = img.width;
  c.height = img.height;
  c.getContext().putImageData(img);
  return c;
}

const composite = makeLayer(99);

// 节点树：底层在前（与内部约定一致）
const bytes = writePSD({
  width: W, height: H,
  nodes: [
    { type: 'layer', name: '底色 中文名', visible: false, opacity: 0.5, blend: 'source-over', canvas: canvasOf(makeLayer(2)) },
    { type: 'layer', name: '顶层 Lines', visible: true, opacity: 1, blend: 'multiply', canvas: canvasOf(makeLayer(1)) },
  ],
  compositeImage: composite,
});
console.log('写入字节数:', bytes.length);

const parsed = readPSD(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
console.log('尺寸:', parsed.width, 'x', parsed.height, '| 图层数:', parsed.layers.length);

let ok = true;
function assert(cond, msg) { if (!cond) { ok = false; console.error('✗', msg); } else console.log('✓', msg); }

assert(parsed.width === W && parsed.height === H, '尺寸一致');
assert(parsed.layers.length === 2, '图层数一致');
const bottom = parsed.layers[0], top = parsed.layers[1];
assert(bottom.name === '底色 中文名', '中文图层名(luni)一致: ' + bottom.name);
assert(top.name === '顶层 Lines', '顶层名称(ASCII)一致: ' + top.name);
assert(bottom.visible === false, '隐藏标记一致');
assert(Math.abs(bottom.opacity - 0.5) < 0.01, '不透明度一致: ' + bottom.opacity);
assert(top.blend === 'multiply', '混合模式一致: ' + top.blend);

// 像素校验（顶层 seed=1）
const src = makeLayer(1).data;
const got = top.canvas._img.data;
let diff = 0;
for (let i = 0; i < src.length; i++) if (src[i] !== got[i]) diff++;
assert(diff === 0, `像素完全一致（差异字节 ${diff}）`);

console.log(ok ? '\n全部通过 ✅' : '\n存在失败 ❌');
process.exit(ok ? 0 : 1);
