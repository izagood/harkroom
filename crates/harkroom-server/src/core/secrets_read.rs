//! S5.4 SE1 — 비밀 REST 의 읽기·지우기 다섯 줄. TS `routes/secretRoutes.ts` 의 `GET /secrets/:id`·`DELETE /secrets/:id`·
//! `GET /secrets/:id/grants`·`DELETE /secrets/:id/grants/:grantId`·`GET /secrets/:id/access` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 사람만(에이전트 403 `forbidden`) → 경로 id(400 `invalid_request`) →
//!   소유자 또는 admin(남의 것은 **있어도 404** — 이름은 권한의 지도다) → 그 줄의 일.
//! - **값은 읽지 않는다.** `secret_version.sealed` 는 kid 조각조차 고르지 않는다(kid 로 가르는 `keyLost` 는 키링이 있는
//!   목록 `GET /secrets` 에만 있고, 그 줄은 `secret_writes.rs` 가 맡는다). 답에는 TS 와 같은 메타 칸만 싣는다.
//! - 지우기: 비밀은 `delete from secret where id = $1`(판·부여는 FK cascade, access log 는 남는다), 부여는
//!   `delete from secret_grant where id = $1 and secret_id = $2` — 남의 비밀의 부여 id 를 넣어도 0 줄(404)이다.
//! - access 목록의 IP 는 소유자에게만 — admin 이 남의 것을 보면 null(security #1253 n2).
//! - 권한은 [`SECRETS_READ_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
//! - 목록·만들기·고치기·값 쓰기는 `secret_writes.rs`, 부여 주기는 `secret_grant_give.rs`, 소유자 보기(reveal)는 `secret_reveal.rs`.
//!   에이전트 줄은 `GET /agent/secret-create`·`POST /agent/secrets`·`/rotate`(generate·import 둘 다)가 `agent_secret_create.rs`,
//!   `POST /agent/secrets/reveal` 이 `agent_secret_reveal.rs` 다. 키링이 없거나 틀린 경우의 409 만 TS 에 넘긴다.
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 판·부여는 FK cascade(표 소유자 권한으로 돈다)라
/// 따로 주지 않는다. 감사 줄(`audit_log` INSERT)은 이미 있는 쓰기 코어 권한이다.
pub const SECRETS_READ_PRIVILEGES: &[(&str, &str)] =
    &[("secret", "DELETE"), ("secret_grant", "DELETE")];

#[derive(Clone)]
pub struct SecretsReadState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such secret")
}
fn no_such_grant() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such grant")
}

/// 시각은 JS `Date#toJSON` 꼴(밀리초·Z).
macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// TS `SECRET_COLS`·`SECRET_FROM` 그대로 — 지금 판은 version·size·created_by 만(sealed 는 고르지 않는다).
pub(crate) const SECRET_SQL: &str = concat!(
    "select json_build_object(",
    "'id', s.id, 'name', s.name, 'kind', s.kind, 'filename', s.filename, 'description', s.description, ",
    "'ownerAccountId', s.owner_account_id, ",
    "'expiresAt', ",
    iso!("s.expires_at"),
    ", 'createdAt', ",
    iso!("s.created_at"),
    ", 'updatedAt', ",
    iso!("s.updated_at"),
    ", 'version', v.version, 'sizeBytes', v.size_bytes, ",
    "'grantCount', (select count(*)::int from secret_grant g where g.secret_id = s.id), ",
    "'createdByAgentId', s.created_by_agent_id, 'createdCauseMessageId', s.created_cause_message_id, ",
    "'valueSetByAgentId', (select a.id from account a where a.id = v.created_by and a.kind = 'agent')",
    ")::text, s.owner_account_id::text, s.name ",
    "from secret s left join lateral (",
    "select version, size_bytes, created_by from secret_version ",
    "where secret_id = s.id and revoked_at is null order by version desc limit 1) v on true ",
    "where s.id = $1::uuid"
);

/// 소유자 또는 admin 이 볼 수 있는 비밀(json, 소유자 id, 이름).
pub(crate) struct Loaded {
    pub(crate) json: String,
    pub(crate) owner: String,
    pub(crate) name: String,
}

