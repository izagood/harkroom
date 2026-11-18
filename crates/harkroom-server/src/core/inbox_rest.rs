//! S5.4 MS2b — `GET /inbox`(TS `routes/messageRoutes.ts`). 줄과 덧붙임은 [`super::inbox_list`] 가 TS `listInbox` 그대로 만든다.
//!
//! - 갈래는 TS 와 같다: `since`·`unread` 가 없으면 최신 [`INBOX_PAGE_LIMIT`] 줄 + `truncated`(`before` 커서), 있으면 전부.
//! - 읽기 풀만 쓴다(SELECT). 인증(401)은 층이 먼저 본다.
//! - 질의는 TS zod 스키마(`coerce.boolean`·`coerce.number().int()`·`enum(['1'])`)를 그대로 따라 읽고, zod 가 거절하는 값은
//!   TS 와 같은 400 `invalid_request` 로 답한다(문구는 다르다 — 대조는 상태만 본다).
//! - `threads=1` 이면 스레드 머리·처리 상태(`threads`·`threadStates`)도 싣는다 — [`super::inbox_threads`](S5.4 MS2c). 키 차례는 TS
//!   `{ entries, threads, threadStates, ...extra }` 그대로(`truncated` 가 맨 끝).
//! - **답하지 않고 읽은 요청 그대로 TS 로 넘기는 것**:
//!   - 위임 v2 스위치(`HARKROOM_DELEGATION_V2`) 값이 없으면 — 켜진 서버는 줄마다 위임 요약(`delegations`)을 싣는데, 값이 없으면
//!     TS 의 env 를 모르므로 넘긴다(`msg_post` 와 같은 판단). 켜짐·꺼짐이 적혀 있으면 Rust 가 그대로 답한다(MS2b-2).
use crate::auth::RequireAccount;
use crate::core::inbox_list::{
    INBOX_PAGE_LIMIT, InboxQuery, InboxRow, list_inbox, list_inbox_newest,
};
use crate::core::inbox_threads::{thread_heads, thread_states};
use crate::core::mcp::respond::minify;
use crate::directory::{internal, json_err, json_ok};
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

pub struct InboxRestState {
    /// 읽기 풀 — SELECT 만 한다.
    pub pool: PgPool,
    /// Rust 가 맡지 않는 요청을 넘길 TS.
    pub up: Upstream,
}

/// 검사를 통과한 질의.
#[derive(Debug, PartialEq, Eq)]
struct Q {
    unread: bool,
    since: Option<i64>,
    before: Option<i64>,
    threads: bool,
}

/// JS `Number(v)` — zod `coerce.number()` 가 쓰는 변환. 앞뒤 공백을 버리고, 빈 글은 0, `0x`·`0o`·`0b` 접두는 정수,
/// 나머지는 10진 실수. JS 가 `NaN` 을 내는 꼴은 `None`.
pub(crate) fn js_number(v: &str) -> Option<f64> {
    let t = v.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return Some(0.0);
    }
    for (pre, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(pre) {
            if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            return Some(rest.chars().fold(0f64, |n, c| {
                n * radix as f64 + c.to_digit(radix).unwrap_or(0) as f64
            }));
        }
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    // Rust 는 `inf`·`nan` 도 읽지만 JS 는 아니다 — 숫자·부호·점·지수 글자만 받는다.
    if !t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return None;
    }
    t.parse::<f64>().ok()
}

/// zod `coerce.number().int().min(lo).max(MAX_SAFE_INTEGER)`. 어긋나면 `None`(→ 400).
fn zod_int(v: &str, lo: i64) -> Option<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let n = js_number(v)?;
    if !n.is_finite() || n.fract() != 0.0 || n < lo as f64 || n > MAX_SAFE {
        return None;
    }
    Some(n as i64)
}

