# CHANGELOG — 落笔生花 Luobishenghua

版本约定：每次迭代 +1（betaN）。随源码发布。

## beta3（2026-10-21）

自动化打包（CI）与双端发布。

- GitHub Actions 工作流 `.github/workflows/build.yml`：推送 `main` 自动并行构建 macOS `.app` 与 Windows NSIS `.exe` 安装包并上传产物
- 推送 `v*` 标签（如 `v1.0.0`）自动创建 GitHub Release 并附上两个平台安装包
- `tauri.conf.json` 图标列表补充 `icon.ico`（Windows 打包必需；此前仅有 `icon.icns`）
- 构建策略：Rust 依赖缓存（swatinem/rust-cache），npm 依赖锁文件安装（`npm ci`）

## beta2（2026-10-21）

macOS 桌面版打包（M5）。

- Tauri 2 应用壳：前端收进 `app/` 独立目录，`src-tauri/` 为 Rust 壳工程
- 打包产物：macOS `.app`（`src-tauri/target/release/bundle/macos/落笔生花.app`），Bundle ID `cn.luobishenghua.paint`
- 应用图标：自绘「墨」字 + 朱红「画」印章（`src-tauri/icons/make_icon.py` 生成，可随时改图重生成）
- 窗口：默认 1440×900，最小 1024×700
- 构建环境：rustup 1.99.1（aarch64-apple-darwin）+ @tauri-apps/cli（项目本地 npm 依赖）
- 构建命令：`npx tauri build --bundles app`（需 PATH 含 `~/.cargo/bin` 与 node bin）

## beta1（2026-10-21）

首个可用版本。

- 笔刷引擎：压感画笔（硬边圆笔/软边喷枪/铅笔/水彩/橡皮擦），压感控制粗细与不透明度
- 画布：平移/缩放/旋转，抓手工具，导航器面板（视野红框拖动）
- 图层系统：新建/删除/排序/重命名/显隐/不透明度/9 种混合模式，纸张底层，棋盘格透明标示
- 撤销/重做：笔画级 + 结构级两级快照（上限可在偏好设置调整）
- PSD 互通：分层导入（中文图层名/显隐/不透明度/混合模式/位置）、分层导出，拖拽打开
- 笔刷生态：.abr 笔刷包导入（v1/v2/v6+，中文笔刷名），笔尖缩略图笔刷仓库
- UI：CSP/Adobe 式可停靠面板系统（磁吸停靠/浮动/折叠）+ 暗灰专业主题
- 菜单栏：落笔生花/文件/编辑/视图/窗口/设置/帮助；窗口菜单管理面板显隐与布局重置
- 对话框：新建文档（自定义尺寸）、偏好设置（撤销步数/默认画布）、快捷键一览、关于

已知限制：不支持 PSB、16/32 位 PSD、CMYK、图层组（平铺）；v6+ .abr 的笔刷名/动态参数（desc 段）未解析；计算型圆头笔刷跳过。
