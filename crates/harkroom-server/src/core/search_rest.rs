//! S5.4 MS2a — `GET /search`(TS `routes/messageRoutes.ts`). 문장·상한·`hasMore` 는 MCP `message.search`([`super::mcp::search`])와
//! **같은 것**을 쓴다 — 가시성 술어·스코프·거르기는 그 골든 문장(`SEARCH_MESSAGES_SQL`) 안에 있다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401, 층) → 질의 검사 → `channelId` 가 있으면 볼 수 있는가(403) → 찾기.
//! - REST 는 MCP 와 두 군데가 다르다: 본문을 `<@id>` 그대로 싣는다(`denormalize` 없음), `hasAttachment` 는 `'true'` 일 때만 참이고
//!   그 밖은 거짓(`$10 is not true` 라 거짓과 없음은 같은 결과).
//! - **답하지 않고 읽은 요청 그대로 TS 로 넘기는 것**(보수적으로 — 판정을 옮기지 않은 것과, TS 가 400 으로 답할 것 전부):
//!   - 질의에 `@` 가 있으면 — TS `normalizeSearchQuery` 가 `@handle` 을 `<@id>` 로 바꾼다(MCP 와 같은 경계).
//!   - `after`·`before` 가 있으면 — zod `datetime({ offset: true })` 판정을 옮기지 않는다.
//!   - 형식이 zod 와 정확히 맞는지 확신할 수 없는 값 — `q` 길이 밖, uuid 가 아닌 id, 숫자만이 아닌 `offset`(TS `Number()` 는
//!     `""`·`" 5"`·`1e2` 도 받는다), 천장 밖 `offset`, 모르는 `sort`·`hasAttachment`, 11개 넘는 `authorId`, `authorId` 밖 키의 되풀이.
//!     TS 가 같은 요청에 400(또는 그 값을 받아 200)으로 답하므로 응답이 갈리지 않는다.
use crate::auth::RequireAccount;
use crate::core::mcp::respond::minify;
use crate::core::mcp::search::{LIMIT, SEARCH_MAX_AUTHORS, SEARCH_MAX_OFFSET, has_more, sql};
use crate::directory::{internal, json_err, json_ok};
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

pub struct SearchState {
    /// 읽기 풀 — SELECT 만 한다.
    pub pool: PgPool,
    /// Rust 가 맡지 않는 요청을 넘길 TS.
    pub up: Upstream,
}

/// 검사를 통과한 질의 — TS `searchMessages` 에 넘기는 값과 같다.
#[derive(Debug, PartialEq)]
struct Q {
    query: String,
    channel: Option<String>,
    thread: Option<String>,
    offset: i64,
    authors: Option<Vec<String>>,
    has_attachment: bool,
    recent: bool,
}

/// 질의 문자열을 읽는다. Rust 가 TS 와 같은 답을 낸다고 확신할 수 없으면 `None`(→ TS).
fn parse(raw: Option<&str>) -> Option<Q> {
    let mut q: Option<String> = None;
    let mut channel: Option<String> = None;
    let mut thread: Option<String> = None;
    let mut offset: Option<i64> = None;
    let mut authors: Vec<String> = Vec::new();
    let mut has_attachment: Option<bool> = None;
    let mut recent: Option<bool> = None;
    let mut seen: Vec<String> = Vec::new();
    for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        let (k, v) = (k.into_owned(), v.into_owned());
        if k == "authorId" {
            if !crate::core::channels::is_uuid(&v) {
                return None;
            }
            authors.push(v);
            continue;
        }
        // 되풀이된 키는 TS 에서 배열이 된다 — 아래 키들은 문자열만 받으니 400. 판정은 TS 에 맡긴다.
        if seen.contains(&k) {
            return None;
        }
        seen.push(k.clone());
        match k.as_str() {
            "q" => {
                // `z.string().min(1).max(256)` — JS 길이(UTF-16 단위).
                let n = v.encode_utf16().count();
                if !(1..=256).contains(&n) || v.contains('@') {
                    return None;
                }
                q = Some(v);
            }
            "channelId" | "threadRootId" => {
                if !crate::core::channels::is_uuid(&v) {
                    return None;
                }
                if k == "channelId" {
                    channel = Some(v);
                } else {
                    thread = Some(v);
                }
            }
            "offset" => {
                if v.is_empty() || v.len() > 4 || !v.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let n: i64 = v.parse().ok()?;
                if n > SEARCH_MAX_OFFSET {
                    return None;
                }
                offset = Some(n);
            }
            "after" | "before" => return None,
            "hasAttachment" => {
                has_attachment = Some(match v.as_str() {
                    "true" => true,
                    "false" => false,
                    _ => return None,
                })
            }
            "sort" => {
                recent = Some(match v.as_str() {
                    "relevance" => false,
                    "recent" => true,
                    _ => return None,
                })
            }
            // zod `object` 는 모르는 키를 버린다.
            _ => {}
        }
    }
    if authors.len() > SEARCH_MAX_AUTHORS {
        return None;
    }
    Some(Q {
        query: q?,
        channel,
        thread,
        offset: offset.unwrap_or(0),
        authors: (!authors.is_empty()).then_some(authors),
        has_attachment: has_attachment.unwrap_or(false),
        recent: recent.unwrap_or(false),
    })
}

