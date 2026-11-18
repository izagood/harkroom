//! S5.4 SE2 — 비밀 부여(`PUT /secrets/:id/grants`). TS `routes/secretRoutes.ts` 의 같은 줄을 옮긴다. 값은 읽지 않는다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 사람만(403 `forbidden`) → 경로 id(400) → 소유자·admin 아니면 404 →
//!   소유자만 403 `owner_only` → 본문(400 `bad_request`) → 만료 409 `secret_expired` → 에이전트 없음 404 →
//!   내 에이전트가 아님 403 `not_own_agent` → 채널 없음 404 → `operator: current` 인데 배정 없음 409 `not_assigned` →
//!   upsert → 감사 `secret.grant.given` → 200 `{grantId, operatorId}`.
//! - 판정 읽기는 읽기 풀, upsert·감사는 쓰기 풀. 권한은 [`SECRET_GRANT_GIVE_PRIVILEGES`] — 없으면 TS 에 남는다.
//! - 다시 승인 `POST /secrets/:id/grants/:grantId/reapprove`([`reapprove`])도 여기서 맡는다 — 같은 상태·같은 권한 묶음.
use crate::auth::RequireAccount;
use crate::core::secrets_read::{SecretsReadState, load};
use crate::directory::{internal, json_err, json_ok};
use crate::write::{AuditEntry, Body, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한(upsert 의 INSERT·DO UPDATE SET·충돌 칸과 `returning` 의 SELECT).
pub const SECRET_GRANT_GIVE_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_grant.id", "SELECT"),
    ("secret_grant.secret_id", "SELECT"),
    ("secret_grant.agent_id", "SELECT"),
    ("secret_grant.channel_id", "SELECT"),
    ("secret_grant.secret_id", "INSERT"),
    ("secret_grant.agent_id", "INSERT"),
    ("secret_grant.channel_id", "INSERT"),
    ("secret_grant.operator_id", "INSERT"),
    ("secret_grant.granted_by", "INSERT"),
    ("secret_grant.operator_id", "UPDATE"),
    ("secret_grant.granted_by", "UPDATE"),
    ("secret_grant.granted_at", "UPDATE"),
    ("secret_grant.suspended_at", "UPDATE"),
    ("secret_grant.suspend_reason", "UPDATE"),
    // 다시 승인(`POST /secrets/{id}/grants/{g}/reapprove`)의 조건부 갱신이 WHERE 에서 읽는 칸.
    ("secret_grant.suspended_at", "SELECT"),
    ("account.id", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("secret.id", "SELECT"),
    ("secret.expires_at", "SELECT"),
    ("agent_assignment.agent_id", "SELECT"),
    ("agent_assignment.operator_id", "SELECT"),
    ("audit_log.action", "SELECT"),
    ("audit_log.target", "SELECT"),
    ("audit_log.at", "SELECT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

const EXPIRED_SQL: &str = "select 1 from secret where id = $1::uuid and expires_at <= now()";
const AGENT_SQL: &str = "select a.id::text, asg.operator_id::text, c.owner_account_id::text from account a \
       left join agent_assignment asg on asg.agent_id = a.id \
       left join agent_config c on c.account_id = a.id \
      where a.id = $1::uuid and a.kind = 'agent' and a.deleted_at is null";
const CHANNEL_SQL: &str = "select 1 from channel where id = $1::uuid";
const UPSERT_SQL: &str = "insert into secret_grant (secret_id, agent_id, channel_id, operator_id, granted_by) \
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid) \
       on conflict (secret_id, agent_id, coalesce(channel_id, '00000000-0000-0000-0000-000000000000'::uuid)) \
       do update set operator_id = excluded.operator_id, granted_by = excluded.granted_by, \
                     granted_at = now(), suspended_at = null, suspend_reason = null \
       returning id::text";

#[derive(Debug, PartialEq)]
struct Grant {
    agent_id: String,
    channel_id: Option<String>,
    current: bool,
}

/// zod `grantBody` — 모르는 키는 버린다. 본문이 없으면 `{}`(TS `req.body ?? {}`).
fn parse(body: &Body) -> Option<Grant> {
    let empty = serde_json::Map::new();
    let o = match body {
        Body::None | Body::Json(Value::Null) => &empty,
        Body::Json(Value::Object(o)) => o,
        _ => return None,
    };
    let agent_id = o.get("agentId")?.as_str()?;
    if !crate::lists::is_zod_uuid(agent_id) {
        return None;
    }
    let channel_id = match o.get("channelId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if crate::lists::is_zod_uuid(s) => Some(s.clone()),
        _ => return None,
    };
    let current = match o.get("operator") {
        None => true,
        Some(Value::String(s)) if s == "current" => true,
        Some(Value::String(s)) if s == "any" => false,
        _ => return None,
    };
    Some(Grant {
        agent_id: agent_id.to_owned(),
        channel_id,
        current,
    })
}

/// `PUT /secrets/:id/grants`.
pub async fn give(
    State(st): State<Arc<SecretsReadState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let s = match load(&st.read, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if s.owner != me.id {
        return json_err(
            StatusCode::FORBIDDEN,
            "owner_only",
            "only the secret owner can grant it",
        );
    }
    let Some(g) = parse(&body) else {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(StatusCode::BAD_REQUEST, "bad_request", "body: invalid");
    };
    match sqlx::query(EXPIRED_SQL)
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(Some(_)) => {
            return json_err(
                StatusCode::CONFLICT,
                "secret_expired",
                "the secret has expired; replace its value or extend expiresAt first",
            );
        }
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    type A = (String, Option<String>, Option<String>);
    let agent: Option<A> = match sqlx::query_as(AGENT_SQL)
        .bind(&g.agent_id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((_, operator_id, owner)) = agent else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent");
    };
    if owner.as_deref() != Some(me.id.as_str()) {
        return json_err(
            StatusCode::FORBIDDEN,
            "not_own_agent",
            "secrets can only be given to your own agents",
        );
    }
    if let Some(ch) = &g.channel_id {
        match sqlx::query(CHANNEL_SQL)
            .bind(ch)
            .fetch_optional(&st.read)
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel"),
            Err(e) => return internal(e),
        }
    }
    if g.current && operator_id.is_none() {
        return json_err(
            StatusCode::CONFLICT,
            "not_assigned",
            "the agent is not assigned to an operator; assign it first or grant with operator: \"any\"",
        );
    }
    let bound = if g.current { operator_id } else { None };
    let grant_id: String = match sqlx::query_scalar(UPSERT_SQL)
        .bind(&id)
        .bind(&g.agent_id)
        .bind(&g.channel_id)
        .bind(&bound)
        .bind(&me.id)
        .fetch_one(&st.write)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "secret.grant.given",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "name": s.name, "grantId": grant_id, "agentId": g.agent_id, "channelId": g.channel_id, "operatorId": bound }),
        },
    )
    .await;
    json_ok(json!({ "grantId": grant_id, "operatorId": bound }).to_string())
}

