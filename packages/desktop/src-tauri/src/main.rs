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

/// 러너 전용 전역 체크아웃 경로(#425): `~/.murmur/runner`.
///
/// **이 경로는 웹뷰가 고르지 않는다.** `runnerCommand` 가 디렉터리로 쪼개져 자식 `PATH` 에만
/// 들어가는 것과 같은 논리다 — 홈 디렉터리를 아는 것은 앱(Rust)뿐이고, 그것을 문자열로
/// 조립하는 규칙까지 웹뷰에 두면 나중에 다른 하위 경로를 계산하는 코드가 웹뷰에 생길 여지가
/// 남는다. 상수는 여기 한 곳에서만 조립되고, 프런트는 이 결과 문자열을 그대로 쓴다.
#[tauri::command]
fn runner_global_repo_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home
        .join(".murmur")
        .join("runner")
        .to_string_lossy()
        .into_owned())
}

/// clone 대상. **고정 리터럴이다** — 웹뷰가 넘길 수 있는 값이 아니다(#425).
const RUNNER_REPO_URL: &str = "https://github.com/izagood/murmur.git";

/// 전역 체크아웃을 준비한다(#425). 웹뷰는 파라미터 없이 이 커맨드 하나만 부를 수 있고,
/// 실행할 프로그램·인자·URL·목적지 경로는 전부 이 함수 안에서 고정된다 —
/// `shell:allow-spawn` 스코프의 인자 리터럴 제약(`runnerLauncher.ts::RUNNER_SCOPE_NAME`)과
/// 같은 이유다. 목적지가 사용자 홈마다 달라 shell 스코프의 리터럴 인자로는 표현할 수 없어서
/// (`Var{validator}` 는 곧 웹뷰가 인자를 고르는 것과 같다), git 실행 자체를 Rust 커맨드
/// 뒤로 옮겨 웹뷰 표면에서 프로그램 이름조차 드러나지 않게 한다.
///
/// **이미 있으면 아무것도 하지 않는다** — 갱신 정책은 "첫 실행에만 clone, 이후 자동 갱신은
/// 하지 않는다"(#425 보고 참고). 매 기동마다 pull 하면 로컬에서 손으로 그 체크아웃을 만지는
/// 사람(드묾)의 변경을 조용히 덮어쓸 수 있고, 러너 기동 경로에 네트워크 왕복을 늘 끼워
/// 넣는다 — 지금 필요한 최소는 "없으면 만든다"뿐이다.
///
/// clone 이 실패하면 **stderr 를 그대로 사람에게 올린다**(#368) — 네트워크 없음, 권한 없음,
/// git 미설치를 앱이 판정해 대신 말하지 않는다. 판정이 틀리면 사람은 진짜 원인을 못 보고
/// 앱이 지어낸 설명만 본다.
#[tauri::command]
fn runner_provision_global_repo(app: tauri::AppHandle) -> Result<String, String> {
    use std::path::Path;
    use std::process::Command;
    use tauri::Manager;

    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dest = home.join(".murmur").join("runner");
    let dest_str = dest.to_string_lossy().into_owned();

    if Path::new(&dest).join(".git").is_dir() {
        return Ok(dest_str);
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("`{}` 를 만들지 못했다: {e}", parent.display()))?;
    }

    let output = Command::new("git")
        .args(["clone", RUNNER_REPO_URL, &dest_str])
        .output()
        .map_err(|e| format!("git 을 실행하지 못했다 — 설치돼 있는지 확인하라: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git clone 이 실패했다: {}", stderr.trim()));
    }

    Ok(dest_str)
}

fn main() {
    tauri::Builder::default()
        // 멘션 알림 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_notification::init())
        // 링크를 OS 로 넘기는 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            runner_global_repo_dir,
            runner_provision_global_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running murmur");
}
