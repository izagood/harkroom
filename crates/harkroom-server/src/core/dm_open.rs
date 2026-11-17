//! S5.4 CH4b-1 — DM 열기 `POST /dms`. TS `routes/channelRoutes.ts` 의 같은 줄과 `services/channels.ts`
//! (`findDm`·`getOrCreateDm`), `routes/moderationRoutes.ts`(`anyBlockBetween`)를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문 읽기 → 인증(401) → 본문(400) → 이미 있는 DM 찾기.
//!   - 있으면 그대로 돌려준다(차단·게이트를 보지 않는다 — 지난 대화를 잃지 않게).
//!   - 없으면 차단(어느 쪽이든) → 403 `dm_unavailable`, 부를 수 없는 에이전트 → 403 `agent_not_invokable`
//!     (`mayInvoke` via mention, 채널 없음).
//! - 만들기는 한 트랜잭션이다: 참여자 묶음 잠금(`lock_dm`, 트랜잭션 끝까지) → 한 번 더 찾기 → 없으면 채널 행과 멤버 행.
//!   DM 에는 참여자 묶음 고유 제약이 없어서, 잠금이 없으면 같은 요청 둘이 DM 을 둘 만든다. 잠금 키는 정렬한 id 목록이라
//!   TS 와 Rust 가 같은 묶음에 같은 잠금을 잡는다.
//! - 답은 언제나 201 과 채널 행이다(이미 있던 DM 도). 이벤트·감사는 없다(TS 도 없다).
//! - 문장은 TS 정본을 골든(`find_dm`·`lock_dm`·`create_dm`·`channel_row`·`add_channel_member`·`any_block_between`)으로 받는다.
//! - 권한은 [`DM_OPEN_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::channels::{dml_rows_sql, frag, is_uuid, rows_sql};
use super::invoke_gate::{self, Ctx, Via};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::write::Body;
use crate::writes_settings::body_then;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};

/// 이 줄이 쓰는 권한(표·칸, 권한) — homelab GRANT 와 같아야 한다. 찾기·차단·호출 게이트도 쓰기 풀에서 본다
/// (만들기 직전의 판정이 같은 연결 묶음을 보게).
pub const DM_OPEN_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel.kind", "INSERT"),
    ("channel.topic", "INSERT"),
    ("channel_member", "SELECT"),
    ("channel_member", "INSERT"),
    ("account_block", "SELECT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("agent_owner_delegate", "SELECT"),
];

#[derive(Clone)]
pub struct DmOpenState {
    pub read: PgPool,
    pub write: PgPool,
    /// `GET /dms`(목록, `directory::dms`)도 이 라우터가 단다 — 같은 경로를 두 라우터가 fallback 과 함께 가지면 axum 이
    /// 합치지 못한다(기동 panic). 되돌림 env 가 `GET /dms` 를 TS 로 보냈으면 false 다(그 메서드는 TS fallback 으로 간다).
    pub get_dms: bool,
}

struct Sql {
    find: String,
    row: String,
    create: String,
    block: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| Sql {
        // id 는 text 로 받는다(sqlx 가 uuid 를 모르는 꼴로 읽지 않게).
        find: format!("select f.id::text from ({}) f", frag("find_dm")),
        row: rows_sql(frag("channel_row"), &["archivedAt", "createdAt"]),
        create: dml_rows_sql(frag("create_dm"), &["archivedAt", "createdAt"]),
        block: format!("select 1 from ({}) b", frag("any_block_between")),
    })
}

/// zod `{ accountIds: z.array(z.string().uuid()).min(1).max(16) }`. 남는 키는 버린다.
fn parse(body: &Body) -> Option<Vec<String>> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let arr = m.get("accountIds")?.as_array()?;
    if !(1..=16).contains(&arr.len()) {
        return None;
    }
    arr.iter()
        .map(|v| v.as_str().filter(|s| is_uuid(s)).map(str::to_string))
        .collect()
}

/// TS `[...new Set(ids)].sort()` — 글자 그대로 중복을 빼고 UTF-16 차례(id 는 ASCII 라 바이트 차례와 같다)로.
fn members_key(ids: &[String], me: &str) -> Vec<String> {
    let mut s: BTreeSet<String> = ids.iter().cloned().collect();
    s.insert(me.to_string());
    s.into_iter().collect()
}

/// 한 행짜리 결과(`[{…}]`)에서 그 행의 JSON 글자를 꺼낸다 — 칸 순서를 지키려고 다시 직렬화하지 않는다.
fn only_row(rows: &str) -> Option<&str> {
    let inner = rows.strip_prefix('[')?.strip_suffix(']')?;
    (!inner.is_empty()).then_some(inner)
}

fn created(row_text: &str) -> Response {
    match only_row(row_text) {
        Some(row) => {
            let mut r = json_ok(row.to_string());
            *r.status_mut() = StatusCode::CREATED;
            r
        }
        None => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        ),
    }
}

/// `GET /dms` — 읽기 표(`routes::MOVED`)에 있던 그 줄을 그대로 부른다.
async fn list(State(st): State<Arc<DmOpenState>>, ra: RequireAccount) -> Response {
    crate::directory::dms(State(st.read.clone()), ra).await
}