const RE_CUR_SQL: &str = "select g.agent_id::text, g.channel_id::text, g.operator_id::text, \
       to_char(g.suspended_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), g.suspend_reason, \
       asg.operator_id::text, c.owner_account_id::text, a.deleted_at is not null \
       from secret_grant g join account a on a.id = g.agent_id \
       left join agent_assignment asg on asg.agent_id = g.agent_id \
       left join agent_config c on c.account_id = g.agent_id \
      where g.id = $1::uuid and g.secret_id = $2::uuid";
const RE_DISABLED_SQL: &str =
    "select 1 from account where id = $1::uuid and disabled_at is not null";
/// TS `newer(seen)` — 본 뒤(또는 본 것이 없는데 정지 뒤)에 남은 `secret.grant.suspended` 기록.
macro_rules! re_newer {
    ($seen:literal) => {
        concat!(
            "select 1 from audit_log al where al.action = 'secret.grant.suspended' and al.target = g.agent_id::text \
               and al.at >= g.suspended_at and (",
            $seen,
            "::timestamptz is null or date_trunc('milliseconds', al.at) > ",
            $seen,
            "::timestamptz)"
        )
    };
}
const RE_CHANGED_SQL: &str = concat!(
    "select 1 from secret_grant g where g.id = $1::uuid and exists (",
    re_newer!("$2"),
    ")"
);
const RE_UPDATE_SQL: &str = concat!(
    "update secret_grant g set operator_id = $3::uuid, granted_by = $4::uuid, granted_at = now(), \
       suspended_at = null, suspend_reason = null \
      where g.id = $1::uuid and g.secret_id = $2::uuid and g.suspended_at is not null \
        and exists (select 1 from account a join agent_config c on c.account_id = a.id \
                     where a.id = g.agent_id and a.deleted_at is null and a.disabled_at is null and c.owner_account_id = $4::uuid) \
        and not exists (select 1 from secret x where x.id = g.secret_id and x.expires_at <= now()) \
        and ($3::uuid is null or exists (select 1 from agent_assignment asg where asg.agent_id = g.agent_id and asg.operator_id = $3::uuid)) \
        and not exists (",
    re_newer!("$5"),
    ")"
);

