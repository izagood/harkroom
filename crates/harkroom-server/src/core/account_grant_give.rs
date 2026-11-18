//! S5.4 — grant 주기. TS `routes/grantRoutes.ts` 의 `PUT /accounts/:id/grants` 를 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireAccount`(401) → 경로 zod(400) → 본문 zod(400 `bad_request`) → api.call 전용 칸(400)
//!   → `member.reset_password`(400 `not_grantable`) → capability 별 판정 → 대상 없음 404 → 전 값 읽기 → upsert
//!   → 감사 `grant.given`/`grant.updated {changed?, capability, scope, expiresAt, allowAgentCause?}` → `grant.changed` → 200 `{grants}`.
//! - `tool.allow` 는 여기서 판정한다(규칙 정규형은 `harkroom_proto::tool_rules::validate_tool_rule`, 사람 세션·소유자·만료 상한).
//! - `api.call`(연결·limits·위임 판정)은 본문 검사까지 마친 뒤 TS 로 넘긴다
//!   — 여기까지는 부작용이 없어 TS 가 처음부터 다시 판정해도 같다.
//! - 알려진 차이: zod 실패의 `message` 는 TS 가 zod issue JSON 이다 — 여기서는 `"body"`. `repo:` scope 길이는
//!   UTF-16 단위가 아니라 문자 수로 센다.
//! - 쓰기 권한은 [`ACCOUNT_GRANT_GIVE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::{Account, RequireAccount};
use crate::core::mcp::grant_writes::repo_grant_scope;
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::proxy::Upstream;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, BODY_LIMIT, Body, emit_event, record_audit};
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// `grant select (account_id, owner_account_id) on agent_config`, `grant select (id, kind) on account`,
/// `grant select (account_id, capability, scope, expires_at, limits, write_needs_human_cause, delegate_depth,
///  allow_agent_cause, suspended_at, granted_by, parent_grant_id, granted_at, id, suspend_reason), insert, update on account_grant`,
/// `grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log` (+ 이벤트 outbox).
pub const ACCOUNT_GRANT_GIVE_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account_grant", "SELECT"),
    ("account_grant", "INSERT"),
    ("account_grant", "UPDATE"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AccountGrantGiveState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    pub up: Upstream,
}

#[derive(Debug, PartialEq)]
pub(crate) struct GrantBody {
    capability: String,
    scope: String,
    /// `None` = 칸 없음, `Some(None)` = `null`, `Some(Some(s))` = 원문.
    expires_at: Option<Option<String>>,
    allow_agent_cause: Option<bool>,
    has_limits: bool,
    delegate_depth: Option<i64>,
    write_needs_human_cause: Option<bool>,
}

fn hex36(s: &str) -> bool {
    s.len() == 36
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-')
}

/// grantBody 의 scope 정규식.
pub(crate) fn scope_ok(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    for p in ["channel:", "team:", "agent:", "connector:"] {
        if let Some(r) = s.strip_prefix(p)
            && hex36(r)
        {
            return true;
        }
    }
    if let Some(r) = s.strip_prefix("repo:") {
        let n = r.chars().count();
        if (3..=201).contains(&n) && !r.chars().any(char::is_whitespace) {
            return true;
        }
    }
    if let Some(r) = s.strip_prefix("tool:")
        && r.len() > 37
        && r.is_char_boundary(36)
        && hex36(&r[..36])
        && r.as_bytes()[36] == b':'
    {
        let rule = &r[37..];
        let n = rule.chars().count();
        if (1..=300).contains(&n) && !rule.contains('\n') {
            return true;
        }
    }
    false
}

/// zod `z.string().datetime()`(오프셋 없이 `Z` 만).
fn zod_datetime_z(s: &str) -> bool {
    s.ends_with('Z') && crate::write::zod_datetime_offset(s).is_ok()
}

