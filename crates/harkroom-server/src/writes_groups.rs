//! 가벼운 쓰기②-집합(S5.2 P4b) — TS `routes/handleGroupRoutes.ts` 의 쓰기(`services/handleGroups.ts`).
//!
//! 문은 다섯 다 `requireCap('channel.manage')`(대상 없음). 순서: 본문 읽기 → 문 → zod. 쓴 뒤 감사(ip 는 `TRUST_PROXY` 규칙)와
//! `handle_group.changed {groupId, audience:'all'}` 이벤트(outbox, 쓰기와 같은 트랜잭션).
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::perm::require_cap;
use crate::routes::AppState;
use crate::write::{AuditEntry, Body, emit_event, record_audit};
use crate::writes_settings::{bad, body_then, ip_of, js_len, write_pool};
use crate::writes_teams::is_handle;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}
macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

fn no_group() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such group")
}

fn obj(body: &Body) -> Option<&serde_json::Map<String, Value>> {
    match body {
        Body::Json(Value::Object(o)) => Some(o),
        _ => None,
    }
}

fn display_name(o: &serde_json::Map<String, Value>) -> Result<String, &'static str> {
    match o.get("displayName") {
        Some(Value::String(s)) if (1..=64).contains(&js_len(s)) => Ok(s.clone()),
        _ => Err("displayName"),
    }
}

/// zod `{ handle: handleSchema, displayName: string.min(1).max(64) }`.
pub fn parse_create(body: &Body) -> Result<(String, String), &'static str> {
    let o = obj(body).ok_or("expected object")?;
    let handle = match o.get("handle") {
        Some(Value::String(h)) if is_handle(h) => h.clone(),
        _ => return Err("handle"),
    };
    Ok((handle, display_name(o)?))
}

/// zod `{ accountIds: uuid[].min(1) }`.
pub fn parse_ids(body: &Body) -> Result<Vec<String>, &'static str> {
    let Some(Value::Array(a)) = obj(body).ok_or("expected object")?.get("accountIds") else {
        return Err("accountIds");
    };
    if a.is_empty() {
        return Err("accountIds");
    }
    a.iter()
        .map(|v| match v {
            Value::String(s) if is_zod_uuid(s) => Ok(s.clone()),
            _ => Err("accountIds"),
        })
        .collect()
}

const GROUP_BY_HANDLE: &str = "select 1 from handle_group where lower(handle) = lower($1)";
const CREATE_GROUP: &str = concat!(
    "with g as (insert into handle_group (handle, display_name) select $1, $2 \
       where not exists (select 1 from account where lower(handle) = lower($1)) returning *) \
     select row_to_json(x)::text from (select ",
    crate::group_cols!(),
    " from g) x"
);
const RENAME_GROUP: &str = concat!(
    "with g as (update handle_group set display_name = $2 where id = $1::uuid returning *) \
     select row_to_json(x)::text from (select ",
    crate::group_cols!(),
    " from g) x"
);
/// `listHandleGroupMembers` 는 순서를 정하지 않는다 — 같은 문장을 감싼다.
const MEMBERS: &str = "select json_build_object('members', coalesce((select json_agg(x.account_id) from (\
    select group_id, account_id from handle_group_member where group_id = $1::uuid) x), '[]'::json))::text";

async fn changed(conn: &mut PgConnection, id: &str) -> Result<i64, sqlx::Error> {
    emit_event(
        conn,
        &json!({ "type": "handle_group.changed", "groupId": id, "audience": "all" }),
    )
    .await
}

async fn audit(
    st: &AppState,
    pool: &PgPool,
    parts: &Parts,
    me: &Account,
    action: &str,
    target: &str,
    detail: Value,
) {
    let ip = ip_of(parts, &st.trust);
    record_audit(
        pool,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(target),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
}

#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn gate(st: &AppState, req: Request) -> Result<(Body, Account, Parts), Response> {
    let (body, RequireAccount(_, auth), parts) = body_then::<RequireAccount>(req).await?;
    let me = require_cap(&st.pool, &auth, "channel.manage", None).await?;
    Ok((body, me, parts))
}