/// zod `{ seenChangedAt: datetime({offset:true}).nullable() }.strict()` — 본문이 없으면 `{}`(→ 거절).
/// `Some(None)` 은 null, `Some(Some(s))` 는 원문 그대로(TS 도 원문을 `::timestamptz` 로 넘긴다).
fn parse_seen(body: &Body) -> Option<Option<String>> {
    let o = match body {
        Body::Json(Value::Object(o)) => o,
        _ => return None,
    };
    if o.len() != 1 {
        return None;
    }
    match o.get("seenChangedAt")? {
        Value::Null => Some(None),
        Value::String(s) if crate::write::zod_datetime_offset(s).is_ok() => Some(Some(s.clone())),
        _ => None,
    }
}

fn no_grant() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such grant")
}

fn conflict(code: &str, msg: &str) -> Response {
    json_err(StatusCode::CONFLICT, code, msg)
}

/// `POST /secrets/:id/grants/:grantId/reapprove` — 정지된 부여를 소유자가 다시 승인한다(TS 같은 줄).
/// 순서: 401 → 사람·불러오기(`load`) → 소유자만 403 `owner_only` → grantId uuid 아니면 404 → 본문 400 →
/// 없거나 지운 에이전트 404 → 정지 아님 409 → 만료 409 → 내 에이전트 아님 403 → 꺼짐 409 → 배정 없음 409 →
/// 본 뒤 바뀜 409 `changed_since` → 조건부 갱신 0 줄이면 409 `state_changed` → 감사 `secret.grant.reapproved` → 200.
pub async fn reapprove(
    State(st): State<Arc<SecretsReadState>>,
    Path((id, grant_id)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let s = match load(&st.read, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if s.owner != me.id {
        return json_err(
            StatusCode::FORBIDDEN,
            "owner_only",
            "only the secret owner can re-approve a grant",
        );
    }
    if !crate::lists::is_zod_uuid(&grant_id) {
        return no_grant();
    }
    let Some(seen) = parse_seen(&body) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "seenChangedAt (the lastChangedAt you reviewed, or null) is required",
        );
    };
    type Cur = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
    );
    let cur: Option<Cur> = match sqlx::query_as(RE_CUR_SQL)
        .bind(&grant_id)
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((
        agent_id,
        channel_id,
        operator_id,
        suspended_at,
        suspend_reason,
        assigned,
        agent_owner,
        deleted,
    )) = cur
    else {
        return no_grant();
    };
    if deleted {
        return no_grant();
    }
    let Some(suspended_at) = suspended_at else {
        return conflict("not_suspended", "the grant is not suspended");
    };
    match sqlx::query(EXPIRED_SQL)
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(Some(_)) => {
            return conflict(
                "secret_expired",
                "the secret has expired; replace its value or extend expiresAt first",
            );
        }
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    if agent_owner.as_deref() != Some(me.id.as_str()) {
        return json_err(
            StatusCode::FORBIDDEN,
            "not_own_agent",
            "secrets can only be given to your own agents",
        );
    }
    match sqlx::query(RE_DISABLED_SQL)
        .bind(&agent_id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(Some(_)) => return conflict("agent_disabled", "enable the agent before re-approving"),
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    let bound = operator_id.is_some();
    if bound && assigned.is_none() {
        return conflict(
            "not_assigned",
            "the agent is not assigned to an operator; assign it first or grant again with operator: \"any\"",
        );
    }
    let bound_operator = if bound { assigned } else { None };
    match sqlx::query(RE_CHANGED_SQL)
        .bind(&grant_id)
        .bind(&seen)
        .fetch_optional(&st.read)
        .await
    {
        Ok(Some(_)) => {
            return conflict(
                "changed_since",
                "the agent definition changed after you reviewed it; reload and review again",
            );
        }
        Ok(None) => {}
        Err(e) => return internal(e),
    }
    let n = match sqlx::query(RE_UPDATE_SQL)
        .bind(&grant_id)
        .bind(&id)
        .bind(&bound_operator)
        .bind(&me.id)
        .bind(&seen)
        .execute(&st.write)
        .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => return internal(e),
    };
    if n == 0 {
        return conflict(
            "state_changed",
            "the grant or agent changed while re-approving; reload and try again",
        );
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "secret.grant.reapproved",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({
                "name": s.name, "grantId": grant_id, "agentId": agent_id, "channelId": channel_id,
                "operatorId": bound_operator, "previousOperatorId": operator_id,
                "suspendReason": suspend_reason, "suspendedAt": suspended_at,
            }),
        },
    )
    .await;
    json_ok(json!({ "grantId": grant_id, "operatorId": bound_operator }).to_string())
}