/// `POST /dms` — 201 과 DM 채널 행.
pub async fn open(State(st): State<Arc<DmOpenState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), _) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(ids) = parse(&body) else {
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid");
    };
    let members = members_key(&ids, &me.id);
    let found: Option<String> = match sqlx::query_scalar(sql().find.as_str())
        .bind(&members)
        .fetch_optional(&st.write)
        .await
    {
        Ok(f) => f,
        Err(e) => return internal(e),
    };
    if found.is_none() {
        let others: Vec<String> = ids.iter().filter(|i| **i != me.id).cloned().collect();
        // 차단(109) — 둘 중 누가 막았든 새 DM 은 열지 않는다. 누가 막았는지는 말하지 않는다.
        if !others.is_empty() {
            match sqlx::query_scalar::<_, i32>(sql().block.as_str())
                .bind(&me.id)
                .bind(&others)
                .fetch_optional(&st.write)
                .await
            {
                Ok(Some(_)) => {
                    return json_err(
                        StatusCode::FORBIDDEN,
                        "dm_unavailable",
                        "you cannot start a conversation with this account",
                    );
                }
                Ok(None) => {}
                Err(e) => return internal(e),
            }
        }
        // 새 DM 은 부를 수 있는 에이전트와만 연다(TS 와 같이 via mention, 채널 없음).
        let mut conn = match st.write.acquire().await {
            Ok(c) => c,
            Err(e) => return internal(e),
        };
        let facts = match invoke_gate::invoke_facts_ordered(&mut conn, &others).await {
            Ok(f) => f,
            Err(e) => return internal(e),
        };
        let ctx = Ctx {
            caller_id: &me.id,
            channel_id: "",
            via: Via::Mention,
            reply_grant_thread_id: None,
        };
        for f in &facts {
            match invoke_gate::may_invoke(&mut conn, f, &ctx).await {
                Ok(true) => {}
                Ok(false) => {
                    return json_err(
                        StatusCode::FORBIDDEN,
                        "agent_not_invokable",
                        "this agent cannot be invoked by you",
                    );
                }
                Err(e) => return internal(e),
            }
        }
    }
    if let Some(id) = found {
        return match sqlx::query_scalar::<_, String>(sql().row.as_str())
            .bind(&id)
            .fetch_one(&st.write)
            .await
        {
            Ok(rows) => created(&rows),
            Err(e) => internal(e),
        };
    }
    // TS `getOrCreateDm` — 판정과 만들기 사이에 같은 묶음의 DM 이 생겼을 수 있다. 잠근 뒤 한 번 더 찾는다.
    let mut tx = match st.write.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    if let Err(e) = sqlx::query(frag("lock_dm"))
        .bind(&members)
        .execute(&mut *tx)
        .await
    {
        return internal(e);
    }
    let raced: Option<String> = match sqlx::query_scalar(sql().find.as_str())
        .bind(&members)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(f) => f,
        Err(e) => return internal(e),
    };
    let rows: String = if let Some(id) = raced {
        match sqlx::query_scalar(sql().row.as_str())
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        }
    } else {
        let rows: String = match sqlx::query_scalar(sql().create.as_str())
            .fetch_one(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
        let id = only_row(&rows)
            .and_then(|r| serde_json::from_str::<Value>(r).ok())
            .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string));
        let Some(id) = id else {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            );
        };
        for m in &members {
            if let Err(e) = sqlx::query(frag("add_channel_member"))
                .bind(&id)
                .bind(m)
                .execute(&mut *tx)
                .await
            {
                return internal(e);
            }
        }
        rows
    };
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    created(&rows)
}

/// 코어 라우터에 합칠 줄 — `channel_create_update.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
/// `GET /dms` 는 [`DmOpenState::get_dms`] 를 본다.
pub fn routes(
    st: DmOpenState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let mut t = Table::<Arc<DmOpenState>>::new().post("/dms", open);
    if st.get_dms {
        t = t.get("/dms", list);
    }
    let t = t
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
    use serde_json::json;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";

    #[test]
    fn body_like_zod() {
        let p = |v: Value| parse(&Body::Json(v));
        assert_eq!(
            p(json!({ "accountIds": [A], "x": 1 })),
            Some(vec![A.into()])
        );
        assert!(p(json!({ "accountIds": [] })).is_none());
        assert!(p(json!({ "accountIds": vec![A; 16] })).is_some());
        assert!(p(json!({ "accountIds": vec![A; 17] })).is_none());
        assert!(p(json!({ "accountIds": ["nope"] })).is_none());
        assert!(p(json!({ "accountIds": [1] })).is_none());
        assert!(p(json!({ "accountIds": A })).is_none());
        assert!(p(json!({})).is_none());
        assert!(parse(&Body::None).is_none());
    }

    #[test]
    fn members_sorted_unique_with_me() {
        assert_eq!(
            members_key(&[B.into(), A.into(), B.into()], A),
            vec![A.to_string(), B.to_string()]
        );
    }

    #[test]
    fn statements_wrap_golden() {
        let s = sql();
        assert!(
            s.create
                .starts_with("with w as (insert into channel (kind, topic)")
        );
        assert!(s.find.contains("$1::uuid[]"));
        assert!(frag("lock_dm").contains("pg_advisory_xact_lock"));
    }
}