/// `grantBody.safeParse(req.body ?? {})`.
pub(crate) fn parse_body(body: &Body) -> Option<GrantBody> {
    let empty = Map::new();
    let m = match body {
        Body::None | Body::Json(Value::Null) => &empty,
        Body::Json(Value::Object(m)) => m,
        _ => return None,
    };
    let capability = match m.get("capability") {
        Some(Value::String(c)) if crate::perm::CAPABILITIES.contains(&c.as_str()) => c.clone(),
        _ => return None,
    };
    let scope = match m.get("scope") {
        None => String::new(),
        Some(Value::String(s)) if scope_ok(s) => s.clone(),
        _ => return None,
    };
    let expires_at = match m.get("expiresAt") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if zod_datetime_z(s) => Some(Some(s.clone())),
        _ => return None,
    };
    let opt_bool = |k: &str| -> Result<Option<bool>, ()> {
        match m.get(k) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            _ => Err(()),
        }
    };
    let allow_agent_cause = opt_bool("allowAgentCause").ok()?;
    let write_needs_human_cause = opt_bool("writeNeedsHumanCause").ok()?;
    let delegate_depth = match m.get("delegateDepth") {
        None => None,
        Some(Value::Number(n)) => {
            let f = n.as_f64()?;
            if f.fract() != 0.0 || !(0.0..=2.0).contains(&f) {
                return None;
            }
            Some(f as i64)
        }
        _ => return None,
    };
    Some(GrantBody {
        capability,
        scope,
        expires_at,
        allow_agent_cause,
        has_limits: m.contains_key("limits"),
        delegate_depth,
        write_needs_human_cause,
    })
}

fn err(s: StatusCode, code: &str, msg: &str) -> Response {
    json_err(s, code, msg)
}

/// `select c.owner_account_id … where c.account_id = $1 and a.kind = 'agent'` — 행 없음 `None`, 소유자 없음 `Some(None)`.
async fn agent_owner(pool: &PgPool, id: &str) -> Result<Option<Option<String>>, sqlx::Error> {
    sqlx::query_scalar::<_, Option<String>>(
        "select c.owner_account_id::text from agent_config c join account a on a.id = c.account_id \
         where c.account_id = $1::uuid and a.kind = 'agent'",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// `checkMergeGrant` — 맞으면 정규화한 scope.
async fn check_merge(
    pool: &PgPool,
    me: &Account,
    id: &str,
    scope: &str,
    cap: &str,
) -> Result<String, Response> {
    let rest = if scope.len() >= 5
        && scope.is_char_boundary(5)
        && scope[..5].eq_ignore_ascii_case("repo:")
    {
        &scope[5..]
    } else {
        scope
    };
    let normalized = if scope.is_empty() {
        None
    } else {
        repo_grant_scope(rest)
    };
    let Some(normalized) = normalized else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "bad_scope",
            &format!(
                "{cap} 의 scope 는 repo:<owner>/<name> 또는 조직 전체 repo:<owner>/* 하나다 — 전역(빈 scope)·부분 패턴은 없다"
            ),
        ));
    };
    if me.kind != "human" {
        return Err(err(
            StatusCode::FORBIDDEN,
            "forbidden",
            &format!("{cap} 는 사람만 줄 수 있다"),
        ));
    }
    match agent_owner(pool, id).await {
        Err(e) => Err(internal(e)),
        Ok(None) => Err(err(
            StatusCode::NOT_FOUND,
            "not_found",
            &format!("{cap} 는 에이전트에게만 준다"),
        )),
        Ok(Some(o)) if o.as_deref() != Some(me.id.as_str()) => Err(err(
            StatusCode::FORBIDDEN,
            "forbidden",
            &format!("{cap} 는 그 에이전트의 소유자만 준다"),
        )),
        Ok(Some(_)) => Ok(normalized),
    }
}

/// `secretCreateOwner`.
/// `cap` 은 문구 머리 — `tool.allow` 는 TS 가 `message.replace('secret.create', 'tool.allow')` 로 같은 문구를 쓴다.
async fn check_secret_owner(
    pool: &PgPool,
    me: &Account,
    id: &str,
    cap: &str,
) -> Result<(), Response> {
    if me.kind != "human" {
        return Err(err(
            StatusCode::FORBIDDEN,
            "forbidden",
            &format!("{cap} 는 사람만 준다"),
        ));
    }
    match agent_owner(pool, id).await {
        Err(e) => Err(internal(e)),
        Ok(None) => Err(err(
            StatusCode::NOT_FOUND,
            "not_found",
            &format!("{cap} 는 에이전트에게만 준다"),
        )),
        Ok(Some(o)) if o.as_deref() != Some(me.id.as_str()) => Err(err(
            StatusCode::FORBIDDEN,
            "forbidden",
            &format!("{cap} 는 그 에이전트의 소유자만 준다"),
        )),
        Ok(Some(_)) => Ok(()),
    }
}