pub fn routes(
    st: SecretsReadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SecretsReadState>>::new()
        .put("/secrets/{id}/grants", give)
        .post("/secrets/{id}/grants/{grant_id}/reapprove", reapprove)
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

    const A: &str = "0b9f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";

    #[test]
    fn parse_matches_zod() {
        let ok = parse(&Body::Json(json!({ "agentId": A, "x": 1 }))).unwrap();
        assert_eq!(ok.channel_id, None);
        assert!(ok.current);
        let any = parse(&Body::Json(
            json!({ "agentId": A, "channelId": A, "operator": "any" }),
        ))
        .unwrap();
        assert_eq!(any.channel_id.as_deref(), Some(A));
        assert!(!any.current);
        assert!(parse(&Body::None).is_none());
        assert!(parse(&Body::Text("x".into())).is_none());
        assert!(parse(&Body::Json(json!({ "agentId": A, "operator": "x" }))).is_none());
        assert!(parse(&Body::Json(json!({ "agentId": A, "channelId": "nope" }))).is_none());
        assert!(parse(&Body::Json(json!({ "agentId": "nope" }))).is_none());
    }

    #[test]
    fn never_reads_values() {
        for q in [
            EXPIRED_SQL,
            AGENT_SQL,
            CHANNEL_SQL,
            UPSERT_SQL,
            RE_CUR_SQL,
            RE_DISABLED_SQL,
            RE_CHANGED_SQL,
            RE_UPDATE_SQL,
        ] {
            assert!(!q.contains("sealed"), "{q}");
        }
    }

    #[test]
    fn parse_seen_matches_zod_strict() {
        assert_eq!(
            parse_seen(&Body::Json(json!({ "seenChangedAt": null }))),
            Some(None)
        );
        let t = "2026-01-02T03:04:05.123+09:00";
        assert_eq!(
            parse_seen(&Body::Json(json!({ "seenChangedAt": t }))),
            Some(Some(t.to_owned()))
        );
        assert!(parse_seen(&Body::None).is_none());
        assert!(parse_seen(&Body::Json(json!({}))).is_none());
        assert!(parse_seen(&Body::Json(json!({ "seenChangedAt": null, "x": 1 }))).is_none());
        assert!(parse_seen(&Body::Json(json!({ "seenChangedAt": "yesterday" }))).is_none());
        assert!(parse_seen(&Body::Json(json!({ "seenChangedAt": 1 }))).is_none());
    }

    #[test]
    fn reapprove_sql_rechecks_and_binds_seen() {
        assert!(RE_CHANGED_SQL.contains("$2::timestamptz is null"));
        assert!(RE_UPDATE_SQL.contains("$5::timestamptz is null"));
        assert!(RE_UPDATE_SQL.contains("a.disabled_at is null"));
        assert!(RE_UPDATE_SQL.contains("g.suspended_at is not null"));
        assert!(!RE_UPDATE_SQL.contains("$6"));
    }

    #[test]
    fn privileges_cover_reapprove_and_audit() {
        for p in [
            ("secret_grant.suspended_at", "SELECT"),
            ("account.disabled_at", "SELECT"),
            ("audit_log.at", "SELECT"),
            ("audit_log.detail", "INSERT"),
        ] {
            assert!(SECRET_GRANT_GIVE_PRIVILEGES.contains(&p), "{p:?}");
        }
    }
}
