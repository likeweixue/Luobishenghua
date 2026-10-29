// 零依赖浏览器回归测试：启动静态服务器 + headless Chrome，逐个跑 test-*.html。
// 用法：npm test            （需要本机安装 Chrome / Chromium）
//      CHROME_BIN=/path/to/chrome npm test
//      TEST_PAGES=test-gpu.html npm test
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = (process.env.TEST_PAGES ||
  'test-engine.html,test-n1.html,test-n2.html,test-n3.html,test-n5.html,test-tiles.html,test-brush.html,test-gpu.html')
  .split(',').map(s => s.trim()).filter(Boolean);
const PAGE_TIMEOUT = Number(process.env.TEST_TIMEOUT_MS) || 30000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (fs.existsSync(c)) return c;
    } else {
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' });
      if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();
    }
  }
  return null;
}

async function waitOk(url, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* retry */ }
    await sleep(120);
  }
  throw new Error('timeout waiting for ' + url);
}

async function waitJson(url, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(120);
  }
  throw new Error('timeout waiting for ' + url);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      let id = 0;
      const pending = new Map();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      };
      const send = (method, params = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
      resolve({ ws, send });
    };
    ws.onerror = reject;
  });
}

async function run() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.error('找不到 Chrome / Chromium；请设置 CHROME_BIN 或安装 Google Chrome。');
    process.exit(1);
  }

  const serverPort = 8620 + Math.floor(Math.random() * 200);
  const debugPort = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lbsh-test-'));
  const server = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(serverPort) },
    stdio: 'ignore',
  });
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });

  let failed = 0;
  let passed = 0;
  try {
    await waitOk(`http://127.0.0.1:${serverPort}/app/`, 8000);
    const targets = await waitJson(`http://127.0.0.1:${debugPort}/json/list`, 15000);
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('no Chrome page target');
    const { ws, send } = await connect(page.webSocketDebuggerUrl);
    await send('Page.enable');
    await send('Runtime.enable');

    for (const name of PAGES) {
      const url = `http://127.0.0.1:${serverPort}/${name}`;
      let title = '';
      let detail = '';
      let ok = false;
      try {
        await send('Page.navigate', { url });
        await sleep(500);
        const end = Date.now() + PAGE_TIMEOUT;
        while (Date.now() < end) {
          const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
          title = r.result?.value || '';
          if (/^PASS\b/.test(title) || title === 'BENCH DONE' || /^FAIL\b/.test(title) || /^ERROR\b/.test(title)) break;
          await sleep(200);
        }
        const out = await send('Runtime.evaluate', {
          expression: "(document.getElementById('out')?.textContent || '').split('\\n').filter(Boolean).slice(0, 2).join(' | ')",
          returnByValue: true,
        });
        detail = out.result?.value || '';
        ok = /^PASS\b/.test(title) || title === 'BENCH DONE';
      } catch (err) {
        title = 'ERROR';
        detail = String(err && err.message || err);
      }
      if (ok) passed++;
      else failed++;
      console.log(`${ok ? '✅' : '❌'} ${name.padEnd(18)} ${title || '(no title)'}  ${detail}`);
    }
    // 应用级端到端：真实指针画一笔 → GPU 预览 → 抬笔提交 → 撤销 / 重做
    let e2eOk = false;
    let e2eDetail = '';
    try {
      await send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/app/?nohome=1` });
      await sleep(2200);
      const info = await send('Runtime.evaluate', {
        expression: `(() => {
          const c = document.getElementById('canvas');
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, has: !!window.__lbsh };
        })()`,
        returnByValue: true,
      });
      const r = info.result?.value;
      if (!r || !r.has) throw new Error('app / __lbsh not ready');
      const sx = Math.round(r.x + r.w * 0.38);
      const sy = Math.round(r.y + r.h * 0.38);
      const ex = Math.round(r.x + r.w * 0.62);
      const ey = Math.round(r.y + r.h * 0.62);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 6; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(sx + (ex - sx) * i / 6),
          y: Math.round(sy + (ey - sy) * i / 6),
          button: 'left', buttons: 1,
        });
        await sleep(35);
      }
      const mid = await send('Runtime.evaluate', {
        expression: `(() => { const s = window.__lbsh.state; return { gpuStroke: !!s.gpuStroke, dabs: s.gpuStroke ? s.gpuStroke.dabs.length : 0, preview: !!__lbsh.engine.gpu.brushPreview, drawing: !!s.drawing }; })()`,
        returnByValue: true,
      });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(450);
      const after = await send('Runtime.evaluate', {
        expression: `(() => {
          const l = __lbsh.layers.active;
          const h = __lbsh.history;
          return {
            gpuStroke: !!__lbsh.state.gpuStroke,
            preview: !!__lbsh.engine.gpu.brushPreview,
            tiles: l ? [...l.surface.tiles.values()].length : 0,
            undo: h.undoStack.length,
            redo: h.redoStack.length,
            gpu: document.getElementById('status-gpu')?.textContent || '',
          };
        })()`,
        returnByValue: true,
      });
      const undo = await send('Runtime.evaluate', {
        expression: `(() => {
          const h = __lbsh.history;
          const before = h.undoStack.length;
          h.undo();
          const undone = h.undoStack.length;
          const redo = h.redoStack.length;
          h.redo();
          return { before, undone, redoAfterUndo: redo, afterRedo: h.undoStack.length };
        })()`,
        returnByValue: true,
      });
      const m = mid.result?.value || {};
      const a = after.result?.value || {};
      const u = undo.result?.value || {};
      e2eDetail = JSON.stringify({ mid: m, after: a, undo: u });
      e2eOk = m.gpuStroke && m.dabs > 0 && m.preview && m.drawing
        && !a.gpuStroke && !a.preview && a.tiles > 0 && a.undo >= 1 && a.gpu === 'GPU'
        && u.before >= 1 && u.undone === u.before - 1 && u.redoAfterUndo >= 1 && u.afterRedo === u.before;
    } catch (err) {
      e2eDetail = String(err && err.message || err);
    }
    if (e2eOk) passed++;
    else failed++;
    console.log(`${e2eOk ? '✅' : '❌'} ${'app-e2e'.padEnd(18)} ${e2eOk ? 'PASS' : 'FAIL'}  ${e2eDetail}`);
    ws.close();
  } catch (err) {
    console.error('测试运行失败：' + (err && err.message || err));
    failed++;
  } finally {
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n浏览器测试：${passed} 个页面通过 / ${failed} 个失败`);
  process.exitCode = failed ? 1 : 0;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
