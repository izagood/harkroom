//! 실행 조합 관리 HTTP 길(J2a) — [`super::exec_combo`] 의 읽기·쓰기를 그대로 내놓는다. 화면은 아직 없다.
//!
//! | 줄 | 누가 |
//! |---|---|
//! | `GET /exec/combos` | 사람 |
//! | `POST /exec/combos` · `PUT`·`DELETE /exec/combos/{id}` | 소유자·관리자인 사람 |
//! | `GET`·`POST /exec/key-links` · `PUT`·`DELETE /exec/key-links/{id}` | 소유자·관리자인 사람(그 비밀의 소유자) |
//! | `GET /exec/agents/{agentId}/combos` | 사람 |
//! | `PUT`·`DELETE /exec/agents/{agentId}/combos/{comboId}` · `PUT …/default` | 그 에이전트의 소유자인 사람 |
//!
//! - **판정은 전부 [`super::exec_combo`] 가 한다** — 이 파일은 요청을 풀고 답을 싸기만 한다. 에이전트 계정·오퍼레이터 토큰은
//!   읽기도 403 이다. MCP 도구로는 내놓지 않는다.
//! - 키 연결은 비밀을 **id 로** 받는다(`secretId`). 비밀 값은 읽지도 내보내지도 않는다.
//! - 쓰기는 감사 로그에 남긴다(`exec.*`). 감사 기록이 실패해도 답은 바꾸지 않는다.
//! - 권한이 없으면 `main.rs` 가 이 길을 붙이지 않는다 — 그때는 404 다(나머지 서버는 그대로 돈다).
use super::exec_combo::{self as ec, ComboError, ComboInput, KeyLinkInput};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct ExecComboState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

type St = State<Arc<ExecComboState>>;

/// 오류 → 상태·코드. 권한 없음과 「남의 것」은 같은 403 이다(대상이 있는지 알려 주지 않는다).
pub fn status_of(e: &ComboError) -> (StatusCode, &'static str) {
    match e {
        ComboError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
        ComboError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
        ComboError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
        ComboError::Conflict => (StatusCode::CONFLICT, "conflict"),
        ComboError::Db(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    }
}

pub(crate) fn fail(e: ComboError) -> Response {
    let (status, code) = status_of(&e);
    match e {
        ComboError::Db(e) => internal(e),
        ComboError::Invalid(field) => json_err(status, code, &format!("{field}: invalid")),
        ComboError::Forbidden => json_err(status, code, "not allowed"),
        ComboError::NotFound => json_err(status, code, "no such item"),
        ComboError::Conflict => json_err(status, code, "name taken or still in use"),
    }
}

pub(crate) fn json_ok(status: StatusCode, v: Value) -> Response {
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        v.to_string(),
    )
        .into_response()
}

pub(crate) fn body_json(raw: &Bytes) -> Result<Value, ComboError> {
    match serde_json::from_slice::<Value>(raw) {
        Ok(v) if v.is_object() => Ok(v),
        _ => Err(ComboError::Invalid("body")),
    }
}

pub(crate) async fn audit(
    st: &ExecComboState,
    parts: &Parts,
    me: &crate::auth::Account,
    action: &str,
    target: &str,
    detail: Value,
) {
    let ip = crate::writes_settings::ip_of(parts, &st.trust);
    record_audit(
        &st.write,
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

// ── 조합 ──────────────────────────────────────────────────────────────

pub async fn list_combos(State(st): St, RequireAccount(me, auth): RequireAccount) -> Response {
    match ec::list_combos(&st.write, &me, &auth).await {
        Ok(v) => json_ok(StatusCode::OK, json!({ "combos": v })),
        Err(e) => fail(e),
    }
}

pub async fn create_combo(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    parts: Parts,
    raw: Bytes,
) -> Response {
    // 권한을 본문보다 먼저 본다 — 못 쓰는 계정에게 본문 오류를 알려 주지 않는다.
    if !ec::can_manage(&me, &auth) {
        return fail(ComboError::Forbidden);
    }
    let input = match body_json(&raw).and_then(|b| ComboInput::parse(&b)) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    match ec::create_combo(&st.write, &me, &auth, &input).await {
        Ok(id) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.combo.created",
                &id,
                json!({ "name": input.name }),
            )
            .await;
            json_ok(StatusCode::CREATED, json!({ "id": id }))
        }
        Err(e) => fail(e),
    }
}

