//! S5.3 C6a-2 — 스레드 하나의 **내** 처리 상태 `PUT /inbox/threads/{rootId}`. TS `routes/messageRoutes.ts` 의 그 라우트와
//! `services/messages.ts::setInboxThreadState` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문(fastify — 익명도 400/415) → 인증(401) → zod `rootId` uuid(400) → zod 본문 union(400 `invalid_request`)
//!   → 나중이면 `until` 이 지금보다 뒤·90일 안(400 `bad_until`) → 루트 읽기(없음·지움 404 / 못 보는 채널 403 / 답글 400 `not_root`)
//!   → 쓰기(지우기 또는 upsert) + `inbox.updated`(같은 트랜잭션) → 200 `{ state }`.
//! - 고치는 행은 언제나 부른 계정의 것이다(`account_id = 나`) — 계정을 몸통으로 받지 않는다.
//! - `until` 은 TS 처럼 **받은 문자열 그대로** DB 에 넣는다(Postgres 가 읽는다). 응답 시각은 `toISOString()` 꼴.
//! - 볼 수 있는지는 TS 골든 술어(`channelVisibleSql('c', '$1::uuid')`)로 본다.
//! - 쓰기 역할 권한은 [`INBOX_THREAD_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::{Body, emit_event};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 이 줄이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. upsert 의 `do update` 가 고치는 세 칸만 UPDATE.
pub const INBOX_THREAD_PRIVILEGES: &[(&str, &str)] = &[
    ("inbox_thread_state", "INSERT"),
    ("inbox_thread_state", "DELETE"),
    ("inbox_thread_state.state", "UPDATE"),
    ("inbox_thread_state.until", "UPDATE"),
    ("inbox_thread_state.updated_at", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const INBOX_THREAD_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS 라우트의 90일(밀리초).
const LATER_MAX_MS: i64 = 90 * 86_400_000;

#[derive(Clone)]
pub struct InboxThreadState {
    pub read: PgPool,
    pub write: PgPool,
}

/// zod union 이 고른 갈래.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Done,
    /// 받은 문자열 그대로와 그 시각(유닉스 밀리초, JS `Date.parse` 와 같게 밀리초 아래는 버림).
    Later(String, i64),
    Clear,
    /// zod 가 거절한다 → 400.
    Invalid,
}

/// `z.union([{state:'done'}, {state:'later', until: z.string().datetime()}, {state: null}])` — 모르는 키는 버린다.
/// `datetime()`(오프셋 없음, zod 3.25)은 끝이 `Z` 인 꼴만 받는다.
pub fn parse_next(body: &Body) -> Next {
    let Body::Json(Value::Object(o)) = body else {
        return Next::Invalid;
    };
    match o.get("state") {
        Some(Value::String(s)) if s == "done" => Next::Done,
        Some(Value::Null) => Next::Clear,
        Some(Value::String(s)) if s == "later" => {
            let Some(Value::String(u)) = o.get("until") else {
                return Next::Invalid;
            };
            if !u.ends_with('Z') {
                return Next::Invalid;
            }
            match crate::write::zod_datetime_offset(u) {
                Ok(Some(iso)) => Next::Later(u.clone(), iso_ms(&iso)),
                // 끝이 Z 인데 JS 가 못 읽는 꼴은 해가 0..9999 밖일 때뿐 — 날짜 꼴이 4자리라 오지 않지만, 오면 지난 시각과 같게 거절된다.
                Ok(None) => Next::Later(u.clone(), i64::MIN),
                Err(()) => Next::Invalid,
            }
        }
        _ => Next::Invalid,
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`(정규화된 꼴) → 유닉스 밀리초.
fn iso_ms(iso: &str) -> i64 {
    let n = |r: std::ops::Range<usize>| iso[r].parse::<i64>().unwrap_or(0);
    let days = crate::write::days_from_civil(n(0..4), n(5..7), n(8..10));
    days * 86_400_000 + ((n(11..13) * 60 + n(14..16)) * 60 + n(17..19)) * 1000 + n(20..23)
}

/// TS: `!(at > Date.now()) || at > Date.now() + 90일` 이면 거절.
pub fn until_ok(at: i64, now: i64) -> bool {
    at > now && at <= now + LATER_MAX_MS
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

struct Sql {
    root: String,
    upsert: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| Sql {
        root: format!(
            "select m.thread_root_id::text, {} as visible \
               from message m join channel c on c.id = m.channel_id \
              where m.id = $2::uuid and m.deleted_at is null",
            super::channels::frag("channel_visible_c_p1uuid")
        ),
        upsert: format!(
            "insert into inbox_thread_state (account_id, root_id, state, until) \
             values ($1::uuid, $2::uuid, $3, $4::timestamptz) \
             on conflict (account_id, root_id) \
               do update set state = excluded.state, until = excluded.until, updated_at = now() \
             returning json_build_object('rootId', root_id, 'state', state, \
               'until', {}, 'updatedAt', {})::text",
            crate::iso!("until"),
            crate::iso!("updated_at"),
        ),
    })
}

/// `PUT /inbox/threads/{rootId}`.
pub async fn put_state(
    State(st): State<Arc<InboxThreadState>>,
    Path(root_id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&root_id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "rootId: invalid",
        );
    }
    let next = parse_next(&body);
    match &next {
        Next::Invalid => {
            return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid");
        }
        Next::Later(_, at) if !until_ok(*at, now_ms()) => {
            return json_err(
                StatusCode::BAD_REQUEST,
                "bad_until",
                "until must be in the future and within 90 days",
            );
        }
        _ => {}
    }
    let root: Option<(Option<String>, bool)> = match sqlx::query_as(sql().root.as_str())
        .bind(&me.id)
        .bind(&root_id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    match root {
        None => return json_err(StatusCode::NOT_FOUND, "not_found", "no such message"),
        Some((_, false)) => return json_err(StatusCode::FORBIDDEN, "forbidden", "not visible"),
        Some((Some(_), true)) => {
            return json_err(StatusCode::BAD_REQUEST, "not_root", "not a thread root");
        }
        Some((None, true)) => {}
    }
    match write(&st.write, &me.id, &root_id, &next).await {
        Ok(state) => (
            StatusCode::OK,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )],
            format!("{{\"state\":{state}}}"),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

/// 지우기 또는 upsert 와 `inbox.updated` 를 한 트랜잭션에. 돌려주는 것은 `state` 칸의 JSON 텍스트(`null` 또는 객체).
async fn write(pool: &PgPool, me: &str, root: &str, next: &Next) -> sqlx::Result<String> {
    let mut tx = pool.begin().await?;
    let state = match next {
        Next::Clear => {
            sqlx::query(
                "delete from inbox_thread_state where account_id = $1::uuid and root_id = $2::uuid",
            )
            .bind(me)
            .bind(root)
            .execute(&mut *tx)
            .await?;
            "null".to_string()
        }
        Next::Done | Next::Later(..) => {
            let (st, until) = match next {
                Next::Later(u, _) => ("later", Some(u.as_str())),
                _ => ("done", None),
            };
            sqlx::query_scalar::<_, String>(sql().upsert.as_str())
                .bind(me)
                .bind(root)
                .bind(st)
                .bind(until)
                .fetch_one(&mut *tx)
                .await?
        }
        Next::Invalid => unreachable!("rejected before write"),
    };
    emit_event(
        &mut tx,
        &json!({ "type": "inbox.updated", "accountId": me }),
    )
    .await?;
    tx.commit().await?;
    Ok(state)
}

/// 코어 라우터에 합칠 줄 — `inbox_read.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: InboxThreadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<InboxThreadState>>::new()
        .put("/inbox/threads/{rootId}", put_state)
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

    fn p(v: Value) -> Next {
        parse_next(&Body::Json(v))
    }

    #[test]
    fn zod_union() {
        assert_eq!(p(json!({ "state": "done" })), Next::Done);
        assert_eq!(p(json!({ "state": "done", "until": 1 })), Next::Done);
        assert_eq!(p(json!({ "state": null })), Next::Clear);
        assert_eq!(p(json!({ "state": null, "until": "x" })), Next::Clear);
        assert_eq!(
            p(json!({ "state": "later", "until": "2026-11-20T00:00:00.123456Z" })),
            Next::Later(
                "2026-11-20T00:00:00.123456Z".into(),
                iso_ms("2026-11-20T00:00:00.123Z")
            )
        );
        // 초 없는 꼴도 zod 3.25 는 받는다.
        assert!(matches!(
            p(json!({ "state": "later", "until": "2026-11-20T00:00Z" })),
            Next::Later(..)
        ));
        // 오프셋은 offset:true 가 아니라 거절.
        assert_eq!(
            p(json!({ "state": "later", "until": "2026-11-20T09:00:00+09:00" })),
            Next::Invalid
        );
        assert_eq!(
            p(json!({ "state": "later", "until": "2026-11-20" })),
            Next::Invalid
        );
        assert_eq!(p(json!({ "state": "later" })), Next::Invalid);
        assert_eq!(p(json!({ "state": "later", "until": 5 })), Next::Invalid);
        assert_eq!(p(json!({ "state": "open" })), Next::Invalid);
        assert_eq!(p(json!({})), Next::Invalid);
        assert_eq!(p(json!([])), Next::Invalid);
        assert_eq!(parse_next(&Body::None), Next::Invalid);
    }

    #[test]
    fn iso_and_window() {
        assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(iso_ms("2026-11-15T15:44:25.007Z"), 1_794_757_465_007);
        let now = 1_000_000;
        assert!(!until_ok(now, now));
        assert!(until_ok(now + 1, now));
        assert!(until_ok(now + LATER_MAX_MS, now));
        assert!(!until_ok(now + LATER_MAX_MS + 1, now));
        assert!(!until_ok(i64::MIN, now));
    }

    #[test]
    fn privileges() {
        assert!(INBOX_THREAD_PRIVILEGES.contains(&("inbox_thread_state.until", "UPDATE")));
        assert!(!INBOX_THREAD_PRIVILEGES.contains(&("inbox_thread_state", "UPDATE")));
    }
}
