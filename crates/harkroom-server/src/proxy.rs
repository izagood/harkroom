//! Rust 서버가 답하지 않는 요청의 끝자리. 예전에는 TS 서버(상류)로 넘겼다 — TS 서버를 지우면서(11-21) 넘김을 닫고
//! 고정 답(404 `not_found`)을 낸다. 라우터 맨 끝 fallback 과, 핸들러가 「이 꼴은 Rust 가 맡지 않는다」고 판정한 갈래가 여기로 온다.
//! `/mcp` 도구 부르기는 여기 오기 전에 [`crate::core::mcp::ts_down::unsupported`] 가 도구 오류(`unsupported_call`)로 답한다.
//!
//! `Upstream` 은 이름만 남은 빈 표지다(아무 데도 잇지 않고 env 도 읽지 않는다) — 상태 구조체 80여 곳이 들고 있어 걷는 것은
//! 기계적인 후속 정리로 미룬다. 옛 대조 시험용 표지 헤더(`x-harkroom-closed`)는 TS 백엔드와 함께 걷었다(11-21).
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{Request, Response, StatusCode, header};
use std::net::SocketAddr;

/// 예전 상류(TS 서버) 자리 — 더는 아무 데도 잇지 않는다.
#[derive(Clone, Default)]
pub struct Upstream;

impl Upstream {
    pub fn new(_base: &str) -> Self {
        Self
    }
}

/// 넘김을 닫은 자리의 고정 오류 코드(HTTP 404).
pub const NOT_FOUND: &str = "not_found";

/// 답하지 않는 경로·꼴 — 404 `{"error":{"code":"not_found",…}}`. 웹소켓 업그레이드도 같다(101 을 내지 않는다).
pub fn closed() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            "{{\"error\":{{\"code\":\"{NOT_FOUND}\",\"message\":\"this route or request shape is not served\"}}}}"
        )))
        .expect("고정 응답")
}

/// 예전 넘김 자리(호출처 꼴을 그대로 둔다). 상류로 보내지 않고 [`closed`] 로 답한다.
pub async fn forward(
    State(_up): State<Upstream>,
    ConnectInfo(_peer): ConnectInfo<SocketAddr>,
    _req: Request<Body>,
) -> Response<Body> {
    closed()
}

/// 앞단 자신의 상태.
pub async fn front_health() -> Response<Body> {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            "{{\"ok\":true,\"front\":\"rust\",\"version\":\"{}\"}}",
            env!("CARGO_PKG_VERSION")
        )))
        .expect("고정 응답")
}

pub fn router(up: Upstream) -> axum::Router {
    axum::Router::new()
        .route("/front/healthz", axum::routing::get(front_health))
        .fallback(forward)
        .with_state(up)
}
