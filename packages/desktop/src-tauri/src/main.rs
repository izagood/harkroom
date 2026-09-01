#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 비밀 보관은 **OS 키체인**에 맡긴다(macOS Keychain / Windows Credential Manager /
//! Linux Secret Service). Tauri 에 공식 키체인 플러그인이 없어 `keyring` 크레이트를 세 개의
//! 명령으로 노출한다 — 플러그인을 기다리는 것보다 얇고, 프런트가 보는 표면은 어차피 같다.
//!
//! 프런트는 이 세 명령이 없거나 실패하는 환경(브라우저 개발·테스트)에서 `localStorage` 로
//! 물러난다(`lib/session.ts`). 그래서 여기서는 실패를 숨기지 않고 문자열로 돌려준다 —
//! 조용히 성공한 척하면 프런트가 평문 경로로 내려갈 기회를 잃는다.

const SERVICE: &str = "app.murmur.desktop";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// 없으면 `None`. "없다"와 "읽을 수 없다"는 다르다 — 후자는 Err 로 올려야 프런트가
/// 폴백할지 로그아웃할지 판단할 수 있다.
#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

/// 없는 것을 지우는 것도 성공이다 — 결과 상태가 같으니 재시도가 안전하다.
#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        // 멘션 알림 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![secret_get, secret_set, secret_delete])
        .run(tauri::generate_context!())
        .expect("error while running murmur");
}
