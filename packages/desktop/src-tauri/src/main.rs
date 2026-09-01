#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // 멘션 알림 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running murmur");
}