pub async fn update_combo(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    parts: Parts,
    raw: Bytes,
) -> Response {
    if !ec::can_manage(&me, &auth) {
        return fail(ComboError::Forbidden);
    }
    let input = match body_json(&raw).and_then(|b| ComboInput::parse(&b)) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    match ec::update_combo(&st.write, &me, &auth, &id, &input).await {
        Ok(()) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.combo.updated",
                &id,
                json!({ "name": input.name }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn delete_combo(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    parts: Parts,
) -> Response {
    match ec::delete_combo(&st.write, &me, &auth, &id).await {
        Ok(()) => {
            audit(&st, &parts, &me, "exec.combo.deleted", &id, json!({})).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

// ── 키 연결 ───────────────────────────────────────────────────────────

pub async fn list_key_links(State(st): St, RequireAccount(me, auth): RequireAccount) -> Response {
    match ec::list_key_links(&st.write, &me, &auth).await {
        Ok(v) => json_ok(StatusCode::OK, json!({ "keyLinks": v })),
        Err(e) => fail(e),
    }
}

pub async fn create_key_link(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    parts: Parts,
    raw: Bytes,
) -> Response {
    if !ec::can_manage(&me, &auth) {
        return fail(ComboError::Forbidden);
    }
    let input = match body_json(&raw).and_then(|b| KeyLinkInput::parse(&b)) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    match ec::create_key_link(&st.write, &me, &auth, &input).await {
        Ok(id) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.key_link.created",
                &id,
                json!({ "name": input.name, "secretId": input.secret_id }),
            )
            .await;
            json_ok(StatusCode::CREATED, json!({ "id": id }))
        }
        Err(e) => fail(e),
    }
}

pub async fn update_key_link(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    parts: Parts,
    raw: Bytes,
) -> Response {
    if !ec::can_manage(&me, &auth) {
        return fail(ComboError::Forbidden);
    }
    let input = match body_json(&raw).and_then(|b| KeyLinkInput::parse(&b)) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    match ec::update_key_link(&st.write, &me, &auth, &id, &input).await {
        Ok(()) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.key_link.updated",
                &id,
                json!({ "name": input.name, "secretId": input.secret_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn delete_key_link(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    parts: Parts,
) -> Response {
    match ec::delete_key_link(&st.write, &me, &auth, &id).await {
        Ok(()) => {
            audit(&st, &parts, &me, "exec.key_link.deleted", &id, json!({})).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

// ── 에이전트 허용 목록 ────────────────────────────────────────────────

pub async fn list_allowed(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path(agent_id): Path<String>,
) -> Response {
    match ec::list_allowed(&st.write, &me, &auth, &agent_id).await {
        Ok(v) => json_ok(StatusCode::OK, json!({ "combos": v })),
        Err(e) => fail(e),
    }
}

pub async fn allow_add(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path((agent_id, combo_id)): Path<(String, String)>,
    parts: Parts,
) -> Response {
    match ec::allow_add(&st.write, &me, &auth, &agent_id, &combo_id).await {
        Ok(()) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.allow.added",
                &agent_id,
                json!({ "comboId": combo_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn allow_remove(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path((agent_id, combo_id)): Path<(String, String)>,
    parts: Parts,
) -> Response {
    match ec::allow_remove(&st.write, &me, &auth, &agent_id, &combo_id).await {
        Ok(()) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.allow.removed",
                &agent_id,
                json!({ "comboId": combo_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn set_default(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path((agent_id, combo_id)): Path<(String, String)>,
    parts: Parts,
) -> Response {
    match ec::set_default(&st.write, &me, &auth, &agent_id, &combo_id).await {
        Ok(()) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.allow.default_set",
                &agent_id,
                json!({ "comboId": combo_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

pub fn routes(
    st: ExecComboState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ExecComboState>>::new()
        .get("/exec/combos", list_combos)
        .post("/exec/combos", create_combo)
        .put("/exec/combos/{id}", update_combo)
        .delete("/exec/combos/{id}", delete_combo)
        .get("/exec/key-links", list_key_links)
        .post("/exec/key-links", create_key_link)
        .put("/exec/key-links/{id}", update_key_link)
        .delete("/exec/key-links/{id}", delete_key_link)
        .get("/exec/agents/{agentId}/combos", list_allowed)
        .put("/exec/agents/{agentId}/combos/{comboId}", allow_add)
        .delete("/exec/agents/{agentId}/combos/{comboId}", allow_remove)
        .put(
            "/exec/agents/{agentId}/combos/{comboId}/default",
            set_default,
        )
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
    fn errors_map_to_statuses() {
        assert_eq!(status_of(&ComboError::Forbidden).0, StatusCode::FORBIDDEN);
        assert_eq!(
            status_of(&ComboError::Invalid("name")),
            (StatusCode::BAD_REQUEST, "invalid_request")
        );
        assert_eq!(status_of(&ComboError::NotFound).0, StatusCode::NOT_FOUND);
        assert_eq!(status_of(&ComboError::Conflict).0, StatusCode::CONFLICT);
    }

    #[test]
    fn body_must_be_a_json_object() {
        for bad in ["", "[]", "\"x\"", "{", "null"] {
            assert!(
                matches!(
                    body_json(&Bytes::from(bad)),
                    Err(ComboError::Invalid("body"))
                ),
                "{bad}"
            );
        }
        assert!(body_json(&Bytes::from("{\"name\":\"a\"}")).is_ok());
    }
}
