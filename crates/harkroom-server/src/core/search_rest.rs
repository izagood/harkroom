//! S5.4 MS2a — `GET /search`(TS `routes/messageRoutes.ts`). 문장·상한·`hasMore` 는 MCP `message.search`([`super::mcp::search`])와
//! **같은 것**을 쓴다 — 가시성 술어·스코프·거르기는 그 골든 문장(`SEARCH_MESSAGES_SQL`) 안에 있다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401, 층) → 질의 검사 → `channelId` 가 있으면 볼 수 있는가(403) → 찾기.
//! - REST 는 MCP 와 두 군데가 다르다: 본문을 `<@id>` 그대로 싣는다(`denormalize` 없음), `hasAttachment` 는 `'true'` 일 때만 참이고
//!   그 밖은 거짓(`$10 is not true` 라 거짓과 없음은 같은 결과).
//! - 질의는 TS zod 스키마 그대로 읽는다(`offset` 은 JS `Number()` 강제 변환). zod 가 거절하는 값 — `q` 없음·길이 밖, uuid 가 아닌
//!   id, 정수가 아니거나 천장 밖 `offset`, 모르는 `sort`·`hasAttachment`, 상한 넘는 `authorId`, `authorId` 밖 키의 되풀이 — 은
//!   TS 와 같은 400 `invalid_request` 로 답한다(문구는 다르다 — 대조는 상태만 본다).
//! - **답하지 않고 읽은 요청 그대로 TS 로 넘기는 것**(zod 를 통과한 뒤, 판정을 옮기지 않은 것):
//!   - 질의에 `@` 가 있으면 — TS `normalizeSearchQuery` 가 `@handle` 을 `<@id>` 로 바꾼다(MCP 와 같은 경계).
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
    after: Option<String>,
    before: Option<String>,
}

/// 읽은 질의를 Rust 가 맡을 수 없을 때의 갈래.
#[derive(Debug, PartialEq)]
enum Reject {
    /// zod 가 거절한다 — TS 와 같은 400.
    Bad,
    /// 형식은 맞지만 판정을 옮기지 않았다(`@` 정규화) — TS 로 넘긴다.
    Ts,
}

/// 질의 문자열을 TS zod 스키마 그대로 읽는다. zod 가 거절하면 [`Reject::Bad`], 옮기지 않은 판정이 남으면 [`Reject::Ts`].
/// 되풀이된 키는 fastify 에서 배열이 된다 — `authorId` 밖의 키는 문자열만 받으니 400 이다.
fn parse(raw: Option<&str>) -> Result<Q, Reject> {
    let mut q: Option<String> = None;
    let mut channel: Option<String> = None;
    let mut thread: Option<String> = None;
    let mut offset: Option<i64> = None;
    let mut authors: Vec<String> = Vec::new();
    let mut has_attachment: Option<bool> = None;
    let mut recent: Option<bool> = None;
    let mut after: Option<String> = None;
    let mut before: Option<String> = None;
    let mut to_ts = false;
    let mut seen: Vec<String> = Vec::new();
    for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        let (k, v) = (k.into_owned(), v.into_owned());
        if k == "authorId" {
            if !crate::core::channels::is_uuid(&v) {
                return Err(Reject::Bad);
            }
            authors.push(v);
            continue;
        }
        let repeated = seen.contains(&k);
        seen.push(k.clone());
        let known = matches!(
            k.as_str(),
            "q" | "channelId"
                | "threadRootId"
                | "offset"
                | "after"
                | "before"
                | "hasAttachment"
                | "sort"
        );
        if repeated && known {
            return Err(Reject::Bad);
        }
        match k.as_str() {
            "q" => {
                // `z.string().min(1).max(256)` — JS 길이(UTF-16 단위).
                let n = v.encode_utf16().count();
                if !(1..=256).contains(&n) {
                    return Err(Reject::Bad);
                }
                // TS `normalizeSearchQuery` 가 `@handle` 을 `<@id>` 로 바꾼다 — 옮기지 않았다.
                if v.contains('@') {
                    to_ts = true;
                }
                q = Some(v);
            }
            "channelId" | "threadRootId" => {
                if !crate::core::channels::is_uuid(&v) {
                    return Err(Reject::Bad);
                }
                if k == "channelId" {
                    channel = Some(v);
                } else {
                    thread = Some(v);
                }
            }
            "offset" => {
                // `z.coerce.number().pipe(int().min(0).max(SEARCH_MAX_OFFSET))` — JS `Number(v)`.
                let n = crate::core::inbox_rest::js_number(&v).ok_or(Reject::Bad)?;
                if !n.is_finite() || n.fract() != 0.0 || n < 0.0 || n > SEARCH_MAX_OFFSET as f64 {
                    return Err(Reject::Bad);
                }
                offset = Some(n as i64);
            }
            // zod `datetime({ offset: true })`.
            "after" | "before" => {
                if !crate::core::mcp::search::zod_datetime_offset(&v) {
                    return Err(Reject::Bad);
                }
                if k == "after" {
                    after = Some(v);
                } else {
                    before = Some(v);
                }
            }
            "hasAttachment" => {
                has_attachment = Some(match v.as_str() {
                    "true" => true,
                    "false" => false,
                    _ => return Err(Reject::Bad),
                })
            }
            "sort" => {
                recent = Some(match v.as_str() {
                    "relevance" => false,
                    "recent" => true,
                    _ => return Err(Reject::Bad),
                })
            }
            // zod `object` 는 모르는 키를 버린다.
            _ => {}
        }
    }
    if authors.len() > SEARCH_MAX_AUTHORS {
        return Err(Reject::Bad);
    }
    let query = q.ok_or(Reject::Bad)?;
    if to_ts {
        return Err(Reject::Ts);
    }
    Ok(Q {
        query,
        channel,
        thread,
        offset: offset.unwrap_or(0),
        authors: (!authors.is_empty()).then_some(authors),
        has_attachment: has_attachment.unwrap_or(false),
        recent: recent.unwrap_or(false),
        after,
        before,
    })
}

