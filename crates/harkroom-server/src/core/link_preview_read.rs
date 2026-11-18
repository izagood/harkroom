//! S5.4 — `GET /link-previews?url=`(TS `linkPreviewRoutes.ts`). 캐시된 미리보기 카드 한 장을 읽는다.
//!
//! - 인증(401, `route_layer`) → `url` 쿼리 zod(`z.string().min(1)`, 400 `url is required`) → shared `normalizePreviewUrl`
//!   (400 `not a previewable url`) → 행 없음 404 → 행(TS `getLinkPreviewByUrl` 키 순서 그대로).
//! - **만료된 행**(TS `isStale`: ok 는 7일, failed·blocked 는 1시간)은 그대로 주고 [`super::link_preview_fetch::queue_fetch`] 로
//!   백그라운드에서 다시 가져온다. 쓰기 풀이 없으면(권한 부족) 요청 그대로 TS 로 넘긴다.
//! - **읽기만 한다.** 새 GRANT 없음 — [`LINK_PREVIEW_READ_PRIVILEGES`], 없으면 `main.rs` 가 TS 에 남긴다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, RawQuery, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한(칸 단위).
pub const LINK_PREVIEW_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("link_preview.url", "SELECT"),
    ("link_preview.title", "SELECT"),
    ("link_preview.description", "SELECT"),
    ("link_preview.image_url", "SELECT"),
    ("link_preview.site_name", "SELECT"),
    ("link_preview.status", "SELECT"),
    ("link_preview.fetched_at", "SELECT"),
];

const ROW_SQL: &str = "select json_build_object('url', url, 'title', title, 'description', description, \
     'imageUrl', image_url, 'siteName', site_name, 'status', status, \
     'fetchedAt', to_char(fetched_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))::text, \
     (case when status = 'ok' then clock_timestamp() - fetched_at > interval '7 days' \
      else clock_timestamp() - fetched_at > interval '1 hour' end) as stale \
     from link_preview where url = $1";

pub struct LinkPreviewState {
    pub read: PgPool,
    /// 재가져오기용 쓰기 풀([`super::link_preview_fetch::LINK_PREVIEW_WRITE_PRIVILEGES`]). 없으면 만료된 행은 TS 로.
    pub write: Option<PgPool>,
    pub up: Upstream,
}

fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// shared `normalizePreviewUrl` — http/https 만, 자격증명 거절, fragment·호스트 후행 점 제거.
pub(crate) fn normalize_preview_url(raw: &str) -> Option<String> {
    let mut u = url::Url::parse(raw.trim_matches(js_ws)).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some_and(|p| !p.is_empty()) {
        return None;
    }
    u.set_fragment(None);
    let host = u.host_str()?.trim_end_matches('.').to_owned();
    if host.is_empty() {
        return None;
    }
    if u.host_str() != Some(host.as_str()) {
        u.set_host(Some(&host)).ok()?;
    }
    Some(u.to_string())
}

/// 쿼리의 `url` — 한 번만, 빈 글자 아님(여러 번이면 배열이라 zod 400).
fn query_url(raw: Option<&str>) -> Option<String> {
    let mut found: Option<String> = None;
    for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        if k == "url" {
            if found.is_some() {
                return None;
            }
            found = Some(v.into_owned());
        }
    }
    found.filter(|s| !s.is_empty())
}

pub async fn link_preview(
    State(st): State<Arc<LinkPreviewState>>,
    RequireAccount(_me, _auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RawQuery(raw): RawQuery,
    req: Request,
) -> Response {
    let Some(q) = query_url(raw.as_deref()) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", "url is required");
    };
    let Some(key) = normalize_preview_url(&q) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "not a previewable url",
        );
    };
    let row: Option<(String, bool)> = match sqlx::query_as(ROW_SQL)
        .bind(&key)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    match row {
        None => json_err(StatusCode::NOT_FOUND, "not_found", "link preview not found"),
        Some((text, true)) if st.write.is_some() => {
            // TS 와 같이 만료된 카드를 먼저 주고 백그라운드에서 갱신한다.
            if let Some(w) = &st.write {
                tokio::spawn(super::link_preview_fetch::queue_fetch(w.clone(), key));
            }
            json_ok(text)
        }
        Some((_, true)) => {
            crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await
        }
        Some((text, false)) => json_ok(text),
    }
}

pub fn routes(
    st: LinkPreviewState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<LinkPreviewState>>::new()
        .get("/link-previews", link_preview)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_like_shared() {
        let n = normalize_preview_url;
        assert_eq!(
            n(" https://Example.COM./a#x ").as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(
            n("http://example.com:80/").as_deref(),
            Some("http://example.com/")
        );
        assert_eq!(
            n("http://2130706433/").as_deref(),
            Some("http://127.0.0.1/")
        );
        assert_eq!(n("ftp://example.com/"), None);
        assert_eq!(n("https://u:p@example.com/"), None);
        assert_eq!(n("https://u@example.com/"), None);
        assert_eq!(n("nope"), None);
        assert_eq!(
            query_url(Some("url=https%3A%2F%2Fa.b")).as_deref(),
            Some("https://a.b")
        );
        assert_eq!(query_url(Some("url=")), None);
        assert_eq!(query_url(Some("url=a&url=b")), None);
        assert_eq!(query_url(None), None);
    }
}
