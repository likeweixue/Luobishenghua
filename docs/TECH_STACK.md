# 技术栈评估：HTML/CSS/JS 适合做「落笔生花」吗？

先给结论：

1. **Photoshop 桌面版不是 HTML/CSS/JS 做的。** 它的核心是 C++（图像合成、色彩管理、文件格式、GPU、插件），界面是原生框架；只有扩展面板 / 脚本层使用 JavaScript（UXP / ExtendScript）。CSP 同样以 C++ 核心 + 原生界面为主。
2. **HTML/CSS/JS 做 UI 完全没问题，而且很适合你现在的阶段。** 你的界面、面板、对话框、快捷键、主题，用 Web 技术迭代速度远快于原生 UI。
3. **决定绘画软件上限的不是 CSS/HTML，而是渲染与笔刷管线。** 目前项目以 Canvas 2D + JS 为主，beta13 起简单平铺图层已走 WebGL2，beta14 面板标签已可自由拖拽重组，beta15 组 / 蒙版 / 混合模式也上了 GPU，beta16 瓦片走纹理数组 + instanced draw，beta18 简单图层笔画 GPU 预览 + 抬笔批量提交，beta19 应用端到端回归，beta20 OffscreenCanvas + Worker 抬笔提交，beta21 核心 GPU/瓦片/Worker 迁移 TS，beta22 engine/layers 迁移 TS，配合 Tauri 2 的 Rust 壳，是一个合理的起步架构；要往专业级走，继续把「剪贴蒙版 / 笔刷铺排 / 大图缩放」迁到 GPU（WebGL2 / WebGPU），把重活交给 WASM 或 Rust。
4. 如果目标是「专业绘画工具」而不是「PS 克隆」，**HTML/CSS/JS + Tauri + WebGPU/WASM** 是一条现实且成本可控的路线。如果目标是和 PS 正面竞争，最终仍然需要一个 C++/Rust 的像素核心。

---

## 1. Photoshop / CSP 实际用什么

| 层 | Photoshop | Clip Studio Paint | 落笔生花（当前） |
|---|---|---|---|
| 画布 / 合成 | C++ + GPU | C++ + GPU | Canvas 2D + WebGL2（组 / 蒙版 / 混合 + instanced） |
| 笔刷引擎 | C++，原生 SIMD/GPU | C++ | JS + Canvas（印章铺排） |
| 文件格式 | C++（PSD/PSB/TIFF…） | C++ | JS（PSD / ABR / ZIP） |
| 界面 | 原生（macOS AppKit / Windows 自绘） | 原生 | HTML/CSS |
| 扩展 / 脚本 | UXP（JS） | 原生插件 | 无 |
| 壳 | 原生 | 原生 | Tauri 2（Rust + WebView） |

所以「Adobe 就是这个技术栈」这个说法只对了一小半：Adobe 的 **Web 版 Photoshop / Express** 是 Web 技术；**桌面版 Photoshop** 不是。你的项目更接近「Web 技术做界面 + 自绘引擎」的 Affinity / Figma 路线，而不是 Adobe 桌面版的路线。

## 2. 当前技术栈的优点

- **零构建、零依赖**：直接 `index.html` + ES Module，调试和部署都简单。
- **UI 迭代快**：beta12 在一天内重排成 PS 工作台，beta14 又把面板标签做成可拖拽停靠，这就是 Web 技术的优势。
- **面板系统**：三个坞组 + 动态标签 + 浮动面板，支持重排 / 跨组 / 停靠 / 持久化；目前还没有任意新建或拆分坞组。
- **跨平台**：Tauri 2 同时出 macOS / Windows，安装包小，原生文件对话框 / 拖拽都能接。
- **Canvas 2D 够用**：瓦片存储 + 脏矩形 + 上下层缓存，已经把「大画布 / 多图层」的内存问题解决得不错。
- **PSD / ABR 生态**：用 JS 直接解析，方便快速试错。

## 3. 瓶颈在哪里

按优先级：

1. **合成与缩放**：Canvas 2D 的 `drawImage` 每次全屏重绘在 4K/8K 画布上会很吃力；缩放时的重采样质量与速度也受限。需要 GPU 合成（WebGL2 纹理 / WebGPU render pass）。
2. **笔刷铺排**：现在每落一个印章都走 2D canvas 绘制 + 读回；高密度笔刷、大笔尖、低间距时会掉帧。可以把印章批处理成顶点/实例，用 WebGL/WebGPU 一次画完。
3. **主线程**：PSD 解析、ZIP、缩略图、自动保存都在主线程；大文件会卡 UI。需要 Worker / OffscreenCanvas / Rust 端处理。
4. **色彩管理**：只有 sRGB 8 位；专业印刷 / HDR 需要 ICC、16 位、线性空间。
5. **UI 工程化**：目前运行时 JS 约 10.5k 行；beta21 起 `gpu` / `tiles` / `brush-worker`，beta22 起 `engine` / `layers` 已有 TS 源与 tsc 构建，主程序 / 面板仍是 JS。继续迁移到 TS + 轻量状态管理，不需要上 React。

