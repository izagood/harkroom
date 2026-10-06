//! 채널·스레드를 **새 창으로 띄우는 문**(designer 판 3, jaebin 결정 W1~W4).
//!
//! ## 왜 `window.open` 인가
//!
//! 연결(WebSocket)·알림·읽음은 앱 전체에 **하나**여야 한다 — 창마다 컨트롤러를 띄우면
//! 같은 메시지에 OS 알림이 창 수만큼 뜨고, 읽음 위치가 두 벌이 된다. Tauri 의 일반 창
//! (`WebviewWindowBuilder` 로 만든 창)은 **자기 자바스크립트 세계**를 따로 가지므로 스토어를
//! 나눠 쓸 수 없다. 반면 메인 웹뷰가 `window.open` 으로 연 창은 같은 웹뷰 설정을 물려받아
//! 오프너와 **같은 출처의 `Window` 객체**로 이어진다 — 메인의 React 가 그 문서에 포털로
//! 그리면 스토어·컨트롤러는 메인 하나 그대로다. 새 창은 그리기만 한다.
//!
//! ## 무엇을 열어 주는가
//!
//! 앱이 스스로 여는 창 하나뿐이다: `about:blank#hk-win=<key>`. 그 밖의 요청(본문 링크의
//! `target=_blank`, 웹뷰 기본 메뉴의 `Open Link in New Window` …)은 **거절한다** — 그 길은
//! 지금까지 아무것도 열지 않았고(`on_new_window` 가 없으면 WKWebView 는 nil 을 돌려준다),
//! 이 파일이 그 문을 넓히지 않는다. 바깥 주소는 `external_link` 가 브라우저로 넘긴다.
//!
//! **전제**: `popup_label` 은 어느 프레임이 요청했는지 모른다. 메인 안의 다른 출처 프레임(미리보기 iframe)은
//! `sandbox` 에 `allow-popups` 가 없어 이 문에 닿지 못한다. 어떤 iframe 이든 `allow-popups` 를 주는 순간 그
//! 프레임이 `hk-win` 키로 자기 출처의 창을 열 수 있게 된다 — 그때는 이 문에서 요청한 프레임을 가려야 한다.

use tauri::Url;

/// 메인 창의 라벨. `tauri.conf.json` 의 창 선언과 capabilities 가 같은 값을 쓴다.
pub const MAIN_LABEL: &str = "main";

/// 새 창 라벨의 머리. 키(`thread-<uuid>` 같은 것)를 붙여 라벨을 만든다 — 키가 같으면 라벨도
/// 같아서, 이미 띄운 창을 화면이 라벨로 다시 찾는다(`src/lib/appWindows.ts`).
pub const POPUP_PREFIX: &str = "win-";

/// `window.open` 요청이 앱이 연 창이면 그 창의 라벨을, 아니면 `None`(거절).
///
/// 키는 `[a-z0-9-]` 1~80자만 받는다 — 라벨 문법(영숫자·`-`·`/`·`:`·`_`)보다 좁게 잡아
/// 이상한 키가 라벨을 깨거나 다른 창 라벨을 흉내 내지 못하게 한다.
///
/// **`#` 이 `%23` 으로 온다**(실측, Tauri 2.11.5·wry 0.55, 2026-10-06): WKWebView 가 넘기는
/// `absoluteString` 이 `about:blank%23hk-win=…` 이라 `Url::fragment()` 가 비어 있다. 두 꼴을 다 받되
/// 머리(`about:blank`) 뒤는 정확히 이 꼴이어야 한다.
pub fn popup_label(url: &Url) -> Option<String> {
    let rest = url.as_str().strip_prefix("about:blank")?;
    let key = rest.strip_prefix("#hk-win=").or_else(|| rest.strip_prefix("%23hk-win="))?;
    let ok = !key.is_empty()
        && key.len() <= 80
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    ok.then(|| format!("{POPUP_PREFIX}{key}"))
}

