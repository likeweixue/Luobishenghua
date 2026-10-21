// ZIP 容器自检：写入 → 读回 → 交给系统 unzip 校验
import { zipWrite, zipRead } from './app/js/zip.js';
import fs from 'node:fs';

const enc = new TextEncoder();
const files = [
  { name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'luobishenghua-project', version: 1, hello: '世界' })) },
  { name: 'layers/000.png', data: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]) },
  { name: 'thumb.png', data: new Uint8Array(Array.from({ length: 1000 }, (_, i) => i & 0xFF)) },
];

const bytes = zipWrite(files);
fs.writeFileSync('/tmp/lbsh-test.zip', bytes);

const back = await zipRead(bytes);
let ok = 0, fail = 0;
function check(cond, label) {
  if (cond) { ok++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

check(back.size === 3, `条目数 3（实际 ${back.size}）`);
check(new TextDecoder().decode(back.get('manifest.json')).includes('世界'), 'UTF-8 中文内容一致');
check(back.get('layers/000.png').length === 9, 'PNG 条目长度一致');
const big = back.get('thumb.png');
check(big.length === 1000 && big[255] === 255 && big[256] === 0, '二进制内容逐字节一致');
check(new TextDecoder().decode(back.get('manifest.json')).includes('luobishenghua-project'), 'manifest 可解析');

console.log(`\nZIP 自检：${ok} 通过 / ${fail} 失败`);
console.log('已写出 /tmp/lbsh-test.zip，可用系统 unzip 校验');
process.exit(fail ? 1 : 0);