/// 설정 화면 `tool.allow` 의 만료 상한(30일 + 1분 여유) — TS `TOOL_RULE_CAPPED_EXPIRY_MS`.
const TOOL_RULE_CAPPED_EXPIRY_MS: i64 = 30 * 86_400_000 + 60_000;
/// TS `TOOL_RULE_EXPIRY_CAPPED_WARNINGS`.
const TOOL_RULE_EXPIRY_CAPPED_WARNINGS: &[&str] = &[
    "runs_arbitrary",
    "executes_in_workload",
    "mutates_remote",
    "unclassified",
];

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `Date.parse(expiresAt)` — zod 를 이미 통과한 값.
fn expires_ms(s: &str) -> Option<i64> {
    let iso = iso(s)?;
    chrono::DateTime::parse_from_rfc3339(&iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// `tool.allow` 판정 — TS 와 같은 순서: scope 꼴·규칙 정규형(400 `bad_scope`) → 사람 세션(403) → 소유자(`secretCreateOwner`)
/// → 위험 경고면 만료 필수·30일 안 → 지난 만료(400).
async fn check_tool_allow(
    pool: &PgPool,
    me: &Account,
    auth: &crate::auth::Auth,
    id: &str,
    b: &GrantBody,
) -> Result<(), Response> {
    use harkroom_proto::tool_rules::{ToolRuleVerdict, validate_tool_rule};
    let parsed = crate::core::mcp::reads4::parse_tool_scope(&b.scope);
    let warnings = match parsed.map(|(_, rule)| (rule, validate_tool_rule(rule))) {
        Some((
            rule,
            ToolRuleVerdict::Ok {
                rule: norm,
                warnings,
                ..
            },
        )) if norm == rule && b.allow_agent_cause.is_none() => warnings,
        _ => {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "bad_scope",
                "tool.allow 의 scope 는 tool:<channelId>:<정규화한 규칙> 이고 넓은 규칙은 받지 않는다",
            ));
        }
    };
    if auth.via != Some(crate::auth::Via::Session) {
        return Err(err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "tool.allow 는 앱에 로그인한 소유자만 준다",
        ));
    }
    check_secret_owner(pool, me, id, "tool.allow").await?;
    let exp = b.expires_at.clone().flatten();
    let exp_ms = exp.as_deref().and_then(expires_ms);
    if warnings
        .iter()
        .any(|w| TOOL_RULE_EXPIRY_CAPPED_WARNINGS.contains(w))
    {
        if exp.is_none() {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "tool_rule_needs_expiry",
                "이 규칙은 위험 경고가 붙어 만료가 필수다(30일 안)",
            ));
        }
        if exp_ms.is_some_and(|t| t > now_ms() + TOOL_RULE_CAPPED_EXPIRY_MS) {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "tool_rule_expiry_too_long",
                "위험 경고가 붙은 규칙의 만료는 30일 안이다",
            ));
        }
    }
    if exp_ms.is_some_and(|t| t <= now_ms()) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "만료가 이미 지났다",
        ));
    }
    Ok(())
}

/// `new Date(s).toISOString()` — 이미 zod 를 통과한 값.
fn iso(s: &str) -> Option<String> {
    crate::write::zod_datetime_offset(s).ok().flatten()
}