/// 메인 창을 세운다. 설정의 창 선언(`create: false`)을 그대로 쓰고 새 창 문만 단다 —
/// 설정에 선언된 창은 빌더를 거치지 않아 `on_new_window` 를 걸 자리가 없다.
pub fn build_main<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    use tauri::Manager as _;
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_LABEL)
        .cloned()
        .expect("tauri.conf.json 에 main 창이 있어야 한다");
    let handle = app.handle().clone();
    let main = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_new_window(move |url, features| {
            let Some(label) = popup_label(&url) else {
                return tauri::webview::NewWindowResponse::Deny;
            };
            // 같은 라벨이 이미 있으면 새로 만들지 않는다. 화면은 먼저 라벨로 찾아 앞으로
            // 가져오므로 여기 오는 일은 거의 없지만, 두 번 눌러 겹친 요청이 창을 둘 만들면 안 된다.
            if let Some(existing) = handle.get_webview_window(&label) {
                let _ = existing.set_focus();
                return tauri::webview::NewWindowResponse::Deny;
            }
            let built = tauri::WebviewWindowBuilder::new(
                &handle,
                &label,
                tauri::WebviewUrl::External(url.clone()),
            )
            .window_features(features)
            .title("Harkroom")
            // 최소 크기는 판 3: 스레드 창 360×420, 채널 창 520×480.
            .min_inner_size(
                if label.starts_with("win-channel-") { 520.0 } else { 360.0 },
                if label.starts_with("win-channel-") { 480.0 } else { 420.0 },
            )
            .disable_drag_drop_handler()
            // 창 제목은 화면이 정한다(`#채널 · 루트 첫 줄`) — 포털 문서의 `document.title` 을 따른다.
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .build();
            match built {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(_) => tauri::webview::NewWindowResponse::Deny,
            }
        })
        .build()?;
    allow_script_windows(&main);
    Ok(())
}

/// 재시작 복원(W2)은 사람이 누르지 않은 `window.open` 이다. WKWebView 는 기본으로 그것을
/// 막는다(`javaScriptCanOpenWindowsAutomatically = NO`). 메인 웹뷰에서만 켠다 — 열 수 있는
/// 것은 위 `popup_label` 이 받은 창뿐이라 이 스위치가 바깥 문을 넓히지 않는다.
#[cfg(target_os = "macos")]
fn allow_script_windows<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| unsafe {
        use objc2::{msg_send, runtime::AnyObject};
        let view = webview.inner() as *mut AnyObject;
        let config: *mut AnyObject = msg_send![view, configuration];
        let prefs: *mut AnyObject = msg_send![config, preferences];
        let _: () = msg_send![prefs, setJavaScriptCanOpenWindowsAutomatically: true];
    });
}

#[cfg(not(target_os = "macos"))]
fn allow_script_windows<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

#[cfg(test)]
mod tests {
    use super::popup_label;
    use tauri::Url;

    fn label(s: &str) -> Option<String> {
        popup_label(&Url::parse(s).unwrap())
    }

    #[test]
    fn 앱이_연_창만_라벨을_받는다() {
        assert_eq!(
            label("about:blank#hk-win=thread-0b7e2c1a-1111-4a4a-9c9c-123456789abc").as_deref(),
            Some("win-thread-0b7e2c1a-1111-4a4a-9c9c-123456789abc")
        );
        assert_eq!(label("about:blank#hk-win=channel-abc").as_deref(), Some("win-channel-abc"));
        // WKWebView 가 실제로 넘기는 꼴
        assert_eq!(label("about:blank%23hk-win=channel-abc").as_deref(), Some("win-channel-abc"));
    }

    #[test]
    fn 그_밖의_새_창_요청은_거절한다() {
        // 본문 링크·기본 메뉴의 Open Link in New Window
        assert_eq!(label("https://github.com/izagood/harkroom"), None);
        assert_eq!(label("tauri://localhost/index.html"), None);
        assert_eq!(label("about:blank"), None);
        assert_eq!(label("about:blank#other=thread-x"), None);
        // 라벨 문법을 깨거나 다른 창을 흉내 내는 키
        assert_eq!(label("about:blank#hk-win="), None);
        assert_eq!(label("about:blank#hk-win=../main"), None);
        assert_eq!(label("about:blank#hk-win=Thread-X"), None);
        assert_eq!(label("about:blank#hk-win=a:b"), None);
        assert_eq!(label(&format!("about:blank#hk-win={}", "a".repeat(81))), None);
        assert_eq!(label("about:srcdoc#hk-win=thread-x"), None);
        assert_eq!(label("about:blank?x=1#hk-win=thread-x"), None);
        assert_eq!(label("about:blank%23hk-win=thread-x%23hk-win=main"), None);
        assert_eq!(label("about:blankx#hk-win=thread-x"), None);
    }
}
