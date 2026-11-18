//! S5.4 — `POST /agent/api-checks`(TS `apiCallRoutes.ts` → `apiCalls.ts::checkApiCall`) — **부분 이식**.
//!
//! Rust 는 판정 전의 두 갈래만 답한다: 오퍼레이터를 거치지 않은 요청(403 `forbidden`)과 zod 모양이 틀린 본문(400 `bad_request`).
//! 모양이 맞는 요청은 전부 TS 로 넘긴다 — 임대·연결·`apiGrantFor`(사슬·limits·경로)·쓰기 사람 원인·비밀 열기(`secret_access_log`)·
//! 막힘 카드(`recordBlocked`)·감사·409 `secret_key_mismatch` 는 아직 TS 몫이다. 넘기는 쪽은 DB 를 건드리지 않으므로 칸 권한이 필요 없다.
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
use serde_json::{Map, Value};
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

pub async fn checks_route(
    State(up): State<Arc<Upstream>>,
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
    super::msg_post::to_ts((*up).clone(), peer, parts, bytes).await
}

pub fn routes(
    up: Upstream,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<Upstream>>::new()
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
        router: t.router.with_state(Arc::new(up)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
