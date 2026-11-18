//! S5.4 — 에이전트 만들기 앞단. TS `routes/accountRoutes.ts` 의 `POST /accounts/agents` 를 옮기는 첫 조각.
//!
//! - 지금 Rust 가 하는 것: `requireCap('agent.create')` — 계정 없음 401 `unauthorized`, 능력 없음 403
//!   `forbidden` `agent.create 권한이 필요하다`. TS 도 preHandler 에서 같은 판정을 먼저 한다.
//! - 본문 zod(`handle`·`displayName`·`configFields`)를 Rust 가 판정한다 — 어긋나면 400 `invalid_request`.
//!   JSON 객체가 아닌 본문(없음·text)은 판정 전부를 TS 로 넘긴다(fastify 파서 순서까지 맞추지 않는다).
//! - `validateScopeChange(null, …)` 도 Rust 가 한다 — 400 `{error:{code:'scope_invariant', message}}`.
//! - 통과하면 쓰기 풀에 [`AGENT_CREATE_PRIVILEGES`] 가 다 있을 때 생성까지 Rust 가 한다: 집합·계정 이름 겹침 409
//!   `handle_taken` → `insert account` → `withDefaults`+`upsertConfig`(owner 는 호출자) → `getAgent` 뷰 →
//!   감사 `agent.created {handle}` → 201. 권한이 모자라면 TS 로 넘긴다(판정까지는 부작용이 없다).
use crate::auth::Auth;
use crate::directory::json_err;
use crate::proxy::Upstream;
use crate::write::Body;
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 생성 트랜잭션·뷰·감사가 쓰기 풀에 바라는 권한. 없으면 `main.rs` 가 `write` 를 비워 성공 길은 TS 로 넘긴다.
pub const AGENT_CREATE_PRIVILEGES: &[(&str, &str)] = &[
    ("handle_group.handle", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.id", "SELECT"),
    ("account.handle", "INSERT"),
    ("account.display_name", "INSERT"),
    ("account.kind", "INSERT"),
    ("agent_defaults.id", "SELECT"),
    ("agent_defaults.harness", "SELECT"),
    ("agent_defaults.model", "SELECT"),
    ("agent_defaults.effort", "SELECT"),
    ("agent_config.account_id", "INSERT"),
    ("agent_config.instructions", "INSERT"),
    ("agent_config.harness", "INSERT"),
    ("agent_config.model", "INSERT"),
    ("agent_config.effort", "INSERT"),
    ("agent_config.working_dir", "INSERT"),
    ("agent_config.mention_permission", "INSERT"),
    ("agent_config.owner_account_id", "INSERT"),
    ("agent_config.invoke_scope", "INSERT"),
    ("agent_config.credential_scope", "INSERT"),
    // `getAgent` 뷰(`operator_stop::agent_view`).
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_runner_version", "SELECT"),
    ("agent_assignment", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("agent_owner_delegate", "SELECT"),
    ("agent_mcp_server", "SELECT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

/// `PATCH /accounts/agents/{id}` 의 Rust 성공 길(설정·스위치 칸만)이 쓰기 풀에 바라는 권한.
/// 없으면 `main.rs` 가 `patch_write` 를 비워 성공 길은 TS 로 넘긴다(오늘과 같다).
/// PATCH 본문에 `handle` 이 있을 때 더 필요한 권한 — 이름공간 판정·UPDATE·`account.handle_changed` 이벤트.
pub const AGENT_RENAME_PRIVILEGES: &[(&str, &str)] = &[
    ("account.handle", "SELECT"),
    ("handle_group.handle", "SELECT"),
    ("account.handle", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const AGENT_RENAME_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

pub const AGENT_PATCH_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.display_name", "UPDATE"),
    // `upsertConfig` — insert 칸 전부 + on conflict update 칸 전부.
    ("agent_config.account_id", "INSERT"),
    ("agent_config.instructions", "INSERT"),
    ("agent_config.harness", "INSERT"),
    ("agent_config.model", "INSERT"),
    ("agent_config.effort", "INSERT"),
    ("agent_config.working_dir", "INSERT"),
    ("agent_config.mention_permission", "INSERT"),
    ("agent_config.owner_account_id", "INSERT"),
    ("agent_config.invoke_scope", "INSERT"),
    ("agent_config.credential_scope", "INSERT"),
    ("agent_config.instructions", "UPDATE"),
    ("agent_config.harness", "UPDATE"),
    ("agent_config.model", "UPDATE"),
    ("agent_config.effort", "UPDATE"),
    ("agent_config.working_dir", "UPDATE"),
    ("agent_config.mention_permission", "UPDATE"),
    ("agent_config.owner_account_id", "UPDATE"),
    ("agent_config.invoke_scope", "UPDATE"),
    ("agent_config.credential_scope", "UPDATE"),
    ("agent_config.updated_at", "UPDATE"),
    // `setTrustSiblings`·`setRequiresMacos`·`setChromeEnabled`·`setUserDecide` upsert.
    ("agent_config.trust_siblings", "INSERT"),
    ("agent_config.trust_siblings", "UPDATE"),
    ("agent_config.requires_macos", "INSERT"),
    ("agent_config.requires_macos", "UPDATE"),
    ("agent_config.chrome_enabled", "INSERT"),
    ("agent_config.chrome_enabled", "UPDATE"),
    ("agent_config.user_decide", "INSERT"),
    ("agent_config.user_decide", "UPDATE"),
    // `getAgent` 뷰(`operator_stop::agent_view`) — before·after.
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_runner_version", "SELECT"),
    ("agent_assignment", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("agent_owner_delegate", "SELECT"),
    ("agent_mcp_server", "SELECT"),
    // `validateMcpServers`·`setAgentMcpServers`.
    ("mcp_server.name", "SELECT"),
    ("mcp_server.credential_kind", "SELECT"),
    ("agent_mcp_server", "DELETE"),
    ("agent_mcp_server.agent_id", "INSERT"),
    ("agent_mcp_server.name", "INSERT"),
    // `suspendSecretGrants(…, 'definition_changed')` + 이미 정지된 grant 확인.
    ("secret_grant.agent_id", "SELECT"),
    ("secret_grant.suspended_at", "SELECT"),
    ("secret_grant.suspended_at", "UPDATE"),
    ("secret_grant.suspend_reason", "UPDATE"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

/// TS `definitionChanged` — 비밀 grant 를 세우는 정의 칸(순서 같다). MCP 목록은 이름순으로 이어 붙여 비교한다.
fn definition_changed(before: &Value, after: &Value) -> Vec<&'static str> {
    let mcp = |v: &Value| {
        let mut l: Vec<String> = v
            .get("mcpServers")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|x| x.as_str().unwrap_or_default().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        l.sort();
        l.join("\n")
    };
    let mut out = Vec::new();
    for k in ["instructions", "harness", "ownerAccountId", "workingDir"] {
        if before.get(k) != after.get(k) {
            out.push(k);
        }
    }
    if mcp(before) != mcp(after) {
        out.push("mcpServers");
    }
    out
}

pub struct AgentCreateState {
    pub pool: PgPool,
    pub up: Upstream,
    /// 권한이 다 있을 때만 — 그러면 생성까지 Rust 가 한다.
    pub write: Option<PgPool>,
    /// [`AGENT_PATCH_PRIVILEGES`] 가 다 있을 때만 — 그러면 PATCH 성공 길(설정·스위치 칸만)을 Rust 가 한다.
    pub patch_write: Option<PgPool>,
    /// 이름 바꾸기(`handle`)까지 Rust 가 할 수 있나 — [`AGENT_RENAME_PRIVILEGES`] 가 다 있을 때만. 아니면 TS.
    pub patch_rename: bool,
    pub trust: Arc<crate::trust_proxy::TrustProxy>,
}

enum Created {
    Taken(&'static str),
    Id(String),
}

/// `createAgentAccount` 의 트랜잭션(뷰 읽기 앞까지).
async fn create_agent_account(
    pool: &PgPool,
    m: &Map<String, Value>,
    owner_id: &str,
) -> Result<Created, sqlx::Error> {
    let handle = m.get("handle").and_then(Value::as_str).unwrap_or_default();
    let display = m
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut tx = pool.begin().await?;
    let group: Option<i32> =
        sqlx::query_scalar("select 1 from handle_group where lower(handle) = lower($1)")
            .bind(handle)
            .fetch_optional(&mut *tx)
            .await?;
    if group.is_some() {
        return Ok(Created::Taken("a group with this handle already exists"));
    }
    let taken: Option<i32> =
        sqlx::query_scalar("select 1 from account where lower(handle) = lower($1)")
            .bind(handle)
            .fetch_optional(&mut *tx)
            .await?;
    if taken.is_some() {
        return Ok(Created::Taken("this handle is already taken"));
    }
    let id: String = match sqlx::query_scalar(
        "insert into account (handle, display_name, kind) values ($1, $2, 'agent') returning id::text",
    )
    .bind(handle)
    .bind(display)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(id) => id,
        Err(e) if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505") => {
            return Ok(Created::Taken("this handle is already taken"));
        }
        Err(e) => return Err(e),
    };
    // `withDefaults` — 키가 있으면(null 이라도) 그 값, 없으면 전역 기본값.
    let (dh, dm, de): (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as("select harness, model, effort from agent_defaults where id = true")
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or((None, None, None));
    let pick = |k: &str, d: Option<String>| match m.get(k) {
        Some(v) => v.as_str().map(str::to_owned),
        None => d,
    };
    let s = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
    sqlx::query(
        "insert into agent_config (account_id, instructions, harness, model, effort, working_dir, mention_permission, \
                                   owner_account_id, invoke_scope, credential_scope) \
         values ($1::uuid, coalesce($2, ''), coalesce($3, 'claude-code'), $4, $5, $6, coalesce($7, 'auto'), $8::uuid, \
                 coalesce($9, 'community'), coalesce($10, 'none'))",
    )
    .bind(&id)
    .bind(s("instructions"))
    .bind(pick("harness", dh))
    .bind(pick("model", dm))
    .bind(pick("effort", de))
    .bind(s("workingDir"))
    .bind(s("mentionPermission"))
    .bind(owner_id)
    .bind(s("invokeScope"))
    .bind(s("credentialScope"))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Created::Id(id))
}

async fn create_native(
    st: &AgentCreateState,
    write: &PgPool,
    parts: &axum::http::request::Parts,
    actor: &crate::auth::Account,
    m: &Map<String, Value>,
) -> Response {
    let id = match create_agent_account(write, m, &actor.id).await {
        Ok(Created::Id(id)) => id,
        Ok(Created::Taken(msg)) => return json_err(StatusCode::CONFLICT, "handle_taken", msg),
        Err(e) => return crate::directory::internal(e),
    };
    let view = match super::operator_stop::agent_view(write, &id).await {
        Ok(Some((v, _))) => v,
        Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent"),
        Err(e) => return crate::directory::internal(e),
    };
    let ip = crate::writes_settings::ip_of(parts, &st.trust);
    crate::write::record_audit(
        write,
        crate::write::AuditEntry {
            action: "agent.created",
            actor_id: Some(&actor.id),
            actor_handle: Some(&actor.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: serde_json::json!({ "handle": m.get("handle") }),
        },
    )
    .await;
    (
        StatusCode::CREATED,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        view,
    )
        .into_response()
}

/// `POST /accounts/agents`.
pub async fn post(
    State(st): State<Arc<AgentCreateState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let auth = req.extensions().get::<Auth>().cloned().unwrap_or_default();
    let actor = match crate::perm::require_cap(&st.pool, &auth, "agent.create", None).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let (parts, raw) = req.into_parts();
    let Ok(bytes) = to_bytes(raw, BODY_LIMIT).await else {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        );
    };
    if let Ok(Body::Json(Value::Object(m))) = crate::write::fastify_body(&parts.headers, &bytes) {
        match check_body(&m) {
            Err(Refusal::Zod(field)) => {
                // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    &format!("{field}: invalid"),
                );
            }
            Err(Refusal::Scope(code, message)) => {
                return json_err(StatusCode::BAD_REQUEST, code, message);
            }
            Ok(()) => {
                if let Some(w) = &st.write {
                    return create_native(&st, w, &parts, &actor, &m).await;
                }
            }
        }
    }
    let req = Request::from_parts(parts, axum::body::Body::from(bytes));
    crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await
}

const BODY_LIMIT: usize = 1024 * 1024;

/// shared `RUNNABLE_HARNESSES`·`MENTION_PERMISSIONS`·`INVOKE_SCOPES`·`CREDENTIAL_SCOPES`.
const HARNESSES: &[&str] = &["claude-code", "codex", "opencode", "kilo", "pi", "omp"];
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const MENTION_PERMISSIONS: &[&str] = &["auto", "readonly"];
const INVOKE_SCOPES: &[&str] = &["owner", "list", "channel", "community"];
const CREDENTIAL_SCOPES: &[&str] = &["personal", "community", "none"];

#[derive(Debug, PartialEq)]
enum Refusal {
    Zod(&'static str),
    Scope(&'static str, &'static str),
}

/// zod 문자열 길이는 UTF-16 단위다.
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 칸 하나: 없으면 통과, `null` 은 `nullable` 일 때만, 값은 `ok` 로 본다.
fn field(
    m: &Map<String, Value>,
    key: &'static str,
    nullable: bool,
    ok: impl Fn(&str) -> bool,
) -> Result<(), Refusal> {
    match m.get(key) {
        None => Ok(()),
        Some(Value::Null) if nullable => Ok(()),
        Some(Value::String(s)) if ok(s) => Ok(()),
        _ => Err(Refusal::Zod(key)),
    }
}

/// TS 본문 zod(모르는 칸은 버린다) + `validateScopeChange(null, {invokeScope ?? 'community', credentialScope ?? 'none'})`.
fn check_body(m: &Map<String, Value>) -> Result<(), Refusal> {
    match m.get("handle") {
        Some(Value::String(h)) if super::account_handle::is_handle(h) => {}
        _ => return Err(Refusal::Zod("handle")),
    }
    match m.get("displayName") {
        Some(Value::String(d)) if (1..=64).contains(&len16(d)) => {}
        _ => return Err(Refusal::Zod("displayName")),
    }
    field(m, "instructions", false, |s| len16(s) <= 8000)?;
    field(m, "harness", false, |s| HARNESSES.contains(&s))?;
    field(m, "model", true, |s| len16(s) <= 64)?;
    field(m, "effort", true, |s| EFFORTS.contains(&s))?;
    field(m, "workingDir", true, |s| len16(s) <= 512)?;
    field(m, "mentionPermission", false, |s| {
        MENTION_PERMISSIONS.contains(&s)
    })?;
    field(m, "ownerAccountId", true, crate::lists::is_zod_uuid)?;
    field(m, "invokeScope", false, |s| INVOKE_SCOPES.contains(&s))?;
    field(m, "credentialScope", false, |s| {
        CREDENTIAL_SCOPES.contains(&s)
    })?;
    let invoke = m
        .get("invokeScope")
        .and_then(Value::as_str)
        .unwrap_or("community");
    let cred = m
        .get("credentialScope")
        .and_then(Value::as_str)
        .unwrap_or("none");
    if cred == "personal" && invoke != "owner" {
        return Err(Refusal::Scope(
            "scope_invariant",
            "개인 자격증명(personal)을 쥔 에이전트는 소유자만 부를 수 있어야 한다(invokeScope=owner)",
        ));
    }
    Ok(())
}

/// TS PATCH 본문 zod — `handle`·`displayName`·`disabled` 는 선택, 나머지는 `configFields` 와 MCP·불리언 칸.
fn check_patch(m: &Map<String, Value>) -> Result<(), &'static str> {
    let z = |r: Result<(), Refusal>| match r {
        Err(Refusal::Zod(f)) => Err(f),
        _ => Ok(()),
    };
    z(field(m, "handle", false, super::account_handle::is_handle))?;
    z(field(m, "displayName", false, |d| {
        (1..=64).contains(&len16(d))
    }))?;
    z(field(m, "instructions", false, |s| len16(s) <= 8000))?;
    z(field(m, "harness", false, |s| HARNESSES.contains(&s)))?;
    z(field(m, "model", true, |s| len16(s) <= 64))?;
    z(field(m, "effort", true, |s| EFFORTS.contains(&s)))?;
    z(field(m, "workingDir", true, |s| len16(s) <= 512))?;
    z(field(m, "mentionPermission", false, |s| {
        MENTION_PERMISSIONS.contains(&s)
    }))?;
    z(field(m, "ownerAccountId", true, crate::lists::is_zod_uuid))?;
    z(field(m, "invokeScope", false, |s| {
        INVOKE_SCOPES.contains(&s)
    }))?;
    z(field(m, "credentialScope", false, |s| {
        CREDENTIAL_SCOPES.contains(&s)
    }))?;
    match m.get("mcpServers") {
        None => {}
        Some(Value::Array(a))
            if a.len() <= 32
                && a.iter().all(|v| {
                    v.as_str().is_some_and(|s| {
                        (1..=32).contains(&s.len())
                            && s.bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    })
                }) => {}
        _ => return Err("mcpServers"),
    }
    for k in [
        "disabled",
        "trustSiblings",
        "requiresMacos",
        "chromeEnabled",
        "userDecide",
    ] {
        if m.get(k).is_some_and(|v| !v.is_boolean()) {
            return Err(k);
        }
    }
    Ok(())
}

const ADMIN_ONLY_FIELDS: &[&str] = &["ownerAccountId", "disabled", "mentionPermission"];

/// 이 칸이 하나라도 있으면 PATCH 성공 길은 TS 로 넘긴다 — 이름 바꾸기(409·감사·WS 이벤트), 끄기(PAT 회수·
/// 감사·`agent_disabled` grant 정지)가 아직 Rust 에 없다. 이름 바꾸기·스코프·MCP 판정, 정의 변경 grant 정지는 Rust 가 한다.
const PATCH_TS_ONLY_FIELDS: &[&str] = &["disabled"];

/// TS `AUDITED_FIELDS` — 순서·종류가 같다.
const AUDITED_FIELDS: &[(&str, bool)] = &[
    ("mentionPermission", false),
    ("workingDir", false),
    ("ownerAccountId", false),
    ("harness", false),
    ("instructions", true),
    ("trustSiblings", false),
    ("chromeEnabled", false),
    ("userDecide", false),
];

/// TS `diffAudited(before, after)` — 값이 바뀐 감사 칸만. `changed` 칸은 원문을 남기지 않는다.
fn diff_audited(before: &Value, after: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, changed_only) in AUDITED_FIELDS {
        let prev = before.get(*k);
        let next = after.get(*k);
        if prev == next {
            continue;
        }
        let v = if *changed_only {
            serde_json::json!({ "changed": true })
        } else {
            let mut o = Map::new();
            if let Some(p) = prev {
                o.insert("before".into(), p.clone());
            }
            if let Some(n) = next {
                o.insert("after".into(), n.clone());
            }
            Value::Object(o)
        };
        out.insert((*k).to_owned(), v);
    }
    out
}

fn json_200(body: String) -> Response {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

/// PATCH 성공 길 — 설정·스위치 칸만(`PATCH_TS_ONLY_FIELDS` 가 없을 때). TS 핸들러의 순서를 그대로 따른다:
/// 비admin 소유 판정 → `getAgent`(404) → 스위치 upsert → `updateAgent`(displayName·`upsertConfig`) → `diffAudited` 감사.
async fn patch_native(
    st: &AgentCreateState,
    write: &PgPool,
    parts: &axum::http::request::Parts,
    me: &crate::auth::Account,
    id: &str,
    m: &Map<String, Value>,
) -> Response {
    use super::relay_routes::{Verdict, check_owner_or_admin};
    if !me.is_admin {
        match check_owner_or_admin(&st.pool, me, id).await {
            Ok(Verdict::Owner | Verdict::Admin) => {}
            Ok(Verdict::Refused(s, c, msg)) => return json_err(s, c, msg),
            Err(e) => return crate::directory::internal(e),
        }
    }
    let not_found = || json_err(StatusCode::NOT_FOUND, "not_found", "no such agent");
    let before = match super::operator_stop::agent_view(write, id).await {
        Ok(Some((v, _))) => v,
        Ok(None) => return not_found(),
        Err(e) => return crate::directory::internal(e),
    };
    let bv: Value = serde_json::from_str(&before).unwrap_or(Value::Null);
    let bs = |k: &str| {
        bv.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let ps = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
    // TS: 값이 실제로 바뀔 때만 이름공간(계정·집합)을 본다.
    let renamed_to = ps("handle").filter(|h| *h != bs("handle"));
    let mut display = ps("displayName");
    if let Some(h) = &renamed_to {
        let taken = sqlx::query_scalar::<_, i32>(
            "select 1 from account where lower(handle) = lower($1) and id != $2::uuid",
        )
        .bind(h)
        .bind(id)
        .fetch_optional(write)
        .await;
        match taken {
            Ok(Some(_)) => {
                return json_err(
                    StatusCode::CONFLICT,
                    "handle_taken",
                    "this handle is already taken",
                );
            }
            Ok(None) => {}
            Err(e) => return crate::directory::internal(e),
        }
        let group = sqlx::query_scalar::<_, i32>(
            "select 1 from handle_group where lower(handle) = lower($1)",
        )
        .bind(h)
        .fetch_optional(write)
        .await;
        match group {
            Ok(Some(_)) => {
                return json_err(
                    StatusCode::CONFLICT,
                    "handle_taken",
                    "a group with this handle already exists",
                );
            }
            Ok(None) => {}
            Err(e) => return crate::directory::internal(e),
        }
        // 표시 이름이 옛 이름 그대로였다면 따라간다. 명시적으로 보낸 displayName 이 이긴다.
        if !m.contains_key("displayName") && bs("displayName") == bs("handle") {
            display = Some(h.clone());
        }
    }
    if m.contains_key("invokeScope") || m.contains_key("credentialScope") {
        let invoke = ps("invokeScope").unwrap_or_else(|| bs("invokeScope"));
        let cred = ps("credentialScope").unwrap_or_else(|| bs("credentialScope"));
        if let Some((code, msg)) = validate_scope_change(&bs("invokeScope"), &invoke, &cred) {
            return json_err(StatusCode::BAD_REQUEST, code, msg);
        }
    }
    let names: Option<Vec<String>> = m.get("mcpServers").and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    });
    if names.is_some() || m.contains_key("credentialScope") {
        let list = names.clone().unwrap_or_else(|| {
            bv.get("mcpServers")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        });
        let cred = ps("credentialScope").unwrap_or_else(|| bs("credentialScope"));
        if !list.is_empty() {
            let rows: Vec<(String, String)> = match sqlx::query_as(
                "select name, credential_kind from mcp_server where name = any($1::text[])",
            )
            .bind(&list)
            .fetch_all(write)
            .await
            {
                Ok(r) => r,
                Err(e) => return crate::directory::internal(e),
            };
            let unknown: Vec<&str> = list
                .iter()
                .filter(|n| !rows.iter().any(|(r, _)| r == *n))
                .map(String::as_str)
                .collect();
            if !unknown.is_empty() {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "unknown_mcp_server",
                    &format!("레지스트리에 없는 MCP 이름: {}", unknown.join(", ")),
                );
            }
            if cred != "personal" && rows.iter().any(|(_, k)| k == "personal") {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "scope_invariant",
                    "personal 자격증명의 MCP 를 붙이려면 credentialScope 가 personal 이어야 한다",
                );
            }
        }
    }
    let r: Result<(), sqlx::Error> = async {
        if let Some(names) = &names {
            sqlx::query("delete from agent_mcp_server where agent_id = $1::uuid and not (name = any($2::text[]))")
                .bind(id)
                .bind(names)
                .execute(write)
                .await?;
            for n in names {
                sqlx::query("insert into agent_mcp_server (agent_id, name) values ($1::uuid, $2) on conflict do nothing")
                    .bind(id)
                    .bind(n)
                    .execute(write)
                    .await?;
            }
        }
        for (key, sql) in [
            (
                "trustSiblings",
                "insert into agent_config (account_id, trust_siblings) values ($1::uuid, $2) \
                 on conflict (account_id) do update set trust_siblings = excluded.trust_siblings, updated_at = now()",
            ),
            (
                "requiresMacos",
                "insert into agent_config (account_id, requires_macos) values ($1::uuid, $2) \
                 on conflict (account_id) do update set requires_macos = excluded.requires_macos, updated_at = now()",
            ),
            (
                "chromeEnabled",
                "insert into agent_config (account_id, chrome_enabled) values ($1::uuid, $2) \
                 on conflict (account_id) do update set chrome_enabled = excluded.chrome_enabled, updated_at = now()",
            ),
            (
                "userDecide",
                "insert into agent_config (account_id, user_decide) values ($1::uuid, $2) \
                 on conflict (account_id) do update set user_decide = excluded.user_decide, updated_at = now()",
            ),
        ] {
            if let Some(on) = m.get(key).and_then(Value::as_bool) {
                sqlx::query(sql).bind(id).bind(on).execute(write).await?;
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        return crate::directory::internal(e);
    }
    // `updateAgent` — 다시 본다(사이에 사라졌으면 404).
    match super::operator_stop::agent_view(write, id).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found(),
        Err(e) => return crate::directory::internal(e),
    }
    if let Some(h) = &renamed_to
        && let Err(e) = rename(write, id, h).await
    {
        return crate::directory::internal(e);
    }
    if let Some(d) = display.as_deref()
        && let Err(e) = sqlx::query("update account set display_name = $2 where id = $1::uuid")
            .bind(id)
            .bind(d)
            .execute(write)
            .await
    {
        return crate::directory::internal(e);
    }
    if let Err(e) = upsert_config(write, id, m).await {
        return crate::directory::internal(e);
    }
    let updated = match super::operator_stop::agent_view(write, id).await {
        Ok(Some((v, _))) => v,
        Ok(None) => return not_found(),
        Err(e) => return crate::directory::internal(e),
    };
    let b: Value = serde_json::from_str(&before).unwrap_or(Value::Null);
    let a: Value = serde_json::from_str(&updated).unwrap_or(Value::Null);
    let ip = crate::writes_settings::ip_of(parts, &st.trust);
    let defn = definition_changed(&b, &a);
    if !defn.is_empty() {
        let n = match sqlx::query(
            "update secret_grant set suspended_at = now(), suspend_reason = $2 where agent_id = $1::uuid and suspended_at is null",
        )
        .bind(id)
        .bind("definition_changed")
        .execute(write)
        .await
        {
            Ok(r) => r.rows_affected(),
            Err(e) => return crate::directory::internal(e),
        };
        let any = if n > 0 {
            true
        } else {
            match sqlx::query_scalar::<_, i32>(
                "select 1 from secret_grant where agent_id = $1::uuid and suspended_at is not null limit 1",
            )
            .bind(id)
            .fetch_optional(write)
            .await
            {
                Ok(r) => r.is_some(),
                Err(e) => return crate::directory::internal(e),
            }
        };
        if any {
            crate::write::record_audit(
                write,
                crate::write::AuditEntry {
                    action: "secret.grant.suspended",
                    actor_id: Some(&me.id),
                    actor_handle: Some(&me.handle),
                    target: Some(id),
                    ip: ip.as_deref(),
                    detail: serde_json::json!({ "reason": "definition_changed", "fields": defn, "suspended": n }),
                },
            )
            .await;
        }
    }
    let changes = diff_audited(&b, &a);
    if !changes.is_empty() {
        crate::write::record_audit(
            write,
            crate::write::AuditEntry {
                action: "agent.updated",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: Some(id),
                ip: ip.as_deref(),
                detail: Value::Object(changes),
            },
        )
        .await;
    }
    if let Some(h) = &renamed_to {
        crate::write::record_audit(
            write,
            crate::write::AuditEntry {
                action: "account.handle.changed",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: Some(id),
                ip: ip.as_deref(),
                detail: serde_json::json!({ "from": bs("handle"), "to": h }),
            },
        )
        .await;
    }
    json_200(updated)
}

/// 이름 UPDATE 와 `account.handle_changed` 이벤트(받는 사람 everyone, outbox)를 한 트랜잭션에 — `account_handle` 과 같다.
async fn rename(write: &PgPool, id: &str, handle: &str) -> Result<(), sqlx::Error> {
    let mut tx = write.begin().await?;
    sqlx::query("update account set handle = $1 where id = $2::uuid")
        .bind(handle)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::write::emit_event(
        &mut tx,
        &serde_json::json!({ "type": "account.handle_changed", "accountId": id, "newHandle": handle }),
    )
    .await?;
    tx.commit().await
}

/// TS `validateScopeChange(before, after)`.
fn validate_scope_change(
    before_invoke: &str,
    invoke: &str,
    cred: &str,
) -> Option<(&'static str, &'static str)> {
    if cred == "personal" && invoke != "owner" {
        return Some((
            "scope_invariant",
            "개인 자격증명(personal)을 쥔 에이전트는 소유자만 부를 수 있어야 한다(invokeScope=owner)",
        ));
    }
    if before_invoke == "owner" && invoke != "owner" {
        return Some((
            "scope_widening",
            "소유자 전용이던 에이전트는 넓힐 수 없다 — 넓히려면 새 에이전트를 만든다",
        ));
    }
    None
}

/// TS `upsertConfig` — 키 부재는 손대지 않음, `null` 은 기본값으로 되돌리기.
async fn upsert_config(pool: &PgPool, id: &str, m: &Map<String, Value>) -> Result<(), sqlx::Error> {
    let has = |k: &str| m.contains_key(k);
    let s = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
    sqlx::query(
        "insert into agent_config (account_id, instructions, harness, model, effort, working_dir, mention_permission, owner_account_id, \
                                   invoke_scope, credential_scope) \
         values ($1::uuid, coalesce($3, ''), coalesce($5, 'claude-code'), $6, $8, $10, coalesce($13, 'auto'), $15::uuid, \
                 coalesce($17, 'community'), coalesce($19, 'none')) \
         on conflict (account_id) do update set \
           instructions       = case when $2::bool  then excluded.instructions       else agent_config.instructions       end, \
           harness            = case when $4::bool  then excluded.harness            else agent_config.harness            end, \
           model              = case when $7::bool  then excluded.model              else agent_config.model              end, \
           effort             = case when $9::bool  then excluded.effort             else agent_config.effort             end, \
           working_dir        = case when $11::bool then excluded.working_dir        else agent_config.working_dir        end, \
           mention_permission = case when $12::bool then excluded.mention_permission else agent_config.mention_permission end, \
           owner_account_id   = case when $14::bool then excluded.owner_account_id   else agent_config.owner_account_id   end, \
           invoke_scope       = case when $16::bool then excluded.invoke_scope       else agent_config.invoke_scope       end, \
           credential_scope   = case when $18::bool then excluded.credential_scope   else agent_config.credential_scope   end, \
           updated_at = now()",
    )
    .bind(id)
    .bind(has("instructions"))
    .bind(s("instructions"))
    .bind(has("harness"))
    .bind(s("harness"))
    .bind(s("model"))
    .bind(has("model"))
    .bind(s("effort"))
    .bind(has("effort"))
    .bind(s("workingDir"))
    .bind(has("workingDir"))
    .bind(has("mentionPermission"))
    .bind(s("mentionPermission"))
    .bind(has("ownerAccountId"))
    .bind(s("ownerAccountId"))
    .bind(has("invokeScope"))
    .bind(s("invokeScope"))
    .bind(has("credentialScope"))
    .bind(s("credentialScope"))
    .execute(pool)
    .await?;
    Ok(())
}

/// `PATCH /accounts/agents/{id}` 앞단 — 경로·본문 zod(400)·Chrome 켜기 403·admin 전용 칸 403 을 Rust 가 판정하고
/// 비admin 의 `checkOwnerOrAdmin` 거절(404·403)도 Rust 가 한다. 나머지(쓰기·감사)는 TS 로 넘긴다. 여기까지는 부작용이 없다.
pub async fn patch(
    State(st): State<Arc<AgentCreateState>>,
    crate::auth::RequireAccount(me, auth): crate::auth::RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    axum::extract::Path(id): axum::extract::Path<String>,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    let Ok(bytes) = to_bytes(raw, BODY_LIMIT).await else {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        );
    };
    if let Ok(Body::Json(Value::Object(m))) = crate::write::fastify_body(&parts.headers, &bytes) {
        if !crate::lists::is_zod_uuid(&id) {
            return json_err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "params: invalid",
            );
        }
        if let Err(f) = check_patch(&m) {
            return json_err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                &format!("{f}: invalid"),
            );
        }
        if m.get("chromeEnabled") == Some(&Value::Bool(true))
            && !(me.kind == "human" && auth.via == Some(crate::auth::Via::Session))
        {
            return json_err(
                StatusCode::FORBIDDEN,
                "human_session_required",
                "only a signed-in human can enable Chrome control",
            );
        }
        if !me.is_admin && ADMIN_ONLY_FIELDS.iter().any(|f| m.contains_key(*f)) {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "admin required for this field",
            );
        }
        if let Some(w) = &st.patch_write
            && !PATCH_TS_ONLY_FIELDS.iter().any(|f| m.contains_key(*f))
            && (st.patch_rename || !m.contains_key("handle"))
        {
            return patch_native(&st, w, &parts, &me, &id, &m).await;
        }
    }
    let req = Request::from_parts(parts, axum::body::Body::from(bytes));
    crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await
}