/// TS `human` → `idParam.parse` → `load(allowAdmin=true)`. Ok 면 지나간다.
#[allow(clippy::result_large_err)]
pub(crate) async fn load(read: &PgPool, me: &Account, id: &str) -> Result<Loaded, Response> {
    if me.kind == "agent" {
        return Err(json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "agents cannot manage secrets",
        ));
    }
    if !crate::lists::is_zod_uuid(id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        ));
    }
    let row: Option<(String, String, String)> = match sqlx::query_as(SECRET_SQL)
        .bind(id)
        .fetch_optional(read)
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(internal(e)),
    };
    match row {
        Some((json, owner, name)) if owner == me.id || me.is_admin => {
            Ok(Loaded { json, owner, name })
        }
        _ => Err(not_found()),
    }
}

/// `GET /secrets/:id`.
pub async fn get_secret(
    State(st): State<Arc<SecretsReadState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    match load(&st.read, &me, &id).await {
        Ok(s) => json_ok(format!("{{\"secret\":{}}}", s.json)),
        Err(r) => r,
    }
}

/// `DELETE /secrets/:id` — 소유자 또는 admin. 감사 `secret.deleted` {name}.
pub async fn delete_secret(
    State(st): State<Arc<SecretsReadState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let s = match load(&st.read, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Err(e) = sqlx::query("delete from secret where id = $1::uuid")
        .bind(&id)
        .execute(&st.write)
        .await
    {
        return internal(e);
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "secret.deleted",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "name": s.name }),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// TS `GET /secrets/:id/grants` 의 SELECT 그대로(정지 뒤 바뀐 칸 이름·그 마지막 시각 — 값은 싣지 않는다).
const GRANTS_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'id', g.id, 'agentId', g.agent_id, 'channelId', g.channel_id, 'operatorId', g.operator_id, ",
    "'grantedBy', g.granted_by, 'grantedAt', ",
    iso!("g.granted_at"),
    ", 'suspendedAt', ",
    iso!("g.suspended_at"),
    ", 'suspendReason', g.suspend_reason, ",
    "'changedFields', case when g.suspended_at is null then null else coalesce((",
    "select array_agg(distinct f order by f) from audit_log al, jsonb_array_elements_text(al.detail->'fields') f ",
    "where al.action = 'secret.grant.suspended' and al.target = g.agent_id::text and al.at >= g.suspended_at",
    "), '{}') end, ",
    "'lastChangedAt', ",
    iso!(
        "(case when g.suspended_at is null then null else (select date_trunc('milliseconds', max(al.at)) from audit_log al where al.action = 'secret.grant.suspended' and al.target = g.agent_id::text and al.at >= g.suspended_at) end)"
    ),
    ") order by g.granted_at), '[]')::text ",
    "from secret_grant g where g.secret_id = $1::uuid"
);

/// `GET /secrets/:id/grants`.
pub async fn list_grants(
    State(st): State<Arc<SecretsReadState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = load(&st.read, &me, &id).await {
        return r;
    }
    match sqlx::query_scalar::<_, String>(GRANTS_SQL)
        .bind(&id)
        .fetch_one(&st.read)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"grants\":{rows}}}")),
        Err(e) => internal(e),
    }
}