async fn search(
    State(st): State<Arc<SearchState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RequireAccount(me, _): RequireAccount,
    req: Request,
) -> Response {
    let Some(q) = parse(req.uri().query()) else {
        return crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await;
    };
    if let Some(ch) = q.channel.as_deref() {
        match crate::core::channels::visible(&st.pool, &me.id, ch).await {
            Ok(true) => {}
            Ok(false) => {
                return json_err(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "not a member of this channel",
                );
            }
            Err(e) => return internal(e),
        }
    }
    let rows: Vec<String> = match sqlx::query_scalar::<_, String>(sql(q.recent))
        .bind(&q.query)
        .bind(LIMIT + 1)
        .bind(&me.id)
        .bind(q.channel.as_deref())
        .bind(q.thread.as_deref())
        .bind(q.offset)
        .bind(q.authors.as_deref())
        .bind(None::<String>)
        .bind(None::<String>)
        .bind(q.has_attachment)
        .fetch_all(&st.pool)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let more = has_more(rows.len(), LIMIT, q.offset);
    let page: Vec<String> = rows
        .iter()
        .take(LIMIT as usize)
        .map(|r| minify(r))
        .collect();
    json_ok(format!(
        "{{\"messages\":[{}],\"hasMore\":{more}}}",
        page.join(",")
    ))
}

/// 코어 라우터에 합칠 줄 — `msg_read.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: SearchState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SearchState>>::new()
        .get("/search", search)
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

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    #[test]
    fn plain_query_is_answered() {
        let q = parse(Some("q=hello+world")).unwrap();
        assert_eq!(q.query, "hello world");
        assert_eq!(q.offset, 0);
        assert!(!q.has_attachment && !q.recent);
        assert_eq!(q.authors, None);
        let q = parse(Some(&format!(
            "q=%ED%95%9C&channelId={A}&threadRootId={B}&offset=50&authorId={A}&authorId={B}&hasAttachment=true&sort=recent&x=1"
        )))
        .unwrap();
        assert_eq!(q.query, "한");
        assert_eq!(q.channel.as_deref(), Some(A));
        assert_eq!(q.thread.as_deref(), Some(B));
        assert_eq!(q.offset, 50);
        assert_eq!(q.authors, Some(vec![A.to_string(), B.to_string()]));
        assert!(q.has_attachment && q.recent);
        assert!(
            !parse(Some("q=a&hasAttachment=false"))
                .unwrap()
                .has_attachment
        );
        assert_eq!(parse(Some("q=a&offset=1000")).unwrap().offset, 1000);
    }

    #[test]
    fn doubtful_queries_go_to_ts() {
        for raw in [
            None,
            Some(""),
            Some("q="),
            Some("q=%40alice"),
            Some("q=a&after=2026-01-01T00:00:00Z"),
            Some("q=a&before=x"),
            Some("q=a&channelId=nope"),
            Some("q=a&threadRootId="),
            Some("q=a&offset="),
            Some("q=a&offset=+5"),
            Some("q=a&offset=1e2"),
            Some("q=a&offset=1001"),
            Some("q=a&offset=-1"),
            Some("q=a&hasAttachment=1"),
            Some("q=a&sort=new"),
            Some("q=a&authorId=bad"),
            Some("q=a&q=b"),
            Some("q=a&sort=recent&sort=recent"),
        ] {
            assert_eq!(parse(raw), None, "{raw:?}");
        }
        let long = "x".repeat(257);
        assert_eq!(parse(Some(&format!("q={long}"))), None);
        assert!(parse(Some(&format!("q={}", "x".repeat(256)))).is_some());
        // 😀 는 UTF-16 두 단위 — 128개 = 256 은 받고 129개는 넘긴다.
        assert!(parse(Some(&format!("q={}", "%F0%9F%98%80".repeat(128)))).is_some());
        assert_eq!(
            parse(Some(&format!("q={}", "%F0%9F%98%80".repeat(129)))),
            None
        );
        let eleven: String = (0..11).map(|_| format!("&authorId={A}")).collect();
        assert_eq!(parse(Some(&format!("q=a{eleven}"))), None);
    }
}
