//! 가벼운 쓰기②-팀(S5.2 P4b) — TS `routes/teamRoutes.ts` 의 쓰기(`services/teams.ts`). 채널에 팀 넣기
//! (`POST /channels/:id/teams/:teamId/add`)는 채널 멤버십을 쓰므로 S5.3 코어로 남긴다.
//!
//! 순서는 TS 와 같다: 본문 읽기 → preHandler(`requireCap('team.create')` 또는 대상 팀을 단 `requireCap('team.manage')`) → zod.
//! 쓴 뒤 감사(ip 는 `TRUST_PROXY` 규칙)와 `agent_team.changed {teamId, audience:'all'}` 이벤트(outbox, 쓰기와 같은 트랜잭션).
use crate::auth::Account;
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::perm::{Target, TargetKind, require_cap};
use crate::routes::AppState;
use crate::write::{AuditEntry, Body, emit_event, record_audit};
use crate::writes_settings::{bad, body_then, ip_of, write_pool};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};

/// shared `INVOKE_SCOPES`.
const INVOKE_SCOPES: &[&str] = &["owner", "list", "channel", "community"];

/// shared `HANDLE_PATTERN`(`^[a-zA-Z0-9_-]{2,32}$`) + `notReservedHandle`(`deleted-` 접두 금지, 대소문자 무시).
pub fn is_handle(s: &str) -> bool {
    (2..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !s.to_ascii_lowercase().starts_with("deleted-")
}

fn no_team() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such team")
}

fn obj(body: &Body) -> Option<&serde_json::Map<String, Value>> {
    match body {
        Body::Json(Value::Object(o)) => Some(o),
        _ => None,
    }
}

/// zod `{ name: nameSchema }`.
pub fn parse_name(body: &Body) -> Result<String, &'static str> {
    match obj(body).and_then(|o| o.get("name")) {
        Some(Value::String(n)) if is_handle(n) => Ok(n.clone()),
        _ => Err("name"),
    }
}

const TEAM_ROW: &str = concat!(
    "select row_to_json(x)::text from (select ",
    crate::team_cols!(),
    " from agent_team t where t.id = $1::uuid) x"
);
const TEAM_BY_NAME: &str = "select 1 from agent_team where lower(name) = lower($1)";
const CREATE_TEAM: &str = concat!(
    "with t as (insert into agent_team (name, created_by, owner_account_id) select $1, $2::uuid, $2::uuid \
       where not exists (select 1 from account where lower(handle) = lower($1)) \
         and not exists (select 1 from handle_group where lower(handle) = lower($1)) \
         and not exists (select 1 from agent_team where lower(name) = lower($1)) returning *) \
     select row_to_json(x)::text from (select ",
    crate::team_cols!(),
    " from t) x"
);
const RENAME_TEAM: &str = concat!(
    "with t as (update agent_team set name = $2 where id = $1::uuid \
       and not exists (select 1 from account where lower(handle) = lower($2)) \
       and not exists (select 1 from handle_group where lower(handle) = lower($2)) \
       and not exists (select 1 from agent_team where lower(name) = lower($2) and id <> $1::uuid) returning *) \
     select row_to_json(x)::text from (select ",
    crate::team_cols!(),
    " from t) x"
);
const SET_SCOPE: &str = concat!(
    "with t as (update agent_team set invoke_scope = $2, \
       owner_account_id = case when $3::boolean then $4::uuid else owner_account_id end \
     where id = $1::uuid returning *) select row_to_json(x)::text from (select ",
    crate::team_cols!(),
    " from t) x"
);
const SET_LEAD: &str = concat!(
    "with t as (update agent_team set lead_account_id = $2::uuid where id = $1::uuid \
       and ($2::uuid is null or exists (select 1 from agent_team_member m where m.team_id = $1::uuid and m.agent_account_id = $2::uuid)) \
     returning *) select row_to_json(x)::text from (select ",
    crate::team_cols!(),
    " from t) x"
);
/// `listTeamMembers`.
const MEMBERS: &str = "select json_build_object('members', coalesce((select json_agg(x order by x.handle) from (\
    select tm.agent_account_id as \"accountId\", a.handle, a.disabled_at is not null as disabled \
    from agent_team_member tm join account a on a.id = tm.agent_account_id where tm.team_id = $1::uuid) x), '[]'::json))::text";
/// `listTeamInvokers`.
const INVOKERS: &str = "select json_build_object('invokers', coalesce((select json_agg(account_id order by account_id) \
    from agent_team_invoker where team_id = $1::uuid), '[]'::json))::text";

