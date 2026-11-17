//! AC5 안전판 — Rust 오퍼레이터 코어가 `/operator` 소켓을 가져가면 TS 의 오퍼레이터 허브는 빈 채로 남는다. 그 허브로
//! 오퍼레이터에게 프레임을 보내거나 소켓을 끊는 TS 줄은 그 동안 **조용히** 아무 일도 하지 않는다(`send` 가 false).
//! 그 줄들이 Rust 로 옮겨질 때까지, 오퍼레이터 코어가 켜진 동안은 이 줄들을 앞단에서 503 으로 막는다 — 부분만 된 쓰기
//! (DB 는 바뀌고 오퍼레이터는 모름)를 남기지 않으려는 것이다. 옮긴 줄은 여기서 뺀다.
//!
//! 인증·CORS 층은 다른 코어 줄과 같다(인증 안 된 요청은 401, 교차 출처 머리는 TS 와 같다 — `route_table` 대조).
use axum::http::StatusCode;
use axum::response::Response;

use crate::route_table::{Routes, Table};

pub const CODE: &str = "operator_core_moved";

/// 막는 줄 — `"METHOD /path"`(TS 경로). 시험이 이 목록과 라우터를 맞춰 본다.
pub const GUARDED: &[&str] = &[
    "POST /accounts/agents/{id}/stop",
    "POST /accounts/agents/{id}/stop/undo",
    "DELETE /accounts/me",
    "GET /agents/{id}/merge-accounts",
    "PUT /agents/{id}/merge-accounts/lines",
];

async fn unavailable(_: crate::auth::RequireAccount) -> Response {
    crate::directory::json_err(
        StatusCode::SERVICE_UNAVAILABLE,
        CODE,
        "this action is temporarily unavailable while the operator service is being moved",
    )
}

fn table() -> Table<()> {
    Table::<()>::new()
        .post("/accounts/agents/{id}/stop", unavailable)
        .post("/accounts/agents/{id}/stop/undo", unavailable)
        .delete("/accounts/me", unavailable)
        .get("/agents/{id}/merge-accounts", unavailable)
        .put("/agents/{id}/merge-accounts/lines", unavailable)
}

pub fn routes(auth: crate::auth::AuthPools, cors: std::sync::Arc<crate::cors::Cors>) -> Routes<()> {
    let t = table()
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
    Routes {
        router: t.router,
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn guarded_list_matches_router_lines() {
        let mut want: Vec<String> = super::GUARDED.iter().map(|s| s.to_string()).collect();
        want.sort();
        let mut got = super::table().finish().http;
        got.sort();
        assert_eq!(got, want);
    }
}
