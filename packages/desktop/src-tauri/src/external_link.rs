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

/// 미리보기(아티팩트) 서명 URL 의 **한 번짜리 허용**(#1069 A′, jaebin 결정 1c3401f3).
///
/// 왜 필요한가: wry 는 하위 프레임(iframe)의 이동까지 이 훅으로 보내고, URL 말고는 아무것도 주지 않는다
/// (wry 0.55 `navigation_policy` — `isMainFrame` 을 보지 않는다). 그래서 미리보기 패널의 iframe 첫 로드
/// (`https://<서버>/preview/<토큰>`)가 `judge` 에서 `OpenExternally` 가 되어 **토큰 URL 이 시스템 브라우저로
/// 나가고 패널은 빈다.**
///
/// 왜 `judge` 에 경로 규칙을 더하지 않는가: 그 규칙은 main 웹뷰에도 열린다. 에이전트가 글에 `/preview/…`
/// 링크를 걸고 사람이 오른쪽 클릭 → Open Link 를 누르면, 60초 안에서는 앱 화면 전체가 에이전트 페이지로 덮인다
/// (security). 그래서 **앱이 방금 받은 그 서명 URL 하나만, 한 번, 90초 안에서만** 통과시킨다. 앱 화면은 그 URL 로
/// 이동할 일이 없고, 그 URL 은 iframe 이 곧바로 써 버린다. 그 밖의 판정은 `judge` 그대로다.
pub struct PreviewAllowance {
    slot: std::sync::Mutex<Option<(Url, std::time::Instant)>>,
}

/// 허용의 수명. 서명 URL 자체가 60초라 그보다 조금 길게 둔다 — 이 칸이 먼저 닫혀 첫 로드를 막는 일이 없게.
pub const PREVIEW_ALLOW_TTL: std::time::Duration = std::time::Duration::from_secs(90);

impl Default for PreviewAllowance {
    fn default() -> Self {
        Self { slot: std::sync::Mutex::new(None) }
    }
}

impl PreviewAllowance {
    /// 다음 이동 하나를 허용해 둔다. http(s) 이고 경로가 `/preview/` 로 시작하는 것만 받는다 — 이 칸이 다른
    /// 주소를 여는 문이 되면 안 된다. 새로 쥐면 앞의 것은 버린다(칸은 하나다).
    pub fn allow(&self, raw: &str, now: std::time::Instant) -> Result<(), &'static str> {
        let url = Url::parse(raw).map_err(|_| "not a url")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("only http(s) preview urls");
        }
        if !url.path().starts_with("/preview/") || url.fragment().is_some() {
            return Err("only /preview/ paths");
        }
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some((url, now + PREVIEW_ALLOW_TTL));
        Ok(())
    }

    /// 이 이동이 쥔 그 URL 이고 만료 전이면 true 를 주고 **칸을 비운다**(한 번만). 만료됐으면 비우고 false.
    /// 다른 URL 이면 칸을 그대로 둔다 — 프레임이 첫 로드 전에 `about:blank` 를 거치는 일이 있다.
    pub fn take(&self, url: &Url, now: std::time::Instant) -> bool {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref() {
            Some((_, expires)) if now >= *expires => {
                *slot = None;
                false
            }
            Some((held, _)) if held == url => {
                *slot = None;
                true
            }
            _ => false,
        }
    }
}

/// 이동 훅을 다는 플러그인. 창이 `tauri.conf.json` 에 선언되어 있어 창 빌더에 훅을 걸 수
/// 없으므로(빌더는 `setup` 시점에 이미 지나갔다), 런타임이 **모든 웹뷰**에 대해 부르는
/// 플러그인 훅을 쓴다.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("external-link")
        .setup(|app, _api| {
            use tauri::Manager as _;
            app.manage(PreviewAllowance::default());
            Ok(())
        })
        .on_navigation(|webview, url| {
            use tauri::Manager as _;
            // 앱이 방금 쥔 미리보기 서명 URL 이면 한 번만 통과시킨다(위 `PreviewAllowance`). 그 밖은 `judge`.
            if let Some(allowance) = webview.try_state::<PreviewAllowance>() {
                if allowance.take(url, std::time::Instant::now()) {
                    return true;
                }
            }
            match judge(url) {
            Verdict::Allow => true,
            Verdict::OpenExternally => {
                open_in_browser(webview, url.as_str());
                false
            }
            Verdict::Block => false,
            }
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
    use super::{judge, PreviewAllowance, Verdict, PREVIEW_ALLOW_TTL};
    use std::time::{Duration, Instant};
    use tauri::Url;

    const TOK: &str = "https://server.example.com/preview/AbC123";

    fn u(raw: &str) -> Url {
        Url::parse(raw).expect("test url")
    }

    #[test]
    fn preview_allowance_lets_the_held_url_through_once() {
        let a = PreviewAllowance::default();
        let t0 = Instant::now();
        a.allow(TOK, t0).unwrap();
        assert!(a.take(&u(TOK), t0 + Duration::from_secs(1)));
        // 두 번째는 원래 규칙으로 돌아간다(이 칸은 비었다).
        assert!(!a.take(&u(TOK), t0 + Duration::from_secs(2)));
        assert_eq!(judge(&u(TOK)), Verdict::OpenExternally);
    }

    #[test]
    fn preview_allowance_expires() {
        let a = PreviewAllowance::default();
        let t0 = Instant::now();
        a.allow(TOK, t0).unwrap();
        assert!(!a.take(&u(TOK), t0 + PREVIEW_ALLOW_TTL));
        // 만료로 비운 뒤에는 다시 와도 통과하지 않는다.
        assert!(!a.take(&u(TOK), t0));
    }

    #[test]
    fn preview_allowance_does_not_open_other_preview_urls() {
        let a = PreviewAllowance::default();
        let t0 = Instant::now();
        a.allow(TOK, t0).unwrap();
        assert!(!a.take(&u("https://server.example.com/preview/OTHER"), t0));
        assert!(!a.take(&u("https://evil.example.com/preview/AbC123"), t0));
        assert!(!a.take(&u("http://server.example.com/preview/AbC123"), t0));
        // 다른 URL 은 칸을 비우지 않는다 — 쥔 그것은 여전히 한 번 통과한다.
        assert!(a.take(&u(TOK), t0));
    }

    #[test]
    fn preview_allowance_only_holds_preview_paths() {
        let a = PreviewAllowance::default();
        let t0 = Instant::now();
        assert!(a.allow("https://server.example.com/channels", t0).is_err());
        assert!(a.allow("https://server.example.com/preview/x#frag", t0).is_err());
        assert!(a.allow("javascript:alert(1)", t0).is_err());
        assert!(a.allow("file:///preview/x", t0).is_err());
        assert!(a.allow("not a url", t0).is_err());
    }

    #[test]
    fn holding_a_preview_url_does_not_change_other_verdicts() {
        let a = PreviewAllowance::default();
        a.allow(TOK, Instant::now()).unwrap();
        assert_eq!(judge(&u("tauri://localhost/index.html")), Verdict::Allow);
        assert_eq!(judge(&u("https://github.com/")), Verdict::OpenExternally);
        assert_eq!(judge(&u("javascript:alert(1)")), Verdict::Block);
    }

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
            v("https://github.com/acme-org/udc-k8s/pull/9420"),
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
