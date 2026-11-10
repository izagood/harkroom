//! 브라우저 인증(OAuth)이 localhost 콜백으로 돌아왔을 때 사람에게 보여 주는 페이지(A5d).
//! 정본은 `packages/operator/src/callbackPage.ts` 다 — 문구·스타일·CSP 를 **바이트까지 같게** 옮긴다
//! (`tests/callback_page_golden.rs` 가 TS 가 낸 페이지와 비교한다).
//!
//! - 스타일·스크립트는 고정 문자열이라 CSP 에 sha256 해시로만 허용한다 — 이스케이프가 새도 주입된 것은 돌지 않는다.
//! - 스크립트는 한 줄 — 주소줄에서 `?code=…&state=…` 를 지운다(캡처·화면 공유에 인증 코드가 찍히지 않게).
//! - `name`·`code` 는 쿼리·인가 서버에서 온 값일 수 있다 → 전부 HTML 이스케이프한다.
use base64::Engine;

use crate::local_mcp::js_trim;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 토큰을 받아 저장했다
    Ok,
    /// state 불일치 — 만료·다른 시도·이미 끝난 흐름
    Expired,
    /// 인가 서버가 거절했다(error=)·code 가 없다
    Denied,
    /// 코드 → 토큰 교환이 실패했다
    ExchangeFailed,
    /// 토큰은 받았지만 저장하지 못했다
    SaveFailed,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Ok => "ok",
            Kind::Expired => "expired",
            Kind::Denied => "denied",
            Kind::ExchangeFailed => "exchange_failed",
            Kind::SaveFailed => "save_failed",
        }
    }
    pub fn status(self) -> u16 {
        match self {
            Kind::Ok => 200,
            Kind::SaveFailed => 500,
            _ => 400,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ko,
    En,
}

impl Lang {
    fn as_str(self) -> &'static str {
        match self {
            Lang::Ko => "ko",
            Lang::En => "en",
        }
    }
}

/// `Accept-Language` 의 첫 언어가 ko 면 한국어, 아니면 영어.
pub fn lang_of(accept_language: Option<&str>) -> Lang {
    let first = accept_language
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    if first == "ko" || first.starts_with("ko-") {
        Lang::Ko
    } else {
        Lang::En
    }
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// 사유 코드는 사람이 읽을 한 줄이면 된다 — 인가 서버가 긴 본문을 줘도 자른다(JS `slice` 처럼 UTF-16 단위).
const CODE_MAX: usize = 120;

fn js_slice(s: &str, max: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

fn title(lang: Lang, kind: Kind) -> &'static str {
    match (lang, kind) {
        (Lang::Ko, Kind::Ok) => "연결됐습니다",
        (Lang::Ko, Kind::Expired) => "인증 시간이 지났습니다",
        (Lang::Ko, _) => "연결하지 못했습니다",
        (Lang::En, Kind::Ok) => "Connected",
        (Lang::En, Kind::Expired) => "This sign-in link has expired",
        (Lang::En, _) => "Couldn't connect",
    }
}

/// `name` 은 이스케이프해 굵게 감싼 이름, 없으면 None.
fn desc(lang: Lang, kind: Kind, n: Option<&str>) -> String {
    match (lang, kind) {
        (Lang::Ko, Kind::Ok) => format!(
            "{} 마쳤습니다.<br>Harkroom 앱으로 돌아가면 바로 쓸 수 있습니다.",
            n.map_or("인증을".to_string(), |n| format!("{n} 인증을"))
        ),
        (Lang::Ko, Kind::Expired) => {
            "이 링크는 더 이상 쓸 수 없습니다.<br>Harkroom 앱에서 인증을 다시 시작하세요."
                .to_string()
        }
        (Lang::Ko, Kind::Denied) => format!(
            "{} 접근을 허용하지 않았습니다.<br>Harkroom 앱의 설정 › MCP에서 다시 인증하세요.",
            n.map_or("인증 서버가".to_string(), |n| format!("{n}에서"))
        ),
        (Lang::Ko, Kind::ExchangeFailed) => format!(
            "{} 인증을 마무리하지 못했습니다.<br>앱에서 다시 시도하세요.",
            n.map_or("인증 서버가".to_string(), |n| format!("{n} 서버가"))
        ),
        (Lang::Ko, Kind::SaveFailed) => {
            "인증은 받았지만 Harkroom이 저장하지 못했습니다.<br>앱에서 다시 시도하세요.".to_string()
        }
        (Lang::En, Kind::Ok) => format!(
            "{}.<br>Head back to the Harkroom app — it's ready to use.",
            n.map_or("Signed in".to_string(), |n| format!("Signed in to {n}"))
        ),
        (Lang::En, Kind::Expired) => {
            "This link can no longer be used.<br>Start the sign-in again from the Harkroom app."
                .to_string()
        }
        (Lang::En, Kind::Denied) => format!(
            "{} didn't grant access.<br>Sign in again from Settings › MCP in the Harkroom app.",
            n.unwrap_or("The server")
        ),
        (Lang::En, Kind::ExchangeFailed) => format!(
            "{} couldn't finish the sign-in.<br>Try again from the app.",
            n.unwrap_or("The server")
        ),
        (Lang::En, Kind::SaveFailed) => {
            "Sign-in succeeded, but Harkroom couldn't save it.<br>Try again from the app."
                .to_string()
        }
    }
}

fn close_text(lang: Lang) -> &'static str {
    match lang {
        Lang::Ko => "이 탭은 닫아도 됩니다.",
        Lang::En => "You can close this tab.",
    }
}

