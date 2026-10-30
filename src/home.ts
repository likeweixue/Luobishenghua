// 源文件：app 运行时使用 app/js/home.js，由 `npm run build:ts` 从本文件生成；请勿直接改 app/js/home.js。
// 首页 / 欢迎页：新建预设、打开文件、最近文件
import { icon } from './icons.js';

const RECENT_KEY = 'lbsh-recents';
const MAX_RECENTS = 8;

export const PRESETS: any[] = [
  { id: 'a4',     name: 'A4 印刷',  w: 2480, h: 3508, hint: '300 DPI' },
  { id: 'a3',     name: 'A3 印刷',  w: 3508, h: 4961, hint: '300 DPI' },
  { id: 'square', name: '正方形',   w: 2048, h: 2048, hint: '插画' },
  { id: 'uhd',    name: '4K 横屏',  w: 3840, h: 2160, hint: '16:9' },
  { id: 'fhd',    name: '1080P',    w: 1920, h: 1080, hint: '16:9' },
  { id: 'comic',  name: '漫画稿',   w: 2100, h: 3000, hint: 'B5' },
  { id: 'screen', name: '屏幕设计', w: 1440, h: 900,  hint: '桌面' },
  { id: 'sticker',name: '表情包',   w: 512,  h: 512,  hint: '贴纸' },
];

/* ---------------- 最近文件存储 ---------------- */

export function getRecents(): any[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addRecent(entry: any): void {
  if (!entry || !entry.name) return;
  const list = getRecents().filter(r =>
    (entry.path && r.path === entry.path) || (!entry.path && r.name === entry.name)
  );
  list.unshift({ ...entry, ts: Date.now() });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch { /* 存储满时忽略 */ }
  renderRecents();
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/* ---------------- 渲染 ---------------- */

function fitSize(w, h, maxW, maxH) {
  const k = Math.min(maxW / w, maxH / h);
  return { width: Math.max(7, Math.round(w * k)), height: Math.max(7, Math.round(h * k)) };
}

function renderPresets(onCreateDoc) {
  const grid = document.getElementById('preset-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset';
    btn.title = `${p.name} · ${p.w} × ${p.h} 像素${p.hint ? ` · ${p.hint}` : ''}`;

    const thumb = document.createElement('span');
    thumb.className = 'pthumb';
    const sheet = document.createElement('span');
    sheet.className = 'psheet';
    const size = fitSize(p.w, p.h, 76, 50);
    sheet.style.width = size.width + 'px';
    sheet.style.height = size.height + 'px';
    thumb.appendChild(sheet);

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;

    const dim = document.createElement('span');
    dim.className = 'pdim';
    dim.textContent = `${p.w} × ${p.h}`;

    btn.append(thumb, name, dim);
    btn.addEventListener('click', () => onCreateDoc(p.w, p.h));
    grid.appendChild(btn);
  }
}

let openRecentHandler = null;

export function renderRecents(onOpenRecent?: (entry: any) => void): void {
  if (onOpenRecent) openRecentHandler = onOpenRecent;
  const listEl = document.getElementById('recent-list');
  if (!listEl) return;
  const recents = getRecents();
  listEl.innerHTML = '';

  if (recents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.innerHTML = '还没有最近文件<br>新建画布或打开一个 PSD 后会出现在这里';
    listEl.appendChild(empty);
    return;
  }

  for (const r of recents) {
    const row = document.createElement('div');
    row.className = 'recent';
    row.title = r.path || `${r.name}（浏览器预览下需重新选择文件）`;

    const ico = document.createElement('span');
    ico.className = 'rico';
    ico.innerHTML = icon('doc');

    const meta = document.createElement('span');
    meta.className = 'rmeta';
    const nm = document.createElement('span');
    nm.className = 'rname';
    nm.textContent = r.name;
    const sub = document.createElement('span');
    sub.className = 'rsub';
    const dims = r.w && r.h ? `${r.w} × ${r.h} · ` : '';
    sub.textContent = dims + timeAgo(r.ts || Date.now());
    meta.append(nm, sub);

    const badge = document.createElement('span');
    badge.className = 'rbadge';
    badge.textContent = r.path ? 'PSD' : '需重选';

    row.append(ico, meta, badge);
    row.addEventListener('click', () => openRecentHandler && openRecentHandler(r));
    listEl.appendChild(row);
  }
}

/* ---------------- 初始化 ---------------- */

export function createHome(opts: any): any {
  const { onCreateDoc, onOpenPSD, onImportABR, onOpenRecent, onClose, hasDocument } = opts;

  renderPresets(onCreateDoc);
  renderRecents(onOpenRecent);

  document.getElementById('home-new').addEventListener('click', () => {
    // 复用「新建文档」对话框，自定义尺寸
    if (opts.onNewDialog) opts.onNewDialog();
  });
  document.getElementById('home-open').addEventListener('click', () => onOpenPSD());
  document.getElementById('home-abr').addEventListener('click', () => onImportABR());
  document.getElementById('home-close').addEventListener('click', () => onClose());

  // 最近文件点击时的默认行为由 main 注入
  return {
    show() {
      renderRecents(onOpenRecent);
      const closeBtn = document.getElementById('home-close');
      closeBtn.style.display = hasDocument() ? '' : 'none';
      document.getElementById('home').classList.remove('hidden');
    },
    hide() {
      document.getElementById('home').classList.add('hidden');
    },
    get visible() {
      return !document.getElementById('home').classList.contains('hidden');
    },
  };
}

/* ---------------- 轻提示 ---------------- */

let toastTimer = null;
export function toast(msg: string, ms: number = 2200): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