async fn team_row(pool: &PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(TEAM_ROW)
        .bind(id)
        .fetch_optional(pool)
        .await
}

async fn changed(conn: &mut PgConnection, team_id: &str) -> Result<i64, sqlx::Error> {
    emit_event(
        conn,
        &json!({ "type": "agent_team.changed", "teamId": team_id, "audience": "all" }),
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

/// 본문 → 인증 → `team.manage`(대상 팀) — TS `requireCap('team.manage', { kind: 'team', param: 'id' })`.
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn gate_manage(
    st: &AppState,
    req: Request,
    team_id: &str,
) -> Result<(Body, Account, Parts), Response> {
    let (body, crate::auth::RequireAccount(_, auth), parts) =
        body_then::<crate::auth::RequireAccount>(req).await?;
    let me = require_cap(
        &st.pool,
        &auth,
        "team.manage",
        Some(Target {
            kind: TargetKind::Team,
            id: team_id,
        }),
    )
    .await?;
    Ok((body, me, parts))
}

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

/// `POST /teams` — `team.create`. 이름이 팀과 겹치면 400 `name_taken`(팀), 계정·집합과 겹쳐도 400 `name_taken`.
pub async fn create_team(State(st): State<AppState>, req: Request) -> Response {
    let (body, crate::auth::RequireAccount(_, auth), parts) =
        tri!(body_then::<crate::auth::RequireAccount>(req).await);
    let me = tri!(require_cap(&st.pool, &auth, "team.create", None).await);
    let name = tri!(parse_name(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let taken: Option<i32> = db!(sqlx::query_scalar(TEAM_BY_NAME)
        .bind(&name)
        .fetch_optional(pool)
        .await);
    if taken.is_some() {
        return json_err(
            StatusCode::BAD_REQUEST,
            "name_taken",
            "a team with this name already exists",
        );
    }
    let mut tx = db!(pool.begin().await);
    let row: Option<String> = db!(sqlx::query_scalar(CREATE_TEAM)
        .bind(&name)
        .bind(&me.id)
        .fetch_optional(&mut *tx)
        .await);
    let Some(row) = row else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "name_taken",
            "an account or handle group already has this name",
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
        "team.created",
        &id,
        json!({ "handle": name }),
    )
    .await;
    let mut r = json_ok(row);
    *r.status_mut() = StatusCode::CREATED;
    r
}

/// `PATCH /teams/{id}` — 이름 바꾸기. 404 `not_found` / 400 `name_taken`.
pub async fn rename_team(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, me, parts) = tri!(gate_manage(&st, req, &id).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let name = tri!(parse_name(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let mut tx = db!(pool.begin().await);
    let row: Option<String> = db!(sqlx::query_scalar(RENAME_TEAM)
        .bind(&id)
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await);
    let Some(row) = row else {
        drop(tx);
        return match db!(team_row(pool, &id).await) {
            Some(_) => json_err(
                StatusCode::BAD_REQUEST,
                "name_taken",
                "this name is already taken",
            ),
            None => no_team(),
        };
    };
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    audit(
        &st,
        pool,
        &parts,
        &me,
        "team.updated",
        &id,
        json!({ "handle": name }),
    )
    .await;
    json_ok(row)
}

/// `DELETE /teams/{id}` — 지우기 직전 팀 이름을 감사에 남긴다. 204.
pub async fn delete_team(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, me, parts) = tri!(gate_manage(&st, req, &id).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let pool = tri!(write_pool(&st));
    let mut tx = db!(pool.begin().await);
    let name: Option<String> = db!(sqlx::query_scalar(
        "delete from agent_team where id = $1::uuid returning name"
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await);
    let Some(name) = name else {
        return no_team();
    };
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    audit(
        &st,
        pool,
        &parts,
        &me,
        "team.deleted",
        &id,
        json!({ "handle": name }),
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// zod `{ invokeScope: enum, ownerAccountId: uuid.nullable().optional() }` → (범위, 소유자 바꾸나, 새 소유자).
pub fn parse_scope(body: &Body) -> Result<(String, bool, Option<String>), &'static str> {
    let o = obj(body).ok_or("expected object")?;
    let scope = match o.get("invokeScope") {
        Some(Value::String(s)) if INVOKE_SCOPES.contains(&s.as_str()) => s.clone(),
        _ => return Err("invokeScope"),
    };
    let (set, owner) = match o.get("ownerAccountId") {
        None => (false, None),
        Some(Value::Null) => (true, None),
        Some(Value::String(u)) if is_zod_uuid(u) => (true, Some(u.clone())),
        Some(_) => return Err("ownerAccountId"),
    };
    Ok((scope, set, owner))
}

/// `PUT /teams/{id}/scope` — owner 범위인데 소유자가 없으면 400 `owner_required`.
pub async fn set_scope(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, me, parts) = tri!(gate_manage(&st, req, &id).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let (scope, set, owner) = tri!(parse_scope(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let before: Option<Option<String>> = db!(sqlx::query_scalar(
        "select owner_account_id::text from agent_team where id = $1::uuid"
    )
    .bind(&id)
    .fetch_optional(pool)
    .await);
    let Some(before_owner) = before else {
        return no_team();
    };
    let effective = if set { owner.clone() } else { before_owner };
    if scope == "owner" && effective.is_none() {
        return json_err(
            StatusCode::BAD_REQUEST,
            "owner_required",
            "owner 범위에는 소유자가 있어야 한다",
        );
    }
    let mut tx = db!(pool.begin().await);
    let row: Option<String> = db!(sqlx::query_scalar(SET_SCOPE)
        .bind(&id)
        .bind(&scope)
        .bind(set)
        .bind(&owner)
        .fetch_optional(&mut *tx)
        .await);
    let Some(row) = row else {
        return no_team();
    };
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    let team: Value = serde_json::from_str(&row).unwrap_or(Value::Null);
    audit(
        &st,
        pool,
        &parts,
        &me,
        "team.scope.set",
        &id,
        json!({ "invokeScope": team["invokeScope"], "ownerAccountId": team["ownerAccountId"] }),
    )
    .await;
    json_ok(row)
}

/// `PUT`·`DELETE /teams/{id}/invokers/{accountId}` — `{ invokers }`.
pub async fn put_invoker(
    State(st): State<AppState>,
    Path((id, account)): Path<(String, String)>,
    req: Request,
) -> Response {
    invoker(st, id, account, req, true).await
}
pub async fn delete_invoker(
    State(st): State<AppState>,
    Path((id, account)): Path<(String, String)>,
    req: Request,
) -> Response {
    invoker(st, id, account, req, false).await
}

async fn account_exists(pool: &PgPool, id: &str) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as("select kind, handle from account where id = $1::uuid")
        .bind(id)
        .fetch_optional(pool)
        .await
}

async fn invoker(
    st: AppState,
    id: String,
    account: String,
    req: Request,
    present: bool,
) -> Response {
    let (_, me, parts) = tri!(gate_manage(&st, req, &id).await);
    if !is_zod_uuid(&id) || !is_zod_uuid(&account) {
        return bad("params");
    }
    let pool = tri!(write_pool(&st));
    if db!(team_row(pool, &id).await).is_none() {
        return no_team();
    }
    if db!(account_exists(pool, &account).await).is_none() {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such account");
    }
    let mut tx = db!(pool.begin().await);
    let sql = if present {
        "insert into agent_team_invoker (team_id, account_id) values ($1::uuid, $2::uuid) on conflict do nothing"
    } else {
        "delete from agent_team_invoker where team_id = $1::uuid and account_id = $2::uuid"
    };
    db!(sqlx::query(sql)
        .bind(&id)
        .bind(&account)
        .execute(&mut *tx)
        .await);
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    let action = if present {
        "team.invoker.added"
    } else {
        "team.invoker.removed"
    };
    audit(
        &st,
        pool,
        &parts,
        &me,
        action,
        &id,
        json!({ "accountId": account }),
    )
    .await;
    json_ok(db!(sqlx::query_scalar::<_, String>(INVOKERS)
        .bind(&id)
        .fetch_one(pool)
        .await))
}

/// zod `{ accountId: uuid.nullable() }` — 키가 없으면 400(빠뜨린 것을 해제로 읽지 않는다).
pub fn parse_lead(body: &Body) -> Result<Option<String>, &'static str> {
    match obj(body).ok_or("expected object")?.get("accountId") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(u)) if is_zod_uuid(u) => Ok(Some(u.clone())),
        _ => Err("accountId"),
    }
}

/// `PUT /teams/{id}/lead` — 팀원만. 404 / 400 `not_a_member`. 감사에는 handle.
pub async fn set_lead(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, me, parts) = tri!(gate_manage(&st, req, &id).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let lead = tri!(parse_lead(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let mut tx = db!(pool.begin().await);
    let row: Option<String> = db!(sqlx::query_scalar(SET_LEAD)
        .bind(&id)
        .bind(&lead)
        .fetch_optional(&mut *tx)
        .await);
    let Some(row) = row else {
        drop(tx);
        return match db!(team_row(pool, &id).await) {
            Some(_) => json_err(
                StatusCode::BAD_REQUEST,
                "not_a_member",
                "the lead must be a member of this team",
            ),
            None => no_team(),
        };
    };
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    let handle = match &lead {
        Some(a) => db!(account_exists(pool, a).await).map(|x| x.1),
        None => None,
    };
    audit(
        &st,
        pool,
        &parts,
        &me,
        "team.lead.set",
        &id,
        json!({ "handle": handle }),
    )
    .await;
    json_ok(row)
}

/// `PUT /teams/{id}/members/{accountId}` — 에이전트만(400 `not_an_agent`). `{ members }`.
pub async fn put_member(
    State(st): State<AppState>,
    Path((id, account)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_, me, parts) = tri!(gate_manage(&st, req, &id).await);
    if !is_zod_uuid(&id) || !is_zod_uuid(&account) {
        return bad("params");
    }
    let pool = tri!(write_pool(&st));
    if db!(team_row(pool, &id).await).is_none() {
        return no_team();
    }
    let Some((kind, handle)) = db!(account_exists(pool, &account).await) else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such account");
    };
    if kind != "agent" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "not_an_agent",
            "only agents can join a team",
        );
    }
    let mut tx = db!(pool.begin().await);
    db!(sqlx::query("insert into agent_team_member (team_id, agent_account_id) values ($1::uuid, $2::uuid) on conflict do nothing").bind(&id).bind(&account).execute(&mut *tx).await);
    db!(changed(&mut tx, &id).await);
    db!(tx.commit().await);
    audit(
        &st,
        pool,
        &parts,
        &me,
        "team.member.added",
        &id,
        json!({ "handle": handle }),
    )
    .await;
    json_ok(db!(sqlx::query_scalar::<_, String>(MEMBERS)
        .bind(&id)
        .fetch_one(pool)
        .await))
}

/// `DELETE /teams/{id}/members/{accountId}` — 실제로 뺐을 때만 감사·이벤트. `{ members }`.
pub async fn delete_member(
    State(st): State<AppState>,
    Path((id, account)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_, me, parts) = tri!(gate_manage(&st, req, &id).await);
    if !is_zod_uuid(&id) || !is_zod_uuid(&account) {
        return bad("params");
    }
    let pool = tri!(write_pool(&st));
    if db!(team_row(pool, &id).await).is_none() {
        return no_team();
    }
    let mut tx = db!(pool.begin().await);
    let removed = db!(sqlx::query(
        "delete from agent_team_member where team_id = $1::uuid and agent_account_id = $2::uuid"
    )
    .bind(&id)
    .bind(&account)
    .execute(&mut *tx)
    .await)
    .rows_affected()
        > 0;
    if removed {
        db!(changed(&mut tx, &id).await);
    }
    db!(tx.commit().await);
    if removed {
        // TS 는 `{ handle: rows[0]?.handle }` — 계정이 없으면 `undefined` 라 JSON 에서 키가 빠진다.
        let detail = match db!(account_exists(pool, &account).await) {
            Some((_, h)) => json!({ "handle": h }),
            None => json!({}),
        };
        audit(&st, pool, &parts, &me, "team.member.removed", &id, detail).await;
    }
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
    fn handle_rules() {
        assert!(is_handle("ab"));
        assert!(is_handle("Team_1-x"));
        assert!(!is_handle("a"));
        assert!(!is_handle(&"a".repeat(33)));
        assert!(!is_handle("a b"));
        assert!(!is_handle("Deleted-x"), "예약 접두");
        assert!(!is_handle("팀"));
    }

    #[test]
    fn scope_and_lead_shapes() {
        assert_eq!(
            parse_scope(&j(json!({ "invokeScope": "list" }))),
            Ok(("list".into(), false, None))
        );
        assert_eq!(
            parse_scope(&j(
                json!({ "invokeScope": "owner", "ownerAccountId": null })
            )),
            Ok(("owner".into(), true, None))
        );
        assert!(parse_scope(&j(json!({ "invokeScope": "all" }))).is_err());
        assert!(parse_scope(&j(json!({ "invokeScope": "list", "ownerAccountId": "x" }))).is_err());
        assert_eq!(parse_lead(&j(json!({ "accountId": null }))), Ok(None));
        assert!(
            parse_lead(&j(json!({}))).is_err(),
            "빠뜨린 키는 해제가 아니다"
        );
        assert!(parse_name(&j(json!({ "name": "deleted-x" }))).is_err());
    }
}
