// WebGL2 合成器
// DeepSeek 自 beta12 起参与落笔生花，beta13 落地简单图层合成，beta15 扩展组 / 蒙版 / 混合模式。
//
// 两条路径：
//   1. simple：普通图层 + 正常混合 + 无蒙版 / 无组，直接 draw 到默认帧缓冲（最快）
//   2. complex：组 / 蒙版 / 非正常混合，走 screen-size FBO 合成：
//      - 场景 ping-pong，支持正片叠底 / 滤色 / 叠加 / 柔光 / 变暗 / 变亮 /
//        颜色减淡 / 线性减淡（lighter）等
//      - 组先渲染到独立 FBO，再按组不透明度 / 蒙版 / 混合模式并回父级
//      - 图层蒙版在瓦片 shader 中按 alpha 采样；组蒙版用 destination-in 乘到组 FBO
//      - 剪贴蒙版 / 层级过深 / 瓦片超限仍回退 Canvas2D
//
// 瓦片按修订号增量上传纹理；GPU 只负责屏幕内容，engine.doc 仍由 Canvas2D 空闲合成。

const VS = `#version 300 es
layout(location = 0) in vec2 a_unit;
uniform vec4 u_rect;
uniform vec2 u_translate;
uniform mat2 u_rot;
uniform float u_scale;
uniform vec2 u_size;
out vec2 v_uv;
out vec2 v_world;
void main() {
  vec2 world = u_rect.xy + a_unit * u_rect.zw;
  v_world = world;
  v_uv = vec2(a_unit.x, 1.0 - a_unit.y);
  vec2 s = u_translate + u_rot * (world * u_scale);
  gl_Position = vec4(s.x / u_size.x * 2.0 - 1.0, 1.0 - s.y / u_size.y * 2.0, 0.0, 1.0);
}`;

const VS_FULL = `#version 300 es
layout(location = 0) in vec2 a_unit;
out vec2 v_uv;
void main() {
  v_uv = a_unit;
  gl_Position = vec4(a_unit * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_TILE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform float u_hasMask;
uniform float u_opacity;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_hasMask > 0.5) c *= texture(u_mask, v_uv).a;
  outColor = c * u_opacity;
}`;

const FS_CHECKER = `#version 300 es
precision highp float;
in vec2 v_world;
uniform vec4 u_doc;
uniform float u_scale;
out vec4 outColor;
void main() {
  vec2 cell = floor(v_world / 8.0);
  float k = mod(cell.x + cell.y, 2.0);
  vec3 col = mix(vec3(0.851, 0.851, 0.851), vec3(1.0), k);
  float edge = min(
    min(v_world.x - u_doc.x, u_doc.x + u_doc.z - v_world.x),
    min(v_world.y - u_doc.y, u_doc.y + u_doc.w - v_world.y)
  );
  if (edge < 0.8 / max(u_scale, 0.001)) col = mix(col, vec3(1.0), 0.18);
  outColor = vec4(col, 1.0);
}`;

const FS_SHADOW = `#version 300 es
precision highp float;
in vec2 v_world;
uniform vec4 u_doc;
uniform float u_scale;
out vec4 outColor;
void main() {
  vec2 d = max(max(u_doc.xy - v_world, v_world - (u_doc.xy + u_doc.zw)), 0.0);
  float dist = length(d);
  float blur = 30.0 / max(u_scale, 0.001);
  float a = 0.18 * exp(-dist * 2.4 / blur);
  outColor = vec4(0.0, 0.0, 0.0, a);
}`;

