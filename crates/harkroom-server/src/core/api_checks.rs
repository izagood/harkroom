//! S5.4 — `POST /agent/api-checks`(TS `apiCallRoutes.ts` → `apiCalls.ts::checkApiCall`) — **부분 이식**.
//!
//! Rust 는 판정 전의 두 갈래만 답한다: 오퍼레이터를 거치지 않은 요청(403 `forbidden`)과 zod 모양이 틀린 본문(400 `bad_request`).
//! 모양이 맞는 요청은 전부 TS 로 넘긴다 — 임대·연결·`apiGrantFor`(사슬·limits·경로)·쓰기 사람 원인·비밀 열기(`secret_access_log`)·
//! 막힘 카드(`recordBlocked`)·감사·409 `secret_key_mismatch` 는 아직 TS 몫이다.
//! 쓰기 풀에 [`API_CHECKS_DENY_PRIVILEGES`] 가 다 있으면 임대 거절(403 `lease_invalid` — 막힘 카드가 없는 갈래)과 그
//! `api.call.denied` 감사는 Rust 가 답한다. 임대가 통과한 요청은 전부 TS 로 넘긴다(임대를 읽기만 했다).
use super::api_results::connector_ok;
use super::grant_reads::through_operator;
use super::merge_approval_peek::str_len_ok;
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::json_err;
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use std::net::SocketAddr;
use std::sync::Arc;

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token, connector, method and path are required";

/// zod `{ leaseId, token, connector, method, path, caps? }` 모양만 본다(남는 키는 zod 처럼 무시).
pub fn shape_ok(body: Option<&Value>) -> bool {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => match v.as_object() {
            Some(o) => o,
            None => return false,
        },
    };
    let ok = (|| {
        let lease = o.get("leaseId")?.as_str()?;
        if !is_uuid(lease) {
            return None;
        }
        str_len_ok(o.get("token")?, 1, 200)?;
        if !connector_ok(o.get("connector")?.as_str()?) {
            return None;
        }
        if !matches!(
            o.get("method")?.as_str()?,
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
        ) {
            return None;
        }
        str_len_ok(o.get("path")?, 1, 2000)?;
        match o.get("caps") {
            None => {}
            Some(v) => {
                let a = v.as_array()?;
                if a.len() > 10 {
                    return None;
                }
                for c in a {
                    str_len_ok(c, 0, 40)?;
                }
            }
        }
        Some(())
    })();
    ok.is_some()
}

/// 임대 거절을 Rust 가 답할 때 쓰기 풀에 있어야 하는 권한 — 임대 정본 문장(`grant_read_lease`)이 읽는 표,
/// `connectorIdByName`, `api.call.denied` 감사 쓰기.
pub const API_CHECKS_DENY_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "SELECT"),
    ("message", "SELECT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("api_connector.id", "SELECT"),
    ("api_connector.name", "SELECT"),
    ("audit_log", "INSERT"),
];

pub struct ChecksState {
    pub up: Upstream,
    /// 임대 거절 경로 — 쓰기 풀에 [`API_CHECKS_DENY_PRIVILEGES`] 가 다 있을 때만.
    pub deny: Option<sqlx::PgPool>,
}

/// TS `leaseOk`.
pub fn lease_ok(lease: Option<&super::lease_read::LeaseRow>, agent: &str, operator: &str) -> bool {
    lease.is_some_and(|l| {
        l.agent_id == agent && l.operator_id.as_deref() == Some(operator) && !l.expired && !l.ended
    })
}

/// TS `(path.split('?')[0] ?? '').slice(0, 300)` — JS 는 UTF-16 단위로 자른다. 자른 자리가 서로게이트 쌍을
/// 가르면 `None`(TS 에 맡긴다).
pub fn audit_path(path: &str) -> Option<String> {
    let head = path.split('?').next().unwrap_or_default();
    let u: Vec<u16> = head.encode_utf16().collect();
    if u.len() <= 300 {
        return Some(head.to_owned());
    }
    String::from_utf16(&u[..300]).ok()
}

/// TS `deny('lease_invalid')` 의 `api.call.denied` 감사 `detail`.
pub fn denied_detail(code: &str, method: &str, path: &str, operator: &str) -> Value {
    json!({ "code": code, "method": method, "path": path, "operatorId": operator, "leaseId": null })
}