/// 질의 문자열을 TS zod 스키마 그대로 읽는다. zod 가 거절하는 값이면 `None`(→ 400).
/// 되풀이된 키는 fastify 에서 배열이 된다 — `unread` 는 `Boolean([...])` 로 참, `threads`·`since`·`before` 는 거절.
fn parse(raw: Option<&str>) -> Option<Q> {
    let mut q = Q {
        unread: false,
        since: None,
        before: None,
        threads: false,
    };
    let mut seen: Vec<String> = Vec::new();
    for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        let k = k.into_owned();
        let repeated = seen.contains(&k);
        seen.push(k.clone());
        match k.as_str() {
            "threads" if repeated => return None,
            "threads" => match v.as_ref() {
                "1" => q.threads = true,
                _ => return None,
            },
            // zod `coerce.boolean` 은 `Boolean(v)` — 빈 글만 거짓(`"0"`·`"false"` 도 참).
            "unread" => q.unread = repeated || !v.is_empty(),
            "since" | "before" if repeated => return None,
            "since" => q.since = Some(zod_int(&v, 0)?),
            "before" => q.before = Some(zod_int(&v, 1)?),
            // zod `object` 는 모르는 키를 버린다.
            _ => {}
        }
    }
    Some(q)
}

/// 줄 본문은 Postgres `json_build_object` 글자(`"id" : 26, …`)다. TS 는 node-pg 로 읽어 `JSON.stringify` 로 다시 쓰므로
/// 문자열 밖 공백을 지워 같은 글자로 맞춘다(키 순서는 그대로 — MCP 와 같은 [`minify`]).
fn entries(rows: &[InboxRow]) -> String {
    let parts: Vec<String> = rows.iter().map(|r| minify(&r.body)).collect();
    parts.join(",")
}

/// `threads=1` 의 덧붙임 — `,"threads":[…],"threadStates":[…]`. 처리 상태는 실린 머리의 것만(TS 와 같다, security F1).
async fn threads_part(pool: &PgPool, me: &str, rows: &[InboxRow]) -> sqlx::Result<String> {
    let heads = thread_heads(pool, me, rows.iter().map(|r| r.root.clone())).await?;
    let ids: Vec<String> = heads.iter().map(|(_, id)| id.clone()).collect();
    let states = thread_states(pool, me, &ids).await?;
    let bodies: Vec<&str> = heads.iter().map(|(b, _)| b.as_str()).collect();
    Ok(format!(
        ",\"threads\":[{}],\"threadStates\":[{}]",
        bodies.join(","),
        states.join(",")
    ))
}

async fn inbox(
    State(st): State<Arc<InboxRestState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RequireAccount(me, _): RequireAccount,
    req: Request,
) -> Response {
    let v2 = crate::core::msg_post::delegation_v2(
        std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref(),
    );
    let Some(q) = parse(req.uri().query()) else {
        // TS zod 오류와 같은 400 — 문구는 다르다(대조는 상태만 본다, `ask.rs` 와 같은 약속).
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "query: invalid");
    };
    let Some(v2) = v2 else {
        return crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await;
    };
    // TS `capped = since === undefined && unread !== true`.
    if q.since.is_none() && !q.unread {
        let (rows, truncated) =
            match list_inbox_newest(&st.pool, &me.id, INBOX_PAGE_LIMIT, q.before, v2).await {
                Ok(v) => v,
                Err(e) => return internal(e),
            };
        let extra = if q.threads {
            match threads_part(&st.pool, &me.id, &rows).await {
                Ok(t) => t,
                Err(e) => return internal(e),
            }
        } else {
            String::new()
        };
        return json_ok(format!(
            "{{\"entries\":[{}]{extra},\"truncated\":{truncated}}}",
            entries(&rows)
        ));
    }
    let query = if q.unread {
        InboxQuery::Unread { since: q.since }
    } else {
        InboxQuery::Since(q.since.unwrap_or(0))
    };
    let rows = match list_inbox(&st.pool, &me.id, query, v2).await {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let extra = if q.threads {
        match threads_part(&st.pool, &me.id, &rows).await {
            Ok(t) => t,
            Err(e) => return internal(e),
        }
    } else {
        String::new()
    };
    json_ok(format!("{{\"entries\":[{}]{extra}}}", entries(&rows)))
}