// Paper 토큰(packages/desktop/src/index.css) — 라이트 / 다크. callbackPage.ts 의 STYLE 을 줄바꿈으로 이은 것.
const STYLE: &str = concat!(
    ":root{color-scheme:light dark;--s:#fbfaf8;--r:#fff;--b:#e6e2dc;--f:#1b1a19;--m:#6b665f;--u:#8e8880;--br:#e4572e;--ok:#1b7d45;--oks:#e6f6ec;--bad:#b42318;--bads:#fdecea}\n",
    "@media (prefers-color-scheme:dark){:root{--s:#1c1b19;--r:#262422;--b:#34312e;--f:#ebe7e2;--m:#9a938b;--u:#7a746c;--br:#ff7a4a;--ok:#5ccf86;--oks:#16301f;--bad:#ff8a80;--bads:#3a1d1b}}\n",
    "*{box-sizing:border-box}\n",
    "html,body{height:100%}\n",
    "body{margin:0;background:var(--s);color:var(--f);font:15px/1.55 -apple-system,BlinkMacSystemFont,\"Apple SD Gothic Neo\",\"Pretendard\",\"Segoe UI\",system-ui,sans-serif;display:grid;place-items:center;padding:32px 16px}\n",
    ".card{width:100%;max-width:380px;background:var(--r);border:1px solid var(--b);border-radius:14px;padding:28px 26px 22px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}\n",
    ".logo{display:flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:13px;letter-spacing:-.01em;margin-bottom:22px}\n",
    ".logo svg{width:22px;height:22px}.logo .c{stroke:var(--br)}\n",
    ".st{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px}\n",
    ".st.ok{background:var(--oks);color:var(--ok)}.st.bad{background:var(--bads);color:var(--bad)}\n",
    ".st svg{width:24px;height:24px}\n",
    "h1{font-size:18px;font-weight:650;margin:0 0 6px;letter-spacing:-.01em}\n",
    ".d{color:var(--m);margin:0;font-size:14px;overflow-wrap:anywhere}\n",
    ".d b{color:var(--f);font-weight:600}\n",
    ".code{margin:14px auto 0;display:inline-block;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--u);border:1px solid var(--b);border-radius:6px;padding:2px 8px;max-width:100%;overflow-wrap:anywhere}\n",
    ".ft{margin-top:22px;padding-top:14px;border-top:1px solid var(--b);font-size:12.5px;color:var(--u)}",
);

// 주소줄에서 쿼리(code·state)를 지운다. 경로는 그대로 둔다.
const SCRIPT: &str = "history.replaceState(null,'',location.pathname);";

fn hash(s: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, s.as_bytes());
    format!(
        "'sha256-{}'",
        base64::engine::general_purpose::STANDARD.encode(d.as_ref())
    )
}