/// `DELETE /secrets/:id/grants/:grantId` — 소유자 또는 admin. 감사 `secret.grant.revoked` {name, grantId, agentId, channelId}.
pub async fn revoke_grant(
    State(st): State<Arc<SecretsReadState>>,
    Path((id, grant_id)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let s = match load(&st.read, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !crate::lists::is_zod_uuid(&grant_id) {
        return no_such_grant();
    }
    let row: Option<(String, Option<String>)> = match sqlx::query_as(
        "delete from secret_grant where id = $1::uuid and secret_id = $2::uuid \
         returning agent_id::text, channel_id::text",
    )
    .bind(&grant_id)
    .bind(&id)
    .fetch_optional(&st.write)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((agent_id, channel_id)) = row else {
        return no_such_grant();
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "secret.grant.revoked",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "name": s.name, "grantId": grant_id, "agentId": agent_id, "channelId": channel_id }),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// JS `Number(s)` 의 흔한 꼴만 — 빈 글·공백은 0, `0x` 16진, 그 밖은 십진 부동소수(아니면 NaN).
fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(h, 16).map_or(f64::NAN, |v| v as f64);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust 는 "inf"·"nan" 도 받는다 — JS 는 아니다.
    if t.bytes()
        .any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E')
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// TS `Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)`. 같은 키가 여럿이면 fastify 가 배열을 주고
/// `Number([a, b])` 는 NaN 이라 100 이다. 소수는 TS 에서 pg 가 거절(500)하므로 여기서도 그대로 넘긴다(아래 bind).
pub fn access_limit(raw: Option<&str>) -> f64 {
    let vals: Vec<String> = url::form_urlencoded::parse(raw.unwrap_or("").as_bytes())
        .filter(|(k, _)| k == "limit")
        .map(|(_, v)| v.into_owned())
        .collect();
    let n = match vals.as_slice() {
        [one] => js_number(one),
        [] => f64::NAN,
        _ => f64::NAN,
    };
    let n = if n.is_nan() || n == 0.0 { 100.0 } else { n };
    n.clamp(1.0, 500.0)
}

const ACCESS_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'id', id::text, 'version', version, 'agentId', agent_id, 'operatorId', operator_id, 'turnId', turn_id, ",
    "'channelId', channel_id, 'threadRootId', thread_root_id, 'result', result, 'reason', reason, ",
    "'at', ",
    iso!("at"),
    ", 'actorAccountId', actor_account_id, 'action', action, 'client', client, ",
    "'ip', case when $3::boolean then ip else null end",
    ") order by at desc, id desc), '[]')::text from (",
    "select * from secret_access_log where secret_id = $1::uuid order by at desc, id desc limit $2::text::bigint",
    ") l"
);

/// `GET /secrets/:id/access?limit=` — 소유자가 아니면(admin) ip 는 null.
pub async fn list_access(
    State(st): State<Arc<SecretsReadState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let s = match load(&st.read, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let limit = access_limit(raw.as_deref());
    // 정수가 아니면 TS 처럼 pg 가 거절한다(500) — 문자열로 넘겨 bigint 캐스트에 맡긴다.
    let limit = if limit.fract() == 0.0 {
        format!("{limit:.0}")
    } else {
        limit.to_string()
    };
    match sqlx::query_scalar::<_, String>(ACCESS_SQL)
        .bind(&id)
        .bind(&limit)
        .bind(s.owner == me.id)
        .fetch_one(&st.read)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"access\":{rows}}}")),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: SecretsReadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SecretsReadState>>::new()
        .get("/secrets/{id}", get_secret)
        .delete("/secrets/{id}", delete_secret)
        .get("/secrets/{id}/grants", list_grants)
        .delete("/secrets/{id}/grants/{grant_id}", revoke_grant)
        .get("/secrets/{id}/access", list_access)
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
    fn access_limit_follows_js() {
        assert_eq!(access_limit(None), 100.0);
        assert_eq!(access_limit(Some("limit=")), 100.0);
        assert_eq!(access_limit(Some("limit=0")), 100.0);
        assert_eq!(access_limit(Some("limit=abc")), 100.0);
        assert_eq!(access_limit(Some("limit=inf")), 100.0);
        assert_eq!(access_limit(Some("limit=-5")), 1.0);
        assert_eq!(access_limit(Some("limit=7")), 7.0);
        assert_eq!(access_limit(Some("limit=%207%20")), 7.0);
        assert_eq!(access_limit(Some("limit=1e2")), 100.0);
        assert_eq!(access_limit(Some("limit=0x10")), 16.0);
        assert_eq!(access_limit(Some("limit=9999")), 500.0);
        assert_eq!(access_limit(Some("limit=Infinity")), 500.0);
        assert_eq!(access_limit(Some("limit=3&limit=4")), 100.0);
        assert_eq!(access_limit(Some("x=1")), 100.0);
    }

    #[test]
    fn sql_never_selects_sealed_value() {
        for q in [SECRET_SQL, GRANTS_SQL, ACCESS_SQL] {
            assert!(!q.contains("sealed"), "{q}");
        }
    }
}