async fn search(
    State(st): State<Arc<SearchState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RequireAccount(me, _): RequireAccount,
    req: Request,
) -> Response {
    let q = match parse(req.uri().query()) {
        Ok(q) => q,
        // TS zod 오류와 같은 400 — 문구는 다르다(대조는 상태만 본다, `channels.rs` 와 같은 약속).
        Err(Reject::Bad) => {
            return json_err(StatusCode::BAD_REQUEST, "invalid_request", "query: invalid");
        }
        Err(Reject::Ts) => {
            return crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await;
        }
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
        .bind(q.after.as_deref())
        .bind(q.before.as_deref())
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
    fn offset_follows_js_number() {
        for (raw, n) in [("", 0), ("+5", 5), ("1e2", 100), ("%205", 5), ("1.0", 1)] {
            assert_eq!(
                parse(Some(&format!("q=a&offset={raw}"))).unwrap().offset,
                n,
                "{raw}"
            );
        }
    }

    #[test]
    fn unported_judgements_go_to_ts() {
        for raw in ["q=%40alice"] {
            assert_eq!(parse(Some(raw)), Err(Reject::Ts), "{raw}");
        }
        let ok = parse(Some(
            "q=a&after=2026-01-01T00:00:00Z&before=2026-02-29T09:00%2B0900",
        ));
        assert_eq!(ok, Err(Reject::Bad), "2026 은 윤년이 아니다");
        let ok = parse(Some(
            "q=a&after=2026-01-01T00:00:00.5Z&before=2028-02-29T09:00%2B09:00",
        ))
        .unwrap();
        assert_eq!(ok.after.as_deref(), Some("2026-01-01T00:00:00.5Z"));
        assert_eq!(ok.before.as_deref(), Some("2028-02-29T09:00+09:00"));
        for raw in [
            "q=a&before=x",
            "q=a&after=2026-01-01",
            "q=a&after=2026-01-01T24:00Z",
            "q=a&after=2026-01-01T00:00:00",
        ] {
            assert_eq!(parse(Some(raw)), Err(Reject::Bad), "{raw}");
        }
    }

    #[test]
    fn zod_rejections_are_400() {
        for raw in [
            None,
            Some(""),
            Some("q="),
            Some("q=a&channelId=nope"),
            Some("q=a&threadRootId="),
            Some("q=a&offset=1001"),
            Some("q=a&offset=-1"),
            Some("q=a&offset=1.5"),
            Some("q=a&offset=x"),
            Some("q=a&hasAttachment=1"),
            Some("q=a&sort=new"),
            Some("q=a&authorId=bad"),
            Some("q=a&q=b"),
            Some("q=a&sort=recent&sort=recent"),
            // zod 실패가 `@`·`after` 보다 먼저다.
            Some("q=%40a&sort=new"),
            Some("q=a&after=x&after=y"),
        ] {
            assert_eq!(parse(raw), Err(Reject::Bad), "{raw:?}");
        }
        let long = "x".repeat(257);
        assert_eq!(parse(Some(&format!("q={long}"))), Err(Reject::Bad));
        assert!(parse(Some(&format!("q={}", "x".repeat(256)))).is_ok());
        // 😀 는 UTF-16 두 단위 — 128개 = 256 은 받고 129개는 거절한다.
        assert!(parse(Some(&format!("q={}", "%F0%9F%98%80".repeat(128)))).is_ok());
        assert_eq!(
            parse(Some(&format!("q={}", "%F0%9F%98%80".repeat(129)))),
            Err(Reject::Bad)
        );
        let eleven: String = (0..11).map(|_| format!("&authorId={A}")).collect();
        assert_eq!(parse(Some(&format!("q=a{eleven}"))), Err(Reject::Bad));
        assert!(parse(Some("q=a&x=1&x=2")).is_ok());
    }
}
