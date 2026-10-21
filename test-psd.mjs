// PSD 读写回环自检（Node 环境 + 浏览器 API 桩）
global.ImageData = class {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
};
global.document = {
  createElement: () => ({
    width: 0, height: 0, _img: null,
    getContext: () => function () {},
  }),
};
// readPSD 里用 canvas.getContext('2d').putImageData，换成对象桩
global.document.createElement = () => {
  const c = {
    width: 0, height: 0, img: null,
    getContext: () => ({ putImageData: (img) => { c.img = img; }, drawImage: () => {} }),
  };
  return c;
};

const { readPSD, writePSD } = await import('./js/psd.js');

const W = 37, H = 23; // 故意用非整数倍尺寸测 RLE 边界
function makeLayer(seed) {
  const img = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = (i * 7 + seed) % 256;
    img.data[i * 4 + 1] = (i * 3 + seed * 2) % 256;
    img.data[i * 4 + 2] = (i * 11 + seed * 5) % 256;
    img.data[i * 4 + 3] = (i % 5 === 0) ? 0 : 200 + (i + seed) % 56; // 含全透明点
  }
  return img;
}
const composite = makeLayer(99);

const bytes = writePSD({
  width: W, height: H,
  layers: [
    { name: '顶层 Lines', visible: true, opacity: 1, blend: 'multiply', imageData: makeLayer(1) },
    { name: '底色 中文名', visible: false, opacity: 0.5, blend: 'source-over', imageData: makeLayer(2) },
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
assert(parsed.layers[0].name === '顶层 Lines', '顶层名称(ASCII)一致: ' + parsed.layers[0].name);
assert(parsed.layers[1].name === '底色 中文名', '中文图层名(luni)一致: ' + parsed.layers[1].name);
assert(parsed.layers[1].visible === false, '隐藏标记一致');
assert(Math.abs(parsed.layers[1].opacity - 0.5) < 0.01, '不透明度一致: ' + parsed.layers[1].opacity);
assert(parsed.layers[0].blend === 'multiply', '混合模式一致: ' + parsed.layers[0].blend);

// 像素校验（顶层 = 文件第一个图层，seed=1）
const src = makeLayer(1).data;
const got = parsed.layers[0].canvas.img.data;
let diff = 0;
for (let i = 0; i < src.length; i++) if (src[i] !== got[i]) diff++;
assert(diff === 0, `像素完全一致（差异字节 ${diff}）`);

console.log(ok ? '\n全部通过 ✅' : '\n存在失败 ❌');
process.exit(ok ? 0 : 1);
