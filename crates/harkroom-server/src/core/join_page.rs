//! S5.4 — 초대 안내 페이지. TS `routes/joinPage.ts` 의 `GET /join` 을 옮긴다.
//!
//! 본문·헤더는 TS 와 바이트까지 같다. 인라인 스크립트 하나만 CSP 해시로 허락한다 — 해시는 [`SCRIPT`] 에서 처음 한 번 계산한다.
//! DB 를 건드리지 않는다(권한 없음).
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};

/// 이 줄은 DB 를 쓰지 않는다.
pub const JOIN_PAGE_PRIVILEGES: &[(&str, &str)] = &[];

const SCRIPT: &str = r#"
(function () {
  var token = decodeURIComponent((location.hash || '').slice(1));
  var server = location.origin;
  document.getElementById('server').textContent = server;
  var t = document.getElementById('token');
  if (/^hrki_[A-Za-z0-9_-]+$/.test(token)) { t.textContent = token; }
  else { document.getElementById('tokenRow').hidden = true; document.getElementById('noToken').hidden = false; }
  document.querySelectorAll('button[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = document.getElementById(b.getAttribute('data-copy')).textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(v).then(function () { b.textContent = b.getAttribute('data-done'); });
    });
  });
})();
"#;

const HTML_HEAD: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Join Harkroom</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--sub:#666;--box:#fff;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--sub:#aaa;--box:#222;--line:#333}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:520px;margin:48px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}p{color:var(--sub);margin:0 0 16px}
.row{background:var(--box);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0 0 12px}
.label{font-size:12px;color:var(--sub)}code{display:block;word-break:break-all;font-size:14px;margin:2px 0 6px}
button{font:inherit;font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
ol{padding-left:20px;color:var(--sub)}a{color:inherit}
</style></head><body><main>
<h1>Join Harkroom · Harkroom 가입</h1>
<p>You were invited to this workspace. · 이 워크스페이스에 초대받았습니다.</p>
<div class="row"><div class="label">Server address · 서버 주소</div><code id="server"></code>
<button type="button" data-copy="server" data-done="Copied · 복사함">Copy · 복사</button></div>
<div class="row" id="tokenRow"><div class="label">Invite token · 초대 토큰</div><code id="token"></code>
<button type="button" data-copy="token" data-done="Copied · 복사함">Copy · 복사</button></div>
<p id="noToken" hidden>No invite token in this link. Open the link from your invite email again. · 이 링크에 초대 토큰이 없습니다. 초대 메일의 링크를 다시 여세요.</p>
<ol>
<li>Install the app: <a href="https://github.com/izagood/harkroom/releases" rel="noopener noreferrer">Harkroom releases</a> · 앱 설치</li>
<li>Open it, enter the server address, and choose Sign up. · 앱을 열고 서버 주소를 넣은 뒤 「가입」을 고르세요.</li>
<li>Paste the invite token. It works once and expires. · 초대 토큰을 붙여 넣으세요. 한 번만 쓰이고 기한이 있습니다.</li>
</ol>
</main><script>"#;

const HTML_TAIL: &str = r#"</script></body></html>"#;

fn script_hash() -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SCRIPT.as_bytes()))
}

fn page() -> &'static (String, String) {
    static P: OnceLock<(String, String)> = OnceLock::new();
    P.get_or_init(|| {
        (
            format!("{HTML_HEAD}{SCRIPT}{HTML_TAIL}"),
            format!(
                "default-src 'none'; script-src 'sha256-{}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                script_hash()
            ),
        )
    })
}

/// `GET /join`.
pub async fn join() -> Response {
    let (html, csp) = page();
    let mut r = html.clone().into_response();
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(csp) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

pub fn routes(cors: Arc<crate::cors::Cors>) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<()>::new()
        .get("/join", join)
        .map(|r| {
            r.layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router,
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn script_hash_matches_ts() {
        // node: createHash('sha256').update(SCRIPT).digest('base64')
        assert_eq!(
            super::script_hash(),
            "xqC7x6PW/7dTb5bRNIbPKvbUylBdcSYkXS+GlyDtY/c="
        );
    }

    #[test]
    fn page_embeds_script_once() {
        let (html, csp) = super::page();
        assert_eq!(html.matches("<script>").count(), 1);
        assert!(html.contains(super::SCRIPT));
        assert!(csp.contains("'sha256-"));
    }
}