const FS_BLIT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv) * u_opacity;
}`;

const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_dst;
uniform int u_mode;
uniform float u_opacity;
out vec4 outColor;

vec3 blendMode(int mode, vec3 cb, vec3 cs) {
  if (mode == 1) return cb * cs;                                  // multiply
  if (mode == 2) return cb + cs - cb * cs;                        // screen
  if (mode == 3) {                                                // overlay
    vec3 lo = 2.0 * cb * cs;
    vec3 hi = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
    return mix(lo, hi, step(vec3(0.5), cb));
  }
  if (mode == 4) {                                                // soft-light
    vec3 d = mix(((16.0 * cb - 12.0) * cb + 4.0) * cb, sqrt(cb), step(vec3(0.25), cb));
    vec3 lo = cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    vec3 hi = cb + (2.0 * cs - 1.0) * (d - cb);
    return mix(lo, hi, step(vec3(0.5), cs));
  }
  if (mode == 5) return min(cb, cs);                              // darken
  if (mode == 6) return max(cb, cs);                              // lighten
  if (mode == 7) {                                                // color-dodge
    vec3 c = vec3(0.0);
    c.r = cb.r <= 0.0 ? 0.0 : (cs.r >= 1.0 ? 1.0 : min(1.0, cb.r / (1.0 - cs.r)));
    c.g = cb.g <= 0.0 ? 0.0 : (cs.g >= 1.0 ? 1.0 : min(1.0, cb.g / (1.0 - cs.g)));
    c.b = cb.b <= 0.0 ? 0.0 : (cs.b >= 1.0 ? 1.0 : min(1.0, cb.b / (1.0 - cs.b)));
    return c;
  }
  if (mode == 8) return min(vec3(1.0), cb + cs);                  // lighter / linear dodge
  return cs;                                                      // normal
}

void main() {
  vec4 s = texture(u_src, v_uv) * u_opacity;
  vec4 d = texture(u_dst, v_uv);
  float sa = s.a;
  float da = d.a;
  if (sa <= 0.0) { outColor = d; return; }
  vec3 cs = s.rgb / sa;
  vec3 cb = da > 0.0001 ? d.rgb / da : vec3(0.0);
  vec3 b = blendMode(u_mode, cb, cs);
  vec3 co = s.rgb * (1.0 - da) + sa * da * b + d.rgb * (1.0 - sa);
  float ao = sa + da * (1.0 - sa);
  outColor = vec4(clamp(co, 0.0, 1.0), clamp(ao, 0.0, 1.0));
}`;

const BLEND_IDS = {
  'source-over': 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  'soft-light': 4,
  darken: 5,
  lighten: 6,
  'color-dodge': 7,
  lighter: 8,
};

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader: ' + log);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('program: ' + log);
  }
  return p;
}