/// `PUT /accounts/{id}/grants`.
pub async fn put_grants(
    State(st): State<Arc<AccountGrantGiveState>>,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    let bytes = match to_bytes(raw, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let body = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(b) => b,
        Err(r) => return r,
    };
    // fastify 는 본문을 preHandler 보다 먼저 읽는다 — 본문 거절(413·415·JSON)이 경로 zod 보다 앞선다.
    if !is_zod_uuid(&id) {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let Some(b) = parse_body(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad_request", "body");
    };
    let cap = b.capability.as_str();
    if cap != "api.call"
        && (b.has_limits || b.delegate_depth.is_some() || b.write_needs_human_cause.is_some())
    {
        return err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "limits·delegateDepth·writeNeedsHumanCause 는 api.call 전용이다",
        );
    }
    if cap == "member.reset_password" {
        return err(
            StatusCode::BAD_REQUEST,
            "not_grantable",
            "member.reset_password 는 owner·admin 역할로만 갖는다",
        );
    }
    if cap == "api.call" {
        return crate::proxy::forward(
            State(st.up.clone()),
            ConnectInfo(peer),
            Request::from_parts(parts, axum::body::Body::from(bytes)),
        )
        .await;
    }
    let mut scope = b.scope.clone();
    let allow = b.allow_agent_cause;
    if cap == "repo.merge" || cap == "repo.read" {
        if cap == "repo.read" && allow.is_some() {
            return err(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "allowAgentCause 는 repo.merge 전용이다",
            );
        }
        match check_merge(&st.write, &me, &id, &scope, cap).await {
            Ok(s) => scope = s,
            Err(r) => return r,
        }
    } else if cap == "tool.allow" {
        if let Err(r) = check_tool_allow(&st.write, &me, &auth, &id, &b).await {
            return r;
        }
    } else if cap == "secret.create" {
        if !scope.is_empty() || allow.is_some() {
            return err(
                StatusCode::BAD_REQUEST,
                "bad_scope",
                "secret.create 의 scope 는 빈 값 하나다",
            );
        }
        if let Err(r) = check_secret_owner(&st.write, &me, &id, "secret.create").await {
            return r;
        }
    } else {
        if !me.is_admin {
            return err(StatusCode::FORBIDDEN, "forbidden", "grant 는 admin 만 준다");
        }
        if scope.starts_with("repo:")
            || scope.starts_with("connector:")
            || scope.starts_with("tool:")
            || allow.is_some()
        {
            return err(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "repo: scope 는 repo.merge·repo.read 전용, allowAgentCause 는 repo.merge 전용이다",
            );
        }
    }
    match sqlx::query_scalar::<_, i32>("select 1 from account where id = $1::uuid")
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return err(StatusCode::NOT_FOUND, "not_found", "그런 계정이 없다"),
        Err(e) => return internal(e),
    }
    type Before = (
        Option<String>,
        Option<Value>,
        bool,
        i32,
        bool,
        bool,
        String,
        Option<String>,
    );
    let before: Option<Before> = match sqlx::query_as(
        "select to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), limits, \
                write_needs_human_cause, delegate_depth, allow_agent_cause, suspended_at is not null, \
                granted_by::text, parent_grant_id::text \
           from account_grant where account_id = $1::uuid and capability = $2 and scope = $3",
    )
    .bind(&id)
    .bind(cap)
    .bind(&scope)
    .fetch_optional(&st.write)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let expires: Option<String> = b.expires_at.clone().flatten();
    let allow_v = allow.unwrap_or(false);
    if let Err(e) = sqlx::query(
        "insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause, limits, delegate_depth, write_needs_human_cause) \
         values ($1::uuid, $2, $3, $4::uuid, $5::timestamptz, $6, null, 0, false) \
         on conflict (account_id, capability, scope) do update \
           set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, \
               allow_agent_cause = excluded.allow_agent_cause, limits = excluded.limits, \
               delegate_depth = excluded.delegate_depth, parent_grant_id = null, \
               write_needs_human_cause = excluded.write_needs_human_cause, \
               suspended_at = null, suspend_reason = null",
    )
    .bind(&id)
    .bind(cap)
    .bind(&scope)
    .bind(&me.id)
    .bind(&expires)
    .bind(allow_v)
    .execute(&st.write)
    .await
    {
        return internal(e);
    }
    let mut detail = Map::new();
    if let Some((b_exp, b_lim, b_wnh, b_dd, b_aac, b_susp, b_by, b_parent)) = &before {
        let mut changed = Map::new();
        let after_exp = expires.as_deref().and_then(iso);
        if *b_exp != after_exp {
            changed.insert("expiresAt".into(), json!([b_exp, after_exp]));
        }
        let b_lim = b_lim.clone().unwrap_or(Value::Null);
        if b_lim != Value::Null {
            changed.insert("limits".into(), json!([b_lim, Value::Null]));
        }
        if *b_wnh {
            changed.insert("writeNeedsHumanCause".into(), json!([true, false]));
        }
        if *b_dd != 0 {
            changed.insert("delegateDepth".into(), json!([b_dd, 0]));
        }
        if *b_aac != allow_v {
            changed.insert("allowAgentCause".into(), json!([b_aac, allow_v]));
        }
        if *b_susp {
            changed.insert("suspended".into(), json!([true, false]));
        }
        if *b_by != me.id {
            changed.insert("grantedBy".into(), json!([b_by, me.id]));
        }
        if b_parent.is_some() {
            changed.insert("parentGrantId".into(), json!([b_parent, Value::Null]));
        }
        detail.insert("changed".into(), Value::Object(changed));
    }
    detail.insert("capability".into(), json!(cap));
    detail.insert("scope".into(), json!(scope));
    detail.insert("expiresAt".into(), json!(expires));
    if cap == "repo.merge" {
        detail.insert("allowAgentCause".into(), json!(allow_v));
    }
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: if before.is_some() {
                "grant.updated"
            } else {
                "grant.given"
            },
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: Value::Object(detail),
        },
    )
    .await;
    let ev = json!({ "type": "grant.changed", "accountId": id, "audience": "all" });
    match st.write.acquire().await {
        Ok(mut conn) => {
            if let Err(e) = emit_event(&mut conn, &ev).await {
                eprintln!(
                    "front: grant.changed event failed: {}",
                    e.as_database_error().map_or("io", |_| "db")
                );
            }
        }
        Err(e) => eprintln!(
            "front: grant.changed event failed: {}",
            e.as_database_error().map_or("io", |_| "db")
        ),
    }
    match sqlx::query_scalar::<_, String>(crate::core::account_grants_read::GRANTS_SQL)
        .bind(&id)
        .fetch_one(&st.write)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"grants\":{rows}}}")),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: AccountGrantGiveState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AccountGrantGiveState>>::new()
        .put("/accounts/{id}/grants", put_grants)
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

    const U: &str = "0b5c6f1e-1d2a-4c3b-8e9f-0a1b2c3d4e5f";

    #[test]
    fn scope_regex() {
        assert!(scope_ok(""));
        assert!(scope_ok(&format!("channel:{U}")));
        assert!(!scope_ok(&format!("channel:{}", U.to_uppercase())));
        assert!(scope_ok("repo:a/b"));
        assert!(!scope_ok("repo:a b/c"));
        assert!(!scope_ok("repo:ab"));
        assert!(scope_ok(&format!("tool:{U}:Bash(git status)")));
        assert!(!scope_ok(&format!("tool:{U}:")));
        assert!(!scope_ok("global"));
    }

    #[test]
    fn body_shape() {
        let ok = parse_body(&Body::Json(
            json!({"capability": "repo.merge", "scope": "repo:a/b"}),
        ))
        .unwrap();
        assert_eq!(ok.scope, "repo:a/b");
        assert_eq!(ok.expires_at, None);
        assert!(parse_body(&Body::Json(json!({"capability": "nope"}))).is_none());
        assert!(parse_body(&Body::None).is_none());
        let e = parse_body(&Body::Json(
            json!({"capability": "repo.merge", "expiresAt": null}),
        ))
        .unwrap();
        assert_eq!(e.expires_at, Some(None));
        assert!(
            parse_body(&Body::Json(
                json!({"capability": "repo.merge", "expiresAt": "2026-01-01T00:00:00+09:00"})
            ))
            .is_none()
        );
        assert!(
            parse_body(&Body::Json(
                json!({"capability": "repo.merge", "expiresAt": "2026-01-01T00:00:00Z"})
            ))
            .is_some()
        );
        assert!(
            parse_body(&Body::Json(
                json!({"capability": "api.call", "delegateDepth": 3})
            ))
            .is_none()
        );
        assert!(
            parse_body(&Body::Json(
                json!({"capability": "api.call", "delegateDepth": 1.5})
            ))
            .is_none()
        );
        assert_eq!(
            parse_body(&Body::Json(
                json!({"capability": "api.call", "delegateDepth": 2})
            ))
            .unwrap()
            .delegate_depth,
            Some(2)
        );
        assert!(parse_body(&Body::Text("x".into())).is_none());
    }

    #[test]
    fn tool_allow_expiry_parse() {
        assert_eq!(expires_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(expires_ms("1970-01-01T09:00:01+09:00"), Some(1000));
        assert!(now_ms() > 0);
        assert!(TOOL_RULE_EXPIRY_CAPPED_WARNINGS.contains(&"runs_arbitrary"));
        assert!(!TOOL_RULE_EXPIRY_CAPPED_WARNINGS.contains(&"short_prefix"));
    }

    #[test]
    fn merges_with_read_and_revoke_paths() {
        // GET·PUT 이 같은 경로에 따로 붙어도 axum 이 합친다.
        let a: axum::Router =
            axum::Router::new().route("/accounts/{id}/grants", axum::routing::get(|| async { "" }));
        let b: axum::Router =
            axum::Router::new().route("/accounts/{id}/grants", axum::routing::put(|| async { "" }));
        let _ = a.merge(b);
    }
}
