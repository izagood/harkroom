//! S5.4 — 에이전트 만들기 앞단. TS `routes/accountRoutes.ts` 의 `POST /accounts/agents` 를 옮기는 첫 조각.
//!
//! - 지금 Rust 가 하는 것: `requireCap('agent.create')` — 계정 없음 401 `unauthorized`, 능력 없음 403
//!   `forbidden` `agent.create 권한이 필요하다`. TS 도 preHandler 에서 같은 판정을 먼저 한다.
//! - 본문 zod(`handle`·`displayName`·`configFields`)를 Rust 가 판정한다 — 어긋나면 400 `invalid_request`.
//!   JSON 객체가 아닌 본문(없음·text)은 판정 전부를 TS 로 넘긴다(fastify 파서 순서까지 맞추지 않는다).
//! - `validateScopeChange(null, …)` 도 Rust 가 한다 — 400 `{error:{code:'scope_invariant', message}}`.
//! - 통과하면 요청을 그대로 TS 로 넘긴다(`createAgentAccount`·감사 `agent.created`·201). 여기까지는 부작용이 없어
//!   TS 가 다시 판정해도 결과가 같다.
//! - 남은 일: 이름 겹침 409·생성 트랜잭션(`withDefaults`·`upsertConfig`)·`getAgent` 응답 모양을 옮긴다.
use crate::auth::Auth;
use crate::directory::json_err;
use crate::proxy::Upstream;
use crate::write::Body;
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 능력 판정(`can`)이 읽는 것 — 읽기 풀이면 된다. 쓰기는 아직 TS 가 한다.
pub const AGENT_CREATE_PRIVILEGES: &[(&str, &str)] = &[];

pub struct AgentCreateState {
    pub pool: PgPool,
    pub up: Upstream,
}

/// `POST /accounts/agents`.
pub async fn post(
    State(st): State<Arc<AgentCreateState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let auth = req.extensions().get::<Auth>().cloned().unwrap_or_default();
    if let Err(r) = crate::perm::require_cap(&st.pool, &auth, "agent.create", None).await {
        return r;
    }
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
            Ok(()) => {}
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

pub fn routes(
    st: AgentCreateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentCreateState>>::new()
        .post("/accounts/agents", post)
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
