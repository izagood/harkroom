//! 웹뷰가 **앱 밖으로 나가는 것을 막는 문**. 나가려던 주소는 OS 기본 브라우저로 넘긴다.
//!
//! ## 왜 이것이 필요한가 (실측, 2026-09-22)
//!
//! 본문의 링크를 **왼쪽 클릭**하면 `MessageBody` 가 `preventDefault` 하고
//! `openExternal` 로 OS 에 넘긴다 — 그 길은 처음부터 맞았다. 그런데 macOS 웹뷰(WKWebView)는
//! 링크 위에서 **오른쪽 클릭**하면 자기 기본 메뉴(`Open Link` · `Open Link in New Window` ·
//! `Download Linked File`)를 띄우고, 거기서 고른 `Open Link` 는 자바스크립트를 **거치지 않고**
//! 웹뷰를 그 주소로 이동시킨다. 그 결과 GitHub 페이지가 앱 화면 자리를 통째로 덮었고,
//! 돌아올 길(뒤로 가기 UI)이 없어 앱을 다시 띄워야 했다.
//!
//! ## 왜 화면단이 아니라 여기인가
//!
//! 화면에서 `contextmenu` 를 막아도 그것은 **그 메뉴 하나**를 지울 뿐이고, 자바스크립트를
//! 거치지 않는 이동 경로(드래그&드롭, 새 창 요청, 웹뷰가 스스로 따라가는 리다이렉트)는
//! 그대로 남는다. 이동은 한 곳에서만 판정한다 — 그 자리가 런타임의 내비게이션 훅이다.
//! 앱은 자기 화면 밖으로 **이동할 일이 애초에 없다**(iframe 도, `location` 대입도 없다).
//! 그래서 "앱 출처가 아니면 이동이 아니다"가 이 파일의 규칙 전부다.

use tauri::Url;

/// 이동 요청 하나에 대한 판정.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 앱 자신의 화면이다. 그대로 간다.
    Allow,
    /// 앱 밖이다. 이동은 취소하고 **OS 기본 브라우저**로 넘긴다.
    OpenExternally,
    /// 앱 밖인데 브라우저로 넘길 것도 아니다(`javascript:` · `file:` · `data:` …).
    /// 취소만 하고 아무것도 열지 않는다 — 본문에서 링크가 되는 스킴은 http/https 뿐인데
    /// (`shared` 의 `LINK_SCHEMES`), 그 밖의 스킴으로 이동이 들어왔다면 사람이 누른 링크가
    /// 아니다.
    Block,
}

/// 앱 자신의 화면으로 인정하는 호스트. 프로덕션은 `tauri://localhost`(macOS·Linux) 또는
/// `http://tauri.localhost`(Windows), 개발은 `devUrl` 의 `http://localhost:5173` 이다.
fn is_app_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("tauri.localhost") | Some("127.0.0.1") | Some("[::1]")
    )
}

/// **판정은 이 함수 하나다** — 훅은 이 결과를 실행만 한다. 그래야 규칙을 프로세스 없이
/// 테스트로 고정할 수 있다(아래 `tests`).
pub fn judge(url: &Url) -> Verdict {
    match url.scheme() {
        // 커스텀 프로토콜(프로덕션 자산·IPC)과 첫 화면. 앱 자신이다.
        "tauri" | "ipc" | "about" | "blob" => Verdict::Allow,
        "http" | "https" => {
            if is_app_host(url) {
                Verdict::Allow
            } else {
                Verdict::OpenExternally
            }
        }
        _ => Verdict::Block,
    }
}

/// 이동 훅을 다는 플러그인. 창이 `tauri.conf.json` 에 선언되어 있어 창 빌더에 훅을 걸 수
/// 없으므로(빌더는 `setup` 시점에 이미 지나갔다), 런타임이 **모든 웹뷰**에 대해 부르는
/// 플러그인 훅을 쓴다.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("external-link")
        .on_navigation(|webview, url| match judge(url) {
            Verdict::Allow => true,
            Verdict::OpenExternally => {
                open_in_browser(webview, url.as_str());
                false
            }
            Verdict::Block => false,
        })
        .build()
}

/// 브라우저로 넘긴다. **실패해도 이동을 되살리지 않는다** — 앱 화면이 덮이는 것보다
/// 아무 일도 일어나지 않는 편이 낫고, 링크를 여는 정상 경로(왼쪽 클릭)는 실패를 화면에
/// 띄우는 자기 길을 이미 갖고 있다(`openExternal.ts`).
fn open_in_browser<R: tauri::Runtime>(webview: &tauri::Webview<R>, url: &str) {
    use tauri::Manager as _;
    use tauri_plugin_shell::ShellExt as _;

    #[allow(deprecated)]
    if let Err(err) = webview.app_handle().shell().open(url, None) {
        eprintln!("[external-link] failed to open {url} in the browser: {err}");
    }
}

#[cfg(test)]
mod tests {
    //! 회귀선은 한 문장이다: **앱 출처가 아닌 http(s) 이동은 절대 허용되지 않는다.**
    //! `Verdict::Allow` 가 거기서 나오는 순간 화면이 덮이는 그 버그가 돌아온다.
    use super::{judge, Verdict};
    use tauri::Url;

    fn v(raw: &str) -> Verdict {
        judge(&Url::parse(raw).expect("test url"))
    }

    #[test]
    fn app_origins_navigate_normally() {
        assert_eq!(v("tauri://localhost/index.html"), Verdict::Allow);
        assert_eq!(v("http://localhost:5173/"), Verdict::Allow);
        assert_eq!(v("http://tauri.localhost/"), Verdict::Allow);
        assert_eq!(v("about:blank"), Verdict::Allow);
    }

    #[test]
    fn outside_links_go_to_the_browser() {
        assert_eq!(
            v("https://github.com/rebellions-sw/udc-k8s/pull/9420"),
            Verdict::OpenExternally
        );
        // 호스트가 앱 호스트로 **끝나기만** 하는 주소에 속으면 안 된다.
        assert_eq!(v("https://evil.localhost.example.com/"), Verdict::OpenExternally);
        assert_eq!(v("http://example.com/localhost"), Verdict::OpenExternally);
    }

    #[test]
    fn other_schemes_open_nothing() {
        assert_eq!(v("file:///etc/passwd"), Verdict::Block);
        assert_eq!(v("data:text/html,<h1>hi</h1>"), Verdict::Block);
        assert_eq!(v("javascript:alert(1)"), Verdict::Block);
    }
}
