// WebGL2 合成器（第一阶段）
//
// 目标：把「简单平铺图层」的屏幕合成搬到 GPU：
//   - 每层只支持普通图层 + 正常混合（source-over）
//   - 无组 / 蒙版 / 剪贴；复杂图层自动回退 Canvas2D
//   - 瓦片按修订号增量上传纹理，平移 / 缩放 / 旋转不再重新合成整张文档
//
// 设计约束：GPU 只负责屏幕内容；engine.doc 仍由 Canvas2D 在空闲时合成，
// 供导航器 / 吸管 / 导出使用，保证旧功能与测试的语义不变。

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

const FS_TILE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv) * u_opacity;
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
    this.lastInfo = null;
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
    this.u = {};
    for (const [name, p] of [['tile', this.tileProg], ['checker', this.checkerProg], ['shadow', this.shadowProg]]) {
      this.u[name] = {
        rect: gl.getUniformLocation(p, 'u_rect'),
        translate: gl.getUniformLocation(p, 'u_translate'),
        rot: gl.getUniformLocation(p, 'u_rot'),
        scale: gl.getUniformLocation(p, 'u_scale'),
        size: gl.getUniformLocation(p, 'u_size'),
        doc: gl.getUniformLocation(p, 'u_doc'),
        opacity: gl.getUniformLocation(p, 'u_opacity'),
        tex: gl.getUniformLocation(p, 'u_tex'),
      };
    }
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
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this.lastInfo = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  /** 当前图层结构是否可由 GPU 路径正确合成 */
  canRender(layers) {
    if (!this.ok || !layers) return false;
    let tiles = 0;
    let bytes = 0;
    for (const node of layers.layers) {
      if (!node.visible || node.opacity <= 0) continue;
      if (node.type !== 'layer') return false;
      if (node.mask || node.clipping) return false;
      if ((node.blend || 'source-over') !== 'source-over') return false;
      const s = node.surface;
      if (!s) return false;
      tiles += s.tileCount;
      bytes += s.byteSize();
      if (tiles > this.maxTiles || bytes > this.maxBytes) return false;
    }
    return true;
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
    // 删掉约 3 秒未使用的旧瓦片纹理（隐藏 / 删除图层后释放）
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

  _setView(prog, view, cssW, cssH) {
    const gl = this.gl;
    const u = this.u[prog === this.tileProg ? 'tile' : prog === this.checkerProg ? 'checker' : 'shadow'];
    const c = Math.cos(view.rotation || 0);
    const s = Math.sin(view.rotation || 0);
    gl.uniformMatrix2fv(u.rot, false, new Float32Array([c, s, -s, c]));
    gl.uniform2f(u.translate, view.tx, view.ty);
    gl.uniform1f(u.scale, view.scale);
    gl.uniform2f(u.size, cssW, cssH);
    return u;
  }

  _drawQuad(rect) {
    const gl = this.gl;
    gl.uniform4f(this._activeU.rect, rect.x, rect.y, rect.w, rect.h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /**
   * 渲染一帧。返回是否成功；失败时调用方回退 Canvas2D。
   * view: engine.view（scale/rotation/tx/ty，CSS px）
   */
  render(layers, view, cssW, cssH, dpr) {
    if (!this.ok || !cssW || !cssH) return false;
    const gl = this.gl;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.169, 0.169, 0.169, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.frame++;

    const doc = { x: 0, y: 0, w: layers.w, h: layers.h };

    // 文档阴影（世界坐标里留一圈；随缩放保持约 26 CSS px 的柔边）
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.shadowProg);
    this._activeU = this._setView(this.shadowProg, view, cssW, cssH);
    const shadowOffset = 2 / Math.max(view.scale, 0.001);
    gl.uniform4f(this._activeU.doc, doc.x, doc.y + shadowOffset, doc.w, doc.h);
    gl.uniform1f(this._activeU.scale, view.scale);
    const pad = 58 / Math.max(view.scale, 0.001);
    this._drawQuad({ x: -pad, y: -pad, w: doc.w + pad * 2, h: doc.h + pad * 2 });

    // 透明棋盘格（文档底）
    gl.disable(gl.BLEND);
    gl.useProgram(this.checkerProg);
    this._activeU = this._setView(this.checkerProg, view, cssW, cssH);
    gl.uniform4f(this._activeU.doc, doc.x, doc.y, doc.w, doc.h);
    gl.uniform1f(this._activeU.scale, view.scale);
    // 向外扩 0.75 CSS px，盖住与阴影之间的光栅化接缝
    const edgePad = 0.75 / Math.max(view.scale, 0.001);
    this._drawQuad({ x: -edgePad, y: -edgePad, w: doc.w + edgePad * 2, h: doc.h + edgePad * 2 });

    // 图层：预乘 alpha + ONE / ONE_MINUS_SRC_ALPHA
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.tileProg);
    this._activeU = this._setView(this.tileProg, view, cssW, cssH);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this._activeU.tex, 0);

    for (const node of layers.layers) {
      if (!node.visible || node.opacity <= 0) continue;
      gl.uniform1f(this._activeU.opacity, node.opacity);
      const s = node.surface;
      for (const t of s.tiles.values()) {
        const r = s.tileRect(t.tx, t.ty);
        const tex = this._texture(t);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        this._drawQuad(r);
      }
    }

    this._evict();
    gl.flush();
    return true;
  }

  clear() {
    if (!this.ok) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
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
  }

  dispose() {
    if (!this.ok) return;
    const gl = this.gl;
    this.dropTextures();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    for (const p of [this.tileProg, this.checkerProg, this.shadowProg]) gl.deleteProgram(p);
    this.ok = false;
  }
}
