//! S5.4 AC4 — handle 바꾸기 두 줄. TS `routes/accountRoutes.ts` 의 `PATCH /accounts/me/handle`·
//! `PATCH /accounts/:id/handle`(admin) 을 옮긴다.
//!
//! - 나: `requireAccount`(401) → 본문(400) → 사람만(400 `agent_handle_not_self_serve`) → 계정 충돌(409) →
//!   집합 충돌(409) → UPDATE + `account.handle_changed`(받는 사람 everyone, outbox) → 감사.
//! - admin: `requireAdmin`(401·403) → 경로(400) → 본문(400) → 대상 없음(404, 지운 계정도 대상) → 충돌 둘(409) →
//!   같은 쓰기. 에이전트도 대상이다(#843).
//! - 충돌 검사와 UPDATE 사이의 경합은 TS 와 같다(unique 위반이면 500). 감사 detail 은 `{from, to}`.
//! - 권한은 [`ACCOUNT_HANDLE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::{RequireAccount, RequireAdmin};
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 권한 — 칸 단위로 좁힌다. 감사(`audit_log` INSERT)는 이미 있는 쓰기 코어 권한이다.
pub const ACCOUNT_HANDLE_PRIVILEGES: &[(&str, &str)] =
    &[("account.handle", "UPDATE"), ("event_outbox", "INSERT")];
pub const ACCOUNT_HANDLE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

#[derive(Clone)]
pub struct AccountHandleState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// zod `handle: z.string().regex(/^[a-z0-9_-]{2,32}$/).refine(notReservedHandle)`. 소문자만(대문자는 400).
pub fn is_handle(s: &str) -> bool {
    (2..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        && !s.starts_with("deleted-")
}

/// zod `{ handle }` — 모르는 칸은 버린다.
pub fn parse_handle(body: &Body) -> Option<String> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    match m.get("handle") {
        Some(Value::String(h)) if is_handle(h) => Some(h.clone()),
        _ => None,
    }
}

fn bad(what: &str) -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

const ACCOUNT_TAKEN: &str =
    "select 1 from account where lower(handle) = lower($1) and id <> $2::uuid";
const GROUP_TAKEN: &str = "select 1 from handle_group where lower(handle) = lower($1)";
const UPDATE: &str = "update account set handle = $1 where id = $2::uuid";

/// 409 두 갈래 — 계정 먼저, 그다음 집합(TS 차례).
async fn taken(read: &PgPool, handle: &str, id: &str) -> sqlx::Result<Option<Response>> {
    let a: Option<i32> = sqlx::query_scalar(ACCOUNT_TAKEN)
        .bind(handle)
        .bind(id)
        .fetch_optional(read)
        .await?;
    if a.is_some() {
        return Ok(Some(json_err(
            StatusCode::CONFLICT,
            "handle_taken",
            "this handle is already taken",
        )));
    }
    let g: Option<i32> = sqlx::query_scalar(GROUP_TAKEN)
        .bind(handle)
        .fetch_optional(read)
        .await?;
    Ok(g.map(|_| {
        json_err(
            StatusCode::CONFLICT,
            "handle_taken",
            "a group with this handle already exists",
        )
    }))
}

/// UPDATE 와 이벤트를 한 트랜잭션에.
async fn write_handle(write: &PgPool, id: &str, handle: &str) -> sqlx::Result<()> {
    let mut tx = write.begin().await?;
    sqlx::query(UPDATE)
        .bind(handle)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::write::emit_event(
        &mut tx,
        &json!({ "type": "account.handle_changed", "accountId": id, "newHandle": handle }),
    )
    .await?;
    tx.commit().await
}

#[allow(clippy::too_many_arguments)]
async fn audit(
    st: &AccountHandleState,
    parts: &Parts,
    actor_id: &str,
    actor_handle: &str,
    target: Option<&str>,
    from: &str,
    to: &str,
) {
    let ip = crate::writes_settings::ip_of(parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "account.handle.changed",
            actor_id: Some(actor_id),
            actor_handle: Some(actor_handle),
            target,
            ip: ip.as_deref(),
            detail: json!({ "from": from, "to": to }),
        },
    )
    .await;
}

/// `PATCH /accounts/me/handle`.
pub async fn patch_me(State(st): State<Arc<AccountHandleState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let Some(handle) = parse_handle(&body) else {
        return bad("handle");
    };
    if me.kind != "human" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "agent_handle_not_self_serve",
            "an agent's name is changed by its owner via PATCH /accounts/agents/:id",
        );
    }
    match taken(&st.read, &handle, &me.id).await {
        Ok(Some(r)) => return r,
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    if let Err(e) = write_handle(&st.write, &me.id, &handle).await {
        return internal(e);
    }
    // TS: actorHandle 은 **새** 이름, target 없음.
    audit(&st, &parts, &me.id, &handle, None, &me.handle, &handle).await;
    json_ok(json!({ "handle": handle }).to_string())
}

/// `PATCH /accounts/{id}/handle` — admin.
pub async fn patch_other(
    State(st): State<Arc<AccountHandleState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAdmin(me), parts) =
        match crate::writes_settings::body_then::<RequireAdmin>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let Some(handle) = parse_handle(&body) else {
        return bad("handle");
    };
    let old: Option<String> =
        match sqlx::query_scalar("select handle from account where id = $1::uuid")
            .bind(&id)
            .fetch_optional(&st.read)
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
    let Some(old) = old else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such account");
    };
    match taken(&st.read, &handle, &id).await {
        Ok(Some(r)) => return r,
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    if let Err(e) = write_handle(&st.write, &id, &handle).await {
        return internal(e);
    }
    audit(&st, &parts, &me.id, &me.handle, Some(&id), &old, &handle).await;
    json_ok(json!({ "handle": handle }).to_string())
}

pub fn routes(
    st: AccountHandleState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AccountHandleState>>::new()
        .patch("/accounts/me/handle", patch_me)
        .patch("/accounts/{id}/handle", patch_other)
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

    fn j(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn handle_rule_follows_zod() {
        assert_eq!(
            parse_handle(&j(json!({ "handle": "ab" }))).as_deref(),
            Some("ab")
        );
        assert!(parse_handle(&j(json!({ "handle": "Ab" }))).is_none());
        assert!(parse_handle(&j(json!({ "handle": "a" }))).is_none());
        assert!(parse_handle(&j(json!({ "handle": "a".repeat(33) }))).is_none());
        assert!(parse_handle(&j(json!({ "handle": "deleted-x" }))).is_none());
        assert!(parse_handle(&j(json!({ "handle": "a.b" }))).is_none());
        assert!(parse_handle(&j(json!({ "handle": 3 }))).is_none());
        assert!(parse_handle(&j(json!({}))).is_none());
    }
}