/// 스타일·스크립트는 고정 문자열이라 해시로만 허용한다.
pub fn csp() -> String {
    [
        "default-src 'none'".to_string(),
        format!("style-src {}", hash(STYLE)),
        format!("script-src {}", hash(SCRIPT)),
        "img-src 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "form-action 'none'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
}

const LOGO: &str = "<svg viewBox=\"0 0 128 128\" aria-hidden=\"true\"><g stroke=\"currentColor\" stroke-width=\"10\" stroke-linecap=\"round\"><path d=\"M20 52V76M35 42V86M50 31V97M80 33V95M95 45V83M110 53V75\"/></g><path class=\"c\" d=\"M65 18V110\" stroke-width=\"10\" stroke-linecap=\"round\"/></svg>";
const ICON_OK: &str = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"/></svg>";
const ICON_BAD: &str = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M7 7l10 10M17 7L7 17\"/></svg>";
const ICON_CLOCK: &str = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/></svg>";

pub struct Page {
    pub status: u16,
    /// 이름은 소문자, TS 와 같은 순서.
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

pub fn render(kind: Kind, name: Option<&str>, code: Option<&str>, lang: Lang) -> Page {
    let t = title(lang, kind);
    let trimmed = name.map(js_trim).filter(|s| !s.is_empty());
    let bold = trimmed.map(|n| format!("<b>{}</b>", esc(n)));
    let icon = match kind {
        Kind::Ok => ICON_OK,
        Kind::Expired => ICON_CLOCK,
        _ => ICON_BAD,
    };
    let code_html = match (kind, code) {
        (Kind::Denied | Kind::ExchangeFailed, Some(c)) if !c.is_empty() => {
            format!("<div class=\"code\">{}</div>", esc(&js_slice(c, CODE_MAX)))
        }
        _ => String::new(),
    };
    let body = format!(
        "<!doctype html>\n<html lang=\"{lang}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"referrer\" content=\"no-referrer\">\n<title>{title} · Harkroom</title>\n<style>{STYLE}</style></head>\n<body><main class=\"card\" data-kind=\"{kind}\">\n<div class=\"logo\">{LOGO}Harkroom</div>\n<div class=\"st {st}\">{icon}</div>\n<h1>{title}</h1>\n<p class=\"d\">{desc}</p>\n{code_html}<div class=\"ft\">{close}</div>\n</main><script>{SCRIPT}</script></body></html>\n",
        lang = lang.as_str(),
        title = esc(t),
        kind = kind.as_str(),
        st = if kind == Kind::Ok { "ok" } else { "bad" },
        desc = desc(lang, kind, bold.as_deref()),
        close = esc(close_text(lang)),
    );
    Page {
        status: kind.status(),
        headers: vec![
            ("content-type", "text/html; charset=utf-8".to_string()),
            ("content-security-policy", csp()),
            ("cache-control", "no-store".to_string()),
            ("referrer-policy", "no-referrer".to_string()),
            ("x-content-type-options", "nosniff".to_string()),
        ],
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_picks_first_tag() {
        assert_eq!(lang_of(Some("ko-KR,en;q=0.8")), Lang::Ko);
        assert_eq!(lang_of(Some(" KO ")), Lang::Ko);
        assert_eq!(lang_of(Some("en-US,ko;q=0.9")), Lang::En);
        assert_eq!(lang_of(Some("kok")), Lang::En);
        assert_eq!(lang_of(None), Lang::En);
    }

    #[test]
    fn escapes_name_and_code() {
        let p = render(Kind::Denied, Some("<x>"), Some("\"a'&"), Lang::En);
        assert!(p.body.contains("<b>&lt;x&gt;</b> didn't grant"));
        assert!(
            p.body
                .contains("<div class=\"code\">&quot;a&#39;&amp;</div>")
        );
        assert_eq!(p.status, 400);
    }

    #[test]
    fn code_only_on_failure_kinds() {
        assert!(
            !render(Kind::Ok, None, Some("x"), Lang::Ko)
                .body
                .contains("class=\"code\"")
        );
        assert!(
            !render(Kind::SaveFailed, None, Some("x"), Lang::Ko)
                .body
                .contains("class=\"code\"")
        );
        assert_eq!(render(Kind::SaveFailed, None, None, Lang::Ko).status, 500);
    }
}
