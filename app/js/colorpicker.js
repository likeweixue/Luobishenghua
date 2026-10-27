// PS 风格拾色器：SV 方块 + 色相条 + RGB/HSV/十六进制输入，实时预览。
import { showModal, hideModal } from './menu.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function normalizeHex(input) {
  let h = String(input || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return '#' + h.toLowerCase();
}

export function hexToRgb(hex) {
  const h = normalizeHex(hex) || '#000000';
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

export function rgbToHex(r, g, b) {
  const to = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1);
  v = clamp(v, 0, 1);
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function hsvToHex(h, s, v) {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

function setupCanvas(canvas, w, h) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * 打开拾色器。
 * @param {string} initial 初始颜色
 * @param {{title?:string,onPreview?:(hex:string)=>void,onCommit?:(hex:string)=>void}} opts
 */
export function openColorPicker(initial, opts = {}) {
  const oldHex = normalizeHex(initial) || '#000000';
  const start = hexToRgb(oldHex);
  let hsv = rgbToHsv(start.r, start.g, start.b);
  let current = oldHex;
  const onPreview = typeof opts.onPreview === 'function' ? opts.onPreview : null;
  const onCommit = typeof opts.onCommit === 'function' ? opts.onCommit : null;
  let closed = false;
  let modal = null;

  const body = `
    <div class="cp-wrap">
      <div class="cp-sv-box">
        <canvas id="cp-sv"></canvas>
        <div id="cp-sv-cursor"></div>
      </div>
      <canvas id="cp-hue" class="cp-hue"></canvas>
      <div class="cp-fields">
        <div class="cp-preview" title="新颜色 / 原颜色">
          <span id="cp-new"></span><span id="cp-old"></span>
        </div>
        <div class="cp-model">
          <div class="cp-model-row"><span>R</span><input id="cp-r"><span>G</span><input id="cp-g"><span>B</span><input id="cp-b"></div>
          <div class="cp-model-row"><span>H</span><input id="cp-h"><span>S</span><input id="cp-s"><span>V</span><input id="cp-v"></div>
        </div>
        <div class="cp-hex-line"><label>#</label><input id="cp-hex" maxlength="7" spellcheck="false"></div>
      </div>
    </div>
    <div class="form-actions">
      <button id="cp-cancel">取消</button>
      <button id="cp-ok" class="primary">确定</button>
    </div>`;

  let overlayEl = null;
  let onOverlay = null;
  let onUp = null;
  const cleanup = () => {
    window.removeEventListener('keydown', onKey, true);
    if (onUp) window.removeEventListener('pointerup', onUp);
    if (overlayEl && onOverlay) overlayEl.removeEventListener('pointerdown', onOverlay);
  };
  const close = (applyOld) => {
    if (closed) return;
    closed = true;
    cleanup();
    if (applyOld && onPreview) onPreview(oldHex);
    if (modal) modal.classList.remove('color-picker-modal');
    hideModal();
  };
  const onKey = (e) => {
    if (closed) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
      e.preventDefault();
      commit();
    }
  };
  const commit = () => {
    if (closed) return;
    if (onCommit) onCommit(current);
    close(false);
  };

  showModal(opts.title || '拾色器', body, (m) => {
    modal = m;
    modal.classList.add('color-picker-modal');

    const sv = modal.querySelector('#cp-sv');
    const hue = modal.querySelector('#cp-hue');
    const cursor = modal.querySelector('#cp-sv-cursor');
    const svCtx = setupCanvas(sv, 240, 176);
    const hueCtx = setupCanvas(hue, 17, 176);
    const newChip = modal.querySelector('#cp-new');
    const oldChip = modal.querySelector('#cp-old');
    oldChip.style.background = oldHex;
    const inputs = {
      r: modal.querySelector('#cp-r'),
      g: modal.querySelector('#cp-g'),
      b: modal.querySelector('#cp-b'),
      h: modal.querySelector('#cp-h'),
      s: modal.querySelector('#cp-s'),
      v: modal.querySelector('#cp-v'),
      hex: modal.querySelector('#cp-hex'),
    };
    let updating = false;

    const paintSV = () => {
      const w = 240, h = 176;
      svCtx.fillStyle = hsvToHex(hsv.h, 1, 1);
      svCtx.fillRect(0, 0, w, h);
      const white = svCtx.createLinearGradient(0, 0, w, 0);
      white.addColorStop(0, 'rgba(255,255,255,1)');
      white.addColorStop(1, 'rgba(255,255,255,0)');
      svCtx.fillStyle = white;
      svCtx.fillRect(0, 0, w, h);
      const black = svCtx.createLinearGradient(0, 0, 0, h);
      black.addColorStop(0, 'rgba(0,0,0,0)');
      black.addColorStop(1, 'rgba(0,0,0,1)');
      svCtx.fillStyle = black;
      svCtx.fillRect(0, 0, w, h);
      cursor.style.left = (hsv.s * w) + 'px';
      cursor.style.top = ((1 - hsv.v) * h) + 'px';
    };

    const paintHue = () => {
      const h = 176;
      const g = hueCtx.createLinearGradient(0, 0, 0, h);
      for (let i = 0; i <= 6; i++) {
        g.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
      }
      hueCtx.fillStyle = g;
      hueCtx.fillRect(0, 0, 17, h);
      hueCtx.strokeStyle = '#fff';
      hueCtx.lineWidth = 1.5;
      const y = (hsv.h / 360) * h;
      hueCtx.beginPath();
      hueCtx.moveTo(0, y);
      hueCtx.lineTo(17, y);
      hueCtx.stroke();
      hueCtx.strokeStyle = 'rgba(0,0,0,.55)';
      hueCtx.lineWidth = 1;
      hueCtx.beginPath();
      hueCtx.moveTo(0, y + 1.5);
      hueCtx.lineTo(17, y + 1.5);
      hueCtx.stroke();
    };

    const paintAll = () => {
      current = hsvToHex(hsv.h, hsv.s, hsv.v);
      paintSV();
      paintHue();
      newChip.style.background = current;
      if (onPreview) onPreview(current);
      updating = true;
      if (document.activeElement !== inputs.hex) inputs.hex.value = current.toUpperCase();
      const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
      if (document.activeElement !== inputs.r) inputs.r.value = rgb.r;
      if (document.activeElement !== inputs.g) inputs.g.value = rgb.g;
      if (document.activeElement !== inputs.b) inputs.b.value = rgb.b;
      if (document.activeElement !== inputs.h) inputs.h.value = Math.round(hsv.h);
      if (document.activeElement !== inputs.s) inputs.s.value = Math.round(hsv.s * 100);
      if (document.activeElement !== inputs.v) inputs.v.value = Math.round(hsv.v * 100);
      updating = false;
    };

    const svPoint = (e) => {
      const r = sv.getBoundingClientRect();
      hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
      hsv.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
      paintAll();
    };
    const huePoint = (e) => {
      const r = hue.getBoundingClientRect();
      hsv.h = clamp((e.clientY - r.top) / r.height, 0, 0.99999) * 360;
      paintAll();
    };

    let drag = null;
    const down = (e, fn) => {
      e.preventDefault();
      drag = fn;
      e.target.setPointerCapture?.(e.pointerId);
      fn(e);
    };
    sv.addEventListener('pointerdown', e => down(e, svPoint));
    hue.addEventListener('pointerdown', e => down(e, huePoint));
    sv.addEventListener('pointermove', e => { if (drag === svPoint) svPoint(e); });
    hue.addEventListener('pointermove', e => { if (drag === huePoint) huePoint(e); });
    onUp = () => { drag = null; };
    window.addEventListener('pointerup', onUp);

    const bindNum = (el, apply) => {
      el.addEventListener('input', () => {
        if (updating) return;
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        apply(v);
        paintAll();
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    };
    bindNum(inputs.r, v => { const c = hsvToRgb(hsv.h, hsv.s, hsv.v); const rgb = { ...c, r: clamp(v, 0, 255) }; Object.assign(hsv, rgbToHsv(rgb.r, rgb.g, rgb.b)); });
    bindNum(inputs.g, v => { const c = hsvToRgb(hsv.h, hsv.s, hsv.v); const rgb = { ...c, g: clamp(v, 0, 255) }; Object.assign(hsv, rgbToHsv(rgb.r, rgb.g, rgb.b)); });
    bindNum(inputs.b, v => { const c = hsvToRgb(hsv.h, hsv.s, hsv.v); const rgb = { ...c, b: clamp(v, 0, 255) }; Object.assign(hsv, rgbToHsv(rgb.r, rgb.g, rgb.b)); });
    bindNum(inputs.h, v => { hsv.h = clamp(v, 0, 360) % 360; });
    bindNum(inputs.s, v => { hsv.s = clamp(v, 0, 100) / 100; });
    bindNum(inputs.v, v => { hsv.v = clamp(v, 0, 100) / 100; });

    inputs.hex.addEventListener('input', () => {
      if (updating) return;
      const hex = normalizeHex(inputs.hex.value);
      if (!hex) return;
      const rgb = hexToRgb(hex);
      Object.assign(hsv, rgbToHsv(rgb.r, rgb.g, rgb.b));
      paintAll();
    });
    inputs.hex.addEventListener('blur', () => {
      if (!normalizeHex(inputs.hex.value)) inputs.hex.value = current.toUpperCase();
    });
    inputs.hex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });

    modal.querySelector('#cp-ok').addEventListener('click', commit);
    modal.querySelector('#cp-cancel').addEventListener('click', () => close(true));
    // 点击遮罩视为取消，并还原颜色
    overlayEl = document.getElementById('modal-overlay');
    onOverlay = (e) => { if (e.target === overlayEl) close(true); };
    overlayEl.addEventListener('pointerdown', onOverlay);
    window.addEventListener('keydown', onKey, true);

    paintAll();
    inputs.hex.focus();
    inputs.hex.select();
  });
}
