//! 채널을 고르는 앱 업데이트 — **Stable / Ludicrous**.
//!
//! ## 왜 Rust 명령인가
//!
//! `tauri-plugin-updater` 의 JS `check()` 가 받는 것은 headers·timeout·proxy·target·
//! allowDowngrades 뿐이다(2.11.0 `commands.rs`). **엔드포인트는 JS 에서 못 바꾼다.**
//! 실행 중에 엔드포인트를 고르는 길은 Rust 의 `updater_builder().endpoints(..)` 하나다.
//!
//! ## 엔드포인트는 여기 상수로만 둔다
//!
//! 화면이 넘기는 것은 **채널 이름**이지 URL 이 아니다. URL 을 받으면 웹뷰에 스크립트를
//! 심은 쪽이 아무 매니페스트나 가리킬 수 있다 — 서명 검증이 설치는 막아 주지만, "새 판이
//! 있다"는 거짓 표시까지 막지는 못한다. 그래서 이름 둘만 받고 나머지는 거절한다.
//!
//! - Ludicrous = `tauri.conf.json` 의 `plugins.updater.endpoints` 와 같은 자리
//!   (`releases/latest`, main 머지마다 `release.yml` 이 옮긴다)
//! - Stable = 돌려 쓰는 prerelease `stable` 의 `latest.json`(`promote.yml` 이 옮긴다)
//!
//! 서명 검증은 그대로 플러그인이 `tauri.conf.json` 의 공개키로 한다 — 매니페스트가 어느
//! 릴리즈에 놓였는지는 신뢰와 무관하다.
//!
//! ## 낮은 판으로 내려가지 않는다
//!
//! 비교기를 바꾸지 않는다(기본 = 원격 판 > 지금 판). Ludicrous 로 0.4.171 을 깐 뒤 Stable 로
//! 돌아가면, Stable 이 0.4.171 을 넘을 때까지 "새 판 없음" 이다 — 설계 합의(결정 5).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const LUDICROUS_ENDPOINT: &str =
    "https://github.com/izagood/harkroom/releases/latest/download/latest.json";
pub const STABLE_ENDPOINT: &str =
    "https://github.com/izagood/harkroom/releases/download/stable/latest.json";

/// 채널 이름 → 엔드포인트. 모르는 이름은 `None`(거절).
pub fn endpoint_for(channel: &str) -> Option<&'static str> {
    match channel {
        "stable" => Some(STABLE_ENDPOINT),
        "ludicrous" => Some(LUDICROUS_ENDPOINT),
        _ => None,
    }
}

/// 마지막 확인이 찾은 판. 설치는 **사람이 화면에서 본 그 판**을 그대로 쓴다 — 설치 때 다시
/// 물으면 그 사이 매니페스트가 바뀌었을 때 본 것과 다른 것이 설치된다(`appUpdater.ts` 와 같은 이유).
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct FoundUpdate {
    version: String,
}

#[tauri::command]
pub async fn app_update_check<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingUpdate>,
    channel: String,
) -> Result<Option<FoundUpdate>, String> {
    let endpoint = endpoint_for(&channel).ok_or_else(|| format!("unknown update channel: {channel}"))?;
    let url = endpoint.parse().map_err(|e| format!("{e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let answer = found.as_ref().map(|u| FoundUpdate { version: u.version.clone() });
    // 없다는 답도 쥔 것을 비운다 — 채널을 바꾼 뒤 앞 채널의 판을 설치하지 않게.
    *pending.0.lock().map_err(|e| e.to_string())? = found;
    Ok(answer)
}

#[tauri::command]
pub async fn app_update_install(pending: State<'_, PendingUpdate>) -> Result<(), String> {
    // 꺼내지 않고 복제한다 — 내려받기가 실패하면 사람이 같은 판으로 [다시 설치] 할 수 있어야 한다.
    // 잠금은 await 앞에서 놓는다.
    let update = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "nothing to install — check for updates first".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}

/// 실물 번들 확인용 표지(`HARKROOM_UPDATE_PROBE=stable|ludicrous`). `HARKROOM_LAUNCH_SMOKE` 와 같은
/// 규율이다: 켜지 않으면 아무것도 안 하고, 켜면 **그 채널을 한 번 물어 stderr 에 한 줄** 적는다.
/// 받는 값은 채널 이름뿐이라 엔드포인트를 밖에서 바꿀 수 없다. 설치는 하지 않는다.
pub fn spawn_probe<R: Runtime>(app: &AppHandle<R>) {
    let Some(channel) = std::env::var_os("HARKROOM_UPDATE_PROBE") else { return };
    let channel = channel.to_string_lossy().into_owned();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let line = match probe(&app, &channel).await {
            Ok(Some(v)) => format!("found={v}"),
            Ok(None) => "found=none".to_string(),
            Err(e) => format!("error={e}"),
        };
        eprintln!(
            "harkroom-update-probe: channel={channel} current={} {line}",
            app.package_info().version
        );
    });
}

async fn probe<R: Runtime>(app: &AppHandle<R>, channel: &str) -> Result<Option<String>, String> {
    let endpoint = endpoint_for(channel).ok_or_else(|| format!("unknown update channel: {channel}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint.parse().map_err(|e| format!("{e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    Ok(updater.check().await.map_err(|e| e.to_string())?.map(|u| u.version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 채널_이름_둘만_받는다() {
        assert_eq!(endpoint_for("stable"), Some(STABLE_ENDPOINT));
        assert_eq!(endpoint_for("ludicrous"), Some(LUDICROUS_ENDPOINT));
        assert_eq!(endpoint_for("Stable"), None);
        assert_eq!(endpoint_for("https://example.com/latest.json"), None);
        assert_eq!(endpoint_for(""), None);
    }

    /// Ludicrous 는 conf 의 엔드포인트와 **같은 자리**여야 한다 — 갈리면 채널을 아는 앱과
    /// 모르는 옛 앱이 서로 다른 "최신"을 본다.
    #[test]
    fn ludicrous_는_conf_엔드포인트와_같다() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(conf["plugins"]["updater"]["endpoints"][0], LUDICROUS_ENDPOINT);
    }

    #[test]
    fn stable_은_stable_릴리즈의_매니페스트다() {
        assert!(STABLE_ENDPOINT.ends_with("/releases/download/stable/latest.json"));
    }
}