/// 코어 라우터에 합칠 줄 — `search_rest.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: InboxRestState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<InboxRestState>>::new()
        .get("/inbox", inbox)
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
    fn entries_match_json_stringify() {
        // bus-e2e(c744b7e5) 실패 꼴: PG `json_build_object` 의 `" : "`·`", "` 가 그대로 실렸다. 문자열 안 공백은 남는다.
        let rows = [
            InboxRow {
                id: 1,
                body: r#"{"id" : 26, "body" : "<@a> 자동화 목록 보여 줘", "meta" : {}, "readAt" : null}"#.into(),
                root: "r".into(),
            },
            InboxRow {
                id: 2,
                body: r#"{"id" : 27, "delegation" : {"lead" : "x"}}"#.into(),
                root: "r".into(),
            },
        ];
        assert_eq!(
            entries(&rows),
            r#"{"id":26,"body":"<@a> 자동화 목록 보여 줘","meta":{},"readAt":null},{"id":27,"delegation":{"lead":"x"}}"#
        );
    }

    #[test]
    fn plain_queries_are_answered() {
        let q = |unread, since, before| Q {
            unread,
            since,
            before,
            threads: false,
        };
        assert_eq!(parse(None), Some(q(false, None, None)));
        assert_eq!(parse(Some("")), Some(q(false, None, None)));
        assert_eq!(parse(Some("unread=1")), Some(q(true, None, None)));
        assert_eq!(
            parse(Some("unread=true&since=0")),
            Some(q(true, Some(0), None))
        );
        assert_eq!(parse(Some("since=42&x=y")), Some(q(false, Some(42), None)));
        assert_eq!(parse(Some("before=7")), Some(q(false, None, Some(7))));
        assert_eq!(
            parse(Some("since=999999999999999")),
            Some(q(false, Some(999_999_999_999_999), None))
        );
        let t = |unread| Q {
            unread,
            since: None,
            before: None,
            threads: true,
        };
        assert_eq!(parse(Some("threads=1")), Some(t(false)));
        assert_eq!(parse(Some("unread=1&threads=1")), Some(t(true)));
    }

    #[test]
    fn zod_coercions_match_ts() {
        // `coerce.boolean`: 빈 글만 거짓, 되풀이는 배열이라 참.
        for raw in [
            "unread=0",
            "unread=false",
            "unread=yes",
            "unread=1&unread=1",
        ] {
            assert!(parse(Some(raw)).unwrap().unread, "{raw}");
        }
        assert!(!parse(Some("unread=")).unwrap().unread);
        // `coerce.number`: JS `Number(v)`.
        for (raw, n) in [
            ("since=", 0),
            ("since=+5", 5),
            ("since=1e2", 100),
            ("since=1.0", 1),
            ("since=%205%20", 5),
            ("since=0x10", 16),
            ("since=999999999999999", 999_999_999_999_999),
            ("since=9007199254740991", 9_007_199_254_740_991),
        ] {
            assert_eq!(parse(Some(raw)).unwrap().since, Some(n), "{raw}");
        }
        assert!(parse(Some("x=1&x=2")).is_some());
    }

    #[test]
    fn zod_rejections_are_400() {
        for raw in [
            "threads=0",
            "threads=",
            "threads=true",
            "threads=1&threads=1",
            "since=-1",
            "since=1.5",
            "since=abc",
            "since=inf",
            "since=Infinity",
            "since=9007199254740992",
            "since=0x",
            "before=0",
            "before=",
            "since=1&since=2",
            "before=2&before=3",
        ] {
            assert_eq!(parse(Some(raw)), None, "{raw}");
        }
    }
}
