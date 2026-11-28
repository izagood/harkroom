//! 실행 자격 줄 관리 HTTP 길(CR1) — [`super::exec_credential`] 의 읽기·쓰기를 그대로 내놓는다. 화면은 아직 없다.
//!
//! | 줄 | 누가 |
//! |---|---|
//! | `GET /exec/credentials` | 사람 |
//! | `POST /exec/credentials` | `key` = 소유자·관리자이면서 그 비밀의 소유자 · `pool` = 그 오퍼레이터의 소유자 |
//! | `DELETE /exec/credentials/{id}` | `key` = 그 비밀의 소유자 · `pool` = 그 오퍼레이터의 소유자나 관리자 |
//! | `GET /exec/agents/{agentId}/credentials` | 사람 |
//! | `PUT`·`DELETE /exec/agents/{agentId}/credentials/{credentialId}` · `PUT …/default` | 그 에이전트의 소유자 |
//!
//! - **판정은 전부 [`super::exec_credential`] 이 한다** — 이 파일은 요청을 풀고 답을 싸기만 한다. 에이전트 계정·오퍼레이터
//!   토큰은 읽기도 403 이다. MCP 도구로는 내놓지 않는다.
//! - 쓰기는 감사 로그에 남긴다(`exec.credential.*`). 감사에는 id·종류·줄 이름만 싣는다 — 풀 이름·주소는 싣지 않는다.
//! - 권한이 없으면 `main.rs` 가 이 길을 붙이지 않는다 — 그때는 404 다(나머지 서버는 그대로 돈다).
use super::exec_combo::ComboError;
use super::exec_combo_routes::{ExecComboState, audit, body_json, fail, json_ok};
use super::exec_credential::{self as xc, CredentialInput};
use crate::auth::RequireAccount;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::sync::Arc;

type St = State<Arc<ExecComboState>>;

pub async fn list_credentials(State(st): St, RequireAccount(me, auth): RequireAccount) -> Response {
    match xc::list_credentials(&st.write, &me, &auth).await {
        Ok(v) => json_ok(StatusCode::OK, json!({ "credentials": v })),
        Err(e) => fail(e),
    }
}

pub async fn create_credential(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    parts: Parts,
    raw: Bytes,
) -> Response {
    // 사람인지를 본문보다 먼저 본다 — 못 쓰는 계정에게 본문 오류를 알려 주지 않는다.
    if !super::exec_combo::is_human(&me, &auth) {
        return fail(ComboError::Forbidden);
    }
    let input = match body_json(&raw).and_then(|b| CredentialInput::parse(&b)) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    match xc::create_credential(&st.write, &me, &auth, &input).await {
        Ok(id) => {
            audit(
                &st,
                &parts,
                &me,
                "exec.credential.created",
                &id,
                json!({ "name": input.name(), "kind": input.kind() }),
            )
            .await;
            json_ok(StatusCode::CREATED, json!({ "id": id }))
        }
        Err(e) => fail(e),
    }
}

pub async fn delete_credential(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    parts: Parts,
) -> Response {
    match xc::delete_credential(&st.write, &me, &auth, &id).await {
        Ok(()) => {
            audit(&st, &parts, &me, "exec.credential.deleted", &id, json!({})).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn list_allowed(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path(agent_id): Path<String>,
) -> Response {
    match xc::list_allowed(&st.write, &me, &auth, &agent_id).await {
        Ok((configured, v)) => json_ok(
            StatusCode::OK,
            json!({ "configured": configured, "credentials": v }),
        ),
        Err(e) => fail(e),
    }
}

async fn allow_done(
    st: &ExecComboState,
    parts: &Parts,
    me: &crate::auth::Account,
    action: &str,
    agent_id: &str,
    credential_id: &str,
    res: Result<(), ComboError>,
) -> Response {
    match res {
        Ok(()) => {
            audit(
                st,
                parts,
                me,
                action,
                agent_id,
                json!({ "credentialId": credential_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn allow_add(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path((agent_id, credential_id)): Path<(String, String)>,
    parts: Parts,
) -> Response {
    let res = xc::allow_add(&st.write, &me, &auth, &agent_id, &credential_id).await;
    let action = "exec.credential.allow_added";
    allow_done(&st, &parts, &me, action, &agent_id, &credential_id, res).await
}

pub async fn allow_remove(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path((agent_id, credential_id)): Path<(String, String)>,
    parts: Parts,
) -> Response {
    let res = xc::allow_remove(&st.write, &me, &auth, &agent_id, &credential_id).await;
    let action = "exec.credential.allow_removed";
    allow_done(&st, &parts, &me, action, &agent_id, &credential_id, res).await
}

pub async fn set_default(
    State(st): St,
    RequireAccount(me, auth): RequireAccount,
    Path((agent_id, credential_id)): Path<(String, String)>,
    parts: Parts,
) -> Response {
    let res = xc::set_default(&st.write, &me, &auth, &agent_id, &credential_id).await;
    let action = "exec.credential.default_set";
    allow_done(&st, &parts, &me, action, &agent_id, &credential_id, res).await
}

pub fn routes(
    st: ExecComboState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ExecComboState>>::new()
        .get("/exec/credentials", list_credentials)
        .post("/exec/credentials", create_credential)
        .delete("/exec/credentials/{id}", delete_credential)
        .get("/exec/agents/{agentId}/credentials", list_allowed)
        .put(
            "/exec/agents/{agentId}/credentials/{credentialId}",
            allow_add,
        )
        .delete(
            "/exec/agents/{agentId}/credentials/{credentialId}",
            allow_remove,
        )
        .put(
            "/exec/agents/{agentId}/credentials/{credentialId}/default",
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