export class GpuRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    this.ok = !!this.gl;
    this.error = null;
    this.tex = new Map();   // tile.canvas -> { tex, rev, last }
    this.frame = 0;
    this.maxTiles = 800;              // 超过就回退 Canvas2D，避免 GPU 纹理爆内存
    this.maxBytes = 200 * 1024 * 1024;
    this.maxDepth = 4;                // 组嵌套深度上限（超过回退）
    this.lastInfo = null;
    this.lastPlan = null;
    this.fboPool = [];
    this._fboW = 0;
    this._fboH = 0;
    if (!this.ok) { this.error = 'WebGL2 unavailable'; return; }
    try {
      this._init();
    } catch (err) {
      this.ok = false;
      this.error = String(err && err.message || err);
      console.warn('[GPU]', this.error);
    }
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ok = false;
      this.error = 'context lost';
      if (this.onLost) this.onLost();
    });
  }

  _init() {
    const gl = this.gl;
    this.tileProg = program(gl, VS, FS_TILE);
    this.checkerProg = program(gl, VS, FS_CHECKER);
    this.shadowProg = program(gl, VS, FS_SHADOW);
    this.blitProg = program(gl, VS_FULL, FS_BLIT);
    this.compProg = program(gl, VS_FULL, FS_COMPOSITE);

    const loc = (p, names) => {
      const o = {};
      for (const n of names) o[n] = gl.getUniformLocation(p, 'u_' + n);
      return o;
    };
    this.u = {
      tile: {
        ...loc(this.tileProg, ['rect', 'translate', 'rot', 'scale', 'size', 'tex', 'mask', 'hasMask', 'opacity']),
      },
      checker: {
        ...loc(this.checkerProg, ['rect', 'translate', 'rot', 'scale', 'size', 'doc']),
      },
      shadow: {
        ...loc(this.shadowProg, ['rect', 'translate', 'rot', 'scale', 'size', 'doc']),
      },
      blit: loc(this.blitProg, ['tex', 'opacity']),
      comp: loc(this.compProg, ['src', 'dst', 'mode', 'opacity']),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    this.whiteTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this.lastInfo = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  /** 结构分析：返回 { ok, complex, tiles, bytes, reason } */
  analyze(layers) {
    const info = { ok: true, complex: false, tiles: 0, bytes: 0, reason: '' };
    if (!this.ok || !layers) {
      info.ok = false;
      info.reason = 'unavailable';
      return info;
    }
    const addMask = (mask) => {
      const s = mask && mask.enabled ? mask.surface : null;
      if (!s) return;
      info.tiles += s.tileCount;
      info.bytes += s.byteSize();
    };
    const walk = (nodes, depth) => {
      for (const node of nodes || []) {
        if (!info.ok) return;
        if (!node || !node.visible || node.opacity <= 0) continue;
        if (node.clipping) { info.ok = false; info.reason = 'clipping'; return; }
        const blend = node.blend || 'source-over';
        if (BLEND_IDS[blend] === undefined) {
          info.ok = false;
          info.reason = 'blend:' + blend;
          return;
        }
        if (node.type === 'group') {
          info.complex = true;
          if (depth >= this.maxDepth) {
            info.ok = false;
            info.reason = 'depth';
            return;
          }
          if (node.mask && node.mask.enabled) {
            info.complex = true;
            addMask(node.mask);
          }
          walk(node.children || [], depth + 1);
        } else {
          if (!node.surface) {
            info.ok = false;
            info.reason = 'surface';
            return;
          }
          if (blend !== 'source-over' || (node.mask && node.mask.enabled)) info.complex = true;
          info.tiles += node.surface.tileCount;
          info.bytes += node.surface.byteSize();
          if (node.mask && node.mask.enabled) addMask(node.mask);
        }
      }
    };
    walk(layers.layers || [], 0);
    if (info.ok && (info.tiles > this.maxTiles || info.bytes > this.maxBytes)) {
      info.ok = false;
      info.reason = 'cap';
    }
    this.lastPlan = info;
    return info;
  }

  /** 当前图层结构是否可由 GPU 路径正确合成 */
  canRender(layers) {
    return this.analyze(layers).ok;
  }

  _texture(tile) {
    const gl = this.gl;
    let e = this.tex.get(tile.canvas);
    if (!e) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile.canvas);
      e = { tex, rev: tile.rev, last: this.frame };
      this.tex.set(tile.canvas, e);
    } else if (e.rev !== tile.rev) {
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile.canvas);
      e.rev = tile.rev;
      e.last = this.frame;
    }
    e.last = this.frame;
    return e.tex;
  }

  _evict() {
    const gl = this.gl;
    if (this.tex.size > 64) {
      for (const [canvas, e] of [...this.tex.entries()]) {
        if (e.last < this.frame - 180) {
          gl.deleteTexture(e.tex);
          this.tex.delete(canvas);
        }
      }
    }
    if (this.tex.size <= 900) return;
    const entries = [...this.tex.entries()];
    entries.sort((a, b) => a[1].last - b[1].last);
    for (const [canvas, e] of entries) {
      if (this.tex.size <= 800) break;
      if (e.last === this.frame) continue;
      gl.deleteTexture(e.tex);
      this.tex.delete(canvas);
    }
  }

  /* ---------------- FBO ---------------- */

  _ensureFbos(w, h) {
    if (this._fboW === w && this._fboH === h) return;
    this._deleteFbos();
    this._fboW = w;
    this._fboH = h;
  }

  _createFbo(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    }
    return { fbo, tex, w, h, inUse: false };
  }

  _getFbo() {
    for (const f of this.fboPool) {
      if (!f.inUse) { f.inUse = true; return f; }
    }
    const f = this._createFbo(this._fboW, this._fboH);
    if (!f) return null;
    f.inUse = true;
    this.fboPool.push(f);
    return f;
  }

  _acquireContext() {
    const a = this._getFbo();
    const b = this._getFbo();
    const src = this._getFbo();
    if (!a || !b || !src) {
      for (const f of [a, b, src]) if (f) f.inUse = false;
      return null;
    }
    return { a, b, src };
  }

  _releaseContext(ctx) {
    for (const f of [ctx.a, ctx.b, ctx.src]) f.inUse = false;
  }

  _bindFbo(f) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.viewport(0, 0, f.w, f.h);
  }

  _bindScreen() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  _clearFbo(f) {
    const gl = this.gl;
    this._bindFbo(f);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _deleteFbos() {
    const gl = this.gl;
    if (gl) {
      for (const f of this.fboPool) {
        try { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); } catch { /* lost */ }
      }
    }
    this.fboPool = [];
    this._fboW = 0;
    this._fboH = 0;
  }

  /* ---------------- 绘制基础 ---------------- */

  _setView(u, view, cssW, cssH) {
    const gl = this.gl;
    const c = Math.cos(view.rotation || 0);
    const s = Math.sin(view.rotation || 0);
    gl.uniformMatrix2fv(u.rot, false, new Float32Array([c, s, -s, c]));
    gl.uniform2f(u.translate, view.tx, view.ty);
    gl.uniform1f(u.scale, view.scale);
    gl.uniform2f(u.size, cssW, cssH);
    return u;
  }

  _drawQuad(u, rect) {
    const gl = this.gl;
    gl.uniform4f(u.rect, rect.x, rect.y, rect.w, rect.h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  _drawFull() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  _white() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
  }

  /* ---------------- 主体 ---------------- */

  /**
   * 渲染一帧。返回是否成功；失败时调用方回退 Canvas2D。
   * view: engine.view（scale/rotation/tx/ty，CSS px）
   */
  render(layers, view, cssW, cssH, dpr) {
    if (!this.ok || !cssW || !cssH) return false;
    const info = this.analyze(layers);
    if (!info.ok) return false;
    const gl = this.gl;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this._bindScreen();
    gl.clearColor(0.169, 0.169, 0.169, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.frame++;

    const doc = { x: 0, y: 0, w: layers.w, h: layers.h };
    this._paintBackdrop(doc, view, cssW, cssH);

    if (info.complex) {
      if (!this._renderComplex(layers, view, cssW, cssH)) return false;
    } else {
      this._renderSimple(layers, view, cssW, cssH);
    }

    this._evict();
    gl.flush();
    return true;
  }

  _paintBackdrop(doc, view, cssW, cssH) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.shadowProg);
    const su = this._setView(this.u.shadow, view, cssW, cssH);
    const shadowOffset = 2 / Math.max(view.scale, 0.001);
    gl.uniform4f(su.doc, doc.x, doc.y + shadowOffset, doc.w, doc.h);
    const pad = 58 / Math.max(view.scale, 0.001);
    this._drawQuad(su, { x: -pad, y: -pad, w: doc.w + pad * 2, h: doc.h + pad * 2 });

    gl.disable(gl.BLEND);
    gl.useProgram(this.checkerProg);
    const cu = this._setView(this.u.checker, view, cssW, cssH);
    gl.uniform4f(cu.doc, doc.x, doc.y, doc.w, doc.h);
    const edgePad = 0.75 / Math.max(view.scale, 0.001);
    this._drawQuad(cu, { x: -edgePad, y: -edgePad, w: doc.w + edgePad * 2, h: doc.h + edgePad * 2 });
  }

  _renderSimple(layers, view, cssW, cssH) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.tileProg);
    const u = this._setView(this.u.tile, view, cssW, cssH);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.tex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.uniform1i(u.mask, 1);
    gl.uniform1f(u.hasMask, 0);
    this._white();
    gl.activeTexture(gl.TEXTURE0);
    for (const node of layers.layers) {
      if (!node.visible || node.opacity <= 0) continue;
      gl.uniform1f(u.opacity, node.opacity);
      const s = node.surface;
      for (const t of s.tiles.values()) {
        const r = s.tileRect(t.tx, t.ty);
        gl.bindTexture(gl.TEXTURE_2D, this._texture(t));
        this._drawQuad(u, r);
      }
    }
  }

  _renderComplex(layers, view, cssW, cssH) {
    const gl = this.gl;
    this._ensureFbos(this.canvas.width, this.canvas.height);
    let ctx = null;
    try {
      ctx = this._acquireContext();
      if (!ctx) return false;
      this._clearFbo(ctx.a);
      const cur = this._renderNodes(layers.layers, ctx.a, ctx.b, ctx.src, view, cssW, cssH, 0);
      this._bindScreen();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this._blit(cur.tex, 1);
      return true;
    } catch (err) {
      console.warn('[GPU] complex render failed, fallback Canvas2D', err);
      return false;
    } finally {
      if (ctx) this._releaseContext(ctx);
    }
  }

  _renderNodes(nodes, sceneA, sceneB, src, view, cssW, cssH, depth) {
    const gl = this.gl;
    let cur = sceneA;
    let other = sceneB;

    for (const node of nodes || []) {
      if (!node.visible || node.opacity <= 0) continue;
      const blend = node.blend || 'source-over';

      if (node.type === 'group') {
        const gctx = this._acquireContext();
        if (!gctx) throw new Error('fbo unavailable');
        try {
          this._clearFbo(gctx.a);
          const gcur = this._renderNodes(node.children || [], gctx.a, gctx.b, gctx.src, view, cssW, cssH, depth + 1);
          if (node.mask && node.mask.enabled && node.mask.surface && !node.mask.surface.isEmpty()) {
            this._applyMaskToFbo(gcur, node.mask.surface, view, cssW, cssH);
          }
          if (blend === 'source-over') {
            this._bindFbo(cur);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this._blit(gcur.tex, node.opacity);
          } else {
            this._composite(gcur.tex, cur.tex, other, BLEND_IDS[blend], node.opacity);
            [cur, other] = [other, cur];
          }
        } finally {
          this._releaseContext(gctx);
        }
      } else {
        const mask = node.mask && node.mask.enabled ? node.mask.surface : null;
        if (blend === 'source-over') {
          this._bindFbo(cur);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this._drawLayerTiles(node, mask, view, cssW, cssH);
        } else {
          this._clearFbo(src);
          this._bindFbo(src);
          gl.disable(gl.BLEND);
          this._drawLayerTiles(node, mask, view, cssW, cssH);
          this._composite(src.tex, cur.tex, other, BLEND_IDS[blend], 1);
          [cur, other] = [other, cur];
        }
      }
    }
    return cur;
  }

  _drawLayerTiles(node, mask, view, cssW, cssH) {
    const gl = this.gl;
    gl.useProgram(this.tileProg);
    const u = this._setView(this.u.tile, view, cssW, cssH);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.tex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.uniform1i(u.mask, 1);
    gl.uniform1f(u.opacity, node.opacity);
    gl.uniform1f(u.hasMask, 0);
    this._white();
    gl.activeTexture(gl.TEXTURE0);

    const s = node.surface;
    for (const t of s.tiles.values()) {
      const r = s.tileRect(t.tx, t.ty);
      gl.bindTexture(gl.TEXTURE_2D, this._texture(t));
      const mt = mask ? mask.getTile(t.tx, t.ty, false) : null;
      if (mt) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._texture(mt));
        gl.uniform1f(u.hasMask, 1);
        gl.activeTexture(gl.TEXTURE0);
      } else {
        this._white();
        gl.uniform1f(u.hasMask, 0);
        gl.activeTexture(gl.TEXTURE0);
      }
      this._drawQuad(u, r);
    }
  }

  _applyMaskToFbo(f, mask, view, cssW, cssH) {
    const gl = this.gl;
    this._bindFbo(f);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ZERO, gl.SRC_ALPHA, gl.ZERO, gl.SRC_ALPHA);
    gl.useProgram(this.tileProg);
    const u = this._setView(this.u.tile, view, cssW, cssH);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.tex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.uniform1i(u.mask, 1);
    gl.uniform1f(u.hasMask, 0);
    gl.uniform1f(u.opacity, 1);
    this._white();
    gl.activeTexture(gl.TEXTURE0);
    for (const t of mask.tiles.values()) {
      const r = mask.tileRect(t.tx, t.ty);
      gl.bindTexture(gl.TEXTURE_2D, this._texture(t));
      this._drawQuad(u, r);
    }
    gl.disable(gl.BLEND);
  }

  _composite(srcTex, dstTex, target, mode, opacity) {
    const gl = this.gl;
    this._bindFbo(target);
    gl.disable(gl.BLEND);
    gl.useProgram(this.compProg);
    const u = this.u.comp;
    gl.uniform1i(u.src, 0);
    gl.uniform1i(u.dst, 1);
    gl.uniform1i(u.mode, mode);
    gl.uniform1f(u.opacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dstTex);
    this._drawFull();
  }

  _blit(tex, opacity) {
    const gl = this.gl;
    gl.useProgram(this.blitProg);
    const u = this.u.blit;
    gl.uniform1i(u.tex, 0);
    gl.uniform1f(u.opacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this._drawFull();
  }

  clear() {
    if (!this.ok) return;
    const gl = this.gl;
    this._bindScreen();
    gl.clearColor(0.169, 0.169, 0.169, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dropTextures() {
    const gl = this.gl;
    if (gl) {
      for (const e of this.tex.values()) {
        try { gl.deleteTexture(e.tex); } catch { /* context lost */ }
      }
    }
    this.tex.clear();
    this._deleteFbos();
  }

  dispose() {
    if (!this.ok) return;
    const gl = this.gl;
    this.dropTextures();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.whiteTex);
    for (const p of [this.tileProg, this.checkerProg, this.shadowProg, this.blitProg, this.compProg]) gl.deleteProgram(p);
    this.ok = false;
  }
}