## 4. 推荐演进路线

### 短期（保持现在的架构）

- 继续用 HTML/CSS/JS + Tauri；把 UI 组件（菜单、面板、滑块、拾色器）抽成可复用的小模块。
- beta21 已引入 **TypeScript**（`src/` + tsc 生成 `app/js`）；后续再评估 Vite / HMR，保留 `app/` 静态运行结构。
- 把 PSD / ABR / ZIP / 自动保存放进 **Web Worker**；缩略图用 OffscreenCanvas。
- 已用零依赖 `scripts/test-browser.mjs` 把 8 个测试页（279 项）+ 应用端到端（真实指针画一笔 → GPU 预览 → 提交 → 撤销 / 重做）接进 CI；后续再评估 Playwright / Vitest 做 PSD 打开 / 保存链路的测试。

### 中期（性能分水岭）

> **beta13 / beta15 已落地**：`app/js/gpu.js` 用 WebGL2 渲染简单平铺图层；
> beta15 增加 FBO 复杂路径，支持图层组（≤4 层）、图层 / 组蒙版、正片叠底 / 滤色 /
> 叠加 / 柔光 / 变暗 / 变亮 / 颜色减淡 / 线性减淡；剪贴蒙版、组嵌套 >4、超大瓦片
> 自动回退 Canvas2D。4000² / 20 层稀疏简单栈的本机基准：整屏合成 15.8 ms → 0.4 ms，
> 视图重绘 13.2 ms → 0.1 ms。beta14 面板标签已支持拖拽重组 / 停靠，单列工具栏也已落地。
> beta16 已把瓦片放进 256×256 纹理数组，并用 instanced draw 合并：简单路径 1 次 draw call，复杂路径每层 1 次。
> beta17 把 8 个测试页（279 项）接进无头 Chrome + CI；beta19 增加真实应用端到端。
> beta18 已把简单图层的笔刷预览搬到 GPU，并在抬笔时批量提交；
> beta20 把抬笔提交放进 Worker + OffscreenCanvas，主线程保留 before/after 快照；
> beta21 完成 GPU / 瓦片 / Worker 的 TS 源迁移与 CI typecheck；beta22 完成 engine / layers，下一步迁移主程序 / 面板。

- 在已落地的 WebGL2 简单 / 复杂合成（组 / 蒙版 / 混合）与纹理数组 + instanced draw 上继续做笔刷批绘制；后续评估 **WebGPU**（新设备优先），Canvas 2D 长期作为 fallback。
- 笔刷印章改为 GPU 实例化/批绘制；瓦片作为纹理图集（atlas），避免每帧上传。
- 视图变换（缩放/旋转/平移）直接在 GPU 上做矩阵变换，标尺/选区用叠加层。
- 重计算（色彩转换、滤镜、液化）用 **WASM（Rust/C++）**，通过 Tauri 或 wasm-bindgen 调用。
- 文件读写、原生菜单、崩溃恢复可以逐步移到 Rust 端，前端只拿结果。

### 长期（如果真的要对标 PS）

- 像素核心用 **Rust 或 C++**（SIMD + GPU），Web 前端只负责 UI 与交互。
- 图层/历史用不可变数据 + 增量快照；支持 16 位、ICC、智能对象、滤镜图。
- 建立笔刷/材质/工作区生态，而不只是「像 PS 的界面」。

## 5. 一句话建议

**不要换掉 HTML/CSS/JS，也不要把「像 PS」误解成「必须用 Adobe 的技术」。** 当前最值得投入的是：把 TypeScript 工程化和更多 Worker 化做起来，把重活移出主线程，把 UI 工程化。beta22 之后，界面、面板、GPU 组 / 蒙版 / 混合、瓦片批绘制、GPU 笔刷预览、Worker 提交、自动化回归和核心模块 TS 化都已跨过「像 PS」的门槛；下一阶段的瓶颈在主程序 / 面板的 TS 工程化，不在 CSS。

DeepSeek 自 beta12 起参与本项目的界面 / 面板 / GPU / 测试协作（2026）。