async fn group_handle(pool: &PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select handle from handle_group where id = $1::uuid")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// `POST /handle-groups` — 집합과 겹치면 400 `handle_taken`(집합), 계정과 겹쳐도 400 `handle_taken`. 201.
pub async fn create_group(State(st): State<AppState>, req: Request) -> Response {
    let (body, me, parts) = tri!(gate(&st, req).await);
    let (handle, name) = tri!(parse_create(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let taken: Option<i32> = db!(sqlx::query_scalar(GROUP_BY_HANDLE)
        .bind(&handle)
        .fetch_optional(pool)
        .await);
    if taken.is_some() {
        return json_err(
            StatusCode::BAD_REQUEST,
            "handle_taken",
            "a group with this handle already exists",
        );
    }
    let mut tx = db!(pool.begin().await);
    let row: Option<String> = db!(sqlx::query_scalar(CREATE_GROUP)
        .bind(&handle)
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await);
    let Some(row) = row else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "handle_taken",
            "an account with this handle already exists",
        );
    };
    let id = serde_json::from_str::<Value>(&row)
        .ok()
        .and_then(|v| v["id"].as_str().map(str::to_owned))
        .unwrap_or_default();
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    audit(
        &st,
        pool,
        &parts,
        &me,
        "handle_group.created",
        &id,
        json!({ "handle": handle }),
    )
    .await;
    let mut r = json_ok(row);
    *r.status_mut() = StatusCode::CREATED;
    r
}

/// `PATCH /handle-groups/{id}` — 표시 이름만.
pub async fn rename_group(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, me, parts) = tri!(gate(&st, req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let name = tri!(
        obj(&body)
            .ok_or("expected object")
            .and_then(display_name)
            .map_err(bad)
    );
    let pool = tri!(write_pool(&st));
    let mut tx = db!(pool.begin().await);
    let row: Option<String> = db!(sqlx::query_scalar(RENAME_GROUP)
        .bind(&id)
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await);
    let Some(row) = row else {
        return no_group();
    };
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    audit(
        &st,
        pool,
        &parts,
        &me,
        "handle_group.updated",
        &id,
        json!({ "displayName": name }),
    )
    .await;
    json_ok(row)
}

/// `DELETE /handle-groups/{id}` — 204. 구성원은 FK cascade 로 함께 지워진다.
pub async fn delete_group(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, me, parts) = tri!(gate(&st, req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let pool = tri!(write_pool(&st));
    let mut tx = db!(pool.begin().await);
    let n = db!(sqlx::query("delete from handle_group where id = $1::uuid")
        .bind(&id)
        .execute(&mut *tx)
        .await)
    .rows_affected();
    if n == 0 {
        return no_group();
    }
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    audit(
        &st,
        pool,
        &parts,
        &me,
        "handle_group.deleted",
        &id,
        json!({}),
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// `POST /handle-groups/{id}/members` — 사람만. 에이전트가 하나라도 있으면 요청 전체를 400 `agent_not_allowed`.
pub async fn add_members(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    members(st, id, req, true).await
}

/// `DELETE /handle-groups/{id}/members`.
pub async fn remove_members(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    members(st, id, req, false).await
}

async fn members(st: AppState, id: String, req: Request, add: bool) -> Response {
    let (body, me, parts) = tri!(gate(&st, req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let ids = tri!(parse_ids(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let Some(handle) = db!(group_handle(pool, &id).await) else {
        return no_group();
    };
    if add {
        let agents: Vec<String> = db!(sqlx::query_scalar(
            "select handle from account where id = any($1::uuid[]) and kind = 'agent'"
        )
        .bind(&ids)
        .fetch_all(pool)
        .await);
        if !agents.is_empty() {
            let list: Vec<String> = agents.iter().map(|h| format!("@{h}")).collect();
            return json_err(
                StatusCode::BAD_REQUEST,
                "agent_not_allowed",
                &format!("agents cannot be added to groups: {}", list.join(", ")),
            );
        }
    }
    let mut tx = db!(pool.begin().await);
    let sql = if add {
        "insert into handle_group_member (group_id, account_id) \
         select $1::uuid, a.id from account a where a.id = any($2::uuid[]) and a.kind = 'human' on conflict do nothing"
    } else {
        "delete from handle_group_member where group_id = $1::uuid and account_id = any($2::uuid[])"
    };
    let n = db!(sqlx::query(sql)
        .bind(&id)
        .bind(&ids)
        .execute(&mut *tx)
        .await)
    .rows_affected();
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    let (action, key) = if add {
        ("handle_group.members.added", "inserted")
    } else {
        ("handle_group.members.removed", "removed")
    };
    let mut detail = json!({ "handle": handle, "requested": ids.len() });
    detail[key] = json!(n);
    audit(&st, pool, &parts, &me, action, &id, detail).await;
    json_ok(db!(sqlx::query_scalar::<_, String>(MEMBERS)
        .bind(&id)
        .fetch_one(pool)
        .await))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn create_and_ids_shapes() {
        assert_eq!(
            parse_create(&j(json!({ "handle": "crew", "displayName": "Crew" }))),
            Ok(("crew".into(), "Crew".into()))
        );
        assert!(parse_create(&j(json!({ "handle": "crew", "displayName": "" }))).is_err());
        assert!(parse_create(&j(json!({ "handle": "deleted-x", "displayName": "x" }))).is_err());
        assert!(
            parse_ids(&j(json!({ "accountIds": [] }))).is_err(),
            "빈 배열은 거절"
        );
        assert!(parse_ids(&j(json!({ "accountIds": ["x"] }))).is_err());
        assert_eq!(
            parse_ids(&j(
                json!({ "accountIds": ["00000000-0000-0000-0000-000000000001"] })
            ))
            .unwrap()
            .len(),
            1
        );
    }
}
