// 落笔生花 Luobishenghua — Tauri 应用入口
// 目前为纯前端应用壳：所有绘画逻辑在 Web 层，后续可把核心引擎迁到 Rust。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running luobishenghua");
}