async fn checks_early(
    pool: &sqlx::PgPool,
    agent: &str,
    operator: &str,
    o: &Value,
) -> sqlx::Result<Option<Response>> {
    let g = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default();
    let Some(path) = audit_path(g("path")) else {
        return Ok(None);
    };
    let now = super::merge_approval_peek::db_now(pool).await?;
    let lease = super::lease_read::read_lease(pool, g("leaseId"), g("token"), &now).await?;
    if lease_ok(lease.as_ref(), agent, operator) {
        return Ok(None);
    }
    let cid: Option<String> =
        sqlx::query_scalar("select id::text from api_connector where name = $1")
            .bind(g("connector"))
            .fetch_optional(pool)
            .await?;
    let target = match cid {
        Some(c) => format!("connector:{c}"),
        None => format!("connector-name:{}", g("connector")),
    };
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "api.call.denied",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&target),
            ip: None,
            detail: denied_detail("lease_invalid", g("method"), &path, operator),
        },
    )
    .await;
    let mut r = json_err(
        StatusCode::FORBIDDEN,
        "lease_invalid",
        "api call not allowed: lease_invalid",
    );
    r.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(Some(r))
}

pub async fn checks_route(
    State(st): State<Arc<ChecksState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    if !shape_ok(parsed.as_ref()) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    }
    if let (Some(pool), Some(op), Some(o)) = (
        st.deny.as_ref(),
        auth.operator.as_ref().map(|o| o.id.as_str()),
        parsed.as_ref(),
    ) {
        match checks_early(pool, &me.id, op, o).await {
            Ok(Some(r)) => return r,
            Ok(None) => {}
            Err(e) => return crate::directory::internal(e),
        }
    }
    super::msg_post::to_ts(st.up.clone(), peer, parts, bytes).await
}

pub fn routes(
    up: Upstream,
    deny: Option<sqlx::PgPool>,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ChecksState>>::new()
        .post("/agent/api-checks", checks_route)
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
        router: t.router.with_state(Arc::new(ChecksState { up, deny })),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lease_ok_like_ts() {
        let l = crate::core::lease_read::LeaseRow {
            id: "L".into(),
            agent_id: "a".into(),
            operator_id: Some("o".into()),
            ..Default::default()
        };
        assert!(lease_ok(Some(&l), "a", "o"));
        assert!(!lease_ok(None, "a", "o"));
        assert!(!lease_ok(Some(&l), "b", "o"));
        assert!(!lease_ok(Some(&l), "a", "x"));
        let mut e = l.clone();
        e.expired = true;
        assert!(!lease_ok(Some(&e), "a", "o"));
        let mut n = l.clone();
        n.ended = true;
        assert!(!lease_ok(Some(&n), "a", "o"));
    }

    #[test]
    fn audit_path_like_ts() {
        assert_eq!(audit_path("/x?api_key=1").as_deref(), Some("/x"));
        assert_eq!(audit_path("?q").as_deref(), Some(""));
        assert_eq!(audit_path(&"a".repeat(400)).unwrap().len(), 300);
        // UTF-16 단위로 센다: 한글은 1단위.
        assert_eq!(audit_path(&"가".repeat(400)).unwrap().chars().count(), 300);
        // 299 단위 뒤에 서로게이트 쌍이 걸리면 TS 에 맡긴다.
        let p = format!("{}{}", "a".repeat(299), "😀");
        assert_eq!(audit_path(&p), None);
        assert_eq!(
            denied_detail("lease_invalid", "GET", "/x", "op"),
            json!({ "code": "lease_invalid", "method": "GET", "path": "/x", "operatorId": "op", "leaseId": null })
        );
    }

    #[test]
    fn deny_privileges_cover_lease_sql() {
        let f = crate::core::channels::frag("grant_read_lease");
        for t in [
            "secret_turn_lease",
            "message",
            "account",
            "agent_config",
            "channel",
            "channel_member",
            "agent_invoker",
        ] {
            assert!(f.contains(t), "{t}");
            assert!(API_CHECKS_DENY_PRIVILEGES.contains(&(t, "SELECT")), "{t}");
        }
    }

    #[test]
    fn shape_like_zod() {
        let ok = json!({ "leaseId": "00000000-0000-4000-8000-000000000000", "token": "t", "connector": "lab", "method": "GET", "path": "/x", "caps": ["token_exchange"], "extra": 1 });
        assert!(shape_ok(Some(&ok)));
        assert!(!shape_ok(None));
        let mut bad = ok.clone();
        bad["method"] = json!("HEAD");
        assert!(!shape_ok(Some(&bad)));
        let mut bad = ok.clone();
        bad["caps"] = json!(["x".repeat(41)]);
        assert!(!shape_ok(Some(&bad)));
        let mut bad = ok;
        bad["connector"] = json!("Lab");
        assert!(!shape_ok(Some(&bad)));
    }
}