pub fn routes(
    st: AgentCreateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentCreateState>>::new()
        .post("/accounts/agents", post)
        .patch("/accounts/agents/{id}", patch)
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

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn body_zod() {
        let ok = json!({ "handle": "bot-1", "displayName": "Bot", "extra": 1 });
        assert_eq!(check_body(&m(ok)), Ok(()));
        for (v, f) in [
            (json!({ "displayName": "B" }), "handle"),
            (json!({ "handle": "Bot", "displayName": "B" }), "handle"),
            (
                json!({ "handle": "deleted-x", "displayName": "B" }),
                "handle",
            ),
            (json!({ "handle": "bot", "displayName": "" }), "displayName"),
            (
                json!({ "handle": "bot", "displayName": "B", "harness": null }),
                "harness",
            ),
            (
                json!({ "handle": "bot", "displayName": "B", "harness": "x" }),
                "harness",
            ),
            (
                json!({ "handle": "bot", "displayName": "B", "effort": "huge" }),
                "effort",
            ),
            (
                json!({ "handle": "bot", "displayName": "B", "ownerAccountId": "nope" }),
                "ownerAccountId",
            ),
            (
                json!({ "handle": "bot", "displayName": "B", "model": "m".repeat(65) }),
                "model",
            ),
        ] {
            assert_eq!(check_body(&m(v)), Err(Refusal::Zod(f)));
        }
        let nulls = json!({ "handle": "bot", "displayName": "B", "model": null, "effort": null,
            "workingDir": null, "ownerAccountId": null });
        assert_eq!(check_body(&m(nulls)), Ok(()));
    }

    #[test]
    fn patch_privileges_cover_view_and_audit() {
        for p in super::super::agent_config_read::AGENT_CONFIG_PRIVILEGES {
            if p.1 == "SELECT" {
                assert!(AGENT_PATCH_PRIVILEGES.contains(p), "{p:?}");
            }
        }
        for c in [
            "trust_siblings",
            "requires_macos",
            "chrome_enabled",
            "user_decide",
        ] {
            let col = format!("agent_config.{c}");
            for verb in ["INSERT", "UPDATE"] {
                assert!(
                    AGENT_PATCH_PRIVILEGES
                        .iter()
                        .any(|(t, v)| *t == col && *v == verb),
                    "{col} {verb}"
                );
            }
        }
        assert!(AGENT_PATCH_PRIVILEGES.contains(&("account.display_name", "UPDATE")));
        assert!(AGENT_PATCH_PRIVILEGES.contains(&("audit_log.detail", "INSERT")));
    }

    #[test]
    fn diff_audited_matches_ts() {
        let before = json!({ "mentionPermission": "auto", "trustSiblings": true, "chromeEnabled": false,
            "userDecide": true, "instructions": "a", "harness": "codex", "workingDir": null, "ownerAccountId": null });
        let mut after = before.clone();
        assert!(diff_audited(&before, &after).is_empty());
        after["chromeEnabled"] = json!(true);
        after["instructions"] = json!("b");
        let d = diff_audited(&before, &after);
        assert_eq!(
            Value::Object(d),
            json!({ "instructions": { "changed": true }, "chromeEnabled": { "before": false, "after": true } })
        );
    }

    #[test]
    fn patch_ts_only_fields_cover_admin_only_and_rename() {
        assert_eq!(
            validate_scope_change("owner", "list", "none").unwrap().0,
            "scope_widening"
        );
        assert_eq!(
            validate_scope_change("list", "list", "personal").unwrap().0,
            "scope_invariant"
        );
        assert!(validate_scope_change("owner", "owner", "personal").is_none());
        assert_eq!(
            definition_changed(
                &json!({ "harness": "a", "mcpServers": ["x", "y"] }),
                &json!({ "harness": "b", "mcpServers": ["y", "x"] })
            ),
            vec!["harness"]
        );
        assert!(PATCH_TS_ONLY_FIELDS.contains(&"disabled"));
        assert!(!PATCH_TS_ONLY_FIELDS.contains(&"handle"));
        for p in [
            ("account.handle", "UPDATE"),
            ("handle_group.handle", "SELECT"),
            ("event_outbox", "INSERT"),
        ] {
            assert!(AGENT_RENAME_PRIVILEGES.contains(&p), "{p:?}");
        }
        assert!(AGENT_RENAME_SEQUENCE_PRIVILEGES.contains(&("event_outbox_id_seq", "USAGE")));
    }

    #[test]
    fn privileges_cover_view() {
        for p in super::super::agent_config_read::AGENT_CONFIG_PRIVILEGES {
            if p.1 == "SELECT" {
                assert!(AGENT_CREATE_PRIVILEGES.contains(p), "{p:?}");
            }
        }
        assert!(AGENT_CREATE_PRIVILEGES.contains(&("audit_log.detail", "INSERT")));
    }

    #[test]
    fn patch_zod() {
        assert_eq!(check_patch(&m(json!({}))), Ok(()));
        assert_eq!(check_patch(&m(json!({ "disabled": "x" }))), Err("disabled"));
        assert_eq!(
            check_patch(&m(json!({ "mcpServers": ["A"] }))),
            Err("mcpServers")
        );
        assert_eq!(
            check_patch(&m(json!({ "mcpServers": ["gh-1"], "trustSiblings": true }))),
            Ok(())
        );
        assert_eq!(check_patch(&m(json!({ "handle": "X" }))), Err("handle"));
    }

    #[test]
    fn body_scope() {
        let bad = json!({ "handle": "bot", "displayName": "B", "credentialScope": "personal" });
        assert!(matches!(
            check_body(&m(bad)),
            Err(Refusal::Scope("scope_invariant", _))
        ));
        let ok = json!({ "handle": "bot", "displayName": "B", "credentialScope": "personal", "invokeScope": "owner" });
        assert_eq!(check_body(&m(ok)), Ok(()));
    }
}
